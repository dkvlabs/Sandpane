package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.MAX_SUBSCRIBE_CURSORS
import labs.dkv.sandpane.model.TaskEvent
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.CompletableFuture
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The scenario the protocol-v1 cursor map exists for: two tasks with UNEVEN event counts, and the
 * proof that a shared scalar loses events while per-task cursors do not.
 *
 * The numbers come from the recorded v1 gap (docs/compatibility.md): task-a has run to sequence 7,
 * task-b has only reached 3. A project-wide checkpoint taken from the loudest task is then applied
 * to BOTH tasks by a shared scalar — and task-b's events at 4, 5, 6 are `<= 7`, so Core filters
 * them out as already seen. They are never delivered, and nothing in the response says so.
 *
 * This test pins the CLIENT side of the fix: cursors are built per task from each [EventStream]'s
 * own checkpoint, and the request that leaves the plugin carries that map.
 */
class ReplayCursorSemanticsTest {

    private fun event(taskId: String, sequence: Long) = TaskEvent(
        taskId = taskId,
        sequence = sequence,
        kind = "message.delta",
        payload = buildJsonObject { },
        timestamp = "2026-10-09T00:00:00Z",
    )

    private fun events(taskId: String, range: LongRange): List<TaskEvent> = range.map { event(taskId, it) }

    /** Two streams at uneven checkpoints, exactly as a live project would look. */
    private fun unevenStreams(): Pair<EventStream, EventStream> {
        val loud = EventStream("task-a", capacity = 50)
        val quiet = EventStream("task-b", capacity = 50)
        loud.merge(events("task-a", 1L..7L))
        quiet.merge(events("task-b", 1L..3L))
        return loud to quiet
    }

    private fun checkpoints(loud: EventStream, quiet: EventStream): List<Pair<String, Long>> =
        listOf(loud.taskId to loud.lastSequence, quiet.taskId to quiet.lastSequence)

    @Test
    fun sharedScalarWouldSilentlySkipTheQuieterTask() {
        val (loud, quiet) = unevenStreams()
        assertEquals(7L, loud.lastSequence)
        assertEquals(3L, quiet.lastSequence)

        // What a single project-wide checkpoint means: one number applied to every task.
        val shared = maxOf(loud.lastSequence, quiet.lastSequence)
        val unseenInB = 4L..6L
        val skipped = unseenInB.filter { it <= shared }
        assertEquals(3, skipped.size, "the shared scalar must skip all three unseen task-b events")

        // With per-task cursors the same events are strictly above task-b's own cursor.
        val plan = ReplayCursors.plan(checkpoints(loud, quiet))
        val bCursor = plan.cursors.getValue("task-b")
        assertTrue(
            unseenInB.all { it > bCursor },
            "per-task cursors must ask for exactly the events the shared scalar dropped",
        )
    }

    @Test
    fun planUsesEachStreamsOwnCheckpointAndDropsZeroes() {
        val (loud, quiet) = unevenStreams()
        val fresh = EventStream("task-c", capacity = 50)
        // task-c has never replayed anything: sequence 0 means "no checkpoint", i.e. absent.

        val plan = ReplayCursors.plan(checkpoints(loud, quiet) + (fresh.taskId to fresh.lastSequence))
        assertEquals(mapOf("task-a" to 7L, "task-b" to 3L), plan.cursors)
        assertFalse(plan.cursors.containsKey("task-c"), "a zero checkpoint must stay absent, not become 0")
        assertEquals(0, plan.omitted)
        assertNull(plan.disclosure())
    }

    @Test
    fun aTaskMissingFromTheMapReplaysInFullWhichIsTheSafeDirection() {
        // Core's rule: `afterSequences[taskId]` defaults to 0 (full history) for tasks the map does
        // not name. That is extra traffic, never lost events — the right way to fail.
        val plan = ReplayCursors.plan(listOf("task-a" to 7L))
        assertEquals(1, plan.cursors.size)
        val request = ReplayCursors.request(projectId = "p1", sharedAfterSequence = 0, plan = plan)
        assertNotNull(request.afterSequences)
        assertEquals(7L, request.afterSequences?.get("task-a"))

        // task-b is not named → Core resumes it from 0 → its whole log arrives, duplicates included.
        val stream = EventStream("task-b", capacity = 50)
        assertEquals(3, stream.merge(events("task-b", 1L..3L)).size, "an uncheckpointed task must get its whole log")
        assertEquals(0, stream.merge(events("task-b", 1L..3L)).size, "redelivery is dropped, never re-rendered")
    }

    @Test
    fun requestShapeKeepsAbsenceAsAbsence() {
        val empty = ReplayCursors.plan(emptyList())
        assertTrue(empty.isEmpty)
        val legacy = ReplayCursors.request(projectId = "p1", sharedAfterSequence = 4, plan = empty)
        assertNull(legacy.afterSequences, "no checkpoints must mean the legacy shared-scalar request")
        assertEquals(4L, legacy.afterSequence)
        assertEquals("p1", legacy.projectId)
        assertNull(legacy.taskId)
    }

    @Test
    fun oversizedPlansAreBoundedAndSayWhatWasLeftOut() {
        val checkpoints = (1L..(MAX_SUBSCRIBE_CURSORS + 25L)).map { "task-$it" to it }
        val plan = ReplayCursors.plan(checkpoints)
        assertEquals(MAX_SUBSCRIBE_CURSORS, plan.cursors.size, "the map must never exceed Core's bound")
        assertEquals(25, plan.omitted)
        val disclosure = plan.disclosure()
        assertNotNull(disclosure)
        assertTrue(disclosure.contains("25"), disclosure)
        assertTrue(disclosure.contains("replay in full"), disclosure)
    }

    @Test
    fun minCursorIsExposedOnlyToExplainWhyTheMapIsUsed() {
        val plan = ReplayCursors.plan(listOf("task-a" to 7L, "task-b" to 3L))
        assertEquals(3L, ReplayCursors.minCursor(plan))
        // Using the min as a SHARED scalar would still be wrong (it re-delivers task-a's whole tail);
        // the value exists so a status line can explain the difference, never to pick a scalar.
        val request = ReplayCursors.request(projectId = "p1", sharedAfterSequence = 0, plan = plan)
        assertEquals(0L, request.afterSequence, "the scalar stays a fallback; the map carries the truth")
    }

    @Test
    fun theBuiltRequestCarriesBothCursorsOnTheWire() {
        val rpc = RecordingTransport()
        val commands = CoreCommands(rpc) { CoreJsonFixtures.capsWithAllMethods() }
        val (loud, quiet) = unevenStreams()
        val plan = ReplayCursors.plan(checkpoints(loud, quiet))

        commands.taskSubscribe(
            ReplayCursors.request(projectId = "atlas", sharedAfterSequence = 0, plan = plan),
        ).get()

        val payload = rpc.only().second
        assertEquals("atlas", payload["projectId"]!!.jsonPrimitive.content)
        assertFalse(payload.containsKey("taskId"), "a project-wide replay must not name one task")
        val cursors = payload["afterSequences"]!!.toString()
        assertTrue(cursors.contains("\"task-a\":7"), cursors)
        assertTrue(cursors.contains("\"task-b\":3"), cursors)
    }
}

/** Minimal recording transport, shared by the cursor tests without pulling in a socket. */
private class RecordingTransport : CoreRpc {
    val sent = ArrayList<Pair<String, kotlinx.serialization.json.JsonObject>>()
    var reply: String = "[]"

    override fun request(method: String, params: JsonElement): CompletableFuture<JsonElement> {
        sent += method to params.jsonObject
        return CompletableFuture.completedFuture(CoreJsonFixtures.json.parseToJsonElement(reply))
    }

    fun only(): Pair<String, kotlinx.serialization.json.JsonObject> {
        assertEquals(1, sent.size, "expected exactly one request on the wire")
        return sent.single()
    }
}

object CoreJsonFixtures {
    val json = labs.dkv.sandpane.model.CoreJson

    fun capsWithAllMethods(): CoreCapabilities = CoreCapabilities(
        protocolVersion = 1,
        coreVersion = "test",
        instanceId = "fixture",
        platform = "macos",
        methods = CoreMethods.ALL,
    )
}
