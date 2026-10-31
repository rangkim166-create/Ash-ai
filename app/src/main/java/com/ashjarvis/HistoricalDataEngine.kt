package com.ashjarvis

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.time.Instant
import java.util.Locale

/**
 * Independent historical-data collector.
 *
 * Uses SportScore's documented public REST/widget endpoints, never The Odds API.
 * Results are cached in SQLite and are refreshed only when explicitly requested
 * or when a saved team profile is older than the refresh interval.
 *
 * SportScore attribution is shown in the Sports history screen.
 */
object HistoricalDataEngine {
    private const val BASE = "https://sportscore.com"
    private const val SOURCE = "SportScore"
    private const val REFRESH_HOURS = 24L

    data class TeamCollection(
        val teamName: String,
        val sport: String,
        val recordsSaved: Int,
        val source: String,
        val checkedAt: String,
        val note: String
    )

    data class MatchCollection(
        val home: TeamCollection,
        val away: TeamCollection
    )

    private fun getJson(path: String): JSONObject {
        val connection = (URL("$BASE$path").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 12000
            readTimeout = 18000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "AshJarvis-Android/1.0")
        }
        try {
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) throw IllegalStateException("$SOURCE HTTP $code: ${body.take(180)}")
            return JSONObject(body)
        } finally {
            connection.disconnect()
        }
    }

    private fun enc(value: String) = URLEncoder.encode(value, "UTF-8")
    private fun sportKey(value: String): String {
        val s = value.lowercase(Locale.ROOT)
        return when {
            s.contains("tennis") -> "tennis"
            s.contains("basket") || s.contains("nba") || s.contains("wnba") -> "basketball"
            s.contains("cricket") -> "cricket"
            else -> "football"
        }
    }

    private fun normalize(value: String) = value.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9]"), "")
    private fun key(value: String) = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private fun findBestEntity(root: JSONObject, teamName: String): JSONObject? {
        val wanted = normalize(teamName)
        var best: JSONObject? = null
        var bestScore = 0
        fun walk(value: Any?) {
            when (value) {
                is JSONObject -> {
                    val label = value.optString("name").ifBlank { value.optString("title") }
                        .ifBlank { value.optString("team_name") }.ifBlank { value.optString("player_name") }
                    val slug = value.optString("slug").ifBlank { value.optString("team_slug") }
                        .ifBlank { value.optString("player_slug") }
                    if (label.isNotBlank() && slug.isNotBlank()) {
                        val candidate = normalize(label)
                        val score = when {
                            candidate == wanted -> 100
                            candidate.contains(wanted) || wanted.contains(candidate) -> 75
                            candidate.split(Regex("(?=[0-9])|[^a-z0-9]+")).any { it.length > 3 && wanted.contains(it) } -> 35
                            else -> 0
                        }
                        if (score > bestScore) { bestScore = score; best = value }
                    }
                    val iterator = value.keys()
                    while (iterator.hasNext()) walk(value.opt(iterator.next()))
                }
                is JSONArray -> for (i in 0 until value.length()) walk(value.opt(i))
            }
        }
        walk(root)
        return best?.takeIf { bestScore >= 75 }
    }

    private fun findMatchRows(root: JSONObject): JSONArray {
        var best = JSONArray()
        var bestScore = 0
        fun walk(value: Any?) {
            when (value) {
                is JSONObject -> {
                    val iterator = value.keys()
                    while (iterator.hasNext()) {
                        val k = iterator.next()
                        val child = value.opt(k)
                        if (child is JSONArray && child.length() > 0) {
                            var score = 0
                            for (i in 0 until minOf(child.length(), 8)) {
                                val row = child.optJSONObject(i) ?: continue
                                if ((row.has("home") || row.has("home_team") || row.has("event")) &&
                                    (row.has("away") || row.has("away_team") || row.has("event"))) score++
                            }
                            if (score > bestScore) { bestScore = score; best = child }
                        }
                        walk(child)
                    }
                }
                is JSONArray -> for (i in 0 until value.length()) walk(value.opt(i))
            }
        }
        walk(root)
        return best
    }

    private fun normalizeResult(row: JSONObject, trackedTeam: String, sport: String, sourceSlug: String): JSONObject? {
        val home = row.optString("home").ifBlank { row.optString("home_team") }
            .ifBlank { row.optString("homeTeam") }
        val away = row.optString("away").ifBlank { row.optString("away_team") }
            .ifBlank { row.optString("awayTeam") }
        if (home.isBlank() || away.isBlank()) return null
        val homeScore = row.opt("home_score")?.toString()?.takeIf { it != "null" }
            ?: row.opt("homeScore")?.toString()?.takeIf { it != "null" }.orEmpty()
        val awayScore = row.opt("away_score")?.toString()?.takeIf { it != "null" }
            ?: row.opt("awayScore")?.toString()?.takeIf { it != "null" }.orEmpty()
        val date = row.optString("time").ifBlank { row.optString("date") }
            .ifBlank { row.optString("datetime") }.ifBlank { row.optString("start_time") }
        val status = row.optString("status").ifBlank { row.optString("status_text") }
        val slug = row.optString("slug").ifBlank { row.optString("id") }
        val trackedIsHome = normalize(home) == normalize(trackedTeam)
        val trackedIsAway = normalize(away) == normalize(trackedTeam)
        val outcome = if (homeScore.toDoubleOrNull() != null && awayScore.toDoubleOrNull() != null) {
            val h = homeScore.toDouble()
            val a = awayScore.toDouble()
            when {
                h == a -> if (sport == "football") "D" else "DRAW"
                (trackedIsHome && h > a) || (trackedIsAway && a > h) -> "W"
                (trackedIsHome && h < a) || (trackedIsAway && a < h) -> "L"
                else -> "UNKNOWN"
            }
        } else "UNKNOWN"
        val identity = "$sport|$slug|$date|$home|$away"
        return JSONObject()
            .put("id", key(identity))
            .put("sport", sport)
            .put("date", date)
            .put("event", "$home vs $away")
            .put("home_team", home)
            .put("away_team", away)
            .put("home_score", homeScore)
            .put("away_score", awayScore)
            .put("status", status)
            .put("outcome", outcome)
            .put("tracked_team", trackedTeam)
            .put("source", SOURCE)
            .put("source_slug", sourceSlug)
            .put("source_match_slug", slug)
            .put("collected_at", Instant.now().toString())
    }

    /**
     * Search the public sports index, resolve the entity slug, fetch its schedule,
     * and merge all returned results into the local per-team history.
     */
    fun collectTeamHistory(context: Context, teamName: String, sportTitle: String, forceRefresh: Boolean = false): TeamCollection {
        require(teamName.isNotBlank()) { "Team/player name is missing" }
        val sport = sportKey(sportTitle)
        val db = LocalSportsDatabase.get(context)
        val profileKey = "$sport:${normalize(teamName)}"
        val oldProfile = db.get("team_profile", profileKey)
        val checked = oldProfile?.optString("history_checked_at").orEmpty()
        val stillFresh = try {
            checked.isNotBlank() && Instant.parse(checked).isAfter(Instant.now().minusSeconds(REFRESH_HOURS * 3600))
        } catch (_: Exception) { false }
        if (!forceRefresh && stillFresh) {
            return TeamCollection(teamName, sport, oldProfile?.optInt("history_records") ?: 0, SOURCE, checked,
                "Using locally cached history; last checked within 24 hours.")
        }

        val search = getJson("/api/v1/search/?q=${enc(teamName)}&sport=$sport&limit=12")
        val entity = findBestEntity(search, teamName)
            ?: throw IllegalStateException("$SOURCE could not confidently match '$teamName'. No history was invented.")
        val slug = entity.optString("slug").ifBlank { entity.optString("team_slug") }
            .ifBlank { entity.optString("player_slug") }
        if (slug.isBlank()) throw IllegalStateException("$SOURCE search result did not include a usable team/player slug.")

        val schedule = getJson("/api/widget/team/?sport=$sport&slug=${enc(slug)}&limit=30")
        val rows = findMatchRows(schedule)
        val batch = mutableListOf<Pair<String, JSONObject>>()
        val seen = linkedSetOf<String>()
        for (i in 0 until rows.length()) {
            val raw = rows.optJSONObject(i) ?: continue
            val normalized = normalizeResult(raw, teamName, sport, slug) ?: continue
            val id = normalized.optString("id")
            if (id.isNotBlank() && seen.add(id)) batch.add(id to normalized)
        }
        if (batch.isNotEmpty()) db.putBatch("team_result", batch)
        val now = Instant.now().toString()
        val profile = JSONObject()
            .put("name", teamName)
            .put("sport", sport)
            .put("slug", slug)
            .put("source", SOURCE)
            .put("source_url", "$BASE/api/widget/team/?sport=$sport&slug=$slug")
            .put("history_records", batch.size)
            .put("history_checked_at", now)
            .put("history_note", if (batch.isEmpty()) "No parseable match rows returned by source." else "Collected source-provided team/player schedule rows.")
        db.put("team_profile", profileKey, profile)
        return TeamCollection(teamName, sport, batch.size, SOURCE, now,
            if (batch.isEmpty()) "Source found the entity but returned no parseable match history." else "Saved/updated ${batch.size} historical or scheduled records locally.")
    }

    fun collectMatchHistory(context: Context, home: String, away: String, sportTitle: String, forceRefresh: Boolean = false): MatchCollection {
        val sport = sportKey(sportTitle)
        val homeResult = collectTeamHistory(context, home, sport, forceRefresh)
        val awayResult = collectTeamHistory(context, away, sport, forceRefresh)
        return MatchCollection(homeResult, awayResult)
    }

    fun teamHistory(context: Context, teamName: String, sportTitle: String, limit: Int = 100): JSONArray {
        val sport = sportKey(sportTitle)
        val all = LocalSportsDatabase.get(context).list("team_result", 10000)
        fun dateValue(value: String): Long {
            return runCatching { Instant.parse(value).toEpochMilli() }.getOrElse {
                runCatching { java.time.LocalDate.parse(value.take(10)).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli() }
                    .getOrDefault(0L)
            }
        }
        val rows = (0 until all.length()).mapNotNull { all.optJSONObject(it) }
            .filter {
                it.optString("sport") == sport &&
                    normalize(it.optString("tracked_team")) == normalize(teamName) &&
                    it.optString("outcome") in setOf("W", "L", "D")
            }
            .sortedByDescending { dateValue(it.optString("date")) }
            .take(limit.coerceIn(1, 1000))
        val out = JSONArray()
        rows.forEach(out::put)
        return out
    }
}
