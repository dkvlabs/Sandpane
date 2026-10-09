package labs.dkv.sandpane.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.core.ErrorAttribution
import labs.dkv.sandpane.model.ApplyResult
import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.services.TaskMonitorService

/**
 * "Apply" from docs/specs/04 §3 / specs/06 §6: hand the reviewed change set back to Core as an
 * explicit Git operation, with the base this client recorded at review time.
 *
 * Safety properties, in order:
 *  1. No apply without a prior review in this window — the base commit has to come from
 *     somewhere real (`reviewedChangeSet`), never from a guess.
 *  2. `hostDirty` refuses client-side as well: Core reports uncommitted host work, and
 *     touching a dirty tree is the exact case specs/04 rule 7 protects.
 *  3. `expectedBase` goes to Core; a divergence aborts THERE and is reported as such.
 *  4. This action writes no host file itself. It has no filesystem write path at all.
 */
class ApplyTaskAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        val project = event.project
        val presentation = event.presentation
        if (project == null || DumbService.isDumb(project)) {
            presentation.isEnabled = false
            presentation.isEnabledAndVisible = project != null
            return
        }
        val problem = ConnectionManager.instance().connectionProblem()
        val pending = TaskMonitorService.instance(project).awaitingReviewTasks().isNotEmpty()
        presentation.isEnabled = problem == null && pending
        presentation.description = problem ?: if (!pending) {
            "No task is awaiting review"
        } else {
            "Apply the reviewed change set through Core"
        }
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val connection = ConnectionManager.instance()
        connection.connectionProblem()?.let {
            notify(project, "Sandpane: Core not ready", it, NotificationType.WARNING)
            return
        }

        val tasks = TaskMonitorService.instance(project)
        val candidate = tasks.awaitingReviewTasks().firstOrNull()
        if (candidate == null) {
            notify(
                project,
                "Sandpane: nothing to apply",
                "Core reports no tracked task in awaiting_review.",
                NotificationType.INFORMATION,
            )
            return
        }

        val reviewed = tasks.reviewedChangeSet(candidate.taskId)
        if (reviewed == null) {
            notify(
                project,
                "Sandpane: review first",
                "Applying needs the base commit Core reported at review time, and this window has not " +
                    "reviewed task ${candidate.taskId}. Run Sandpane: Review Changes first.",
                NotificationType.WARNING,
            )
            return
        }

        if (reviewed.hostDirty) {
            notify(
                project,
                "Sandpane: apply refused — host tree is dirty",
                "Core reports uncommitted changes in the host working tree for task ${candidate.taskId}. " +
                    "Commit or stash your own work before applying an agent's change set; Sandpane will " +
                    "not overwrite it.",
                NotificationType.ERROR,
            )
            return
        }

        if (!confirm(project, "Sandpane: Apply Task Changes", applyMessage(candidate, reviewed), "Apply via Core")) {
            notify(project, "Sandpane: nothing applied", "Cancelled.", NotificationType.INFORMATION)
            return
        }

        tasks.apply(candidate.taskId, selectedFiles = null, expectedBase = reviewed.baseCommit)
            .whenComplete { result, error ->
                if (error != null) {
                    // Attribution seam again: this action must not announce a client-side refusal
                    // as git.apply failing at Core — an apply that never left is a different fact
                    // from one Core rejected.
                    notify(
                        project,
                        ErrorAttribution.headline(CoreMethods.GIT_APPLY, error),
                        ErrorAttribution.describe(CoreMethods.GIT_APPLY, error),
                        NotificationType.ERROR,
                    )
                    return@whenComplete
                }
                notifyApplyResult(project, candidate.taskId, result)
            }
    }

    private fun applyMessage(
        candidate: TaskMonitorService.TaskView,
        reviewed: ChangeSet,
    ): String = buildString {
        appendLine("Apply task ${candidate.taskId.take(8)} through Core?")
        appendLine()
        appendLine("files: ${reviewed.changes.size}")
        appendLine("base commit: ${reviewed.baseCommit}")
        appendLine("host dirty: ${reviewed.hostDirty} (checked again by Core before it touches anything)")
        appendLine()
        append("This is an explicit Git operation. If the repository moved since the review, Core aborts.")
    }

    private fun notifyApplyResult(project: Project, taskId: String, result: ApplyResult?) {
        if (result == null) {
            notify(project, "Sandpane: git.apply returned nothing", "task $taskId", NotificationType.WARNING)
            return
        }
        val message = when {
            result.applied -> "Applied. Re-read the files you expect to have changed."
            else -> "Not applied. Core said: ${result.abortReason ?: "no reason given"}" +
                (if (result.conflictedFiles.isNotEmpty()) "\nconflicts: ${result.conflictedFiles.joinToString(", ")}" else "")
        }
        notify(
            project,
            "Sandpane: apply ${if (result.applied) "succeeded" else "did not happen"}",
            message,
            if (result.applied) NotificationType.INFORMATION else NotificationType.WARNING,
        )
    }
}
