package labs.dkv.sandpane.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import labs.dkv.sandpane.actions.ActionIds
import labs.dkv.sandpane.core.AgentGate
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.core.ErrorAttribution
import labs.dkv.sandpane.core.KeyedCall
import labs.dkv.sandpane.core.KeyedWrites
import labs.dkv.sandpane.core.RenderedEvent
import labs.dkv.sandpane.model.AgentEvent
import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.model.ConversationSendParams
import labs.dkv.sandpane.model.CoreEventKinds
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.PROTOCOL_VERSION
import labs.dkv.sandpane.model.Project as SandpaneProject
import labs.dkv.sandpane.model.SandboxSummary
import labs.dkv.sandpane.model.describe
import labs.dkv.sandpane.text.VisibleText
import labs.dkv.sandpane.services.SandpaneContextProvider
import labs.dkv.sandpane.services.SbxService
import labs.dkv.sandpane.services.TaskMonitorService
import labs.dkv.sandpane.settings.SandpaneSettings
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JSplitPane
import javax.swing.JTextArea
import javax.swing.ListSelectionModel
import javax.swing.Timer
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

/**
 * The Sandpane tool window body: native Swing only (docs/specs/04 §2). No JCEF, no embedded
 * browser, and no Markdown/HTML surface — untrusted agent text is never rendered as markup
 * here. Markdown safety and accessibility are JB4 items after theme testing.
 *
 * ## Where streaming batch dispatch lands (the "never block the EDT" answer)
 *
 * ```text
 * Core socket reader thread (CoreClient.readLoop)
 *   -> EventStream.merge -> TaskMonitorService.onBatch              [background]
 *     -> ChatPanel view listener:
 *          message.delta      -> pendingDeltas.offer(task, seq, text) [lock-free queue, no Swing]
 *          everything else     -> onEdt { ... }                    [invokeLater]
 *   -> javax.swing.Timer(streamFlushIntervalMs, default 50ms)       [fires ON the EDT]
 *     -> drainDeltas() -> DefaultListModel writes -> repaint        [the ONLY paint path]
 * ```
 *
 * No background thread ever touches a component. The queue is the hand-off, so a fast adapter
 * cannot flood the repaint loop (specs/04 §5 risk 2), the retained row count is capped by
 * [MAX_ROWS], and the timer stops itself when the queue drains. Construction happens on the
 * EDT (tool-window content creation), which is also where the timer is started.
 *
 * Known gaps this panel exposes rather than hides:
 *  - the workspace mode a sandbox was bound with is Core's RECORDED `sandbox_bindings` row, not
 *    a live SBX verification; when the field is absent the picker shows UNVERIFIED — TREAT AS
 *    LIVE-WRITABLE rather than a neutral look (docs/specs/02 §7). See [SandboxSummary.modeView].
 *  - the chat picker is filled by `conversation.list`, an ADDITIVE protocol-v1 method. A Core
 *    that does not advertise it leaves the picker empty with the reason in the tooltip — this
 *    panel never fabricates a conversation to send to.
 *  - transcript rows recovered from `conversation.history` are Core's stored messages, rendered
 *    as plain text; a truncated page says so and gives the cursor that continues it.
 *
 * Text safety (security review S1): every label and renderer here that shows Core- or
 * user-provided text has Swing HTML rendering disabled ([PlainText]); tooltips carrying such text
 * are escaped. Nothing a Core string contains is ever interpreted as markup.
 *
 * Selection integrity (review bug 3): the chat picker, the displayed transcript and the Send target
 * are the same conversation — selection survives a refresh by id, any selection change reloads (or
 * clears) the transcript, and the target is printed next to Send. Live task activity is rendered
 * into the transcript only when the task's conversation is the displayed one, or when Core has not
 * (yet) told this client which conversation the task belongs to; those rows carry the task id.
 */
class ChatPanel(
    private val project: Project,
    private val parentDisposable: Disposable,
) : JPanel(BorderLayout()), Disposable {

    /** One message. The list shows [summaryLine]; the details pane shows the full text. */
    data class ChatRow(
        val id: String,
        val role: String,
        val text: String,
        val meta: String?,
    ) {
        fun summaryLine(): String {
            val first = text.lineSequence().firstOrNull { it.isNotBlank() }?.trim() ?: "(empty)"
            val extraLines = (text.lines().size - 1).coerceAtLeast(0)
            val head = "$role: $first"
            return if (extraLines > 0) "$head …(+$extraLines lines)" else head
        }
    }

    /**
     * An editor context item that WAS sent with the last message. Shown for the record only: the
     * selection is quoted into the message body at send time, so there is nothing left to remove
     * (review bug 10 — the old "Remove ×" button removed a chip from a message already sent).
     */
    data class AttachmentChip(val label: String, val target: String)

    private val settings = SandpaneSettings.instance()
    private val connection = ConnectionManager.instance()
    private val sbx = SbxService.instance(project)
    private val tasks = TaskMonitorService.instance(project)
    private val contextProvider = SandpaneContextProvider.instance(project)

    private val rowsModel = DefaultListModel<ChatRow>()
    private val rowsById = HashMap<String, ChatRow>()
    private val messages = JList(rowsModel)
    private val details = JTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
        font = Font(Font.MONOSPACED, Font.PLAIN, 12)
    }

    private val attachmentsModel = DefaultListModel<AttachmentChip>()
    private val attachments = JList(attachmentsModel)

    private val projectModel = DefaultComboBoxModel<SandpaneProject>()
    private val sandboxModel = DefaultComboBoxModel<SandboxSummary>()
    private val agentModel = DefaultComboBoxModel<String>()

    /**
     * Conversations Core reports for the selected project (`conversation.list`, additive in
     * protocol v1). Empty-and-labelled, never invented: when Core does not advertise the method
     * the model stays empty and [conversationState] carries the reason the UI shows.
     */
    private val conversationModel = DefaultComboBoxModel<Conversation>()
    private val projectPicker = JComboBox(projectModel)
    private val sandboxPicker = JComboBox(sandboxModel)
    private val agentPicker = JComboBox(agentModel)
    private val conversationPicker = JComboBox(conversationModel)

    /** Why the chat picker is empty, when it is: not advertised / loading / failed / none. */
    private var conversationState: String = "chat enumeration has not run yet"

    private val composer = JTextArea(4, 60).apply {
        lineWrap = true
        wrapStyleWord = true
        document.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent) { onComposerChanged() }
            override fun removeUpdate(e: DocumentEvent) { onComposerChanged() }
            override fun changedUpdate(e: DocumentEvent) { onComposerChanged() }
        })
    }

    private val sendButton = JButton("Send")

    private val connectionLabel = PlainText.label("  not connected")
    private val contextLabel = PlainText.label("  no editor context")
    private val gateLabel = PlainText.label("  ")
    private val banner = PlainText.label("")

    /** The conversation Send will post to, printed beside the button (review bug 3). */
    private val targetLabel = PlainText.label(ConversationSelection.targetLine(null))

    /**
     * True while this panel repopulates a model itself: Swing fires selection/action events for
     * programmatic changes too, and those must not be mistaken for the user picking something.
     * Replaces the old `hasFocus()` gating, which ignored every non-focus change and so let the
     * picker and the transcript drift apart. EDT-only.
     */
    private var suppressPickerEvents = false

    /** Which conversation the transcript currently shows. EDT-only. */
    private var displayedConversationId: String? = null

    /** Bumped per enumeration / history load; a stale completion is dropped. EDT-only. */
    private var enumerationGeneration = 0

    /** The Core project whose conversations [conversationModel] currently holds. EDT-only. */
    private var conversationsProjectId: String? = null
    private var historyGeneration = 0

    /** Tasks whose replay refusal was already announced in the transcript. EDT-only. */
    private val announcedRefusals = HashMap<String, String>()

    /** taskId → row id for the growing agent message. EDT-owned only. */
    private val streamingRows = HashMap<String, String>()

    /** taskId → the streaming text in durable-sequence order (review W1). EDT-owned only. */
    private val streamingText = HashMap<String, SequencedText>()

    /** One `message.delta`, with the durable sequence that orders it. */
    private data class PendingDelta(val taskId: String, val sequence: Long, val text: String)

    private val pendingDeltas = java.util.concurrent.ConcurrentLinkedQueue<PendingDelta>()
    private val flushTimer: Timer

    /** Set once [dispose] runs; guards [onEdt] because the platform offers no Disposable overload. */
    @Volatile
    private var panelDisposed: Boolean = false

    private var removeStateListener: (() -> Unit)? = null
    private var removeSnapshotListener: (() -> Unit)? = null
    private var removeViewListener: (() -> Unit)? = null

    private var hostMapping: SandpaneContextProvider.HostMapping =
        SandpaneContextProvider.HostMapping.Unsupported("host/path mapping not resolved yet")

    init {
        name = "SandpanePanel"
        border = BorderFactory.createEmptyBorder(4, 6, 4, 6)

        add(buildHeader(), BorderLayout.NORTH)
        add(buildTranscript(), BorderLayout.CENTER)
        add(buildComposer(), BorderLayout.SOUTH)

        messages.selectionMode = ListSelectionModel.SINGLE_SELECTION
        messages.cellRenderer = PlainTextListRenderer(BorderFactory.createEmptyBorder(2, 4, 2, 4)) { value ->
            val row = value as? ChatRow
            if (row == null) (value?.toString() ?: "") to null
            else row.summaryLine() to (row.meta ?: "select to read the full message")
        }
        messages.addListSelectionListener { if (!messages.valueIsAdjusting) showSelectedRowDetails() }
        attachments.cellRenderer = PlainTextListRenderer { value ->
            val chip = value as? AttachmentChip
            if (chip == null) (value?.toString() ?: "") to null else chip.label to chip.target
        }

        flushTimer = Timer(settings.streamFlushIntervalMs) { drainDeltas() }
        flushTimer.isCoalesce = true
        flushTimer.start()

        wireCore()
        // Project changes re-enumerate chats from Core; nothing is cached client-side as truth.
        projectPicker.addActionListener {
            if (!suppressPickerEvents) onSelectedProjectChanged()
        }
        conversationPicker.addActionListener {
            if (!suppressPickerEvents) onConversationSelectionChanged()
        }
        addSystemRow(
            "Sandpane scaffold (JB0/JB1). Projects and sandboxes are read from Core. Chats are " +
                "enumerated with conversation.list when this Core advertises it; the task list is " +
                "hydrated with task.list. Nothing is invented when a method is absent.",
        )
        sbx.refresh()
    }

    /**
     * `conversation.list` for the selected project, on a background thread, with the outcome
     * rendered as text — never as a silently empty picker. The previously selected conversation is
     * kept BY ID when Core still lists it, and the transcript is then reconciled with whatever ends
     * up selected (review bug 3).
     */
    private fun onSelectedProjectChanged() {
        val selected = projectModel.selectedItem as? SandpaneProject
        repopulate {
            sandboxModel.removeAllElements()
            sbx.sandboxesFor(selected?.id).forEach { sandboxModel.addElement(it) }
        }
        val generation = ++enumerationGeneration
        if (selected == null) {
            repopulate { conversationModel.removeAllElements() }
            conversationsProjectId = null
            conversationState = "no project selected"
            onConversationSelectionChanged()
            refreshGateUI()
            return
        }
        conversationState = "loading conversations from Core…"
        sbx.enumerateConversations(selected.id).whenComplete { enumeration, error ->
            onEdt {
                // A newer project selection / refresh superseded this answer: drop it.
                if (generation != enumerationGeneration) return@onEdt
                val listed: List<Conversation> = when {
                    error != null -> {
                        conversationState = ErrorAttribution.describe(CoreMethods.CONVERSATION_LIST, error)
                        emptyList()
                    }

                    enumeration is SbxService.ConversationEnumeration.Available -> {
                        conversationState = if (enumeration.conversations.isEmpty()) {
                            "Core reports no open conversations for this project"
                        } else {
                            enumeration.explain()
                        }
                        enumeration.conversations
                    }

                    enumeration is SbxService.ConversationEnumeration.Failed -> {
                        conversationState = enumeration.explain()
                        emptyList()
                    }

                    else -> {
                        conversationState = "this Core does not advertise conversation.list — " +
                            "chats cannot be enumerated, and none is invented"
                        emptyList()
                    }
                }
                // The selection as it is NOW (the user may have picked another chat while this
                // request was in flight), judged against the project the picker holds (review W2).
                val outcome = ConversationSelection.reconcile(
                    currentSelectedId = selectedConversationId(),
                    modelProjectId = conversationsProjectId,
                    answeredProjectId = selected.id,
                    listed = listed,
                )
                repopulate {
                    conversationModel.removeAllElements()
                    listed.forEach { conversationModel.addElement(it) }
                    // Explicit, by id — never DefaultComboBoxModel's implicit "first added" pick.
                    conversationModel.selectedItem = outcome.choice
                }
                conversationsProjectId = selected.id
                outcome.vanishedId?.let { gone ->
                    addSystemRow(
                        "The conversation previously selected (${gone.take(8)}) is no longer " +
                            "listed by Core for this project; the selection changed and the transcript follows it.",
                    )
                }
                conversationPicker.toolTipText = PlainText.tooltip(conversationState)
                conversationPicker.isEnabled = conversationModel.size > 0
                onConversationSelectionChanged()
                refreshGateUI()
            }
        }
        // Task rows come from task.list when advertised; the replay path stays otherwise.
        tasks.hydrateFromTaskList(selected.id).whenComplete { hydration, error ->
            onEdt {
                val text = if (error != null) {
                    ErrorAttribution.describe(CoreMethods.TASK_LIST, error)
                } else {
                    hydration.describe()
                }
                gateLabel.toolTipText = PlainText.tooltip(text)
                if (hydration is TaskMonitorService.Hydration.Loaded && hydration.tasks.isNotEmpty()) {
                    addSystemRow(text)
                }
            }
        }
    }

    /** Run a programmatic model change without it counting as a user selection. EDT-only. */
    private inline fun repopulate(change: () -> Unit) {
        val prior = suppressPickerEvents
        suppressPickerEvents = true
        try {
            change()
        } finally {
            suppressPickerEvents = prior
        }
    }

    /**
     * The selected conversation changed — by the user or by a refresh. Brings the transcript and
     * the Send-target line in line with it; a no-op when they already agree.
     */
    private fun onConversationSelectionChanged() {
        val selected = conversationModel.selectedItem as? Conversation
        targetLabel.text = ConversationSelection.targetLine(selected)
        targetLabel.toolTipText = PlainText.tooltip(
            selected?.let { "Send posts to Core conversation ${it.id} · agent ${it.agentId}" }
                ?: "No conversation is selected; Send will refuse rather than invent one.",
        )
        if (!ConversationSelection.transcriptOutOfSync(selected?.id, displayedConversationId)) return
        if (selected == null) {
            clearTranscript()
            displayedConversationId = null
            historyGeneration++
            addSystemRow("No conversation selected: the transcript is empty and Send is refused.")
        } else {
            loadConversationHistory(selected)
        }
        refreshGateUI()
    }

    private fun clearTranscript() {
        rowsModel.removeAllElements()
        rowsById.clear()
        streamingRows.clear()
        streamingText.clear()
        details.text = ""
    }

    /**
     * `conversation.history` for [conversation]: one bounded page of Core's stored messages plus,
     * when the page stopped early, a visible disclosure and the cursor that continues it. Rows are
     * plain text; content is data and is never rendered as markup.
     */
    private fun loadConversationHistory(conversation: Conversation) {
        clearTranscript()
        displayedConversationId = conversation.id
        val generation = ++historyGeneration
        addSystemRow("loading transcript of ${ConversationSelection.displayName(conversation)} from Core…")
        connection.conversationHistory(conversation.id).whenComplete { page, error ->
            onEdt {
                // The user (or a refresh) moved on to another conversation: drop this page.
                if (generation != historyGeneration) return@onEdt
                if (error != null) {
                    // NOT_FOUND on an archived or unknown conversation is Core's verdict and is
                    // shown as such — not turned into an empty transcript that reads as "no
                    // messages". A refusal this plugin raised before sending says so instead.
                    addSystemRow(ErrorAttribution.describe(CoreMethods.CONVERSATION_HISTORY, error))
                    return@onEdt
                }
                if (page == null) return@onEdt
                for (message in page.messages) {
                    addRow(
                        ChatRow(
                            id = "core-${message.id}",
                            role = message.role,
                            text = message.content,
                            meta = "sequence ${message.sequence} · stored by Core",
                        ),
                    )
                }
                page.truncationNote()?.let { addSystemRow(it) }
                addSystemRow(
                    "transcript from Core: ${page.messages.size} message(s)${
                        if (page.truncated) " (truncated — resume after sequence ${page.nextSequence})" else ""
                    }",
                )
            }
        }
    }

    // -----------------------------------------------------------------------
    // layout
    // -----------------------------------------------------------------------

    private fun buildHeader(): JComponent {
        val group = DefaultActionGroup()
        val actionManager = ActionManager.getInstance()
        ActionIds.ALL.forEach { id -> actionManager.getAction(id)?.let { group.add(it) } }
        val toolbar = actionManager
            .createActionToolbar("SandpaneToolWindow", group, true)
            .apply { targetComponent = this@ChatPanel }

        val pickers = JPanel(FlowLayout(FlowLayout.LEFT, 6, 2)).apply {
            add(PlainText.label("Project"))
            add(projectPicker.apply { preferredSize = Dimension(170, 26) })
            add(PlainText.label("Chat"))
            add(conversationPicker.apply { preferredSize = Dimension(160, 26) })
            add(PlainText.label("Sandbox"))
            add(sandboxPicker.apply { preferredSize = Dimension(180, 26) })
            add(PlainText.label("Agent"))
            add(agentPicker.apply { preferredSize = Dimension(150, 26) })
        }

        projectPicker.renderer = PlainTextListRenderer { value ->
            val project = value as? SandpaneProject
            if (project == null) "no project" to null
            else project.name to "Core project ${project.id}"
        }
        agentPicker.renderer = PlainTextListRenderer { value -> (value?.toString() ?: "") to null }

        sandboxPicker.renderer = PlainTextListRenderer { value ->
            val sandbox = value as? SandboxSummary
            if (sandbox == null) {
                (value?.toString() ?: "") to null
            } else {
                val mode = sandbox.modeView()
                // Two different claims, never merged into one: `probedState` is what SBX was last
                // seen doing; `workspaceMode` is what Core RECORDED it was asked to bind. A null
                // mode is Core's honest absence and renders as UNVERIFIED, never as safe
                // (docs/specs/02 §7, specs/04 §3).
                "${sandbox.name} ● ${sandbox.probedState ?: "state not probed"} · ${mode.badge}" to
                    "state: last probed by Core; SBX owns sandbox state.\nmode: ${mode.explanation}"
            }
        }

        conversationPicker.renderer = PlainTextListRenderer { value ->
            val conversation = value as? Conversation
            if (conversation == null) {
                "no conversation" to "conversation.list is not advertised by this Core, or it lists none"
            } else {
                ConversationSelection.displayName(conversation) to
                    "Core conversation ${conversation.id} · agent ${conversation.agentId} · created ${conversation.createdAt}"
            }
        }

        return JPanel(BorderLayout()).apply {
            add(toolbar.component, BorderLayout.WEST)
            add(pickers, BorderLayout.CENTER)
            add(banner.apply { border = BorderFactory.createEmptyBorder(2, 6, 2, 6) }, BorderLayout.SOUTH)
        }
    }

    private fun buildTranscript(): JComponent {
        val list = JScrollPane(messages).apply {
            preferredSize = Dimension(320, 240)
            border = BorderFactory.createTitledBorder("Conversation")
        }
        val detail = JScrollPane(details).apply {
            border = BorderFactory.createTitledBorder("Message detail (plain text; never rendered as markup)")
        }
        return JSplitPane(JSplitPane.VERTICAL_SPLIT, list, detail).apply {
            resizeWeight = 0.55
            dividerLocation = 260
        }
    }

    private fun buildComposer(): JComponent {
        val chips = JPanel(BorderLayout()).apply {
            // Record of what went out with the LAST message — not an editable attachment list.
            add(PlainText.label("Sent with last message"), BorderLayout.NORTH)
            add(
                JScrollPane(attachments.apply {
                    selectionMode = ListSelectionModel.SINGLE_SELECTION
                    preferredSize = Dimension(220, 56)
                }).apply { horizontalScrollBarPolicy = JScrollPane.HORIZONTAL_SCROLLBAR_NEVER },
                BorderLayout.CENTER,
            )
        }

        val input = JScrollPane(composer).apply {
            preferredSize = Dimension(320, 84)
            border = BorderFactory.createTitledBorder("Message")
        }
        sendButton.addActionListener { sendFromComposer() }

        val sendColumn = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(Box.createVerticalGlue())
            add(targetLabel)
            add(sendButton)
        }

        val bottom = JPanel(BorderLayout()).apply {
            add(chips, BorderLayout.WEST)
            add(input, BorderLayout.CENTER)
            add(sendColumn, BorderLayout.EAST)
        }

        val status = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            border = BorderFactory.createCompoundBorder(
                BorderFactory.createMatteBorder(1, 0, 0, 0, java.awt.Color(128, 128, 128)),
                BorderFactory.createEmptyBorder(3, 4, 3, 4),
            )
            add(connectionLabel)
            add(Box.createHorizontalStrut(12))
            add(contextLabel)
            add(Box.createHorizontalGlue())
            add(gateLabel)
        }

        return JPanel(BorderLayout()).apply {
            add(bottom, BorderLayout.CENTER)
            add(status, BorderLayout.SOUTH)
        }
    }

    // -----------------------------------------------------------------------
    // Core wiring — callbacks arrive on background threads
    // -----------------------------------------------------------------------

    private fun wireCore() {
        removeStateListener = connection.addStateListener { state -> applyState(state) }

        removeSnapshotListener = sbx.addSnapshotListener { snapshot ->
            onEdt {
                val previouslySelected = (projectModel.selectedItem as? SandpaneProject)?.id
                val projects = snapshot.projects.orEmpty()
                repopulate {
                    projectModel.removeAllElements()
                    projects.forEach { projectModel.addElement(it) }
                    // A refresh re-asks Core; it does not reuse a cached conversation list. The
                    // selection is preserved by id when Core still reports that project.
                    projectModel.selectedItem =
                        projects.firstOrNull { it.id == previouslySelected } ?: projects.firstOrNull()
                }
                banner.text = snapshot.failure
                    ?.let { "Core problem: $it (${snapshot.describeAge()})" }
                    ?: "projects and sandboxes ${snapshot.describeAge()}"
                onSelectedProjectChanged()
                refreshGateUI()
            }
        }

        removeViewListener = tasks.addViewListener { taskId, view, rendered ->
            val delta = (rendered?.agentEvent as? AgentEvent.MessageDelta)?.text
            if (delta != null && rendered != null) {
                // Hand-off only: no Swing access on this thread. The sequence travels with the
                // text so a hole-filling delta lands at its position, not at the end.
                pendingDeltas.offer(PendingDelta(taskId, rendered.taskEvent.sequence, delta))
                // start() resets the countdown, so it is only called when the timer stopped.
                if (!flushTimer.isRunning) flushTimer.start()
            } else {
                onEdt { applyTaskEvent(taskId, view, rendered) }
            }
        }
    }

    private fun applyState(state: ConnectionManager.State) {
        onEdt {
            connectionLabel.text = "  " + when (state) {
                is ConnectionManager.State.Ready ->
                    "Core ${state.capabilities.coreVersion} · ${shorten(state.socketPath)}"

                is ConnectionManager.State.Connecting -> "connecting (retry #${state.attempt})…"
                is ConnectionManager.State.Handshaking -> "negotiating protocol…"
                is ConnectionManager.State.Unavailable -> "Core down: ${state.reason}"
                is ConnectionManager.State.VersionMismatch ->
                    "protocol mismatch: Core v${state.coreProtocolVersion}, client v$PROTOCOL_VERSION"

                is ConnectionManager.State.TransportUnsupported -> "transport unsupported: ${state.reason}"
                is ConnectionManager.State.Idle -> "idle"
            }

            val caps = (state as? ConnectionManager.State.Ready)?.capabilities
            if (caps != null) {
                agentModel.removeAllElements()
                caps.agents.forEach { agentModel.addElement(if (it.verified) it.id else "${it.id} (unverified)") }
            }
            hostMapping = contextProvider.hostMapping()
            refreshGateUI()
        }
    }

    /** The single place that decides whether an action is allowed, from Core state. */
    private fun refreshGateUI() {
        val problem = connection.connectionProblem()
        val gate = connection.agentGate()
        val mapping = hostMapping
        gateLabel.text = "  " + if (gate is AgentGate.Open) "streaming: ${gate.streamingAdapterIds}" else "chat unsupported"

        val blocker: String? = problem
            ?: (mapping as? SandpaneContextProvider.HostMapping.Unsupported)?.reason
            ?: gate.reasonForUser().takeUnless { gate.chatEnabled }

        val blocked = blocker != null
        composer.isEnabled = !blocked
        sendButton.isEnabled = !blocked && composer.text.isNotBlank()
        sendButton.toolTipText = PlainText.tooltip(blocker ?: "Send this text plus the editor context to Core")
        composer.toolTipText = PlainText.tooltip(blocker ?: "Type a message for the selected conversation")
        banner.text = blocker
            ?: "projects and sandboxes ${sbx.currentSnapshot().describeAge()}"
    }

    /**
     * Does live activity for [taskId] belong in the transcript currently shown? Unknown
     * attribution is shown (labelled with the task id) rather than hidden. EDT-only.
     */
    private fun belongsToDisplayedConversation(taskId: String, view: TaskMonitorService.TaskView?): Boolean {
        val conversationId = (view ?: tasks.view(taskId))?.conversationId ?: return true
        return conversationId == displayedConversationId
    }

    /** Runs on the EDT only (Swing Timer fires on the EDT). */
    private fun drainDeltas() {
        if (pendingDeltas.isEmpty()) {
            flushTimer.stop()
            // Lost-wakeup guard (review bug 8): a producer that offered between the isEmpty()
            // check and stop() saw the timer still running and did not start it. Re-check after
            // stopping; whichever side runs last restarts the timer.
            if (!pendingDeltas.isEmpty() && !panelDisposed) flushTimer.start()
            return
        }
        val changed = LinkedHashSet<String>()
        while (true) {
            val next = pendingDeltas.poll() ?: break
            // Another conversation's stream is Core-stored; it appears when that chat is opened.
            if (!belongsToDisplayedConversation(next.taskId, null)) continue
            if (streamingText.getOrPut(next.taskId) { SequencedText() }.put(next.sequence, next.text)) {
                changed += next.taskId
            }
        }
        changed.forEach { taskId -> renderStreamingRow(taskId) }
        trimRows()
    }

    /** Re-render one task's streaming row from its sequence-ordered text. EDT-only. */
    private fun renderStreamingRow(taskId: String) {
        val text = streamingText[taskId]?.toString().orEmpty()
        if (text.isEmpty()) return
        val rowId = streamingRows.getOrPut(taskId) { "agent-$taskId" }
        val existing = rowsById[rowId]
        val row = ChatRow(
            id = rowId,
            role = "agent",
            text = text,
            meta = "task ${taskId.take(8)} · streaming (${settings.streamFlushIntervalMs}ms flush)",
        )
        if (existing == null) rowsModel.addElement(row) else rowsModel.setElementAt(row, rowsModel.indexOf(existing))
        rowsById[rowId] = row
        if (messages.selectedIndex < 0 || messages.selectedValue?.id == rowId) showDetails(row.text)
    }

    private fun applyTaskEvent(taskId: String, view: TaskMonitorService.TaskView, rendered: RenderedEvent?) {
        if (!belongsToDisplayedConversation(taskId, view)) return
        val event = rendered?.agentEvent
        val line: String? = when (event) {
            is AgentEvent.ToolStarted -> "tool ${event.name} started (${event.id})"
            is AgentEvent.ToolFinished ->
                "tool finished ${if (event.ok) "ok" else "FAILED"} (${event.id})" +
                    (event.summary?.let { " — $it" } ?: "")

            is AgentEvent.FileChanged -> "file changed: ${event.path}"
            is AgentEvent.ApprovalRequired -> "approval required (${event.requestId}): ${event.description}"
            is AgentEvent.TaskCompleted -> "task ${taskId.take(8)} completed ok=${event.ok}"
            is AgentEvent.Failed -> "error ${event.code}: ${event.message}"
            is AgentEvent.UnsupportedEvent -> "unverified provider event: ${event.providerType}"
            is AgentEvent.Malformed -> "unrecognized ${event.wireType}: ${event.reason}"
            null -> rendered?.note
            else -> null
        }
        val kind = rendered?.taskEvent?.kind
        if (line != null) {
            val prefix = if (kind != null && CoreEventKinds.ALL.contains(kind)) "[$kind] " else ""
            addSystemRow(prefix + line)
        }
        announceReplayRefusal(taskId, view.replayRefusal)
        updateRowStatus(taskId, view)
    }

    /**
     * Review bug 5: Core refused this task's replay and polling for it stopped. Said once per
     * refusal (and once when a reconnect re-arms it), never repeated per poll interval.
     */
    private fun announceReplayRefusal(taskId: String, refusal: String?) {
        val announced = announcedRefusals[taskId]
        if (refusal == announced) return
        if (refusal != null) {
            announcedRefusals[taskId] = refusal
            addSystemRow(
                "task ${taskId.take(8)}: updates stopped — $refusal The transcript for this task may be " +
                    "incomplete until Sandpane reconnects to Core.",
            )
        } else if (announced != null) {
            announcedRefusals.remove(taskId)
            addSystemRow("task ${taskId.take(8)}: Core connection renewed; replay for this task is being retried once.")
        }
    }

    private fun updateRowStatus(taskId: String, view: TaskMonitorService.TaskView) {
        val rowId = "agent-$taskId"
        val row = rowsById[rowId] ?: return
        val updated = row.copy(meta = "task ${taskId.take(8)} · ${view.statusLabel} (reported by Core)")
        val index = rowsModel.indexOf(row)
        if (index >= 0) rowsModel.setElementAt(updated, index)
        rowsById[rowId] = updated
    }

    // -----------------------------------------------------------------------
    // user actions
    // -----------------------------------------------------------------------

    private fun sendFromComposer() {
        val content = composer.text.trim()
        if (content.isEmpty()) return
        val conversationId = selectedConversationId()
        if (conversationId == null) {
            addSystemRow(
                "Nothing was sent: no conversation is selected. " +
                    (if (conversationState.contains("does not advertise")) {
                        "This Core does not advertise conversation.list, so no conversation can be " +
                            "enumerated — creating one implicitly would be a fake integration."
                    } else {
                        "Core reports no open conversation for this project ($conversationState)."
                    }),
            )
            return
        }
        val snapshot = contextProvider.collect()
        contextLabel.text = "  " + snapshot.describeForStatusBar()
        val params = ConversationSendParams(
            conversationId = conversationId,
            content = contextProvider.buildContent(content, snapshot),
            attachments = snapshot.attachments,
        )
        composer.text = ""
        addAttachmentChips(snapshot)
        addUserRow(content)
        sendButton.isEnabled = false

        handleSend(tasks.send(params))
    }

    /**
     * Report one keyed send (A2). A replay is announced as such and the task rows are re-read from
     * Core; an unknown outcome of a KEYED send gets a "Retry safely" notification action that resends
     * the identical params with the same key — on that explicit click only, never automatically.
     */
    private fun handleSend(call: KeyedCall<ConversationSendParams, TaskMonitorService.SendResult>) {
        call.result.whenComplete { result, error ->
            onEdt {
                if (error != null) {
                    val text = KeyedWrites.describe(CoreMethods.CONVERSATION_SEND, KeyedWrites.classify(error), call.keyed)
                    addSystemRow(text.body)
                    if (text.offerRetrySafely) offerRetrySafely(call.params, text)
                } else if (result != null) {
                    val notice = KeyedWrites.replayNotice(result.replayed)
                    if (notice != null) {
                        // Never a fresh success, never its stored status: say so and re-read Core.
                        val id = when (result) {
                            is TaskMonitorService.SendResult.FromSummary -> result.taskId
                            is TaskMonitorService.SendResult.TaskIdOnly -> result.taskId
                        }
                        addSystemRow("$notice (task ${VisibleText.reveal(id.take(8))})")
                        val selected = projectPicker.selectedItem as? SandpaneProject
                        if (selected == null) {
                            addSystemRow("No project is selected, so task.list cannot be re-read here; use Refresh.")
                        } else {
                            tasks.hydrateFromTaskList(selected.id).whenComplete { hydration, hydrationError ->
                                onEdt {
                                    addSystemRow(
                                        if (hydrationError != null) {
                                            ErrorAttribution.describe(CoreMethods.TASK_LIST, hydrationError)
                                        } else {
                                            "Re-read after the replay: ${hydration.describe()}"
                                        },
                                    )
                                }
                            }
                        }
                    } else {
                        addSystemRow(
                            when (result) {
                                is TaskMonitorService.SendResult.FromSummary ->
                                    // An unknown status is still an ACCEPTED task: Core queued it.
                                    "Core accepted task ${result.taskId.take(8)} · status reported by Core: " +
                                        result.summary.status.describe()

                                is TaskMonitorService.SendResult.TaskIdOnly ->
                                    "Core accepted task ${result.taskId.take(8)} (id-only response; see protocol gap 2)"
                            },
                        )
                    }
                }
                refreshGateUI()
            }
        }
    }

    /** A notification whose single, expiring action is the explicit "Retry safely" resend. */
    private fun offerRetrySafely(params: ConversationSendParams, text: KeyedWrites.Text) {
        val group = NotificationGroupManager.getInstance().getNotificationGroup("Sandpane") ?: return
        val notification = group.createNotification(
            NotificationText.escape(VisibleText.reveal(text.title)),
            NotificationText.escapeMultiline(VisibleText.revealMultiline(text.body)),
            NotificationType.ERROR,
        )
        notification.addAction(
            NotificationAction.createSimpleExpiring(KeyedWrites.RETRY_SAFELY_LABEL) {
                if (panelDisposed) return@createSimpleExpiring
                addSystemRow("Retrying safely with the same idempotency key (identical request).")
                handleSend(tasks.retrySendSafely(params))
            },
        )
        notification.notify(project)
    }

    private fun addUserRow(content: String) {
        addRow(ChatRow("user-${System.nanoTime()}", "you", content, contextLabel.text.trim()))
    }

    private fun addSystemRow(text: String) {
        addRow(ChatRow("system-${System.nanoTime()}", "sandpane", text, null))
    }

    private fun addRow(row: ChatRow) {
        rowsModel.addElement(row)
        rowsById[row.id] = row
        trimRows()
    }

    private fun addAttachmentChips(snapshot: SandpaneContextProvider.Snapshot) {
        attachmentsModel.removeAllElements()
        snapshot.activeFile?.let {
            attachmentsModel.addElement(AttachmentChip("file ${it.substringAfterLast('/')}", "attached as a file reference: $it"))
        }
        if (snapshot.hasSelection) {
            attachmentsModel.addElement(
                AttachmentChip(
                    "selection ${snapshot.selectionStartLine}–${snapshot.selectionEndLine}",
                    "quoted into the message body that was sent" +
                        if (snapshot.truncated) " (truncated to the context budget)" else "",
                ),
            )
        }
    }

    private fun onComposerChanged() {
        val gateAllows = connection.connectionProblem() == null && connection.agentGate().chatEnabled &&
            hostMapping is SandpaneContextProvider.HostMapping.Supported
        sendButton.isEnabled = gateAllows && composer.text.isNotBlank()
    }

    private fun trimRows() {
        while (rowsModel.size() > MAX_ROWS) {
            val dropped = rowsModel.remove(0)
            rowsById.remove(dropped.id)
            val droppedTasks = streamingRows.filterValues { it == dropped.id }.keys
            droppedTasks.forEach { streamingText.remove(it) }
            streamingRows.keys.removeAll(droppedTasks)
        }
    }

    private fun showSelectedRowDetails() {
        messages.selectedValue?.let { showDetails(it.text) }
    }

    /**
     * The full message body. A JTextArea never renders HTML, but agent text could still carry bidi
     * overrides or zero-width characters that reorder or hide what is read (the "Trojan Source"
     * shape), so those are shown escaped; real line breaks and tabs are kept.
     */
    private fun showDetails(text: String) {
        details.text = VisibleText.revealMultiline(text)
    }

    /**
     * The conversation messages are sent to: Core's own record, selected in the picker, and only
     * ever populated from `conversation.list`. Null when Core does not advertise that method or
     * reports none — [sendFromComposer] then refuses rather than inventing an id (AGENTS.md
     * rule 5). Conversation selection is a UI preference; the conversation itself is Core state.
     */
    private fun selectedConversationId(): String? =
        (conversationModel.selectedItem as? Conversation)?.id

    private fun shorten(path: String): String =
        if (path.length <= 28) path else "…" + path.takeLast(26)

    /**
     * The one EDT hop in this panel. `Application.invokeLater` has no `(Runnable, Disposable)`
     * overload on the pinned baseline, so expiry is a plain disposed flag checked inside the
     * runnable: a queued row update that lands after the tool window closed is dropped instead
     * of touching dead components.
     */
    private fun onEdt(action: () -> Unit) {
        // A disposed panel runs NOTHING: late whenComplete handlers used to execute their Swing
        // code inline on the completing (background) thread here (review bug 1).
        if (panelDisposed) return
        val app = ApplicationManager.getApplication()
        if (app == null) action() else app.invokeLater { if (!panelDisposed) action() }
    }

    /** Detaches every subscription. Core tasks are untouched by design. */
    override fun dispose() {
        panelDisposed = true
        flushTimer.stop()
        removeStateListener?.invoke()
        removeSnapshotListener?.invoke()
        removeViewListener?.invoke()
        removeStateListener = null
        removeSnapshotListener = null
        removeViewListener = null
        pendingDeltas.clear()
        rowsById.clear()
        streamingRows.clear()
        streamingText.clear()
        announcedRefusals.clear()
    }

    companion object {
        /** Cap on the retained view model (docs/specs/04 §5 risk 2). */
        const val MAX_ROWS = 400
    }
}
