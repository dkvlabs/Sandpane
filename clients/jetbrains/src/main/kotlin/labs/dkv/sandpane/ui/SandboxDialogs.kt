package labs.dkv.sandpane.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import labs.dkv.sandpane.core.IssuedRemoval
import labs.dkv.sandpane.model.SandboxSummary
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.Action
import javax.swing.DefaultComboBoxModel
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * The `sandbox.remove` confirmation message (design 2026-10-09 §2), separate from the action so its
 * exact content is unit-tested.
 *
 * Every Core-supplied value — name, sbx id, expiry, each impact line — goes through [DialogHtml],
 * which reveals hidden characters single-line ([labs.dkv.sandpane.text.VisibleText.reveal]) and
 * HTML-escapes them; impact lines are table rows, so a crafted line cannot lay itself out as a fake
 * entry or header. The only bold text is this plugin's own headers. The token is never shown.
 */
object RemoveConfirmation {

    /** Impact lines shown; the rest are counted in one overflow line (Core's list is not bounded). */
    const val MAX_IMPACT_LINES: Int = 20

    /**
     * First, bold header whenever Core reports `external` — the exact wording every Sandpane client
     * uses. It deliberately does not say "made outside Sandpane": `external` also covers a pre-A1
     * binding with no recorded sbx id and a binding for an earlier same-named sandbox.
     */
    const val EXTERNAL_HEADER: String = "NOT CONFIRMED AS CREATED BY SANDPANE"

    /** The plain line under [EXTERNAL_HEADER] (shared wording across clients). */
    const val EXTERNAL_TEXT: String =
        "Core cannot confirm Sandpane created this sandbox (no Sandpane binding is recorded for this sbx id)."

    /** Constant dialog title and button labels: the platform renders the title as HTML too. */
    const val TITLE: String = "Sandpane: Remove Sandbox"
    const val REMOVE_LABEL: String = "Remove Sandbox"
    const val CANCEL_LABEL: String = "Cancel"

    fun message(issued: IssuedRemoval): DialogHtml {
        val html = DialogHtml()
        if (issued.external) html.header(EXTERNAL_HEADER).line(EXTERNAL_TEXT).blank()
        html.line("Remove this sandbox? Core runs `sbx rm --force` for it; this cannot be undone.")
            .fields(
                "sandbox" to issued.name,
                "sbx id" to issued.target.id,
                "confirmation expires" to issued.expiresAt,
            )
            .blank()
        if (issued.impact.isEmpty()) {
            html.line("Core reported no impact lines for this removal.")
        } else {
            html.header("Impact, as reported by Core (${issued.impact.size} line(s)):")
            html.entries("", issued.impact.take(MAX_IMPACT_LINES))
            val more = issued.impact.size - MAX_IMPACT_LINES
            if (more > 0) html.line("… and $more more impact line(s) not shown")
        }
        return html
            .blank()
            .line("The confirmation is single-use and expires as shown; Core re-checks that the sandbox is")
            .line("still the same one (same sbx id) before removing it. Cancel sends nothing further.")
    }
}

/**
 * Picks the sandbox a lifecycle action targets, from the last Core snapshot (every sandbox sbx
 * lists — including ones NOT bound to a Sandpane project, which the chat picker hides, because those
 * are exactly the ones a remove must be able to reach and label as external).
 *
 * Rows go through [PlainTextListRenderer]: Core-supplied names and states are revealed, never
 * rendered as HTML. Shown on the EDT; it makes no Core call.
 */
class SandboxChooserDialog(
    project: Project,
    dialogTitle: String,
    private val okLabel: String,
    sandboxes: List<SandboxSummary>,
    private val snapshotAge: String,
) : DialogWrapper(project, true) {

    private val model = DefaultComboBoxModel(sandboxes.toTypedArray())
    private val combo = JComboBox(model).apply {
        renderer = PlainTextListRenderer { value -> describe(value as? SandboxSummary) }
    }

    init {
        title = dialogTitle
        init()
    }

    val selected: SandboxSummary? get() = combo.selectedItem as? SandboxSummary

    override fun createCenterPanel(): JComponent = JPanel(BorderLayout(0, 8)).apply {
        add(PlainText.label("Sandbox (from Core's list, $snapshotAge):"), BorderLayout.NORTH)
        add(combo.apply { preferredSize = Dimension(460, preferredSize.height) }, BorderLayout.CENTER)
    }

    override fun createActions(): Array<Action> {
        okAction.putValue(Action.NAME, okLabel)
        return arrayOf(okAction, cancelAction)
    }

    override fun getPreferredFocusedComponent(): JComponent = combo

    companion object {
        /** One row: two separate claims (probed state, binding) plus the agent sbx reports. */
        fun describe(sandbox: SandboxSummary?): Pair<String, String?> {
            if (sandbox == null) return "no sandbox" to null
            val state = sandbox.probedState ?: "state not probed"
            val binding = if (sandbox.boundProjectId != null) "bound to a Sandpane project" else "no Sandpane binding"
            val agent = sandbox.agent?.let { "agent $it (reported by sbx, not verified)" } ?: "agent not reported"
            return "${sandbox.name} ● $state · $binding" to "$binding\n$agent\n${sandbox.modeView().badge}"
        }
    }
}
