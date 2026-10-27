package com.ashjarvis

import android.app.Activity
import android.os.Bundle
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.content.Context
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var messages: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var input: EditText
    private val prefs by lazy { getSharedPreferences("ash_jarvis", Context.MODE_PRIVATE) }
    private val history = JSONArray()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(10, 15, 28)
        window.navigationBarColor = Color.rgb(10, 15, 28)
        buildUi()
        restoreHistory()
        if (history.length() == 0) addMessage("Ash Jarvis", "I'm installed and ready. Connect an AI provider or integrate an on-device model to enable real AI responses.")
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(20, 18, 20, 14)
            setBackgroundColor(Color.rgb(10, 15, 28))
        }
        val title = TextView(this).apply {
            text = "ASH JARVIS"
            textSize = 23f
            setTextColor(Color.rgb(121, 210, 255))
            gravity = Gravity.CENTER_VERTICAL
        }
        val subtitle = TextView(this).apply {
            text = "NATIVE ANDROID ASSISTANT  •  LOCAL CHAT HISTORY"
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
        val send = Button(this).apply { text = "SEND"; setOnClickListener { sendMessage() } }
        row.addView(send)
        val footer = TextView(this).apply {
            text = "AI engine: not connected • Offline model: not installed"
            textSize = 11f
            setTextColor(Color.rgb(255, 195, 105))
            setPadding(0, 12, 0, 0)
        }
        root.addView(title)
        root.addView(subtitle)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(row)
        root.addView(footer)
        setContentView(root)
    }

    private fun sendMessage() {
        val text = input.text.toString().trim()
        if (text.isEmpty()) return
        addMessage("You", text)
        input.setText("")
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(input.windowToken, 0)
        addMessage("Ash Jarvis", "Your message is saved on this device. An AI provider is not configured yet, so I can't generate a model response. The next step is connecting an online API or adding a tested on-device inference runtime.")
        Toast.makeText(this, "Saved locally", Toast.LENGTH_SHORT).show()
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
        val lp = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 10 }
        messages.addView(card, lp)
        val item = JSONObject().put("sender", sender).put("text", text)
        history.put(item)
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
