package com.ashjarvis

import android.app.Activity
import android.os.Bundle
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.app.DownloadManager
import android.net.Uri
import android.os.Environment
import android.content.DialogInterface
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.speech.RecognizerIntent
import android.speech.tts.TextToSpeech
import java.util.Locale
import io.aatricks.llmedge.LLMEdge
import io.aatricks.llmedge.model.ModelSpec
import io.aatricks.llmedge.text.TextModelOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.provider.Settings
import android.text.InputType
import android.app.AlertDialog
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.OutputStreamWriter
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.concurrent.thread

class MainActivity : Activity() {
    private lateinit var messages: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var input: EditText
    private lateinit var footer: TextView
    private val prefs by lazy { getSharedPreferences("ash_jarvis", Context.MODE_PRIVATE) }
    private val history = JSONArray()
    private val keyAlias = "ash_jarvis_api_key"
    private var tts: TextToSpeech? = null
    private val aiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    @Volatile private var offlineEdge: LLMEdge? = null
    private val speechRequestCode = 7124
    companion object { const val ACTION_STOP_SPEAKING = "com.ashjarvis.ACTION_STOP_SPEAKING" }
    private val stopSpeechReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ACTION_STOP_SPEAKING) {
                tts?.stop()
                footer.text = "Speech stopped"
            }
        }
    }
    private var stopReceiverRegistered = false

    override fun onResume() {
        super.onResume()
        if (!stopReceiverRegistered) {
            val filter = android.content.IntentFilter(ACTION_STOP_SPEAKING)
            if (android.os.Build.VERSION.SDK_INT >= 33) registerReceiver(stopSpeechReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            else @Suppress("DEPRECATION") run { registerReceiver(stopSpeechReceiver, filter) }
            stopReceiverRegistered = true
        }
    }

    override fun onPause() {
        if (stopReceiverRegistered) {
            try { unregisterReceiver(stopSpeechReceiver) } catch (_: Exception) {}
            stopReceiverRegistered = false
        }
        super.onPause()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(10, 15, 28)
        window.navigationBarColor = Color.rgb(10, 15, 28)
        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                val engine = tts ?: return@TextToSpeech
                engine.language = Locale.getDefault()
                applySavedVoice()
            }
        }
        buildUi()
        restoreHistory()
        if (history.length() == 0) addMessage("Ash Jarvis", "Welcome. Set up your OpenRouter API key and model to start real AI chat.")
        updateStatus()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(16, 14, 16, 12)
            setBackgroundColor(Color.rgb(8, 12, 24))
        }
        fun makeText(value: String, size: Float, color: Int) = TextView(this).apply {
            text = value
            textSize = size
            setTextColor(color)
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(18, 16, 18, 16)
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(Color.rgb(20, 31, 54))
                cornerRadius = 28f
                setStroke(1, Color.rgb(48, 82, 125))
            }
        }
        val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        top.addView(makeText("✦  ASH JARVIS", 23f, Color.rgb(125, 211, 252)), LinearLayout.LayoutParams(0, -2, 1f))
        top.addView(Button(this).apply { text = "VOICE"; contentDescription = "Choose male or female voice"; setOnClickListener { showVoiceSettings() } })
        top.addView(Button(this).apply { text = "⚙"; contentDescription = "AI settings"; setOnClickListener { showAiSetup() } })
        header.addView(top)
        header.addView(makeText("YOUR AI. YOUR PHONE. YOUR RULES.", 10f, Color.rgb(164, 184, 216)).apply { setPadding(0, 5, 0, 8) })
        val statusRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        statusRow.addView(makeText("●", 12f, Color.rgb(74, 222, 128)))
        statusRow.addView(makeText("  Voice & phone tools", 12f, Color.rgb(222, 231, 245)), LinearLayout.LayoutParams(0, -2, 1f))
        statusRow.addView(Button(this).apply { text = "SPORTS"; setOnClickListener { showSportsOdds() } })
        statusRow.addView(Button(this).apply { text = "PHONE"; setOnClickListener { showPhoneTools() } })
        statusRow.addView(Button(this).apply { text = "OFFLINE AI"; setOnClickListener { showOfflineModelPicker() } })
        header.addView(statusRow)
        root.addView(header)

        root.addView(makeText("QUICK LAUNCH", 11f, Color.rgb(147, 169, 201)).apply { setPadding(2, 14, 0, 6) })
        val appStrip = android.widget.HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false }
        val appRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        appStrip.addView(appRow)
        val apps = getLaunchableApps().take(12)
        if (apps.isEmpty()) {
            appRow.addView(makeText("No launchable apps found", 12f, Color.LTGRAY).apply { setPadding(8, 12, 8, 12) })
        } else {
            apps.forEach { info ->
                val appLabel = info.loadLabel(packageManager).toString()
                val tile = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER
                    setPadding(12, 10, 12, 10)
                    background = android.graphics.drawable.GradientDrawable().apply {
                        setColor(Color.rgb(22, 32, 52))
                        cornerRadius = 20f
                        setStroke(1, Color.rgb(43, 60, 88))
                    }
                    setOnClickListener { launchInstalledApp(info.activityInfo.packageName, appLabel) }
                }
                val icon = android.widget.ImageView(this).apply {
                    setImageDrawable(info.loadIcon(packageManager))
                    layoutParams = LinearLayout.LayoutParams(42, 42)
                    contentDescription = appLabel
                }
                tile.addView(icon)
                tile.addView(makeText(appLabel.take(13), 11f, Color.rgb(226, 235, 249)).apply {
                    gravity = Gravity.CENTER
                    setPadding(0, 6, 0, 0)
                })
                appRow.addView(tile, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = 8 })
            }
        }
        root.addView(appStrip)

        val listenButton = Button(this).apply {
            text = if (prefs.getBoolean("ash_listening_enabled", false)) "■  STOP LISTENING" else "🎙  HEY ASH · START LISTENING"
            setOnClickListener { toggleBackgroundListening(this) }
        }
        root.addView(listenButton, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 10; bottomMargin = 8 })

        scroll = ScrollView(this).apply { clipToPadding = false; setPadding(0, 4, 0, 8) }
        messages = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(messages)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))

        val composer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(8, 4, 4, 4)
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(Color.rgb(20, 29, 47))
                cornerRadius = 24f
                setStroke(1, Color.rgb(54, 87, 126))
            }
        }
        input = EditText(this).apply {
            hint = "Ask Ash or say “open YouTube”"
            setHintTextColor(Color.rgb(133, 151, 179))
            setTextColor(Color.WHITE)
            textSize = 15f
            setSingleLine(false)
            maxLines = 3
            setPadding(12, 10, 8, 10)
            backgroundTintList = android.content.res.ColorStateList.valueOf(Color.TRANSPARENT)
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_SEND
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEND) { sendMessage(); true } else false
            }
        }
        composer.addView(input, LinearLayout.LayoutParams(0, -2, 1f))
        composer.addView(Button(this).apply { text = "🎙"; contentDescription = "Speak to Ash"; setOnClickListener { startVoiceInput() } })
        composer.addView(Button(this).apply { text = "➤"; contentDescription = "Send message"; setOnClickListener { sendMessage() } })
        root.addView(composer)
        footer = makeText("", 10f, Color.rgb(255, 195, 105)).apply { setPadding(3, 8, 3, 0) }
        root.addView(footer)
        setContentView(root)
    }

    private fun getLaunchableApps(): List<android.content.pm.ResolveInfo> {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return try {
            @Suppress("DEPRECATION")
            packageManager.queryIntentActivities(intent, 0)
                .filter { it.activityInfo.packageName != packageName }
                .distinctBy { it.activityInfo.packageName }
                .sortedBy { it.loadLabel(packageManager).toString().lowercase(Locale.ROOT) }
        } catch (_: Exception) { emptyList() }
    }

    private fun launchInstalledApp(packageNameToOpen: String, label: String): Boolean {
        return try {
            val intent = packageManager.getLaunchIntentForPackage(packageNameToOpen)
            if (intent == null) {
                Toast.makeText(this, "$label can't be opened from the launcher", Toast.LENGTH_SHORT).show()
                false
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
                true
            }
        } catch (_: Exception) {
            Toast.makeText(this, "Couldn't open $label", Toast.LENGTH_SHORT).show()
            false
        }
    }

        private fun toggleBackgroundListening(button: Button) {
        if (prefs.getBoolean("ash_listening_enabled", false)) {
            stopService(Intent(this, AshListeningService::class.java))
            prefs.edit().putBoolean("ash_listening_enabled", false).apply()
            button.text = "HEY ASH: LISTEN"
            Toast.makeText(this, "Ash voice listening stopped", Toast.LENGTH_SHORT).show()
            return
        }
        if (android.os.Build.VERSION.SDK_INT >= 23 && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), 7130)
            Toast.makeText(this, "Allow microphone access, then tap HEY ASH: LISTEN again", Toast.LENGTH_LONG).show()
            return
        }
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26) startForegroundService(Intent(this, AshListeningService::class.java))
            else startService(Intent(this, AshListeningService::class.java))
            prefs.edit().putBoolean("ash_listening_enabled", true).apply()
            button.text = "STOP LISTENING"
            Toast.makeText(this, "Listening enabled. Say “Hey Ash” then a command.", Toast.LENGTH_LONG).show()
        } catch (_: Exception) {
            Toast.makeText(this, "Couldn't start listening. Check microphone permission.", Toast.LENGTH_LONG).show()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 7130 && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "Microphone allowed. Tap HEY ASH: LISTEN to start.", Toast.LENGTH_LONG).show()
        }
    }

    private fun startVoiceInput() {
        try {
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
                putExtra(RecognizerIntent.EXTRA_PROMPT, "Talk to Ash Jarvis")
            }
            startActivityForResult(intent, speechRequestCode)
        } catch (_: Exception) {
            Toast.makeText(this, "Speech recognition isn't available on this phone", Toast.LENGTH_LONG).show()
        }
    }

    @Deprecated("Deprecated in Android API; retained for broad device compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == speechRequestCode && resultCode == RESULT_OK) {
            val spoken = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            if (!spoken.isNullOrBlank()) {
                input.setText(spoken)
                input.setSelection(input.text.length)
                sendMessage()
            }
        }
    }

    private fun showSportsOdds() {
        val savedBase = (prefs.getString("sports_api_base_url", "") ?: "").trim().trimEnd('/')
        if (savedBase.isBlank()) {
            val field = EditText(this).apply {
                hint = "https://your-ash-sports-api.onrender.com"
                setSingleLine(true)
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            }
            AlertDialog.Builder(this)
                .setTitle("Connect Ash Sports API")
                .setMessage("Enter the HTTPS URL of Ash's deployed odds backend. The Odds API key stays on that server, not in this APK.")
                .setView(field)
                .setNegativeButton("CANCEL", null)
                .setPositiveButton("SAVE & CONNECT") { _, _ ->
                    val base = field.text.toString().trim().trimEnd('/')
                    if (!base.startsWith("https://")) {
                        Toast.makeText(this, "Use a valid HTTPS backend URL", Toast.LENGTH_LONG).show()
                    } else {
                        prefs.edit().putString("sports_api_base_url", base).apply()
                        loadSportsList(base)
                    }
                }.show()
            return
        }
        loadSportsList(savedBase)
    }

    private fun loadSportsList(base: String) {
        footer.text = "Ash Sports: loading available sports…"
        aiScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    val connection = (URL("$base/sports").openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        connectTimeout = 12000
                        readTimeout = 18000
                    }
                    try {
                        val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
                        val body = stream.bufferedReader().use { it.readText() }
                        if (connection.responseCode !in 200..299) throw IllegalStateException(body.take(400))
                        JSONObject(body).optJSONArray("data") ?: JSONArray()
                    } finally { connection.disconnect() }
                }
                if (result.length() == 0) {
                    footer.text = "Ash Sports: provider returned no active sports"
                    Toast.makeText(this@MainActivity, "No active sports were returned by the odds provider", Toast.LENGTH_LONG).show()
                    return@launch
                }
                val options = (0 until result.length()).map { result.getJSONObject(it) }
                    .filter { it.optBoolean("active", true) && it.optString("key").isNotBlank() }
                    .sortedWith(compareBy<JSONObject>({ it.optString("group") }, { it.optString("title") }))
                    .take(80)
                val labels = options.map { obj ->
                    val group = obj.optString("group", "Sport")
                    "$group • ${obj.optString("title", obj.optString("key"))} [${obj.optString("key")}]"
                }.toTypedArray()
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("Choose a sport / competition")
                    .setItems(labels) { _, which ->
                        val sportKey = options[which].optString("key")
                        val title = options[which].optString("title", sportKey)
                        loadLiveOdds(base, sportKey, title)
                    }
                    .setNeutralButton("CHANGE API URL") { _, _ ->
                        prefs.edit().remove("sports_api_base_url").apply()
                        showSportsOdds()
                    }
                    .setNegativeButton("CLOSE", null)
                    .show()
                footer.text = "Ash Sports: connected"
            } catch (e: Exception) {
                footer.text = "Ash Sports: connection failed"
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("Ash Sports connection failed")
                    .setMessage((e.message ?: "Could not load sports").take(1000) + "\n\nCheck the backend URL and ensure ODDS_API_KEY is set on the server.")
                    .setPositiveButton("CHANGE URL") { _, _ ->
                        prefs.edit().remove("sports_api_base_url").apply()
                        showSportsOdds()
                    }
                    .setNegativeButton("OK", null).show()
            }
        }
    }

    private fun loadLiveOdds(base: String, sportKey: String, sportTitle: String) {
        footer.text = "Ash Sports: loading live odds for $sportTitle…"
        aiScope.launch {
            try {
                val payload = withContext(Dispatchers.IO) {
                    val url = "$base/odds?sport=$sportKey&regions=uk,eu&markets=h2h,totals&oddsFormat=decimal"
                    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                        requestMethod = "GET"
                        connectTimeout = 12000
                        readTimeout = 22000
                    }
                    try {
                        val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
                        val body = stream.bufferedReader().use { it.readText() }
                        if (connection.responseCode !in 200..299) throw IllegalStateException(body.take(800))
                        JSONObject(body)
                    } finally { connection.disconnect() }
                }
                val events = payload.optJSONArray("data") ?: JSONArray()
                val out = StringBuilder()
                out.append("ASH SPORTS • ").append(sportTitle).append("\n")
                out.append("Bookmaker odds from The Odds API • decimal format\n\n")
                if (events.length() == 0) {
                    out.append("No live/upcoming events with odds were returned for this competition right now.\n\n")
                } else {
                    for (i in 0 until minOf(events.length(), 12)) {
                        val event = events.getJSONObject(i)
                        out.append(event.optString("away_team")).append(" vs ").append(event.optString("home_team")).append("\n")
                        out.append("Kick-off: ").append(event.optString("commence_time")).append("\n")
                        val books = event.optJSONArray("bookmakers") ?: JSONArray()
                        for (b in 0 until minOf(books.length(), 3)) {
                            val book = books.getJSONObject(b)
                            out.append("  ").append(book.optString("title")).append(": ")
                            val markets = book.optJSONArray("markets") ?: JSONArray()
                            val parts = mutableListOf<String>()
                            for (m in 0 until markets.length()) {
                                val market = markets.getJSONObject(m)
                                val key = market.optString("key")
                                if (key != "h2h" && key != "totals") continue
                                val outcomes = market.optJSONArray("outcomes") ?: JSONArray()
                                val outcomeParts = mutableListOf<String>()
                                for (o in 0 until outcomes.length()) {
                                    val outcome = outcomes.getJSONObject(o)
                                    val point = if (outcome.has("point")) " ${outcome.optDouble("point")}" else ""
                                    outcomeParts.add("${outcome.optString("name")}$point ${outcome.optDouble("price")}")
                                }
                                if (outcomeParts.isNotEmpty()) parts.add("$key: " + outcomeParts.joinToString(", "))
                            }
                            out.append(if (parts.isEmpty()) "no featured odds" else parts.joinToString(" | ")).append("\n")
                        }
                        out.append("\n")
                    }
                }
                out.append("ODD/EVEN: The Odds API does not list this as a standard market. Ash will only show bookmaker odd/even prices if the provider returns that exact market for an event; it will never invent prices from over/under odds.\n")
                val remaining = payload.optJSONObject("quota")?.optString("x-requests-remaining", "unknown") ?: "unknown"
                out.append("\nAPI credits remaining: ").append(remaining)
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("Ash live bookmaker odds")
                    .setMessage(out.toString().take(12000))
                    .setPositiveButton("CHECK ODD/EVEN") { _, _ ->
                        if (events.length() == 0) {
                            Toast.makeText(this@MainActivity, "No events available to check", Toast.LENGTH_LONG).show()
                        } else {
                            val count = minOf(events.length(), 12)
                            val eventLabels = (0 until count).map { idx ->
                                val ev = events.getJSONObject(idx)
                                "${ev.optString("away_team")} vs ${ev.optString("home_team")}"
                            }.toTypedArray()
                            AlertDialog.Builder(this@MainActivity)
                                .setTitle("Choose event to check odd/even")
                                .setItems(eventLabels) { _, index ->
                                    val ev = events.getJSONObject(index)
                                    checkOddEvenForEvent(base, sportKey, ev.optString("id"), ev.optString("away_team"), ev.optString("home_team"))
                                }
                                .setNegativeButton("CANCEL", null).show()
                        }
                    }
                    .setNegativeButton("DONE", null)
                    .setNeutralButton("RECONNECT") { _, _ ->
                        prefs.edit().remove("sports_api_base_url").apply()
                        showSportsOdds()
                    }
                    .show()
                footer.text = "Ash Sports: odds loaded • verify prices at bookmaker before acting"
            } catch (e: Exception) {
                footer.text = "Ash Sports: odds request failed"
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("Couldn't load odds")
                    .setMessage((e.message ?: "Unknown error").take(1000))
                    .setPositiveButton("OK", null).show()
            }
        }
    }

    private fun checkOddEvenForEvent(base: String, sportKey: String, eventId: String, away: String, home: String) {
        if (eventId.isBlank()) {
            Toast.makeText(this, "Event ID missing; cannot check market", Toast.LENGTH_LONG).show()
            return
        }
        footer.text = "Ash Sports: checking whether bookmakers publish odd/even…"
        aiScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    fun getJson(path: String): JSONObject {
                        val connection = (URL(base + path).openConnection() as HttpURLConnection).apply {
                            requestMethod = "GET"
                            connectTimeout = 12000
                            readTimeout = 20000
                        }
                        try {
                            val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
                            val body = stream.bufferedReader().use { it.readText() }
                            if (connection.responseCode !in 200..299) throw IllegalStateException(body.take(700))
                            JSONObject(body)
                        } finally { connection.disconnect() }
                    }
                    val encodedId = java.net.URLEncoder.encode(eventId, "UTF-8")
                    val marketsPayload = getJson("/event-markets?sport=$sportKey&event_id=$encodedId&regions=uk,eu")
                    val providerEvent = marketsPayload.optJSONObject("data")
                    val books = providerEvent?.optJSONArray("bookmakers") ?: JSONArray()
                    val candidates = setOf("odd_even", "odd_even_goals", "total_goals_odd_even")
                    val available = linkedSetOf<String>()
                    for (b in 0 until books.length()) {
                        val markets = books.getJSONObject(b).optJSONArray("markets") ?: JSONArray()
                        for (m in 0 until markets.length()) {
                            val key = markets.getJSONObject(m).optString("key")
                            if (key in candidates) available.add(key)
                        }
                    }
                    if (available.isEmpty()) {
                        return@withContext "No bookmaker returned an odd/even market for this event. The Odds API's published standard market list does not include odd/even. Ash did not invent odds."
                    }
                    val report = StringBuilder("Odd/even market keys returned: ${available.joinToString(", ")}\n\n")
                    for (key in available) {
                        val odds = getJson("/event-odds?sport=$sportKey&event_id=$encodedId&regions=uk,eu&markets=$key")
                        val eventData = odds.optJSONObject("data")
                        val oddsBooks = eventData?.optJSONArray("bookmakers") ?: JSONArray()
                        for (b in 0 until oddsBooks.length()) {
                            val book = oddsBooks.getJSONObject(b)
                            val marketArray = book.optJSONArray("markets") ?: JSONArray()
                            for (m in 0 until marketArray.length()) {
                                val market = marketArray.getJSONObject(m)
                                if (market.optString("key") != key) continue
                                report.append(book.optString("title")).append(": ")
                                val outcomes = market.optJSONArray("outcomes") ?: JSONArray()
                                val items = mutableListOf<String>()
                                for (o in 0 until outcomes.length()) {
                                    val outcome = outcomes.getJSONObject(o)
                                    items.add("${outcome.optString("name")} @ ${outcome.optDouble("price")}")
                                }
                                report.append(items.joinToString(", ")).append("\n")
                            }
                        }
                    }
                    report.toString()
                }
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("Odd/even • $away vs $home")
                    .setMessage(result.take(5000))
                    .setPositiveButton("OK", null).show()
                footer.text = "Ash Sports: odd/even market check complete"
            } catch (e: Exception) {
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("Odd/even odds unavailable")
                    .setMessage((e.message ?: "Provider does not support this market").take(900) + "\n\nThis usually means The Odds API doesn't expose odd/even for this event. Ash will not substitute made-up prices.")
                    .setPositiveButton("OK", null).show()
                footer.text = "Ash Sports: odd/even not available from provider"
            }
        }
    }

    private fun showPhoneTools() {
        val options = arrayOf("Enable screen reading / tapping", "Read last captured screen aloud", "Tap a visible item by its text", "Type a reply into focused field", "Open phone dialer", "Open notifications", "Open quick settings", "Call-answering help")
        AlertDialog.Builder(this)
            .setTitle("Ash phone tools")
            .setItems(options) { _, which ->
                when (which) {
                    0 -> AlertDialog.Builder(this)
                        .setTitle("Enable Ash screen control")
                        .setMessage("Android requires you to enable Ash Jarvis Screen Control manually. This permission lets Ash read visible text and perform actions you request. Only enable it if you trust this app.")
                        .setNegativeButton("CANCEL", null)
                        .setPositiveButton("OPEN SETTINGS") { _, _ ->
                            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                        }.show()
                    1 -> {
                        val screen = prefs.getString(AshAccessibilityService.KEY_SCREEN, null)
                        if (screen.isNullOrBlank()) {
                            Toast.makeText(this, "No screen text captured yet. Enable Ash accessibility, open the target app, then return here.", Toast.LENGTH_LONG).show()
                        } else {
                            AlertDialog.Builder(this).setTitle("Last captured screen")
                                .setMessage(screen.take(9000))
                                .setPositiveButton("SPEAK") { _, _ -> tts?.speak(screen.take(3500), TextToSpeech.QUEUE_FLUSH, null, "ash-screen") }
                                .setNegativeButton("CLOSE", null).show()
                        }
                    }
                    2 -> {
                        val field = EditText(this).apply { hint = "Exact visible text to tap"; setSingleLine(true) }
                        AlertDialog.Builder(this).setTitle("Tap screen item")
                            .setMessage("This sends a tap to the currently active app. Check the target carefully before confirming.")
                            .setView(field).setNegativeButton("CANCEL", null)
                            .setPositiveButton("TAP") { _, _ ->
                                val target = field.text.toString().trim()
                                if (target.isNotBlank()) sendBroadcast(Intent(AshAccessibilityService.ACTION_TAP_TEXT).setPackage(packageName).putExtra(AshAccessibilityService.EXTRA_TEXT, target))
                            }.show()
                    }
                    3 -> {
                        val field = EditText(this).apply { hint = "Text to insert"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE }
                        AlertDialog.Builder(this).setTitle("Type into focused field")
                            .setMessage("First focus the message box in the target app. This inserts text only; it does not send the message.")
                            .setView(field).setNegativeButton("CANCEL", null)
                            .setPositiveButton("INSERT") { _, _ ->
                                val value = field.text.toString()
                                if (value.isNotBlank()) sendBroadcast(Intent(AshAccessibilityService.ACTION_TYPE_TEXT).setPackage(packageName).putExtra(AshAccessibilityService.EXTRA_TEXT, value))
                            }.show()
                    }
                    4 -> startActivity(Intent(Intent.ACTION_DIAL))
                    5 -> sendBroadcast(Intent(AshAccessibilityService.ACTION_NOTIFICATIONS).setPackage(packageName))
                    6 -> sendBroadcast(Intent(AshAccessibilityService.ACTION_QUICK_SETTINGS).setPackage(packageName))
                    7 -> AlertDialog.Builder(this).setTitle("Call controls")
                        .setMessage("Say \"call 07XXXXXXXX\" to open the dialer with a number. Say \"answer call\" or \"reject call\" to try tapping the matching control on a visible call screen. Android may block automatic answering/rejection on some phones. Ash does not secretly listen to calls.")
                        .setPositiveButton("OK", null).show()
                }
            }.show()
    }

    private fun updateStatus() {
        if (prefs.getBoolean("offline_ai_enabled", false)) {
            footer.text = "Offline AI selected • " + (prefs.getString("offline_model_name", "model not selected") ?: "model not selected")
            return
        }
        footer.text = if (getApiKey().isNullOrBlank()) {
            "AI engine: not configured • Tap AI SETUP"
        } else {
            "OpenRouter: configured • Model: " + (prefs.getString("model", "") ?: "")
        }
    }

    override fun onDestroy() {
        try { offlineEdge?.close() } catch (_: Exception) {}
        offlineEdge = null
        tts?.stop()
        tts?.shutdown()
        super.onDestroy()
    }

    private data class OfflineModel(
        val name: String,
        val ramLabel: String,
        val minRamGb: Int,
        val sizeLabel: String,
        val fileName: String,
        val url: String,
        val description: String
    )

    private val offlineModels = listOf(
        OfflineModel(
            "Qwen 2.5 0.5B Instruct (Q4_K_M)", "2–3 GB RAM", 2, "~400 MB",
            "qwen2.5-0.5b-instruct-q4_k_m.gguf",
            "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf?download=true",
            "Fastest and lightest; basic chat and simple tasks."
        ),
        OfflineModel(
            "Qwen 2.5 1.5B Instruct (Q4_K_M)", "4 GB RAM", 4, "~1.0 GB",
            "qwen2.5-1.5b-instruct-q4_k_m.gguf",
            "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf?download=true",
            "Balanced lightweight assistant for everyday questions."
        ),
        OfflineModel(
            "Qwen 2.5 3B Instruct (Q4_K_M)", "6 GB RAM", 6, "~2.0 GB",
            "qwen2.5-3b-instruct-q4_k_m.gguf",
            "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf?download=true",
            "More capable, but may slow down when Android uses much of the memory."
        ),
        OfflineModel(
            "Dolphin 2.9 Llama 3 8B (Q4_K_M)", "8 GB+ RAM recommended", 8, "~4.9 GB",
            "dolphin-2.9-llama3-8b-Q4_K_M.gguf",
            "https://huggingface.co/bartowski/dolphin-2.9-llama3-8b-GGUF/resolve/main/dolphin-2.9-llama3-8b-Q4_K_M.gguf?download=true",
            "Less restrictive style; too large for many 6 GB phones."
        )
    )

    private fun showOfflineModelPicker() {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(20, 8, 20, 4)
        }
        val ramLabel = TextView(this).apply {
            text = "1. Choose your phone's total RAM"
            textSize = 15f
            setTextColor(Color.rgb(30, 41, 59))
            setPadding(0, 4, 0, 8)
        }
        panel.addView(ramLabel)
        val ramSpinner = android.widget.Spinner(this)
        val ramOptions = listOf("2 GB", "3 GB", "4 GB", "6 GB", "8 GB", "12 GB", "16 GB or more")
        ramSpinner.adapter = android.widget.ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, ramOptions)
        val savedRam = prefs.getInt("offline_ram_gb", 6)
        ramSpinner.setSelection(ramOptions.indexOfFirst { it.startsWith(savedRam.toString() + " ") }.takeIf { it >= 0 } ?: 3)
        panel.addView(ramSpinner)
        panel.addView(TextView(this).apply {
            text = "2. Choose a model recommended for that RAM"
            textSize = 15f
            setTextColor(Color.rgb(30, 41, 59))
            setPadding(0, 14, 0, 8)
        })
        val modelSpinner = android.widget.Spinner(this)
        val modelAdapter = android.widget.ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, mutableListOf<String>())
        modelSpinner.adapter = modelAdapter
        val details = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.rgb(51, 65, 85))
            setPadding(0, 10, 0, 4)
        }
        panel.addView(modelSpinner)
        panel.addView(details)

        fun selectedRam(): Int = ramOptions[ramSpinner.selectedItemPosition].substringBefore(" ").toIntOrNull() ?: 16
        fun compatibleModels(): List<OfflineModel> {
            val ram = selectedRam()
            return offlineModels.filter { it.minRamGb <= ram }.ifEmpty { listOf(offlineModels.first()) }
        }
        fun refreshModels(preferredName: String? = null) {
            val choices = compatibleModels()
            modelAdapter.clear()
            modelAdapter.addAll(choices.map { it.name + " • " + it.sizeLabel })
            modelAdapter.notifyDataSetChanged()
            val chosen = choices.firstOrNull { it.name == preferredName }
                ?: choices.lastOrNull { it.minRamGb <= selectedRam() }
                ?: choices.first()
            modelSpinner.setSelection(choices.indexOf(chosen).coerceAtLeast(0))
            details.text = chosen.description + "\n\nDownload size: " + chosen.sizeLabel +
                "\nRecommended minimum RAM: " + chosen.ramLabel +
                "\n\nNote: downloading a GGUF file alone does not enable chat. The local inference engine must be integrated."
        }
        ramSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) = refreshModels()
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }
        modelSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                val chosen = compatibleModels().getOrNull(position) ?: return
                details.text = chosen.description + "\n\nDownload size: " + chosen.sizeLabel +
                    "\nRecommended minimum RAM: " + chosen.ramLabel +
                    "\n\nNote: downloading a GGUF file alone does not enable chat. The local inference engine must be integrated."
            }
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
        }
        refreshModels()

        val dialog = AlertDialog.Builder(this)
            .setTitle("Ash Jarvis • Offline models")
            .setView(panel)
            .setNegativeButton("CANCEL", null)
            .setNeutralButton("CHECK DOWNLOADED", null)
            .setPositiveButton(if (prefs.getBoolean("offline_ai_enabled", false)) "USE OFFLINE AI" else "DOWNLOAD MODEL") { _, _ ->
                val ram = selectedRam()
                val chosen = compatibleModels().getOrNull(modelSpinner.selectedItemPosition) ?: offlineModels.first()
                prefs.edit().putInt("offline_ram_gb", ram).putString("offline_model_name", chosen.name).putString("offline_model_file", chosen.fileName).apply()
                if (prefs.getBoolean("offline_model_downloaded", false)) {
                    setOfflineAiEnabled(true)
                } else {
                    startOfflineModelDownload(chosen)
                }
            }
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                checkOfflineModelDownload()
            }
        }
        dialog.show()
    }

    private fun checkOfflineModelDownload() {
        val fileName = prefs.getString("offline_model_file", null)
        val downloadId = prefs.getLong("offline_model_download_id", -1L)
        if (fileName.isNullOrBlank() || downloadId < 0L) {
            AlertDialog.Builder(this)
                .setTitle("No model download recorded")
                .setMessage("Choose DOWNLOAD MODEL first. Ash will save the model under Downloads/AshJarvis.")
                .setPositiveButton("OK", null)
                .show()
            return
        }

        val manager = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
        val query = DownloadManager.Query().setFilterById(downloadId)
        manager.query(query).use { cursor ->
            if (cursor == null || !cursor.moveToFirst()) {
                Toast.makeText(this, "Download record not found. Start the model download again.", Toast.LENGTH_LONG).show()
                return
            }
            val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            val reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
            when (status) {
                DownloadManager.STATUS_PENDING, DownloadManager.STATUS_RUNNING, DownloadManager.STATUS_PAUSED ->
                    Toast.makeText(this, "Model download is still in progress.", Toast.LENGTH_LONG).show()
                DownloadManager.STATUS_FAILED ->
                    AlertDialog.Builder(this)
                        .setTitle("Model download failed")
                        .setMessage("Android download error code: " + reason + ". Check Wi-Fi and free storage, then download again.")
                        .setPositiveButton("OK", null)
                        .show()
                DownloadManager.STATUS_SUCCESSFUL -> {
                    try {
                        val localUri = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI))
                        val internal = java.io.File(filesDir, fileName)
                        if (!internal.exists() || internal.length() < 1024 * 1024) {
                            contentResolver.openInputStream(Uri.parse(localUri)).use { source ->
                                if (source == null) throw IllegalStateException("Android couldn't open the downloaded model.")
                                internal.outputStream().use { target -> source.copyTo(target) }
                            }
                        }
                        val size = if (internal.exists()) internal.length() else 0L
                        if (size > 1024 * 1024) {
                            prefs.edit().putBoolean("offline_model_downloaded", true).apply()
                            AlertDialog.Builder(this)
                                .setTitle("Model ready")
                                .setMessage("Verified " + fileName + " (" + String.format(Locale.US, "%.2f", size / (1024.0 * 1024.0)) + " MB) in Ash's private app storage. Tap OFFLINE AI again and choose USE OFFLINE AI to start local replies.")
                                .setPositiveButton("OK", null).show()
                        } else throw IllegalStateException("The downloaded model file is unexpectedly small.")
                    } catch (e: Exception) {
                        AlertDialog.Builder(this).setTitle("Couldn't prepare model")
                            .setMessage((e.message ?: "Unknown file error") + "\nTry the download again and ensure enough storage is available.")
                            .setPositiveButton("OK", null).show()
                    }
                }
            }
        }
    }

    private fun startOfflineModelDownload(model: OfflineModel) {
        try {
            val manager = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
            val request = DownloadManager.Request(Uri.parse(model.url))
                .setTitle("Ash Jarvis • " + model.name)
                .setDescription("Downloading " + model.sizeLabel + " model to Downloads/AshJarvis")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverMetered(false)
                .setAllowedOverRoaming(false)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "AshJarvis/" + model.fileName)
            val id = manager.enqueue(request)
            prefs.edit().putLong("offline_model_download_id", id).putString("offline_model_file", model.fileName).apply()
            AlertDialog.Builder(this)
                .setTitle("Download started")
                .setMessage(model.name + " is downloading over Wi-Fi to Downloads/AshJarvis. When complete, the file is stored on your phone. Ash still needs its local inference engine integrated before it can answer with this model offline.")
                .setPositiveButton("OK", null)
                .show()
        } catch (e: Exception) {
            Toast.makeText(this, "Could not start download: " + (e.message ?: "unknown error"), Toast.LENGTH_LONG).show()
        }
    }

    private fun applySavedVoice() {
        val engine = tts ?: return
        val savedName = prefs.getString("tts_voice_name", null)
        val voices = try { engine.voices?.toList().orEmpty() } catch (_: Exception) { emptyList() }
        val selected = voices.firstOrNull { it.name == savedName }
        if (selected != null) {
            try { engine.voice = selected } catch (_: Exception) {}
        } else {
            engine.language = Locale.getDefault()
        }
    }

    private fun showVoiceSettings() {
        val engine = tts
        if (engine == null) {
            Toast.makeText(this, "Speech engine is still starting. Try again.", Toast.LENGTH_SHORT).show()
            return
        }
        val voices = try {
            engine.voices?.filter { it.locale.language == Locale.getDefault().language || it.locale.language == "en" }
                ?.sortedWith(compareBy<android.speech.tts.Voice>({ it.locale.displayLanguage }, { it.name }))
                .orEmpty()
        } catch (_: Exception) { emptyList() }
        if (voices.isEmpty()) {
            AlertDialog.Builder(this)
                .setTitle("Ash voice settings")
                .setMessage("No selectable voices were found in the installed Android speech engine. Install or download additional voices in Android Text-to-speech settings, then reopen this menu.")
                .setPositiveButton("TTS SETTINGS") { _, _ ->
                    try { startActivity(Intent("com.android.settings.TTS_SETTINGS")) }
                    catch (_: Exception) { startActivity(Intent(Settings.ACTION_SETTINGS)) }
                }
                .setNegativeButton("CLOSE", null).show()
            return
        }
        fun voiceLabel(voice: android.speech.tts.Voice): String {
            val name = voice.name.replace("_", " ")
            val genderHint = when {
                Regex("(?i)female|woman|zira|samantha|victoria|karen|moira|tessa|ava|jenny").containsMatchIn(name) -> " • likely female"
                Regex("(?i)male|man|david|mark|daniel|george|guy|ryan|aaron").containsMatchIn(name) -> " • likely male"
                else -> ""
            }
            val quality = if (voice.quality >= android.speech.tts.Voice.QUALITY_HIGH) " • high quality" else ""
            return "${voice.locale.displayName}: $name$genderHint$quality"
        }
        val labels = voices.map { voiceLabel(it) }.toTypedArray()
        val savedName = prefs.getString("tts_voice_name", null)
        val selectedIndex = voices.indexOfFirst { it.name == savedName }.coerceAtLeast(0)
        AlertDialog.Builder(this)
            .setTitle("Ash Jarvis • Voice")
            .setMessage("Choose an installed voice. Male/female labels are best-effort because Android voice engines do not always identify gender. You can preview before saving.")
            .setSingleChoiceItems(labels, selectedIndex) { dialog, which ->
                val voice = voices[which]
                try {
                    engine.voice = voice
                    prefs.edit().putString("tts_voice_name", voice.name).apply()
                    engine.speak("Hello. I am Ash Jarvis. Voice system ready.", TextToSpeech.QUEUE_FLUSH, null, "ash-voice-preview")
                    Toast.makeText(this, "Voice selected: ${voice.locale.displayLanguage}", Toast.LENGTH_SHORT).show()
                } catch (_: Exception) {
                    Toast.makeText(this, "That voice isn't available on this device.", Toast.LENGTH_LONG).show()
                }
                dialog.dismiss()
            }
            .setNeutralButton("ANDROID VOICE SETTINGS") { _, _ ->
                try { startActivity(Intent("com.android.settings.TTS_SETTINGS")) }
                catch (_: Exception) { startActivity(Intent(Settings.ACTION_SETTINGS)) }
            }
            .setNegativeButton("CLOSE", null)
            .show()
    }

    private fun showAiSetup() {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 12, 24, 4)
        }
        val modelInput = EditText(this).apply {
            hint = "OpenRouter model ID, e.g. nvidia/nemotron-3-ultra-550b-a55b:free"
            setSingleLine(true)
            setText(prefs.getString("model", "nvidia/nemotron-3-ultra-550b-a55b:free") ?: "nvidia/nemotron-3-ultra-550b-a55b:free")
        }
        val keyInput = EditText(this).apply {
            hint = if (getApiKey().isNullOrBlank()) "Paste OpenRouter API key" else "API key saved securely; enter replacement"
            inputType = 129
            setSingleLine(true)
        }
        panel.addView(modelInput)
        panel.addView(keyInput)
        AlertDialog.Builder(this)
            .setTitle("Connect OpenRouter")
            .setMessage("Use an exact OpenRouter model ID. Recommended: nvidia/nemotron-3-ultra-550b-a55b:free. Create a key at openrouter.ai/settings/keys. Your key is encrypted with Android Keystore on this device; it is not written into source code.")
            .setView(panel)
            .setNegativeButton("CANCEL", null)
            .setNeutralButton("CLEAR KEY") { _, _ ->
                prefs.edit().remove("api_key_cipher").remove("api_key_iv").apply()
                updateStatus()
                Toast.makeText(this, "Saved API key cleared", Toast.LENGTH_SHORT).show()
            }
            .setPositiveButton("SAVE & TEST") { _, _ ->
                val model = modelInput.text.toString().trim()
                val key = keyInput.text.toString().trim()
                if (model.isBlank()) {
                    Toast.makeText(this, "Enter a model name first", Toast.LENGTH_LONG).show()
                } else if (key.isNotBlank()) {
                    try {
                        saveApiKey(key)
                        prefs.edit().putString("model", model).apply()
                        updateStatus()
                        testConnection()
                    } catch (e: Exception) {
                        Toast.makeText(this, "Could not protect the key on this device", Toast.LENGTH_LONG).show()
                    }
                } else if (!getApiKey().isNullOrBlank()) {
                    prefs.edit().putString("model", model).apply()
                    updateStatus()
                    testConnection()
                } else {
                    Toast.makeText(this, "Enter your API key", Toast.LENGTH_LONG).show()
                }
            }
            .show()
    }


    private fun handlePhoneCommand(raw: String): Boolean {
        val command = raw.trim()
        val lower = command.lowercase(Locale.ROOT)
        // Small multilingual phrasebook for common phone controls. Match locally for speed and reliability.
        val multilingual = when {
            lower in listOf("nyamaza", "acha kuongea", "nyamaza ash", "kaa kimya", "leka okwogera", "sirikira", "yimiriza okwogera") -> "stop talking"
            lower in listOf("funga app", "toka kwenye app", "ondoka kwenye app", "ggala app", "fulumya app", "close app", "exit app", "quit app") -> "close app"
            lower in listOf("rudi nyuma", "nyuma", "dda emabega", "komawo emabega") -> "go back"
            lower in listOf("nenda nyumbani", "fungua home", "enda ewaka", "genda awaka") -> "go home"
            lower in listOf("fungua whatsapp", "fungua youtube", "fungua facebook", "ggulawo whatsapp", "ggulawo youtube", "ggulawo facebook") -> "open " + lower.substringAfterLast(" ").trim()
            lower in listOf("sogeza chini", "shuka chini", "serengeta wansi") -> "scroll down"
            lower in listOf("sogeza juu", "panda juu", "serengeta waggulu") -> "scroll up"
            lower in listOf("simama kusikiliza", "acha kusikiliza", "leka okuwuliriza", "yimiriza okuwuliriza") -> "stop listening"
            else -> lower
        }
        // Short control words must be handled locally, never sent to the chat model.
        if (multilingual in listOf("stop", "stop talking", "be quiet", "quiet", "cancel speech", "stop explaining")) {
            tts?.stop()
            footer.text = "Speech stopped"
            return true
        }
        if (multilingual in listOf("stop listening", "turn off listening", "disable listening")) {
            stopService(Intent(this, AshListeningService::class.java))
            prefs.edit().putBoolean("ash_listening_enabled", false).apply()
            tts?.stop()
            Toast.makeText(this, "Ash listening stopped", Toast.LENGTH_SHORT).show()
            return true
        }
        fun action(action: String, extra: String? = null): Boolean {
            val intent = Intent(action).setPackage(packageName)
            if (extra != null) intent.putExtra(AshAccessibilityService.EXTRA_TEXT, extra)
            sendBroadcast(intent)
            Toast.makeText(this, "Ash: $command", Toast.LENGTH_SHORT).show()
            return true
        }
        // Handle common natural-language app-launch requests locally, before sending anything to the AI.
        // WhatsApp launch does not require the Accessibility service to be enabled.
        val simplified = multilingual
            .replace(Regex("\\b(just|please|can you|could you|for me)\\b"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        if (simplified.startsWith("open ") || simplified.startsWith("launch ") || simplified.startsWith("start ")) {
            val requested = simplified.removePrefix("open ").removePrefix("launch ").removePrefix("start ").removePrefix("app ").removePrefix("my ").trim()
            if (requested.isNotBlank()) {
                val match = getLaunchableApps().firstOrNull { info ->
                    val label = info.loadLabel(packageManager).toString().lowercase(Locale.ROOT)
                    label == requested || label.contains(requested) || requested.contains(label)
                }
                if (match != null) return launchInstalledApp(match.activityInfo.packageName, match.loadLabel(packageManager).toString())
            }
        }
        if ((simplified.startsWith("open ") || simplified.startsWith("launch ") || simplified.startsWith("start ")) &&
            simplified.contains("whatsapp")) {
            val packages = listOf("com.whatsapp", "com.whatsapp.w4b")
            for (packageNameToOpen in packages) {
                val launchIntent = packageManager.getLaunchIntentForPackage(packageNameToOpen)
                if (launchIntent != null) {
                    return try {
                        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        startActivity(launchIntent)
                        Toast.makeText(this, "Opening WhatsApp", Toast.LENGTH_SHORT).show()
                        true
                    } catch (_: Exception) {
                        Toast.makeText(this, "Couldn't open WhatsApp on this phone", Toast.LENGTH_LONG).show()
                        true
                    }
                }
            }
            Toast.makeText(this, "WhatsApp isn't installed or available on this profile", Toast.LENGTH_LONG).show()
            return true
        }
        if (simplified.startsWith("open app ")) {
            val appName = simplified.substringAfter("open app ").trim()
            if (appName.isNotBlank()) return action(AshAccessibilityService.ACTION_OPEN_APP, appName)
        }
        if (simplified.startsWith("open ")) {
            val appName = simplified.substringAfter("open ").removePrefix("my ").trim()
            if (appName.isNotBlank()) return action(AshAccessibilityService.ACTION_OPEN_APP, appName)
        }
        if (multilingual in listOf("scroll down", "scroll down please", "go down", "page down")) return action(AshAccessibilityService.ACTION_SCROLL_DOWN)
        if (multilingual in listOf("scroll up", "scroll up please", "go up", "page up")) return action(AshAccessibilityService.ACTION_SCROLL_UP)
        if (multilingual in listOf("swipe left", "move left")) return action(AshAccessibilityService.ACTION_SWIPE_LEFT)
        if (multilingual in listOf("swipe right", "move right")) return action(AshAccessibilityService.ACTION_SWIPE_RIGHT)
        if (multilingual in listOf("close app", "exit app", "quit app")) return action(AshAccessibilityService.ACTION_HOME)
        if (multilingual in listOf("go back", "back", "press back")) return action(AshAccessibilityService.ACTION_BACK)
        if (multilingual in listOf("go home", "home screen", "press home")) return action(AshAccessibilityService.ACTION_HOME)
        if (lower in listOf("show notifications", "open notifications", "notification shade")) return action(AshAccessibilityService.ACTION_NOTIFICATIONS)
        if (multilingual in listOf("open quick settings", "show quick settings")) return action(AshAccessibilityService.ACTION_QUICK_SETTINGS)
        if (lower in listOf("lock phone", "lock screen")) return action(AshAccessibilityService.ACTION_LOCK_SCREEN)
        if (lower in listOf("answer call", "pick up call", "pick the call", "accept call")) return action(AshAccessibilityService.ACTION_TAP_TEXT, "Answer")
        if (lower in listOf("reject call", "decline call", "hang up call")) return action(AshAccessibilityService.ACTION_TAP_TEXT, "Decline")
        if (lower.startsWith("call ") || lower.startsWith("dial ")) {
            val number = command.substringAfter(" ").trim()
            val cleaned = number.filter { it.isDigit() || it == '+' || it == '*' || it == '#' }
            if (cleaned.length >= 3) {
                return try {
                    startActivity(Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", cleaned, null)))
                    Toast.makeText(this, "Dialer opened. Review the number and press call.", Toast.LENGTH_LONG).show()
                    true
                } catch (_: Exception) {
                    Toast.makeText(this, "Couldn't open the phone dialer", Toast.LENGTH_LONG).show()
                    true
                }
            }
        }
        if (lower in listOf("what is on my screen", "read my screen", "read screen", "describe my screen")) {
            val screen = prefs.getString(AshAccessibilityService.KEY_SCREEN, null)
            if (screen.isNullOrBlank()) addMessage("Ash Jarvis", "I can't see screen text yet. Enable Ash Screen Control in Android Accessibility settings, then try again.")
            else {
                addMessage("Ash Jarvis", screen.take(5000))
                tts?.speak(screen.take(3000), TextToSpeech.QUEUE_FLUSH, null, "ash-screen-command")
            }
            return true
        }
        if (lower.startsWith("tap ") || lower.startsWith("click ")) {
            val target = command.substringAfter(" ", "").trim()
            if (target.isNotBlank()) return action(AshAccessibilityService.ACTION_TAP_TEXT, target)
        }
        if (lower.startsWith("type ") || lower.startsWith("enter text ")) {
            val target = if (lower.startsWith("type ")) command.substringAfter("type ").trim()
                else command.substringAfter("enter text ").trim()
            if (target.isNotBlank()) return action(AshAccessibilityService.ACTION_TYPE_TEXT, target)
        }
        if (lower in listOf("stop reading", "stop speaking")) {
            tts?.stop()
            return true
        }
        if (lower.startsWith("open app ")) {
            val appName = command.substringAfter("open app ", "").trim()
            if (appName.isNotBlank()) return action(AshAccessibilityService.ACTION_OPEN_APP, appName)
        }
        return false
    }

    private fun sendMessage() {
        val text = input.text.toString().trim()
        if (text.isEmpty()) return
        if (handlePhoneCommand(text)) {
            input.setText("")
            return
        }
        if (handleSportsPredictionCommand(text)) return
        if (handleSportsOddsCommand(text)) return
        val offlineSelected = prefs.getBoolean("offline_ai_enabled", false)
        val offlineName = prefs.getString("offline_model_name", null)
        if (!offlineSelected && (getApiKey().isNullOrBlank() || (prefs.getString("model", "") ?: "").isBlank())) {
            showAiSetup()
            return
        }
        input.setText("")
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(input.windowToken, 0)
        footer.text = if (offlineSelected) "Loading local AI… first reply may take time" else "Ash is thinking…"
        addMessage("You", text)
        if (offlineSelected) {
            aiScope.launch {
                try {
                    val modelFile = getOfflineModelFile()
                    if (!modelFile.isFile || modelFile.length() < 1024 * 1024) {
                        throw IllegalStateException("Offline model file is missing. Open OFFLINE AI, download a model, then tap CHECK DOWNLOADED.")
                    }
                    val edge = offlineEdge ?: LLMEdge.create(this@MainActivity, aiScope).also { offlineEdge = it }
                    val prompt = buildString {
                        append("You are Ash Jarvis, a helpful private Android assistant. Reply clearly and concisely. ")
                        append("You were created by the Ash Teach Team. Never claim phone actions succeeded unless confirmed.\n")
                        val start = (history.length() - 10).coerceAtLeast(0)
                        for (i in start until history.length()) {
                            val item = history.optJSONObject(i) ?: continue
                            val sender = item.optString("sender")
                            val body = item.optString("text")
                            if (body.isBlank() || body.startsWith("Welcome.")) continue
                            append(if (sender == "You") "User: " else "Ash: ")
                            append(body.take(1200))
                            append("\n")
                        }
                        append("Ash:")
                    }
                    val answer = withContext(Dispatchers.IO) {
                        edge.text.generate(
                            prompt = prompt,
                            model = ModelSpec.localFile(modelFile),
                            options = TextModelOptions(contextSize = 2048, numThreads = 4, generationThreads = 4, temperature = 0.7f),
                            maxTokens = 256
                        )
                    }
                    addMessage("Ash Jarvis", answer.trim().ifBlank { "I couldn't generate a reply. Try again." })
                    tts?.speak(answer.take(3500), TextToSpeech.QUEUE_FLUSH, null, "ash-offline-reply")
                    footer.text = "Offline AI • replies run on this phone"
                } catch (e: Exception) {
                    addMessage("Ash Jarvis", "Offline AI couldn't start: " + (e.message ?: "unknown error"))
                    footer.text = "Offline AI needs a valid downloaded model"
                }
            }
            return
        }
        thread {
            try {
                val answer = callOpenRouter(text)
                runOnUiThread {
                    addMessage("Ash Jarvis", answer)
                    tts?.speak(answer.take(3500), TextToSpeech.QUEUE_FLUSH, null, "ash-reply")
                    updateStatus()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    addMessage("Ash Jarvis", "I couldn't reach OpenRouter: " + (e.message ?: "connection error") + ". Check your internet, API key, model ID and free-model availability.")
                    updateStatus()
                }
            }
        }
    }

    private fun handleSportsOddsCommand(text: String): Boolean {
        val lower = text.lowercase(Locale.ROOT)
        val intent = lower == "odds" || lower.startsWith("odds ") ||
            lower.contains("bookmaker odds") || lower.contains("odd even") ||
            lower.contains("odd/even") || lower.contains("live odds")
        if (!intent) return false
        input.setText("")
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(input.windowToken, 0)
        addMessage("You", text)
        addMessage("Ash Jarvis", "Opening live bookmaker odds. Choose a sport, then use CHECK ODD/EVEN on an event if you want Ash to verify whether that market is actually available.")
        showSportsOdds()
        return true
    }

    private fun handleSportsPredictionCommand(text: String): Boolean {
        val lower = text.lowercase(Locale.ROOT)
        val historyIntent = lower.contains("sports history") || lower.startsWith("history football") ||
            lower.startsWith("history tennis") || lower.startsWith("history basketball") ||
            lower == "sports data" || lower == "sports status"
        val predictionIntent = lower.startsWith("predict ") || lower.startsWith("prediction ") ||
            lower.startsWith("sports predict") || lower.contains(" prediction for ")
        if (!historyIntent && !predictionIntent) return false

        input.setText("")
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(input.windowToken, 0)
        addMessage("You", text)
        footer.text = "Loading Ash sports history…"

        thread {
            try {
                val connection = (URL("https://raw.githubusercontent.com/rangkim166-create/Ash-ai/main/data/history/ratings.json")
                    .openConnection() as HttpURLConnection)
                connection.connectTimeout = 15000
                connection.readTimeout = 20000
                connection.setRequestProperty("Cache-Control", "no-cache")
                val payload = try {
                    val code = connection.responseCode
                    if (code !in 200..299) throw IllegalStateException("Sports ratings are not published yet (HTTP $code). Open the GitHub Actions tab and run Collect sports history.")
                    connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                } finally {
                    connection.disconnect()
                }
                val root = JSONObject(payload)
                val tables = root.optJSONObject("ratings") ?: throw IllegalStateException("Sports ratings file is incomplete.")
                val counts = root.optJSONObject("match_counts") ?: JSONObject()
                val answer: String
                if (historyIntent) {
                    answer = "Ash sports history status\n" +
                        "Football results used: " + counts.optInt("football") + "\n" +
                        "Tennis matches used: " + counts.optInt("tennis") + "\n" +
                        "Basketball games used: " + counts.optInt("basketball") + "\n\n" +
                        "These are the records loaded into the Elo baseline, not every match ever played or historical betting odds."
                } else {
                    val sport = when {
                        lower.contains("basketball") || lower.contains("nba") -> "basketball"
                        lower.contains("tennis") -> "tennis"
                        else -> "football"
                    }
                    val separator = Regex("\\s+(?:vs\\.?|versus|against)\\s+", RegexOption.IGNORE_CASE)
                    val match = separator.find(text)
                    if (match == null) {
                        answer = "Use: predict football Arsenal vs Liverpool\n" +
                            "Or: predict tennis player one vs player two\n" +
                            "Or: predict basketball Boston Celtics vs Los Angeles Lakers"
                    } else {
                        val leftRaw = text.substring(0, match.range.first)
                        val rightRaw = text.substring(match.range.last + 1)
                        var firstQuery = leftRaw.replace(Regex("(?i)^\\s*(?:please\\s+)?(?:sports\\s+)?(?:predict|prediction)\\s*"), "").trim()
                        firstQuery = firstQuery.replace(Regex("(?i)^(football|soccer|tennis|basketball|nba)\\s+"), "").trim()
                        var secondQuery = rightRaw.replace(Regex("(?i)\\s+(?:prediction|please predict)$"), "").trim()
                        val table = tables.optJSONObject(sport) ?: JSONObject()
                        val first = findSportsRating(table, firstQuery)
                        val second = findSportsRating(table, secondQuery)
                        if (first == null || second == null) {
                            answer = "I couldn't match both names in Ash's published $sport history. Check spelling or try the full team/player names.\n" +
                                "Loaded matches: " + counts.optInt(sport) + ". A missing rating means the model uses a neutral baseline."
                        } else {
                            val probability = 1.0 / (1.0 + Math.pow(10.0, (second.second - first.second) / 400.0))
                            answer = "Ash $sport Elo estimate\n" +
                                first.first + ": Elo " + String.format(Locale.US, "%.0f", first.second) + "\n" +
                                second.first + ": Elo " + String.format(Locale.US, "%.0f", second.second) + "\n\n" +
                                first.first + " estimated win chance: " + String.format(Locale.US, "%.1f", probability * 100.0) + "%\n" +
                                second.first + " estimated win chance: " + String.format(Locale.US, "%.1f", (1.0 - probability) * 100.0) + "%\n\n" +
                                "Based on historical results only. It does not account for injuries, lineups, surface, venue or live odds. Not a guarantee."
                        }
                    }
                }
                runOnUiThread {
                    addMessage("Ash Jarvis", answer)
                    tts?.speak(answer.take(3000), TextToSpeech.QUEUE_FLUSH, null, "ash-sports-reply")
                    footer.text = "Sports history • " + root.optString("generated_at_utc", "last published")
                }
            } catch (e: Exception) {
                runOnUiThread {
                    val message = e.message ?: "unknown connection error"
                    addMessage("Ash Jarvis", "Ash sports history isn't available yet: $message")
                    footer.text = "Sports history not connected yet"
                }
            }
        }
        return true
    }

    private fun findSportsRating(table: JSONObject, query: String): Pair<String, Double>? {
        val normalizedQuery = query.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9]"), "")
        if (normalizedQuery.length < 3) return null
        val entries = mutableListOf<Pair<String, Double>>()
        val keys = table.keys()
        while (keys.hasNext()) {
            val name = keys.next()
            val rating = table.optDouble(name, Double.NaN)
            if (!rating.isNaN()) entries.add(name to rating)
        }
        entries.firstOrNull {
            it.first.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9]"), "") == normalizedQuery
        }?.let { return it }
        val matches = entries.filter {
            val normalizedName = it.first.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9]"), "")
            normalizedName.length >= 3 &&
                (normalizedName.contains(normalizedQuery) || normalizedQuery.contains(normalizedName))
        }
        return matches.maxByOrNull {
            it.first.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9]"), "").length
        }
    }

    private fun getOfflineModelFile(): java.io.File {
        val fileName = prefs.getString("offline_model_file", null)
            ?: throw IllegalStateException("No offline model selected. Open OFFLINE AI and download one.")
        val internal = java.io.File(filesDir, fileName)
        if (internal.exists() && internal.length() > 1024 * 1024) return internal
        val publicFile = java.io.File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "AshJarvis/" + fileName
        )
        if (!publicFile.exists() || publicFile.length() <= 1024 * 1024) {
            throw IllegalStateException("Model download isn't complete yet. Check Wi-Fi and download status.")
        }
        publicFile.inputStream().use { input ->
            internal.outputStream().use { output -> input.copyTo(output) }
        }
        return internal
    }

    private fun setOfflineAiEnabled(enabled: Boolean) {
        prefs.edit().putBoolean("offline_ai_enabled", enabled).apply()
        Toast.makeText(this, if (enabled) "Offline AI selected. Replies will run on-device." else "Online AI selected.", Toast.LENGTH_LONG).show()
        updateStatus()
    }

    private fun testConnection() {
        footer.text = "Testing OpenRouter connection…"
        thread {
            try {
                val answer = callOpenRouter("Reply with exactly: Ash Jarvis connected")
                runOnUiThread {
                    addMessage("Ash Jarvis", answer)
                    updateStatus()
                    Toast.makeText(this, "OpenRouter responded successfully", Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    footer.text = "OpenRouter test failed • Check model, key and internet"
                    addMessage("Ash Jarvis", "Connection test failed: " + (e.message ?: "unknown error") + ". Verify the OpenRouter model ID and confirm your API key has access.")
                }
            }
        }
    }

    private fun callOpenRouter(userText: String): String {
        val key = getApiKey() ?: throw IllegalStateException("API key missing")
        val model = prefs.getString("model", "")?.trim().orEmpty()
        if (model.isBlank()) throw IllegalStateException("model name missing")
        val connection = (URL("https://openrouter.ai/api/v1/chat/completions").openConnection() as HttpURLConnection)
        connection.requestMethod = "POST"
        connection.connectTimeout = 20000
        connection.readTimeout = 90000
        connection.setRequestProperty("Authorization", "Bearer $key")
        connection.setRequestProperty("Content-Type", "application/json")
        connection.setRequestProperty("HTTP-Referer", "https://github.com/rangkim166-create/Ash-ai")
        connection.setRequestProperty("X-OpenRouter-Title", "Ash Jarvis")
        connection.doOutput = true
        val recent = JSONArray()
        recent.put(JSONObject().put("role", "system").put("content", "You are Ash Jarvis, the AI assistant created by the Ash Teach Team. If asked who created you, say: \"I was created by the Ash Teach Team.\" Understand and reply in the user's language when possible, including English, Luganda, and Kiswahili/Swahili. For Lumasaba or another language, respond only when confident; if uncertain, ask for clarification rather than pretending. Be a capable, concise, practical assistant. The Android app can execute only supported local commands; never claim you opened, tapped, typed, sent, purchased, deleted, or changed anything unless the app confirms it. For phone actions, give the user the exact supported command when appropriate. Respect stop/stop talking commands immediately. Be honest, clear, and safety-conscious. Ask for confirmation before sending messages, deleting data, making purchases, or other consequential actions."))
        val start = (history.length() - 12).coerceAtLeast(0)
        for (i in start until history.length()) {
            val item = history.optJSONObject(i) ?: continue
            val sender = item.optString("sender")
            val content = item.optString("text")
            if (content.isBlank() || sender == "Ash Jarvis" && content.startsWith("Welcome.")) continue
            recent.put(JSONObject().put("role", if (sender == "You") "user" else "assistant").put("content", content.take(3000)))
        }
        // The current user message is already in local history; don't send it twice.
        val payload = JSONObject()
            .put("model", model)
            .put("messages", recent)
            .put("stream", false)
            .put("max_tokens", 1200)
        try {
            OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { it.write(payload.toString()) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val responseText = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            if (code !in 200..299) {
                val detail = try {
                    val err = JSONObject(responseText).opt("error")
                    if (err is JSONObject) err.optString("message", err.toString()) else err?.toString() ?: responseText
                } catch (_: Exception) { responseText }
                val hint = when (code) {
                    401 -> " OpenRouter rejected the API key. Create a new key and replace the saved key."
                    402 -> " The request may require credits or a paid model; confirm the selected model is marked Free."
                    403 -> " OpenRouter denied access. Check account/key access and the selected provider's terms."
                    404 -> " Model not found. Use the exact model slug shown on OpenRouter."
                    429 -> " Free-model rate limit reached or provider is busy. Wait and retry, or choose another free model."
                    else -> ""
                }
                throw IllegalStateException("HTTP $code: " + detail.take(240) + hint)
            }
            val json = JSONObject(responseText)
            return json.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")
                ?.optString("content")?.takeIf { it.isNotBlank() }
                ?: throw IllegalStateException("OpenRouter returned no answer")
        } finally {
            connection.disconnect()
        }
    }

    private fun getSecretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(keyAlias, null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return generator.generateKey()
    }

    private fun saveApiKey(key: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getSecretKey())
        val encrypted = cipher.doFinal(key.toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString("api_key_cipher", Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString("api_key_iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    private fun getApiKey(): String? {
        return try {
            val encrypted = prefs.getString("api_key_cipher", null) ?: return null
            val iv = prefs.getString("api_key_iv", null) ?: return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getSecretKey(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    private fun addMessage(sender: String, text: String) {
        val isUser = sender == "You"
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(15, 12, 15, 12)
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(if (isUser) Color.rgb(26, 74, 111) else Color.rgb(22, 31, 49))
                cornerRadius = 22f
                setStroke(1, if (isUser) Color.rgb(54, 125, 177) else Color.rgb(44, 58, 82))
            }
        }
        val label = TextView(this).apply {
            this.text = if (isUser) "YOU" else "✦  ASH JARVIS"
            textSize = 10f
            setLetterSpacing(0.08f)
            setTextColor(if (isUser) Color.rgb(160, 220, 255) else Color.rgb(129, 230, 177))
        }
        val body = TextView(this).apply {
            this.text = text
            textSize = 15f
            setTextColor(Color.rgb(241, 245, 252))
            setLineSpacing(2f, 1.02f)
            setPadding(0, 6, 0, 0)
        }
        card.addView(label)
        card.addView(body)
        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = if (isUser) Gravity.END else Gravity.START
            addView(card, LinearLayout.LayoutParams(-1, -2).apply {
                width = (resources.displayMetrics.widthPixels * if (isUser) 0.86f else 0.96f).toInt()
            })
        }
        messages.addView(outer, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 10 })
        history.put(JSONObject().put("sender", sender).put("text", text))
        prefs.edit().putString("history", history.toString()).apply()
        scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun restoreHistory() {
        val saved = prefs.getString("history", "[]") ?: "[]"
        try {
            val array = JSONArray(saved)
            for (i in 0 until array.length()) {
                val item = array.getJSONObject(i)
                val sender = item.optString("sender", "Ash Jarvis")
                val text = item.optString("text", "")
                if (text.isNotBlank()) {
                    val card = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(14,10,14,10); setBackgroundColor(if (sender == "You") Color.rgb(28,48,72) else Color.rgb(23,31,49)) }
                    card.addView(TextView(this).apply { this.text = sender.uppercase(); textSize = 10f; setTextColor(if (sender == "You") Color.rgb(121,210,255) else Color.rgb(129,230,177)) })
                    card.addView(TextView(this).apply { this.text = text; textSize = 14f; setTextColor(Color.WHITE); setPadding(0,5,0,0) })
                    messages.addView(card, LinearLayout.LayoutParams(-1,-2).apply { bottomMargin = 10 })
                    history.put(item)
                }
            }
        } catch (_: Exception) { prefs.edit().remove("history").apply() }
    }
}
