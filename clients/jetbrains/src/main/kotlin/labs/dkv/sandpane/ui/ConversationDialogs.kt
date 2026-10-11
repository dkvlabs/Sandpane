package labs.dkv.sandpane.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import labs.dkv.sandpane.core.ConversationGuards
import labs.dkv.sandpane.core.ConversationUiState
import labs.dkv.sandpane.core.ExportCopy
import labs.dkv.sandpane.core.ExportDocument
import labs.dkv.sandpane.core.ExportOutcome
import labs.dkv.sandpane.core.IssuedConversationDelete
import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.Action
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextField

/**
 * The `conversation.delete` confirmation message (A3b, the A1 two-step pattern), separate from the
 * panel so its exact content is unit-tested. Every Core value — title, id, expiry, impact lines — is
 * capped ([DisplayCap]) and goes through [DialogHtml] (revealed single-line, HTML-escaped). The token
 * is never shown. `external` is always false for a conversation, so there is no external banner
 * ([labs.dkv.sandpane.core.ConversationDeleteCheck] refuses an answer that claims it).
 */
object ConversationDeleteConfirmation {

    const val MAX_IMPACT_LINES: Int = 20

    /** Constant title and labels: the platform renders the title as HTML too. */
    const val TITLE: String = "Sandpane: Delete Conversation"
    const val DELETE_LABEL: String = "Delete Conversation"
    const val CANCEL_LABEL: String = "Cancel"

    fun message(issued: IssuedConversationDelete): DialogHtml {
        val html = DialogHtml()
            .line("Delete this conversation from Sandpane Core? This cannot be undone in Core.")
            .fields(
                "conversation" to DisplayCap.cap(issued.name),
                "conversation id" to DisplayCap.cap(issued.conversationId),
                "confirmation expires" to DisplayCap.cap(issued.expiresAt),
            )
            .blank()
        if (issued.impact.isEmpty()) {
            html.line("Core reported no impact lines for this delete.")
        } else {
            html.header("Impact, as reported by Core (${issued.impact.size} line(s)):")
            html.entries("", issued.impact.take(MAX_IMPACT_LINES).map { DisplayCap.cap(it) })
            val more = issued.impact.size - MAX_IMPACT_LINES
            if (more > 0) html.line("… and $more more impact line(s) not shown")
        }
        return html
            .blank()
            .line("The confirmation is single-use and bound to this conversation id; it expires as shown and is")
            .line("checked again when you click. Cancel sends nothing further.")
    }
}

/** The copy shown BEFORE an export starts and in the save dialog (after the pages were read). */
object ConversationExportCopy {

    const val TITLE: String = "Sandpane: Export Conversation"
    const val EXPORT_LABEL: String = "Export…"
    const val CANCEL_LABEL: String = "Cancel"

    /** Before: what is exported, and that redaction is best-effort. */
    fun before(conversation: Conversation): DialogHtml = DialogHtml()
        .line("Export this conversation's messages to a JSON file you choose?")
        .fields(
            "conversation" to DisplayCap.cap(ConversationUiState.label(conversation)),
            "conversation id" to DisplayCap.cap(conversation.id),
        )
        .blank()
        .line("Core redacts the export (tokens, keys, credentials in URLs, secret-looking values).")
        .line(ExportCopy.BEST_EFFORT)
        .line(ExportCopy.SCOPE)

    /** The save dialog's description: the replacement count and whether the export is complete. */
    fun saveDescription(document: ExportDocument): String =
        "${document.messageCount} message(s)" +
            (if (document.complete) "" else " — PARTIAL: ${VisibleText.reveal(document.stopReason ?: "stopped early")}") +
            ". ${ExportOutcome.summary(document)} ${ExportCopy.BEST_EFFORT}"
}

/** The pure part of [ConversationRenameDialog], unit-tested without Swing. */
object ConversationRenames {

    /**
     * The title to send, or null when nothing changed. The baseline is the FIELD's own text when the
     * dialog opened (a JTextField turns a stored newline into a space), so an untouched pre-rule title
     * is never "renamed" to what the field happened to show. Sent exactly as typed (Core does not trim).
     */
    fun change(baseline: String, typed: String): String? = typed.takeIf { it != baseline }
}

/**
 * Rename Conversation (`conversation.rename`). Validation mirrors Core EXACTLY ([ConversationGuards]):
 * 1–200 characters, no control or bidi/separator characters, whitespace-only refused, no trimming.
 */
class ConversationRenameDialog(
    project: Project,
    private val original: Conversation,
) : DialogWrapper(project, true) {

    private val titleField = JTextField(original.title, 40)

    /** The field's text right after construction — the baseline for "changed" (see [ConversationRenames]). */
    private val baseline: String = titleField.text

    init {
        title = "Sandpane: Rename Conversation"
        init()
    }

    /** What to send: null = unchanged. */
    val result: String? get() = ConversationRenames.change(baseline, titleField.text)

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(GridBagLayout())
        val c = GridBagConstraints().apply {
            gridx = 0
            fill = GridBagConstraints.HORIZONTAL
            weightx = 1.0
            insets = Insets(2, 0, 2, 0)
        }
        fun add(component: JComponent) {
            c.gridy++
            panel.add(component, c)
        }
        c.gridy = -1
        // Core's current values, revealed and capped (a pre-rule title may hold characters the field hides).
        add(
            PlainText.label(
                "Core conversation ${VisibleText.reveal(DisplayCap.cap(original.id))} — current title: " +
                    VisibleText.reveal(DisplayCap.cap(original.title)),
            ),
        )
        add(PlainText.label("Title (1–${ConversationGuards.MAX_TITLE_CHARS} characters, one line, not only spaces):"))
        add(titleField)
        return panel
    }

    override fun doValidate(): ValidationInfo? {
        val r = result ?: return ValidationInfo("Nothing changed.", titleField).asWarning().withOKEnabled()
        ConversationGuards.renameTitleProblem(r)?.let { return ValidationInfo("Core would refuse: $it", titleField) }
        return null
    }

    override fun createActions(): Array<Action> {
        okAction.putValue(Action.NAME, "Rename in Core")
        return arrayOf(okAction, cancelAction)
    }

    override fun getPreferredFocusedComponent(): JComponent = titleField
}
