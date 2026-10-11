package labs.dkv.sandpane.ui

import labs.dkv.sandpane.text.VisibleText
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
 *
 * Disabling HTML is not enough on its own: a raw newline, bidi override or zero-width character
 * still changes what a plain label shows. Every surface here therefore also passes its text
 * through [VisibleText] (security review of af8949b), single-line for labels and list rows,
 * multi-line for tooltips.
 */
object PlainText {

    /** The client-property key `BasicHTML` checks before building an HTML view. */
    const val HTML_DISABLE_KEY: String = "html.disable"

    fun <T : JComponent> disableHtml(component: T): T = component.apply {
        putClientProperty(HTML_DISABLE_KEY, java.lang.Boolean.TRUE)
    }

    /**
     * A label that never renders HTML and always shows hidden characters escaped — including text
     * assigned later through `label.text = …`, which is how most call sites update it.
     */
    fun label(text: String = ""): JLabel = disableHtml(RevealingLabel()).apply { this.text = text }

    /** [JLabel] whose text is always single-line and free of hidden characters ([VisibleText.reveal]). */
    private class RevealingLabel : JLabel() {
        override fun setText(text: String?) {
            // Called by JLabel's own constructor too; this override uses no instance state.
            super.setText(text?.let(VisibleText::reveal))
        }
    }

    /**
     * Text for surfaces whose rendering this plugin does not control and that may be either plain
     * or HTML depending on where the platform shows them — action `description`s appear in the
     * status bar AND in HTML tooltips (review suggestion 4). Escaping would print `&lt;` in the
     * plain surface, so angle brackets are replaced by the look-alike single guillemets instead:
     * readable in both, and no tag can form.
     */
    fun inert(text: String): String =
        VisibleText.reveal(text).replace('<', '\u2039').replace('>', '\u203A')

    /** Escaped, explicitly-HTML tooltip text: safe in both Swing and IntelliJ tooltip renderers. */
    fun tooltip(text: String?): String? =
        text?.let { "<html>" + NotificationText.escapeMultiline(VisibleText.revealMultiline(it)) + "</html>" }
}

/**
 * Messages for `Messages.showDialog` / `Messages.showInputDialog`, which this plugin uses for
 * explicit confirmations whose text carries Core- and agent-supplied data (file paths, task ids,
 * base commits, the user's own file names).
 *
 * Verified on the pinned IntelliJ IDEA 2026.2.3 (262.10968.63) by disassembling the platform
 * classes the public API dispatches to (no internal API is called from this plugin):
 *  - `Messages.showDialog` → `MessagesService.showMessageDialog` → `AlertMessagesManager` →
 *    `com.intellij.ui.messages.AlertDialog`, whose message pane is ALWAYS `text/html` (it calls
 *    `setContentType("text/html")` unconditionally and rewrites `\n` to `<br/>`). A plain-text
 *    message is therefore parsed as HTML — a path containing `<b>` or `</html>` is markup there.
 *    The fallback `MessageDialog` renders HTML only when the text starts with `<html>`
 *    (`Messages.configureMessagePaneUi` checks `BasicHTML.isHTMLString`).
 *  - `Messages.showInputDialog` → `Messages.InputDialog`: HTML pane when the text starts with
 *    `<html>`, otherwise a `JLabel` with `MultiLineLabelUI`.
 * An explicit `<html>` envelope around fully-escaped text renders as literal characters on ALL
 * three paths, which a plain string cannot guarantee. Whitespace runs are kept as `&nbsp;` so two
 * paths differing only in spacing stay distinguishable, and hidden characters are escaped first
 * ([VisibleText.revealMultiline]).
 *
 * Titles and button labels passed next to such a message must stay compile-time constants: the
 * AlertDialog title is an HTML pane as well.
 */
object DialogText {
    fun html(message: String): String =
        VisibleText.revealMultiline(message).split('\n').joinToString(
            separator = "<br>",
            prefix = "<html>",
            postfix = "</html>",
        ) { line -> keepSpaces(NotificationText.escape(line)) }

    /** HTML collapses whitespace: keep every space after the first of a run, and leading ones. */
    internal fun keepSpaces(line: String): String = buildString(line.length + 16) {
        var previousWasSpace = true // a space at line start would be dropped as well
        for (c in line) {
            when (c) {
                ' ' -> {
                    append(if (previousWasSpace) "&nbsp;" else " ")
                    previousWasSpace = true
                }

                '\t' -> {
                    append("&nbsp;&nbsp;&nbsp;&nbsp;")
                    previousWasSpace = true
                }

                else -> {
                    append(c)
                    previousWasSpace = false
                }
            }
        }
    }
}

/**
 * A confirmation message with STRUCTURE — plugin-written lines and headers, plus numbered lists
 * of agent- or Core-supplied entries — rendered to the same `<html>` envelope as [DialogText].
 *
 * Why a list is a table (security review of the JetBrains anti-spoofing change, C1): the
 * platform's AlertDialog lays its message out with a word-wrap view factory, which force-breaks an
 * over-long unbreakable run at the pane width. With one `<br>`-separated line per entry, the
 * wrapped tail of a crafted path started at the left margin — exactly where real `[n]` markers
 * and section headers start — so a path could render a pixel-identical fake entry or a fake
 * section header. Here every entry is one table row: its marker in a `nowrap` column of its
 * own, its text in the next column. However the text wraps, every tail stays inside the text
 * column, to the right of every real marker; headers sit outside the tables at the left margin and
 * are bold. Escaped text cannot produce HTML bold, but Unicode "mathematical bold" letters LOOK
 * bold — paths containing them are flagged ([labs.dkv.sandpane.services.ApplyPlan.HIDDEN_CHARS_FLAG]),
 * and the column layout, not the weight, is what keeps a path from posing as a header.
 *
 * Every value passed in is revealed single-line ([VisibleText.reveal]) and HTML-escaped here; the
 * only unescaped markup is this builder's own.
 */
class DialogHtml {
    private val body = StringBuilder()
    private val run = mutableListOf<String>()

    /** One plugin-written line; any Core/agent value inside it is revealed and escaped. */
    fun line(text: String): DialogHtml = apply { run += lineHtml(text) }

    /** A section header: a line in HTML bold, which escaped values cannot produce (see the class KDoc). */
    fun header(text: String): DialogHtml = apply { run += "<b>${lineHtml(text)}</b>" }

    fun blank(): DialogHtml = apply { run += "&nbsp;" }

    /**
     * One row per entry: `[<markerPrefix><n>]` in its own column, the entry text in the next.
     * [cells] are shown exactly as given after revealing and escaping, so callers pass the already
     * display-shaped text (e.g. [labs.dkv.sandpane.services.ApplyPlan.displayPath]).
     */
    fun entries(markerPrefix: String, cells: List<String>): DialogHtml = apply {
        if (cells.isEmpty()) return@apply
        flushRun()
        body.append("<table cellpadding=0 cellspacing=0>")
        cells.forEachIndexed { index, cell ->
            body.append("<tr><td valign=top nowrap><b>&nbsp;&nbsp;[")
                .append(NotificationText.escape(markerPrefix)).append(index + 1)
                .append("]&nbsp;</b></td><td valign=top>")
                .append(DialogText.keepSpaces(NotificationText.escape(VisibleText.reveal(cell))))
                .append("</td></tr>")
        }
        body.append("</table>")
    }

    /**
     * Labelled values, one table row each: the plugin's own [label] in a `nowrap` column, the
     * revealed and escaped value in the next. A long value (a file name the agent chose) wraps
     * inside its own column and can never start a line at the left margin.
     */
    fun fields(vararg rows: Pair<String, String>): DialogHtml = apply {
        if (rows.isEmpty()) return@apply
        flushRun()
        body.append("<table cellpadding=0 cellspacing=0>")
        for ((label, value) in rows) {
            body.append("<tr><td valign=top nowrap>&nbsp;&nbsp;")
                .append(NotificationText.escape(label)).append(":&nbsp;</td><td valign=top>")
                .append(DialogText.keepSpaces(NotificationText.escape(VisibleText.reveal(value))))
                .append("</td></tr>")
        }
        body.append("</table>")
    }

    fun build(): String {
        flushRun()
        return "<html>$body</html>"
    }

    private fun lineHtml(text: String): String =
        DialogText.keepSpaces(NotificationText.escape(VisibleText.reveal(text))).ifEmpty { "&nbsp;" }

    private fun flushRun() {
        if (run.isEmpty()) return
        body.append(run.joinToString("<br>"))
        run.clear()
    }
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
        // A list row is one line: Core text with a newline, bidi override or zero-width character
        // is shown with those characters escaped rather than obeyed.
        this.text = VisibleText.reveal(text)
        toolTipText = PlainText.tooltip(tip)
        padding?.let { border = it }
        return this
    }
}
