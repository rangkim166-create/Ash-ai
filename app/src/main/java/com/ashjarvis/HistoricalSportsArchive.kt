package com.ashjarvis

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.security.MessageDigest
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale

/**
 * Imports licensed/public CSV match archives into Ash's private SQLite database.
 * Raw source columns are retained alongside normalized match fields for later analysis.
 */
object HistoricalSportsArchive {
    data class ImportResult(
        val imported: Int,
        val skipped: Int,
        val sport: String,
        val sourceName: String,
        val firstYear: Int?,
        val lastYear: Int?
    )

    fun importCsv(context: Context, uri: Uri, sport: String, sourceName: String): ImportResult {
        val resolver = context.contentResolver
        val input = resolver.openInputStream(uri) ?: throw IllegalStateException("Could not open selected CSV file")
        val db = LocalSportsDatabase.get(context)
        var imported = 0
        var skipped = 0
        val years = mutableListOf<Int>()
        val batch = mutableListOf<Pair<String, JSONObject>>()

        input.use { stream ->
            BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { reader ->
                val headerLine = reader.readLine() ?: throw IllegalArgumentException("CSV file is empty")
                val headers = parseCsvLine(headerLine).map { it.trim().removePrefix("\uFEFF") }
                if (headers.isEmpty()) throw IllegalArgumentException("CSV header is missing")
                val normalized = headers.map { normalize(it) }
                fun column(vararg names: String): Int = names.map { normalize(it) }.firstNotNullOfOrNull { normalized.indexOf(it).takeIf { ix -> ix >= 0 } } ?: -1

                val dateCol = column("date", "match_date", "game_date", "tourney_date", "date_event", "datetime", "fixture_date")
                if (dateCol < 0) throw IllegalArgumentException("No supported match date column found. Expected Date, match_date, game_date or tourney_date.")
                val homeCol = column("home_team", "hometeam", "team_home", "visitor_team", "winner_name")
                val awayCol = column("away_team", "awayteam", "team_away", "opponent", "opponent_team", "loser_name")
                val teamCol = column("team_name", "team", "franchise")
                val homeFlagCol = column("home", "is_home")
                val matchupCol = column("matchup")
                val homeScoreCol = column("home_score", "fthg", "home_goals", "pts_home", "home_pts", "winner_score")
                val awayScoreCol = column("away_score", "ftag", "away_goals", "pts_away", "away_pts", "loser_score")
                val resultCol = column("ftr", "result", "winner", "match_winner")

                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    val raw = line ?: continue
                    if (raw.isBlank()) continue
                    val cells = parseCsvLine(raw)
                    val rawDate = cells.getOrNull(dateCol).orEmpty().trim()
                    val date = parseDate(rawDate)
                    if (date == null || date.year !in 2000..2026) { skipped++; continue }
                    var home = cells.getOrNull(homeCol).orEmpty().trim()
                    var away = cells.getOrNull(awayCol).orEmpty().trim()
                    val team = cells.getOrNull(teamCol).orEmpty().trim()
                    val opponent = cells.getOrNull(awayCol).orEmpty().trim()
                    if ((home.isBlank() || away.isBlank()) && team.isNotBlank() && opponent.isNotBlank()) {
                        val flag = cells.getOrNull(homeFlagCol).orEmpty().trim().lowercase(Locale.ROOT)
                        val teamIsHome = flag in setOf("true", "1", "yes", "home", "h")
                        if (home.isBlank() || away.isBlank()) {
                            home = if (teamIsHome) team else opponent
                            away = if (teamIsHome) opponent else team
                        }
                    }
                    if ((home.isBlank() || away.isBlank()) && team.isNotBlank() && matchupCol >= 0) {
                        val matchup = cells.getOrNull(matchupCol).orEmpty().trim()
                        val split = Regex("^(.+?)\\s+(vs\\.?|@)\\s+(.+)$", RegexOption.IGNORE_CASE).find(matchup)
                        if (split != null) {
                            val left = split.groupValues[1].trim()
                            val right = split.groupValues[3].trim()
                            val separator = split.groupValues[2]
                            val teamIsLeft = left.equals(team, true)
                            home = if (separator.startsWith("@")) right else if (teamIsLeft) left else right
                            away = if (separator.startsWith("@")) left else if (teamIsLeft) right else left
                        }
                    }
                    if (home.isBlank() || away.isBlank()) { skipped++; continue }

                    val row = JSONObject()
                    headers.forEachIndexed { index, name ->
                        val value = cells.getOrNull(index).orEmpty()
                        if (name.isNotBlank()) row.put(name, value)
                    }
                    val normalizedRecord = JSONObject()
                        .put("sport", sport.lowercase(Locale.ROOT))
                        .put("date", date.toString())
                        .put("year", date.year)
                        .put("home_team", home)
                        .put("away_team", away)
                        .put("home_score", cells.getOrNull(homeScoreCol).orEmpty())
                        .put("away_score", cells.getOrNull(awayScoreCol).orEmpty())
                        .put("result", cells.getOrNull(resultCol).orEmpty())
                        .put("source", sourceName)
                        .put("raw", row)
                    val identity = "${sport.lowercase(Locale.ROOT)}|${date}| ${home.lowercase(Locale.ROOT)}|${away.lowercase(Locale.ROOT)}"
                    val key = sha256(identity)
                    batch.add(key to normalizedRecord)
                    years.add(date.year)
                    imported++
                    if (batch.size >= 500) {
                        db.putBatch("historical_match", batch.toList())
                        batch.clear()
                    }
                }
            }
        }
        if (batch.isNotEmpty()) db.putBatch("historical_match", batch)
        val result = ImportResult(imported, skipped, sport, sourceName, years.minOrNull(), years.maxOrNull())
        db.put("archive_import", sha256("${sport}|${sourceName}|${System.currentTimeMillis()}"),
            JSONObject().put("sport", sport).put("source", sourceName)
                .put("imported", imported).put("skipped", skipped)
                .put("first_year", result.firstYear ?: JSONObject.NULL)
                .put("last_year", result.lastYear ?: JSONObject.NULL)
                .put("imported_at", java.time.Instant.now().toString()))
        return result
    }

    private fun parseDate(value: String): LocalDate? {
        val clean = value.substringBefore(' ').trim()
        val patterns = listOf(
            "yyyy-MM-dd", "yyyy/MM/dd", "yyyyMMdd", "dd/MM/yy", "dd/MM/yyyy",
            "MM/dd/yyyy", "dd-MM-yyyy", "yyyy.MM.dd"
        )
        for (pattern in patterns) {
            try {
                val parsed = LocalDate.parse(clean, DateTimeFormatter.ofPattern(pattern, Locale.US))
                if (pattern == "dd/MM/yy" && parsed.year > 2026) return parsed.minusYears(100)
                return parsed
            } catch (_: DateTimeParseException) { }
        }
        return null
    }

    private fun parseCsvLine(line: String): List<String> {
        val values = mutableListOf<String>()
        val field = StringBuilder()
        var quoted = false
        var i = 0
        while (i < line.length) {
            val ch = line[i]
            when {
                ch == '"' && quoted && i + 1 < line.length && line[i + 1] == '"' -> {
                    field.append('"'); i++
                }
                ch == '"' -> quoted = !quoted
                ch == ',' && !quoted -> {
                    values.add(field.toString()); field.setLength(0)
                }
                else -> field.append(ch)
            }
            i++
        }
        values.add(field.toString())
        return values
    }

    private fun normalize(value: String): String = value.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9]"), "")

    private fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
