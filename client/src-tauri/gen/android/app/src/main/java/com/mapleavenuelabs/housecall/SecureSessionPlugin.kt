package com.mapleavenuelabs.housecall

import android.app.Activity
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
}
