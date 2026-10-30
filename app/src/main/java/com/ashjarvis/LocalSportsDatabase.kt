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

    /** Bulk insert in bounded transactions so large historical imports don't hold one huge transaction. */
    @Synchronized
    fun putBatch(type: String, records: List<Pair<String, JSONObject>>) {
        val db = writableDatabase
        records.chunked(500).forEach { batch ->
            db.beginTransaction()
            try {
                batch.forEach { (key, payload) ->
                    val values = android.content.ContentValues().apply {
                        put("record_key", "$type:$key")
                        put("record_type", type)
                        put("payload", payload.toString())
                        put("updated_at", java.time.Instant.now().toString())
                    }
                    db.insertWithOnConflict("sports_records", null, values, SQLiteDatabase.CONFLICT_REPLACE)
                }
                db.setTransactionSuccessful()
            } finally { db.endTransaction() }
        }
    }

    @Synchronized
    fun listPage(type: String, limit: Int = 500, offset: Int = 0): JSONArray {
        val out = JSONArray()
        readableDatabase.query("sports_records", arrayOf("payload"), "record_type=?",
            arrayOf(type), null, null, "updated_at DESC",
            "${limit.coerceIn(1, 5000)} OFFSET ${offset.coerceAtLeast(0)}").use { c ->
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


    /** Export every stored record for backup outside app-private storage. */
    @Synchronized
    fun exportAll(): JSONObject {
        val root = JSONObject().put("format", "ash-sports-backup-v1")
            .put("exported_at", java.time.Instant.now().toString())
        val records = JSONArray()
        readableDatabase.rawQuery(
            "SELECT record_type, record_key, payload, updated_at FROM sports_records ORDER BY record_type, record_key",
            null
        ).use { c ->
            while (c.moveToNext()) records.put(JSONObject()
                .put("type", c.getString(0))
                .put("key", c.getString(1).substringAfter(":"))
                .put("payload", JSONObject(c.getString(2)))
                .put("updated_at", c.getString(3)))
        }
        return root.put("records", records)
    }

    /** Merge a validated backup without deleting records already on this phone. */
    @Synchronized
    fun restoreAll(root: JSONObject): Int {
        require(root.optString("format") == "ash-sports-backup-v1") { "Unsupported Ash backup format" }
        val records = root.optJSONArray("records") ?: throw IllegalArgumentException("Backup contains no records")
        val grouped = linkedMapOf<String, MutableList<Pair<String, JSONObject>>>()
        for (i in 0 until records.length()) {
            val row = records.optJSONObject(i) ?: continue
            val type = row.optString("type")
            val key = row.optString("key")
            val payload = row.optJSONObject("payload")
            if (type.isBlank() || key.isBlank() || payload == null) continue
            grouped.getOrPut(type) { mutableListOf() }.add(key to payload)
        }
        grouped.forEach { (type, rows) -> putBatch(type, rows) }
        return grouped.values.sumOf { it.size }
    }

    companion object {
        @Volatile private var instance: LocalSportsDatabase? = null
        fun get(context: Context): LocalSportsDatabase =
            instance ?: synchronized(this) {
                instance ?: LocalSportsDatabase(context).also { instance = it }
            }
    }
}
