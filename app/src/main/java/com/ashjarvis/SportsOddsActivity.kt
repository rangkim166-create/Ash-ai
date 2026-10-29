package com.ashjarvis

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.text.InputType
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

class SportsOddsActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var root: LinearLayout
    private lateinit var body: LinearLayout
    private lateinit var status: TextView
    private var currentTab = "today"
    private val bg = Color.rgb(8, 13, 27)
    private val panel = Color.rgb(20, 30, 52)
    private val accent = Color.rgb(96, 210, 255)
    private val muted = Color.rgb(158, 177, 207)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = bg
        window.navigationBarColor = bg
        scheduleDailyRefresh()
        render()
    }

    private fun scheduleDailyRefresh() {
        val request = PeriodicWorkRequestBuilder<OddsRefreshWorker>(24, TimeUnit.HOURS).build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "ash_daily_odds_refresh", ExistingPeriodicWorkPolicy.KEEP, request
        )
    }

    private fun render() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(16, 14, 16, 12)
            setBackgroundColor(bg)
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(18, 18, 18, 18)
            background = rounded(panel, 26, Color.rgb(45, 79, 121))
        }
        val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        top.addView(text("ASH SPORTS INTELLIGENCE", 19f, accent, true), LinearLayout.LayoutParams(0, -2, 1f))
        top.addView(button("BACK") { finish() })
        header.addView(top)
        header.addView(text("TODAY'S SLATE  •  LIVE BOOKMAKER PRICES", 11f, muted).apply { setPadding(0, 8, 0, 0) })
        root.addView(header)
        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; setPadding(0, 12, 0, 8) }
        controls.addView(button("TODAY") { currentTab = "today"; render() }, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(button("HISTORY") { currentTab = "history"; render() }, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(button("SETUP") { showSetup() }, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(controls)
        val scroll = ScrollView(this)
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 4, 0, 8) }
        scroll.addView(body)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        status = text("", 11f, muted).apply { setPadding(3, 8, 3, 0) }
        root.addView(status)
        setContentView(root)
        if (currentTab == "history") showHistory() else showToday()
    }

    private fun showToday() {
        val key = OddsEngine.readApiKey(this)
        if (key.isNullOrBlank()) {
            card("CONNECT YOUR ODDS FEED", "Paste your own The Odds API key. Ash encrypts it on this phone and checks the selected leagues daily.") {
                button("ADD API KEY") { showSetup() }
            }
            status.text = "Not connected • no API key saved"
            return
        }
        val history = OddsEngine.history(this)
        val upcoming = (0 until history.length()).mapNotNull { history.optJSONObject(it) }
            .filter { it.optString("commence_time").isNotBlank() && it.optString("commence_time") >= java.time.Instant.now().toString() }
            .sortedBy { it.optString("commence_time") }
        val candidates = upcoming.filter { it.optString("candidate").isNotBlank() && it.optInt("candidate_bookmakers") >= 2 }
        card("DAILY SHORTLIST", "Candidates are filtered from available bookmaker prices. This is not a guarantee or a promise of profit.") {}
        if (candidates.isEmpty()) body.addView(text("No shortlisted games saved yet. Tap REFRESH to collect the latest odds.", 14f, muted).apply { setPadding(12, 14, 12, 14) })
        candidates.take(20).forEach { event ->
            card("${event.optString("away_team")}  vs  ${event.optString("home_team")}",
                "${event.optString("sport_title")}\nKick-off: ${event.optString("commence_time")}\nMarket candidate: ${event.optString("candidate")} @ ${event.optString("candidate_price")}\nBookmakers checked: ${event.optInt("candidate_bookmakers")}\nTap to check if odd/even odds are published. Shortlist only, not a prediction guarantee.") { checkOddEven(event) }
        }
        card("ALL UPCOMING GAMES", "Saved games found through your API key: ${upcoming.size}") {}
        upcoming.filter { candidates.none { c -> c.optString("id") == it.optString("id") } }.take(30).forEach { event ->
            card("${event.optString("away_team")}  vs  ${event.optString("home_team")}",
                "${event.optString("sport_title")} • ${event.optString("commence_time")}\nBookmakers: ${event.optInt("bookmaker_count")} • First seen: ${event.optString("first_seen")}") {}
        }
        val last = getSharedPreferences("ash_jarvis", MODE_PRIVATE).getString("odds_last_sync", "not yet")
        status.text = "Last sync: $last • Stored history: ${history.length()} games"
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        actions.addView(button("REFRESH NOW") { refreshNow() }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(button("CHOOSE LEAGUES") { showLeagues() }, LinearLayout.LayoutParams(0, -2, 1f))
        body.addView(actions, 0)
    }

    private fun showHistory() {
        val history = OddsEngine.history(this)
        card("MATCH HISTORY", "${history.length()} unique games collected. Each game stores when Ash first found it and recent odds snapshots.") {}
        val rows = (0 until history.length()).mapNotNull { history.optJSONObject(it) }
            .sortedByDescending { it.optString("first_seen") }
        if (rows.isEmpty()) body.addView(text("No games collected yet. Connect your key, choose leagues, then refresh.", 14f, muted).apply { setPadding(12, 12, 12, 12) })
        rows.take(100).forEach { event ->
            val snapshots = event.optJSONArray("snapshots") ?: JSONArray()
            card("${event.optString("away_team")}  vs  ${event.optString("home_team")}",
                "${event.optString("sport_title")}\nKick-off: ${event.optString("commence_time")}\nFirst discovered: ${event.optString("first_seen")}\nLast checked: ${event.optString("last_seen")}\nOdds snapshots stored: ${snapshots.length()}") {}
        }
        status.text = "History is stored locally on this device • ${history.length()} games"
        body.addView(button("CLEAR MATCH HISTORY") {
            AlertDialog.Builder(this).setTitle("Clear collected history?")
                .setMessage("This only deletes the local match/odds history on this phone.")
                .setNegativeButton("CANCEL", null)
                .setPositiveButton("CLEAR") { _, _ ->
                    getSharedPreferences("ash_jarvis", MODE_PRIVATE).edit().remove("ash_odds_history_json").apply()
                    render()
                }.show()
        })
    }

    private fun showSetup() {
        val saved = OddsEngine.readApiKey(this).orEmpty()
        val field = EditText(this).apply {
            hint = "Paste The Odds API key"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setSingleLine(true)
            setText(saved)
        }
        AlertDialog.Builder(this).setTitle("Connect The Odds API")
            .setMessage("Your key is encrypted with Android Keystore and stored on this phone. It is not written into the APK or sent to Ash's server.")
            .setView(field)
            .setNegativeButton("CANCEL", null)
            .setNeutralButton("REMOVE KEY") { _, _ ->
                OddsEngine.clearApiKey(this)
                Toast.makeText(this, "Odds API key removed", Toast.LENGTH_SHORT).show()
                render()
            }
            .setPositiveButton("SAVE & TEST") { _, _ ->
                val key = field.text.toString().trim()
                if (key.length < 8) {
                    Toast.makeText(this, "Enter a valid API key", Toast.LENGTH_LONG).show()
                } else {
                    OddsEngine.saveApiKey(this, key)
                    testConnection(key)
                }
            }.show()
    }

    private fun testConnection(key: String) {
        status.text = "Testing odds API key…"
        scope.launch {
            try {
                val sports = withContext(Dispatchers.IO) { OddsEngine.loadSports(key) }
                if (sports.length() == 0) throw IllegalStateException("API key connected, but no sports are currently available for this plan.")
                val active = (0 until sports.length()).mapNotNull { sports.optJSONObject(it) }
                    .filter { it.optBoolean("active", true) && it.optString("key").isNotBlank() }
                val defaults = OddsEngine.favoriteKeys(this@SportsOddsActivity)
                val availableKeys = active.map { it.optString("key") }.toSet()
                if (defaults.none { it in availableKeys }) {
                    val preferred = active.filter { s ->
                        val k = s.optString("key")
                        k == "soccer_epl" || k == "basketball_nba"
                    }.map { it.optString("key") }.toSet()
                    OddsEngine.saveFavorites(this@SportsOddsActivity, preferred)
                }
                Toast.makeText(this@SportsOddsActivity, "Connected • ${active.size} sports/competitions available", Toast.LENGTH_LONG).show()
                scheduleDailyRefresh()
                currentTab = "today"
                render()
            } catch (e: Exception) {
                status.text = "Connection failed"
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Could not connect")
                    .setMessage((e.message ?: "API request failed").take(800))
                    .setPositiveButton("EDIT KEY") { _, _ -> showSetup() }
                    .setNegativeButton("OK", null).show()
            }
        }
    }

    private fun showLeagues() {
        val key = OddsEngine.readApiKey(this)
        if (key.isNullOrBlank()) { showSetup(); return }
        status.text = "Loading leagues available on your API plan…"
        scope.launch {
            try {
                val sports = withContext(Dispatchers.IO) { OddsEngine.loadSports(key) }
                val options = (0 until sports.length()).mapNotNull { sports.optJSONObject(it) }
                    .filter { it.optBoolean("active", true) && it.optString("key").isNotBlank() }
                    .sortedWith(compareBy<JSONObject>({ it.optString("group") }, { it.optString("title") }))
                val labels = options.map { "${it.optString("group", "Sport")} • ${it.optString("title", it.optString("key"))}" }.toTypedArray()
                val selected = OddsEngine.favoriteKeys(this@SportsOddsActivity)
                val checks = BooleanArray(options.size) { selected.contains(options[it].optString("key")) }
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Choose daily leagues")
                    .setMultiChoiceItems(labels, checks) { _, which, isChecked -> checks[which] = isChecked }
                    .setNegativeButton("CANCEL", null)
                    .setPositiveButton("SAVE LEAGUES") { _, _ ->
                        val chosen = options.indices.filter { checks[it] }.map { options[it].optString("key") }.toSet()
                        if (chosen.isEmpty()) Toast.makeText(this@SportsOddsActivity, "Choose at least one league", Toast.LENGTH_LONG).show()
                        else {
                            OddsEngine.saveFavorites(this@SportsOddsActivity, chosen)
                            Toast.makeText(this@SportsOddsActivity, "Daily leagues saved", Toast.LENGTH_SHORT).show()
                            refreshNow()
                        }
                    }.show()
                status.text = "Select leagues to check each day"
            } catch (e: Exception) {
                status.text = "Could not load leagues"
                Toast.makeText(this@SportsOddsActivity, (e.message ?: "Request failed").take(300), Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun checkOddEven(event: JSONObject) {
        val key = OddsEngine.readApiKey(this)
        if (key.isNullOrBlank()) { showSetup(); return }
        status.text = "Checking bookmaker odd/even market…"
        scope.launch {
            try {
                val payload = withContext(Dispatchers.IO) {
                    OddsEngine.checkOddEven(key, event.optString("sport_key"), event.optString("id"))
                }
                val books = payload.optJSONArray("bookmakers")
                    ?: payload.optJSONObject("data")?.optJSONArray("bookmakers")
                    ?: JSONArray()
                val lines = mutableListOf<String>()
                for (i in 0 until books.length()) {
                    val book = books.optJSONObject(i) ?: continue
                    val markets = book.optJSONArray("markets") ?: continue
                    for (j in 0 until markets.length()) {
                        val market = markets.optJSONObject(j) ?: continue
                        if (market.optString("key") !in setOf("odd_even", "odd_even_goals", "total_goals_odd_even")) continue
                        val outcomes = market.optJSONArray("outcomes") ?: continue
                        val prices = (0 until outcomes.length()).mapNotNull { idx ->
                            outcomes.optJSONObject(idx)?.let { "${it.optString("name")} @ ${it.optDouble("price", 0.0)}" }
                        }
                        if (prices.isNotEmpty()) lines.add("${book.optString("title", book.optString("key"))}: ${prices.joinToString(", ")}")
                    }
                }
                val message = if (lines.isEmpty()) {
                    "No bookmaker returned an odd/even market for this event. This feed may not publish odd/even; Ash will not guess or convert over/under odds into fake prices."
                } else lines.joinToString("\n")
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Odd/even market check")
                    .setMessage(message).setPositiveButton("OK", null).show()
                status.text = if (lines.isEmpty()) "Odd/even odds unavailable for this game" else "Odd/even odds found"
            } catch (e: Exception) {
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Odd/even unavailable")
                    .setMessage((e.message ?: "Provider does not publish this market").take(700))
                    .setPositiveButton("OK", null).show()
                status.text = "Odd/even odds unavailable for this game"
            }
        }
    }

    private fun refreshNow() {
        val key = OddsEngine.readApiKey(this)
        if (key.isNullOrBlank()) { showSetup(); return }
        status.text = "Fetching today's bookmaker odds…"
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) { OddsEngine.sync(this@SportsOddsActivity, key) }
                val summary = "Games received: ${result.gamesFound}\nNew games discovered: ${result.newGames}\nLeagues checked: ${result.sportsChecked}\nAPI credits remaining: ${result.remaining ?: "not reported"}" +
                    if (result.errors.isNotEmpty()) "\n\nSome leagues could not be checked:\n" + result.errors.take(4).joinToString("\n") else ""
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Daily odds refresh complete")
                    .setMessage(summary).setPositiveButton("VIEW GAMES") { _, _ -> currentTab = "today"; render() }.show()
                status.text = "Updated • ${result.newGames} new games discovered"
            } catch (e: Exception) {
                status.text = "Refresh failed"
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Couldn't refresh odds")
                    .setMessage((e.message ?: "API request failed").take(900))
                    .setPositiveButton("SETTINGS") { _, _ -> showSetup() }
                    .setNegativeButton("OK", null).show()
            }
        }
    }

    private fun card(title: String, description: String, extra: () -> Unit) {
        val item = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(15, 14, 15, 14)
            background = rounded(panel, 20, Color.rgb(39, 57, 87))
        }
        item.addView(text(title, 15f, Color.WHITE, true))
        item.addView(text(description, 12f, muted).apply { setPadding(0, 8, 0, 0) })
        item.setOnClickListener { extra() }
        body.addView(item, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 10 })
    }

    private fun text(value: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(null, Typeface.BOLD)
        setPadding(2, 2, 2, 2)
    }

    private fun button(label: String, action: () -> Unit): Button = Button(this).apply {
        text = label
        textSize = 11f
        isAllCaps = false
        setTextColor(Color.WHITE)
        background = rounded(Color.rgb(31, 54, 83), 14, Color.rgb(57, 101, 150))
        setOnClickListener { action() }
    }

    private fun rounded(color: Int, radiusDp: Int, stroke: Int) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = radiusDp * resources.displayMetrics.density
        setStroke((resources.displayMetrics.density).toInt().coerceAtLeast(1), stroke)
    }
}
