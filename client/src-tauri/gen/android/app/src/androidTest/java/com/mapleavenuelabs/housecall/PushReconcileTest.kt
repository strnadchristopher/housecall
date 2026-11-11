package com.mapleavenuelabs.housecall

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Disposable app only. Exercises real encrypted ledger changes with injected provider I/O. */
@RunWith(AndroidJUnit4::class)
class PushReconcileTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @After fun cleanup() { PushRuntime.clear(context) }
    private fun seed() {
        PushRuntime.clear(context)
        PushStore.write(context, JSONObject().put("generation", "fixture")
            .put("ledger", JSONObject().put("m1", JSONObject().put("epoch", 0).put("shown", true))
                .put("m2", JSONObject().put("epoch", 0).put("shown", true))))
    }
    private fun tombstones() = JSONObject().put("events", JSONArray(listOf("m1", "m2").map {
        JSONObject().put("id", "event_$it").put("message_id", it).put("channel_id", "general")
            .put("kind", "retract").put("epoch", 1).put("state", "accepted")
    }))
    private fun assertRemoved() {
        val ledger = PushStore.read(context)!!.getJSONObject("ledger")
        for (id in listOf("m1", "m2")) {
            assertEquals(1, ledger.getJSONObject(id).getInt("epoch"))
            assertFalse(ledger.getJSONObject(id).getBoolean("shown"))
        }
    }
    @Test fun tokenAndRegistrationOutagesDoNotBlockAuthenticatedRetractions() {
        for (tokenFails in listOf(true, false)) {
            seed()
            val paths = mutableListOf<String>()
            try {
                PushRuntime.reconcile(context, send = { _, path, _, _ ->
                    paths.add(path)
                    when (path) {
                        "/api/push/events" -> tombstones()
                        "/api/notifications" -> JSONObject().put("notifications", JSONArray())
                        else -> throw PushHttpError(503)
                    }
                }, acquireToken = { if (tokenFails) error("fixture token outage") else "fixture" })
                fail("Provider outage must remain retryable")
            } catch (_: Exception) { }
            assertEquals(listOf("/api/push/events", "/api/notifications"), paths.take(2))
            assertRemoved()
        }
    }
    @Test fun firstAckFailureDoesNotBlockLaterTombstones() {
        seed()
        try {
            PushRuntime.reconcile(context, send = { _, path, _, _ ->
                when (path) {
                    "/api/push/events" -> tombstones()
                    "/api/notifications" -> JSONObject().put("notifications", JSONArray())
                    "/api/push/device" -> JSONObject()
                    else -> { assertRemoved(); throw PushHttpError(503) }
                }
            }, acquireToken = { "fixture" })
            fail("Acknowledgment outage must remain retryable")
        } catch (_: PushHttpError) { }
        assertRemoved()
    }
    @Test fun revokedSessionClearsGrantWithoutCallingFirebase() {
        seed()
        PushRuntime.reconcile(context, send = { _, _, _, _ -> throw PushHttpError(401) },
            acquireToken = { fail("Revoked session must not require Firebase"); "unused" })
        assertNull(PushStore.read(context))
    }
    @Test fun unsendDuringTokenAcquisitionCannotAuthorizeAnOldAlert() {
        seed()
        var exists = true
        var authorityReads = 0
        PushRuntime.reconcile(context, send = { _, path, _, _ ->
            when (path) {
                "/api/push/events" -> JSONObject().put("events", JSONArray().put(JSONObject()
                    .put("id", "alert").put("message_id", "new_message").put("channel_id", "general")
                    .put("kind", "alert").put("epoch", 0).put("state", "accepted")))
                "/api/notifications" -> {
                    authorityReads++
                    JSONObject().put("notifications", JSONArray().apply {
                        if (exists) put(JSONObject().put("message_id", "new_message").put("channel_id", "general"))
                    })
                }
                else -> JSONObject()
            }
        }, acquireToken = { exists = false; "fixture" })
        assertEquals(2, authorityReads)
        assertFalse(PushStore.read(context)!!.getJSONObject("ledger").has("new_message"))
    }
}
