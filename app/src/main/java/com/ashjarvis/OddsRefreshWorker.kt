package com.ashjarvis

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class OddsRefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            OddsEngine.syncFromBackend(applicationContext)
            val picks = OddsEngine.buildDailyPicks(applicationContext)
            TipResultsTracker.settleFinishedFromHistory(applicationContext)
            DailyPicksNotifier.notify(applicationContext, picks)
            Result.success()
        } catch (_: Exception) {
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }
}
