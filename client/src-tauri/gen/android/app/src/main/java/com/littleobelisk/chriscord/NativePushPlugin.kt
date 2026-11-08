package com.littleobelisk.chriscord

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import androidx.core.app.NotificationManagerCompat
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.ConcurrentHashMap

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class NativePushPlugin(private val activity: Activity) : Plugin(activity) {
    private val executor = Executors.newSingleThreadExecutor()
    private val revision = AtomicLong()
    private val permissionRevisions = ConcurrentHashMap<Long, Long>()

    @Command fun status(invoke: Invoke) {
        try {
            invoke.resolve(JSObject().put("supported", true).put("configured", PushRuntime.configured)
                .put("enabled", PushStore.read(activity) != null)
                .put("permissionGranted", NotificationManagerCompat.from(activity).areNotificationsEnabled()))
        } catch (_: Exception) { invoke.reject("Unable to read native push status") }
    }

    /** Only this explicit command requests permission. Login/resume never calls it implicitly. */
    @Command fun enable(invoke: Invoke) {
        try {
            permissionRevisions[invoke.id] = revision.incrementAndGet()
            val args = invoke.getArgs()
            PushRuntime.validateOrigin(args.getString("origin"))
            check(PushRuntime.configured)
            if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissionForAlias("notifications", invoke, "permissionResult")
            } else permissionResult(invoke)
        } catch (_: Exception) {
            permissionRevisions.remove(invoke.id)
            invoke.reject("Push configuration is unavailable or invalid")
        }
    }
    @PermissionCallback fun permissionResult(invoke: Invoke) {
        val requestedRevision = permissionRevisions.remove(invoke.id) ?: return invoke.reject("Push request expired")
        if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) {
            invoke.reject("Notification permission was not granted")
            return
        }
        executor.execute {
            try {
                val args = invoke.getArgs()
                synchronized(PushStore) {
                    check(revision.get() == requestedRevision)
                    PushRuntime.enable(activity, args.getString("origin"), args.getString("token"), args.getString("deviceKey"))
                }
                // Registration runs durably in WorkManager; enabled is not a delivery receipt.
                invoke.resolve(JSObject().put("enabled", true).put("registrationPending", true))
            } catch (_: Exception) { invoke.reject("Unable to enable background push") }
        }
    }
    @Command fun reconcile(invoke: Invoke) {
        executor.execute {
            PushRuntime.schedule(activity)
            invoke.resolve(JSObject().put("scheduled", PushStore.read(activity) != null))
        }
    }
    @Command fun clear(invoke: Invoke) {
        // Clear outside the executor queue so an earlier command cannot postpone revocation.
        try {
            val old = synchronized(PushStore) {
                revision.incrementAndGet()
                PushRuntime.clear(activity)
            }
            if (old != null) executor.execute {
                PushRuntime.unregister(old)
                if (FirebaseApp.getApps(activity).isNotEmpty()) {
                    runCatching { Tasks.await(FirebaseMessaging.getInstance().deleteToken(), 20, TimeUnit.SECONDS) }
                }
            }
            invoke.resolve(JSObject().put("cleared", true))
        } catch (_: Exception) { invoke.reject("Unable to clear native push state") }
    }
}
