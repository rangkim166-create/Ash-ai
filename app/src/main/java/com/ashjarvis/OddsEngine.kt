package com.ashjarvis

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import java.time.Instant

object OddsEngine {
    private const val PREFS = "ash_jarvis"
    private const val KEY_ALIAS = "ash_odds_api_key"
    private const val HISTORY_KEY = "ash_odds_history_json"
    private const val FAVORITES_KEY = "ash_odds_favorites"
    private const val BASE = "https://api.the-odds-api.com/v4"

    data class SyncResult(val gamesFound: Int, val newGames: Int, val sportsChecked: Int, val errors: List<String>, val remaining: String?)

    fun saveApiKey(context: Context, value: String) {
        val key = getSecretKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val encrypted = cipher.doFinal(value.trim().toByteArray(Charsets.UTF_8))
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("odds_key_cipher", Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString("odds_key_iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    fun readApiKey(context: Context): String? {
        return try {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val encrypted = prefs.getString("odds_key_cipher", null) ?: return null
            val iv = prefs.getString("odds_key_iv", null) ?: return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getSecretKey(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), Charsets.UTF_8).takeIf { it.isNotBlank() }
        } catch (_: Exception) { null }
    }

    fun clearApiKey(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove("odds_key_cipher").remove("odds_key_iv").apply()
    }

    private fun getSecretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }

    fun requestJson(url: String): Pair<JSONObject, Map<String, String>> {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 12000
            readTimeout = 20000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "AshJarvis-Android/1.0")
        }
        try {
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) {
                val detail = try { JSONObject(body).optString("message", body) } catch (_: Exception) { body }
                throw IllegalStateException("Odds API HTTP $code: ${detail.take(240)}")
            }
            val headers = mutableMapOf<String, String>()
            listOf("x-requests-remaining", "x-requests-used", "x-requests-last").forEach { name ->
                headers[name] = connection.getHeaderField(name).orEmpty()
            }
            val parsed = if (body.trimStart().startsWith("[")) {
                JSONObject().put("data", JSONArray(body))
            } else JSONObject(body)
            return parsed to headers
        } finally { connection.disconnect() }
    }

    fun loadSports(apiKey: String): JSONArray {
        val key = URLEncoder.encode(apiKey, "UTF-8")
        val (payload, _) = requestJson("$BASE/sports/?apiKey=$key")
        return payload.optJSONArray("data") ?: JSONArray()
    }

    fun checkOddEven(apiKey: String, sportKey: String, eventId: String): JSONObject {
        val key = URLEncoder.encode(apiKey, "UTF-8")
        val sport = URLEncoder.encode(sportKey, "UTF-8")
        val event = URLEncoder.encode(eventId, "UTF-8")
        return requestJson("$BASE/sports/$sport/events/$event/odds/?apiKey=$key&regions=uk,eu&markets=odd_even&oddsFormat=decimal").first
    }

    fun favoriteKeys(context: Context): MutableSet<String> {
        val stored = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(FAVORITES_KEY, null)
        return stored?.split(",")?.map { it.trim() }?.filter { it.isNotBlank() }?.toMutableSet()
            ?: linkedSetOf("soccer_epl", "soccer_uefa_champs_league", "soccer_spain_la_liga", "basketball_nba")
    }

    fun saveFavorites(context: Context, keys: Set<String>) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(FAVORITES_KEY, keys.joinToString(",")).apply()
    }

    fun history(context: Context): JSONArray {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val db = LocalSportsDatabase.get(context)
        // One-time migration: preserve the old SharedPreferences archive before switching to SQLite.
        if (!prefs.getBoolean("sports_sqlite_migrated_v1", false)) {
            val legacy = try { JSONArray(prefs.getString(HISTORY_KEY, "[]") ?: "[]") } catch (_: Exception) { JSONArray() }
            for (i in 0 until legacy.length()) {
                val row = legacy.optJSONObject(i) ?: continue
                val id = row.optString("id")
                if (id.isNotBlank()) db.put("match", id, row)
            }
            prefs.edit().putBoolean("sports_sqlite_migrated_v1", true).apply()
        }
        return db.list("match", 10000)
    }

    fun sync(context: Context, apiKey: String): SyncResult {
        val allSports = loadSports(apiKey)
        val active = (0 until allSports.length()).mapNotNull { allSports.optJSONObject(it) }
            .filter { it.optBoolean("active", true) && it.optString("key").isNotBlank() }
        // Daily discovery mode: scan every active sport/competition exposed by this API key.
        // The Odds API requires a separate odds request per sport, so quota depends on plan and coverage.
        val sports = active
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val old = history(context)
        val byId = linkedMapOf<String, JSONObject>()
        for (i in 0 until old.length()) {
            val item = old.optJSONObject(i) ?: continue
            val id = item.optString("id")
            if (id.isNotBlank()) byId[id] = item
        }
        var found = 0
        var added = 0
        var remaining: String? = null
        val errors = mutableListOf<String>()
        for (sport in sports) {
            val sportKey = sport.optString("key")
            try {
                val key = URLEncoder.encode(apiKey, "UTF-8")
                val sportParam = URLEncoder.encode(sportKey, "UTF-8")
                val url = "$BASE/sports/$sportParam/odds/?apiKey=$key&regions=uk,eu&markets=h2h&oddsFormat=decimal"
                val (payload, headers) = requestJson(url)
                headers["x-requests-remaining"]?.let { remaining = it }
                val events = payload.optJSONArray("data") ?: JSONArray()
                for (i in 0 until events.length()) {
                    val event = events.optJSONObject(i) ?: continue
                    val id = event.optString("id")
                    if (id.isBlank()) continue
                    val now = Instant.now().toString()
                    val prior = byId[id]
                    val summary = summarize(event, sportKey, sport.optString("title", sportKey), now, prior)
                    if (prior == null) added++
                    byId[id] = summary
                    // Persist each discovered fixture immediately; a later failed request cannot erase it.
                    LocalSportsDatabase.get(context).put("match", id, summary)
                    found++
                }
                if (remaining?.toIntOrNull() == 0) {
                    errors.add("API quota is exhausted; stopped scanning remaining sports to avoid repeated failed requests.")
                    break
                }
            } catch (e: Exception) {
                errors.add("$sportKey: ${(e.message ?: "request failed").take(160)}")
            }
        }
        val sorted = byId.values.sortedByDescending { it.optString("last_seen") }
        val saved = JSONArray()
        sorted.forEach { saved.put(it) }
        // SharedPreferences remains a small compatibility cache; SQLite is the durable source of truth.
        val cache = JSONArray()
        sorted.take(1000).forEach { cache.put(it) }
        prefs.edit().putString(HISTORY_KEY, cache.toString()).putString("odds_last_sync", Instant.now().toString()).apply()
        if (found == 0 && errors.isNotEmpty()) throw IllegalStateException(errors.take(3).joinToString("\n"))
        return SyncResult(found, added, sports.size, errors, remaining)
    }

    fun savedDailyPicks(context: Context): JSONArray = try {
        JSONArray(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("ash_daily_picks_json", "[]") ?: "[]")
    } catch (_: Exception) { JSONArray() }

    /**
     * Build a small daily evidence shortlist from real upcoming API fixtures.
     * For the leading candidates, research recent results online when local evidence is absent/stale.
     * Never fabricates results or treats missing data as a losing/winning signal.
     */
    fun buildDailyPicks(context: Context): JSONArray {
        val now = Instant.now()
        val history = history(context)
        val upcoming = (0 until history.length()).mapNotNull { history.optJSONObject(it) }
            .filter {
                val kickoff = it.optString("commence_time")
                kickoff.isNotBlank() && try { Instant.parse(kickoff).isAfter(now) } catch (_: Exception) { false }
            }
        // Research a few more than the final shortlist, then reject matches without enough evidence.
        val candidates = upcoming.filter {
            it.optString("candidate").isNotBlank() &&
                it.optInt("candidate_bookmakers") >= 3 &&
                it.optDouble("candidate_price", 0.0) in 1.25..1.75
        }.sortedWith(compareByDescending<JSONObject> { it.optInt("candidate_bookmakers") }
            .thenBy { kotlin.math.abs(it.optDouble("candidate_price", 9.0) - 1.50) })
            .take(5)

        candidates.forEach { event ->
            val checkedAt = event.optString("research_checked_at")
            val fresh = try { checkedAt.isNotBlank() && Instant.parse(checkedAt).isAfter(now.minusSeconds(24L * 3600L)) } catch (_: Exception) { false }
            if (!fresh) {
                try {
                    val report = researchMatch(event.optString("home_team"), event.optString("away_team"), event.optString("sport_title"), includePlayerNews = false)
                    event.put("research_checked_at", now.toString())
                        .put("research_has_results", report.optBoolean("has_results_history"))
                        .put("research_home_recent", report.optJSONArray("home_recent") ?: JSONArray())
                        .put("research_away_recent", report.optJSONArray("away_recent") ?: JSONArray())
                        .put("research_home_profile", report.optJSONObject("home_profile") ?: JSONObject())
                        .put("research_away_profile", report.optJSONObject("away_profile") ?: JSONObject())
                        .put("research_home_players", report.optJSONArray("home_players") ?: JSONArray())
                        .put("research_away_players", report.optJSONArray("away_players") ?: JSONArray())
                        .put("research_news", report.optJSONArray("news") ?: JSONArray())
                        .put("research_availability_flags", report.optJSONArray("availability_flags") ?: JSONArray())
                        .put("research_web_notes", report.optJSONArray("web_notes") ?: JSONArray())
                        .put("research_sources", report.optJSONArray("sources") ?: JSONArray())
                } catch (_: Exception) {
                    event.put("research_checked_at", now.toString())
                        .put("research_has_results", false)
                }
            }
        }

        fun formStats(rows: JSONArray?): Pair<Int, Int> {
            if (rows == null) return 0 to 0
            var points = 0
            var played = 0
            for (i in 0 until rows.length()) {
                val row = rows.optJSONObject(i) ?: continue
                when (row.optString("outcome")) {
                    "W" -> { points += 3; played++ }
                    "D" -> { points += 1; played++ }
                    "L" -> { played++ }
                }
            }
            return points to played
        }

        val ranked = candidates.mapNotNull { event ->
            val homeRows = event.optJSONArray("research_home_recent")
            val awayRows = event.optJSONArray("research_away_recent")
            val (homePoints, homePlayed) = formStats(homeRows)
            val (awayPoints, awayPlayed) = formStats(awayRows)
            val selection = event.optString("candidate")
            val homeName = event.optString("home_team")
            val awayName = event.optString("away_team")
            val homePerGame = if (homePlayed > 0) homePoints.toDouble() / homePlayed else 0.0
            val awayPerGame = if (awayPlayed > 0) awayPoints.toDouble() / awayPlayed else 0.0
            val edge = when {
                selection.equals(homeName, ignoreCase = true) -> homePerGame - awayPerGame
                selection.equals(awayName, ignoreCase = true) -> awayPerGame - homePerGame
                else -> 0.0
            }
            val books = event.optInt("candidate_bookmakers")
            val price = event.optDouble("candidate_price", 0.0)
            val flags = event.optJSONArray("research_availability_flags")?.length() ?: 0

            // Conservative evidence gate: both teams need recent scored results, odds need
            // multi-book support, and the selected side must have a positive recent-form edge.
            val strong = books >= 4 && homePlayed >= 4 && awayPlayed >= 4 &&
                edge >= 0.60 && price in 1.25..1.65 && flags == 0
            val moderate = books >= 3 && homePlayed >= 3 && awayPlayed >= 3 &&
                edge >= 0.25 && price in 1.25..1.75 && flags <= 1
            if (!strong && !moderate) return@mapNotNull null

            val evidenceIndex = (
                minOf(books, 5) * 8 +
                (minOf(homePlayed, 5) + minOf(awayPlayed, 5)) * 3 +
                ((edge + 1.0) * 10).toInt().coerceIn(0, 20) +
                if (price <= 1.50) 10 else 6
            ).coerceIn(0, 100)
            val reason = buildList {
                add("$books bookmakers return this selection")
                add("recent results available for both teams ($homePlayed home-team records, $awayPlayed away-team records)")
                add("selected team's recent points-per-game edge: %.2f".format(java.util.Locale.US, edge))
                if (flags > 0) add("possible team/player availability news needs manual confirmation")
            }.joinToString("; ")

            JSONObject()
                .put("id", event.optString("id"))
                .put("sport_key", event.optString("sport_key"))
                .put("sport_title", event.optString("sport_title"))
                .put("home_team", homeName)
                .put("away_team", awayName)
                .put("commence_time", event.optString("commence_time"))
                .put("selection", selection)
                .put("price", price)
                .put("bookmakers", books)
                .put("research_results_count", homePlayed + awayPlayed)
                .put("home_recent_count", homePlayed)
                .put("away_recent_count", awayPlayed)
                .put("form_edge_per_game", edge)
                .put("research_has_results", homePlayed > 0 && awayPlayed > 0)
                .put("home_profile", event.optJSONObject("research_home_profile") ?: JSONObject())
                .put("away_profile", event.optJSONObject("research_away_profile") ?: JSONObject())
                .put("home_players", event.optJSONArray("research_home_players") ?: JSONArray())
                .put("away_players", event.optJSONArray("research_away_players") ?: JSONArray())
                .put("news", event.optJSONArray("research_news") ?: JSONArray())
                .put("availability_flags", event.optJSONArray("research_availability_flags") ?: JSONArray())
                .put("research_sources", event.optJSONArray("research_sources") ?: JSONArray())
                .put("evidence_index", evidenceIndex)
                .put("confidence", if (strong) "Stronger evidence — still uncertain" else "Moderate evidence — still uncertain")
                .put("reason", reason)
        }.sortedWith(compareByDescending<JSONObject> { it.optInt("evidence_index") }
            .thenByDescending { it.optInt("bookmakers") }).take(3)

        val result = JSONArray()
        ranked.forEach { result.put(it) }
        val db = LocalSportsDatabase.get(context)
        // Keep the researched fixture, profiles, roster, news and source references on-device.
        candidates.forEach { event ->
            val id = event.optString("id")
            if (id.isNotBlank()) {
                db.put("match", id, event)
                db.put("match_research", id, JSONObject()
                    .put("event_id", id)
                    .put("checked_at", event.optString("research_checked_at"))
                    .put("home_profile", event.optJSONObject("research_home_profile") ?: JSONObject())
                    .put("away_profile", event.optJSONObject("research_away_profile") ?: JSONObject())
                    .put("home_recent", event.optJSONArray("research_home_recent") ?: JSONArray())
                    .put("away_recent", event.optJSONArray("research_away_recent") ?: JSONArray())
                    .put("home_players", event.optJSONArray("research_home_players") ?: JSONArray())
                    .put("away_players", event.optJSONArray("research_away_players") ?: JSONArray())
                    .put("news", event.optJSONArray("research_news") ?: JSONArray())
                    .put("sources", event.optJSONArray("research_sources") ?: JSONArray()))
            }
        }
        val pickDate = java.time.LocalDate.now(java.time.ZoneId.systemDefault()).toString()
        db.put("daily_picks", pickDate, JSONObject().put("date", pickDate).put("picks", result))
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("ash_daily_picks_json", result.toString())
            .putString("ash_daily_picks_date", pickDate)
            .apply()
        return result
    }

    private fun summarize(event: JSONObject, sportKey: String, sportTitle: String, now: String, prior: JSONObject?): JSONObject {
        val prices = mutableMapOf<String, MutableList<Double>>()
        val books = event.optJSONArray("bookmakers") ?: JSONArray()
        for (b in 0 until books.length()) {
            val book = books.optJSONObject(b) ?: continue
            val markets = book.optJSONArray("markets") ?: JSONArray()
            for (m in 0 until markets.length()) {
                val market = markets.optJSONObject(m) ?: continue
                if (market.optString("key") != "h2h") continue
                val outcomes = market.optJSONArray("outcomes") ?: JSONArray()
                for (o in 0 until outcomes.length()) {
                    val outcome = outcomes.optJSONObject(o) ?: continue
                    val name = outcome.optString("name")
                    val price = outcome.optDouble("price", 0.0)
                    if (name.isNotBlank() && price > 1.0) prices.getOrPut(name) { mutableListOf() }.add(price)
                }
            }
        }
        var bestName = ""
        var bestAvg = 0.0
        var bestBooks = 0
        for ((name, list) in prices) {
            val avg = list.average()
            if (list.size >= 2 && avg in 1.20..1.90 &&
                (list.size > bestBooks || (list.size == bestBooks && kotlin.math.abs(avg - 1.55) < kotlin.math.abs(bestAvg - 1.55)))) {
                bestName = name; bestAvg = avg; bestBooks = list.size
            }
        }
        val snapshots = prior?.optJSONArray("snapshots") ?: JSONArray()
        snapshots.put(JSONObject().put("seen_at", now).put("bookmakers", books.length())
            .put("best_candidate", bestName).put("average_price", if (bestAvg > 0) bestAvg else JSONObject.NULL))
        // Keep every collected odds snapshot for long-term movement analysis.
        return JSONObject()
            .put("id", event.optString("id"))
            .put("sport_key", sportKey)
            .put("sport_title", sportTitle)
            .put("home_team", event.optString("home_team"))
            .put("away_team", event.optString("away_team"))
            .put("commence_time", event.optString("commence_time"))
            .put("first_seen", prior?.optString("first_seen")?.takeIf { !it.isNullOrBlank() } ?: now)
            .put("last_seen", now)
            .put("bookmaker_count", books.length())
            .put("candidate", bestName)
            .put("candidate_price", if (bestAvg > 0) bestAvg else JSONObject.NULL)
            .put("candidate_bookmakers", bestBooks)
            .put("snapshots", snapshots)
    }

    /**
     * Multi-source research for a fixture. Uses team profiles, recent events, available roster
     * metadata and current news snippets. Public sources can be incomplete or wrong; every
     * field is labelled as evidence, never treated as confirmed injury or guaranteed prediction.
     */
    fun researchMatch(homeTeam: String, awayTeam: String, sportTitle: String, includePlayerNews: Boolean = true): JSONObject {
        val report = JSONObject()
            .put("home_team", homeTeam)
            .put("away_team", awayTeam)
            .put("sport_title", sportTitle)
            .put("researched_at", Instant.now().toString())
        val sources = JSONArray()
        val homeRecent = JSONArray()
        val awayRecent = JSONArray()
        val webNotes = JSONArray()
        val homePlayers = JSONArray()
        val awayPlayers = JSONArray()
        val news = JSONArray()

        fun norm(value: String): String = value.lowercase().replace(Regex("[^a-z0-9]"), "")

        fun searchTeam(teamName: String): JSONObject? {
            val url = "https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=" +
                URLEncoder.encode(teamName, "UTF-8")
            val teams = researchRequest(url).optJSONArray("teams") ?: return null
            if (teams.length() == 0) return null
            val requested = norm(teamName)
            val exact = (0 until teams.length()).mapNotNull { teams.optJSONObject(it) }
                .firstOrNull { norm(it.optString("strTeam")) == requested }
            if (exact != null) return exact
            // Avoid silently attaching another club's roster/results to a similarly named team.
            return (0 until teams.length()).mapNotNull { teams.optJSONObject(it) }
                .firstOrNull {
                    val found = norm(it.optString("strTeam"))
                    found.length >= 5 && (found.contains(requested) || requested.contains(found))
                }
        }

        fun addTeamProfile(team: JSONObject?, teamName: String, label: String) {
            if (team == null) {
                report.put("${label}_profile", JSONObject().put("team", teamName).put("found", false))
                return
            }
            val description = team.optString("strDescriptionEN").trim()
            report.put("${label}_profile", JSONObject()
                .put("team", team.optString("strTeam", teamName))
                .put("found", true)
                .put("sport", team.optString("strSport"))
                .put("league", team.optString("strLeague"))
                .put("country", team.optString("strCountry"))
                .put("formed_year", team.optString("intFormedYear"))
                .put("stadium", team.optString("strStadium"))
                .put("description", description.take(900)))
            val id = team.optString("idTeam")
            if (id.isNotBlank()) sources.put("TheSportsDB team profile: " + team.optString("strTeam", teamName))
        }

        fun loadRecent(team: JSONObject?, destination: JSONArray, teamName: String) {
            val id = team?.optString("idTeam").orEmpty()
            if (id.isBlank()) return
            val url = "https://www.thesportsdb.com/api/v1/json/3/eventslast.php?id=" +
                URLEncoder.encode(id, "UTF-8")
            val events = researchRequest(url).optJSONArray("results") ?: return
            for (i in 0 until minOf(events.length(), 5)) {
                val e = events.optJSONObject(i) ?: continue
                val home = e.optString("strHomeTeam")
                val away = e.optString("strAwayTeam")
                val hs = e.optString("intHomeScore")
                val ascore = e.optString("intAwayScore")
                val h = hs.toIntOrNull()
                val a = ascore.toIntOrNull()
                val teamIsHome = e.optString("idHomeTeam") == id ||
                    norm(home) == norm(team?.optString("strTeam", teamName) ?: teamName)
                val outcome = if (h == null || a == null) {
                    "result unavailable"
                } else {
                    val teamScore = if (teamIsHome) h else a
                    val opponentScore = if (teamIsHome) a else h
                    when {
                        teamScore > opponentScore -> "W"
                        teamScore < opponentScore -> "L"
                        else -> "D"
                    }
                }
                destination.put(JSONObject()
                    .put("date", e.optString("dateEvent"))
                    .put("event", e.optString("strEvent"))
                    .put("home", home)
                    .put("away", away)
                    .put("home_score", hs)
                    .put("away_score", ascore)
                    .put("outcome", outcome))
            }
        }

        fun loadPlayers(team: JSONObject?, destination: JSONArray) {
            val id = team?.optString("idTeam").orEmpty()
            if (id.isBlank()) return
            val url = "https://www.thesportsdb.com/api/v1/json/3/lookup_all_players.php?id=" +
                URLEncoder.encode(id, "UTF-8")
            val players = researchRequest(url).optJSONArray("player") ?: return
            // Keep the available squad list concise and avoid storing large biography blobs.
            for (i in 0 until minOf(players.length(), 12)) {
                val p = players.optJSONObject(i) ?: continue
                val name = p.optString("strPlayer").trim()
                if (name.isBlank()) continue
                destination.put(JSONObject()
                    .put("name", name)
                    .put("position", p.optString("strPosition"))
                    .put("nationality", p.optString("strNationality"))
                    .put("number", p.optString("strNumber"))
                    .put("status", p.optString("strStatus"))
                    .put("description", p.optString("strDescriptionEN").trim().take(320))
                    .put("thumb", p.optString("strCutout", p.optString("strThumb"))))
            }
            if (destination.length() > 0) sources.put("TheSportsDB available squad metadata")
        }

        fun decodeFeedText(value: String): String = value
            .replace(Regex("(?is)<!\\[CDATA\\[(.*?)]]>")) { it.groupValues[1] }
            .replace(Regex("(?is)<[^>]+>"), " ")
            .replace("&amp;", "&").replace("&quot;", "\"")
            .replace("&#39;", "'").replace("&#039;", "'")
            .replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">")
            .replace(Regex("&#(\\d+);")) { match ->
                match.groupValues[1].toIntOrNull()?.let { String(Character.toChars(it)) } ?: match.value
            }
            .replace(Regex("\\s+"), " ").trim()

        fun tagValue(block: String, tag: String): String {
            val match = Regex("(?is)<$tag\\b[^>]*>(.*?)</$tag\\s*>").find(block)
            return match?.groupValues?.getOrNull(1)?.let { decodeFeedText(it) }.orEmpty()
        }

        fun searchNews(query: String, teamName: String) {
            val url = "https://news.google.com/rss/search?q=" +
                URLEncoder.encode(query, "UTF-8") + "&hl=en-US&gl=US&ceid=US:en"
            val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 9000
                readTimeout = 12000
                setRequestProperty("User-Agent", "AshJarvis-SportsResearch/1.0 (Android)")
            }
            try {
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val xml = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                if (code !in 200..299) throw IllegalStateException("News search HTTP $code")
                val items = Regex("(?is)<item\\b[^>]*>(.*?)</item>").findAll(xml).take(5)
                for (itemMatch in items) {
                    val block = itemMatch.groupValues[1]
                    val title = tagValue(block, "title")
                    val link = Regex("(?is)<link\\b[^>]*>(.*?)</link\\s*>").find(block)
                        ?.groupValues?.getOrNull(1)?.trim().orEmpty()
                    val description = tagValue(block, "description")
                    val published = tagValue(block, "pubDate")
                    if (title.isNotBlank()) {
                        val item = JSONObject()
                            .put("team", teamName)
                            .put("title", title.take(220))
                            .put("snippet", description.take(420))
                            .put("published", published)
                            .put("url", link)
                        news.put(item)
                        webNotes.put(item)
                    }
                }
            } finally {
                connection.disconnect()
            }
        }

        var home: JSONObject? = null
        var away: JSONObject? = null
        try { home = searchTeam(homeTeam); addTeamProfile(home, homeTeam, "home") } catch (_: Exception) {
            report.put("home_profile", JSONObject().put("team", homeTeam).put("found", false))
        }
        try { away = searchTeam(awayTeam); addTeamProfile(away, awayTeam, "away") } catch (_: Exception) {
            report.put("away_profile", JSONObject().put("team", awayTeam).put("found", false))
        }
        try { loadRecent(home, homeRecent, homeTeam) } catch (_: Exception) { }
        try { loadRecent(away, awayRecent, awayTeam) } catch (_: Exception) { }
        try { loadPlayers(home, homePlayers) } catch (_: Exception) { }
        try { loadPlayers(away, awayPlayers) } catch (_: Exception) { }
        try { searchNews("\"$homeTeam\" $sportTitle latest news injuries unavailable lineup recent form player stats goals assists top scorer", homeTeam) } catch (_: Exception) { }
        try { searchNews("\"$awayTeam\" $sportTitle latest news injuries unavailable lineup recent form player stats goals assists top scorer", awayTeam) } catch (_: Exception) { }
        // On-demand deep research also checks recent public news about a few rostered players.
        // Daily background refresh skips these extra calls to protect free-source rate limits.
        if (includePlayerNews) {
            listOf(homePlayers to homeTeam, awayPlayers to awayTeam).forEach { pair ->
                val roster = pair.first
                for (i in 0 until minOf(roster.length(), 2)) {
                    val player = roster.optJSONObject(i)?.optString("name").orEmpty()
                    if (player.isBlank()) continue
                    try {
                        searchNews("\"$player\" $sportTitle stats goals assists performance form injury availability", "Player: $player")
                    } catch (_: Exception) { }
                }
            }
        }
        if (news.length() > 0) sources.put("Google News RSS search results")
        if (webNotes.length() > 0) {
            for (i in 0 until minOf(webNotes.length(), 6)) {
                val item = webNotes.optJSONObject(i) ?: continue
                val snippet = item.optString("snippet")
                if (snippet.isNotBlank()) item.put("snippet", snippet.take(320))
            }
        }

        val riskTerms = listOf("injured", "injury", "unavailable", "suspended", "doubtful", "ruled out", "misses", "out of")
        val flags = JSONArray()
        for (i in 0 until news.length()) {
            val item = news.optJSONObject(i) ?: continue
            val text = (item.optString("title") + " " + item.optString("snippet")).lowercase()
            val matched = riskTerms.filter { text.contains(it) }
            if (matched.isNotEmpty()) flags.put(JSONObject()
                .put("team", item.optString("team"))
                .put("headline", item.optString("title"))
                .put("terms", matched.joinToString(", ")))
        }

        report.put("home_recent", homeRecent)
            .put("away_recent", awayRecent)
            .put("home_players", homePlayers)
            .put("away_players", awayPlayers)
            .put("web_notes", webNotes)
            .put("news", news)
            .put("availability_flags", flags)
            .put("sources", sources)
            .put("has_results_history", homeRecent.length() > 0 || awayRecent.length() > 0)
            .put("evidence_summary", JSONObject()
                .put("home_results", homeRecent.length())
                .put("away_results", awayRecent.length())
                .put("home_players", homePlayers.length())
                .put("away_players", awayPlayers.length())
                .put("news_items", news.length())
                .put("possible_availability_flags", flags.length()))
        return report
    }

    private fun researchRequest(url: String): JSONObject {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 9000
            readTimeout = 12000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "AshJarvis-SportsResearch/1.0 (Android)")
        }
        try {
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) throw IllegalStateException("Research source HTTP $code")
            return JSONObject(body)
        } finally {
            connection.disconnect()
        }
    }

}
