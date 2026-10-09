package labs.dkv.sandpane.ui

import java.awt.Component
import javax.swing.DefaultListCellRenderer
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JList

/**
 * Security review S1: Swing renders any label/renderer text that starts with `<html>` as HTML —
 * including Core-provided conversation titles, sandbox names, error messages and agent ids, and
 * user file names. Every component in this plugin that shows such text sets the standard
 * `html.disable` client property, which `javax.swing.plaf.basic.BasicHTML.updateRenderer` honours,
 * so the text is always drawn literally.
 *
 * Tooltips are rendered by a SEPARATE tooltip component that does not inherit the owner's
 * property, so tooltip text goes through [tooltip], which escapes the content and wraps it in an
 * explicit `<html>` envelope: markup in Core text is shown as characters, newlines become breaks.
 */
object PlainText {

    /** The client-property key `BasicHTML` checks before building an HTML view. */
    const val HTML_DISABLE_KEY: String = "html.disable"

    fun <T : JComponent> disableHtml(component: T): T = component.apply {
        putClientProperty(HTML_DISABLE_KEY, java.lang.Boolean.TRUE)
    }

    fun label(text: String = ""): JLabel = disableHtml(JLabel()).apply { this.text = text }

    /**
     * Text for surfaces whose rendering this plugin does not control and that may be either plain
     * or HTML depending on where the platform shows them — action `description`s appear in the
     * status bar AND in HTML tooltips (review suggestion 4). Escaping would print `&lt;` in the
     * plain surface, so angle brackets are replaced by the look-alike single guillemets instead:
     * readable in both, and no tag can form.
     */
    fun inert(text: String): String = text.replace('<', '\u2039').replace('>', '\u203A')

    /** Escaped, explicitly-HTML tooltip text: safe in both Swing and IntelliJ tooltip renderers. */
    fun tooltip(text: String?): String? =
        text?.let { "<html>" + NotificationText.escapeMultiline(it) + "</html>" }
}

/** HTML escaping for surfaces the platform renders as HTML (notifications, tooltips). */
object NotificationText {
    fun escape(text: String): String = buildString(text.length + 16) {
        for (c in text) {
            when (c) {
                '&' -> append("&amp;")
                '<' -> append("&lt;")
                '>' -> append("&gt;")
                '"' -> append("&quot;")
                '\'' -> append("&#39;")
                else -> append(c)
            }
        }
    }

    fun escapeMultiline(text: String): String = escape(text).replace("\r\n", "\n").replace("\n", "<br>")
}

/**
 * A list/combo renderer that never interprets its text as HTML. [present] maps a value to the
 * literal text and an optional (plain) tooltip; it runs on the EDT during painting only.
 */
class PlainTextListRenderer(
    /** Applied after each render, because DefaultListCellRenderer resets its border per cell. */
    private val padding: javax.swing.border.Border? = null,
    private val present: (Any?) -> Pair<String, String?>,
) : DefaultListCellRenderer() {

    init {
        PlainText.disableHtml(this)
    }

    override fun getListCellRendererComponent(
        list: JList<*>?,
        value: Any?,
        index: Int,
        isSelected: Boolean,
        cellHasFocus: Boolean,
    ): Component {
        super.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus)
        // super() already set text = value.toString(); the property is set in init, before any
        // text, so BasicHTML never builds a view for it. Re-assert in case a LaF reset it.
        putClientProperty(PlainText.HTML_DISABLE_KEY, java.lang.Boolean.TRUE)
        val (text, tip) = present(value)
        this.text = text
        toolTipText = PlainText.tooltip(tip)
        padding?.let { border = it }
        return this
    }
}
