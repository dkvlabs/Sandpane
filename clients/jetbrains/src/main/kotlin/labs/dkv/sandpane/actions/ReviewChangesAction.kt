package labs.dkv.sandpane.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.ProjectLevelVcsManager
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.model.ChangeSet
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

    override fun getUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        val project = event.project
        val presentation = event.presentation
        if (project == null || DumbService.isDumb(project)) {
            presentation.isEnabled = false
            presentation.isEnabledAndVisible = project != null
            return
        }
        val problem = ConnectionManager.instance().connectionProblem()
        presentation.isEnabled = problem == null
        if (problem != null) presentation.description = problem
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
                    "message (JB2) or use Sandpane: Refresh Projects and Sandboxes to pull Core's task list.",
                NotificationType.INFORMATION,
            )
            return
        }
        // Deterministic choice: the newest sequence. Stated in the result so the user knows
        // which of several candidates was reviewed.
        val chosen = candidates.first()
        tasks.review(chosen.taskId).whenComplete { changeSet, error ->
            if (error != null) {
                notify(
                    project,
                    "Sandpane: git.review failed",
                    "${error.message ?: error.javaClass.simpleName}\nfor task ${chosen.taskId}",
                    NotificationType.ERROR,
                )
                return@whenComplete
            }
            if (changeSet == null) {
                notify(project, "Sandpane: git.review returned nothing", "task ${chosen.taskId}", NotificationType.WARNING)
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
        val repositoryRoot = ProjectLevelVcsManager.getInstance(project).allVcsRoots.firstOrNull()?.path
            ?: project.basePath
        val target = diff.resolve(changeSet, repositoryRoot)
        val summary = diff.summarize(target, null)
        val type = if (target.unresolved.isNotEmpty() || changeSet.hostDirty) NotificationType.WARNING else NotificationType.INFORMATION
        val extra = if (candidateCount > 1) "\n(${candidateCount - 1} other task(s) also await review)" else ""
        notify(
            project,
            "Sandpane: change set for task ${chosen.taskId.take(8)}",
            truncate(summary) + extra,
            type,
        )
    }

    private fun truncate(text: String): String =
        if (text.length <= MAX_NOTIFICATION_CHARS) text
        else text.take(MAX_NOTIFICATION_CHARS) + "\n… (truncated; the tool window shows the full list)"

    companion object {
        /** Bound the notification body: a huge change set must not paste into a balloon. */
        private const val MAX_NOTIFICATION_CHARS = 2_000
    }
}
