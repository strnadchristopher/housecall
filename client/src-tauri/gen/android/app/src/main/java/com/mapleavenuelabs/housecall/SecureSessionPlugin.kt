package com.mapleavenuelabs.housecall

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** Commands behind `tauri-plugin-secure-session` on Android. Errors are generic; no value is ever logged. */
@TauriPlugin
class SecureSessionPlugin(private val activity: Activity) : Plugin(activity) {
    @Command fun get(invoke: Invoke) {
        try {
            val session = SessionStore.get(activity, invoke.getArgs().getString("origin"))
            invoke.resolve(JSObject().apply { if (session != null) put("session", session) })
        } catch (_: Exception) { invoke.reject("secure storage unavailable") }
    }
    @Command fun set(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            SessionStore.set(activity, args.getString("origin"), args.getString("session"))
            invoke.resolve(JSObject().put("ok", true))
        } catch (_: Exception) { invoke.reject("secure storage unavailable") }
    }
    @Command fun remove(invoke: Invoke) {
        try {
            SessionStore.remove(activity, invoke.getArgs().getString("origin"))
            invoke.resolve(JSObject().put("ok", true))
        } catch (_: Exception) { invoke.reject("secure storage unavailable") }
    }
    @Command fun list(invoke: Invoke) {
        try {
            val origins = JSArray()
            SessionStore.list(activity).forEach { origins.put(it) }
            invoke.resolve(JSObject().put("origins", origins))
        } catch (_: Exception) { invoke.reject("secure storage unavailable") }
    }
    @Command fun recordGet(invoke: Invoke) {
        try {
            val value = IdentityRecordStore.get(activity, invoke.getArgs().getString("account"))
            invoke.resolve(JSObject().apply { if (value != null) put("value", value) })
        } catch (_: Exception) { invoke.reject("secure storage unavailable") }
    }
    @Command fun recordSet(invoke: Invoke) {
        try {
            val args = invoke.getArgs()
            IdentityRecordStore.set(activity, args.getString("account"), args.getString("value"))
            invoke.resolve(JSObject().put("ok", true))
        } catch (_: Exception) { invoke.reject("secure storage unavailable") }
    }
    @Command fun recordRemove(invoke: Invoke) {
        try {
            IdentityRecordStore.remove(activity, invoke.getArgs().getString("account"))
            invoke.resolve(JSObject().put("ok", true))
        } catch (_: Exception) { invoke.reject("secure storage unavailable") }
    }
    @Command fun sensitiveSurface(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                val enabled = invoke.getArgs().getBoolean("enabled")
                val main = activity as? MainActivity ?: throw IllegalStateException()
                main.sensitiveSurface = enabled
                activity.window.decorView.filterTouchesWhenObscured = enabled
                if (enabled) activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
                else activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
                invoke.resolve(JSObject().put("ok", true).put("captured", false))
            } catch (_: Exception) { invoke.reject("screen protection unavailable") }
        }
    }
    private var verifyingOwner = false
    @Command fun verifyOwner(invoke: Invoke) {
        activity.runOnUiThread {
            if (verifyingOwner) { invoke.reject("device verification already active"); return@runOnUiThread }
            val keyguard = activity.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            if (!keyguard.isDeviceSecure) {
                invoke.resolve(JSObject().put("supported", false).put("verified", false))
                return@runOnUiThread
            }
            val intent = keyguard.createConfirmDeviceCredentialIntent(invoke.getArgs().getString("reason"), "Verify with your device unlock")
            if (intent == null) { invoke.reject("device verification unavailable"); return@runOnUiThread }
            verifyingOwner = true
            try { startActivityForResult(invoke, intent, "ownerVerified") }
            catch (_: Exception) { verifyingOwner = false; invoke.reject("device verification unavailable") }
        }
    }
    @ActivityCallback
    private fun ownerVerified(invoke: Invoke, result: ActivityResult) {
        verifyingOwner = false
        invoke.resolve(JSObject().put("supported", true).put("verified", result.resultCode == Activity.RESULT_OK))
    }
}
