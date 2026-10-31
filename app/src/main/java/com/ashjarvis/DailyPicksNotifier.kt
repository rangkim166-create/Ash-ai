package com.ashjarvis

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import java.time.LocalDate

object DailyPicksNotifier {
    private const val CHANNEL_ID = "ash_odds_of_the_day"

    fun notify(context: Context, picks: JSONArray) {
        val prefs = context.getSharedPreferences("ash_jarvis", Context.MODE_PRIVATE)
        val today = LocalDate.now().toString()
        if (prefs.getString("ash_daily_notification_date", "") == today) return

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Ash Odds of the Day", NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { description = "Approved daily match selections and research status from Ash Sports Intelligence" }
            )
        }
        val lines = (0 until minOf(picks.length(), 3)).mapNotNull { index ->
            val item = picks.optJSONObject(index) ?: return@mapNotNull null
            "${item.optString("away_team")} vs ${item.optString("home_team")} — ${item.optString("selection")} @ ${"%.2f".format(java.util.Locale.US, item.optDouble("price", 0.0))}"
        }
        val body = lines.joinToString("\n").ifBlank { "No selection passed today’s evidence checks. Ash did not force a pick." }
        val intent = Intent(context, SportsOddsActivity::class.java)
        val pending = PendingIntent.getActivity(
            context, 5120, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setContentTitle("Ash • Odds of the Day")
            .setContentText(if (picks.length() > 0) "${picks.length()} approved selections to review" else "No pick passed today’s evidence checks")
            .setStyle(NotificationCompat.BigTextStyle().bigText(body + "\n\nResearch only — outcomes are not guaranteed."))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        try {
            manager.notify(5120, notification)
            prefs.edit().putString("ash_daily_notification_date", today).apply()
        } catch (_: SecurityException) {
            // Android 13+ notification permission may not have been granted.
        }
    }
}
