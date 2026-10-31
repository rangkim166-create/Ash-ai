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

    /**
     * One real odd/even market check per local day. This deliberately spends at most
     * one extra event-market request and never manufactures a price when the feed lacks it.
     */
    fun dailyOddEvenTip(context: Context, apiKey: String): JSONObject? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val day = java.time.LocalDate.now(java.time.ZoneId.systemDefault()).toString()
        val db = LocalSportsDatabase.get(context)
        db.get("daily_odd_even", day)?.optJSONObject("tip")?.let { return it }
        if (prefs.getString("ash_odd_even_checked_date", null) == day) return null

        val events = history(context)
        val candidates = (0 until events.length()).mapNotNull { events.optJSONObject(it) }
            .filter { event ->
                val sport = (event.optString("sport_key") + " " + event.optString("sport_title")).lowercase()
                (sport.contains("soccer") || sport.contains("football")) &&
                    runCatching { Instant.parse(event.optString("commence_time")).isAfter(Instant.now()) }.getOrDefault(false)
            }.sortedBy { it.optString("commence_time") }
        if (candidates.isEmpty()) {
            prefs.edit().putString("ash_odd_even_checked_date", day).apply()
            db.put("daily_odd_even", day, JSONObject().put("date", day).put("status", "no_upcoming_football"))
            return null
        }

        val event = candidates.first()
        val requestDay = prefs.getString("ash_odds_request_day", null)
        var requestsUsed = if (requestDay == day) prefs.getInt("ash_odds_request_count", 0) else 0
        if (requestsUsed >= 14) {
            prefs.edit().putString("ash_odd_even_checked_date", day).apply()
            db.put("daily_odd_even", day, JSONObject().put("date", day).put("status", "daily_request_cap_reached"))
            return null
        }
        requestsUsed++
        prefs.edit().putString("ash_odds_request_day", day).putInt("ash_odds_request_count", requestsUsed).apply()
        return try {
            val payload = checkOddEven(apiKey, event.optString("sport_key"), event.optString("id"))
            val eventData = payload.optJSONArray("data")?.optJSONObject(0)
            val books = payload.optJSONArray("bookmakers")
                ?: eventData?.optJSONArray("bookmakers")
                ?: payload.optJSONObject("data")?.optJSONArray("bookmakers")
                ?: JSONArray()
            val pricesByOutcome = linkedMapOf<String, MutableList<Double>>()
            val fairByOutcome = linkedMapOf<String, MutableList<Double>>()
            val bookNames = linkedMapOf<String, MutableList<String>>()
            for (i in 0 until books.length()) {
                val book = books.optJSONObject(i) ?: continue
                val markets = book.optJSONArray("markets") ?: JSONArray()
                for (j in 0 until markets.length()) {
                    val market = markets.optJSONObject(j) ?: continue
                    if (market.optString("key") !in setOf("odd_even", "odd_even_goals", "total_goals_odd_even")) continue
                    val outcomes = market.optJSONArray("outcomes") ?: JSONArray()
                    val valid = (0 until outcomes.length()).mapNotNull { k ->
                        val outcome = outcomes.optJSONObject(k) ?: return@mapNotNull null
                        val name = outcome.optString("name").trim()
                        val price = outcome.optDouble("price", 0.0)
                        if (name.isBlank() || price !in 1.35..1.65) null else name to price
                    }
                    if (valid.size < 2) continue
                    val overround = valid.sumOf { 1.0 / it.second }
                    if (overround <= 0.0) continue
                    valid.forEach { (name, price) ->
                        pricesByOutcome.getOrPut(name) { mutableListOf() }.add(price)
                        fairByOutcome.getOrPut(name) { mutableListOf() }.add((1.0 / price) / overround)
                        bookNames.getOrPut(name) { mutableListOf() }.add(book.optString("title", book.optString("key")))
                    }
                }
            }
            val selected = pricesByOutcome.entries
                .filter { it.value.size >= 2 }
                .maxWithOrNull(compareBy<Map.Entry<String, MutableList<Double>>> { it.value.size }
                    .thenBy { -kotlin.math.abs(it.value.average() - 1.50) })
            val tip = selected?.let { entry ->
                val averagePrice = entry.value.average()
                val bestIndex = entry.value.indices.maxByOrNull { entry.value[it] } ?: 0
                val bestPrice = entry.value[bestIndex]
                JSONObject()
                    .put("id", event.optString("id"))
                    .put("sport_key", event.optString("sport_key"))
                    .put("sport_title", event.optString("sport_title"))
                    .put("home_team", event.optString("home_team"))
                    .put("away_team", event.optString("away_team"))
                    .put("commence_time", event.optString("commence_time"))
                    .put("selection", entry.key)
                    .put("price", bestPrice)
                    .put("average_market_price", averagePrice)
                    .put("bookmaker", bookNames[entry.key]?.getOrNull(bestIndex).orEmpty())
                    .put("bookmaker_names", bookNames[entry.key]?.distinct()?.joinToString(", ").orEmpty())
                    .put("bookmakers", entry.value.size)
                    .put("market_probability_pct", fairByOutcome[entry.key]?.average()?.times(100.0) ?: JSONObject.NULL)
                    .put("probability_method", "Average de-vigged bookmaker odd/even market probability; not an independent Ash forecast")
                    .put("reason", "Real odd/even prices returned by multiple bookmakers; verify again before publishing because prices move.")
                    .put("target_band", "1.35–1.65")
            }
            prefs.edit().putString("ash_odd_even_checked_date", day).apply()
            if (tip != null) {
                TipResultsTracker.publish(context, tip, "odd_even")
                db.put("daily_odd_even", day, JSONObject().put("date", day).put("status", "found").put("tip", tip))
            } else {
                db.put("daily_odd_even", day, JSONObject().put("date", day).put("status", "market_unavailable")
                    .put("event_id", event.optString("id")))
            }
            tip
        } catch (e: Exception) {
            prefs.edit().putString("ash_odd_even_checked_date", day).apply()
            db.put("daily_odd_even", day, JSONObject().put("date", day).put("status", "request_failed")
                .put("error", (e.message ?: "market request failed").take(180)))
            null
        }
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

    fun loadBackendSports(): JSONArray {
        val payload = requestJson("https://ash-sports-api.onrender.com/v1/public/odds/sports").first
        return payload.optJSONArray("data") ?: JSONArray()
    }

    fun syncFromBackend(context: Context): SyncResult {
        val payload = requestJson("https://ash-sports-api.onrender.com/v1/public/odds/events").first
        val events = payload.optJSONArray("data") ?: JSONArray()
        val old = history(context)
        val byId = linkedMapOf<String, JSONObject>()
        for (i in 0 until old.length()) {
            val item = old.optJSONObject(i) ?: continue
            val id = item.optString("id")
            if (id.isNotBlank()) byId[id] = item
        }
        var found = 0
        var added = 0
        val errors = mutableListOf<String>()
        for (i in 0 until events.length()) {
            val event = events.optJSONObject(i) ?: continue
            val id = event.optString("id")
            if (id.isBlank()) continue
            val prior = byId[id]
            val sportKey = event.optString("sport_key")
            val sportTitle = event.optString("sport_title")
            val summary = summarize(event, sportKey, sportTitle, Instant.now().toString(), prior)
            if (prior == null) added++
            byId[id] = summary
            LocalSportsDatabase.get(context).put("match", id, summary)
            found++
        }
        val sorted = byId.values.sortedByDescending { it.optString("last_seen") }
        val cache = JSONArray()
        sorted.take(1000).forEach { cache.put(it) }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(HISTORY_KEY, cache.toString())
            .putString("odds_last_sync", Instant.now().toString())
            .apply()
        return SyncResult(found, added, 0, errors, null)
    }

    fun sync(context: Context, apiKey: String): SyncResult {
        val allSports = loadSports(apiKey)
        val active = (0 until allSports.length()).mapNotNull { allSports.optJSONObject(it) }
            .filter { it.optBoolean("active", true) && it.optString("key").isNotBlank() }
        // Scan only user-selected competitions; each odds endpoint consumes quota.
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val storedSelection = prefs.getString(FAVORITES_KEY, null)
        val selectedKeys = if (storedSelection != null) {
            storedSelection.split(",").map { it.trim() }.filter { it.isNotBlank() }.toSet()
        } else {
            val chosen = linkedSetOf<String>()
            fun pick(predicate: (JSONObject) -> Boolean, preferred: List<String>) {
                val match = preferred.firstNotNullOfOrNull { key -> active.firstOrNull { it.optString("key") == key } }
                    ?: active.firstOrNull(predicate)
                match?.optString("key")?.takeIf { it.isNotBlank() }?.let(chosen::add)
            }
            pick({ it.optString("key").startsWith("soccer_") || it.optString("group").contains("soccer", true) || it.optString("title").contains("Premier League", true) },
                listOf("soccer_epl", "soccer_uefa_champs_league", "soccer_spain_la_liga"))
            pick({ it.optString("key").startsWith("basketball_") || it.optString("group").contains("basket", true) || it.optString("title").contains("basket", true) },
                listOf("basketball_nba"))
            pick({ it.optString("key").startsWith("tennis_") || it.optString("group").contains("tennis", true) || it.optString("title").contains("tennis", true) }, emptyList())
            prefs.edit().putString(FAVORITES_KEY, chosen.joinToString(",")).apply()
            chosen
        }
        val sports = active.filter { it.optString("key") in selectedKeys }.take(12)
        val old = history(context)
        val byId = linkedMapOf<String, JSONObject>()
        for (i in 0 until old.length()) {
            val item = old.optJSONObject(i) ?: continue
            val id = item.optString("id")
            if (id.isNotBlank()) byId[id] = item
        }
        var found = 0
        var added = 0
        var checkedSports = 0
        var remaining: String? = null
        val errors = mutableListOf<String>()
        val requestDay = java.time.LocalDate.now(java.time.ZoneId.systemDefault()).toString()
        if (prefs.getString("ash_odds_request_day", null) != requestDay) {
            prefs.edit().putString("ash_odds_request_day", requestDay).putInt("ash_odds_request_count", 0).apply()
        }
        var requestsUsed = prefs.getInt("ash_odds_request_count", 0)
        for (sport in sports) {
            if (requestsUsed >= 13) {
                errors.add("Daily odds-request safety cap reached (13 market requests). Refresh tomorrow to protect the monthly quota.")
                break
            }
            val sportKey = sport.optString("key")
            try {
                requestsUsed++
                checkedSports++
                prefs.edit().putInt("ash_odds_request_count", requestsUsed).apply()
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
        return SyncResult(found, added, checkedSports, errors, remaining)
    }

    fun savedDailyPicks(context: Context): JSONArray {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val date = prefs.getString("ash_daily_picks_date",
            java.time.LocalDate.now(java.time.ZoneId.systemDefault()).toString()).orEmpty()
        val archived = LocalSportsDatabase.get(context).get("daily_picks", date)?.optJSONArray("picks")
        if (archived != null) return archived
        return try { JSONArray(prefs.getString("ash_daily_picks_json", "[]") ?: "[]") }
        catch (_: Exception) { JSONArray() }
    }

    /**
     * Build a small daily evidence shortlist from real upcoming API fixtures.
     * For the leading candidates, research recent results online when local evidence is absent/stale.
     * Never fabricates results or treats missing data as a losing/winning signal.
     */
    fun buildDailyPicks(context: Context): JSONArray {
        val now = Instant.now()
        // Refresh global historical Elo independently of bookmaker API quota.
        // A failed download leaves the phone's previous snapshot intact.
        val historicalRatingRefresh = runCatching { HistoricalRatingsEngine.refreshIfStale(context) }.getOrNull()
        val history = history(context)
        val upcoming = (0 until history.length()).mapNotNull { history.optJSONObject(it) }
            .filter {
                val kickoff = it.optString("commence_time")
                kickoff.isNotBlank() && try { Instant.parse(kickoff).isAfter(now) } catch (_: Exception) { false }
            }
        // Diversify the research slate across football, basketball and tennis,
        // then sample the requested price bands instead of researching only short favourites.
        val candidatePool = upcoming.filter {
            it.optString("candidate").isNotBlank() &&
                it.optInt("candidate_bookmakers") >= 3 &&
                it.optDouble("candidate_price", 0.0) in 1.50..100.00
        }.sortedWith(compareByDescending<JSONObject> { it.optInt("candidate_bookmakers") }
            .thenBy { it.optDouble("candidate_price", 99.0) })
        val candidates = mutableListOf<JSONObject>()
        fun addFirst(predicate: (JSONObject) -> Boolean) {
            candidatePool.firstOrNull { candidate -> predicate(candidate) &&
                candidates.none { it.optString("id") == candidate.optString("id") } }?.let(candidates::add)
        }
        addFirst { it.optString("sport_key").startsWith("soccer_") || it.optString("sport_title").contains("football", true) }
        addFirst { it.optString("sport_key").startsWith("basketball_") || it.optString("sport_title").contains("basket", true) }
        addFirst { it.optString("sport_key").startsWith("tennis_") || it.optString("sport_title").contains("tennis", true) }
        listOf(1.50..2.00, 2.01..3.00, 3.01..5.00, 5.01..10.00, 10.01..20.00, 20.01..50.00, 50.01..100.00).forEach { band ->
            candidatePool.filter { it.optDouble("candidate_price", 0.0) in band }
                .forEach { candidate ->
                    if (candidates.size < 6 && candidates.none { it.optString("id") == candidate.optString("id") }) {
                        candidates.add(candidate)
                    }
                }
        }
        candidatePool.forEach { candidate ->
            if (candidates.size < 6 && candidates.none { it.optString("id") == candidate.optString("id") }) {
                candidates.add(candidate)
            }
        }

        candidates.forEach { event ->
            val checkedAt = event.optString("research_checked_at")
            val fresh = try { checkedAt.isNotBlank() && Instant.parse(checkedAt).isAfter(now.minusSeconds(24L * 3600L)) } catch (_: Exception) { false }
            if (!fresh) {
                try {
                    // Historical collection is independent of The Odds API quota.
                    runCatching {
                        HistoricalDataEngine.collectMatchHistory(
                            context,
                            event.optString("home_team"),
                            event.optString("away_team"),
                            event.optString("sport_title")
                        )
                    }
                    val report = researchMatch(event.optString("home_team"), event.optString("away_team"), event.optString("sport_title"), includePlayerNews = true)
                    fun combineRecent(label: String, teamName: String): JSONArray {
                        val combined = JSONArray()
                        val existing = report.optJSONArray("${label}_recent") ?: JSONArray()
                        val seen = linkedSetOf<String>()
                        for (index in 0 until existing.length()) {
                            val row = existing.optJSONObject(index) ?: continue
                            val identity = "${row.optString("date")}|${row.optString("event")}"
                            if (seen.add(identity)) combined.put(row)
                        }
                        val archived = HistoricalDataEngine.teamHistory(context, teamName, event.optString("sport_title"), 100)
                        for (index in 0 until archived.length()) {
                            val row = archived.optJSONObject(index) ?: continue
                            val identity = "${row.optString("date")}|${row.optString("event")}"
                            if (seen.add(identity)) combined.put(row)
                        }
                        return combined
                    }
                    val homeRecent = combineRecent("home", event.optString("home_team"))
                    val awayRecent = combineRecent("away", event.optString("away_team"))
                    event.put("research_checked_at", now.toString())
                        .put("research_has_results", homeRecent.length() > 0 && awayRecent.length() > 0)
                        .put("research_home_recent", homeRecent)
                        .put("research_away_recent", awayRecent)
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

        data class FormSummary(val played: Int, val weightedWinRate: Double, val wins: Int, val losses: Int, val draws: Int)
        fun formStats(rows: JSONArray?): FormSummary {
            if (rows == null) return FormSummary(0, 0.0, 0, 0, 0)
            val valid = (0 until rows.length()).mapNotNull { index ->
                val row = rows.optJSONObject(index) ?: return@mapNotNull null
                if (row.optString("outcome").uppercase() !in setOf("W", "L", "D")) null else row
            }.take(10)
            var weighted = 0.0
            var weightTotal = 0.0
            var wins = 0
            var losses = 0
            var draws = 0
            valid.forEachIndexed { index, row ->
                val weight = 1.0 / (1.0 + index * 0.18)
                val score = when (row.optString("outcome").uppercase()) {
                    "W" -> { wins++; 1.0 }
                    "D" -> { draws++; 0.5 }
                    else -> { losses++; 0.0 }
                }
                weighted += score * weight
                weightTotal += weight
            }
            return FormSummary(valid.size, if (weightTotal > 0.0) weighted / weightTotal else 0.0, wins, losses, draws)
        }

        val experienceSegments = TipResultsTracker.stats(context, 3650).optJSONObject("performance_segments") ?: JSONObject()
        fun oddsBand(price: Double): String = when {
            price < 2.0 -> "1.50–1.99"
            price < 3.0 -> "2.00–2.99"
            price < 5.0 -> "3.00–4.99"
            price < 10.0 -> "5.00–9.99"
            else -> "10+"
        }
        fun sportCategory(event: JSONObject): String = when {
            event.optString("sport_key").startsWith("soccer_") || event.optString("sport_title").contains("football", true) || event.optString("sport_title").contains("soccer", true) -> "Football"
            event.optString("sport_key").startsWith("basketball_") || event.optString("sport_title").contains("basket", true) -> "Basketball"
            event.optString("sport_key").startsWith("tennis_") || event.optString("sport_title").contains("tennis", true) -> "Tennis"
            else -> event.optString("sport_title", "Other")
        }

        val ranked = candidates.mapNotNull { event ->
            val homeRows = event.optJSONArray("research_home_recent")
            val awayRows = event.optJSONArray("research_away_recent")
            val homeForm = formStats(homeRows)
            val awayForm = formStats(awayRows)
            val homePlayed = homeForm.played
            val awayPlayed = awayForm.played
            val selection = event.optString("candidate")
            val homeName = event.optString("home_team")
            val awayName = event.optString("away_team")
            val homeRating = HistoricalRatingsEngine.rating(context, sportCategory(event), homeName)
            val awayRating = HistoricalRatingsEngine.rating(context, sportCategory(event), awayName)
            val historicalRatingReady = homeRating != null && awayRating != null &&
                homeRating.matches >= 8 && awayRating.matches >= 8
            val historicalEloHomeProbability = if (historicalRatingReady) {
                1.0 / (1.0 + Math.pow(10.0, (awayRating!!.rating - homeRating!!.rating) / 400.0))
            } else null
            val ratingEdge = when {
                selection.equals(homeName, ignoreCase = true) && historicalRatingReady -> homeRating!!.rating - awayRating!!.rating
                selection.equals(awayName, ignoreCase = true) && historicalRatingReady -> awayRating!!.rating - homeRating!!.rating
                else -> 0.0
            }
            // Elo is a supporting historical prior, not a calibrated standalone betting probability.
            val ratingAdjustment = if (historicalRatingReady) (ratingEdge / 50.0).toInt().coerceIn(-6, 6) else 0
            val edge = when {
                selection.equals(homeName, ignoreCase = true) -> homeForm.weightedWinRate - awayForm.weightedWinRate
                selection.equals(awayName, ignoreCase = true) -> awayForm.weightedWinRate - homeForm.weightedWinRate
                else -> -1.0
            }
            val selectedIsKnownSide = selection.equals(homeName, true) || selection.equals(awayName, true)
            val books = event.optInt("candidate_bookmakers")
            val price = event.optDouble("candidate_price", 0.0)
            val flags = event.optJSONArray("research_availability_flags")?.length() ?: 0
            val segmentKey = "${sportCategory(event)}|${oddsBand(price)}"
            val pastSegment = experienceSegments.optJSONObject(segmentKey)
            val pastSettled = pastSegment?.optInt("settled") ?: 0
            val pastYield = pastSegment?.optDouble("yield_pct", 0.0) ?: 0.0
            // Only let long-run experience influence ranking after at least 30 settled tips in this segment.
            val experienceAdjustment = if (pastSettled >= 30) (pastYield / 5.0).toInt().coerceIn(-8, 8) else 0

            // Sport-neutral win-rate comparison; high-odds selections need more evidence.
            val highRisk = price >= 5.0
            val veryHighRisk = price >= 10.0
            val extremeRisk = price >= 20.0
            val requiredGames = when {
                extremeRisk -> 15
                veryHighRisk -> 12
                highRisk -> 8
                else -> 5
            }
            val requiredBooks = when {
                extremeRisk -> 8
                veryHighRisk -> 6
                highRisk -> 5
                else -> 3
            }
            val strongEdge = when {
                extremeRisk -> 0.35
                veryHighRisk -> 0.28
                highRisk -> 0.20
                else -> 0.12
            }
            val strong = selectedIsKnownSide && books >= maxOf(4, requiredBooks) &&
                homePlayed >= requiredGames && awayPlayed >= requiredGames &&
                edge >= strongEdge && flags == 0
            val moderate = !veryHighRisk && selectedIsKnownSide && books >= requiredBooks &&
                homePlayed >= requiredGames && awayPlayed >= requiredGames &&
                edge >= (if (highRisk) 0.12 else 0.06) && flags <= 1
            if (!strong && !moderate) return@mapNotNull null

            val formDepth = minOf(homePlayed, 10) + minOf(awayPlayed, 10)
            val edgePoints = (edge * 35.0).toInt().coerceIn(0, 25)
            val oddsRiskPenalty = when {
                price >= 50.0 -> 40
                price >= 20.0 -> 32
                price >= 10.0 -> 24
                price >= 8.0 -> 18
                price >= 5.0 -> 12
                price >= 3.0 -> 6
                else -> 0
            }
            val baseEvidenceIndex = (minOf(books, 8) * 6 + formDepth * 2 + edgePoints +
                (if (flags == 0) 8 else 0) - oddsRiskPenalty).coerceIn(0, 100)
            val evidenceIndex = (baseEvidenceIndex + experienceAdjustment + ratingAdjustment).coerceIn(0, 100)
            val reason = buildList {
                add("$books bookmakers return this selection")
                add("recent results available for both teams ($homePlayed home-team records, $awayPlayed away-team records)")
                add("selected side's recency-weighted win-rate edge: %.1f percentage points".format(java.util.Locale.US, edge * 100.0))
                add("recent form: ${homeForm.wins}W-${homeForm.draws}D-${homeForm.losses}L vs ${awayForm.wins}W-${awayForm.draws}D-${awayForm.losses}L")
                if (historicalRatingReady) {
                    add("historical Elo prior: $homeName ${"%.0f".format(java.util.Locale.US, homeRating!!.rating)} (${homeRating!!.matches} matches) vs $awayName ${"%.0f".format(java.util.Locale.US, awayRating!!.rating)} (${awayRating!!.matches} matches)")
                    add("historical Elo supports selected side by ${"%.0f".format(java.util.Locale.US, ratingEdge)} points; used only as a small ranking adjustment, not a calibrated probability")
                } else add("historical Elo unavailable or under 8 matches for one side; no rating adjustment applied")
                if (price >= 5.0) add("high-variance price band; stricter sample and bookmaker requirements applied")
                if (pastSettled >= 30) add("Ash's tracked ${sportCategory(event)} history in this odds band: $pastSettled settled tips, ${"%.1f".format(java.util.Locale.US, pastYield)}% yield")
                else add("Ash has $pastSettled/30 settled ${sportCategory(event)} tips in this odds band; experience adjustment not yet enabled")
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
                .put("best_bookmaker", event.optString("candidate_best_bookmaker"))
                .put("bookmaker_names", event.optString("candidate_bookmaker_names"))
                .put("average_market_price", event.optDouble("candidate_average_price", price))
                .put("raw_implied_probability_pct", if (price > 1.0) 100.0 / price else JSONObject.NULL)
                .put("market_probability_pct", event.optDouble("candidate_market_probability", Double.NaN).takeIf { it.isFinite() }?.times(100.0) ?: JSONObject.NULL)
                .put("probability_method", event.optString("candidate_probability_method", "Not available"))
                .put("bookmakers", books)
                .put("research_results_count", homePlayed + awayPlayed)
                .put("home_recent_count", homePlayed)
                .put("away_recent_count", awayPlayed)
                .put("form_edge_per_game", edge)
                .put("historical_elo_home", homeRating?.rating ?: JSONObject.NULL)
                .put("historical_elo_away", awayRating?.rating ?: JSONObject.NULL)
                .put("historical_elo_home_probability_pct", historicalEloHomeProbability?.times(100.0) ?: JSONObject.NULL)
                .put("historical_elo_home_matches", homeRating?.matches ?: 0)
                .put("historical_elo_away_matches", awayRating?.matches ?: 0)
                .put("historical_elo_rating_adjustment", ratingAdjustment)
                .put("historical_elo_generated_at", homeRating?.generatedAt ?: awayRating?.generatedAt ?: JSONObject.NULL)
                .put("historical_rating_snapshot_updated", historicalRatingRefresh?.updated ?: false)
                .put("home_form", "${homeForm.wins}W-${homeForm.draws}D-${homeForm.losses}L")
                .put("away_form", "${awayForm.wins}W-${awayForm.draws}D-${awayForm.losses}L")
                .put("form_method", "Recency-weighted win rate over up to 10 verified team/player results; draws count as half")
                .put("experience_adjustment", experienceAdjustment)
                .put("experience_sample", pastSettled)
                .put("experience_yield_pct", if (pastSettled >= 30) pastYield else JSONObject.NULL)
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
            .thenByDescending { it.optInt("bookmakers") }).take(6)

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
        // Snapshot each published shortlist selection in the permanent results ledger.
        for (index in 0 until result.length()) {
            val pick = result.optJSONObject(index) ?: continue
            TipResultsTracker.publish(context, pick, "h2h")
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("ash_daily_picks_json", result.toString())
            .putString("ash_daily_picks_date", pickDate)
            .apply()
        return result
    }

    private fun summarize(event: JSONObject, sportKey: String, sportTitle: String, now: String, prior: JSONObject?): JSONObject {
        val prices = mutableMapOf<String, MutableList<Double>>()
        val bookNames = mutableMapOf<String, MutableList<String>>()
        // Remove each bookmaker's overround before averaging market probabilities.
        val fairProbabilities = mutableMapOf<String, MutableList<Double>>()
        val books = event.optJSONArray("bookmakers") ?: JSONArray()
        for (b in 0 until books.length()) {
            val book = books.optJSONObject(b) ?: continue
            val markets = book.optJSONArray("markets") ?: JSONArray()
            for (m in 0 until markets.length()) {
                val market = markets.optJSONObject(m) ?: continue
                if (market.optString("key") != "h2h") continue
                val outcomes = market.optJSONArray("outcomes") ?: JSONArray()
                val valid = (0 until outcomes.length()).mapNotNull { index ->
                    val outcome = outcomes.optJSONObject(index) ?: return@mapNotNull null
                    val name = outcome.optString("name")
                    val price = outcome.optDouble("price", 0.0)
                    if (name.isBlank() || price <= 1.0) null else Triple(name, price, 1.0 / price)
                }
                val overround = valid.sumOf { it.third }
                if (overround <= 0.0) continue
                valid.forEach { (name, price, implied) ->
                    prices.getOrPut(name) { mutableListOf() }.add(price)
                    bookNames.getOrPut(name) { mutableListOf() }.add(book.optString("title", book.optString("key")))
                    fairProbabilities.getOrPut(name) { mutableListOf() }.add(implied / overround)
                }
            }
        }
        var bestName = ""
        var bestAvg = 0.0
        var bestBooks = 0
        for ((name, list) in prices) {
            val avg = list.average()
            if (list.size >= 2 && avg in 1.50..10.00 &&
                (list.size > bestBooks || (list.size == bestBooks && kotlin.math.abs(avg - 2.50) < kotlin.math.abs(bestAvg - 2.50)))) {
                bestName = name; bestAvg = avg; bestBooks = list.size
            }
        }
        val candidateProbability = fairProbabilities[bestName]?.average()?.takeIf { bestName.isNotBlank() }
        val bestPrice = prices[bestName]?.maxOrNull() ?: bestAvg
        val bestPriceIndex = prices[bestName]?.indexOf(bestPrice) ?: -1
        val bestBookmaker = bookNames[bestName]?.getOrNull(bestPriceIndex).orEmpty()
        val rawImpliedProbability = if (bestPrice > 1.0) 1.0 / bestPrice else null
        val snapshots = prior?.optJSONArray("snapshots") ?: JSONArray()
        snapshots.put(JSONObject().put("seen_at", now).put("bookmakers", books.length())
            .put("best_candidate", bestName).put("average_price", if (bestAvg > 0) bestAvg else JSONObject.NULL)
            .put("market_probability_pct", candidateProbability?.times(100.0) ?: JSONObject.NULL))
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
            .put("candidate_price", if (bestPrice > 0) bestPrice else JSONObject.NULL)
            .put("candidate_average_price", if (bestAvg > 0) bestAvg else JSONObject.NULL)
            .put("candidate_best_bookmaker", bestBookmaker)
            .put("candidate_bookmaker_names", bookNames[bestName]?.distinct()?.joinToString(", ") ?: "")
            .put("candidate_bookmakers", bestBooks)
            .put("candidate_market_probability", candidateProbability ?: JSONObject.NULL)
            .put("candidate_raw_implied_probability", rawImpliedProbability ?: JSONObject.NULL)
            .put("candidate_probability_method", "Average bookmaker implied probabilities after removing each bookmaker's overround (h2h market)")
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
        val sportResearchTerms = when {
            sportTitle.contains("tennis", true) ->
                "tennis ranking surface court head-to-head recent matches form fatigue injury withdrawal fitness tournament"
            sportTitle.contains("basket", true) ->
                "basketball injury report probable starters minutes restriction back-to-back rest days pace offensive defensive rating recent form"
            else ->
                "football soccer expected lineup injuries suspensions xG expected goals recent form head-to-head fixture congestion manager team news"
        }
        try { searchNews("\"$homeTeam\" $sportTitle $sportResearchTerms", homeTeam) } catch (_: Exception) { }
        try { searchNews("\"$awayTeam\" $sportTitle $sportResearchTerms", awayTeam) } catch (_: Exception) { }
        try { searchNews("\"$homeTeam\" vs \"$awayTeam\" $sportTitle head-to-head match preview prediction team news", "Match preview") } catch (_: Exception) { }
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
