package labs.dkv.sandpane.services

import labs.dkv.sandpane.core.toRenderedEvent
import labs.dkv.sandpane.model.TaskEvent
import labs.dkv.sandpane.model.TaskStatus
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals

/** Review W1 (AGENTS.md rule 3): a late, older status event never rolls a task row back. */
class TaskViewFoldTest {

    private fun status(sequence: Long, to: String) = TaskEvent(
        taskId = "t",
        sequence = sequence,
        kind = "status.changed",
        payload = buildJsonObject { put("to", to) },
        timestamp = "2026-10-09T00:00:${sequence.toString().padStart(2, '0')}Z",
    )

    private fun delta(sequence: Long) = TaskEvent(
        taskId = "t",
        sequence = sequence,
        kind = "message.delta",
        payload = buildJsonObject { put("type", "message.delta"); put("text", "x") },
        timestamp = "2026-10-09T00:00:${sequence.toString().padStart(2, '0')}Z",
    )

    private fun foldAll(events: List<TaskEvent>, start: TaskMonitorService.TaskView = empty()) =
        events.fold(start) { view, e -> TaskMonitorService.fold(view, e, e.toRenderedEvent()) }

    private fun empty() = TaskMonitorService.TaskView("t", null, null, null, null, null, 0, null, emptyList())

    @Test
    fun holeFillingEventsDeliveredAfterNewerOnesDoNotRollStatusBack() {
        val afterGap = foldAll(listOf(status(1, "queued"), delta(2), delta(5), status(6, "awaiting_review")))
        assertEquals(TaskStatus.AWAITING_REVIEW, afterGap.status)

        // The resync fills 3 and 4 — older than 6 — and 4 says "running".
        val filled = foldAll(listOf(delta(3), status(4, "running")), afterGap)
        assertEquals(TaskStatus.AWAITING_REVIEW, filled.status, "an older status.changed must not win")
        assertEquals(6L, filled.lastSequence)
        assertEquals(afterGap.lastEventAt, filled.lastEventAt)
    }

    @Test
    fun inOrderEventsStillAdvanceTheRow() {
        val view = foldAll(listOf(status(1, "queued"), status(2, "running"), status(3, "awaiting_review")))
        assertEquals(TaskStatus.AWAITING_REVIEW, view.status)
        assertEquals(3L, view.lastSequence)
    }
}
