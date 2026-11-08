package com.littleobelisk.chriscord

import java.net.URI

/** Pure policy functions: no Android services, persistence, or secret logging. */
object NativeAuthPolicy {
    fun origin(value: String): String? = runCatching {
        val uri = URI(value)
        require(uri.scheme == "https" && uri.host != null && uri.rawAuthority == uri.host)
        require(uri.host.matches(Regex("[a-z0-9]+(?:[.-][a-z0-9]+)*")))
        require(uri.rawPath.isNullOrEmpty() && uri.rawQuery == null && uri.rawFragment == null)
        require(value == "https://${uri.host}")
        value
    }.getOrNull()

    fun authorized(
        configuredOrigin: String, requestOrigin: String, rpId: String,
        challenge: String, appOrigin: String, allowedOrigins: List<String>,
    ): Boolean {
        val safe = origin(configuredOrigin) ?: return false
        return requestOrigin == safe && rpId == URI(safe).host &&
            challenge.matches(Regex("[A-Za-z0-9_-]{16,1024}")) &&
            appOrigin.matches(Regex("android:apk-key-hash:[A-Za-z0-9_-]{43}")) &&
            allowedOrigins.size <= 8 && allowedOrigins.contains(appOrigin)
    }

    /** Only the build's HTTPS origin, exact root path, and fragment-held token. */
    fun inviteToken(value: String, configuredOrigin: String): String? {
        val safe = origin(configuredOrigin) ?: return null
        val prefix = "$safe/#invite="
        if (!value.startsWith(prefix)) return null
        return value.removePrefix(prefix).takeIf { it.matches(Regex("[a-f0-9]{64}")) }
    }
}
