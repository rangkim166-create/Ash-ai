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
    private var pendingArchiveSport = "football"
    private val archiveImportRequestCode = 9926
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
        header.addView(text("TODAY'S SLATE  •  ODDS + TEAM INTELLIGENCE", 11f, muted).apply { setPadding(0, 8, 0, 0) })
        root.addView(header)
        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; setPadding(0, 12, 0, 8) }
        controls.addView(button("TODAY") { currentTab = "today"; render() }, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(button("PARKED") { currentTab = "parked"; render() }, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(button("HISTORY") { currentTab = "history"; render() }, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(button("RESULTS") { currentTab = "results"; render() }, LinearLayout.LayoutParams(0, -2, 1f))
        controls.addView(button("SETUP") { showSetup() }, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(controls)
        val scroll = ScrollView(this)
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 4, 0, 8) }
        scroll.addView(body)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        status = text("", 11f, muted).apply { setPadding(3, 8, 3, 0) }
        root.addView(status)
        setContentView(root)
        when (currentTab) {
            "parked" -> showParked()
            "history" -> showHistory()
            "results" -> showResults()
            else -> showToday()
        }
    }

    private fun showToday() {
        val history = OddsEngine.history(this)
        val upcoming = (0 until history.length()).mapNotNull { history.optJSONObject(it) }
            .filter { it.optString("commence_time").isNotBlank() && it.optString("commence_time") >= java.time.Instant.now().toString() }
            .sortedBy { it.optString("commence_time") }
        card("ODDS OF THE DAY", "Today's approved selections only. Ash ranks real upcoming fixtures using bookmaker prices, recent verified results, historical ratings and match research. If nothing passes, the sheet stays empty — no forced picks.") {}
        card("HOW ASH ANALYSES A MATCH",
            "• Recent verified results, weighted toward newer games\n• Long-run historical Elo ratings from archived football, basketball and tennis results (supporting evidence only)\n• Comparable bookmaker prices and best available price\n• Multi-bookmaker agreement and market-implied probability\n• Sport-specific online news: line-ups/injuries for football, rest/back-to-back and player availability for basketball, surface/form/fitness for tennis\n• Higher odds require deeper history and more bookmaker support\n\nThe evidence index is a ranking aid, not a win probability. Probability figures are bookmaker-derived until Ash has enough settled data to validate an independent model.") {}
        val dailyPicks = OddsEngine.savedDailyPicks(this)
        val picksText = buildString {
            if (dailyPicks.length() == 0) {
                append("Ash has not found a match that passes its current evidence checks yet. No pick is better than forcing a weak one.")
            } else {
                for (i in 0 until dailyPicks.length()) {
                    val pick = dailyPicks.optJSONObject(i) ?: continue
                    if (isNotEmpty()) append("\n\n")
                    append(i + 1).append(". ").append(pick.optString("away_team"))
                        .append(" vs ").append(pick.optString("home_team"))
                    append("\nPick: ").append(pick.optString("selection"))
                        .append(" @ ").append("%.2f".format(java.util.Locale.US, pick.optDouble("price", 0.0)))
                    append("\nMarket-implied chance: ")
                    val marketPct = pick.optDouble("market_probability_pct", Double.NaN)
                    append(if (marketPct.isFinite()) "%.1f%%".format(java.util.Locale.US, marketPct) else "not available")
                    append("\nRaw odds-implied chance: ")
                    val rawPct = pick.optDouble("raw_implied_probability_pct", Double.NaN)
                    append(if (rawPct.isFinite()) "%.1f%%".format(java.util.Locale.US, rawPct) else "not available")
                    append("\nEvidence index: ").append(pick.optInt("evidence_index"))
                        .append("/100 • Bookmakers: ").append(pick.optInt("bookmakers"))
                    val eloHome = pick.optDouble("historical_elo_home", Double.NaN)
                    val eloAway = pick.optDouble("historical_elo_away", Double.NaN)
                    val eloProbability = pick.optDouble("historical_elo_home_probability_pct", Double.NaN)
                    if (eloHome.isFinite() && eloAway.isFinite()) {
                        append("\nHistorical Elo prior: home ").append("%.0f".format(java.util.Locale.US, eloHome))
                            .append(" vs away ").append("%.0f".format(java.util.Locale.US, eloAway))
                            .append(" • samples ").append(pick.optInt("historical_elo_home_matches"))
                            .append("/").append(pick.optInt("historical_elo_away_matches"))
                        if (eloProbability.isFinite()) append("\nElo baseline home estimate: ")
                            .append("%.1f%%".format(java.util.Locale.US, eloProbability))
                            .append(" (unvalidated historical baseline, not a betting probability)")
                    }
                    append("\nWhy: ").append(pick.optString("reason"))
                }
                append("\n\nEvidence index is a heuristic, not a measured chance of winning. Odds can change.")
            }
        }
        card("TODAY'S APPROVED PICKS", picksText) {
            AlertDialog.Builder(this).setTitle("Daily researched shortlist")
                .setMessage(picksText)
                .setPositiveButton("OK", null).show()
        }
        body.addView(button("COPY ODDS OF THE DAY") {
            val copyText = buildString {
                append("ASH ODDS OF THE DAY • ").append(java.time.LocalDate.now()).append("\n\n")
                if (dailyPicks.length() == 0) {
                    append("No selections passed today's evidence checks. No forced bets.")
                } else {
                    for (i in 0 until dailyPicks.length()) {
                        val pick = dailyPicks.optJSONObject(i) ?: continue
                        append(i + 1).append(". ").append(pick.optString("away_team"))
                            .append(" vs ").append(pick.optString("home_team")).append("\n")
                        append("Pick: ").append(pick.optString("selection")).append(" @ ")
                            .append("%.2f".format(java.util.Locale.US, pick.optDouble("price", 0.0))).append("\n")
                        append("Sport: ").append(pick.optString("sport_title")).append(" • Bookmakers: ")
                            .append(pick.optInt("bookmakers")).append("\n")
                        append("Best price: ").append(pick.optString("best_bookmaker", "not listed")).append("\n\n")
                    }
                }
                append("Odds move. Evidence rankings are not guarantees. Bet responsibly.")
            }
            val clipboard = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Ash Odds of the Day", copyText))
            Toast.makeText(this, "Daily odds copied — ready to paste", Toast.LENGTH_LONG).show()
        })
        showAccumulatorTargets(dailyPicks)
        val oddEvenDay = java.time.LocalDate.now(java.time.ZoneId.systemDefault()).toString()
        val oddEvenRecord = LocalSportsDatabase.get(this).get("daily_odd_even", oddEvenDay)
        val oddEvenTip = oddEvenRecord?.optJSONObject("tip")
        card("DAILY ODD / EVEN • TARGET 1.50",
            if (oddEvenTip != null) {
                "${oddEvenTip.optString("away_team")} vs ${oddEvenTip.optString("home_team")}\nPick: ${oddEvenTip.optString("selection")} @ ${"%.2f".format(java.util.Locale.US, oddEvenTip.optDouble("price"))}\nBookmakers: ${oddEvenTip.optInt("bookmakers")} • ${oddEvenTip.optString("bookmaker")}\nStatus: archived for result tracking"
            } else {
                "Ash checks one real football odd/even market each day (one extra odds request). Today: ${oddEvenRecord?.optString("status", "not checked yet") ?: "not checked yet"}. No made-up prices. Tap to inspect another match."
            }) {
            if (oddEvenTip != null) {
                AlertDialog.Builder(this).setTitle("Today's odd/even selection")
                    .setMessage("${oddEvenTip.optString("selection")} @ ${"%.2f".format(java.util.Locale.US, oddEvenTip.optDouble("price"))}\n${oddEvenTip.optString("bookmaker")}\n${oddEvenTip.optString("probability_method")}")
                    .setPositiveButton("OK", null).show()
            } else chooseOddEvenGame(upcoming)
        }
        body.addView(button("SHARE DAILY TIP SHEET") {
            val shareText = buildString {
                append("ASH SPORTS TIPS • ").append(java.time.LocalDate.now()).append("\n\n")
                if (dailyPicks.length() == 0) {
                    append("No selections passed today's evidence checks. No forced bets.\n")
                } else {
                    for (i in 0 until dailyPicks.length()) {
                        val pick = dailyPicks.optJSONObject(i) ?: continue
                        append(i + 1).append(". ").append(pick.optString("sport_title")).append("\n")
                        append(pick.optString("away_team")).append(" vs ").append(pick.optString("home_team")).append("\n")
                        append("Pick: ").append(pick.optString("selection")).append(" @ ")
                            .append("%.2f".format(java.util.Locale.US, pick.optDouble("price"))).append("\n")
                        append("Best price: ").append(pick.optString("best_bookmaker", "bookmaker not listed")).append("\n")
                        append("Bookmakers checked: ").append(pick.optInt("bookmakers")).append(" • ").append(pick.optString("bookmaker_names")).append("\n")
                        val probability = pick.optDouble("market_probability_pct", Double.NaN)
                        if (probability.isFinite()) append("Market-implied probability: ")
                            .append("%.1f%%".format(java.util.Locale.US, probability)).append("\n")
                        append("Research: ").append(pick.optString("reason")).append("\n\n")
                    }
                }
                if (oddEvenTip != null) {
                    append("ODD / EVEN SPECIAL\n")
                    append(oddEvenTip.optString("away_team")).append(" vs ").append(oddEvenTip.optString("home_team")).append("\n")
                    append(oddEvenTip.optString("selection")).append(" @ ")
                        .append("%.2f".format(java.util.Locale.US, oddEvenTip.optDouble("price"))).append("\n")
                    append("Bookmakers: ").append(oddEvenTip.optInt("bookmakers")).append("\n\n")
                }
                append("Odds can change. Probabilities shown are bookmaker-derived, not guaranteed outcomes. Bet responsibly.")
            }
            val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(android.content.Intent.EXTRA_TEXT, shareText)
            }
            startActivity(android.content.Intent.createChooser(intent, "Share Ash daily tips"))
        })
        val last = getSharedPreferences("ash_jarvis", MODE_PRIVATE).getString("odds_last_sync", "not yet")
        val ratingSnapshot = HistoricalRatingsEngine.snapshotInfo(this)
        val ratingCount = ratingSnapshot?.optInt("participant_records_cached") ?: 0
        val ratingDate = ratingSnapshot?.optString("generated_at").orEmpty().take(10)
        status.text = "Last sync: $last • ${upcoming.size} upcoming • ${dailyPicks.length()} approved picks • Historical Elo: " +
            if (ratingCount > 0) "$ratingCount participants ($ratingDate)" else "not synced yet"
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        actions.addView(button("REFRESH NOW") { refreshNow() }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(button("VIEW SPORTS API LIST") { showLeagues() }, LinearLayout.LayoutParams(0, -2, 1f))
        body.addView(actions, 0)
    }

            private fun showParked() {
        val history = OddsEngine.history(this)
        val dailyPicks = OddsEngine.savedDailyPicks(this)
        val approvedIds = (0 until dailyPicks.length()).mapNotNull { dailyPicks.optJSONObject(it)?.optString("id") }.toSet()
        val now = java.time.Instant.now()
        val parked = (0 until history.length()).mapNotNull { history.optJSONObject(it) }
            .filter { event ->
                val kickoff = event.optString("commence_time")
                val future = kickoff.isNotBlank() && runCatching { java.time.Instant.parse(kickoff).isAfter(now) }.getOrDefault(false)
                future && event.optString("id") !in approvedIds
            }
            .sortedWith(compareByDescending<JSONObject> { it.optInt("candidate_bookmakers") }
                .thenBy { it.optString("commence_time") })

        card("PARKED / WATCHLIST", "These are real upcoming fixtures that did not make today's approved Odds of the Day. They are for monitoring only — not recommended bets. A match stays parked until its evidence checks pass.") {}
        if (parked.isEmpty()) {
            body.addView(text("No parked fixtures right now. Refresh the odds feed to update the watchlist.", 14f, muted)
                .apply { setPadding(12, 14, 12, 14) })
            status.text = "Parked watchlist • 0 fixtures"
            return
        }
        parked.take(100).forEach { event ->
            val books = event.optInt("candidate_bookmakers")
            val candidate = event.optString("candidate")
            val marketText = if (candidate.isNotBlank()) {
                "Market candidate: $candidate @ ${"%.2f".format(java.util.Locale.US, event.optDouble("candidate_price", 0.0))}"
            } else "Market candidate: not available"
            val reason = when {
                candidate.isBlank() -> "No qualifying bookmaker market is available"
                books < 3 -> "Too few bookmaker quotes for the main shortlist"
                else -> "Did not pass the full recent-form / research threshold"
            }
            card("${event.optString("away_team")} vs ${event.optString("home_team")}",
                "${event.optString("sport_title")}\n$marketText\nBookmakers: $books\nKick-off: ${event.optString("commence_time")}\nPARKED — $reason. Not a pick.") {
                researchMatch(event)
            }
        }
        status.text = "Parked watchlist • ${parked.size} fixtures • not approved for betting"
    }

    private fun showAccumulatorTargets(researchedPicks: JSONArray) {
        val targets = listOf(1.5, 2.0, 3.0, 4.0, 5.0, 6.0, 10.0, 20.0, 50.0, 100.0)
        val researched = (0 until researchedPicks.length()).mapNotNull { researchedPicks.optJSONObject(it) }
            .filter { it.optDouble("price", 0.0) > 1.0 }
        targets.forEach { target ->
            val remaining = researched.toMutableList()
            val selected = mutableListOf<JSONObject>()
            var combined = 1.0
            while (combined < target && remaining.isNotEmpty() && selected.size < 8) {
                val need = target / combined
                val next = remaining.minByOrNull { pick ->
                    val price = pick.optDouble("price", 1.0)
                    kotlin.math.abs(kotlin.math.ln(price / need))
                } ?: break
                val price = next.optDouble("price", 1.0)
                if (selected.isNotEmpty() && price > need * 2.0) break
                selected.add(next)
                remaining.remove(next)
                combined *= price
            }
            val ready = selected.isNotEmpty() && combined >= target && combined <= target * 1.75
            val highRisk = target > 10.0
            val title = "TARGET ${target.toInt()} ODDS" +
                if (ready) " • ${selected.size} RESEARCHED PICKS" else " • NOT ENOUGH EVIDENCE"
            val details = if (ready) {
                "Combined decimal odds: %.2f".format(java.util.Locale.US, combined) +
                    (if (highRisk) "\nHIGH RISK • this is not a main daily recommendation." else "") +
                    "\n" + selected.joinToString("\n") { pick ->
                        val probability = pick.optDouble("market_probability_pct", Double.NaN)
                        "• ${pick.optString("away_team")} vs ${pick.optString("home_team")} — ${pick.optString("selection")} @ ${"%.2f".format(java.util.Locale.US, pick.optDouble("price"))} • market chance ${if (probability.isFinite()) "%.1f%%".format(java.util.Locale.US, probability) else "n/a"} • ${pick.optString("best_bookmaker")}"
                    } +
                    "\nApprox. combined market chance (assuming independent matches): " + run {
                        val probabilities = selected.map { it.optDouble("market_probability_pct", Double.NaN) / 100.0 }
                        if (probabilities.all { it.isFinite() && it in 0.0..1.0 })
                            "%.2f%%".format(java.util.Locale.US, probabilities.fold(1.0) { acc, p -> acc * p } * 100.0)
                        else "not available"
                    } +
                    "\nOnly previously researched selections are used. Combined probabilities assume independence and are bookmaker-derived, not Ash-validated forecasts. Odds can move."
            } else {
                "Ash does not have enough distinct researched selections to build this target responsibly. Refresh or choose more competitions. It will not add unresearched matches just to reach the number."
            }
            card(title, details) {
                if (!ready) {
                    Toast.makeText(this, "Not enough researched selections for target ${target.toInt()}", Toast.LENGTH_LONG).show()
                } else {
                    AlertDialog.Builder(this).setTitle("Researched ${target.toInt()}-odds slip")
                        .setMessage(details)
                        .setPositiveButton("OK", null).show()
                }
            }
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
                var archivedTip: JSONObject? = null
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
                                val bookmakerName = book.optString("title", book.optString("key"))
                                found.add("$bookmakerName: ${outcome.optString("name")} @ ${"%.2f".format(java.util.Locale.US, price)}")
                                if (archivedTip == null) {
                                    archivedTip = JSONObject()
                                        .put("id", event.optString("id"))
                                        .put("sport_key", event.optString("sport_key"))
                                        .put("sport_title", event.optString("sport_title"))
                                        .put("home_team", event.optString("home_team"))
                                        .put("away_team", event.optString("away_team"))
                                        .put("commence_time", event.optString("commence_time"))
                                        .put("selection", outcome.optString("name"))
                                        .put("price", price)
                                        .put("bookmaker", bookmakerName)
                                        .put("bookmakers", 1)
                                        .put("probability_method", "Single bookmaker price; no independent Ash probability")
                                }
                            }
                        }
                    }
                }
                archivedTip?.let { tip ->
                    val day = java.time.LocalDate.now(java.time.ZoneId.systemDefault()).toString()
                    TipResultsTracker.publish(this@SportsOddsActivity, tip, "odd_even")
                    LocalSportsDatabase.get(this@SportsOddsActivity).put("daily_odd_even", day,
                        JSONObject().put("date", day).put("status", "found").put("tip", tip))
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

    private fun chooseHistoricalImport() {
        val sports = arrayOf("Football / Soccer", "Basketball", "Tennis")
        AlertDialog.Builder(this).setTitle("Import historical match CSV")
            .setMessage("Choose the sport for this file. Ash will keep rows dated 2000–2026 in its private SQLite database. Use datasets you are allowed to store.")
            .setItems(sports) { _, which ->
                pendingArchiveSport = when (which) {
                    1 -> "basketball"
                    2 -> "tennis"
                    else -> "football"
                }
                val intent = android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(android.content.Intent.CATEGORY_OPENABLE)
                    type = "text/*"
                }
                startActivityForResult(intent, archiveImportRequestCode)
            }
            .setNegativeButton("CANCEL", null).show()
    }

    @Deprecated("Deprecated Android callback retained for broad device compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != archiveImportRequestCode || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        status.text = "Importing $pendingArchiveSport history into Ash's phone database…"
        scope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    HistoricalSportsArchive.importCsv(this@SportsOddsActivity, uri, pendingArchiveSport, uri.lastPathSegment ?: "selected CSV")
                }
                Toast.makeText(this@SportsOddsActivity,
                    "Imported ${result.imported} ${result.sport} matches • skipped ${result.skipped} rows • years ${result.firstYear ?: "?"}–${result.lastYear ?: "?"}",
                    Toast.LENGTH_LONG).show()
                render()
                status.text = "Historical import complete • ${result.imported} rows saved locally"
            } catch (e: Exception) {
                status.text = "Historical import failed"
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Could not import CSV")
                    .setMessage((e.message ?: "Unsupported CSV file").take(800))
                    .setPositiveButton("OK", null).show()
            }
        }
    }

    private fun showResults() {
        val all = TipResultsTracker.all(this)
        val week = TipResultsTracker.stats(this, 7)
        val month = TipResultsTracker.stats(this, 30)
        val lifetime = TipResultsTracker.stats(this, 3650)
        fun pct(value: JSONObject, key: String): String {
            val number = value.optDouble(key, Double.NaN)
            return if (number.isFinite()) "%.1f%%".format(java.util.Locale.US, number) else "—"
        }
        card("LAST 7 DAYS",
            "Won: ${week.optInt("won")} • Lost: ${week.optInt("lost")} • Pending: ${week.optInt("pending")}\nHit rate: ${pct(week, "hit_rate_pct")}\nProfit: ${"%.2f".format(java.util.Locale.US, week.optDouble("profit_units"))} units • Yield: ${pct(week, "yield_pct")}\nMarket Brier score: ${if (week.isNull("market_brier_score")) "not enough samples" else "%.3f".format(java.util.Locale.US, week.optDouble("market_brier_score"))}") {}
        card("LAST 30 DAYS",
            "Won: ${month.optInt("won")} • Lost: ${month.optInt("lost")} • Pending: ${month.optInt("pending")}\nHit rate: ${pct(month, "hit_rate_pct")}\nProfit: ${"%.2f".format(java.util.Locale.US, month.optDouble("profit_units"))} units • Yield: ${pct(month, "yield_pct")}\nMarket Brier score: ${if (month.isNull("market_brier_score")) "not enough samples" else "%.3f".format(java.util.Locale.US, month.optDouble("market_brier_score"))}") {}
        val segments = lifetime.optJSONObject("performance_segments") ?: JSONObject()
        val segmentRows = mutableListOf<Pair<Int, String>>()
        val segmentKeys = segments.keys()
        while (segmentKeys.hasNext()) {
            val key = segmentKeys.next()
            val segment = segments.optJSONObject(key) ?: continue
            val count = segment.optInt("settled")
            val yield = segment.optDouble("yield_pct", Double.NaN)
            val hit = segment.optDouble("hit_rate_pct", Double.NaN)
            segmentRows.add(count to "${key.replace("|", " • ")}: ${segment.optInt("won")}W-${segment.optInt("lost")}L • hit ${if (hit.isFinite()) "%.1f%%".format(java.util.Locale.US, hit) else "—"} • yield ${if (yield.isFinite()) "%.1f%%".format(java.util.Locale.US, yield) else "—"}")
        }
        val experienceText = if (segmentRows.isEmpty()) {
            "No settled tips yet. Ash needs real published and settled selections before it can learn which sport and odds bands perform best."
        } else segmentRows.sortedByDescending { it.first }.joinToString("\n") { it.second } +
            "\n\nAsh only uses a segment's past yield to adjust evidence ranking after 30 settled tips in that same sport and odds band."
        card("ASH'S TRACKED EXPERIENCE", experienceText) {}
        card("HOW TO READ THE NUMBERS",
            "Brier score checks how well the saved bookmaker-implied probabilities matched outcomes (lower is better). It is NOT Ash's independent prediction accuracy. A small sample is not proof of a long-term edge.") {}
        body.addView(button("CHECK FINISHED MATCHES") { checkFinishedResults() })
        card("SAVED TIPS",
            "${all.length()} records saved in SQLite. Ash can verify completed scores from its historical source; unverified matches remain pending. You can still settle a result manually.") {}
        val rows = (0 until all.length()).mapNotNull { all.optJSONObject(it) }
            .sortedByDescending { it.optString("published_at") }
        if (rows.isEmpty()) {
            body.addView(text("No tips archived yet. Generate the daily shortlist first.", 14f, muted).apply { setPadding(12, 12, 12, 12) })
        }
        rows.take(150).forEach { tip ->
            val scoreText = if (tip.has("home_score") && tip.has("away_score")) "\nFinal score: ${tip.optInt("home_score")}–${tip.optInt("away_score")}" else ""
            val profitText = if (tip.has("profit_units")) "\nProfit: ${"%.2f".format(java.util.Locale.US, tip.optDouble("profit_units"))} units" else ""
            val details = "${tip.optString("sport_title")} • ${tip.optString("market_type")}\nPick: ${tip.optString("selection")} @ ${"%.2f".format(java.util.Locale.US, tip.optDouble("price", 0.0))}\nPublished: ${tip.optString("published_at")}\nStatus: ${tip.optString("status")}$scoreText$profitText"
            card("${tip.optString("away_team")} vs ${tip.optString("home_team")}", details) {
                if (tip.optString("status") == "pending") {
                    val options = arrayOf("WON", "LOST", "VOID")
                    AlertDialog.Builder(this).setTitle("Record final result")
                        .setItems(options) { _, which ->
                            val outcome = when (which) { 0 -> "won"; 1 -> "lost"; else -> "void" }
                            TipResultsTracker.settle(this, tip.optString("tip_id"), outcome, -1, -1)
                            render()
                        }.setNegativeButton("CANCEL", null).show()
                }
            }
        }
        status.text = "Results ledger • pending tips can be settled after matches"
    }

    private fun checkFinishedResults() {
        status.text = "Checking completed match results…"
        scope.launch {
            val settled = withContext(Dispatchers.IO) {
                TipResultsTracker.settleFinishedFromHistory(this@SportsOddsActivity)
            }
            Toast.makeText(this@SportsOddsActivity,
                "Verified and settled $settled tips. Unconfirmed matches remain pending.",
                Toast.LENGTH_LONG).show()
            render()
        }
    }

    private fun showHistory() {
        val db = LocalSportsDatabase.get(this)
        val history = OddsEngine.history(this)
        card("ASH'S ON-PHONE DATABASE",
            "${db.count("match")} odds fixtures • ${db.count("historical_match")} imported historical matches • ${db.count("match_research")} research reports • ${db.count("team_profile")} team profiles • ${db.count("player_profile")} player profiles • ${db.count("team_result")} team results • ${db.count("sports_news")} news records • ${db.count("daily_picks")} dated pick records\n\nStored in the app's private SQLite database. The history list below shows the most recent records; older records remain stored.") {}
        card("MATCH HISTORY", "${history.length()} recent games loaded from local SQLite. Each game stores when Ash first found it and recent odds snapshots.") {}
        val rows = (0 until history.length()).mapNotNull { history.optJSONObject(it) }
            .sortedByDescending { it.optString("first_seen") }
        if (rows.isEmpty()) body.addView(text("No games collected yet. Connect your key, choose leagues, then refresh.", 14f, muted).apply { setPadding(12, 12, 12, 12) })
        rows.take(100).forEach { event ->
            val snapshots = event.optJSONArray("snapshots") ?: JSONArray()
            card("${event.optString("away_team")}  vs  ${event.optString("home_team")}",
                "${event.optString("sport_title")}\nKick-off: ${event.optString("commence_time")}\nFirst discovered: ${event.optString("first_seen")}\nLast checked: ${event.optString("last_seen")}\nOdds snapshots stored: ${snapshots.length()}\nTap to research match history online") { researchMatch(event) }
        }
        status.text = "History is stored locally on this device • ${history.length()} games"
        card("ONLINE HISTORICAL DATA • POWERED BY SPORTScore",
            "When Ash researches a match, it searches SportScore for both teams/players, fetches available past and upcoming fixtures, and saves returned records in SQLite. Historical coverage depends on the source; missing seasons are never invented. Data source: sportscore.com") {
            startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("https://sportscore.com/")))
        }
        body.addView(button("IMPORT HISTORICAL CSV (2000–2026)") { chooseHistoricalImport() })
        body.addView(button("CLEAR MATCH HISTORY") {
            AlertDialog.Builder(this).setTitle("Clear collected history?")
                .setMessage("This only deletes the local match/odds history on this phone.")
                .setNegativeButton("CANCEL", null)
                .setPositiveButton("CLEAR") { _, _ ->
                    val localDb = LocalSportsDatabase.get(this)
                    localDb.clear("match")
                    localDb.clear("match_research")
                    localDb.clear("daily_picks")
                    getSharedPreferences("ash_jarvis", MODE_PRIVATE).edit()
                        .remove("ash_odds_history_json")
                        .putBoolean("sports_sqlite_migrated_v1", true)
                        .apply()
                    render()
                }.show()
        })
    }

    private fun showSetup() {
        AlertDialog.Builder(this).setTitle("Ash Sports backend")
            .setMessage("This app reads bookmaker odds collected by Ash's server. Your Odds API key stays on the server and is never embedded in the APK. Use REFRESH NOW to sync the latest saved fixtures and bookmaker prices.")
            .setPositiveButton("REFRESH NOW") { _, _ -> refreshNow() }
            .setNegativeButton("CLOSE", null)
            .show()
    }

    private fun testConnection(key: String) {
        status.text = "Testing odds API key…"
        scope.launch {
            try {
                val sports = withContext(Dispatchers.IO) { OddsEngine.loadSports(key) }
                if (sports.length() == 0) throw IllegalStateException("API key connected, but no sports are currently available for this plan.")
                val active = (0 until sports.length()).mapNotNull { sports.optJSONObject(it) }
                    .filter { it.optBoolean("active", true) && it.optString("key").isNotBlank() }
                val selectionPrefs = getSharedPreferences("ash_jarvis", MODE_PRIVATE)
                if (!selectionPrefs.contains("ash_odds_favorites")) {
                    val football = active.filter {
                        it.optString("key").startsWith("soccer_") ||
                            it.optString("group").contains("soccer", true) ||
                            it.optString("title").contains("football", true) ||
                            it.optString("title").contains("premier league", true)
                    }.sortedWith(compareBy<JSONObject>({ if (it.optString("key") == "soccer_epl") 0 else 1 }, { it.optString("title") }))
                        .take(4)
                    val basketball = active.filter {
                        it.optString("key").startsWith("basketball_") || it.optString("group").contains("basket", true) || it.optString("title").contains("basket", true)
                    }.take(1)
                    val tennis = active.filter {
                        it.optString("key").startsWith("tennis_") || it.optString("group").contains("tennis", true) || it.optString("title").contains("tennis", true)
                    }.take(1)
                    val preferred = (football + basketball + tennis).map { it.optString("key") }.toSet()
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
        status.text = "Loading competitions currently collected by Ash…"
        scope.launch {
            try {
                val sports = withContext(Dispatchers.IO) { OddsEngine.loadBackendSports() }
                val lines = (0 until sports.length()).mapNotNull { i ->
                    val item = sports.optJSONObject(i) ?: return@mapNotNull null
                    "• ${item.optString("title")} — ${item.optString("group")}"
                }
                val message = if (lines.isEmpty()) "No competitions have been collected yet. Ash's server will populate this list after its next odds scan."
                    else "Competitions currently represented in Ash's database:\\n\\n" + lines.joinToString("\\n") +
                        "\\n\\nAsh currently chooses a diversified set automatically. Your league preferences are not yet sent to the server."
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Ash server competitions")
                    .setMessage(message).setPositiveButton("OK", null).show()
                status.text = "${sports.length()} competitions in the latest server data"
            } catch (e: Exception) {
                status.text = "Could not load server competitions"
                Toast.makeText(this@SportsOddsActivity, (e.message ?: "Network error").take(250), Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun researchMatch(event: JSONObject) {
        status.text = "Ash is researching team form, squads, player profiles and current news…"
        scope.launch {
            try {
                val collected = withContext(Dispatchers.IO) {
                    val history = runCatching {
                        HistoricalDataEngine.collectMatchHistory(
                            this@SportsOddsActivity,
                            event.optString("home_team"),
                            event.optString("away_team"),
                            event.optString("sport_title")
                        )
                    }.getOrNull()
                    val report = OddsEngine.researchMatch(
                        event.optString("home_team"),
                        event.optString("away_team"),
                        event.optString("sport_title")
                    )
                    history to report
                }
                val historyCollection = collected.first
                val report = collected.second
                if (historyCollection != null) {
                    listOf(
                        "home" to historyCollection.home,
                        "away" to historyCollection.away
                    ).forEach { side ->
                        val label = side.first
                        val teamHistory = HistoricalDataEngine.teamHistory(
                            this@SportsOddsActivity,
                            side.second.teamName,
                            event.optString("sport_title"),
                            100
                        )
                        report.put("${label}_historical_results", teamHistory)
                        report.put("${label}_historical_source", side.second.source)
                        report.put("${label}_historical_records_saved", side.second.recordsSaved)
                        report.put("${label}_historical_checked_at", side.second.checkedAt)
                    }
                    val sourceList = report.optJSONArray("sources") ?: JSONArray()
                    if ((0 until sourceList.length()).none { sourceList.optString(it).contains("SportScore") }) {
                        sourceList.put("SportScore historical fixtures API")
                    }
                    report.put("sources", sourceList)
                }
                val eventId = event.optString("id")
                val memory = LocalSportsDatabase.get(this@SportsOddsActivity)
                if (eventId.isNotBlank()) memory.put("match_research", eventId, report)
                listOf("home" to event.optString("home_team"), "away" to event.optString("away_team")).forEach { side ->
                    val label = side.first
                    val teamName = side.second
                    report.optJSONObject("${label}_profile")?.let { profile ->
                        memory.put("team_profile", teamName.lowercase().replace(Regex("[^a-z0-9]"), ""), profile)
                    }
                    val recent = report.optJSONArray("${label}_recent") ?: JSONArray()
                    for (index in 0 until recent.length()) {
                        val row = recent.optJSONObject(index) ?: continue
                        val key = "${teamName.lowercase()}|${row.optString("date")}|${row.optString("event")}"
                        memory.put("team_result", key, row.put("tracked_team", teamName))
                    }
                    val players = report.optJSONArray("${label}_players") ?: JSONArray()
                    for (index in 0 until players.length()) {
                        val player = players.optJSONObject(index) ?: continue
                        val playerName = player.optString("name")
                        if (playerName.isNotBlank()) memory.put("player_profile", "${teamName.lowercase()}|${playerName.lowercase()}", player.put("team", teamName))
                    }
                }
                val newsRows = report.optJSONArray("news") ?: JSONArray()
                for (index in 0 until newsRows.length()) {
                    val item = newsRows.optJSONObject(index) ?: continue
                    val identity = item.optString("url").ifBlank { item.optString("team") + "|" + item.optString("title") }
                    if (identity.isNotBlank()) memory.put("sports_news", identity, item)
                }
                fun formatRecent(label: String, rows: JSONArray): String {
                    if (rows.length() == 0) return "$label recent results: no verified results found online"
                    val lines = (0 until minOf(rows.length(), 5)).mapNotNull { i ->
                        val row = rows.optJSONObject(i) ?: return@mapNotNull null
                        val score = "${row.optString("home_score")}–${row.optString("away_score")}"
                        val scoreText = if (score.contains("null") || score == "–") "score unavailable" else score
                        "• ${row.optString("date")}  ${row.optString("event")} — $scoreText (${row.optString("outcome")})"
                    }
                    return "$label recent results:\n" + lines.joinToString("\n")
                }
                fun profile(label: String, item: JSONObject): String {
                    if (!item.optBoolean("found", false)) return "$label profile: not found in the public team database"
                    return buildString {
                        append(label).append(" TEAM PROFILE\n")
                        append("League: ").append(item.optString("league", "not listed")).append(" • Country: ")
                            .append(item.optString("country", "not listed")).append("\n")
                        append("Stadium: ").append(item.optString("stadium", "not listed"))
                            .append(" • Founded: ").append(item.optString("formed_year", "not listed")).append("\n")
                        val description = item.optString("description")
                        if (description.isNotBlank()) append(description.take(480)).append("\n")
                    }
                }
                fun roster(label: String, players: JSONArray): String {
                    if (players.length() == 0) return "$label squad: no roster data returned by the public source"
                    val lines = (0 until minOf(players.length(), 10)).mapNotNull { i ->
                        val p = players.optJSONObject(i) ?: return@mapNotNull null
                        val position = p.optString("position").takeIf { it.isNotBlank() } ?: "position not listed"
                        val number = p.optString("number").takeIf { it.isNotBlank() && it != "null" }?.let { " #$it" }.orEmpty()
                        val nationality = p.optString("nationality").takeIf { it.isNotBlank() }?.let { " • $it" }.orEmpty()
                        val description = p.optString("description").takeIf { it.isNotBlank() }?.let { " — ${it.take(130)}" }.orEmpty()
                        "• ${p.optString("name")}$number — $position$nationality$description"
                    }
                    return "$label AVAILABLE PLAYER PROFILES (up to 10 shown):\n" + lines.joinToString("\n")
                }
                val homeRecent = report.optJSONArray("home_recent") ?: JSONArray()
                val awayRecent = report.optJSONArray("away_recent") ?: JSONArray()
                val homeProfile = report.optJSONObject("home_profile") ?: JSONObject()
                val awayProfile = report.optJSONObject("away_profile") ?: JSONObject()
                val homePlayers = report.optJSONArray("home_players") ?: JSONArray()
                val awayPlayers = report.optJSONArray("away_players") ?: JSONArray()
                val news = report.optJSONArray("news") ?: JSONArray()
                val flags = report.optJSONArray("availability_flags") ?: JSONArray()
                val sources = report.optJSONArray("sources") ?: JSONArray()
                val newsLines = (0 until minOf(news.length(), 8)).mapNotNull { i ->
                    val item = news.optJSONObject(i) ?: return@mapNotNull null
                    val headline = item.optString("title")
                    val snippet = item.optString("snippet")
                    val date = item.optString("published")
                    "• [${item.optString("team")}] $headline" +
                        (if (date.isNotBlank()) " ($date)" else "") +
                        (if (snippet.isNotBlank()) "\n  ${snippet.take(220)}" else "") +
                        (if (item.optString("url").isNotBlank()) "\n  ${item.optString("url")}" else "")
                }
                val flagLines = (0 until minOf(flags.length(), 5)).mapNotNull { i ->
                    val item = flags.optJSONObject(i) ?: return@mapNotNull null
                    "• Possible availability-news flag for ${item.optString("team")}: ${item.optString("headline")}"
                }
                val sourceLines = (0 until sources.length()).mapNotNull { i ->
                    sources.optString(i).takeIf { it.isNotBlank() }
                }.distinct()
                val message = buildString {
                    append("ASH SPORTS RESEARCH • ").append(report.optString("researched_at")).append("\n")
                    append("Match: ").append(event.optString("away_team")).append(" vs ").append(event.optString("home_team")).append("\n\n")
                    append(profile(event.optString("home_team"), homeProfile)).append("\n")
                    append(profile(event.optString("away_team"), awayProfile)).append("\n")
                    append(formatRecent(event.optString("home_team"), homeRecent)).append("\n\n")
                    append(formatRecent(event.optString("away_team"), awayRecent)).append("\n\n")
                    append(roster(event.optString("home_team"), homePlayers)).append("\n\n")
                    append(roster(event.optString("away_team"), awayPlayers)).append("\n\n")
                    append("CURRENT ONLINE NEWS\n")
                    append(if (newsLines.isEmpty()) "No useful recent headlines returned by the news source." else newsLines.joinToString("\n"))
                    append("\n\nPOSSIBLE INJURY / AVAILABILITY CLUES\n")
                    append(if (flagLines.isEmpty()) "No obvious injury/availability keywords found. This does NOT confirm that every player is fit." else flagLines.joinToString("\n"))
                    append("\n\nSOURCES\n")
                    append(if (sourceLines.isEmpty()) "No source returned usable data this time." else sourceLines.joinToString("\n"))
                    append("\n\nASSESSMENT LIMITS\n")
                    append("Roster and biography data can be incomplete or outdated. News keyword matches are clues, not verified injury reports. Player ability ratings, confirmed starting lineups and live fitness status are not guaranteed by these free sources. Ash must lower confidence when evidence is missing.")
                }
                AlertDialog.Builder(this@SportsOddsActivity)
                    .setTitle("Ash team & player intelligence")
                    .setMessage(message)
                    .setPositiveButton("OK", null)
                    .show()
                status.text = "Research done • results ${homeRecent.length() + awayRecent.length()} • players ${homePlayers.length() + awayPlayers.length()} • news ${news.length()}"
            } catch (e: Exception) {
                status.text = "Research temporarily unavailable"
                AlertDialog.Builder(this@SportsOddsActivity)
                    .setTitle("Research unavailable")
                    .setMessage("Ash could not reach a research source right now. The match is not invalid; try again when internet is available.\n\n${(e.message ?: "Network request failed").take(300)}")
                    .setPositiveButton("OK", null)
                    .show()
            }
        }
    }

    private fun checkOddEven(event: JSONObject) {
        AlertDialog.Builder(this).setTitle("Odd/even market not collected")
            .setMessage("Ash's central collector currently stores match winner, totals and spread markets. It does not yet collect odd/even prices, so it will not invent them.")
            .setPositiveButton("OK", null).show()
    }

    private fun refreshNow() {
        status.text = "Syncing the latest bookmaker data from Ash's server…"
        scope.launch {
            try {
                val pair = withContext(Dispatchers.IO) {
                    val result = OddsEngine.syncFromBackend(this@SportsOddsActivity)
                    val picks = OddsEngine.buildDailyPicks(this@SportsOddsActivity)
                    TipResultsTracker.settleFinishedFromHistory(this@SportsOddsActivity)
                    result to picks
                }
                val result = pair.first
                val picks = pair.second
                DailyPicksNotifier.notify(this@SportsOddsActivity, picks)
                val pickSummary = if (picks.length() == 0) "\\nNo evidence-ranked picks available today; Ash did not force a selection."
                    else "\\nDaily shortlist:\\n" + (0 until picks.length()).mapNotNull { i ->
                        val p = picks.optJSONObject(i) ?: return@mapNotNull null
                        "• ${p.optString("away_team")} vs ${p.optString("home_team")} — ${p.optString("selection")} @ ${"%.2f".format(java.util.Locale.US, p.optDouble("price", 0.0))} (${p.optString("confidence")})"
                    }.joinToString("\\n")
                val summary = "Games received from Ash server: ${result.gamesFound}\\nNew games discovered: ${result.newGames}\\nServer-managed competitions: yes\\nAPI key stored on server; no key in this APK." + pickSummary +
                    if (result.errors.isNotEmpty()) "\\n\\nSome items could not be checked:\\n" + result.errors.take(4).joinToString("\\n") else ""
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Ash server sync complete")
                    .setMessage(summary).setPositiveButton("VIEW GAMES") { _, _ -> currentTab = "today"; render() }.show()
                status.text = "Updated • ${result.newGames} new games • ${picks.length()} shortlist picks"
            } catch (e: Exception) {
                status.text = "Server sync failed"
                AlertDialog.Builder(this@SportsOddsActivity).setTitle("Couldn't sync Ash Sports")
                    .setMessage((e.message ?: "Backend request failed").take(900))
                    .setPositiveButton("RETRY") { _, _ -> refreshNow() }
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
