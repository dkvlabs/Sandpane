// Per-task replay cursors: the pure seam behind `task.subscribe`'s `afterSequences` map.
//
// Why a shared scalar is wrong, stated once (docs/compatibility.md, protocol-v1 gap):
// event sequences are PER TASK and start at 1, so one number cannot describe several tasks.
// Take task A at sequence 7 and task B at sequence 3. A project-wide replay with the shared
// scalar 7 asks Core for `sequence > 7` from BOTH tasks, so B's next events (4, 5, 6, 7) are
// filtered out as if already seen — they are skipped, not deferred, and the client has no way to
// notice. `afterSequences` names each task's own cursor, which is what this produces.
package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.MAX_SUBSCRIBE_CURSORS
import labs.dkv.sandpane.model.TaskSubscribeParams

object ReplayCursors {

    /**
     * Build the cursor map from (taskId, lastAppliedSequence) pairs.
     *
     * Rules, in order:
     *  * a task at sequence 0 is NOT in the map — "no events applied yet" is exactly "absent", and
     *    Core resumes an absent task from 0 (its full history) anyway;
     *  * a negative checkpoint is clamped to 0 by [CoreGuards.validateCursorMap], never sent as
     *    a negative cursor;
     *  * the map is bounded to [MAX_SUBSCRIBE_CURSORS] entries. Insertion order decides what
     *    survives, so the caller should pass its most recently active tasks first; the count that
     *    did not fit is reported by [CursorPlan.omitted] rather than dropped silently — a task
     *    left out replays IN FULL, which is extra traffic, never lost events.
     */
    fun plan(checkpoints: Iterable<Pair<String, Long>>): CursorPlan {
        val cursors = LinkedHashMap<String, Long>()
        var omitted = 0
        for ((taskId, sequence) in checkpoints) {
            if (sequence <= 0L) continue
            if (cursors.size >= MAX_SUBSCRIBE_CURSORS) {
                omitted += 1
                continue
            }
            cursors.putIfAbsent(taskId, sequence)
        }
        return CursorPlan(cursors, omitted)
    }

    /**
     * The request for a project-wide (or global) catch-up.
     *
     * An EMPTY plan returns the legacy shape — no `afterSequences` key at all — because "no map"
     * and "empty map" are different requests to Core: the first applies the shared scalar, the
     * second replays every scoped task from 0. Silently turning one into the other would change
     * how much of the log lands in the UI.
     */
    fun request(
        projectId: String?,
        sharedAfterSequence: Long,
        plan: CursorPlan,
    ): TaskSubscribeParams =
        if (plan.cursors.isEmpty()) {
            TaskSubscribeParams(projectId = projectId, afterSequence = sharedAfterSequence)
        } else {
            TaskSubscribeParams(
                projectId = projectId,
                afterSequence = sharedAfterSequence,
                afterSequences = plan.cursors,
            )
        }

    /**
     * The smallest checkpoint across a plan — the value a caller must NOT use as a project-wide
     * scalar without knowing it drops every task behind it. Exposed because the UI shows it when
     * explaining why per-task cursors are used instead.
     */
    fun minCursor(plan: CursorPlan): Long = plan.cursors.values.minOrNull() ?: 0L

    /** A cursor map ready for one request, plus what the bound forced out. */
    data class CursorPlan(val cursors: Map<String, Long>, val omitted: Int) {
        val isEmpty: Boolean get() = cursors.isEmpty()

        /** Sentence a status bar can show when [omitted] is non-zero. */
        fun disclosure(): String? = if (omitted <= 0) null else
            "$omitted task(s) have no room in the ${MAX_SUBSCRIBE_CURSORS}-entry cursor map and " +
                "will replay in full"
    }
}
