package com.ashjarvis

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

/**
 * Permanent-on-device ledger for every tip Ash publishes.
 * Odds and the original research snapshot are preserved so later results can be audited.
 */
object TipResultsTracker {
    private const val TYPE = "published_tip"

    fun publish(context: Context, source: JSONObject, market: String = "h2h"): JSONObject {
        val db = LocalSportsDatabase.get(context)
        val eventId = source.optString("id").ifBlank { source.optString("event_id") }
        val selection = source.optString("selection")
        val day = LocalDate.now(ZoneId.systemDefault()).toString()
        val stableId = "$day|$eventId|$market|$selection"
        val existing = db.get(TYPE, stableId)
        if (existing != null) return existing
        val tip = JSONObject(source.toString())
            .put("tip_id", stableId)
            .put("market_type", market)
            .put("published_at", Instant.now().toString())
            .put("published_date", day)
            .put("status", "pending")
            .put("settled_at", JSONObject.NULL)
            .put("profit_units", JSONObject.NULL)
        db.put(TYPE, stableId, tip)
        return tip
    }

    fun all(context: Context): JSONArray = LocalSportsDatabase.get(context).list(TYPE, 10000)

    fun settle(context: Context, tipId: String, status: String, homeScore: Int, awayScore: Int): Boolean {
        require(status in setOf("won", "lost", "void"))
        val db = LocalSportsDatabase.get(context)
        val tip = db.get(TYPE, tipId) ?: return false
        val price = tip.optDouble("price", 0.0)
        val profit = when (status) {
            "won" -> if (price > 1.0) price - 1.0 else 0.0
            "lost" -> -1.0
            else -> 0.0
        }
        tip.put("status", status)
            .put("settled_at", Instant.now().toString())
            .put("profit_units", profit)
        if (homeScore >= 0 && awayScore >= 0) {
            tip.put("home_score", homeScore).put("away_score", awayScore)
        }
        db.put(TYPE, tipId, tip)
        return true
    }

    /**
     * Recheck pending fixtures against refreshed historical records and settle only
     * when the source explicitly labels the match complete and returns numeric scores.
     */
    fun settleFinishedFromHistory(context: Context): Int {
        val now = Instant.now()
        val due = all(context).let { rows ->
            (0 until rows.length()).mapNotNull { rows.optJSONObject(it) }
        }.filter { tip ->
            tip.optString("status") == "pending" &&
                runCatching { Instant.parse(tip.optString("commence_time")).isBefore(now) }.getOrDefault(false)
        }.sortedBy { it.optString("commence_time") }.take(10)
        fun norm(value: String) = value.lowercase().replace(Regex("[^a-z0-9]"), "")
        fun findRow(rows: JSONArray, home: String, away: String): JSONObject? {
            for (i in 0 until rows.length()) {
                val row = rows.optJSONObject(i) ?: continue
                if (norm(row.optString("home_team")) == norm(home) &&
                    norm(row.optString("away_team")) == norm(away)) return row
            }
            return null
        }
        var settled = 0
        for (tip in due) {
            val home = tip.optString("home_team")
            val away = tip.optString("away_team")
            val sport = tip.optString("sport_title")
            val refreshed = runCatching {
                HistoricalDataEngine.collectMatchHistory(context, home, away, sport, forceRefresh = true)
            }.isSuccess
            if (!refreshed) continue
            val homeRow = findRow(HistoricalDataEngine.teamHistory(context, home, sport, 100), home, away) ?: continue
            val awayRow = findRow(HistoricalDataEngine.teamHistory(context, away, sport, 100), home, away)
            val statusText = homeRow.optString("status").lowercase()
            val completed = statusText in setOf("finished", "complete", "completed", "final", "ft", "full time", "ended") ||
                statusText.contains("finished") || statusText.contains("full time") || statusText.contains("completed")
            if (!completed) continue
            val homeScore = homeRow.optString("home_score").toDoubleOrNull() ?: continue
            val awayScore = homeRow.optString("away_score").toDoubleOrNull() ?: continue
            if (awayRow != null) {
                val otherHome = awayRow.optString("home_score").toDoubleOrNull()
                val otherAway = awayRow.optString("away_score").toDoubleOrNull()
                if (otherHome != null && otherAway != null && (otherHome != homeScore || otherAway != awayScore)) continue
            }
            val selection = tip.optString("selection")
            val outcome = if (tip.optString("market_type") == "odd_even") {
                val actual = if ((homeScore + awayScore).toInt() % 2 == 0) "even" else "odd"
                if (selection.lowercase().contains(actual)) "won" else "lost"
            } else when {
                selection.equals(home, true) -> if (homeScore > awayScore) "won" else "lost"
                selection.equals(away, true) -> if (awayScore > homeScore) "won" else "lost"
                selection.equals("draw", true) || selection.equals("tie", true) ->
                    if (homeScore == awayScore) "won" else "lost"
                else -> continue
            }
            if (settle(context, tip.optString("tip_id"), outcome, homeScore.toInt(), awayScore.toInt())) settled++
        }
        return settled
    }

    fun stats(context: Context, days: Int): JSONObject {
        val cutoff = Instant.now().minusSeconds(days.coerceAtLeast(1).toLong() * 86400L)
        var won = 0
        var lost = 0
        var voided = 0
        var pending = 0
        var profit = 0.0
        var brierTotal = 0.0
        var brierCount = 0
        val tips = all(context)
        for (i in 0 until tips.length()) {
            val tip = tips.optJSONObject(i) ?: continue
            val published = runCatching { Instant.parse(tip.optString("published_at")) }.getOrNull() ?: continue
            if (published.isBefore(cutoff)) continue
            when (tip.optString("status")) {
                "won" -> {
                    won++
                    profit += tip.optDouble("profit_units", 0.0)
                    val probability = tip.optDouble("market_probability_pct", Double.NaN) / 100.0
                    if (probability.isFinite() && probability in 0.0..1.0) {
                        brierTotal += (probability - 1.0) * (probability - 1.0)
                        brierCount++
                    }
                }
                "lost" -> {
                    lost++
                    profit += tip.optDouble("profit_units", -1.0)
                    val probability = tip.optDouble("market_probability_pct", Double.NaN) / 100.0
                    if (probability.isFinite() && probability in 0.0..1.0) {
                        brierTotal += probability * probability
                        brierCount++
                    }
                }
                "void" -> voided++
                else -> pending++
            }
        }
        val settled = won + lost
        val staked = settled.toDouble()
        return JSONObject()
            .put("period_days", days)
            .put("won", won)
            .put("lost", lost)
            .put("void", voided)
            .put("pending", pending)
            .put("settled", settled)
            .put("hit_rate_pct", if (settled > 0) won.toDouble() / settled * 100.0 else JSONObject.NULL)
            .put("profit_units", profit)
            .put("yield_pct", if (staked > 0.0) profit / staked * 100.0 else JSONObject.NULL)
            .put("market_brier_score", if (brierCount > 0) brierTotal / brierCount else JSONObject.NULL)
            .put("market_brier_samples", brierCount)
    }
}
