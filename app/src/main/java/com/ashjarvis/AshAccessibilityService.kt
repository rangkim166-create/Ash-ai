package com.ashjarvis

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast

class AshAccessibilityService : AccessibilityService() {
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        saveVisibleScreen()
    }

    override fun onInterrupt() {}

    private val commandReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val target = intent?.getStringExtra(EXTRA_TEXT).orEmpty()
            when (intent?.action) {
                ACTION_TAP_TEXT -> if (target.isNotBlank()) {
                    val node = findNode(rootInActiveWindow, target)
                    val success = node?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
                    announce(if (success) "Tapped $target" else "Couldn't find a clickable item named $target")
                }
                ACTION_TYPE_TEXT -> {
                    val focused = findFocusedEditable(rootInActiveWindow)
                    if (focused != null) {
                        focused.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                        focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
                            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, target)
                        })
                    } else announce("No focused text field found")
                }
                ACTION_SCROLL_DOWN -> scrollWindow(forward = true)
                ACTION_SCROLL_UP -> scrollWindow(forward = false)
                ACTION_SWIPE_LEFT -> swipe(0.82f, 0.5f, 0.18f, 0.5f)
                ACTION_SWIPE_RIGHT -> swipe(0.18f, 0.5f, 0.82f, 0.5f)
                ACTION_BACK -> performGlobalAction(GLOBAL_ACTION_BACK)
                ACTION_HOME -> performGlobalAction(GLOBAL_ACTION_HOME)
                ACTION_OPEN_APP -> if (target.isNotBlank()) openApp(target)
            }
            saveVisibleScreen()
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        val filter = IntentFilter().apply {
            addAction(ACTION_TAP_TEXT)
            addAction(ACTION_TYPE_TEXT)
            addAction(ACTION_SCROLL_DOWN)
            addAction(ACTION_SCROLL_UP)
            addAction(ACTION_SWIPE_LEFT)
            addAction(ACTION_SWIPE_RIGHT)
            addAction(ACTION_BACK)
            addAction(ACTION_HOME)
            addAction(ACTION_OPEN_APP)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(commandReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else @Suppress("DEPRECATION") run { registerReceiver(commandReceiver, filter) }
        saveVisibleScreen()
        announce("Ash screen control is ready")
    }

    override fun onDestroy() {
        try { unregisterReceiver(commandReceiver) } catch (_: Exception) {}
        super.onDestroy()
    }

    private fun announce(message: String) {
        mainHandler.post { Toast.makeText(this, message, Toast.LENGTH_SHORT).show() }
    }

    private fun scrollWindow(forward: Boolean) {
        val root = rootInActiveWindow
        val node = findScrollable(root)
        val action = if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        val success = node?.performAction(action) == true
        if (!success) {
            val startY = if (forward) 0.78f else 0.28f
            val endY = if (forward) 0.28f else 0.78f
            swipe(0.5f, startY, 0.5f, endY)
        }
    }

    private fun swipe(startX: Float, startY: Float, endX: Float, endY: Float) {
        val dm = resources.displayMetrics
        val path = Path().apply {
            moveTo(dm.widthPixels * startX, dm.heightPixels * startY)
            lineTo(dm.widthPixels * endX, dm.heightPixels * endY)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 350))
            .build()
        val accepted = dispatchGesture(gesture, null, null)
        if (!accepted) announce("Swipe wasn't accepted. Check that Ash Screen Control is enabled.")
    }

    private fun openApp(requestedName: String) {
        val pm = packageManager
        val candidates = try {
            @Suppress("DEPRECATION")
            pm.getInstalledApplications(0)
        } catch (_: Exception) { emptyList() }
        val match = candidates.firstOrNull { app ->
            val label = pm.getApplicationLabel(app).toString()
            label.equals(requestedName, ignoreCase = true) ||
                label.contains(requestedName, ignoreCase = true)
        }
        val launch = match?.let { pm.getLaunchIntentForPackage(it.packageName) }
        if (launch == null) {
            announce("Couldn't find an app named $requestedName")
            return
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try { startActivity(launch) } catch (_: Exception) { announce("Couldn't open $requestedName") }
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

    private fun findNode(node: AccessibilityNodeInfo?, target: String): AccessibilityNodeInfo? {
        if (node == null) return null
        val text = node.text?.toString().orEmpty()
        val desc = node.contentDescription?.toString().orEmpty()
        if (text.contains(target, true) || desc.contains(target, true)) {
            if (node.isClickable) return node
            val parent = node.parent
            if (parent?.isClickable == true) return parent
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

    private fun findScrollable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.isScrollable) return node
        for (i in 0 until node.childCount) {
            val found = findScrollable(node.getChild(i))
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
        const val ACTION_SCROLL_DOWN = "com.ashjarvis.ACTION_SCROLL_DOWN"
        const val ACTION_SCROLL_UP = "com.ashjarvis.ACTION_SCROLL_UP"
        const val ACTION_SWIPE_LEFT = "com.ashjarvis.ACTION_SWIPE_LEFT"
        const val ACTION_SWIPE_RIGHT = "com.ashjarvis.ACTION_SWIPE_RIGHT"
        const val ACTION_BACK = "com.ashjarvis.ACTION_BACK"
        const val ACTION_HOME = "com.ashjarvis.ACTION_HOME"
        const val ACTION_OPEN_APP = "com.ashjarvis.ACTION_OPEN_APP"
        const val EXTRA_TEXT = "text"
    }
}
