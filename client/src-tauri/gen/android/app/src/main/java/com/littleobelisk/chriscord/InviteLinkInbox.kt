package com.littleobelisk.chriscord

import android.content.Intent
import android.os.SystemClock
import java.util.UUID

/** One bounded, short-lived pending invitation. No preferences, URLs, or logs. */
object InviteLinkInbox {
    private var token: String? = null
    private var id: String? = null
    private var receivedAt = 0L
    @Synchronized fun capture(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val raw = intent.dataString
        // Remove from the Activity's intent before Tauri/plugin dispatch and saved state.
        intent.data = null
        if (raw == null || raw.length > 2048) return
        val accepted = NativeAuthPolicy.inviteToken(raw, BuildConfig.AUTH_ORIGIN) ?: return
        token = accepted
        id = UUID.randomUUID().toString()
        receivedAt = SystemClock.elapsedRealtime()
    }
    @Synchronized fun take(): Pair<String, String>? {
        if (SystemClock.elapsedRealtime() - receivedAt > 120_000L) {
            token = null
            id = null
        }
        val value = token ?: return null
        return Pair(id ?: return null, value)
    }
    @Synchronized fun acknowledge(deliveredId: String) {
        if (id != deliveredId) return
        token = null
        id = null
        receivedAt = 0
    }
}
