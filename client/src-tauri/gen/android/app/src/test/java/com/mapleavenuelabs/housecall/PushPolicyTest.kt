package com.mapleavenuelabs.housecall

import org.junit.Assert.*
import org.junit.Test

class PushPolicyTest {
    @Test fun tombstoneWinsOverLateAlertAndRestartedState() {
        assertEquals(PushPolicy.Action.REMOVE, PushPolicy.action(0, 1, false, true))
        assertEquals(PushPolicy.Action.REMOVE, PushPolicy.action(1, 0, true, true))
    }
    @Test fun unauthenticatedOrAbsentStateNeverDisplays() {
        assertEquals(PushPolicy.Action.SUPPRESS, PushPolicy.action(0, null, false, false))
        assertEquals(PushPolicy.Action.SUPPRESS, PushPolicy.action(2, null, false, true))
    }
    @Test fun replayNeverRedisplaysDismissedNotification() {
        assertEquals(PushPolicy.Action.SUPPRESS, PushPolicy.action(0, 0, true, true))
        assertEquals(PushPolicy.Action.SHOW, PushPolicy.action(0, null, false, true))
    }
    @Test fun mixedDeliveryAlwaysRetractsFirst() {
        val events = listOf(PushPolicy.Event("a", "m", "c", 0), PushPolicy.Event("b", "m", "c", 1))
        assertEquals(listOf(1, 0), PushPolicy.ordered(events).map { it.epoch })
    }
}
