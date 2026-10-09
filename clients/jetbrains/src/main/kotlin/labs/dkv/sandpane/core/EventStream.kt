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
 * PROTOCOL-SEMANTICS FINDING (reported, not worked around silently): Core's
 * `task.subscribe(projectId, afterSequence)` applies ONE checkpoint to every task it
 * replays (`sandpane-service::task_subscribe` → `replay_task(tid, p.after_sequence)` per
 * task). With several concurrent tasks whose sequences differ, a project-wide checkpoint
 * can skip a quieter task's newer events. So this client subscribes per task for anything
 * it actually tracks (each stream owns its own checkpoint) and uses a project-wide poll
 * only to DISCOVER task ids. A server-side per-task checkpoint map (or an
 * `(taskId, afterSequence)` list in the request) is the fix; it belongs in the protocol,
 * not in a client-side cache.
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
    }

    private val lock = Object()
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

    /** @return a lambda that removes the listener again. */
    fun addListener(listener: Listener): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    /** Ordered snapshot of the retained window (newest last). */
    fun snapshot(): List<TaskEvent> = synchronized(lock) { ring.toList() }

    /**
     * Fold a replay batch into the window.
     * @return the events this call actually accepted (in order).
     */
    fun merge(batch: List<TaskEvent>): List<TaskEvent> {
        val accepted = ArrayList<TaskEvent>(batch.size)
        synchronized(lock) {
            for (event in batch) {
                if (event.taskId != taskId) continue
                if (event.sequence <= lastSequence) continue // idempotent replay / duplicate
                if (lastSequence > 0 && event.sequence > lastSequence + 1) {
                    gapDetected = true
                }
                ring.addLast(event)
                while (ring.size > capacity) {
                    ring.removeFirst()
                    evictedCount += 1
                }
                lastSequence = event.sequence
                accepted.add(event)
            }
        }
        if (accepted.isNotEmpty()) {
            // Fan-out on the caller's (background) thread; the UI owns its own EDT hop.
            for (l in listeners) {
                runCatching { l.onEvents(accepted) }
            }
        }
        return accepted
    }

    /** A replay from scratch cleared the hole; called after a full resync. */
    fun markResynced() {
        gapDetected = false
    }

    /** Reset only on an instance change (Core restarted): checkpoints are per-instance. */
    fun forgetCheckpoint() {
        synchronized(lock) {
            ring.clear()
            lastSequence = 0
            gapDetected = false
        }
    }

    companion object {
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
    return when {
        EventStream.isCoreLifecycleKind(kind) -> RenderedEvent(this, null, "core event '$kind'")
        else -> RenderedEvent(this, null, "unrecognized event kind '$kind'")
    }
}
