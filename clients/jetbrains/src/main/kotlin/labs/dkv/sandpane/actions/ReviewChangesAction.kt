package labs.dkv.sandpane.actions

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.ProjectLevelVcsManager
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.core.ErrorAttribution
import labs.dkv.sandpane.core.GitDiffs
import labs.dkv.sandpane.ui.FileDiffChooserDialog
import labs.dkv.sandpane.ui.GitDiffText
import labs.dkv.sandpane.ui.GitDiffViewerDialog
import labs.dkv.sandpane.ui.NotificationText
import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.text.VisibleText
import labs.dkv.sandpane.ui.PlainText
import labs.dkv.sandpane.services.EditorDiffProvider
import labs.dkv.sandpane.services.TaskMonitorService

/**
 * "Review changes" from docs/specs/04 §3: ask Core for the ACTUAL change set against the
 * task's recorded base revision, then map it onto host files for navigation.
 *
 * The diff is Core's computation; this action only displays what Core reported, including the
 * `hostDirty` flag and any path the client refused to resolve (AGENTS.md rules 5 and 7).
 * Native side-by-side diff rendering is a JB3 item and is announced as deferred rather than
 * pretended at — see [EditorDiffProvider.openNativeDiff].
 */
class ReviewChangesAction : AnAction() {

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
        val problem = ConnectionManager.instance().connectionProblem()
        presentation.isEnabled = problem == null
        if (problem != null) presentation.description = PlainText.inert(problem)
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val connection = ConnectionManager.instance()
        connection.connectionProblem()?.let {
            notify(project, "Sandpane: Core not ready", it, NotificationType.WARNING)
            return
        }

        val tasks = TaskMonitorService.instance(project)
        val candidates = tasks.awaitingReviewTasks()
        if (candidates.isEmpty()) {
            notify(
                project,
                "Sandpane: nothing to review yet",
                "Core reports no tracked task in awaiting_review for this window. Track a task by sending a " +
                    "message (JB2) or use Sandpane: Refresh Projects and Sandboxes to pull Core's task list." +
                    tasks.unknownStatusNote(),
                NotificationType.INFORMATION,
            )
            return
        }
        // Deterministic choice: the newest sequence. Stated in the result so the user knows
        // which of several candidates was reviewed.
        val chosen = candidates.first()
        tasks.review(chosen.taskId).whenComplete { changeSet, error ->
            if (error != null) {
                // Title and body both come from the attribution seam: a refusal raised here before
                // a byte was written must never be announced as git.review failing at Core.
                notify(
                    project,
                    ErrorAttribution.headline(CoreMethods.GIT_REVIEW, error),
                    ErrorAttribution.describe(CoreMethods.GIT_REVIEW, error) + "\nfor task ${VisibleText.reveal(chosen.taskId)}",
                    NotificationType.ERROR,
                )
                return@whenComplete
            }
            if (changeSet == null) {
                notify(project, "Sandpane: git.review returned nothing", "task ${VisibleText.reveal(chosen.taskId)}", NotificationType.WARNING)
                return@whenComplete
            }
            show(project, chosen, changeSet, candidates.size)
        }
    }

    private fun show(
        project: Project,
        chosen: TaskMonitorService.TaskView,
        changeSet: ChangeSet,
        candidateCount: Int,
    ) {
        val diff = EditorDiffProvider.instance(project)
        val repositoryRoot = ProjectLevelVcsManager.getInstance(project).getAllVcsRoots().firstOrNull()?.path?.path
            ?: project.basePath
        val target = diff.resolve(changeSet, repositoryRoot)
        val summary = diff.summarize(target, null)
        val type = if (target.unresolved.isNotEmpty() || changeSet.hostDirty) NotificationType.WARNING else NotificationType.INFORMATION
        val extra = if (candidateCount > 1) "\n(${candidateCount - 1} other task(s) also await review)" else ""
        val connection = ConnectionManager.instance()
        // A5: a per-file Diff action, only when Core advertises git.diff; otherwise visibly unsupported.
        val diffGap = connection.commands.advertisementGap(CoreMethods.GIT_DIFF)
        val diffNote = if (diffGap != null && changeSet.changes.isNotEmpty()) "\n" + GitDiffText.UNSUPPORTED else ""
        val group = NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATION_GROUP_ID) ?: return
        val notification = group.createNotification(
            NotificationText.escape(VisibleText.reveal("Sandpane: change set for task ${chosen.taskId.take(8)}")),
            NotificationText.escapeMultiline(VisibleText.revealMultiline(truncate(summary) + extra + diffNote)),
            type,
        )
        if (diffGap == null && changeSet.changes.isNotEmpty()) {
            notification.addAction(
                NotificationAction.createSimple("Show file diff\u2026") { chooseAndShowDiff(project, chosen.taskId, changeSet) },
            )
        }
        notification.notify(project)
    }

    /** EDT: pick one entry; the `git.diff` call runs on ConnectionManager's io pool; the viewer opens on the EDT. */
    private fun chooseAndShowDiff(project: Project, taskId: String, changeSet: ChangeSet) {
        if (project.isDisposed) return
        val chooser = FileDiffChooserDialog(project, changeSet.changes)
        if (!chooser.showAndGet()) return
        val change = chooser.selected ?: return
        ConnectionManager.instance().commands.gitDiff(taskId, change).whenComplete { result, error ->
            ApplicationManager.getApplication().invokeLater({
                if (project.isDisposed) return@invokeLater
                if (result != null) {
                    GitDiffViewerDialog(project, result, null).show()
                } else {
                    notify(
                        project,
                        ErrorAttribution.headline(CoreMethods.GIT_DIFF, error),
                        GitDiffs.describeFailure(error) + "\nfile: " + GitDiffText.pathLabel(change.path, change.oldPath),
                        NotificationType.WARNING,
                    )
                }
            }, ModalityState.nonModal())
        }
    }

    /** Cut on a code-point boundary (S4): never half of a surrogate pair at the end. */
    private fun truncate(text: String): String {
        if (text.codePointCount(0, text.length) <= MAX_NOTIFICATION_CHARS) return text
        return text.substring(0, text.offsetByCodePoints(0, MAX_NOTIFICATION_CHARS)) +
            "\n… (truncated; the tool window shows the full list)"
    }

    companion object {
        /** Bound the notification body: a huge change set must not paste into a balloon. */
        private const val MAX_NOTIFICATION_CHARS = 2_000
    }
}
