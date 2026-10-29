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
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 991)
        }
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
        card("DAILY SHORTLIST", "Ash scans active sports exposed by your API key, then ranks a small daily research shortlist. Each sport requires a separate odds request, so your API quota/plan limits coverage. Target odds are combined prices, not win probabilities or guarantees.") {}
        val dailyPicks = OddsEngine.savedDailyPicks(this)
        val picksText = if (dailyPicks.length() == 0) {
            "No daily shortlist saved yet. Tap REFRESH NOW to scan available sports and research leading candidates."
        } else {
            (0 until dailyPicks.length()).mapNotNull { i ->
                val pick = dailyPicks.optJSONObject(i) ?: return@mapNotNull null
                "${i + 1}. ${pick.optString("away_team")} vs ${pick.optString("home_team")}\n   Pick: ${pick.optString("selection")} @ ${"%.2f".format(java.util.Locale.US, pick.optDouble("price", 0.0))}\n   Bookmakers: ${pick.optInt("bookmakers")} • Recent results found: ${pick.optInt("research_results_count")} • ${pick.optString("confidence")}"
            }.joinToString("\n\n") + "\n\nThese are research candidates, not guaranteed winners. Use only money you can afford to lose."
        }
        card("ASH DAILY MATCHES TO WATCH", picksText) {
            AlertDialog.Builder(this).setTitle("Daily researched shortlist")
                .setMessage(picksText)
                .setPositiveButton("OK", null).show()
        }
        showAccumulatorTargets(candidates)
        card("ODD / EVEN • TARGET 1.50", "Choose a match and check whether your provider actually returns an odd/even market near 1.50. Ash never invents these prices.") {
            chooseOddEvenGame(upcoming)
        }
        if (candidates.isEmpty()) body.addView(text("No qualifying games saved yet. Tap REFRESH to collect current bookmaker odds.", 14f, muted).apply { setPadding(12, 14, 12, 14) })
        candidates.take(20).forEach { event ->
            card("${event.optString("away_team")}  vs  ${event.optString("home_team")}",
                "${event.optString("sport_title")}\nKick-off: ${event.optString("commence_time")}\nMarket candidate: ${event.optString("candidate")} @ ${event.optString("candidate_price")}\nBookmakers checked: ${event.optInt("candidate_bookmakers")}\nTap to research recent results online if local result history is missing.") { researchMatch(event) }
        }
        card("ALL UPCOMING GAMES", "Saved games found through your API key: ${upcoming.size}") {}
        upcoming.filter { candidates.none { c -> c.optString("id") == it.optString("id") } }.take(30).forEach { event ->
            card("${event.optString("away_team")}  vs  ${event.optString("home_team")}",
                "${event.optString("sport_title")} • ${event.optString("commence_time")}\nBookmakers: ${event.optInt("bookmaker_count")} • First seen: ${event.optString("first_seen")}\nTap to research online") { researchMatch(event) }
        }
        val last = getSharedPreferences("ash_jarvis", MODE_PRIVATE).getString("odds_last_sync", "not yet")
        status.text = "Last sync: $last • Stored history: ${history.length()} games"
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        actions.addView(button("REFRESH NOW") { refreshNow() }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(button("VIEW SPORTS API LIST") { showLeagues() }, LinearLayout.LayoutParams(0, -2, 1f))
        body.addView(actions, 0)
    }

    private fun showAccumulatorTargets(candidates: List<JSONObject>) {
        val targets = listOf(2.0, 4.0, 5.0, 6.0, 10.0, 100.0)
        val row = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        targets.forEach { target ->
            val picks = mutableListOf<JSONObject>()
            var combined = 1.0
            candidates.filter {
                val price = it.optDouble("candidate_price", 0.0)
                price >= 1.20 && price <= 2.50 && it.optString("candidate").isNotBlank()
            }.sortedBy { it.optDouble("candidate_price", 99.0) }.forEach { event ->
                if (combined < target && picks.none { it.optString("id") == event.optString("id") }) {
                    picks.add(event)
                    combined *= event.optDouble("candidate_price", 1.0)
                }
            }
            val ready = combined >= target && picks.isNotEmpty()
            val title = "TARGET ${target.toInt()} ODDS" + if (ready) "  •  ${picks.size} PICKS" else "  •  NOT ENOUGH GAMES"
            val details = if (ready) {
                "Approx. combined decimal odds: %.2f".format(java.util.Locale.US, combined) +
                    "\n" + picks.joinToString("\n") { "• ${it.optString("away_team")} vs ${it.optString("home_team")} — ${it.optString("candidate")} @ ${it.optDouble("candidate_price", 0.0)}" } +
                    "\nResearch shortlist only. Prices can change; no outcome is guaranteed."
            } else {
                "Ash has not found enough distinct upcoming games with usable prices to reach this target. Refresh later or select more leagues. No games are added just to force the target."
            }
            card(title, details) {
                if (!ready) {
                    Toast.makeText(this, "Not enough qualifying games for target ${target.toInt()}", Toast.LENGTH_LONG).show()
                } else {
                    AlertDialog.Builder(this).setTitle("Daily ${target.toInt()}-odds shortlist")
                        .setMessage(details)
                        .setPositiveButton("OK", null).show()
                }
            }
            row.addView(View(this).apply { setBackgroundColor(Color.rgb(36, 49, 73)) },
                LinearLayout.LayoutParams(-1, (resources.displayMetrics.density).toInt().coerceAtLeast(1)).apply {
                    topMargin = 2; bottomMargin = 8
                })
        }
    }

    private fun chooseOddEvenGame(events: List<JSONObject>) {
        if (events.isEmpty()) {
            AlertDialog.Builder(this).setTitle("No upcoming games")
                .setMessage("Refresh your selected leagues first. Ash can only check matches returned by your odds provider.")
                .setPositiveButton("REFRESH") { _, _ -> refreshNow() }
                .setNegativeButton("CLOSE", null).show()
            return
        }
        val labels = events.take(80).map { event ->
            "${event.optString("away_team")} vs ${event.optString("home_team")} • ${event.optString("sport_title")}"
        }.toTypedArray()
        AlertDialog.Builder(this).setTitle("Choose match • odd/even near 1.50")
            .setItems(labels) { _, which -> checkOddEvenAtTarget(events.take(80)[which]) }
            .setNegativeButton("CANCEL", null).show()
    }

    private fun checkOddEvenAtTarget(event: JSONObject) {
        val key = OddsEngine.readApiKey(this)
        if (key.isNullOrBlank()) { showSetup(); return }
        status.text = "Checking real odd/even market prices…"
        scope.launch {
            try {
                val payload = withContext(Dispatchers.IO) {
                    OddsEngine.checkOddEven(key, event.optString("sport_key"), event.optString("id"))
                }
                val firstEvent = payload.optJSONArray("data")?.optJSONObject(0)
                val books = payload.optJSONArray("bookmakers")
                    ?: firstEvent?.optJSONArray("bookmakers")
                    ?: payload.optJSONObject("data")?.optJSONArray("bookmakers")
                    ?: JSONArray()
                val found = mutableListOf<String>()
                for (i in 0 until books.length()) {
                    val book = books.optJSONObject(i) ?: continue
                    val markets = book.optJSONArray("markets") ?: JSONArray()
                    for (j in 0 until markets.length()) {
                        val market = markets.optJSONObject(j) ?: continue
                        if (market.optString("key") !in setOf("odd_even", "odd_even_goals", "total_goals_odd_even")) continue
                        val outcomes = market.optJSONArray("outcomes") ?: JSONArray()
                        for (k in 0 until outcomes.length()) {
                            val outcome = outcomes.optJSONObject(k) ?: continue
                            val price = outcome.optDouble("price", 0.0)
                            if (price in 1.35..1.65) {
                                found.add("${book.optString("title", book.optString("key"))}: ${outcome.optString("name")} @ ${"%.2f".format(java.util.Locale.US, price)}")
                            }
                        }
                    }
                }
                val message = if (found.isEmpty()) {
                    "No actual odd/even price near 1.50 was returned for this match. The selected API feed may not support this market. Try another match or a provider that offers odd/even odds."
                } else found.distinct().joinToString("\n") + "\n\nPrices shown are returned by the provider and may change before kickoff."
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Odd/even • target 1.50")
                    .setMessage("${event.optString("away_team")} vs ${event.optString("home_team")}\n\n$message")
                    .setPositiveButton("OK", null).show()
                status.text = if (found.isEmpty()) "No odd/even prices near 1.50 returned" else "${found.size} odd/even prices found"
            } catch (e: Exception) {
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Odd/even market unavailable")
                    .setMessage((e.message ?: "The provider did not return this market").take(700))
                    .setPositiveButton("OK", null).show()
                status.text = "Odd/even market unavailable for this match"
            }
        }
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
                "${event.optString("sport_title")}\nKick-off: ${event.optString("commence_time")}\nFirst discovered: ${event.optString("first_seen")}\nLast checked: ${event.optString("last_seen")}\nOdds snapshots stored: ${snapshots.length()}\nTap to research match history online") { researchMatch(event) }
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
                refreshNow()
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
        status.text = "Loading active sports from your API…"
        scope.launch {
            try {
                val sports = withContext(Dispatchers.IO) { OddsEngine.loadSports(key) }
                val options = (0 until sports.length()).mapNotNull { sports.optJSONObject(it) }
                    .filter { it.optBoolean("active", true) && it.optString("key").isNotBlank() }
                    .sortedWith(compareBy<JSONObject>({ it.optString("group") }, { it.optString("title") }))
                val labels = options.map { "${it.optString("group", "Sport")} • ${it.optString("title", it.optString("key"))}" }.toTypedArray()
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Active sports exposed by your API key")
                    .setMessage("Ash's daily scan checks all active sports returned by this key. The Odds API needs a separate odds request for each sport, so a broad scan can use more API credits. Actual fixtures and bookmaker markets depend on your provider plan.")
                    .setItems(labels) { _, which ->
                        val chosen = options[which]
                        AlertDialog.Builder(this@SportsOddsActivity)
                            .setTitle(chosen.optString("title", chosen.optString("key")))
                            .setMessage("API key: ${chosen.optString("key")}\nGroup: ${chosen.optString("group")}\nActive: ${chosen.optBoolean("active", true)}\n\nThis competition is included in the all-active-sports scan.")
                            .setPositiveButton("OK", null).show()
                    }
                    .setPositiveButton("CLOSE", null).show()
                status.text = "All active sports listed • ${options.size} available"
            } catch (e: Exception) {
                status.text = "Could not load sports list"
                Toast.makeText(this@SportsOddsActivity, (e.message ?: "Request failed").take(300), Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun researchMatch(event: JSONObject) {
        status.text = "Local result history may be missing • researching the internet…"
        scope.launch {
            try {
                val report = withContext(Dispatchers.IO) {
                    OddsEngine.researchMatch(
                        event.optString("home_team"),
                        event.optString("away_team"),
                        event.optString("sport_title")
                    )
                }
                fun formatRecent(label: String, rows: JSONArray): String {
                    if (rows.length() == 0) return "${label} recent results: no verified results found online"
                    val lines = (0 until minOf(rows.length(), 5)).mapNotNull { i ->
                        val row = rows.optJSONObject(i) ?: return@mapNotNull null
                        val score = "${row.optString("home_score")}–${row.optString("away_score")}"
                        val scoreText = if (score.contains("null") || score == "–") "score unavailable" else score
                        "• ${row.optString("date")}  ${row.optString("event")} — ${scoreText} (${row.optString("outcome")})"
                    }
                    return "${label} recent results:\n" + lines.joinToString("\n")
                }
                val homeRecent = report.optJSONArray("home_recent") ?: JSONArray()
                val awayRecent = report.optJSONArray("away_recent") ?: JSONArray()
                val notes = report.optJSONArray("web_notes") ?: JSONArray()
                val sources = report.optJSONArray("sources") ?: JSONArray()
                val noteLines = (0 until minOf(notes.length(), 6)).mapNotNull { i ->
                    val item = notes.optJSONObject(i) ?: return@mapNotNull null
                    "• ${item.optString("title")}: ${item.optString("snippet")}"
                }
                val message = buildString {
                    append("Internet research completed: ").append(report.optString("researched_at")).append("\n\n")
                    append(formatRecent(event.optString("home_team"), homeRecent)).append("\n\n")
                    append(formatRecent(event.optString("away_team"), awayRecent)).append("\n\n")
                    append("WEB CONTEXT\n")
                    append(if (noteLines.isEmpty()) "No useful web snippets were returned." else noteLines.joinToString("\n"))
                    append("\n\nSOURCES\n")
                    append(if (sources.length() == 0) "Sources did not return data this time." else
                        (0 until sources.length()).mapNotNull { sources.optString(it).takeIf { s -> s.isNotBlank() } }.distinct().joinToString(", "))
                    append("\n\n")
                    if (homeRecent.length() == 0 && awayRecent.length() == 0) {
                        append("No verified recent results were found. This match is NOT invalid; Ash must mark the evidence as insufficient and avoid pretending the history exists.")
                    } else {
                        append("Research evidence only. Verify team identity and match details; this is not a guaranteed prediction.")
                    }
                }
                AlertDialog.Builder(this@SportsOddsActivity)
                    .setTitle("Ash internet match research")
                    .setMessage(message)
                    .setPositiveButton("OK", null)
                    .show()
                status.text = if (homeRecent.length() + awayRecent.length() > 0)
                    "Internet research complete • recent results found"
                else "Internet searched • no verified recent results found"
            } catch (e: Exception) {
                status.text = "Internet research temporarily unavailable"
                AlertDialog.Builder(this@SportsOddsActivity)
                    .setTitle("Research unavailable")
                    .setMessage("Ash could not reach a research source right now. The match is not invalid; try again when internet is available.\n\n${(e.message ?: "Network request failed").take(300)}")
                    .setPositiveButton("OK", null)
                    .show()
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
                val firstEvent = payload.optJSONArray("data")?.optJSONObject(0)
                val books = payload.optJSONArray("bookmakers")
                    ?: firstEvent?.optJSONArray("bookmakers")
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
                val pair = withContext(Dispatchers.IO) {
                    val result = OddsEngine.sync(this@SportsOddsActivity, key)
                    val picks = OddsEngine.buildDailyPicks(this@SportsOddsActivity)
                    result to picks
                }
                val result = pair.first
                val picks = pair.second
                DailyPicksNotifier.notify(this@SportsOddsActivity, picks)
                val pickSummary = if (picks.length() == 0) "\nNo evidence-ranked picks available today; Ash did not force a selection."
                    else "\nDaily shortlist:\n" + (0 until picks.length()).mapNotNull { i ->
                        val p = picks.optJSONObject(i) ?: return@mapNotNull null
                        "• ${p.optString("away_team")} vs ${p.optString("home_team")} — ${p.optString("selection")} @ ${"%.2f".format(java.util.Locale.US, p.optDouble("price", 0.0))} (${p.optString("confidence")})"
                    }.joinToString("\n")
                val summary = "Games received: ${result.gamesFound}\nNew games discovered: ${result.newGames}\nActive sports scanned: ${result.sportsChecked}\nAPI credits remaining: ${result.remaining ?: "not reported"}" + pickSummary +
                    if (result.errors.isNotEmpty()) "\n\nSome sports could not be checked:\n" + result.errors.take(4).joinToString("\n") else ""
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Daily odds refresh complete")
                    .setMessage(summary).setPositiveButton("VIEW GAMES") { _, _ -> currentTab = "today"; render() }.show()
                status.text = "Updated • ${result.newGames} new games • ${picks.length()} shortlist picks"
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
