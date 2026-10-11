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
import labs.dkv.sandpane.model.CoreFeatures
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.core.GitApplies
import labs.dkv.sandpane.text.VisibleText
import labs.dkv.sandpane.ui.PlainText
import labs.dkv.sandpane.services.EditorDiffProvider
import labs.dkv.sandpane.services.ReviewRoot
import labs.dkv.sandpane.services.ReviewRoots
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
        reviewAndShow(project, candidates.first().taskId, candidates.size)
    }

    companion object {
        /** Bound the notification body: a huge change set must not paste into a balloon. */
        private const val MAX_NOTIFICATION_CHARS = 2_000

        /**
         * A fresh, read-only `git.review` of [taskId] and its summary notification. Also the "Review
         * again" path after an apply (A6): the new answer replaces the stored review, so the old
         * selection and the diffs opened for it are discarded.
         */
        fun reviewAndShow(project: Project, taskId: String, candidateCount: Int = 1) {
            if (project.isDisposed) return
            TaskMonitorService.instance(project).review(taskId).whenComplete { changeSet, error ->
                if (error != null) {
                    // Title and body both come from the attribution seam: a refusal raised here before
                    // a byte was written must never be announced as git.review failing at Core.
                    notify(
                        project,
                        ErrorAttribution.headline(CoreMethods.GIT_REVIEW, error),
                        ErrorAttribution.describe(CoreMethods.GIT_REVIEW, error) + "\nfor task ${VisibleText.reveal(taskId)}",
                        NotificationType.ERROR,
                    )
                    return@whenComplete
                }
                if (changeSet == null) {
                    notify(project, "Sandpane: git.review returned nothing", "task ${VisibleText.reveal(taskId)}", NotificationType.WARNING)
                    return@whenComplete
                }
                show(project, taskId, changeSet, candidateCount)
            }
        }

        private fun show(
            project: Project,
            taskId: String,
            changeSet: ChangeSet,
            candidateCount: Int,
        ) {
            if (project.isDisposed) return
            val diff = EditorDiffProvider.instance(project)
            // I3: resolve against the VCS root that IS Core's repoPath, never simply the first root; with no
            // match nothing is resolved and the summary says so. This runs on the completing (io) thread of
            // git.review, off the EDT, since choosing canonicalizes paths on disk.
            val vcsRoots = ProjectLevelVcsManager.getInstance(project).getAllVcsRoots().map { it.path.path }
            val target = when (val root = ReviewRoots.choose(changeSet.repoPath, vcsRoots)) {
                is ReviewRoot.Matched -> diff.resolve(changeSet, root.root)
                is ReviewRoot.Refused -> EditorDiffProvider.unresolvedTarget(changeSet, root.warning)
            }
            val summary = diff.summarize(target, null)
            val warn = target.unresolved.isNotEmpty() || changeSet.hostDirty || target.rootWarning != null
            val type = if (warn) NotificationType.WARNING else NotificationType.INFORMATION
            val extra = if (candidateCount > 1) "\n(${candidateCount - 1} other task(s) also await review)" else ""
            val connection = ConnectionManager.instance()
            // A5: a per-file Diff action, only when Core advertises git.diff; otherwise visibly unsupported.
            val diffGap = connection.commands.advertisementGap(CoreMethods.GIT_DIFF)
            val diffNote = if (diffGap != null && changeSet.changes.isNotEmpty()) "\n" + GitDiffText.UNSUPPORTED else ""
            val applyNote = if (changeSet.changes.isNotEmpty()) "\n" + applyHint(connection, changeSet) else ""
            val group = NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATION_GROUP_ID) ?: return
            val notification = group.createNotification(
                NotificationText.escape(VisibleText.reveal("Sandpane: change set for task ${taskId.take(8)}")),
                NotificationText.escapeMultiline(VisibleText.revealMultiline(truncate(summary) + extra + diffNote + applyNote)),
                type,
            )
            if (diffGap == null && changeSet.changes.isNotEmpty()) {
                notification.addAction(
                    NotificationAction.createSimple("Show file diff\u2026") { chooseAndShowDiff(project, taskId, changeSet) },
                )
            }
            notification.notify(project)
        }

        /** A6: how (or whether) the files of this review can be applied; never an action from here. */
        private fun applyHint(connection: ConnectionManager, changeSet: ChangeSet): String = when {
            connection.capabilities?.hasFeature(CoreFeatures.GIT_APPLY) != true -> GitApplies.NOT_IMPLEMENTED
            changeSet.reviewId.isNullOrEmpty() ->
                "Apply: Core gave this review no reviewId, so its files cannot be applied (only host_worktree tasks can)."
            else -> "To apply files from this review: Sandpane: Apply Reviewed Files\u2026 (you choose files and confirm)."
        }

        /**
         * EDT: pick one entry; the `git.diff` call runs on ConnectionManager's io pool; the viewer opens on
         * the EDT. A6: the answer is recorded into the current review, for flag (a) and the mismatch rule.
         */
        private fun chooseAndShowDiff(project: Project, taskId: String, changeSet: ChangeSet) {
            if (project.isDisposed) return
            val chooser = FileDiffChooserDialog(project, changeSet.changes)
            if (!chooser.showAndGet()) return
            val change = chooser.selected ?: return
            ConnectionManager.instance().commands.gitDiff(taskId, change).whenComplete { result, error ->
                ApplicationManager.getApplication().invokeLater({
                    if (project.isDisposed) return@invokeLater
                    if (result != null) {
                        TaskMonitorService.instance(project).recordDiff(taskId, result)
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
                "\n\u2026 (truncated; the tool window shows the full list)"
        }
    }
}
