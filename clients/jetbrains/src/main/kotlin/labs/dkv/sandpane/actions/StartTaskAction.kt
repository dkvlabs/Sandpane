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
import labs.dkv.sandpane.core.ErrorAttribution
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.ui.PlainText
import labs.dkv.sandpane.services.FolderAssociation
import labs.dkv.sandpane.services.SandpaneContextProvider
import labs.dkv.sandpane.services.SbxService
import labs.dkv.sandpane.text.VisibleText
import labs.dkv.sandpane.ui.DialogHtml
import labs.dkv.sandpane.ui.DialogText
import labs.dkv.sandpane.ui.SendContextMessages
import labs.dkv.sandpane.ui.NotificationText

/** Action ids declared in plugin.xml; the tool window toolbar is built from this list. */
object ActionIds {
    const val START_TASK = "labs.dkv.sandpane.StartTask"
    const val REVIEW_CHANGES = "labs.dkv.sandpane.ReviewChanges"
    const val APPLY_TASK = "labs.dkv.sandpane.ApplyTask"
    const val REFRESH_SANDBOXES = "labs.dkv.sandpane.RefreshSandboxes"
    const val STOP_SANDBOX = "labs.dkv.sandpane.StopSandbox"
    const val REMOVE_SANDBOX = "labs.dkv.sandpane.RemoveSandbox"
    const val START_SANDBOX = "labs.dkv.sandpane.StartSandbox"

    val ALL: List<String> = listOf(
        START_TASK, REVIEW_CHANGES, APPLY_TASK, REFRESH_SANDBOXES,
        STOP_SANDBOX, REMOVE_SANDBOX, START_SANDBOX,
    )
}

internal const val NOTIFICATION_GROUP_ID = "Sandpane"

/**
 * Explicit confirmation with the generic, long-standing public API: `Messages.showDialog`
 * with an option vector returns the selected index, which avoids depending on any one
 * yes/no overload's return type. JB0 compile-check item.
 *
 * [message] is PLAIN text and may carry Core- or agent-supplied data; it is rendered through
 * [DialogText.html], because on 2026.2 this dialog parses its message as HTML even without an
 * `<html>` prefix (see [DialogText]). [title] and [yesLabel] must be constants written in this
 * plugin — never Core data — since the dialog title is rendered as HTML too.
 */
internal fun confirm(project: Project, title: String, message: String, yesLabel: String): Boolean =
    confirmHtml(project, title, DialogText.html(message), yesLabel)

/** As [confirm], for a structured message whose lists must not be spoofable by wrapping ([DialogHtml]). */
internal fun confirm(project: Project, title: String, message: DialogHtml, yesLabel: String): Boolean =
    confirmHtml(project, title, message.build(), yesLabel)

private fun confirmHtml(project: Project, title: String, html: String, yesLabel: String): Boolean {
    val chosen = Messages.showDialog(project, html, title, arrayOf(yesLabel, "Cancel"), 1, null)
    return chosen == 0
}

internal fun notify(project: Project?, title: String, content: String, type: NotificationType) {
    val group = NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATION_GROUP_ID)
        ?: return
    // IntelliJ renders notification title/content as HTML, and both routinely carry Core- or
    // user-provided text (abort reasons, conflicted paths, error messages). They are escaped here,
    // once, so no caller can forget (security review S1) — after hidden characters (bidi
    // overrides, zero-width, stray controls) are made visible, so they cannot reorder or hide
    // text either. Single-line values inside a body (paths, ids) are revealed at the call site
    // with [VisibleText.reveal], so a newline in one cannot fake a line of the body.
    val notification: Notification = group.createNotification(
        NotificationText.escape(VisibleText.reveal(title)),
        NotificationText.escapeMultiline(VisibleText.revealMultiline(content)),
        type,
    )
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

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

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
            presentation.description = PlainText.inert(problem)
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
                VisibleText.reveal(mapping.reason),
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
            // Escaped HTML for the same reason as [confirm]: the preview names files whose names
            // the agent may have chosen (direct_mount), and `<html>` makes it render as text.
            SendContextMessages.preview(snapshot).build(),
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
            message = SendContextMessages.confirmation(snapshot, instruction),
            yesLabel = "Send",
        )
        if (!confirmed) {
            notify(project, "Sandpane: nothing sent", "Cancelled before the request.", NotificationType.INFORMATION)
            return
        }

        // 4. Read-only RPC to resolve the project mapping. Nothing is created optimistically.
        //
        // `refresh()` pulls `project.list` (with the additive protocol-v1 `repositories`) into the
        // snapshot that [SbxService.associateFolder] matches against, so the answer below is Core's
        // data put through the same pure rules the unit tests pin — never a guess. Each branch names
        // a different fact: matched, claimed by several projects, not registered, and "cannot tell"
        // are not interchangeable (AGENTS.md rule 5).
        val sbx = SbxService.instance(project)
        sbx.refresh().whenComplete { sbxSnapshot, error ->
            if (error != null) {
                notify(
                    project,
                    ErrorAttribution.headline(CoreMethods.PROJECT_LIST, error),
                    ErrorAttribution.describe(CoreMethods.PROJECT_LIST, error),
                    NotificationType.ERROR,
                )
                return@whenComplete
            }
            // A partial refresh is stated rather than hidden; the association still uses whatever
            // Core answered.
            sbxSnapshot?.failure?.let {
                notify(project, "Sandpane: project or sandbox list is incomplete", VisibleText.reveal(it), NotificationType.WARNING)
            }
            val folder = (mapping as? SandpaneContextProvider.HostMapping.Supported)?.projectRoot
                ?: snapshot.vcsRoot
            when (val association = sbx.associateFolder(folder)) {
                is FolderAssociation.Matched -> notify(
                    project,
                    "Sandpane: task creation is not wired up in this build",
                    "Resolved '${VisibleText.reveal(association.matchedRepository)}' to Core project " +
                        "'${VisibleText.reveal(association.project.name)}' " +
                        "(${VisibleText.reveal(association.project.id)}) — that mapping is " +
                        "Core's own, not a guess. Stopping here is this plugin's decision: the " +
                        "editor-side `conversation.send` path is JB3 work and is unimplemented, so " +
                        "nothing was sent and no conversation id is invented.\n\n$JB3_GAP_MESSAGE",
                    NotificationType.WARNING,
                )

                is FolderAssociation.Ambiguous -> notify(
                    project,
                    "Sandpane: several Core projects claim this folder",
                    "Core lists these projects for the same repository path: " +
                        association.candidates.joinToString(", ") {
                            "${VisibleText.reveal(it.name)} (${VisibleText.reveal(it.id)})"
                        }.let {
                            "$it. Choosing one is yours to make — taking the first would be this " +
                                "client inventing a preference it does not have. Nothing was sent."
                        },
                    NotificationType.WARNING,
                )

                FolderAssociation.Unregistered -> notify(
                    project,
                    "Sandpane: this folder is not registered with Core",
                    "No project in Core's `project.list.repositories` resolves to " +
                        "'${folder?.let(VisibleText::reveal) ?: "this IDE folder"}'. This is Core's answer, not a lookup " +
                        "failure: the folder is simply not registered. Register it (desktop app or " +
                        "Core CLI) and try again — nothing was sent.",
                    NotificationType.INFORMATION,
                )

                is FolderAssociation.Indeterminate -> notify(
                    project,
                    "Sandpane: cannot tell whether this folder is registered",
                    "${VisibleText.reveal(association.reason)} Saying \"not registered\" here would be a false answer " +
                        "about your setup, so nothing was sent.\n\n$JB3_GAP_MESSAGE",
                    NotificationType.WARNING,
                )
            }
        }
    }

    /**
     * The seam a JB2/JB3 adapter fills in: given a resolved Core project plus a conversation,
     * this is where `conversation.send` runs with [SandpaneContextProvider.buildContent] and
     * [SandpaneContextProvider.Snapshot.attachments]. Kept unimplemented rather than guessing a
     * conversation id (AGENTS.md rule 5).
     */
    companion object {
        private const val DEFAULT_INSTRUCTION = "Explain what this code does and what could break."

        /**
         * What is STILL missing after the protocol-v1 discovery revision, stated without the gaps
         * that revision closed.
         *
         * Folder→project resolution and conversation enumeration became possible once Core added
         * `project.repositories` and `conversation.list`, and this plugin uses both. What blocks
         * task creation from the editor popup is client work (the JB3 send path) plus one open
         * protocol item: `ContextRef(kind: selection)` has no identifier contract, so a selection
         * can only travel as quoted content, never as an addressable ref.
         */
        internal const val JB3_GAP_MESSAGE =
            "Remaining gaps: the editor-side send path is JB3 work and is not implemented in this " +
                "build, and Core still gives `ContextRef(kind: selection)` no identifier contract " +
                "(the selection is quoted into `content` as data, never sent as an addressable ref). " +
                "See clients/jetbrains/README.md."
    }
}
