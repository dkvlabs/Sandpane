package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.TaskEvent
import kotlinx.serialization.json.buildJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Bug 6 (gap resync was a no-op) and bug 5's per-stream refusal flag, pinned on the pure stream.
 */
class EventStreamTest {

    private fun event(sequence: Long, taskId: String = "task-a") = TaskEvent(
        taskId = taskId,
        sequence = sequence,
        kind = "message.delta",
        payload = buildJsonObject { },
        timestamp = "2026-10-09T00:00:00Z",
    )

    private fun events(vararg sequences: Long) = sequences.map { event(it) }

    @Test
    fun holeIsRecordedAsMissingRange() {
        val stream = EventStream("task-a", capacity = 50)
        stream.merge(events(1, 2, 5))
        assertTrue(stream.gapDetected)
        assertEquals(listOf(3L..4L), stream.missingRanges())
        assertEquals(5L, stream.lastSequence)
    }

    @Test
    fun fullResyncDeliversExactlyTheMissingEventsAndNothingAlreadySeen() {
        val stream = EventStream("task-a", capacity = 50)
        stream.merge(events(1, 2, 5))
        val delivered = ArrayList<Long>()
        stream.addListener { batch -> batch.forEach { delivered += it.sequence } }

        val accepted = stream.merge(events(1, 2, 3, 4, 5))
        assertEquals(listOf(3L, 4L), accepted.map { it.sequence })
        assertEquals(listOf(3L, 4L), delivered, "listeners must not see 1, 2, 5 again")
        assertFalse(stream.gapDetected)
        assertEquals(listOf(1L, 2L, 3L, 4L, 5L), stream.snapshot().map { it.sequence }, "window stays ordered")
        assertEquals(0L, stream.markResynced())

        // A second identical resync is a pure duplicate.
        assertTrue(stream.merge(events(1, 2, 3, 4, 5)).isEmpty())
        assertEquals(listOf(3L, 4L), delivered)
    }

    @Test
    fun resyncAlsoAcceptsNewerEventsAfterTheHole() {
        val stream = EventStream("task-a", capacity = 50)
        stream.merge(events(1, 4))
        val accepted = stream.merge(events(1, 2, 3, 4, 5, 6))
        assertEquals(listOf(2L, 3L, 5L, 6L), accepted.map { it.sequence })
        assertEquals(6L, stream.lastSequence)
        assertTrue(stream.missingRanges().isEmpty())
    }

    @Test
    fun partialFillSplitsTheHole() {
        val stream = EventStream("task-a", capacity = 50)
        stream.merge(events(1, 6))
        stream.merge(events(3))
        assertEquals(listOf(2L..2L, 4L..5L), stream.missingRanges())
        assertTrue(stream.gapDetected)
    }

    @Test
    fun holesCoreCannotFillAreGivenUpAfterAFullResyncNotRequestedForever() {
        val stream = EventStream("task-a", capacity = 50)
        stream.merge(events(1, 2, 5))
        stream.merge(events(1, 2, 5)) // Core's full log genuinely lacks 3 and 4
        assertTrue(stream.gapDetected)
        assertEquals(2L, stream.markResynced())
        assertFalse(stream.gapDetected)
        assertTrue(stream.missingRanges().isEmpty())
    }

    @Test
    fun otherTasksEventsAreIgnored() {
        val stream = EventStream("task-a", capacity = 50)
        assertTrue(stream.merge(listOf(event(1, taskId = "task-b"))).isEmpty())
        assertEquals(0L, stream.lastSequence)
    }

    @Test
    fun replayRefusalIsPerStreamAndNotifiesListeners() {
        val stream = EventStream("task-a", capacity = 50)
        val seen = ArrayList<String?>()
        stream.addListener(object : EventStream.Listener {
            override fun onEvents(events: List<TaskEvent>) = Unit
            override fun onReplayRefusalChanged(message: String?) {
                seen += message
            }
        })
        assertNull(stream.replayRefusal)
        stream.markReplayRefused("too large")
        assertEquals("too large", stream.replayRefusal)
        assertTrue(stream.clearReplayRefusal())
        assertFalse(stream.clearReplayRefusal(), "clearing twice reports nothing new")
        assertEquals(listOf("too large", null), seen)
    }
}

/** Review suggestions 6 and 8. */
class EventStreamJoinAndEvictionTest {

    private fun event(sequence: Long) = TaskEvent(
        taskId = "t",
        sequence = sequence,
        kind = "message.delta",
        payload = buildJsonObject { },
        timestamp = "2026-10-09T00:00:00Z",
    )

    @Test
    fun aJoiningListenerFirstReceivesTheRetainedWindowThenOnlyNewEvents() {
        val stream = EventStream("t", capacity = 50)
        stream.merge((1L..3L).map(::event))
        val seen = ArrayList<Long>()
        stream.addListenerWithSnapshot { batch -> batch.forEach { seen += it.sequence } }
        assertEquals(listOf(1L, 2L, 3L), seen)
        stream.merge((1L..4L).map(::event))
        assertEquals(listOf(1L, 2L, 3L, 4L), seen, "no duplicate, no gap")
    }

    @Test
    fun aJoiningListenerLearnsOfAnOutstandingRefusal() {
        val stream = EventStream("t", capacity = 50)
        stream.markReplayRefused("too large")
        val refusals = ArrayList<String?>()
        stream.addListenerWithSnapshot(object : EventStream.Listener {
            override fun onEvents(events: List<TaskEvent>) = Unit
            override fun onReplayRefusalChanged(message: String?) {
                refusals += message
            }
        })
        assertEquals(listOf<String?>("too large"), refusals)
    }

    @Test
    fun aFilledHoleIsNeverTheEventEvictedToMakeRoom() {
        val stream = EventStream("t", capacity = 3)
        stream.merge(listOf(1L, 2L, 6L, 7L, 8L).map(::event)) // retains 6,7,8; hole 3..5
        assertEquals(listOf(6L, 7L, 8L), stream.snapshot().map { it.sequence })
        val accepted = stream.merge(listOf(event(3)))
        assertEquals(listOf(3L), accepted.map { it.sequence })
        val retained = stream.snapshot().map { it.sequence }
        assertTrue(3L in retained, "the just-filled event must survive its own insertion: $retained")
        assertEquals(3, retained.size)
        assertEquals(retained.sorted(), retained, "window stays in sequence order")
    }
}
