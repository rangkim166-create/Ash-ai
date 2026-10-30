package com.ashjarvis

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

/**
 * On-device sports memory. All records remain in the app's private database;
 * no cloud account or remote database is required.
 */
class LocalSportsDatabase private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, "ash_sports_memory.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("""CREATE TABLE sports_records (
            record_key TEXT PRIMARY KEY,
            record_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )""")
        db.execSQL("CREATE INDEX idx_sports_records_type ON sports_records(record_type)")
        db.execSQL("CREATE INDEX idx_sports_records_updated ON sports_records(updated_at)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) { }

    @Synchronized
    fun put(type: String, key: String, payload: JSONObject) {
        val values = android.content.ContentValues().apply {
            put("record_key", "$type:$key")
            put("record_type", type)
            put("payload", payload.toString())
            put("updated_at", java.time.Instant.now().toString())
        }
        writableDatabase.insertWithOnConflict("sports_records", null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    @Synchronized
    fun get(type: String, key: String): JSONObject? {
        readableDatabase.query("sports_records", arrayOf("payload"), "record_key=?",
            arrayOf("$type:$key"), null, null, null).use { c ->
            return if (c.moveToFirst()) runCatching { JSONObject(c.getString(0)) }.getOrNull() else null
        }
    }

    @Synchronized
    fun list(type: String, limit: Int = 2000): JSONArray {
        val out = JSONArray()
        readableDatabase.query("sports_records", arrayOf("payload"), "record_type=?",
            arrayOf(type), null, null, "updated_at DESC", limit.coerceIn(1, 10000).toString()).use { c ->
            while (c.moveToNext()) runCatching { JSONObject(c.getString(0)) }.getOrNull()?.let(out::put)
        }
        return out
    }

    @Synchronized
    fun count(type: String): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM sports_records WHERE record_type=?", arrayOf(type)).use {
            return if (it.moveToFirst()) it.getInt(0) else 0
        }
    }

    @Synchronized
    fun clear(type: String) {
        writableDatabase.delete("sports_records", "record_type=?", arrayOf(type))
    }

    companion object {
        @Volatile private var instance: LocalSportsDatabase? = null
        fun get(context: Context): LocalSportsDatabase =
            instance ?: synchronized(this) {
                instance ?: LocalSportsDatabase(context).also { instance = it }
            }
    }
}
