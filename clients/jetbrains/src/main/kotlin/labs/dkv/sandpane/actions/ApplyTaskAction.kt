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
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.text.VisibleText
import labs.dkv.sandpane.ui.ApplyConfirmation
import labs.dkv.sandpane.ui.PlainText
import labs.dkv.sandpane.services.ApplyPlan
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
 *  4. `selectedFiles` is exactly the reviewed paths the dialog listed ([ApplyPlan]); an empty
 *     change set is refused before the dialog rather than sent.
 *  5. This action writes no host file itself. It has no filesystem write path at all.
 */
class ApplyTaskAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        val project = event.project
        val presentation = event.presentation
        if (project == null || DumbService.isDumb(project)) {
            // Visible-but-disabled while indexing; hidden without a project. (The old order set
            // isEnabledAndVisible last, which silently re-enabled the action during indexing.)
            presentation.isVisible = project != null
            presentation.isEnabled = false
            return
        }
        val problem = ConnectionManager.instance().connectionProblem()
        val pending = TaskMonitorService.instance(project).awaitingReviewTasks().isNotEmpty()
        presentation.isEnabled = problem == null && pending
        presentation.description = problem?.let(PlainText::inert) ?: if (!pending) {
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
                "Core reports no tracked task in awaiting_review." + tasks.unknownStatusNote(),
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
                    "reviewed task ${VisibleText.reveal(candidate.taskId)}. Run Sandpane: Review Changes first.",
                NotificationType.WARNING,
            )
            return
        }

        val plan = when (val decision = ApplyPlan.decide(candidate.taskId, reviewed)) {
            is ApplyPlan.Decision.Refused -> {
                notify(project, "Sandpane: apply refused — nothing sent", VisibleText.reveal(decision.reason), NotificationType.ERROR)
                return
            }

            is ApplyPlan.Decision.Ready -> decision
        }

        val message = ApplyConfirmation.message(candidate.taskId, reviewed, plan)
        if (!confirm(project, "Sandpane: Apply Task Changes", message, "Apply via Core")) {
            notify(project, "Sandpane: nothing applied", "Cancelled.", NotificationType.INFORMATION)
            return
        }

        // Exactly the paths the dialog listed (review bug 7) — never `null` after a confirmation
        // that named files.
        tasks.apply(plan.params)
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
                notifyApplyResult(project, candidate.taskId, result, plan.notSent.size)
            }
    }

    private fun notifyApplyResult(project: Project, taskId: String, result: ApplyResult?, notSent: Int) {
        if (result == null) {
            notify(project, "Sandpane: git.apply returned nothing", "task ${VisibleText.reveal(taskId)}", NotificationType.WARNING)
            return
        }
        val leftOut = if (notSent > 0) {
            "\n$notSent file(s) with a status this plugin build does not define were NOT part of the " +
                "selection and were left unapplied."
        } else {
            ""
        }
        val message = when {
            result.applied -> "Applied. Re-read the files you expect to have changed.$leftOut"
            // Core's reason is revealed single-line: notify keeps real newlines, and a reason must
            // not be able to fake a line of this body (S2).
            else -> "Not applied. Core said: ${result.abortReason?.let(VisibleText::reveal) ?: "no reason given"}" +
                conflictsLine(result.conflictedFiles) + leftOut
        }
        notify(
            project,
            "Sandpane: apply ${if (result.applied) "succeeded" else "did not happen"}",
            message,
            if (result.applied) NotificationType.INFORMATION else NotificationType.WARNING,
        )
    }

    /**
     * Conflicted paths, each escaped ([ApplyPlan.displayPath]) so a newline in one cannot fake a
     * line, and bounded like the confirmation list (W2): a change set with thousands of conflicts
     * must not produce an unreadable notification.
     */
    private fun conflictsLine(conflicted: List<String>): String {
        if (conflicted.isEmpty()) return ""
        val shown = conflicted.take(ApplyPlan.MAX_LISTED_PATHS).joinToString(", ", transform = ApplyPlan::displayPath)
        val more = conflicted.size - ApplyPlan.MAX_LISTED_PATHS
        return "\nconflicts (${conflicted.size}): $shown" + if (more > 0) ", … and $more more" else ""
    }
}
