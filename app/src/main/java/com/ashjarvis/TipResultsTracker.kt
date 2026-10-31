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
            .put("home_score", homeScore)
            .put("away_score", awayScore)
            .put("settled_at", Instant.now().toString())
            .put("profit_units", profit)
        db.put(TYPE, tipId, tip)
        return true
    }

    fun stats(context: Context, days: Int): JSONObject {
        val cutoff = Instant.now().minusSeconds(days.coerceAtLeast(1).toLong() * 86400L)
        var won = 0
        var lost = 0
        var voided = 0
        var pending = 0
        var profit = 0.0
        val tips = all(context)
        for (i in 0 until tips.length()) {
            val tip = tips.optJSONObject(i) ?: continue
            val published = runCatching { Instant.parse(tip.optString("published_at")) }.getOrNull() ?: continue
            if (published.isBefore(cutoff)) continue
            when (tip.optString("status")) {
                "won" -> { won++; profit += tip.optDouble("profit_units", 0.0) }
                "lost" -> { lost++; profit += tip.optDouble("profit_units", -1.0) }
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
    }
}
