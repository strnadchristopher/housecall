package com.mapleavenuelabs.housecall

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest

@TauriPlugin
class NativeAuthPlugin(private val activity: Activity) : Plugin(activity) {
    private val handler = Handler(Looper.getMainLooper())
    private data class Pending(val invoke: Invoke, val signal: CancellationSignal, val timeout: Runnable)
    // All request state is accessed on the Activity main thread.
    private var pending: Pending? = null

    private fun appOrigin(): String? = runCatching {
        if (Build.VERSION.SDK_INT < 28) return null
        val info = activity.packageManager.getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        val certificates = info.signingInfo?.apkContentsSigners ?: return null
        if (certificates.size != 1) return null
        val digest = MessageDigest.getInstance("SHA-256").digest(certificates[0].toByteArray())
        "android:apk-key-hash:" + Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }.getOrNull()

    @Command fun status(invoke: Invoke) {
        val origin = NativeAuthPolicy.origin(BuildConfig.AUTH_ORIGIN)
        val app = appOrigin()
        invoke.resolve(JSObject().put("platform", "android").put("supported", Build.VERSION.SDK_INT >= 28)
            .put("configured", origin != null && app != null).put("origin", origin ?: "")
            .put("rpId", origin?.let { URI(it).host } ?: "").put("appOrigin", app ?: "")
            .put("associationVerified", false))
    }

    @Command fun takeInvite(invoke: Invoke) {
        val invite = InviteLinkInbox.take()
        val result = JSObject()
        if (invite?.token != null) result.put("id", invite.id).put("invite", JSONObject().put("token", invite.token).put("server_origin", BuildConfig.AUTH_ORIGIN))
        else if (invite?.schemeUrl != null) result.put("id", invite.id).put("url", invite.schemeUrl)
        invoke.resolve(result)
    }
    @Command fun acknowledgeInvite(invoke: Invoke) {
        try {
            InviteLinkInbox.acknowledge(invoke.getArgs().getString("id"))
            invoke.resolve(JSObject().put("acknowledged", true))
        } catch (_: Exception) { invoke.reject("Invalid invitation receipt") }
    }

    @Command fun register(invoke: Invoke) = begin(invoke, true)
    @Command fun authenticate(invoke: Invoke) = begin(invoke, false)
    @Command fun cancel(invoke: Invoke) {
        activity.runOnUiThread {
            pending?.let { finish(it, null, "Passkey request cancelled") }
            invoke.resolve(JSObject().put("cancelled", true))
        }
    }

    private fun begin(invoke: Invoke, registration: Boolean) {
        activity.runOnUiThread {
            if (pending != null) { invoke.reject("Passkey request already active"); return@runOnUiThread }
            val app = appOrigin()
            if (Build.VERSION.SDK_INT < 28 || app == null || NativeAuthPolicy.origin(BuildConfig.AUTH_ORIGIN) == null) {
                invoke.reject("Native passkeys are not configured"); return@runOnUiThread
            }
            val requestJson: String
            try {
                val args = invoke.getArgs()
                requestJson = args.getString("requestJson")
                require(requestJson.length <= 65536)
                val options = JSONObject(requestJson)
                val allowed = args.getJSONArray("androidOrigins")
                require(allowed.length() <= 8)
                val allowedOrigins = (0 until allowed.length()).map { allowed.getString(it) }
                val rp = if (registration) options.getJSONObject("rp").getString("id") else options.getString("rpId")
                require(NativeAuthPolicy.authorized(BuildConfig.AUTH_ORIGIN, args.getString("origin"), rp,
                    options.getString("challenge"), app, allowedOrigins))
            } catch (_: Exception) {
                invoke.reject("Passkey server or application origin mismatch"); return@runOnUiThread
            }
            val signal = CancellationSignal()
            val timeout = Runnable { pending?.takeIf { it.invoke === invoke }?.let { finish(it, null, "Passkey request timed out") } }
            val request = Pending(invoke, signal, timeout)
            pending = request
            handler.postDelayed(timeout, 100_000L)
            try {
                val manager = CredentialManager.create(activity)
                val executor = ContextCompat.getMainExecutor(activity)
                if (registration) {
                    // No origin/clientDataHash override: the provider binds the installed APK certificate.
                    manager.createCredentialAsync(activity, CreatePublicKeyCredentialRequest(requestJson), signal, executor,
                        object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
                            override fun onResult(result: CreateCredentialResponse) {
                                val value = (result as? CreatePublicKeyCredentialResponse)?.registrationResponseJson
                                finish(request, value, if (value == null) "Credential provider unavailable or request rejected" else null)
                            }
                            override fun onError(e: CreateCredentialException) {
                                finish(request, null, if (e is CreateCredentialCancellationException) "Passkey request cancelled" else "Credential provider unavailable or request rejected")
                            }
                        })
                } else {
                    val options = GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson)))
                    manager.getCredentialAsync(activity, options, signal, executor,
                        object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                            override fun onResult(result: GetCredentialResponse) {
                                val value = (result.credential as? PublicKeyCredential)?.authenticationResponseJson
                                finish(request, value, if (value == null) "Credential provider unavailable or request rejected" else null)
                            }
                            override fun onError(e: GetCredentialException) {
                                finish(request, null, if (e is GetCredentialCancellationException) "Passkey request cancelled" else "Credential provider unavailable or request rejected")
                            }
                        })
                }
            } catch (_: Exception) { finish(request, null, "Credential provider unavailable or request rejected") }
        }
    }

    private fun finish(request: Pending, json: String?, error: String?) {
        if (pending !== request) return
        pending = null
        handler.removeCallbacks(request.timeout)
        request.signal.cancel()
        if (error != null || json == null || json.length > 131072) {
            request.invoke.reject(error ?: "Credential provider unavailable or request rejected")
        } else request.invoke.resolve(JSObject().put("credentialJson", json))
    }

    override fun onDestroy(activity: AppCompatActivity) {
        pending?.let { finish(it, null, "Passkey request cancelled") }
    }
}
