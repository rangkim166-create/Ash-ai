package com.ashjarvis

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.text.Normalizer
import java.util.Locale

/**
 * Downloads the published historical Elo snapshot and caches individual ratings
 * in the phone's private SQLite store. Unknown team names are deliberately not
 * fuzzy-matched: a false identity match is worse than missing a rating.
 */
object HistoricalRatingsEngine {
    private const val SOURCE_URL =
        "https://raw.githubusercontent.com/rangkim166-create/Ash-ai/ash-neon-backend/data/history/ratings.json"
    private const val REFRESH_HOURS = 24L
    private const val RECORD_TYPE = "historical_rating"
    private const val META_TYPE = "historical_rating_meta"
    private const val META_KEY = "published_snapshot"

    data class RefreshResult(
        val updated: Boolean,
        val generatedAt: String,
        val matchCounts: JSONObject,
        val participants: JSONObject,
        val note: String
    )

    data class TeamRating(val rating: Double, val matches: Int, val generatedAt: String)

    private fun normalize(value: String): String {
        val ascii = Normalizer.normalize(value.lowercase(Locale.ROOT), Normalizer.Form.NFD)
            .replace(Regex("\\p{M}+"), "")
        val compact = ascii.replace(Regex("[^a-z0-9]"), "")
            .replace(Regex("(afc|fc|cf|bc|sc|sk|fk|club)$"), "")
        return when (compact) {
            "laclippers" -> "losangelesclippers"
            "lalakers" -> "losangeleslakers"
            else -> compact
        }
    }

    private fun sportKey(value: String): String = when {
        value.contains("tennis", true) -> "tennis"
        value.contains("basket", true) || value.contains("nba", true) -> "basketball"
        else -> "football"
    }

    /** Safe to call from WorkManager's IO dispatcher. Cached ratings survive source outages. */
    fun refreshIfStale(context: Context, force: Boolean = false): RefreshResult {
        val db = LocalSportsDatabase.get(context)
        val meta = db.get(META_TYPE, META_KEY)
        val checkedAt = meta?.optString("checked_at").orEmpty()
        val generatedAt = meta?.optString("generated_at").orEmpty()
        val fresh = runCatching {
            checkedAt.isNotBlank() &&
                Instant.parse(checkedAt).isAfter(Instant.now().minusSeconds(REFRESH_HOURS * 3600L))
        }.getOrDefault(false)
        if (!force && fresh) {
            return RefreshResult(
                false, generatedAt,
                meta?.optJSONObject("match_counts") ?: JSONObject(),
                meta?.optJSONObject("participant_counts") ?: JSONObject(),
                "Using cached historical ratings."
            )
        }

        return try {
            val connection = (URL(SOURCE_URL).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 12000
                readTimeout = 30000
                setRequestProperty("Accept", "application/json")
                setRequestProperty("User-Agent", "AshJarvis-Android/1.0")
                setRequestProperty("Cache-Control", "no-cache")
            }
            val root = try {
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                if (code !in 200..299) throw IllegalStateException("Historical ratings HTTP $code: ${body.take(180)}")
                JSONObject(body)
            } finally {
                connection.disconnect()
            }
            require(root.optInt("schema_version") >= 3) { "Historical ratings file is an unsupported schema version." }
            val ratings = root.optJSONObject("ratings") ?: throw IllegalStateException("Ratings section missing.")
            val appearances = root.optJSONObject("appearances") ?: throw IllegalStateException("Sample counts missing.")
            val recentFormRoot = root.optJSONObject("recent_form") ?: JSONObject()
            val matchCounts = root.optJSONObject("match_counts") ?: JSONObject()
            val participantCounts = root.optJSONObject("participant_counts") ?: JSONObject()
            val snapshotTime = root.optString("generated_at_utc").ifBlank { Instant.now().toString() }
            val batch = mutableListOf<Pair<String, JSONObject>>()

            for (sport in listOf("football", "basketball", "tennis")) {
                val sportRatings = ratings.optJSONObject(sport) ?: JSONObject()
                val sportAppearances = appearances.optJSONObject(sport) ?: JSONObject()
                val iterator = sportRatings.keys()
                while (iterator.hasNext()) {
                    val name = iterator.next()
                    val value = sportRatings.optDouble(name, Double.NaN)
                    val played = sportAppearances.optInt(name, 0)
                    if (name.isBlank() || !value.isFinite() || played <= 0) continue
                    val recentRows = recentFormRoot.optJSONObject(sport)?.optJSONArray(name) ?: org.json.JSONArray()
                    val record = JSONObject()
                        .put("sport", sport)
                        .put("team", name)
                        .put("elo", value)
                        .put("matches", played)
                        .put("recent_form", recentRows)
                        .put("generated_at", snapshotTime)
                        .put("source", "Ash historical results Elo snapshot")
                    batch.add("$sport:${normalize(name)}" to record)
                }
            }
            require(batch.isNotEmpty()) { "Published ratings snapshot contains no usable participants." }
            db.clear(RECORD_TYPE)
            db.putBatch(RECORD_TYPE, batch)
            val checked = Instant.now().toString()
            val newMeta = JSONObject()
                .put("checked_at", checked)
                .put("generated_at", snapshotTime)
                .put("schema_version", root.optInt("schema_version"))
                .put("match_counts", matchCounts)
                .put("participant_counts", participantCounts)
                .put("participant_records_cached", batch.size)
                .put("source_url", SOURCE_URL)
            db.put(META_TYPE, META_KEY, newMeta)
            RefreshResult(true, snapshotTime, matchCounts, participantCounts,
                "Updated ${batch.size} participant ratings from the published historical results.")
        } catch (error: Exception) {
            RefreshResult(
                false, generatedAt,
                meta?.optJSONObject("match_counts") ?: JSONObject(),
                meta?.optJSONObject("participant_counts") ?: JSONObject(),
                "Could not refresh historical ratings; retained cached data. ${error.message ?: "source unavailable"}"
            )
        }
    }

    fun rating(context: Context, sport: String, participant: String): TeamRating? {
        if (participant.isBlank()) return null
        val key = "${sportKey(sport)}:${normalize(participant)}"
        val row = LocalSportsDatabase.get(context).get(RECORD_TYPE, key) ?: return null
        val elo = row.optDouble("elo", Double.NaN)
        val matches = row.optInt("matches", 0)
        if (!elo.isFinite() || matches <= 0) return null
        return TeamRating(elo, matches, row.optString("generated_at"))
    }

    /** Recent verified match results from the same published archive, newest first. */
    fun recentForm(context: Context, sport: String, participant: String): org.json.JSONArray {
        if (participant.isBlank()) return org.json.JSONArray()
        val key = "${sportKey(sport)}:${normalize(participant)}"
        return LocalSportsDatabase.get(context).get(RECORD_TYPE, key)
            ?.optJSONArray("recent_form") ?: org.json.JSONArray()
    }

    fun snapshotInfo(context: Context): JSONObject? =
        LocalSportsDatabase.get(context).get(META_TYPE, META_KEY)
}
