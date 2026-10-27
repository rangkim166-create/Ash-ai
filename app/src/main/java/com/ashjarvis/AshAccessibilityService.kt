package com.ashjarvis

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

class AshAccessibilityService : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Keep a lightweight snapshot of visible text for the user-requested screen reader.
        saveVisibleScreen()
    }

    override fun onInterrupt() {}

    override fun onServiceConnected() {
        super.onServiceConnected()
        saveVisibleScreen()
    }

    private fun saveVisibleScreen() {
        val root = rootInActiveWindow ?: return
        val lines = mutableListOf<String>()
        fun walk(node: AccessibilityNodeInfo?, depth: Int) {
            if (node == null || depth > 30 || lines.size >= 180) return
            val text = node.text?.toString()?.trim().orEmpty()
            val desc = node.contentDescription?.toString()?.trim().orEmpty()
            val label = if (text.isNotBlank()) text else desc
            if (label.isNotBlank() && label !in lines) lines.add(label.take(240))
            for (i in 0 until node.childCount) walk(node.getChild(i), depth + 1)
        }
        walk(root, 0)
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(KEY_SCREEN, lines.joinToString("\n").take(12000))
            .putLong(KEY_SCREEN_TIME, System.currentTimeMillis())
            .apply()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TAP_TEXT -> {
                val target = intent.getStringExtra(EXTRA_TEXT).orEmpty()
                if (target.isNotBlank()) findNode(rootInActiveWindow, target)?.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }
            ACTION_TYPE_TEXT -> {
                val value = intent.getStringExtra(EXTRA_TEXT).orEmpty()
                val root = rootInActiveWindow
                val focused = findFocusedEditable(root)
                if (focused != null) {
                    focused.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                    focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
                        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
                    })
                }
            }
        }
        saveVisibleScreen()
        return START_NOT_STICKY
    }

    private fun findNode(node: AccessibilityNodeInfo?, target: String): AccessibilityNodeInfo? {
        if (node == null) return null
        val text = node.text?.toString().orEmpty()
        val desc = node.contentDescription?.toString().orEmpty()
        if (text.contains(target, true) || desc.contains(target, true)) {
            if (node.isClickable) return node
            node.parent?.let { if (it.isClickable) return it }
        }
        for (i in 0 until node.childCount) {
            val found = findNode(node.getChild(i), target)
            if (found != null) return found
        }
        return null
    }

    private fun findFocusedEditable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.isEditable && (node.isFocused || node.isFocusable)) return node
        for (i in 0 until node.childCount) {
            val found = findFocusedEditable(node.getChild(i))
            if (found != null) return found
        }
        return null
    }

    companion object {
        const val PREFS = "ash_jarvis"
        const val KEY_SCREEN = "visible_screen_text"
        const val KEY_SCREEN_TIME = "visible_screen_time"
        const val ACTION_TAP_TEXT = "com.ashjarvis.ACTION_TAP_TEXT"
        const val ACTION_TYPE_TEXT = "com.ashjarvis.ACTION_TYPE_TEXT"
        const val EXTRA_TEXT = "text"
    }
}