package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.AgentEvent
import labs.dkv.sandpane.model.AgentEventCodec
import labs.dkv.sandpane.model.CoreEventKinds
import labs.dkv.sandpane.model.TaskEvent
import java.util.concurrent.CopyOnWriteArrayList

/**
 * One task's replayable event window: a checkpoint, a bounded view model, and fan-out.
 *
 * `task_events` is append-only with a per-task strictly increasing `sequence`
 * (docs/specs/02 §3). Reconnection is therefore a `task.subscribe(taskId, afterSequence)`
 * replay from [lastSequence] and must be idempotent — a duplicate or stale replay is
 * dropped here, never re-rendered as new activity.
 *
 * PROTOCOL-SEMANTICS NOTE (a finding this revision closes): Core's
 * `task.subscribe(projectId, afterSequence)` applies ONE checkpoint to every task it
 * replays when no `afterSequences` map is supplied (`sandpane-service::task_subscribe` →
 * the shared scalar per task). With several concurrent tasks whose sequences differ, a
 * project-wide checkpoint can skip a quieter task's newer events — the recorded protocol-v1 gap.
 * `TaskSubscribeParams.afterSequences` is now the server-side per-task checkpoint map that gap
 * asked for, and [labs.dkv.sandpane.core.ConnectionManager.discoverTasks] builds it from exactly
 * these streams' [lastSequence] values, so the cursor Core resumes from is the one this plugin
 * durably applied.
 *
 * This is why a stream owns its own checkpoint instead of trusting a shared one: an untracked
 * task left out of the map replays IN FULL (cursor 0), which is the safe direction — duplicate
 * events are dropped by [merge] rather than re-rendered, while a shared scalar risks silence.
 *
 * Bounded by design (docs/specs/04 §5 risk 2): at most [capacity] events are retained per
 * task; eviction drops the oldest and is reported, never silent.
 */
class EventStream(
    val taskId: String,
    private val capacity: Int,
) {

    fun interface Listener {
        /** Called on a background thread. Implementations must re-dispatch for Swing. */
        fun onEvents(events: List<TaskEvent>)

        /**
         * Core refused this task's replay as too large for one frame ([message] non-null), or a
         * fresh handshake re-armed it (null). Background thread; re-dispatch for Swing.
         */
        fun onReplayRefusalChanged(message: String?) {}
    }

    private val lock = Object()

    /**
     * Serialises fan-out against listener attachment, so a joining listener's snapshot and the
     * live batches it receives afterwards neither overlap nor leave a gap. Always taken BEFORE
     * [lock], never inside it.
     */
    private val fanout = Object()
    private val ring = ArrayDeque<TaskEvent>()
    private val listeners = CopyOnWriteArrayList<Listener>()

    @Volatile
    var lastSequence: Long = 0
        private set

    /** Set when replay shows a hole; the poller then requests a full resync for this task. */
    @Volatile
    var gapDetected: Boolean = false
        private set

    @Volatile
    var evictedCount: Long = 0
        private set

    /**
     * Sequence ranges this stream has NOT seen although a later sequence arrived (a replay hole).
     * Guarded by [lock]. A full resync accepts exactly these sequences — and nothing it already
     * delivered — so a resync never re-renders old activity as new.
     */
    private val missing = ArrayList<LongRange>()

    /** Holes dropped because [MAX_MISSING_RANGES] was exceeded; reported, never silently refilled. */
    @Volatile
    var droppedHoleCount: Long = 0
        private set

    /**
     * Non-null while Core's refusal of this task's replay (too large for one frame) is outstanding.
     * Polling for this stream stops until a fresh handshake re-arms it: the identical request can
     * never converge, so it is not retried on a timer.
     */
    @Volatile
    var replayRefusal: String? = null
        private set

    /** @return a lambda that removes the listener again. Delivers nothing already retained. */
    fun addListener(listener: Listener): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    /**
     * Attach [listener] and hand it the retained window first (review suggestion 6): a second IDE
     * window joining a stream another window already polls must see what was already merged, not
     * only what arrives next. Atomic with fan-out, so no event is delivered twice or skipped.
     * An outstanding replay refusal is reported too.
     * @return a lambda that removes the listener again.
     */
    fun addListenerWithSnapshot(listener: Listener): () -> Unit = synchronized(fanout) {
        val retained = snapshot()
        listeners.add(listener)
        if (retained.isNotEmpty()) runCatching { listener.onEvents(retained) }
        replayRefusal?.let { message -> runCatching { listener.onReplayRefusalChanged(message) } }
        return { listeners.remove(listener) }
    }

    /** Ordered snapshot of the retained window (newest last). */
    fun snapshot(): List<TaskEvent> = synchronized(lock) { ring.toList() }

    /** The sequences still missing, for tests and diagnostics. */
    fun missingRanges(): List<LongRange> = synchronized(lock) { missing.toList() }

    /**
     * The lowest sequence a hole is waiting for, or null when there is none. A resync replays from
     * just before it — not from 0 — so one gap in a long task does not re-request the whole log
     * (which, near the frame ceiling, Core would refuse and stop this task's updates).
     */
    fun firstMissingSequence(): Long? = synchronized(lock) { missing.minOfOrNull { it.first } }

    /**
     * Fold a replay batch into the window.
     *
     * Newer sequences are appended; a sequence at or below [lastSequence] is a duplicate and is
     * dropped — UNLESS it fills a recorded hole, in which case it is inserted in sequence order and
     * delivered once. Listeners receive only the events this call accepted.
     *
     * @return the events this call actually accepted (in arrival order).
     */
    fun merge(batch: List<TaskEvent>): List<TaskEvent> = synchronized(fanout) { mergeLocked(batch) }

    private fun mergeLocked(batch: List<TaskEvent>): List<TaskEvent> {
        val accepted = ArrayList<TaskEvent>(batch.size)
        synchronized(lock) {
            for (event in batch) {
                if (event.taskId != taskId) continue
                if (event.sequence <= lastSequence) {
                    // Idempotent replay / duplicate — except a sequence a hole is waiting for.
                    if (takeFromHole(event.sequence)) {
                        insertInOrder(event)
                        accepted.add(event)
                    }
                    continue
                }
                if (lastSequence > 0 && event.sequence > lastSequence + 1) {
                    recordHole(lastSequence + 1, event.sequence - 1)
                }
                ring.addLast(event)
                evictOverflow()
                lastSequence = event.sequence
                accepted.add(event)
            }
            gapDetected = missing.isNotEmpty()
        }
        if (accepted.isNotEmpty()) {
            // Fan-out on the caller's (background) thread; the UI owns its own EDT hop.
            for (l in listeners) {
                runCatching { l.onEvents(accepted) }
            }
        }
        return accepted
    }

    /**
     * A replay covering every recorded hole (from just before [firstMissingSequence]) has been
     * merged. Any hole it did not fill is not in Core's log for this task, so asking again cannot
     * fill it: the hole is dropped and counted rather than requested forever.
     * @return how many sequences were given up on.
     */
    fun markResynced(): Long = synchronized(lock) {
        val unfilled = missing.sumOf { it.last - it.first + 1 }
        missing.clear()
        gapDetected = false
        unfilled
    }

    /** Record Core's oversized-replay refusal and stop treating this stream as pollable. */
    fun markReplayRefused(message: String) = synchronized(fanout) {
        replayRefusal = message
        for (l in listeners) runCatching { l.onReplayRefusalChanged(message) }
    }

    /** Re-arm after a fresh handshake. @return true when a refusal was actually cleared. */
    fun clearReplayRefusal(): Boolean = synchronized(fanout) {
        if (replayRefusal == null) return false
        replayRefusal = null
        for (l in listeners) runCatching { l.onReplayRefusalChanged(null) }
        return true
    }

    /** Reset only on an instance change (Core restarted): checkpoints are per-instance. */
    fun forgetCheckpoint() {
        synchronized(lock) {
            ring.clear()
            missing.clear()
            lastSequence = 0
            gapDetected = false
        }
    }

    private fun recordHole(first: Long, last: Long) {
        if (missing.size >= MAX_MISSING_RANGES) {
            // Dropping (not widening) the oldest hole is the safe direction: a widened range could
            // re-accept sequences that were already delivered.
            val dropped = missing.removeAt(0)
            droppedHoleCount += dropped.last - dropped.first + 1
        }
        missing.add(first..last)
    }

    /** Remove [sequence] from the hole that contains it. @return false when no hole holds it. */
    private fun takeFromHole(sequence: Long): Boolean {
        val index = missing.indexOfFirst { sequence in it }
        if (index < 0) return false
        val hole = missing.removeAt(index)
        val pieces = listOf(hole.first..(sequence - 1), (sequence + 1)..hole.last).filter { !it.isEmpty() }
        missing.addAll(index, pieces)
        return true
    }

    private fun insertInOrder(event: TaskEvent) {
        val index = ring.indexOfFirst { it.sequence > event.sequence }
        if (index < 0) ring.addLast(event) else ring.add(index, event)
        evictOverflow(keep = event)
    }

    /**
     * Drop the oldest retained events beyond [capacity], never [keep] (review suggestion 8): a hole
     * just filled is the event a joining window most needs in its snapshot, so when it is itself
     * the oldest, the next-oldest goes instead. Every drop is counted in [evictedCount].
     */
    private fun evictOverflow(keep: TaskEvent? = null) {
        while (ring.size > capacity) {
            if (keep != null && ring.first() === keep && ring.size > 1) {
                ring.removeAt(1)
            } else {
                ring.removeFirst()
            }
            evictedCount += 1
        }
    }

    companion object {
        /** Bound on remembered holes per task; beyond it the oldest is dropped and counted. */
        const val MAX_MISSING_RANGES = 256

        /**
         * Is this `kind` a normalized agent event rather than a Core lifecycle kind?
         * Unknown kinds are rendered as unrecognized — never reinterpreted (AGENTS.md rule 5).
         */
        fun isAgentEventKind(kind: String): Boolean = AgentEvent.TYPES.contains(kind)

        fun isCoreLifecycleKind(kind: String): Boolean = CoreEventKinds.ALL.contains(kind)
    }
}

/** An agent event paired with the durable event that carried it. */
data class RenderedEvent(
    val taskEvent: TaskEvent,
    val agentEvent: AgentEvent?,
    /** Non-null when the kind was a Core lifecycle kind or could not be decoded. */
    val note: String?,
)

/**
 * Project one durable event onto something a UI can show. Decoding never fails closed:
 * an unrecognized shape arrives as [AgentEvent.Malformed] so it is visible.
 */
fun TaskEvent.toRenderedEvent(): RenderedEvent {
    if (EventStream.isAgentEventKind(kind)) {
        val decoded = AgentEventCodec.decode(payload)
        return if (decoded is AgentEvent.Malformed) {
            RenderedEvent(this, null, "unrecognized '${decoded.wireType}' payload: ${decoded.reason}")
        } else {
            RenderedEvent(this, decoded, null)
        }
    }
    GitApplies.eventNote(kind, payload)?.let { return RenderedEvent(this, null, it) }
    return when {
        EventStream.isCoreLifecycleKind(kind) -> RenderedEvent(this, null, "core event '$kind'")
        else -> RenderedEvent(this, null, "unrecognized event kind '$kind'")
    }
}
