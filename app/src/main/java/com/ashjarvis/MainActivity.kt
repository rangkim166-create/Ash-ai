package com.ashjarvis

import android.app.Activity
import android.os.Bundle
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.content.Context
import android.content.Intent
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
    private val speechRequestCode = 7124

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(10, 15, 28)
        window.navigationBarColor = Color.rgb(10, 15, 28)
        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) tts?.language = Locale.getDefault()
        }
        buildUi()
        restoreHistory()
        if (history.length() == 0) addMessage("Ash Jarvis", "Welcome. Set up your OpenRouter API key and model to start real AI chat.")
        updateStatus()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(20, 18, 20, 14)
            setBackgroundColor(Color.rgb(10, 15, 28))
        }
        val titleRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val title = TextView(this).apply {
            text = "ASH JARVIS"
            textSize = 23f
            setTextColor(Color.rgb(121, 210, 255))
            gravity = Gravity.CENTER_VERTICAL
        }
        titleRow.addView(title, LinearLayout.LayoutParams(0, -2, 1f))
        titleRow.addView(Button(this).apply { text = "AI SETUP"; setOnClickListener { showAiSetup() } })
        titleRow.addView(Button(this).apply { text = "DOLPHIN"; setOnClickListener { confirmDolphinDownload() } })
        titleRow.addView(Button(this).apply { text = "PHONE"; setOnClickListener { showPhoneTools() } })
        val subtitle = TextView(this).apply {
            text = "UNIVERSAL ANDROID AI  •  PRIVATE LOCAL CHAT HISTORY"
            textSize = 10f
            setTextColor(Color.rgb(153, 166, 190))
            setPadding(0, 4, 0, 14)
        }
        scroll = ScrollView(this)
        messages = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(messages)
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        input = EditText(this).apply {
            hint = "Message Ash..."
            setHintTextColor(Color.GRAY)
            setTextColor(Color.WHITE)
            textSize = 15f
            setSingleLine(false)
            maxLines = 4
            setPadding(12, 10, 12, 10)
            backgroundTintList = android.content.res.ColorStateList.valueOf(Color.rgb(65, 140, 190))
        }
        row.addView(input, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(Button(this).apply { text = "🎙"; contentDescription = "Speak to Ash"; setOnClickListener { startVoiceInput() } })
        row.addView(Button(this).apply { text = "SEND"; setOnClickListener { sendMessage() } })
        footer = TextView(this).apply {
            textSize = 11f
            setTextColor(Color.rgb(255, 195, 105))
            setPadding(0, 12, 0, 0)
        }
        root.addView(titleRow)
        root.addView(subtitle)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(row)
        root.addView(footer)
        setContentView(root)
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

    private fun showPhoneTools() {
        val options = arrayOf("Enable screen reading / tapping", "Read last captured screen aloud", "Tap a visible item by its text", "Type a reply into focused field")
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
                            .setMessage("First switch to the target app and focus its message box. Then return to Ash and use this tool. This inserts text only; it does not send the message.")
                            .setView(field).setNegativeButton("CANCEL", null)
                            .setPositiveButton("INSERT") { _, _ ->
                                val value = field.text.toString()
                                if (value.isNotBlank()) sendBroadcast(Intent(AshAccessibilityService.ACTION_TYPE_TEXT).setPackage(packageName).putExtra(AshAccessibilityService.EXTRA_TEXT, value))
                            }.show()
                    }
                }
            }.show()
    }

    private fun updateStatus() {
        footer.text = if (getApiKey().isNullOrBlank()) {
            "AI engine: not configured • Tap AI SETUP"
        } else {
            "OpenRouter: configured • Model: " + (prefs.getString("model", "") ?: "")
        }
    }

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        super.onDestroy()
    }

    private fun confirmDolphinDownload() {
        AlertDialog.Builder(this)
            .setTitle("Download Dolphin 2.9 • Llama 3 8B")
            .setMessage("This offline model file (Q4_K_M) is about 4.9 GB. It will be saved to Downloads/AshJarvis on your phone. This can use several GB of mobile data and storage. The app still needs its local inference engine integrated before this file can answer chats. Wi-Fi and at least 7 GB free space are strongly recommended. Continue?")
            .setNegativeButton("NOT NOW", null)
            .setPositiveButton("DOWNLOAD") { _, _ -> startDolphinDownload() }
            .show()
    }

    private fun startDolphinDownload() {
        try {
            val fileName = "dolphin-2.9-llama3-8b-Q4_K_M.gguf"
            val manager = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
            val request = DownloadManager.Request(
                Uri.parse("https://huggingface.co/bartowski/dolphin-2.9-llama3-8b-GGUF/resolve/main/dolphin-2.9-llama3-8b-Q4_K_M.gguf?download=true")
            )
                .setTitle("Ash Jarvis • Dolphin 2.9")
                .setDescription("Downloading offline model (~4.9 GB) to Downloads/AshJarvis")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverMetered(false)
                .setAllowedOverRoaming(false)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "AshJarvis/" + fileName)
            val id = manager.enqueue(request)
            prefs.edit().putLong("dolphin_download_id", id).apply()
            Toast.makeText(this, "Dolphin download queued. Wi-Fi is required; check the download notification.", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Could not start download: " + (e.message ?: "unknown error"), Toast.LENGTH_LONG).show()
        }
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
        fun action(action: String, extra: String? = null): Boolean {
            val intent = Intent(action).setPackage(packageName)
            if (extra != null) intent.putExtra(AshAccessibilityService.EXTRA_TEXT, extra)
            sendBroadcast(intent)
            Toast.makeText(this, "Ash: $command", Toast.LENGTH_SHORT).show()
            return true
        }
        if (lower in listOf("scroll down", "scroll down please", "go down", "page down")) return action(AshAccessibilityService.ACTION_SCROLL_DOWN)
        if (lower in listOf("scroll up", "scroll up please", "go up", "page up")) return action(AshAccessibilityService.ACTION_SCROLL_UP)
        if (lower in listOf("swipe left", "move left")) return action(AshAccessibilityService.ACTION_SWIPE_LEFT)
        if (lower in listOf("swipe right", "move right")) return action(AshAccessibilityService.ACTION_SWIPE_RIGHT)
        if (lower in listOf("go back", "back", "press back")) return action(AshAccessibilityService.ACTION_BACK)
        if (lower in listOf("go home", "home screen", "press home")) return action(AshAccessibilityService.ACTION_HOME)
        if (lower in listOf("what is on my screen", "read my screen", "read screen", "describe my screen")) {
            val screen = prefs.getString(AshAccessibilityService.KEY_SCREEN, null)
            if (screen.isNullOrBlank()) addMessage("Ash Jarvis", "I can't see screen text yet. Enable Ash Screen Control in Android Accessibility settings, then try again.")
            else {
                addMessage("Ash Jarvis", screen.take(5000))
                tts?.speak(screen.take(3000), TextToSpeech.QUEUE_FLUSH, null, "ash-screen-command")
            }
            return true
        }
        if (lower.startsWith("tap ")) {
            val target = command.substringAfter(" ", "").trim()
            if (target.isNotBlank()) return action(AshAccessibilityService.ACTION_TAP_TEXT, target)
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
        if (getApiKey().isNullOrBlank() || (prefs.getString("model", "") ?: "").isBlank()) {
            showAiSetup()
            return
        }
        input.setText("")
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(input.windowToken, 0)
        footer.text = "Ash is thinking…"
        addMessage("You", text)
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
        recent.put(JSONObject().put("role", "system").put("content", "You are Ash Jarvis, a helpful general-purpose AI assistant. Be honest, clear, and safety-conscious."))
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
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(14, 10, 14, 10)
            setBackgroundColor(if (sender == "You") Color.rgb(28, 48, 72) else Color.rgb(23, 31, 49))
        }
        val label = TextView(this).apply {
            this.text = sender.uppercase()
            textSize = 10f
            setTextColor(if (sender == "You") Color.rgb(121, 210, 255) else Color.rgb(129, 230, 177))
        }
        val body = TextView(this).apply { this.text = text; textSize = 14f; setTextColor(Color.WHITE); setPadding(0, 5, 0, 0) }
        card.addView(label); card.addView(body)
        messages.addView(card, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 10 })
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
