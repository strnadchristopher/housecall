package com.littleobelisk.chriscord

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.*
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URI
import java.util.UUID
import java.util.concurrent.TimeUnit

class PushApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (PushStore.read(this) != null) {
            runCatching { PushRuntime.messaging(this) }
            PushRuntime.schedule(this)
        }
    }
}

class PushMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        // No payload is displayed, persisted, or trusted: even IDs come from authenticated state.
        PushRuntime.schedule(this)
    }
    override fun onNewToken(token: String) { PushRuntime.schedule(this) }
    override fun onDeletedMessages() { PushRuntime.schedule(this) }
}

class PushWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result = try {
        PushRuntime.reconcile(applicationContext)
        Result.success()
    } catch (_: Exception) {
        if (PushStore.read(applicationContext) == null || runAttemptCount >= 4) Result.failure()
        else Result.retry()
    }
}

internal class PushHttpError(val status: Int) : Exception("Push request rejected")

internal object PushRuntime {
    private const val WORK = "chriscord-native-push"
    private const val CHANNEL = "private-mentions"
    private const val PREFIX = "chriscord-push:"
    private const val MAX_LEDGER = 4096
    // Network reconciliation is serialized; logout does not acquire this lock.
    private val reconcileLock = Any()
    val configured: Boolean get() = listOf(BuildConfig.FIREBASE_APPLICATION_ID, BuildConfig.FIREBASE_API_KEY,
        BuildConfig.FIREBASE_PROJECT_ID, BuildConfig.FIREBASE_SENDER_ID).all { it.isNotBlank() }

    fun messaging(context: Context): FirebaseMessaging {
        check(configured) { "Firebase client configuration missing" }
        synchronized(this) {
            if (FirebaseApp.getApps(context).none { it.name == FirebaseApp.DEFAULT_APP_NAME }) {
                FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
                    .setApplicationId(BuildConfig.FIREBASE_APPLICATION_ID)
                    .setApiKey(BuildConfig.FIREBASE_API_KEY)
                    .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                    .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
            }
        }
        return FirebaseMessaging.getInstance()
    }

    fun validateOrigin(origin: String): String {
        val uri = URI(origin)
        require(uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null &&
            uri.rawQuery == null && uri.rawFragment == null && uri.rawPath in listOf("", "/"))
        return origin.removeSuffix("/")
    }

    fun enable(context: Context, origin: String, token: String, device: String) {
        val base = validateOrigin(origin)
        require(token.length in 32..4096 && device.length in 32..4096)
        require(token.all { it.code in 33..126 } && device.all { it.code in 33..126 })
        check(configured)
        // Same session retains its tombstones and deduplication ledger.
        synchronized(PushStore) {
            val old = PushStore.read(context)
            if (old == null || old.optString("origin") != base || old.optString("token") != token ||
                old.optString("device") != device) {
                check(old == null) { "Clear previous push session first" }
                PushStore.write(context, JSONObject().put("origin", base).put("token", token)
                    .put("device", device).put("generation", UUID.randomUUID().toString())
                    .put("ledger", JSONObject()))
            }
            messaging(context).isAutoInitEnabled = true
        }
        schedule(context)
        val periodic = PeriodicWorkRequestBuilder<PushWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK + "-periodic", ExistingPeriodicWorkPolicy.KEEP, periodic)
    }

    fun schedule(context: Context) {
        if (PushStore.read(context) == null) return
        val work = OneTimeWorkRequestBuilder<PushWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS).build()
        // A hint arriving during a running reconcile gets a subsequent durable pass.
        WorkManager.getInstance(context).enqueueUniqueWork(WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, work)
    }

    fun cancelAll(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.tag?.startsWith(PREFIX) == true }
            .forEach { manager.cancel(it.tag, it.id) }
    }

    /** Erase locally before any network work. In-flight responses cannot restore this generation. */
    fun clear(context: Context): JSONObject? = synchronized(PushStore) {
        val old = PushStore.read(context)
        PushStore.clear(context)
        cancelAll(context)
        WorkManager.getInstance(context).cancelUniqueWork(WORK)
        WorkManager.getInstance(context).cancelUniqueWork(WORK + "-periodic")
        if (configured && FirebaseApp.getApps(context).isNotEmpty()) {
            FirebaseMessaging.getInstance().isAutoInitEnabled = false
            // Token deletion is not required for local security; backend unregister uses old session.
        }
        old
    }

    fun unregister(old: JSONObject?) {
        if (old != null) runCatching { request(old, "/api/push/device", "DELETE") }
    }

    private fun request(state: JSONObject, path: String, method: String = "GET", body: JSONObject? = null): JSONObject {
        require(path.startsWith("/api/") && !path.contains(".."))
        val connection = URI(state.getString("origin") + path).toURL().openConnection(Proxy.NO_PROXY) as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 8000
            connection.readTimeout = 8000
            connection.requestMethod = method
            connection.setRequestProperty("Authorization", "Bearer " + state.getString("token"))
            connection.setRequestProperty("X-Device-Key", state.getString("device"))
            connection.setRequestProperty("Accept", "application/json")
            connection.useCaches = false
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            if (status !in 200..299) throw PushHttpError(status)
            val bytes = connection.inputStream.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                val deadline = SystemClock.elapsedRealtime() + 15_000
                while (true) {
                    check(SystemClock.elapsedRealtime() < deadline)
                    val n = input.read(buffer)
                    if (n < 0) break
                    require(output.size() + n <= 1_048_576)
                    output.write(buffer, 0, n)
                }
                output.toByteArray()
            }
            return if (bytes.isEmpty()) JSONObject() else JSONObject(String(bytes, Charsets.UTF_8))
        } finally { connection.disconnect() }
    }

    // Injectable transport/token boundaries allow device tests to exercise provider outages
    // with the real Keystore ledger and reconciliation code, without live FCM credentials.
    fun reconcile(context: Context,
        send: (JSONObject, String, String, JSONObject?) -> JSONObject = ::request,
        acquireToken: () -> String = { Tasks.await(messaging(context).token, 20, TimeUnit.SECONDS) }
    ) = synchronized(reconcileLock) {
        val session = PushStore.read(context) ?: return@synchronized
        val generation = session.getString("generation")
        val deadline = SystemClock.elapsedRealtime() + 45_000
        var progressed = false
        fun current() = PushStore.read(context)?.optString("generation") == generation
        fun exhausted(): Boolean {
            if (SystemClock.elapsedRealtime() < deadline) return false
            if (current()) schedule(context)
            return true
        }
        fun authority(): Set<Pair<String, String>> {
            val notifications = send(session, "/api/notifications", "GET", null).getJSONArray("notifications")
            require(notifications.length() <= 500)
            return (0 until notifications.length()).map { i ->
                val row = notifications.getJSONObject(i)
                row.getString("message_id") to row.getString("channel_id")
            }.toSet()
        }
        fun reconcileInventory(authoritative: Set<Pair<String, String>>): Boolean = PushStore.update(context, generation) { state ->
            val ledger = state.getJSONObject("ledger")
            context.getSystemService(NotificationManager::class.java).activeNotifications
                .filter { it.tag?.startsWith(PREFIX) == true }.forEach { notification ->
                    val message = notification.tag.removePrefix(PREFIX)
                    val row = ledger.optJSONObject(message)
                    if (row == null || (message to row.optString("channel")) !in authoritative || row.optInt("epoch") == 1) {
                        context.getSystemService(NotificationManager::class.java).cancel(notification.tag, notification.id)
                    }
                }
        }
        try {
            val response = send(session, "/api/push/events", "GET", null)
            val raw = response.getJSONArray("events")
            require(raw.length() <= 100)
            val events = (0 until raw.length()).map { index ->
                val item = raw.getJSONObject(index)
                val kind = item.getString("kind")
                val epoch = item.getInt("epoch")
                require((kind == "retract" && epoch == 1) || (kind == "alert" && epoch == 0))
                PushPolicy.Event(safeId(item.getString("id")), safeId(item.getString("message_id")),
                    safeId(item.getString("channel_id")), epoch, item.getString("state") != "acknowledged")
            }
            val acknowledgments = mutableListOf<PushPolicy.Event>()
            // Apply all authenticated tombstones before any registration or acknowledgment I/O.
            // A provider or acknowledgment outage must not block known local removals.
            for (event in PushPolicy.ordered(events).filter { it.epoch == 1 }) {
                if (exhausted()) return@synchronized
                when (apply(context, generation, event, false)) {
                    Applied.STALE -> return@synchronized
                    Applied.DONE -> if (event.pending) acknowledgments.add(event)
                    Applied.DEFERRED -> Unit
                }
            }
            // This endpoint joins current membership; its message FK cascades on unsend.
            // Always reconcile OS inventory; missing/truncated history suppresses uncertain alerts.
            if (!reconcileInventory(authority())) return@synchronized
            // Registration authorizes fresh alerts, never cleanup. Firebase failures and a
            // disabled provider still leave authenticated tombstones/inventory reconciled.
            if (exhausted()) return@synchronized
            val token = acquireToken()
            if (!current()) return@synchronized
            send(session, "/api/push/device", "PUT", JSONObject().put("provider", "fcm").put("token", token))
            if (!current()) { unregister(session); return@synchronized }
            // Token acquisition can wait twenty seconds. Never authorize fresh alerts from
            // the pre-registration snapshot: unsend/membership may have changed meanwhile.
            val authoritative = authority()
            if (!reconcileInventory(authoritative)) return@synchronized
            for (event in PushPolicy.ordered(events).filter { it.epoch == 0 && it.pending }) {
                if (exhausted()) return@synchronized
                when (apply(context, generation, event, (event.message to event.channel) in authoritative)) {
                    Applied.STALE -> return@synchronized
                    Applied.DONE -> acknowledgments.add(event)
                    Applied.DEFERRED -> Unit
                }
            }
            for (event in acknowledgments) {
                if (exhausted() || !current()) return@synchronized
                try { send(session, "/api/push/events/${event.id}/ack", "POST", JSONObject()) }
                catch (error: PushHttpError) { if (error.status != 404) throw error }
                progressed = true
            }
            if (progressed && response.optBoolean("history_truncated") && current()) schedule(context)
        } catch (error: PushHttpError) {
            if (error.status == 401 || error.status == 403) {
                synchronized(PushStore) { if (current()) clear(context) }
            } else throw error
        }
    }

    private fun safeId(value: String): String {
        require(value.length in 1..128 && value.all { it.isLetterOrDigit() || it in "_-" })
        return value
    }
    private enum class Applied { STALE, DONE, DEFERRED }
    private fun apply(context: Context, generation: String, event: PushPolicy.Event, exists: Boolean): Applied {
        var applied = Applied.DONE
        val current = PushStore.update(context, generation) { state ->
            val ledger = state.getJSONObject("ledger")
            val row = ledger.optJSONObject(event.message)
            val action = PushPolicy.action(event.epoch, row?.optInt("epoch"), row?.optBoolean("shown") == true, exists)
            val manager = context.getSystemService(NotificationManager::class.java)
            when (action) {
                PushPolicy.Action.REMOVE -> {
                    // Persist tombstone before cancel/ack; a crash cannot allow an older alert.
                    if (row == null && ledger.length() >= MAX_LEDGER) {
                        state.put("suppressAlerts", true)
                    } else ledger.put(event.message, JSONObject().put("epoch", 1).put("shown", false).put("channel", event.channel))
                    PushStore.write(context, state)
                    manager.cancel(PREFIX + event.message, 0)
                }
                PushPolicy.Action.SHOW -> {
                    if (state.optBoolean("suppressAlerts") || ledger.length() >= MAX_LEDGER ||
                        !NotificationManagerCompat.from(context).areNotificationsEnabled()) {
                        applied = Applied.DEFERRED
                        return@update
                    }
                    if (Build.VERSION.SDK_INT >= 26) {
                        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Private mentions", NotificationManager.IMPORTANCE_DEFAULT))
                        if (manager.getNotificationChannel(CHANNEL).importance == NotificationManager.IMPORTANCE_NONE) {
                            applied = Applied.DEFERRED
                            return@update
                        }
                    }
                    // Mark first: process death between persistence and notify may suppress, never replay.
                    ledger.put(event.message, JSONObject().put("epoch", 0).put("shown", true).put("channel", event.channel))
                    PushStore.write(context, state)
                    val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    val open = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    val notification = NotificationCompat.Builder(context, CHANNEL)
                        .setSmallIcon(android.R.drawable.ic_dialog_email).setContentTitle("Chriscord")
                        .setContentText("You have a new mention").setContentIntent(open).setAutoCancel(true)
                        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setOnlyAlertOnce(true).build()
                    manager.notify(PREFIX + event.message, 0, notification)
                }
                PushPolicy.Action.SUPPRESS -> {
                    if (!exists) manager.cancel(PREFIX + event.message, 0)
                }
            }
        }
        return if (current) applied else Applied.STALE
    }
}
