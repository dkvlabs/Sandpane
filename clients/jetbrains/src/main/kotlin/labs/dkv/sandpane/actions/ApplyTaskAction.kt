package labs.dkv.sandpane.actions

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.changes.VcsDirtyScopeManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import labs.dkv.sandpane.core.ApplyInFlight
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.core.GitApplies
import labs.dkv.sandpane.model.ApplyResult
import labs.dkv.sandpane.model.CoreFeatures
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.services.ApplyPlan
import labs.dkv.sandpane.services.TaskMonitorService
import labs.dkv.sandpane.text.VisibleText
import labs.dkv.sandpane.ui.ApplyConfirmation
import labs.dkv.sandpane.ui.ApplyConfirmationDialog
import labs.dkv.sandpane.ui.ApplySelectionDialog
import labs.dkv.sandpane.ui.NotificationText
import labs.dkv.sandpane.ui.PlainText

/**
 * "Apply reviewed files" (A6, design 2026-10-09 §3.6; docs/specs/04 §3, specs/06 §6): hand
 * files the user reviewed back to Core, which writes them into the working tree and STAGES them
 * (nothing is committed) after its own gates.
 *
 * Safety properties, in order:
 *  1. Gated on Core advertising `git-apply`; otherwise the honest "not implemented by this Core"
 *     state and nothing is sent.
 *  2. Only over ONE `git.review` answer this window received from THIS Core instance (Core keeps
 *     `reviewId` in memory only; another instance means review again).
 *  3. The selection dialog and the confirmation are opened ONLY here, in [actionPerformed] — a
 *     direct user gesture on the EDT — never from chat, agent or tool text, a timer or a reconnect.
 *  4. A diff that showed other content than the entry's `taskBlob` refuses the send ([ApplyPlan]).
 *  5. The call goes through [ApplyPlan.submit] → `CoreCommands.gitApply`, on ConnectionManager's io
 *     pool with the 45 s git deadline; the EDT never waits. Single-flight per task
 *     ([ApplyInFlight]); never retried (no idempotency in Core).
 *  6. This action writes no host file itself. Afterwards it only marks the VCS view dirty and asks
 *     the IDE to re-read the repository (both read-only), and refreshes the review.
 */
class ApplyTaskAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        val project = event.project
        val presentation = event.presentation
        if (project == null || DumbService.isDumb(project)) {
            // Visible-but-disabled while indexing; hidden without a project.
            presentation.isVisible = project != null
            presentation.isEnabled = false
            return
        }
        val connection = ConnectionManager.instance()
        val problem = connection.connectionProblem()
        val advertised = connection.capabilities?.hasFeature(CoreFeatures.GIT_APPLY) == true
        val candidate = TaskMonitorService.instance(project).awaitingReviewTasks().firstOrNull()
        val running = candidate != null && ApplyInFlight.isActive(candidate.taskId)
        presentation.isEnabled = problem == null && advertised && candidate != null && !running
        presentation.description = when {
            problem != null -> PlainText.inert(problem)
            !advertised -> GitApplies.NOT_IMPLEMENTED
            candidate == null -> "No task is awaiting review"
            running -> "An apply for this task is running; wait for its result"
            else -> "Choose reviewed files and apply them through Core (staged, not committed)"
        }
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val connection = ConnectionManager.instance()
        connection.connectionProblem()?.let {
            notify(project, "Sandpane: Core not ready", it, NotificationType.WARNING)
            return
        }
        val caps = connection.capabilities
        if (caps == null || !caps.hasFeature(CoreFeatures.GIT_APPLY)) {
            notify(project, "Sandpane: apply not available", GitApplies.NOT_IMPLEMENTED, NotificationType.INFORMATION)
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
        val taskId = candidate.taskId
        val session = tasks.reviewSession(taskId)
        if (session == null) {
            notify(
                project,
                "Sandpane: review first",
                "Applying works on the files of one review, and this window has not reviewed task " +
                    "${VisibleText.reveal(taskId)}. Run Sandpane: Review Changes first. Nothing was sent.",
                NotificationType.WARNING,
            )
            return
        }
        if (session.coreInstanceId != caps.instanceId) {
            tasks.discardReview(taskId)
            notifyResult(
                project,
                taskId,
                "Sandpane: review again",
                "Core restarted since this review, and Core keeps reviews in memory only. Review again, then " +
                    "choose the files again. Nothing was sent.",
                NotificationType.WARNING,
                reviewAgain = true,
            )
            return
        }
        if (ApplyInFlight.isActive(taskId)) {
            notify(project, "Sandpane: apply already running", "Wait for its result. Nothing was sent.", NotificationType.INFORMATION)
            return
        }
        val diffs = if (connection.commands.advertisementGap(CoreMethods.GIT_DIFF) == null) {
            { change: FileChange -> connection.commands.gitDiff(taskId, change) }
        } else {
            null
        }

        // Step 1: the per-file checkboxes (modal, EDT, this gesture only).
        val chooser = ApplySelectionDialog(project, session, diffs)
        if (!chooser.showAndGet()) return
        val ready = when (val decision = ApplyPlan.decide(session, chooser.selectedIndices)) {
            is ApplyPlan.Decision.Refused -> {
                if (decision.reviewAgain) tasks.discardReview(taskId)
                notifyResult(
                    project,
                    taskId,
                    "Sandpane: apply refused — nothing sent",
                    VisibleText.reveal(decision.reason),
                    NotificationType.WARNING,
                    reviewAgain = decision.reviewAgain,
                )
                return
            }
            is ApplyPlan.Decision.Ready -> decision
        }

        // Step 2: the mandatory confirmation (modal, EDT, same gesture; Cancel is the default).
        val confirmation = ApplyConfirmationDialog(project, ApplyConfirmation.message(session, ready).build(), ready.entries.size)
        if (!confirmation.showAndGet()) {
            notify(project, "Sandpane: nothing applied", "Cancelled. Nothing was sent.", NotificationType.INFORMATION)
            return
        }
        if (!ApplyInFlight.begin(taskId)) {
            notify(project, "Sandpane: apply already running", "Wait for its result. Nothing was sent.", NotificationType.INFORMATION)
            return
        }
        val repoPath = session.changeSet.repoPath
        val sent = ready.entries.size
        val pending = ApplyPlan.submit(ready, connection.commands)
        if (pending == null) {
            ApplyInFlight.end(taskId)
            return
        }
        pending.whenComplete { result, error ->
            ApplyInFlight.end(taskId)
            ApplicationManager.getApplication().invokeLater(
                { onAnswer(project, taskId, repoPath, sent, result, error) },
                ModalityState.nonModal(),
            )
        }
    }

    /** EDT: show the outcome, let the IDE re-read what git may have written, and refresh the review. */
    private fun onAnswer(project: Project, taskId: String, repoPath: String?, sent: Int, result: ApplyResult?, error: Throwable?) {
        if (project.isDisposed) return
        val shown = if (result != null && error == null) {
            GitApplies.presentResult(result, repoPath, sent)
        } else {
            GitApplies.presentFailure(error, repoPath)
        }
        if (shown.mayHaveWritten) refreshFromDisk(project, repoPath)
        val type = when (shown.severity) {
            GitApplies.Severity.INFO -> NotificationType.INFORMATION
            GitApplies.Severity.WARNING -> NotificationType.WARNING
            GitApplies.Severity.ERROR -> NotificationType.ERROR
        }
        notifyResult(project, taskId, shown.title, shown.body, type, reviewAgain = shown.offerReviewAgain)
        if (shown.sentToCore) {
            // The selection and its diff evidence belong to the review that was just used; a fresh,
            // read-only review shows what is left (applied paths are now staged, so Core refuses them).
            TaskMonitorService.instance(project).discardReview(taskId)
            ReviewChangesAction.reviewAndShow(project, taskId)
        }
    }

    /** Read-only: mark the VCS view dirty and ask the IDE to re-read the repository from disk. */
    private fun refreshFromDisk(project: Project, repoPath: String?) {
        VcsDirtyScopeManager.getInstance(project).markEverythingDirty()
        val root = repoPath?.let { LocalFileSystem.getInstance().findFileByPath(it) } ?: return
        VfsUtil.markDirtyAndRefresh(true, true, true, root)
    }

    /** A notification whose title and body are escaped here; optionally offers "Review again". */
    private fun notifyResult(
        project: Project,
        taskId: String,
        title: String,
        body: String,
        type: NotificationType,
        reviewAgain: Boolean,
    ) {
        val group = NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATION_GROUP_ID) ?: return
        val notification = group.createNotification(
            NotificationText.escape(VisibleText.reveal(title)),
            NotificationText.escapeMultiline(VisibleText.revealMultiline(body)),
            type,
        )
        if (reviewAgain) {
            notification.addAction(
                NotificationAction.createSimpleExpiring("Review again") { ReviewChangesAction.reviewAndShow(project, taskId) },
            )
        }
        notification.notify(project)
    }
}
