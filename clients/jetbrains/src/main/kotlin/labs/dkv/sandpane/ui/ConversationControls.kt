package labs.dkv.sandpane.ui

import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import labs.dkv.sandpane.actions.confirm
import labs.dkv.sandpane.actions.notify
import labs.dkv.sandpane.actions.notifyOutcome
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.core.ConversationDeleteFlow
import labs.dkv.sandpane.core.ConversationDeleteFollowUp
import labs.dkv.sandpane.core.ConversationExportPager
import labs.dkv.sandpane.core.ConversationExportSave
import labs.dkv.sandpane.core.ConversationOutcomes
import labs.dkv.sandpane.core.ConversationUiState
import labs.dkv.sandpane.core.ExportDocument
import labs.dkv.sandpane.core.IssuedConversationDelete
import labs.dkv.sandpane.core.SingleFlight
import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.Project as SandpaneProject
import labs.dkv.sandpane.services.SbxService
import labs.dkv.sandpane.settings.SandpaneSettings
import java.awt.FlowLayout
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JPanel

/**
 * A3b chat-surface controls (design 2026-10-09 §3.3 item 9), native Swing, next to the chat picker:
 * Show archived · Rename… · Archive · Unarchive · Delete… · Export…, plus the "sandbox chosen at
 * creation" line for the selected conversation.
 *
 * Every button's enabled state comes from [ConversationUiState.gate] — the connection state,
 * `system.probe`'s advertised methods and Core's `archivedAt` only; an unadvertised method leaves the
 * button visible but disabled, saying so. Every Core call goes through
 * [labs.dkv.sandpane.core.CoreCommands] (ConnectionManager's io pool), delete step 2 and the export
 * file write are handed to the io pool explicitly, and every mutation re-reads `conversation.list`.
 * All methods here run on the EDT except where a background hop is named.
 */
class ConversationControls(
    private val project: Project,
    private val host: Host,
) {
    /** What the chat panel provides. Every call is made on the EDT. */
    interface Host {
        fun selectedConversation(): Conversation?
        fun selectedProject(): SandpaneProject?

        /** Re-read `conversation.list` for the selected project ([includeArchived] forces archived rows in). */
        fun reloadConversations(includeArchived: Boolean)

        /** Core says [conversationId] is gone: drop selection, transcript and tracked tasks for it. */
        fun forgetConversation(conversationId: String)

        fun systemRow(text: String)

        /** Run [block] on the EDT unless the panel was disposed. */
        fun onEdt(block: () -> Unit)
    }

    private val connection = ConnectionManager.instance()
    private val sbx = SbxService.instance(project)
    private val settings = SandpaneSettings.instance()

    private val showArchived = JCheckBox("Show archived", settings.showArchivedConversations)
    private val renameButton = JButton("Rename…")
    private val archiveButton = JButton("Archive")
    private val unarchiveButton = JButton("Unarchive")
    private val deleteButton = JButton("Delete…")
    private val exportButton = JButton("Export…")
    private val sandboxLabel = PlainText.label("")

    /** Review Info 2: one Delete and one Export at a time in this window; a second click sends nothing. */
    private val flights: Map<ConversationUiState.Action, SingleFlight> = mapOf(
        ConversationUiState.Action.DELETE to SingleFlight(),
        ConversationUiState.Action.EXPORT to SingleFlight(),
    )

    private val buttons: Map<ConversationUiState.Action, JButton> = linkedMapOf(
        ConversationUiState.Action.RENAME to renameButton,
        ConversationUiState.Action.ARCHIVE to archiveButton,
        ConversationUiState.Action.UNARCHIVE to unarchiveButton,
        ConversationUiState.Action.DELETE to deleteButton,
        ConversationUiState.Action.EXPORT to exportButton,
    )

    val component: JPanel = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0)).apply {
        add(showArchived)
        buttons.values.forEach { add(it) }
        add(sandboxLabel)
    }

    init {
        showArchived.addActionListener {
            settings.setShowArchivedConversations(showArchived.isSelected)
            host.reloadConversations(includeArchived = false)
        }
        renameButton.addActionListener { rename() }
        archiveButton.addActionListener { setArchived(archive = true) }
        unarchiveButton.addActionListener { setArchived(archive = false) }
        deleteButton.addActionListener { delete() }
        exportButton.addActionListener { export() }
        refresh()
    }

    /** Re-derive every enabled state and tooltip. EDT-only; makes no Core call. */
    fun refresh() {
        val problem = connection.connectionProblem()
        val conversation = host.selectedConversation()
        val project = host.selectedProject()
        for ((action, button) in buttons) {
            val gap = if (problem == null) connection.commands.advertisementGap(action.method) else null
            val blocked = ConversationUiState.gate(action, conversation, project, problem, gap)
                ?: ConversationUiState.inFlightNotice(action).takeIf { flights[action]?.isBusy == true }
            button.isEnabled = blocked == null
            button.toolTipText = PlainText.tooltip(blocked?.let { "Not available — $it" } ?: describe(action))
        }
        val canListArchived = problem == null && sbx.canListArchivedConversations()
        showArchived.isEnabled = canListArchived
        showArchived.isSelected = settings.showArchivedConversations
        showArchived.toolTipText = PlainText.tooltip(
            problem ?: if (canListArchived) {
                "Also list archived conversations (labeled [archived]); their history stays readable"
            } else {
                "This Core does not advertise conversation.archive, so it cannot list archived conversations."
            },
        )
        sandboxLabel.text = conversation?.let {
            ConversationUiState.sandboxLine(it, sbx.reportsConversationSandbox(), sbx.currentSnapshot().sandboxes?.map { s -> s.name })
        } ?: ""
    }

    private fun describe(action: ConversationUiState.Action): String = when (action) {
        ConversationUiState.Action.RENAME -> "Rename this conversation in Core"
        ConversationUiState.Action.ARCHIVE -> "Archive (reversible; Core then refuses new messages and renames; history stays readable)"
        ConversationUiState.Action.UNARCHIVE -> "Return this archived conversation to the live list"
        ConversationUiState.Action.DELETE ->
            "Delete after Core's own confirmation (host files, worktrees, branches and sandboxes are not touched)"
        ConversationUiState.Action.EXPORT -> "Export the messages to a JSON file you choose. Redaction is best-effort."
        ConversationUiState.Action.SEND -> "Send"
    }

    /** The selected conversation when [action] is allowed for it right now; otherwise null after saying why. */
    private fun target(action: ConversationUiState.Action): Conversation? {
        val problem = connection.connectionProblem()
        val gap = if (problem == null) connection.commands.advertisementGap(action.method) else null
        val conversation = host.selectedConversation()
        val blocked = ConversationUiState.gate(action, conversation, host.selectedProject(), problem, gap)
        if (blocked != null) {
            notify(project, "Sandpane: ${action.method} not available", "$blocked. Nothing was sent.", NotificationType.WARNING)
            return null
        }
        return conversation
    }

    private fun rereadIncludesArchived(unknown: Boolean): Boolean =
        sbx.canListArchivedConversations() && (unknown || settings.showArchivedConversations)

    // -----------------------------------------------------------------------
    // rename / archive / unarchive
    // -----------------------------------------------------------------------

    private fun rename() {
        val conversation = target(ConversationUiState.Action.RENAME) ?: return
        val dialog = ConversationRenameDialog(project, conversation)
        if (!dialog.showAndGet()) return
        val title = dialog.result
        if (title == null) {
            notify(project, "Sandpane: conversation not renamed", "Nothing was changed, so nothing was sent.", NotificationType.INFORMATION)
            return
        }
        report(CoreMethods.CONVERSATION_RENAME, connection.commands.conversationRename(conversation.id, title))
    }

    private fun setArchived(archive: Boolean) {
        val action = if (archive) ConversationUiState.Action.ARCHIVE else ConversationUiState.Action.UNARCHIVE
        val conversation = target(action) ?: return
        val call = if (archive) {
            connection.commands.conversationArchive(conversation.id)
        } else {
            connection.commands.conversationUnarchive(conversation.id)
        }
        report(action.method, call)
    }

    /** One mutation's outcome, then the re-read (archived rows included when the outcome is unknown). */
    private fun report(method: String, call: CompletableFuture<Conversation>) {
        call.whenComplete { result, error ->
            host.onEdt {
                val unknown = error != null && ConversationOutcomes.isUnknown(error)
                notifyOutcome(
                    project,
                    if (error != null) {
                        ConversationOutcomes.describeFailure(method, error, rereadIncludesArchived(unknown))
                    } else {
                        ConversationOutcomes.describeSuccess(method, result, archivedListed = rereadIncludesArchived(false))
                    },
                )
                host.reloadConversations(includeArchived = unknown)
            }
        }
    }

    // -----------------------------------------------------------------------
    // delete (A1 two-step pattern)
    // -----------------------------------------------------------------------

    /** A second click while [action] is still running: say so; nothing was sent. */
    private fun refuseBusy(action: ConversationUiState.Action) {
        notify(project, "Sandpane: ${action.method} already in progress", ConversationUiState.inFlightNotice(action), NotificationType.WARNING)
    }

    private fun delete() {
        var conversationId = ""
        var projectId = ""
        val launch = flights.getValue(ConversationUiState.Action.DELETE).launch {
            val conversation = target(ConversationUiState.Action.DELETE) ?: return@launch null
            conversationId = conversation.id
            projectId = conversation.projectId
            ConversationDeleteFlow(
                connection.commands,
                DeleteDialogUi(project),
                // Step 2 is built and sent on the io pool, never on the EDT the dialog returned on.
                background = { task -> connection.background("conversation.delete step 2") { task() } },
            ).run(conversationId)
        }
        refresh()
        val started = when (launch) {
            is SingleFlight.Launch.Busy -> return refuseBusy(ConversationUiState.Action.DELETE)
            is SingleFlight.Launch.Declined -> return
            is SingleFlight.Launch.Started -> launch.done
        }
        started.whenComplete { outcome, error ->
            host.onEdt {
                refresh()
                val next = ConversationDeleteFollowUp.next(outcome)
                val unknown = next == ConversationDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE
                if (outcome == null) {
                    notify(
                        project,
                        "Sandpane: delete outcome unknown",
                        "The delete flow ended without an outcome (${error?.javaClass?.simpleName ?: "no detail"}). Nothing is " +
                            "retried; ${ConversationOutcomes.rereadSentence(rereadIncludesArchived(true))}.",
                        NotificationType.ERROR,
                    )
                } else {
                    notifyOutcome(project, outcome.describe(rereadIncludesArchived(unknown)))
                }
                when (next) {
                    ConversationDeleteFollowUp.Next.FORGET_AND_REREAD -> {
                        host.forgetConversation(conversationId)
                        host.reloadConversations(includeArchived = false)
                    }
                    ConversationDeleteFollowUp.Next.REREAD -> host.reloadConversations(includeArchived = false)
                    ConversationDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE -> rereadThenForgetIfGone(projectId, conversationId)
                }
            }
        }
    }

    /**
     * Unknown outcome: re-read the PROJECT's conversations with archived ones (A3a pattern) at Core's
     * row maximum; forget the conversation only when that complete list no longer has it.
     */
    private fun rereadThenForgetIfGone(projectId: String, conversationId: String) {
        if (!sbx.canListArchivedConversations()) {
            host.reloadConversations(includeArchived = false)
            return
        }
        val limit = ConversationDeleteFollowUp.REREAD_LIMIT
        connection.listConversations(projectId, includeArchived = true, limit = limit).whenComplete { listed, error ->
            host.onEdt {
                if (ConversationDeleteFollowUp.goneAfterReread(conversationId, if (error == null) listed else null, archivedIncluded = true, requestedLimit = limit)) {
                    host.forgetConversation(conversationId)
                    notify(
                        project,
                        "Sandpane: conversation no longer listed by Core",
                        "Core's re-read list (archived conversations included) no longer has this conversation, so this " +
                            "window dropped its state for it. The delete's own outcome was not confirmed.",
                        NotificationType.INFORMATION,
                    )
                }
                host.reloadConversations(includeArchived = true)
            }
        }
    }

    /** The IDE side of [ConversationDeleteFlow.Ui]: the EDT hop and the native modal dialog. */
    private class DeleteDialogUi(private val project: Project) : ConversationDeleteFlow.Ui {
        override fun onUiThread(block: () -> Unit) {
            ApplicationManager.getApplication().invokeLater(block, ModalityState.defaultModalityState())
        }

        override fun confirm(issued: IssuedConversationDelete): Boolean {
            if (project.isDisposed) return false
            val chosen = Messages.showDialog(
                project,
                ConversationDeleteConfirmation.message(issued).build(),
                ConversationDeleteConfirmation.TITLE,
                null,
                arrayOf(ConversationDeleteConfirmation.DELETE_LABEL, ConversationDeleteConfirmation.CANCEL_LABEL),
                1, // default option: Cancel (Enter does not delete)
                1, // focused option: Cancel
                Messages.getWarningIcon(),
            )
            return chosen == 0
        }
    }

    // -----------------------------------------------------------------------
    // export
    // -----------------------------------------------------------------------

    private fun export() {
        val launch = flights.getValue(ConversationUiState.Action.EXPORT).launch {
            val conversation = target(ConversationUiState.Action.EXPORT) ?: return@launch null
            if (!confirm(project, ConversationExportCopy.TITLE, ConversationExportCopy.before(conversation), ConversationExportCopy.EXPORT_LABEL)) {
                return@launch null
            }
            val conversationId = conversation.id
            host.systemRow("Exporting ${conversationId.take(8)} from Core (redacted by Core, best-effort)…")
            val pager = ConversationExportPager({ after -> connection.commands.conversationExport(conversationId, after) })
            ConversationExportSave(
                SaveDialogUi(project),
                // The write runs on the io pool, never on the EDT the save dialog returned on.
                background = { task -> connection.background("conversation.export write") { task() } },
            ).save(pager.collect(conversationId))
        }
        refresh()
        val started = when (launch) {
            is SingleFlight.Launch.Busy -> return refuseBusy(ConversationUiState.Action.EXPORT)
            is SingleFlight.Launch.Declined -> return
            is SingleFlight.Launch.Started -> launch.done
        }
        started.whenComplete { outcome, error ->
            host.onEdt {
                refresh()
                val text = outcome?.describe() ?: ConversationOutcomes.describeExportFailure(error)
                notifyOutcome(project, text)
                host.systemRow(text.body)
            }
        }
    }

    /** The IDE side of [ConversationExportSave.Ui]: the native save dialog, on the EDT. */
    private class SaveDialogUi(private val project: Project) : ConversationExportSave.Ui {
        override fun onUiThread(block: () -> Unit) {
            ApplicationManager.getApplication().invokeLater(block, ModalityState.defaultModalityState())
        }

        override fun chooseTarget(defaultName: String, document: ExportDocument): Path? {
            if (project.isDisposed) return null
            val descriptor = FileSaverDescriptor(
                ConversationExportCopy.TITLE,
                ConversationExportCopy.saveDescription(document),
                "json",
            )
            val chosen = FileChooserFactory.getInstance()
                .createSaveFileDialog(descriptor, project)
                .save(null as Path?, defaultName)
                ?: return null
            // Exactly the file the user chose; nothing else is ever written.
            return chosen.file.toPath().takeIf { it.isAbsolute }
        }
    }
}
