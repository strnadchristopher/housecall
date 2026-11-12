package com.mapleavenuelabs.housecall

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
            "https://evil.test/#invite=$token", "housecall://invite/#invite=$token", "$origin:443/#invite=$token")) {
            assertNull(NativeAuthPolicy.inviteToken(value, origin))
        }
    }
    @Test fun schemeInviteAcceptsOnlyTheExactShape() {
        val code = "hc1.aHR0cHM6Ly9jaGF0LmV4YW1wbGUudGVzdA." + "b".repeat(64)
        assertEquals("housecall://invite?code=$code", NativeAuthPolicy.schemeInvite("housecall://invite?code=$code"))
        for (value in listOf("housecall://invite?code=$code&x=1", "housecall://invite/?code=$code", "housecall://evil?code=$code",
            "housecall://invite?code=$code#x", "https://invite?code=$code", "housecall://invite?code=hc2.a." + "b".repeat(64),
            "housecall://invite?code=hc1.a." + "B".repeat(64))) {
            assertNull(NativeAuthPolicy.schemeInvite(value))
        }
    }
}
