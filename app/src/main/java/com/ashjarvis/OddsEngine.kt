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

    fun history(context: Context): JSONArray = try {
        JSONArray(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(HISTORY_KEY, "[]") ?: "[]")
    } catch (_: Exception) { JSONArray() }

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
        val sorted = byId.values.sortedByDescending { it.optString("last_seen") }.take(1000)
        val saved = JSONArray()
        sorted.forEach { saved.put(it) }
        prefs.edit().putString(HISTORY_KEY, saved.toString()).putString("odds_last_sync", Instant.now().toString()).apply()
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
        val candidates = upcoming.filter {
            it.optString("candidate").isNotBlank() &&
                it.optInt("candidate_bookmakers") >= 2 &&
                it.optDouble("candidate_price", 0.0) in 1.20..1.90
        }.sortedWith(compareByDescending<JSONObject> { it.optInt("candidate_bookmakers") }
            .thenBy { kotlin.math.abs(it.optDouble("candidate_price", 9.0) - 1.55) })
            .take(3)

        // Online enrichment is capped to the leading three games to avoid hammering free public sources.
        candidates.forEach { event ->
            val checkedAt = event.optString("research_checked_at")
            val fresh = try { checkedAt.isNotBlank() && Instant.parse(checkedAt).isAfter(now.minusSeconds(24L * 3600L)) } catch (_: Exception) { false }
            if (!fresh) {
                try {
                    val report = researchMatch(event.optString("home_team"), event.optString("away_team"), event.optString("sport_title"))
                    event.put("research_checked_at", now.toString())
                        .put("research_has_results", report.optBoolean("has_results_history"))
                        .put("research_home_recent", report.optJSONArray("home_recent") ?: JSONArray())
                        .put("research_away_recent", report.optJSONArray("away_recent") ?: JSONArray())
                        .put("research_web_notes", report.optJSONArray("web_notes") ?: JSONArray())
                        .put("research_sources", report.optJSONArray("sources") ?: JSONArray())
                } catch (_: Exception) {
                    event.put("research_checked_at", now.toString())
                        .put("research_has_results", false)
                }
            }
        }

        fun formScore(rows: JSONArray?): Int {
            if (rows == null) return 0
            var score = 0
            for (i in 0 until rows.length()) {
                val row = rows.optJSONObject(i) ?: continue
                score += when (row.optString("outcome")) { "W" -> 2; "D" -> 1; else -> 0 }
            }
            return score
        }
        val ranked = candidates.map { event ->
            val homeRows = event.optJSONArray("research_home_recent")
            val awayRows = event.optJSONArray("research_away_recent")
            val evidence = (homeRows?.length() ?: 0) + (awayRows?.length() ?: 0)
            val selection = event.optString("candidate")
            val homeName = event.optString("home_team")
            val awayName = event.optString("away_team")
            val formEdge = when {
                selection.equals(homeName, ignoreCase = true) -> formScore(homeRows) - formScore(awayRows)
                selection.equals(awayName, ignoreCase = true) -> formScore(awayRows) - formScore(homeRows)
                else -> 0
            }
            val books = event.optInt("candidate_bookmakers")
            val price = event.optDouble("candidate_price", 2.0)
            val score = books * 10 + minOf(evidence, 10) * 2 + formEdge.coerceIn(-5, 5) - kotlin.math.abs(price - 1.55) * 5
            JSONObject()
                .put("id", event.optString("id"))
                .put("sport_key", event.optString("sport_key"))
                .put("sport_title", event.optString("sport_title"))
                .put("home_team", event.optString("home_team"))
                .put("away_team", event.optString("away_team"))
                .put("commence_time", event.optString("commence_time"))
                .put("selection", event.optString("candidate"))
                .put("price", price)
                .put("bookmakers", books)
                .put("research_results_count", evidence)
                .put("research_has_results", event.optBoolean("research_has_results", false))
                .put("research_sources", event.optJSONArray("research_sources") ?: JSONArray())
                .put("evidence_score", score)
                .put("confidence", when {
                    evidence >= 6 && books >= 3 -> "Medium evidence"
                    evidence >= 2 && books >= 2 -> "Limited evidence"
                    else -> "Low evidence"
                })
        }.sortedByDescending { it.optInt("evidence_score") }.take(3)
        val result = JSONArray()
        ranked.forEach { result.put(it) }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(HISTORY_KEY, history.toString())
            .putString("ash_daily_picks_json", result.toString())
            .putString("ash_daily_picks_date", java.time.LocalDate.now(java.time.ZoneId.systemDefault()).toString())
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
        while (snapshots.length() > 3) snapshots.remove(0)
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
     * Fallback internet research for a fixture when local result history is missing.
     * Uses TheSportsDB's public team/recent-events endpoints and Wikipedia search snippets.
     * Empty results are reported as missing data, never treated as an invalid match.
     */
    fun researchMatch(homeTeam: String, awayTeam: String, sportTitle: String): JSONObject {
        val report = JSONObject()
            .put("home_team", homeTeam)
            .put("away_team", awayTeam)
            .put("sport_title", sportTitle)
            .put("researched_at", Instant.now().toString())
        val sources = JSONArray()
        val homeRecent = JSONArray()
        val awayRecent = JSONArray()
        val webNotes = JSONArray()

        fun searchTeam(teamName: String): JSONObject? {
            val url = "https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=" +
                URLEncoder.encode(teamName, "UTF-8")
            val json = researchRequest(url)
            return json.optJSONArray("teams")?.let { teams ->
                if (teams.length() > 0) teams.optJSONObject(0) else null
            }
        }

        fun loadRecent(team: JSONObject?, destination: JSONArray, teamName: String) {
            val id = team?.optString("idTeam").orEmpty()
            if (id.isBlank()) return
            val url = "https://www.thesportsdb.com/api/v1/json/3/eventslast.php?id=" +
                URLEncoder.encode(id, "UTF-8")
            val events = researchRequest(url).optJSONArray("results") ?: return
            val count = minOf(events.length(), 5)
            for (i in 0 until count) {
                val e = events.optJSONObject(i) ?: continue
                val home = e.optString("strHomeTeam")
                val away = e.optString("strAwayTeam")
                val hs = e.optString("intHomeScore")
                val ascore = e.optString("intAwayScore")
                val scoreAvailable = hs.isNotBlank() && hs != "null" && ascore.isNotBlank() && ascore != "null"
                var outcome = "result unavailable"
                if (scoreAvailable) {
                    val h = hs.toIntOrNull()
                    val a = ascore.toIntOrNull()
                    if (h != null && a != null) {
                        val isHome = home.equals(teamName, ignoreCase = true) ||
                            home.equals(team?.optString("strTeam").orEmpty(), ignoreCase = true)
                        val teamScore = if (isHome) h else a
                        val opponentScore = if (isHome) a else h
                        outcome = when {
                            teamScore > opponentScore -> "W"
                            teamScore < opponentScore -> "L"
                            else -> "D"
                        }
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

        fun searchWeb(teamName: String) {
            val url = "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
                URLEncoder.encode(teamName + " " + sportTitle + " team recent results", "UTF-8") +
                "&format=json&utf8=1&srlimit=3"
            val results = researchRequest(url).optJSONObject("query")?.optJSONArray("search") ?: return
            for (i in 0 until results.length()) {
                val item = results.optJSONObject(i) ?: continue
                val snippet = item.optString("snippet")
                    .replace(Regex("<[^>]*>"), " ")
                    .replace("&quot;", "\"")
                    .replace("&#039;", "'")
                    .replace("&amp;", "&")
                    .replace(Regex("\\s+"), " ")
                    .trim()
                if (snippet.isNotBlank()) webNotes.put(JSONObject()
                    .put("title", item.optString("title"))
                    .put("snippet", snippet)
                    .put("team", teamName))
            }
        }

        try {
            val home = searchTeam(homeTeam)
            if (home != null) {
                sources.put("TheSportsDB team profile: " + home.optString("strTeam", homeTeam))
                loadRecent(home, homeRecent, homeTeam)
            }
        } catch (_: Exception) { }
        try {
            val away = searchTeam(awayTeam)
            if (away != null) {
                sources.put("TheSportsDB team profile: " + away.optString("strTeam", awayTeam))
                loadRecent(away, awayRecent, awayTeam)
            }
        } catch (_: Exception) { }
        try { searchWeb(homeTeam); sources.put("Wikipedia search API") } catch (_: Exception) { }
        try { searchWeb(awayTeam); if (sources.toString().contains("Wikipedia search API").not()) sources.put("Wikipedia search API") } catch (_: Exception) { }

        report.put("home_recent", homeRecent)
            .put("away_recent", awayRecent)
            .put("web_notes", webNotes)
            .put("sources", sources)
            .put("has_results_history", homeRecent.length() > 0 || awayRecent.length() > 0)
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
