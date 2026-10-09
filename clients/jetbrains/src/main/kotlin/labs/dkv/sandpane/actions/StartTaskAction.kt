package labs.dkv.sandpane.actions

import com.intellij.notification.Notification
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.model.Project as SandpaneProject
import labs.dkv.sandpane.services.SandpaneContextProvider
import labs.dkv.sandpane.services.SbxService

/** Action ids declared in plugin.xml; the tool window toolbar is built from this list. */
object ActionIds {
    const val START_TASK = "labs.dkv.sandpane.StartTask"
    const val REVIEW_CHANGES = "labs.dkv.sandpane.ReviewChanges"
    const val APPLY_TASK = "labs.dkv.sandpane.ApplyTask"
    const val REFRESH_SANDBOXES = "labs.dkv.sandpane.RefreshSandboxes"

    val ALL: List<String> = listOf(START_TASK, REVIEW_CHANGES, APPLY_TASK, REFRESH_SANDBOXES)
}

internal const val NOTIFICATION_GROUP_ID = "Sandpane"

/**
 * Explicit confirmation with the generic, long-standing public API: `Messages.showDialog`
 * with an option vector returns the selected index, which avoids depending on any one
 * yes/no overload's return type. JB0 compile-check item.
 */
internal fun confirm(project: Project, title: String, message: String, yesLabel: String): Boolean {
    val chosen = Messages.showDialog(project, message, title, arrayOf(yesLabel, "Cancel"), 1, null)
    return chosen == 0
}

internal fun notify(project: Project?, title: String, content: String, type: NotificationType) {
    val group = NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATION_GROUP_ID)
        ?: return
    val notification: Notification = group.createNotification(title, content, type)
    notification.notify(project)
}

/**
 * "Explain selection / refactor selection / fix diagnostics" entry point (docs/specs/04 §3),
 * expressed as one action that collects bounded editor context and hands it to Core.
 *
 * What is real here: the read-action context capture (selection text, active file, VCS root),
 * the readiness checks, and the `project.list` read-only RPC used to resolve the mapping.
 *
 * What is deliberately NOT faked: no task is created, because the protocol cannot yet answer
 * "which Core project is this IDE folder" and has no way to enumerate conversations:
 *  - `Project` exposes id/name/description/createdAt but no repository paths, so there is no
 *    client-side way to match `project.basePath` (or a VCS root) to a Core project.
 *  - there is no `conversation.list`, so an existing conversation cannot be found either.
 * The action states that, and records the three protocol items the fix needs (`project.list`
 * returning repository paths, or a path-resolving method, plus `conversation.list` and a
 * selection `ContextRef` identifier contract) — see README "Protocol gaps found".
 */
class StartTaskAction : AnAction() {

    override fun getUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(event: AnActionEvent) {
        val presentation = event.presentation
        val project = event.project
        if (project == null) {
            presentation.isEnabledAndVisible = false
            return
        }
        val editor = event.getData(CommonDataKeys.EDITOR)
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE)
        val hasContext = editor != null || file != null
        // Respect dumb/indexing mode and unavailable context (specs/04 §3).
        presentation.isEnabledAndVisible = hasContext && !DumbService.isDumb(project)

        val connection = ConnectionManager.instance()
        val problem = connection.connectionProblem()
        if (problem != null) {
            presentation.isEnabled = false
            presentation.description = problem
        }
        if (editor != null && editor.selectionModel.hasSelection()) {
            presentation.text = "Sandpane: Start Task with Selection"
        } else {
            presentation.text = "Sandpane: Start Task with Active File"
        }
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return

        // 1. Capture the context on the EDT: short, bounded read action. No I/O.
        val provider = SandpaneContextProvider.instance(project)
        val snapshot = provider.collect(event.getData(CommonDataKeys.EDITOR))
        val mapping = provider.hostMapping()
        if (mapping is SandpaneContextProvider.HostMapping.Unsupported) {
            notify(
                project,
                "Sandpane: path mapping unsupported",
                mapping.reason,
                NotificationType.ERROR,
            )
            return
        }

        val connection = ConnectionManager.instance()
        connection.connectionProblem()?.let {
            notify(project, "Sandpane: Core not ready", it, NotificationType.WARNING)
            return
        }
        val gate = connection.agentGate()
        if (!gate.chatEnabled) {
            notify(
                project,
                "Sandpane: chat is unsupported on this Core",
                gate.reasonForUser(),
                NotificationType.WARNING,
            )
            return
        }

        // 2. Explicit, user-authorized instruction. Cancel means nothing is sent.
        val instruction = Messages.showInputDialog(
            project,
            buildPromptPreviewMessage(snapshot),
            "Sandpane: Task Instruction",
            null,
            DEFAULT_INSTRUCTION,
            null,
        )?.trim()
        if (instruction.isNullOrEmpty()) return

        // 3. Confirm exactly what leaves the IDE (specs/06 §8: context sources are explicit).
        val confirmed = confirm(
            project = project,
            title = "Sandpane: Send Context to Core",
            message = buildConfirmationMessage(snapshot, instruction),
            yesLabel = "Send",
        )
        if (!confirmed) {
            notify(project, "Sandpane: nothing sent", "Cancelled before the request.", NotificationType.INFORMATION)
            return
        }

        // 4. Read-only RPC to resolve the project mapping. Nothing is created optimistically.
        SbxService.instance(project).listProjects().whenComplete { coreProjects, error ->
            if (error != null) {
                notify(
                    project,
                    "Sandpane: project.list failed",
                    error.message ?: error.javaClass.simpleName,
                    NotificationType.ERROR,
                )
                return@whenComplete
            }
            notify(
                project,
                "Sandpane: cannot resolve this folder to a Core project",
                describeMappingGap(coreProjects.orEmpty(), mapping, snapshot) + "\n\n" + PROTOCOL_GAP_MESSAGE,
                NotificationType.WARNING,
            )
        }
    }

    /**
     * The seam a JB2/JB3 adapter fills in: given a resolved Core project plus a conversation,
     * this is where `conversation.send` runs with [SandpaneContextProvider.buildContent] and
     * [SandpaneContextProvider.Snapshot.attachments]. Kept unimplemented rather than guessing a
     * conversation id (AGENTS.md rule 5).
     */
    private fun buildPromptPreviewMessage(snapshot: SandpaneContextProvider.Snapshot): String = buildString {
        appendLine("What Sandpane will send:")
        snapshot.activeFile?.let { appendLine("  active file: $it") }
        if (snapshot.hasSelection) {
            appendLine("  selection: lines ${snapshot.selectionStartLine}–${snapshot.selectionEndLine} (${snapshot.selectionText?.length ?: 0} chars)")
        } else {
            appendLine("  selection: none")
        }
        snapshot.vcsRoot?.let { appendLine("  VCS root: $it") }
        if (snapshot.truncated) appendLine("  (the selection is truncated to the context budget)")
        append("Type the instruction for the agent:")
    }

    private fun buildConfirmationMessage(
        snapshot: SandpaneContextProvider.Snapshot,
        instruction: String,
    ): String = buildString {
        appendLine("Send this to Sandpane Core?")
        appendLine()
        appendLine("instruction: $instruction")
        snapshot.activeFile?.let { appendLine("file: $it") }
        if (snapshot.hasSelection) {
            appendLine("selection: ${snapshot.selectionText?.length ?: 0} chars of ${snapshot.activeFile ?: "the file"}")
        }
        appendLine()
        append("Nothing is written to your repository: the agent works in its own sandbox, and any")
        append("change comes back as a review you apply explicitly.")
    }

    /**
     * States, in the user's terms, why the folder cannot be matched to a Core project today.
     *
     * A name match would be a guess: `sandpane_protocol::Project` carries id/name/description/
     * createdAt and no repository paths, so nothing on the wire ties an IDE folder to a project.
     * Returning a "resolved" project from `project.name == folderName` would be exactly the
     * fabricated success the specs forbid (AGENTS.md rule 5).
     */
    private fun describeMappingGap(
        coreProjects: List<SandpaneProject>,
        mapping: SandpaneContextProvider.HostMapping,
        snapshot: SandpaneContextProvider.Snapshot,
    ): String {
        val root = (mapping as? SandpaneContextProvider.HostMapping.Supported)?.projectRoot
            ?: snapshot.vcsRoot
            ?: "this IDE folder"
        val names = coreProjects.joinToString(", ") { it.name }.ifBlank { "none" }
        return "Core reports ${coreProjects.size} project(s): $names. " +
            "'$root' cannot be matched to any of them: project.list returns no repository paths."
    }

    companion object {
        private const val DEFAULT_INSTRUCTION = "Explain what this code does and what could break."

        internal const val PROTOCOL_GAP_MESSAGE =
            "Task creation stopped here on purpose: Sandpane Core cannot yet resolve an IDE folder " +
                "to a project (project.list returns no repository paths) and has no conversation.list, " +
                "so no conversation can be selected. Those two methods plus a selection ContextRef " +
                "identifier contract are protocol items, not UI work — see clients/jetbrains/README.md."
    }
}
