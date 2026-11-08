package com.littleobelisk.chriscord

import org.junit.Assert.*
import org.junit.Test

class NativeAuthPolicyTest {
    private val origin = "https://chat.example.test"
    private val app = "android:apk-key-hash:" + "A".repeat(43)
    private val challenge = "C".repeat(43)

    @Test fun canonicalHttpsOriginOnly() {
        assertEquals(origin, NativeAuthPolicy.origin(origin))
        for (value in listOf("", "http://chat.example.test", "$origin/", "$origin:443", "$origin/path",
            "$origin?query=1", "$origin#fragment", "https://u@chat.example.test", "https://CHAT.example.test",
            "https://chat.example.test\\evil", "https://chat.example.test%00")) {
            assertNull(NativeAuthPolicy.origin(value))
        }
    }
    @Test fun appCertificateAndRpMustBothMatch() {
        assertTrue(NativeAuthPolicy.authorized(origin, origin, "chat.example.test", challenge, app, listOf(app)))
        assertFalse(NativeAuthPolicy.authorized(origin, origin, "evil.test", challenge, app, listOf(app)))
        assertFalse(NativeAuthPolicy.authorized(origin, "https://evil.test", "chat.example.test", challenge, app, listOf(app)))
        assertFalse(NativeAuthPolicy.authorized(origin, origin, "chat.example.test", challenge, app, emptyList()))
        assertFalse(NativeAuthPolicy.authorized(origin, origin, "chat.example.test", "not a challenge", app, listOf(app)))
        assertFalse(NativeAuthPolicy.authorized(origin, origin, "chat.example.test", challenge, app, List(9) { app }))
    }
    @Test fun invitationRejectsNormalizedPathsAndTokenInQuery() {
        val token = "b".repeat(64)
        assertEquals(token, NativeAuthPolicy.inviteToken("$origin/#invite=$token", origin))
        for (value in listOf("$origin/?invite=$token", "$origin/a/../#invite=$token",
            "$origin/#invite=$token&extra=yes", "$origin/#invite=$token%00", "$origin/#invite=${token.uppercase()}",
            "https://evil.test/#invite=$token", "chriscord://invite/#invite=$token", "$origin:443/#invite=$token")) {
            assertNull(NativeAuthPolicy.inviteToken(value, origin))
        }
    }
}
