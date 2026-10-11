package labs.dkv.sandpane.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTabbedPane
import labs.dkv.sandpane.core.RunTarget
import labs.dkv.sandpane.core.VerificationGuards
import labs.dkv.sandpane.core.Verifications
import labs.dkv.sandpane.model.VerificationCommand
import labs.dkv.sandpane.model.VerificationResult
import labs.dkv.sandpane.text.VisibleText
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import javax.swing.Action
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextArea
import javax.swing.JTextField
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

/**
 * A7 step 1 of approving (§3.7 item 2): the label plus the argv entered as a LIST, one text
 * field per element. There is no one-line field and no shell-like splitting anywhere: what the user
 * types in field N is element N, byte for byte. Element fields keep a pasted LF (Swing's
 * `filterNewlines` is turned off), so a pre-filled suggestion is never silently altered; the
 * confirmation that follows shows every element revealed.
 *
 * Constructed only from VerificationPanel's click handlers (a direct gesture on Sandpane's own
 * button), filled from Core state (a `project.context` suggestion) or empty.
 */
class VerificationArgvDialog(
    project: Project,
    initialLabel: String,
    initialArgv: List<String>,
) : DialogWrapper(project, true) {

    private val labelField = JTextField(initialLabel, 40).also { keepNewlines(it) }
    private val fields = ArrayList<JTextField>()
    private val rows = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS) }
    private val problem = PlainText.label(" ")
    private val listener = object : DocumentListener {
        override fun insertUpdate(e: DocumentEvent) = onChanged()
        override fun removeUpdate(e: DocumentEvent) = onChanged()
        override fun changedUpdate(e: DocumentEvent) = onChanged()
    }

    init {
        title = VerificationText.APPROVE_TITLE
        labelField.document.addDocumentListener(listener)
        (initialArgv.ifEmpty { listOf("") }).forEach(::addField)
        okAction.putValue(Action.NAME, "Continue…")
        init()
        onChanged()
    }

    /** The label exactly as typed (Core trims it). */
    val label: String get() = labelField.text

    /** The elements exactly as typed, in order. */
    val argv: List<String> get() = fields.map { it.text }

    private fun addField(value: String) {
        val field = JTextField(value, 40).also { keepNewlines(it) }
        field.document.addDocumentListener(listener)
        fields += field
        rebuildRows()
    }

    private fun removeField(field: JTextField) {
        if (fields.size <= 1) return
        fields.remove(field)
        rebuildRows()
    }

    private fun rebuildRows() {
        rows.removeAll()
        fields.forEachIndexed { i, field ->
            rows.add(JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
                add(PlainText.label("[${i + 1}]"))
                add(field)
                add(JButton("Remove").apply {
                    isEnabled = fields.size > 1
                    addActionListener { removeField(field) }
                })
                alignmentX = 0f
            })
        }
        rows.revalidate()
        rows.repaint()
        onChanged()
    }

    private fun onChanged() {
        val why = VerificationGuards.labelProblem(label) ?: VerificationGuards.argvProblem(argv)
        problem.text = why?.let { "Core would refuse this: $it" } ?: "${fields.size} element(s). You confirm the exact list in the next step."
        isOKActionEnabled = why == null
    }

    override fun createCenterPanel(): JComponent {
        val header = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(PlainText.label("Label (shown in lists; 1 to 80 characters):"))
            add(JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply { add(labelField); alignmentX = 0f })
            add(PlainText.label("Arguments, one per field (element 1 is the program). No shell: nothing is split, joined or expanded."))
            add(PlainText.label(Verifications.DO_NOT_PUT_SECRETS))
        }
        val add = JButton("Add argument").apply { addActionListener { addField("") } }
        return JPanel(BorderLayout(0, 6)).apply {
            add(header, BorderLayout.NORTH)
            add(JBScrollPane(rows).apply { preferredSize = Dimension(640, 260) }, BorderLayout.CENTER)
            add(JPanel(BorderLayout()).apply {
                add(add, BorderLayout.WEST)
                add(problem, BorderLayout.SOUTH)
            }, BorderLayout.SOUTH)
        }
    }

    override fun getPreferredFocusedComponent(): JComponent = labelField

    companion object {
        /**
         * Swing's `JTextField` replaces a pasted or programmatically set LF with a space unless the
         * document's `filterNewlines` property is false. An element must reach Core byte for byte.
         */
        fun keepNewlines(field: JTextField): JTextField = field.apply {
            document.putProperty("filterNewlines", java.lang.Boolean.FALSE)
        }
    }
}

/**
 * A modal confirmation whose message is [lines] (built by [VerificationText]), shown as PLAIN text:
 * a non-editable, word-wrapping `JTextArea` with `html.disable` set, one line per row (every row is
 * revealed again here, so none can carry a raw line break). Never an HTML view (§3.7 item 6). Cancel
 * is the DEFAULT button and has the initial focus, so Enter or Escape on open cancels; the explicit
 * button is [okLabel]. Used for approve (step 2) and revoke, constructed only from
 * VerificationPanel's click handlers.
 */
class VerificationConfirmDialog(
    project: Project,
    dialogTitle: String,
    private val lines: List<String>,
    okLabel: String,
) : DialogWrapper(project, true) {

    init {
        title = dialogTitle
        okAction.putValue(Action.NAME, okLabel)
        okAction.putValue(DEFAULT_ACTION, null)
        cancelAction.putValue(Action.NAME, VerificationText.CANCEL_LABEL)
        cancelAction.putValue(DEFAULT_ACTION, true)
        init()
    }

    override fun createCenterPanel(): JComponent = JBScrollPane(textPane(lines)).apply { preferredSize = Dimension(720, 440) }

    override fun createActions(): Array<Action> = arrayOf(okAction, cancelAction)

    override fun getPreferredFocusedComponent(): JComponent? = getButton(cancelAction)

    companion object {
        /** The plain text of [lines]: each row revealed single-line, joined by real line breaks. */
        fun plainText(lines: List<String>): String = lines.joinToString("\n") { VisibleText.reveal(it) }

        /** A non-editable plain text area showing [lines]; it interprets no markup at all. */
        fun textPane(lines: List<String>): JTextArea = PlainText.disableHtml(JTextArea(plainText(lines))).apply {
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
            caretPosition = 0
        }
    }
}

/**
 * A7 Run (§3.7 item 8): pick one of the project's approved commands (Core's last
 * `verification.list`) for ONE task whose binding resolved to [target]; the confirmation text below
 * the picker shows the command, sandbox, mode and warnings and is rebuilt when the pick changes.
 * Cancel is the default and focused button. Constructed only from VerificationPanel's Run click
 * handler; it never takes an id or argv from anywhere but Core state.
 */
class VerificationRunDialog(
    project: Project,
    private val taskId: String,
    private val target: RunTarget.Bound,
    commands: List<VerificationCommand>,
    private val stateAge: String,
) : DialogWrapper(project, true) {

    private val picker = JComboBox(commands.toTypedArray()).apply {
        renderer = PlainTextListRenderer { value ->
            val c = value as? VerificationCommand
            (c?.let { Verifications.commandRow(it.label, it.argv) } ?: "no command") to null
        }
        if (commands.isNotEmpty()) selectedIndex = 0
    }
    private val pane = VerificationConfirmDialog.textPane(render())

    init {
        title = VerificationText.RUN_TITLE
        okAction.putValue(Action.NAME, VerificationText.RUN_LABEL)
        okAction.putValue(DEFAULT_ACTION, null)
        cancelAction.putValue(Action.NAME, VerificationText.CANCEL_LABEL)
        cancelAction.putValue(DEFAULT_ACTION, true)
        picker.addActionListener {
            pane.text = VerificationConfirmDialog.plainText(render())
            pane.caretPosition = 0
            isOKActionEnabled = selectedCommand != null
        }
        init()
        isOKActionEnabled = selectedCommand != null
    }

    /** The command the user confirmed: an element of Core's own list, never parsed from text. */
    val selectedCommand: VerificationCommand? get() = picker.selectedItem as? VerificationCommand

    private fun render(): List<String> {
        val c = picker.selectedItem as? VerificationCommand ?: return listOf("No approved command.")
        return VerificationText.runConfirmation(taskId, target, c.label, c.argv)
    }

    override fun createCenterPanel(): JComponent = JPanel(BorderLayout(0, 6)).apply {
        add(JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(PlainText.label("Approved command (Core's list, $stateAge):"))
            add(picker)
        }, BorderLayout.NORTH)
        add(JBScrollPane(pane).apply { preferredSize = Dimension(720, 420) }, BorderLayout.CENTER)
    }

    override fun createActions(): Array<Action> = arrayOf(okAction, cancelAction)

    override fun getPreferredFocusedComponent(): JComponent? = getButton(cancelAction)
}

/**
 * The read-only viewer for one `verification.result` (§3.7 item 6). Output is UNTRUSTED: shown
 * in non-editable plain [JTextArea]s (which never interpret markup) through
 * [Verifications.outputText] — no console, no terminal, no hyperlink or file-link detection, no
 * HTML. There is no run, copy-to-project or open action.
 */
class VerificationOutputDialog(
    project: Project,
    private val result: VerificationResult,
) : DialogWrapper(project, false) {

    init {
        title = "Sandpane: Verification Output"
        isModal = false
        init()
    }

    private fun area(text: String): JTextArea = JTextArea(Verifications.outputText(text)).apply {
        isEditable = false
        lineWrap = false
        font = Font(Font.MONOSPACED, Font.PLAIN, font.size)
        caretPosition = 0
    }

    override fun createCenterPanel(): JComponent {
        val header = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            VerificationText.resultHeader(result).forEach { add(PlainText.label(it)) }
        }
        val tabs = JBTabbedPane().apply {
            addTab("stdout", JBScrollPane(area(result.stdout)))
            addTab("stderr", JBScrollPane(area(result.stderr)))
        }
        return JPanel(BorderLayout(0, 6)).apply {
            add(header, BorderLayout.NORTH)
            add(tabs.apply { preferredSize = Dimension(820, 460) }, BorderLayout.CENTER)
        }
    }

    override fun createActions(): Array<Action> {
        okAction.putValue(Action.NAME, "Close")
        return arrayOf(okAction)
    }
}
