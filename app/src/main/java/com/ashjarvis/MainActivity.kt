package com.ashjarvis

import android.app.Activity
import android.os.Bundle
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.content.Context
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
    private val keyAlias = "ash_jarvis_ollama_key"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(10, 15, 28)
        window.navigationBarColor = Color.rgb(10, 15, 28)
        buildUi()
        restoreHistory()
        if (history.length() == 0) addMessage("Ash Jarvis", "Welcome. Set up your Ollama Cloud API and model to start real AI chat.")
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

    private fun updateStatus() {
        footer.text = if (getApiKey().isNullOrBlank()) {
            "AI engine: not configured • Tap AI SETUP"
        } else {
            "Ollama Cloud: configured • Model: " + (prefs.getString("model", "") ?: "")
        }
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
            hint = "Ollama model name (from model library)"
            setSingleLine(true)
            setText(prefs.getString("model", "") ?: "")
        }
        val keyInput = EditText(this).apply {
            hint = if (getApiKey().isNullOrBlank()) "Paste NEW Ollama API key" else "API key saved securely; enter replacement"
            inputType = 129
            setSingleLine(true)
        }
        panel.addView(modelInput)
        panel.addView(keyInput)
        AlertDialog.Builder(this)
            .setTitle("Connect Ollama Cloud")
            .setMessage("Get a model name from ollama.com/search. Your key is encrypted with Android Keystore on this device; it is not written into the source code.")
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

    private fun sendMessage() {
        val text = input.text.toString().trim()
        if (text.isEmpty()) return
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
                val answer = callOllama(text)
                runOnUiThread {
                    addMessage("Ash Jarvis", answer)
                    updateStatus()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    addMessage("Ash Jarvis", "I couldn't reach Ollama: " + (e.message ?: "connection error") + ". Check your internet, API key, model name and account access.")
                    updateStatus()
                }
            }
        }
    }

    private fun testConnection() {
        footer.text = "Testing Ollama connection…"
        thread {
            try {
                val answer = callOllama("Reply with exactly: Ash Jarvis connected")
                runOnUiThread {
                    addMessage("Ash Jarvis", answer)
                    updateStatus()
                    Toast.makeText(this, "Ollama responded successfully", Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                runOnUiThread {
                    footer.text = "Ollama test failed • Check model, key and internet"
                    addMessage("Ash Jarvis", "Connection test failed: " + (e.message ?: "unknown error") + ". Verify the model name in the Ollama model library and confirm your API key has access.")
                }
            }
        }
    }

    private fun callOllama(userText: String): String {
        val key = getApiKey() ?: throw IllegalStateException("API key missing")
        val model = prefs.getString("model", "")?.trim().orEmpty()
        if (model.isBlank()) throw IllegalStateException("model name missing")
        val connection = (URL("https://ollama.com/v1/chat/completions").openConnection() as HttpURLConnection)
        connection.requestMethod = "POST"
        connection.connectTimeout = 20000
        connection.readTimeout = 60000
        connection.setRequestProperty("Authorization", "Bearer $key")
        connection.setRequestProperty("Content-Type", "application/json")
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
        // The current user message is already in history; don't send it twice.
        val payload = JSONObject()
            .put("model", model)
            .put("messages", recent)
            .put("stream", false)
        try {
            OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { it.write(payload.toString()) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val responseText = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            if (code !in 200..299) {
                val detail = try { JSONObject(responseText).optString("error", responseText) } catch (_: Exception) { responseText }
                throw IllegalStateException("HTTP $code: " + detail.take(240))
            }
            val json = JSONObject(responseText)
            return json.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content")
                ?.takeIf { it.isNotBlank() } ?: throw IllegalStateException("Ollama returned no answer")
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
