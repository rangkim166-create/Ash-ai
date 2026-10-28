package com.ashjarvis

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.widget.Toast
import java.util.Locale

/**
 * User-started, foreground speech listener. Android displays an ongoing notification
 * while the microphone is active. This is not a hardware hotword detector; availability
 * depends on the device speech-recognition provider and battery policy.
 */
class AshListeningService : Service() {
    private var recognizer: SpeechRecognizer? = null
    private var listening = false
    private var restarting = false

    override fun onCreate() {
        super.onCreate()
        createChannel()
        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification: Notification = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("Ash Jarvis is listening")
                .setContentText("Say “Hey Ash” followed by a phone command. Tap to open Ash.")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentIntent(openApp)
                .setOngoing(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle("Ash Jarvis is listening")
                .setContentText("Say “Hey Ash” followed by a phone command.")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentIntent(openApp)
                .setOngoing(true)
                .build()
        }
        startForeground(NOTIFICATION_ID, notification)
        if (SpeechRecognizer.isRecognitionAvailable(this)) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this).also { sr ->
                sr.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) { listening = true; restarting = false }
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() { listening = false }
                    override fun onError(error: Int) {
                        listening = false
                        if (error != SpeechRecognizer.ERROR_CLIENT && error != SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) scheduleRestart()
                        else if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) stopSelf()
                    }
                    override fun onResults(results: Bundle?) {
                        listening = false
                        val said = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                        handleSpeech(said)
                        scheduleRestart()
                    }
                    override fun onPartialResults(partialResults: Bundle?) {
                        val said = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                        if (said.isNotBlank()) handleSpeech(said, partial = true)
                    }
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })
            }
            startRecognition()
        } else {
            Toast.makeText(this, "No speech recognition service is available", Toast.LENGTH_LONG).show()
            stopSelf()
        }
    }

    private fun startRecognition() {
        if (listening || recognizer == null) return
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
        }
        try { restarting = false; recognizer?.startListening(intent) } catch (_: Exception) { scheduleRestart() }
    }

    private fun handleSpeech(raw: String, partial: Boolean = false) {
        val lower = raw.trim().lowercase(Locale.ROOT)
        val prefix = listOf("hey ash", "hi ash", "okay ash", "ok ash", "ash jarvis")
            .firstOrNull { lower.startsWith(it) } ?: return
        val command = raw.trim().drop(prefix.length).trim(' ', ',', '.', ':')
        if (command.isBlank() || (partial && command.length < 4)) return
        val intent = Intent(this, AshAccessibilityService::class.java).setAction(AshAccessibilityService.ACTION_WAKE_COMMAND)
            .putExtra(AshAccessibilityService.EXTRA_TEXT, command)
        // The accessibility service itself receives commands through its private receiver.
        sendBroadcast(Intent(AshAccessibilityService.ACTION_WAKE_COMMAND).setPackage(packageName).putExtra(AshAccessibilityService.EXTRA_TEXT, command))
    }

    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private val restartRunnable = Runnable { startRecognition() }
    private fun scheduleRestart() {
        if (restarting) return
        restarting = true
        handler.removeCallbacks(restartRunnable)
        handler.postDelayed(restartRunnable, 450)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Ash voice assistant", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Visible status while Ash voice listening is enabled"
            })
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        try { recognizer?.cancel(); recognizer?.destroy() } catch (_: Exception) {}
        recognizer = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val CHANNEL_ID = "ash_voice_listening"
        const val NOTIFICATION_ID = 7102
        const val ACTION_START = "com.ashjarvis.START_LISTENING"
        const val ACTION_STOP = "com.ashjarvis.STOP_LISTENING"
    }
}
