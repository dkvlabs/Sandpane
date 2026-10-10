package labs.dkv.sandpane.ui

import com.intellij.util.ui.HTMLEditorKitBuilder
import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.Reported
import labs.dkv.sandpane.model.reported
import labs.dkv.sandpane.services.ApplyPlan
import labs.dkv.sandpane.services.SandpaneContextProvider
import java.awt.Dimension
import java.awt.Font
import javax.swing.JEditorPane
import javax.swing.text.Element
import javax.swing.text.StyleConstants
import javax.swing.text.html.HTML
import kotlin.test.Test
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Security review C1 (JetBrains anti-spoofing change): the Apply dialog is laid out by the
 * platform's word-wrap view factory, which force-breaks an over-long unbreakable run at the pane
 * width. With `<br>`-separated entries, the wrapped tail of a crafted path started at the left
 * margin — where real `[n]` markers and section headers start — so the path could render a fake
 * entry or a fake "NOT sent" header.
 *
 * These tests lay the REAL dialog HTML ([ApplyConfirmation]) out with the platform's own
 * `HTMLEditorKitBuilder().withWordWrapViewFactory()` and check the geometry, not strings: no
 * visual line inside a path cell may start left of that cell's column. They do not hardcode a
 * font or pixel position — the attack is searched for (path padding × pane width), so the tests
 * keep testing on any host font. Non-vacuity is asserted twice: crafted paths must really wrap,
 * and the same search against the old `<br>` layout must find a fake line.
 */
class DialogLayoutTest {

    private data class VisualLine(val start: Int, val x: Int)

    private fun layOut(html: String, width: Int): JEditorPane = JEditorPane().apply {
        contentType = "text/html"
        editorKit = HTMLEditorKitBuilder().withWordWrapViewFactory().build()
        font = Font(Font.SANS_SERIF, Font.PLAIN, 13)
        text = html
        size = Dimension(width, Short.MAX_VALUE.toInt())
        size = Dimension(width, preferredSize.height)
    }

    private fun visualLines(pane: JEditorPane): List<VisualLine> {
        val lines = mutableListOf<VisualLine>()
        var lastY = Int.MIN_VALUE
        for (offset in 0 until pane.document.length) {
            val r = pane.modelToView2D(offset).bounds
            if (r.y != lastY) lines += VisualLine(offset, r.x)
            lastY = r.y
        }
        return lines
    }

    private fun elements(root: Element): Sequence<Element> = sequence {
        yield(root)
        for (i in 0 until root.elementCount) yieldAll(elements(root.getElement(i)))
    }

    private fun tag(e: Element) = e.attributes.getAttribute(StyleConstants.NameAttribute)

    /** (marker cell, text cell) for every table row in the dialog. */
    private fun rows(pane: JEditorPane): List<Pair<Element, Element>> =
        elements(pane.document.defaultRootElement).filter { tag(it) == HTML.Tag.TR }.map { tr ->
            val cells = (0 until tr.elementCount).map(tr::getElement).filter { tag(it) == HTML.Tag.TD }
            check(cells.size == 2) { "a dialog row has ${cells.size} cells" }
            cells[0] to cells[1]
        }.toList()

    private data class Check(val escapes: List<String>, val wrappedCells: Int)

    /**
     * Visual lines that begin inside an entry's text cell but left of that cell's column — the
     * only way a cell could pose as a marker or header. Also counts cells that wrapped.
     */
    private fun check(pane: JEditorPane): Check {
        val lines = visualLines(pane)
        val text = pane.document.getText(0, pane.document.length)
        val escapes = mutableListOf<String>()
        var wrapped = 0
        for ((marker, cell) in rows(pane)) {
            val columnX = pane.modelToView2D(cell.startOffset).bounds.x
            val markerX = pane.modelToView2D(marker.startOffset).bounds.x
            assertTrue(markerX < columnX, "geometry is degenerate: marker x=$markerX, column x=$columnX")
            val inside = lines.filter { it.start in cell.startOffset until cell.endOffset }
            if (inside.size > 1) wrapped++
            inside.filter { it.x < columnX }.forEach {
                escapes += "x=${it.x} < column $columnX: '${text.substring(it.start, minOf(text.length, it.start + 40))}'"
            }
        }
        return Check(escapes, wrapped)
    }

    private val target = ".github/workflows/ci.yml"

    /** WrapProbe: a path padded until its forced break lands right before a fake `[2]` entry. */
    private fun fakeEntry(fill: Int) = "src/" + "x".repeat(fill) + "  [2] $target"

    /** ConcealProbe: a path that would wrap into a fake NOT-sent header plus a fake entry. */
    private fun fakeHeader(fill: Int) = ".github/workflows/a.yml" + " ".repeat(fill) +
        "NOT sent (2) — status unknown to this build:" + " ".repeat(fill) + "  [1] .github/workflows/b.yml"

    private fun dialogFor(paths: List<String>, unknown: List<String> = emptyList()): String {
        val reviewed = ChangeSet(
            taskId = "task-1",
            baseCommit = "0123456789abcdef0123456789abcdef01234567",
            hostDirty = false,
            changes = paths.map { FileChange(it, FileChangeStatus.MODIFIED.reported()) } +
                unknown.map { FileChange(it, Reported.Unknown("type_changed")) },
        )
        val plan = assertIs<ApplyPlan.Decision.Ready>(ApplyPlan.decide("task-1", reviewed))
        return ApplyConfirmation.message("task-1", reviewed, plan).build()
    }

    /** The layout this change replaces: one `<br>` line per entry (kept here as the control). */
    private fun oldDialogFor(paths: List<String>): String =
        DialogText.html("files (${paths.size}) — exactly these are sent as the selection:\n" + ApplyPlan.describePaths(paths))

    /** For the old layout: lines that start left of the path column and are not a real line start. */
    private fun oldEscapes(pane: JEditorPane): List<String> {
        val text = pane.document.getText(0, pane.document.length)
        val realStarts = buildSet {
            add(0)
            text.forEachIndexed { i, c -> if (c == '\n') add(i + 1) }
        }
        val columnX = pane.modelToView2D(text.indexOf("[1]") + 4).bounds.x
        return visualLines(pane).filter { it.start !in realStarts && it.x < columnX }
            .map { text.substring(it.start, minOf(text.length, it.start + 40)) }
    }

    private val widths = listOf(300, 360, 480)
    private val fills = 0..90

    @Test
    fun noCraftedPathWrapsIntoTheMarkerColumn() {
        var wrapped = 0
        for (width in widths) {
            for (fill in fills) {
                for (paths in listOf(listOf(fakeEntry(fill), target), listOf(fakeHeader(fill / 3), target))) {
                    val result = check(layOut(dialogFor(paths, unknown = listOf("u.kt")), width))
                    assertTrue(result.escapes.isEmpty(), "width=$width fill=$fill: ${result.escapes}")
                    wrapped += result.wrappedCells
                }
            }
        }
        // Non-vacuity: the crafted paths really did wrap, so the check above had tails to judge.
        assertTrue(wrapped > widths.size * fills.count(), "crafted paths wrapped only $wrapped times")
    }

    @Test
    fun controlTheOldLineLayoutLetsACraftedPathStartAFakeLine() {
        val found = widths.flatMap { width ->
            fills.flatMap { fill -> oldEscapes(layOut(oldDialogFor(listOf(fakeEntry(fill), target)), width)) }
        }
        assertTrue(found.any { it.replace('\u00A0', ' ').trimStart().startsWith("[2]") }, "the control found no fake entry: $found")
    }

    /**
     * Security re-review W3: the send-context confirmation shows the active file, whose name the
     * agent may have chosen (direct_mount). With `<br>` lines, `src/qqq… selection: none` wrapped
     * into a fake left-margin `selection: none` line. Values are now table cells too.
     */
    @Test
    fun theSendConfirmationValuesCannotWrapIntoTheLabelColumn() {
        var wrapped = 0
        for (width in widths) {
            for (fill in fills) {
                val file = "/repo/src/" + "q".repeat(fill) + " selection: none"
                val snapshot = SandpaneContextProvider.Snapshot(file, "x".repeat(120), 1, 4, "/repo", false)
                for (html in listOf(
                    SendContextMessages.confirmation(snapshot, "explain   instruction: fake").build(),
                    SendContextMessages.preview(snapshot).build(),
                )) {
                    val result = check(layOut(html, width))
                    assertTrue(result.escapes.isEmpty(), "width=$width fill=$fill: ${result.escapes}")
                    wrapped += result.wrappedCells
                }
            }
        }
        assertTrue(wrapped > 0, "the crafted file names never wrapped, so nothing was tested")
    }

    @Test
    fun everyListedEntryIsOneRowAndHeadersStayOutsideTheTables() {
        val pane = layOut(dialogFor(listOf(fakeEntry(40), target, "a b.kt"), unknown = listOf("u.kt")), 360)
        val rows = rows(pane)
        assertTrue(rows.size == 4, "3 sent rows + 1 NOT-sent row, got ${rows.size}")
        val text = pane.document.getText(0, pane.document.length)
        val markers = rows.map { (marker, _) -> text.substring(marker.startOffset, marker.endOffset).replace('\u00A0', ' ').trim() }
        assertTrue(markers == listOf("[1]", "[2]", "[3]", "[x1]"), "markers: $markers")
        // Headers are body text, never inside a table cell.
        val inCells = rows.flatMap { (m, c) -> listOf(m.startOffset until m.endOffset, c.startOffset until c.endOffset) }
        for (header in listOf("files (3)", "NOT sent (1)")) {
            val at = text.indexOf(header)
            assertTrue(at >= 0 && inCells.none { at in it }, "header '$header' must be outside the tables")
        }
    }
}
