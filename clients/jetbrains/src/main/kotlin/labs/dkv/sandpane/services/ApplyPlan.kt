package labs.dkv.sandpane.services

import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.GitApplyParams

/**
 * What a confirmed "Apply" sends to Core, derived ONLY from the change set the user reviewed.
 *
 * Review bug 7: the action confirmed "N reviewed files" but sent `selectedFiles = null`, which
 * Core reads as "no selection given". The request now names exactly the reviewed paths, so what
 * the user confirmed and what Core is asked to apply are the same list. Pure, no I/O.
 *
 * Protocol limit (stated, not papered over): `FileChange` carries only `path` and `status` — no
 * original path for a `renamed` entry (sandpane-protocol `FileChange`). The dialog therefore says
 * which entries are renames whose source Core did not report; this plan does not invent one.
 */
object ApplyPlan {

    sealed class Decision {
        /**
         * Ready to confirm and send; [params] carries exactly [paths]. [renamedWithoutSource] lists
         * the renamed entries, whose original path the protocol does not carry.
         */
        data class Ready(
            val params: GitApplyParams,
            val paths: List<String>,
            val renamedWithoutSource: List<String> = emptyList(),
        ) : Decision()

        /** Nothing is sent; [reason] is user-facing. */
        data class Refused(val reason: String) : Decision()
    }

    /** Lines of the confirmation dialog that list paths before collapsing the rest into a count. */
    const val MAX_LISTED_PATHS = 20

    fun decide(taskId: String, reviewed: ChangeSet): Decision {
        if (reviewed.taskId != taskId) {
            return Decision.Refused(
                "the reviewed change set belongs to task ${reviewed.taskId}, not $taskId; review this task first",
            )
        }
        if (reviewed.hostDirty) {
            return Decision.Refused(
                "Core reports uncommitted changes in the host working tree for task $taskId. Commit or " +
                    "stash your own work before applying an agent's change set; Sandpane will not overwrite it.",
            )
        }
        if (reviewed.baseCommit.isBlank()) {
            return Decision.Refused("Core reported no base commit for task $taskId, so there is nothing to assert")
        }
        val blank = reviewed.changes.count { it.path.isBlank() }
        if (blank > 0) {
            // Review suggestion 5: a change set with a pathless entry is malformed. Dropping the
            // entry would send a smaller selection than the one Core reported and the user saw.
            return Decision.Refused(
                "Core's change set for task $taskId has $blank entr${if (blank == 1) "y" else "ies"} without a " +
                    "path; refusing rather than applying a selection that differs from the reviewed one",
            )
        }
        val paths = reviewed.changes.map { it.path }.distinct()
        if (paths.isEmpty()) {
            // An empty selection is a different request from "no selection" — and neither is what
            // a user who reviewed zero files meant. Nothing is sent.
            return Decision.Refused("Core's change set for task $taskId lists no files; there is nothing to apply")
        }
        return Decision.Ready(
            GitApplyParams(taskId = taskId, selectedFiles = paths, expectedBase = reviewed.baseCommit),
            paths,
            reviewed.changes.filter { it.status == FileChangeStatus.RENAMED }.map { it.path }.distinct(),
        )
    }

    /** The reviewed paths for the confirmation dialog, bounded. */
    fun describePaths(paths: List<String>, limit: Int = MAX_LISTED_PATHS): String = buildString {
        paths.take(limit).forEach { appendLine("  $it") }
        if (paths.size > limit) append("  … and ${paths.size - limit} more")
    }.trimEnd()
}
