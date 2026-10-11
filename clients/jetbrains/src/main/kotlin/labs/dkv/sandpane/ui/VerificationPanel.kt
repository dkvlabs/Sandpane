package labs.dkv.sandpane.ui

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.core.KeyedRequests
import labs.dkv.sandpane.core.OutcomeSeverity
import labs.dkv.sandpane.core.RunTarget
import labs.dkv.sandpane.core.VerificationActivity
import labs.dkv.sandpane.core.VerificationInFlight
import labs.dkv.sandpane.core.VerificationRuns
import labs.dkv.sandpane.core.Verifications
import labs.dkv.sandpane.model.CoreEventKinds
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.ProjectContextResult
import labs.dkv.sandpane.model.TaskSummary
import labs.dkv.sandpane.model.VerificationCommand
import labs.dkv.sandpane.model.VerificationRunParams
import labs.dkv.sandpane.model.describe
import labs.dkv.sandpane.services.SbxService
import labs.dkv.sandpane.services.TaskMonitorService
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.GridLayout
import javax.swing.BorderFactory
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextArea
import javax.swing.ListSelectionModel
import labs.dkv.sandpane.model.Project as SandpaneProject

/**
 * The Verification section of the Sandpane tool window (A7, design 2026-10-09 §3.7): a
 * project's approved commands (with Revoke and Add), `project.context` suggestions (with Approve),
 * the project's tasks (with a per-task Run) and the runs this IDE has seen (with Refresh result and
 * View output).
 *
 * Rules (§3.7 items 6 and 8):
 *  - Enabled ONLY when Core advertises the `verification` feature; otherwise every control is
 *    disabled and the gate text says why. Nothing is sent then.
 *  - Approve, Revoke and Run open their modal dialogs ONLY in a click handler on this panel's own
 *    buttons (`on*Clicked`, no parameters), synchronously, filled from Core state this panel already
 *    holds. No event, reconnect, timer, chat or agent text, and no action parameter can open them
 *    or pass argv, a command id or a run id.
 *  - `project.context` is read ONLY when the user clicks Detect suggestions (J-I2): never from a
 *    reload, a reconnect or a project switch. `verification.list` is read automatically.
 *  - Every Core call goes through [ConnectionManager]'s io pool; this panel only touches Swing on the
 *    EDT ([onEdt]). Output is read with `verification.result` when Core reports a run finished (an
 *    event) or the user clicks Refresh result — never on a timer.
 *  - Task status is never derived from a verification (AGENTS.md rule 3).
 */
class VerificationPanel(
    private val project: Project,
) : JPanel(BorderLayout()), Disposable {

    /** One `project.context` suggestion row: Core's repository, manifest, argv and notes, verbatim. */
    data class Suggestion(
        val repoPath: String,
        val manifest: String,
        val argv: List<String>,
        val notes: List<String>,
        val unreadable: List<String>,
    ) {
        /** Counts only: paths, the manifest name, argv and notes are untrusted and never logged. */
        override fun toString(): String =
            "Suggestion(${argv.size} element(s), ${notes.size} note(s), ${unreadable.size} unreadable)"
    }

    private val connection = ConnectionManager.instance()
    private val sbx = SbxService.instance(project)
    private val tasks = TaskMonitorService.instance(project)

    /** Wall clock for the retry window (D-I5); the window rules themselves take `now` as a parameter. */
    private val clock: () -> Long = System::currentTimeMillis

    private val gateLabel = PlainText.label(" ")
    private val statusLabel = PlainText.label(" ")
    private val projectModel = DefaultComboBoxModel<SandpaneProject>()
    private val projectPicker = JComboBox(projectModel)
    private val refreshButton = JButton("Refresh")

    private val commandsModel = DefaultListModel<VerificationCommand>()
    private val commandsList = JBList(commandsModel)
    private val addButton = JButton("Add command…")
    private val revokeButton = JButton("Revoke…")

    private val suggestionsModel = DefaultListModel<Suggestion>()
    private val suggestionsList = JBList(suggestionsModel)
    private val approveButton = JButton("Approve…")
    private val detectButton = JButton("Detect suggestions")
    private val notesArea = JTextArea(4, 60).apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
    }

    private val tasksModel = DefaultListModel<TaskSummary>()
    private val tasksList = JBList(tasksModel)
    private val runButton = JButton("Run…")
    private val taskTargetLabel = PlainText.label(" ")

    private val runsModel = DefaultListModel<VerificationActivity.Run>()
    private val runsList = JBList(runsModel)
    private val refreshResultButton = JButton("Refresh result")
    private val viewOutputButton = JButton("View output…")

    /** The project whose state the lists show (a picker event for the same project reads nothing again). */
    private var loadedProjectId: String? = null

    /** When Core's command list / context in this panel were last read (shown in the Run dialog). */
    private var commandsReadAt: Long = 0

    @Volatile
    private var disposed = false
    private var removeStateListener: (() -> Unit)? = null
    private var removeSnapshotListener: (() -> Unit)? = null
    private var removeViewListener: (() -> Unit)? = null

    init {
        name = "SandpaneVerificationPanel"
        border = BorderFactory.createEmptyBorder(4, 6, 4, 6)
        configureLists()
        add(buildHeader(), BorderLayout.NORTH)
        add(JBScrollPane(buildSections()), BorderLayout.CENTER)
        add(statusLabel, BorderLayout.SOUTH)
        wire()
        refreshControls()
    }

    // -----------------------------------------------------------------------
    // layout
    // -----------------------------------------------------------------------

    private fun configureLists() {
        projectPicker.renderer = PlainTextListRenderer { value ->
            val p = value as? SandpaneProject
            (p?.let { DisplayCap.cap(it.name) + if (it.isArchived) " [archived]" else "" } ?: "no project") to null
        }
        commandsList.selectionMode = ListSelectionModel.SINGLE_SELECTION
        commandsList.cellRenderer = PlainTextListRenderer { value ->
            val c = value as? VerificationCommand
            (c?.let { Verifications.commandRow(it.label, it.argv) } ?: "") to null
        }
        suggestionsList.selectionMode = ListSelectionModel.SINGLE_SELECTION
        suggestionsList.cellRenderer = PlainTextListRenderer { value ->
            val s = value as? Suggestion
            (s?.let { Verifications.item(it.manifest) + " in " + Verifications.item(it.repoPath) + ":  " + it.argv.joinToString(" ") { a -> Verifications.element(a) } } ?: "") to null
        }
        tasksList.selectionMode = ListSelectionModel.SINGLE_SELECTION
        tasksList.cellRenderer = PlainTextListRenderer { value ->
            val t = value as? TaskSummary
            (t?.let { taskRow(it) } ?: "") to null
        }
        runsList.selectionMode = ListSelectionModel.SINGLE_SELECTION
        runsList.cellRenderer = PlainTextListRenderer { value ->
            val r = value as? VerificationActivity.Run
            (r?.let { runRow(it) } ?: "") to null
        }
        PlainText.disableHtml(notesArea)
    }

    private fun buildHeader(): JComponent = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        add(JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
            add(PlainText.label("Project"))
            add(projectPicker.apply { preferredSize = Dimension(220, 26) })
            add(refreshButton)
            alignmentX = 0f
        })
        add(gateLabel.apply { alignmentX = 0f })
        add(PlainText.label(Verifications.UNVERIFIED_NOTE).apply { alignmentX = 0f })
    }

    private fun section(title: String, list: JComponent, vararg buttons: JComponent, extra: JComponent? = null): JComponent =
        JPanel(BorderLayout(0, 2)).apply {
            border = BorderFactory.createTitledBorder(title)
            add(JBScrollPane(list).apply { preferredSize = Dimension(560, 110) }, BorderLayout.CENTER)
            add(JPanel(BorderLayout()).apply {
                add(JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply { buttons.forEach { add(it) } }, BorderLayout.NORTH)
                extra?.let { add(it, BorderLayout.CENTER) }
            }, BorderLayout.SOUTH)
        }

    private fun buildSections(): JComponent = JPanel(GridLayout(0, 1, 0, 6)).apply {
        add(section("Approved commands", commandsList, addButton, revokeButton))
        add(section("Suggestions (project.context; never run or approved automatically)", suggestionsList, detectButton, approveButton, extra = JBScrollPane(notesArea)))
        add(section("Tasks", tasksList, runButton, extra = taskTargetLabel))
        add(section("Runs seen in this IDE", runsList, refreshResultButton, viewOutputButton))
    }

    // -----------------------------------------------------------------------
    // wiring (callbacks arrive on background threads; Swing only through onEdt)
    // -----------------------------------------------------------------------

    private fun wire() {
        // Click handlers: the ONLY places the dialogs open (gesture-only, §3.7 item 8).
        refreshButton.addActionListener { onRefreshClicked() }
        addButton.addActionListener { onAddCommandClicked() }
        revokeButton.addActionListener { onRevokeClicked() }
        approveButton.addActionListener { onApproveSuggestionClicked() }
        detectButton.addActionListener { onDetectSuggestionsClicked() }
        runButton.addActionListener { onRunClicked() }
        refreshResultButton.addActionListener { onRefreshResultClicked() }
        viewOutputButton.addActionListener { onViewOutputClicked() }
        projectPicker.addActionListener { if (selectedProject()?.id != loadedProjectId) reload() }
        commandsList.addListSelectionListener { refreshControls() }
        suggestionsList.addListSelectionListener { showSuggestionNotes(); refreshControls() }
        tasksList.addListSelectionListener { refreshControls() }
        runsList.addListSelectionListener { refreshControls() }

        removeStateListener = connection.addStateListener { onEdt { refreshControls(); reload() } }
        removeSnapshotListener = sbx.addSnapshotListener { snapshot ->
            onEdt {
                val previous = (projectModel.selectedItem as? SandpaneProject)?.id
                val projects = snapshot.projects.orEmpty()
                projectModel.removeAllElements()
                projects.forEach { projectModel.addElement(it) }
                projectModel.selectedItem = projects.firstOrNull { it.id == previous }
                    ?: projects.firstOrNull { !it.isArchived } ?: projects.firstOrNull()
                refreshControls()
            }
        }
        removeViewListener = tasks.addViewListener { taskId, _, rendered ->
            val event = rendered?.taskEvent ?: return@addViewListener
            if (event.kind !in CoreEventKinds.VERIFICATION) return@addViewListener
            // A finished run's result is read once, here (an event), never on a timer. Nothing opens.
            if (event.kind == CoreEventKinds.VERIFICATION_FINISHED && Verifications.gate(connection.capabilities) == null) {
                val runId = ((event.payload as? JsonObject)?.get("runId") as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
                if (runId != null && VerificationActivity.get(runId)?.taskId == taskId) fetchResult(runId, announce = false)
            }
            onEdt { reloadRuns() }
        }
    }

    // -----------------------------------------------------------------------
    // reads (read-only; io pool)
    // -----------------------------------------------------------------------

    private fun selectedProject(): SandpaneProject? = projectModel.selectedItem as? SandpaneProject

    private fun reload() {
        val p = selectedProject()
        loadedProjectId = p?.id
        commandsModel.clear()
        suggestionsModel.clear()
        tasksModel.clear()
        notesArea.text = DETECT_HINT
        refreshControls()
        if (p == null || connection.connectionProblem() != null || Verifications.gate(connection.capabilities) != null) {
            reloadRuns()
            return
        }
        val projectId = p.id
        statusLabel.text = "Reading Core's verification state…"
        connection.commands.verificationList(projectId).whenComplete { list, error ->
            onEdt {
                if (selectedProject()?.id != projectId) return@onEdt
                if (list != null) {
                    commandsModel.clear()
                    list.forEach { commandsModel.addElement(it) }
                    commandsReadAt = System.currentTimeMillis()
                    statusLabel.text = "${list.size} approved command(s), read from Core."
                } else {
                    report(Verifications.describeFailure(CoreMethods.VERIFICATION_LIST, error))
                }
                refreshControls()
            }
        }
        connection.listTasks(projectId).whenComplete { list, _ ->
            onEdt {
                if (selectedProject()?.id != projectId) return@onEdt
                tasksModel.clear()
                list.orEmpty().forEach { tasksModel.addElement(it) }
                reloadRuns()
                refreshControls()
            }
        }
    }

    private fun fillSuggestions(context: ProjectContextResult) {
        suggestionsModel.clear()
        for (repo in context.repositories) {
            for (d in repo.detected) {
                for (argv in d.suggestedCommands) {
                    suggestionsModel.addElement(Suggestion(repo.repoPath, d.manifest, argv, d.notes, repo.unreadable))
                }
            }
        }
        val unreadable = context.repositories.filter { it.unreadable.isNotEmpty() }
        if (suggestionsModel.isEmpty) {
            notesArea.text = "Core detected no suggestions in the project's registered repositories." +
                unreadable.joinToString("") { r -> "\n" + unreadableLine(r.repoPath, r.unreadable) }
        }
    }

    private fun unreadableLine(repoPath: String, unreadable: List<String>): String =
        "unreadable in " + Verifications.item(repoPath) + " (nothing was taken from them): " +
            unreadable.take(Verifications.MAX_LISTED).joinToString(", ") { Verifications.item(it) }

    private fun showSuggestionNotes() {
        val s = suggestionsList.selectedValue ?: return
        // Plain text area, each note revealed single-line and capped: never HTML, Markdown or links.
        notesArea.text = buildString {
            append("Notes (${s.notes.size}) from Core for ${Verifications.item(s.manifest)}:")
            s.notes.forEach { append("\n• ").append(Verifications.item(it)) }
            if (s.unreadable.isNotEmpty()) append("\n").append(unreadableLine(s.repoPath, s.unreadable))
        }
        notesArea.caretPosition = 0
    }

    private fun reloadRuns() {
        val ids = (0 until tasksModel.size).map { tasksModel.getElementAt(it).id }.toSet()
        val selected = runsList.selectedValue?.runId
        runsModel.clear()
        VerificationActivity.runsForTasks(ids).forEach { runsModel.addElement(it) }
        if (selected != null) {
            (0 until runsModel.size).firstOrNull { runsModel.getElementAt(it).runId == selected }?.let { runsList.selectedIndex = it }
        }
        refreshControls()
    }

    /** `verification.result` for a run id Core gave this IDE (an answer or an event). */
    private fun fetchResult(runId: String, announce: Boolean) {
        connection.commands.verificationResult(runId).whenComplete { result, error ->
            if (result != null) VerificationActivity.recordResult(result)
            onEdt {
                if (result != null) {
                    statusLabel.text = "Run ${VisibleText.reveal(runId.take(8))}: " + Verifications.outcomeLine(result)
                } else if (announce) {
                    report(Verifications.describeFailure(CoreMethods.VERIFICATION_RESULT, error))
                }
                reloadRuns()
            }
        }
    }

    // -----------------------------------------------------------------------
    // click handlers: the only entry points (no parameters; state comes from Core)
    // -----------------------------------------------------------------------

    private fun onRefreshClicked() {
        sbx.refresh()
        reload()
    }

    /** `project.context` for the selected project: read only here, on this explicit click (J-I2). */
    private fun onDetectSuggestionsClicked() {
        val p = readyProject() ?: return
        val projectId = p.id
        suggestionsModel.clear()
        notesArea.text = "Asking Core to detect suggestions (read-only; nothing is run or approved)…"
        detectButton.isEnabled = false
        connection.commands.projectContext(projectId).whenComplete { context, error ->
            onEdt {
                if (selectedProject()?.id != projectId) return@onEdt
                if (context != null) {
                    fillSuggestions(context)
                    if (!suggestionsModel.isEmpty) notesArea.text = "${suggestionsModel.size()} suggestion(s) detected by Core. Select one to see its notes."
                } else {
                    notesArea.text = DETECT_HINT
                    report(Verifications.describeFailure(CoreMethods.PROJECT_CONTEXT, error))
                }
                refreshControls()
            }
        }
    }

    private fun onAddCommandClicked() {
        val p = readyProject() ?: return
        approveWithDialogs(p, "", suggestedArgv = null, notes = null)
    }

    private fun onApproveSuggestionClicked() {
        val p = readyProject() ?: return
        val s = suggestionsList.selectedValue ?: return
        approveWithDialogs(p, DisplayCap.cap(s.argv.joinToString(" "), 80).removeSuffix("…"), s.argv, s.notes)
    }

    /**
     * Step 1 (the list editor) and step 2 (the confirmation), both modal and synchronous inside the
     * click that called this; then `verification.approve` on the io pool. Called ONLY from
     * [onAddCommandClicked] and [onApproveSuggestionClicked]. A suggestion's notes are shown only
     * while its argv is unchanged (D-I4); an edited list says so instead.
     */
    private fun approveWithDialogs(p: SandpaneProject, initialLabel: String, suggestedArgv: List<String>?, notes: List<String>?) {
        val editor = VerificationArgvDialog(project, initialLabel, suggestedArgv.orEmpty())
        if (!editor.showAndGet()) return
        val label = editor.label
        val argv = editor.argv
        val shownNotes = VerificationText.notesForConfirmation(suggestedArgv, notes, argv)
        val lines = VerificationText.approveConfirmation(
            p.name, label, argv, shownNotes, editedFromSuggestion = suggestedArgv != null && shownNotes == null,
        )
        val confirm = VerificationConfirmDialog(project, VerificationText.APPROVE_TITLE, lines, VerificationText.APPROVE_LABEL)
        if (!confirm.showAndGet()) {
            statusLabel.text = "Cancelled. Nothing was sent."
            return
        }
        statusLabel.text = "Approving…"
        connection.commands.verificationApprove(p.id, label, argv).whenComplete { command, error ->
            onEdt {
                if (command != null) {
                    // Core returns the EXISTING command (label unchanged) for a byte-equal live argv.
                    statusLabel.text = "Approved: " + Verifications.item(command.label) +
                        if (command.label != label.trim()) {
                            " (Core returned this label: the same argument list was already approved, and Core keeps its label)"
                        } else {
                            ""
                        }
                } else {
                    report(Verifications.describeFailure(CoreMethods.VERIFICATION_APPROVE, error))
                }
                reload()
            }
        }
    }

    private fun onRevokeClicked() {
        readyProject() ?: return
        val c = commandsList.selectedValue ?: return
        val lines = VerificationText.revokeConfirmation(c.label, c.argv)
        val confirm = VerificationConfirmDialog(project, VerificationText.REVOKE_TITLE, lines, VerificationText.REVOKE_LABEL)
        if (!confirm.showAndGet()) return
        connection.commands.verificationRevoke(c.id).whenComplete { revoked, error ->
            onEdt {
                if (revoked != null) {
                    statusLabel.text = if (revoked) "Revoked: " + Verifications.item(c.label) else "Core answered revoked: false."
                } else {
                    report(Verifications.describeFailure(CoreMethods.VERIFICATION_REVOKE, error))
                }
                reload()
            }
        }
    }

    private fun onRunClicked() {
        readyProject() ?: return
        val task = tasksList.selectedValue ?: return
        VerificationInFlight.releaseExpired(clock())
        VerificationInFlight.blockReason(task.id)?.let {
            statusLabel.text = "Run disabled: $it. Nothing was sent."
            return
        }
        val commands = (0 until commandsModel.size).map { commandsModel.getElementAt(it) }
        if (commands.isEmpty()) {
            statusLabel.text = "Approve a command first. Nothing was sent."
            return
        }
        // expectedSandboxName = the task's BINDING; expectedWorkspaceMode = sandbox.list's mode for it.
        val target = RunTarget.resolve(task.sandboxName, sbx.currentSnapshot().sandboxes)
        if (target !is RunTarget.Bound) {
            statusLabel.text = (target as RunTarget.Unbound).reason + ". Nothing was sent."
            return
        }
        val dialog = VerificationRunDialog(project, task.id, target, commands, ageOf(commandsReadAt))
        if (!dialog.showAndGet()) {
            statusLabel.text = "Cancelled. Nothing was sent."
            return
        }
        val command = dialog.selectedCommand ?: return
        when (val prepared = VerificationRuns.newRun(task.id, command.id, target, connection.capabilities)) {
            is KeyedRequests.Prepared.Refused -> statusLabel.text = VisibleText.reveal(prepared.reason)
            is KeyedRequests.Prepared.Ready -> {
                if (!VerificationInFlight.begin(task.id, clock(), prepared.params.idempotencyKey)) {
                    statusLabel.text = "Run disabled: " + (VerificationInFlight.blockReason(task.id) ?: Verifications.IN_FLIGHT_SENDING) +
                        ". Nothing was sent."
                    return
                }
                dispatchRun(prepared.params, task, command.label)
            }
        }
    }

    private fun onRefreshResultClicked() {
        readyProject() ?: return
        val run = runsList.selectedValue ?: return
        fetchResult(run.runId, announce = true)
    }

    private fun onViewOutputClicked() {
        val run = runsList.selectedValue ?: return
        val result = VerificationActivity.get(run.runId)?.result
        if (result == null) {
            statusLabel.text = "No result read yet for this run; click Refresh result."
            return
        }
        VerificationOutputDialog(project, result).show()
    }

    // -----------------------------------------------------------------------
    // run dispatch, with "Retry safely" only after a lost answer (same key, same params)
    // -----------------------------------------------------------------------

    /** Sends [params] (the in-flight claim for its task is held by the caller) and reports the answer. */
    private fun dispatchRun(params: VerificationRunParams, task: TaskSummary, label: String) {
        statusLabel.text = "Asking Core to start the verification…"
        connection.commands.verificationRun(params).whenComplete { started, error ->
            if (started != null) {
                VerificationActivity.recordStarted(
                    params.taskId, started.runId, params.expectedSandboxName, label, started.startedSequence, started.replayed == true,
                )
                VerificationInFlight.end(params.taskId)
            }
            onEdt {
                if (started != null) {
                    // Follow the task's durable events so verification.finished arrives (read-only), on
                    // the EDT and WITHOUT the panel's (possibly stale) TaskSummary (J-W1).
                    VerificationRuns.followAfterStart(task, tasks::track)
                    statusLabel.text = "Core started run ${VisibleText.reveal(started.runId.take(8))}." +
                        (if (started.replayed == true) " " + Verifications.REPLAY_NOTICE else "") +
                        " Its result is read when Core reports it finished."
                    reloadRuns()
                    return@onEdt
                }
                val shown = Verifications.describeFailure(CoreMethods.VERIFICATION_RUN, error, keyed = params.idempotencyKey != null)
                if (shown.offerRetrySafely) VerificationInFlight.markLost(params.taskId) else VerificationInFlight.end(params.taskId)
                notifyRun(shown, params, task, label)
                refreshControls()
            }
        }
    }

    /**
     * Reports a failed run. "Retry safely" is offered only after a LOST answer of a keyed run and only
     * within [Verifications.RETRY_WINDOW_MILLIS] of the ORIGINAL send (D-I5): the claim records that
     * time, a resend keeps it, and a click after the window refuses with [Verifications.TOO_LATE_TO_RETRY]
     * and releases the claim.
     */
    private fun notifyRun(shown: Verifications.Presentation, params: VerificationRunParams, task: TaskSummary, label: String) {
        val firstSentAt = VerificationInFlight.firstSentAt(params.taskId, params.idempotencyKey)
        val retryOpen = shown.offerRetrySafely && VerificationRuns.retryWindowOpen(firstSentAt, clock())
        if (shown.offerRetrySafely && !retryOpen) VerificationInFlight.end(params.taskId)
        val presented = if (shown.offerRetrySafely && !retryOpen) {
            shown.copy(body = shown.body + " " + Verifications.TOO_LATE_TO_RETRY + ".", offerRetrySafely = false)
        } else {
            shown
        }
        val notification = notification(presented) ?: run {
            if (retryOpen) VerificationInFlight.end(params.taskId)
            return
        }
        if (retryOpen) {
            notification.addAction(
                NotificationAction.createSimpleExpiring(labs.dkv.sandpane.core.KeyedWrites.RETRY_SAFELY_LABEL) {
                    val sentAt = VerificationInFlight.firstSentAt(params.taskId, params.idempotencyKey)
                    when (val again = VerificationRuns.retryRun(params, connection.capabilities, sentAt, clock())) {
                        is KeyedRequests.Prepared.Ready -> {
                            VerificationInFlight.markResending(params.taskId)
                            dispatchRun(again.params, task, label)
                        }
                        is KeyedRequests.Prepared.Refused -> {
                            VerificationInFlight.end(params.taskId)
                            report(
                                Verifications.Presentation(
                                    "Sandpane: verification retry not sent",
                                    VisibleText.reveal(again.reason),
                                    OutcomeSeverity.WARNING,
                                ),
                            )
                            refreshControls()
                        }
                    }
                },
            )
            notification.addAction(
                NotificationAction.createSimpleExpiring("Do not retry") {
                    VerificationInFlight.end(params.taskId)
                    refreshControls()
                },
            )
        }
        notification.notify(project)
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    /** The selected project when Core is ready and advertises verification; else says why and returns null. */
    private fun readyProject(): SandpaneProject? {
        connection.connectionProblem()?.let {
            statusLabel.text = "Core not ready: $it"
            return null
        }
        Verifications.gate(connection.capabilities)?.let {
            statusLabel.text = it
            return null
        }
        return selectedProject() ?: run {
            statusLabel.text = "Choose a project first."
            null
        }
    }

    private fun refreshControls() {
        VerificationInFlight.releaseExpired(clock())
        val problem = connection.connectionProblem()
        val gate = if (problem == null) Verifications.gate(connection.capabilities) else null
        gateLabel.text = when {
            problem != null -> "Core not ready: $problem"
            gate != null -> gate
            else -> "Verification: advertised by this Core. Approve, revoke and run happen only from these buttons."
        }
        val on = problem == null && gate == null && selectedProject() != null
        refreshButton.isEnabled = true
        addButton.isEnabled = on
        revokeButton.isEnabled = on && commandsList.selectedValue != null
        approveButton.isEnabled = on && suggestionsList.selectedValue != null
        detectButton.isEnabled = on
        val task = tasksList.selectedValue
        val target = task?.let { RunTarget.resolve(it.sandboxName, sbx.currentSnapshot().sandboxes) }
        val held = task?.let { VerificationInFlight.blockReason(it.id) }
        runButton.isEnabled = on && target is RunTarget.Bound && !commandsModel.isEmpty && held == null
        taskTargetLabel.text = when {
            task == null -> "Select a task to run an approved command in its sandbox."
            held != null -> "Run disabled: $held."
            target is RunTarget.Bound -> "Run target: sandbox ${VisibleText.reveal(target.sandboxName)} (${target.mode.wireName})"
            target is RunTarget.Unbound -> "Run disabled: ${target.reason}."
            else -> " "
        }
        val run = runsList.selectedValue
        refreshResultButton.isEnabled = on && run != null
        viewOutputButton.isEnabled = run != null && VerificationActivity.get(run.runId)?.result != null
    }

    private fun taskRow(t: TaskSummary): String =
        VisibleText.reveal(t.id.take(8)) + "  " + t.status.describe() + "  ·  " +
            (t.sandboxName?.let { "bound to " + Verifications.item(it) } ?: "not bound to a sandbox")

    private fun runRow(r: VerificationActivity.Run): String =
        "run " + VisibleText.reveal(r.runId.take(8)) + " · task " + VisibleText.reveal(r.taskId.take(8)) +
            (r.label?.let { " · " + Verifications.item(DisplayCap.cap(it, 60)) } ?: "") + " · " +
            (r.result?.let { Verifications.outcomeLine(it) } ?: if (r.finished) "finished; result not read yet" else "started; no finished event yet")

    private fun ageOf(millis: Long): String {
        if (millis <= 0) return "never read"
        val s = (System.currentTimeMillis() - millis) / 1_000
        return if (s < 60) "read ${s}s ago" else "read ${s / 60}m ago"
    }

    private fun report(shown: Verifications.Presentation) {
        statusLabel.text = shown.title
        notification(shown)?.notify(project)
    }

    private fun notification(shown: Verifications.Presentation): com.intellij.notification.Notification? {
        val group = NotificationGroupManager.getInstance().getNotificationGroup("Sandpane") ?: return null
        val type = when (shown.severity) {
            OutcomeSeverity.INFO -> NotificationType.INFORMATION
            OutcomeSeverity.WARNING -> NotificationType.WARNING
            OutcomeSeverity.ERROR -> NotificationType.ERROR
        }
        return group.createNotification(
            NotificationText.escape(VisibleText.reveal(shown.title)),
            NotificationText.escapeMultiline(VisibleText.revealMultiline(shown.body)),
            type,
        )
    }

    private companion object {
        const val DETECT_HINT: String =
            "Click Detect suggestions to ask Core which commands the project's manifests suggest (read-only; " +
                "nothing is run or approved)."
    }

    /** The one EDT hop; a disposed panel runs nothing. */
    private fun onEdt(action: () -> Unit) {
        if (disposed) return
        val app = ApplicationManager.getApplication()
        if (app == null) action() else app.invokeLater { if (!disposed) action() }
    }

    /** Detaches this panel's listeners only; Core and every run are untouched. */
    override fun dispose() {
        disposed = true
        removeStateListener?.invoke()
        removeSnapshotListener?.invoke()
        removeViewListener?.invoke()
    }
}
