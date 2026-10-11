package labs.dkv.sandpane.ui

import labs.dkv.sandpane.services.ApplyPlan
import java.io.StringReader
import javax.swing.JList
import javax.swing.text.Element
import javax.swing.text.StyleConstants
import javax.swing.text.html.HTML
import javax.swing.text.html.HTMLDocument
import javax.swing.text.html.HTMLEditorKit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Security finding (review of af8949b): confirmations shown by `Messages.showDialog` (the pre-A6
 * Apply dialog among them; A6 lays the same [DialogHtml] out in its own `DialogWrapper`), which on IntelliJ 2026.2 parses its message as HTML even without an `<html>` prefix (see
 * [DialogText]). These tests parse [DialogText.html] with the JDK's own `HTMLEditorKit` — the same
 * Swing HTML parser family the platform panes sit on, NOT the platform's `HTMLEditorKitBuilder`
 * (no IntelliJ impl class is touched here) — and assert that crafted paths render inert: no markup
 * element is created, the literal characters are shown, and the line structure is exactly the
 * structure this plugin wrote.
 */
class DialogTextTest {

    private fun parse(html: String): HTMLDocument {
        val kit = HTMLEditorKit()
        val doc = kit.createDefaultDocument() as HTMLDocument
        kit.read(StringReader(html), doc, 0)
        return doc
    }

    private fun elements(root: Element): Sequence<Element> = sequence {
        yield(root)
        for (i in 0 until root.elementCount) yieldAll(elements(root.getElement(i)))
    }

    /**
     * Every HTML tag the parser honoured: block/special tags become elements (NameAttribute), while
     * character-level tags such as `<b>` become an attribute KEY on the content runs they wrap.
     */
    private fun tagsIn(doc: HTMLDocument): Set<HTML.Tag> =
        elements(doc.defaultRootElement).flatMap { element ->
            val attrs = element.attributes
            val keys = attrs.attributeNames.toList().filterIsInstance<HTML.Tag>()
            keys + listOfNotNull(attrs.getAttribute(StyleConstants.NameAttribute) as? HTML.Tag)
        }.toSet()

    private fun brCount(doc: HTMLDocument): Int = elements(doc.defaultRootElement)
        .count { it.attributes.getAttribute(StyleConstants.NameAttribute) == HTML.Tag.BR }

    /** Rendered characters, with the `&nbsp;` this plugin emits for kept spaces read back as spaces. */
    private fun renderedText(doc: HTMLDocument): String = doc.getText(0, doc.length).replace('\u00A0', ' ')

    private val crafted = listOf(
        "src/<b>bold</b>.kt",
        "src/</html><h1>APPROVED</h1>.kt",
        "src/<img src='http://example.invalid/x.png'>.kt",
        "src/evil.kt\n  [9] src/fake.kt",
        "src/invoice\u202Etxt.exe",
        "src/con\u200Bfig.kt",
        "src/a &amp; b.kt",
    )

    /** The Apply dialog's path list, built the way [ApplyConfirmation] builds it. */
    private fun pathDialog(paths: List<String>): String = DialogHtml()
        .header("files (${paths.size}) — exactly these are sent as the selection:")
        .entries("", ApplyPlan.listPaths(paths).cells)
        .line("base commit: abc")
        .build()

    private fun rowCount(doc: HTMLDocument): Int = elements(doc.defaultRootElement)
        .count { it.attributes.getAttribute(StyleConstants.NameAttribute) == HTML.Tag.TR }

    /** Text of every run the parser rendered bold. */
    private fun boldRuns(doc: HTMLDocument): List<String> = elements(doc.defaultRootElement)
        .filter { it.isLeaf && it.attributes.isDefined(HTML.Tag.B) }
        .map { doc.getText(it.startOffset, it.endOffset - it.startOffset).replace('\u00A0', ' ').trim() }
        .filter { it.isNotEmpty() }
        .toList()

    @Test
    fun craftedPathsRenderInertInTheConfirmationHtml() {
        val html = pathDialog(crafted)
        val doc = parse(html)

        val tags = tagsIn(doc)
        for (forbidden in listOf(HTML.Tag.H1, HTML.Tag.IMG)) {
            assertFalse(forbidden in tags, "a path created a <$forbidden> element: $html")
        }
        // Bold is this plugin's own weight for headers and markers; no path may produce it.
        val bold = boldRuns(doc)
        assertTrue(
            bold.all { it.startsWith("files (") || Regex("""\[\d+]""").matches(it) },
            "bold text that is not a header or marker: $bold",
        )
        val text = renderedText(doc)
        assertTrue(text.contains("src/<b>bold</b>.kt"), "markup must be shown literally: $text")
        assertTrue(text.contains("src/</html><h1>APPROVED</h1>.kt"), text)
        assertTrue(text.contains("src/a &amp; b.kt"), "an entity in a path must not be decoded: $text")
        assertTrue(text.contains("""src/evil.kt\n  [9] src/fake.kt"""), text)
        assertTrue(text.contains("""src/invoice\u202Etxt.exe"""), text)
        assertFalse(text.contains('\u202E') || text.contains('\u200B'), "hidden characters must not reach the pane")

        // Structure is exactly ours: one table row per path, and no path adds a line break.
        assertEquals(crafted.size, rowCount(doc), "a path must not add or remove an entry: $html")
        assertEquals(0, brCount(doc), "a path must not add a line break: $html")
    }

    /**
     * Negative control: the SAME message without [DialogText], preprocessed the way the platform's
     * AlertDialog does it (raw text, `\n` → `<br/>`, parsed as HTML — see [DialogText]), does build
     * markup and does gain lines. Proves the assertions above can fail on this JVM.
     */
    @Test
    fun controlCaseTheRawMessageWouldRenderMarkupAndExtraLines() {
        val raw = "files (2):\n  [1] src/<b>bold</b>.kt\n  [2] src/</p><h1>APPROVED</h1><img src=x>.kt"
        val doc = parse(raw.replace("\n", "<br/>"))
        val tags = tagsIn(doc)
        assertTrue(HTML.Tag.B in tags && HTML.Tag.H1 in tags && HTML.Tag.IMG in tags, "control did not render markup: $tags")
        assertFalse(renderedText(doc).contains("<b>"), "control should have consumed the tags")
    }

    @Test
    fun pathCellsInTheDialogHaveNoBreakableSpaceInsideAPath() {
        val bait = "src/" + "x".repeat(60) + ".kt   [2] src/fake.kt"
        val html = pathDialog(listOf(bait, "ok.kt"))
        val cells = Regex("<td valign=top>(.*?)</td>").findAll(html).map { it.groupValues[1] }.toList()
        assertEquals(2, cells.size, html)
        cells.forEach { cell -> assertFalse(cell.contains(' '), "breakable space in dialog cell: $cell") }
    }

    @Test
    fun whitespaceRunsSurviveSoNearIdenticalPathsStayDistinct() {
        val paths = listOf("a b.kt", "a  b.kt", "a   b.kt")
        val doc = parse(pathDialog(paths))
        val cells = elements(doc.defaultRootElement)
            .filter { it.attributes.getAttribute(StyleConstants.NameAttribute) == HTML.Tag.TD }
            .map { doc.getText(it.startOffset, it.endOffset - it.startOffset).replace('\u00A0', ' ').trim() }
            .toList()
        assertEquals(listOf("[1]", "a b.kt", "[2]", "a  b.kt", "[3]", "a   b.kt"), cells)
    }

    @Test
    fun theEnvelopeIsWhatEveryPlatformRendererNeeds() {
        val html = DialogText.html("plain\nline <two>")
        // MessageDialog/InputDialog switch to HTML only on this prefix (BasicHTML.isHTMLString),
        // and AlertDialog would otherwise parse the raw text as HTML anyway.
        assertTrue(html.startsWith("<html>") && html.endsWith("</html>"), html)
        assertFalse(html.contains('\n'), "AlertDialog rewrites raw newlines; none may remain")
        assertEquals("<html>plain<br>line &lt;two&gt;</html>", html)
    }

    @Test
    fun legitimateNonAsciiSurvivesTheDialogRoundTrip() {
        val paths = listOf("src/日本語/ファイル.kt", "docs/файл.md", "café/résumé.txt", "assets/🚀.png")
        val text = renderedText(parse(pathDialog(paths)))
        paths.forEach { assertTrue(text.contains(it), "missing $it in $text") }
        assertFalse(text.contains(ApplyPlan.HIDDEN_CHARS_FLAG))
    }
}

/** Labels, list rows and tooltips show hidden characters escaped, never obeyed. */
class RevealingSurfacesTest {

    @Test
    fun aPlainLabelShowsHiddenCharactersEscapedEvenWhenTextIsSetLater() {
        val label = PlainText.label("title\u202Eexe.txt")
        assertEquals("""title\u202Eexe.txt""", label.text)
        label.text = "line one\nline two"
        assertEquals("""line one\nline two""", label.text)
        label.text = "Атлас 日本 🚀"
        assertEquals("Атлас 日本 🚀", label.text, "ordinary non-ASCII is untouched")
    }

    @Test
    fun aListRowIsOneLineAndTheTooltipKeepsRealLineBreaksOnly() {
        val renderer = PlainTextListRenderer { value -> value.toString() to "first\nsecond\u200B" }
        val component = renderer.getListCellRendererComponent(JList<String>(), "a\nb\u2066c", 0, false, false)
            as javax.swing.JLabel
        assertEquals("""a\nb\u2066c""", component.text)
        assertEquals("""<html>first<br>second\u200B</html>""", component.toolTipText)
    }

    @Test
    fun actionDescriptionsAreInertAndRevealed() {
        assertEquals("""‹b›x‹/b›\nfake""", PlainText.inert("<b>x</b>\nfake"))
    }
}
