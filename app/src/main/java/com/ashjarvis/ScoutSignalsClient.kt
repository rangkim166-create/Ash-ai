package com.ashjarvis

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

object ScoutSignalsClient {
    private const val ENDPOINT = "https://ash-sports-api.onrender.com/v1/public/scout/signals"
    private const val PREFS = "ash_jarvis"
    private const val DEVICE_KEY = "ash_scout_device_id"

    private fun deviceId(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val existing = prefs.getString(DEVICE_KEY, null)
        if (!existing.isNullOrBlank()) return existing
        val created = UUID.randomUUID().toString()
        prefs.edit().putString(DEVICE_KEY, created).apply()
        return created
    }

    private fun request(context: Context, method: String, payload: JSONObject? = null): JSONObject {
        val connection = (URL(ENDPOINT).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 12000
            readTimeout = 20000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("X-Ash-Device-Id", deviceId(context))
            if (payload != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }
        try {
            if (payload != null) {
                connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val parsed = runCatching { JSONObject(body) }.getOrElse { JSONObject() }
            if (code !in 200..299) {
                throw IllegalStateException(parsed.optString("error").ifBlank { "Scout request failed (HTTP $code)" })
            }
            return parsed
        } finally {
            connection.disconnect()
        }
    }

    fun listSignals(context: Context): JSONArray =
        request(context, "GET").optJSONArray("signals") ?: JSONArray()

    fun submitSignal(context: Context, sport: String, team: String, opinion: String, reason: String): JSONObject =
        request(context, "POST", JSONObject()
            .put("sport", sport)
            .put("team", team.trim())
            .put("opinion", opinion)
            .put("reason", reason.trim().take(1000)))
}
