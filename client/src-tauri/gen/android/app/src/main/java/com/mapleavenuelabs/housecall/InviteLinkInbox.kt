package com.mapleavenuelabs.housecall

import android.content.Intent
import android.os.SystemClock
import java.util.UUID

/** One delivered pending invitation: the build origin's https link, or a housecall:// link. */
data class PendingInvite(val id: String, val token: String?, val schemeUrl: String?)

/** One bounded, short-lived pending invitation. No preferences, URLs, or logs. */
object InviteLinkInbox {
    private var token: String? = null
    private var schemeUrl: String? = null
    private var id: String? = null
    private var receivedAt = 0L
    @Synchronized fun capture(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val raw = intent.dataString
        // Remove from the Activity's intent before Tauri/plugin dispatch and saved state.
        intent.data = null
        if (raw == null || raw.length > 2048) return
        val accepted = NativeAuthPolicy.inviteToken(raw, BuildConfig.AUTH_ORIGIN)
        val scheme = if (accepted == null) NativeAuthPolicy.schemeInvite(raw) else null
        if (accepted == null && scheme == null) return
        token = accepted
        schemeUrl = scheme
        id = UUID.randomUUID().toString()
        receivedAt = SystemClock.elapsedRealtime()
    }
    @Synchronized fun take(): PendingInvite? {
        if (SystemClock.elapsedRealtime() - receivedAt > 120_000L) {
            token = null
            schemeUrl = null
            id = null
        }
        val current = id ?: return null
        if (token == null && schemeUrl == null) return null
        return PendingInvite(current, token, schemeUrl)
    }
    @Synchronized fun acknowledge(deliveredId: String) {
        if (id != deliveredId) return
        token = null
        schemeUrl = null
        id = null
        receivedAt = 0
    }
}
