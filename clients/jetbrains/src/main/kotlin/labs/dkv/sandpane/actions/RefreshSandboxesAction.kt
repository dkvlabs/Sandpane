package labs.dkv.sandpane.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.services.SbxService
import labs.dkv.sandpane.services.TaskMonitorService

/**
 * "Manage project / show activity" refresh (docs/specs/04 §3): re-probe project and sandbox
 * state from Core, and pull the task list.
 *
 * Read-only by construction — `project.list`, `sandbox.list` and `task.subscribe` replay. State
 * is always re-probed rather than assumed, and the staleness of the snapshot is reported with
 * it, so an old list is never presented as current (specs/02 §5, AGENTS.md rule 5).
 *
 * This action is also the recovery path when the connection dropped: it re-triggers the
 * handshake instead of showing a dead panel (specs/04 §2 step 5).
 */
class RefreshSandboxesAction : AnAction() {

    override fun getUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        // Always available: the honest "Core is down" message is more useful than a greyed item.
        val presentation = event.presentation
        presentation.isEnabledAndVisible = event.project != null
        presentation.text = if (ConnectionManager.instance().isReady) {
            "Sandpane: Refresh Projects and Sandboxes"
        } else {
            "Sandpane: Reconnect and Refresh"
        }
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val connection = ConnectionManager.instance()

        if (!connection.isReady) {
            connection.connectAsync("refresh action")
            notify(
                project,
                "Sandpane: reconnecting",
                connection.connectionProblem()
                    ?: "attempting the local Core socket at ${connection.socketPath()}",
                NotificationType.INFORMATION,
            )
            return
        }

        val sbx = SbxService.instance(project)
        sbx.refresh().whenComplete { snapshot, error ->
            if (error != null || snapshot == null) {
                notify(
                    project,
                    "Sandpane: refresh failed",
                    error?.message ?: "no snapshot returned",
                    NotificationType.ERROR,
                )
                return@whenComplete
            }

            val projects = snapshot.projects?.size?.toString() ?: "unknown"
            val sandboxes = snapshot.sandboxes?.size?.toString() ?: "unknown"
            val gate = connection.agentGate()
            val sbxLine = snapshot.projects?.let { coreProjects ->
                val caps = connection.capabilities
                when {
                    caps?.sbx == null -> "SBX: not reported by this Core"
                    caps.sbx.installed -> "SBX: installed ${caps.sbx.version?.let { "($it)" } ?: "(version not probed)"}" +
                        caps.sbx.daemonRunning?.let { if (it) ", daemon running" else ", daemon NOT running" }
                        .orEmpty() + "; ${coreProjects.size} project(s) in Core"

                    else -> "SBX: NOT INSTALLED — sandbox features cannot work until the user installs Docker " +
                        "Sandboxes separately (Sandpane bundles no sbx binary)"
                }
            }.orEmpty()

            // Task discovery needs a Core project id; without folder→project resolution the
            // client cannot scope it. Reported rather than guessed (see README "Protocol gaps").
            val tasks = TaskMonitorService.instance(project)
            val taskLine = if (tasks.trackedTaskIds().isEmpty()) {
                "tracked tasks: none. Discovery is scoped by Core project id, and this folder cannot be " +
                    "resolved to one yet (project.list carries no repository paths)."
            } else {
                "tracked tasks: ${tasks.trackedTaskIds().size}"
            }

            notify(
                project,
                "Sandpane: refreshed · ${snapshot.describeAge()}",
                buildString {
                    appendLine("projects: $projects · sandboxes: $sandboxes")
                    if (sbxLine.isNotEmpty()) appendLine(sbxLine)
                    appendLine(taskLine)
                    appendLine("agent gate: ${gate.reasonForUser()}")
                    snapshot.failure?.let { appendLine("Core problems: $it") }
                },
                if (snapshot.failure == null) NotificationType.INFORMATION else NotificationType.WARNING,
            )
        }
    }
}
