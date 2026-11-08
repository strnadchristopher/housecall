package com.littleobelisk.chriscord

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Disposable emulator/application only: these tests clear this app's native push state. */
@RunWith(AndroidJUnit4::class)
class PushStoreTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @After fun cleanup() { PushRuntime.clear(context) }
    @Test fun keystoreStorageSurvivesReloadWithoutPlaintextAndKeepsTombstone() {
        PushRuntime.clear(context)
        val secret = "fixture-session-secret-not-a-real-token"
        val state = JSONObject().put("generation", "old").put("token", secret)
            .put("ledger", JSONObject().put("message", JSONObject().put("epoch", 1)))
        PushStore.write(context, state)
        val bytes = File(context.noBackupFilesDir, "push-v1.enc").readBytes()
        assertFalse(String(bytes, Charsets.ISO_8859_1).contains(secret))
        val restored = PushStore.read(context)!!
        assertEquals(secret, restored.getString("token"))
        assertEquals(1, restored.getJSONObject("ledger").getJSONObject("message").getInt("epoch"))
    }
    @Test fun logoutAndAccountReplacementRejectLateWorkerWrites() {
        PushRuntime.clear(context)
        PushStore.write(context, JSONObject().put("generation", "old").put("ledger", JSONObject()))
        PushRuntime.clear(context)
        assertNull(PushStore.read(context))
        assertFalse(PushStore.update(context, "old") { fail("Late write after logout") })
        PushStore.write(context, JSONObject().put("generation", "new").put("ledger", JSONObject()))
        assertFalse(PushStore.update(context, "old") { fail("Late write across accounts") })
        assertEquals("new", PushStore.read(context)!!.getString("generation"))
    }
}
