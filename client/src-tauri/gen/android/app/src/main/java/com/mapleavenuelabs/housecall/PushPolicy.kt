package com.mapleavenuelabs.housecall

/** Pure ordering policy shared by native reconciliation and regression tests. */
internal object PushPolicy {
    data class Event(val id: String, val message: String, val channel: String, val epoch: Int, val pending: Boolean = true)
    enum class Action { REMOVE, SHOW, SUPPRESS }
    fun action(epoch: Int, previousEpoch: Int?, alreadyShown: Boolean, current: Boolean): Action = when {
        epoch == 1 || previousEpoch == 1 -> Action.REMOVE
        epoch != 0 || !current || alreadyShown -> Action.SUPPRESS
        else -> Action.SHOW
    }
    fun ordered(events: List<Event>) = events.sortedByDescending { it.epoch }
}
