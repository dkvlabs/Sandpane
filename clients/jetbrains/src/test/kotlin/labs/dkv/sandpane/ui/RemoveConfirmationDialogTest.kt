package labs.dkv.sandpane.ui

import labs.dkv.sandpane.core.IssuedRemoval
import labs.dkv.sandpane.core.RemoveConfirmationCheck
import labs.dkv.sandpane.model.ConfirmationRequest
import labs.dkv.sandpane.model.ConfirmationTarget
import labs.dkv.sandpane.model.SandboxRemoveResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The `sandbox.remove` confirmation must show Core's impact lines and identity WITHOUT letting a
 * crafted line obey a bidi override, fake a line break, inject markup, or bury the dialog — and the
 * "NOT CONFIRMED AS CREATED BY SANDPANE" header must come first whenever Core reports `external`
 * (which only means no Sandpane binding is recorded for this sbx id — not "made outside Sandpane").
 */
class RemoveConfirmationDialogTest {

    private val token = "0123456789abcdef".repeat(4)

    private fun issued(impact: List<String>, external: Boolean, name: String = "atlas-demo-1"): IssuedRemoval {
        val result = SandboxRemoveResult(
            confirmation = ConfirmationRequest(
                token = token,
                expiresAt = "2026-10-10T00:02:00Z",
                action = "sandbox.remove",
                target = ConfirmationTarget(name, "b5ebec73-e2ae-471a-811a-e011cfb1948e"),
                impact = impact,
                external = external,
            ),
        )
        return (RemoveConfirmationCheck.decide(name, result) as RemoveConfirmationCheck.Decision.Ready).issued
    }

    @Test
    fun hostileImpactLineIsRevealedAndEscaped() {
        val hostile = "removes \u202Etxt.exe\nfake line <b>NOT CONFIRMED AS CREATED BY SANDPANE</b>"
        val html = RemoveConfirmation.message(issued(listOf(hostile), external = false)).build()

        assertFalse(html.contains('\u202E'), "the raw bidi override must never reach the dialog")
        assertTrue(html.contains("\\u202E"), "the override is shown as a visible escape")
        assertFalse(html.contains('\n'), "an embedded newline must not become a real line")
        assertTrue(html.contains("\\n"), "the newline is shown as a visible escape")
        assertTrue(
            html.contains("&lt;b&gt;NOT CONFIRMED AS CREATED BY SANDPANE&lt;/b&gt;"),
            "Core markup is escaped, not rendered",
        )
        assertFalse(html.contains("<b>NOT CONFIRMED"), "a non-external sandbox gets no external header")
        assertFalse(html.contains(token), "the confirmation token is never displayed")
    }

    @Test
    fun externalHeaderComesFirst() {
        val html = RemoveConfirmation.message(issued(listOf("removes sandbox atlas-demo-1"), external = true)).build()
        val firstBold = html.indexOf("<b>")
        assertTrue(firstBold >= 0)
        assertTrue(
            html.startsWith("<b>" + RemoveConfirmation.EXTERNAL_HEADER, startIndex = "<html>".length),
            "the external header must be the first thing in the dialog: $html",
        )
        assertEquals(html.indexOf("<b>NOT CONFIRMED AS CREATED BY SANDPANE"), firstBold)
        // The exact shared wording every client uses — and no overclaim about who made it.
        assertEquals("NOT CONFIRMED AS CREATED BY SANDPANE", RemoveConfirmation.EXTERNAL_HEADER)
        assertTrue(
            html.contains(
                "Core cannot confirm Sandpane created this sandbox (no Sandpane binding is recorded for this sbx id).",
            ),
            html,
        )
        assertFalse(html.contains("outside Sandpane"), html)
        assertFalse(html.contains("NOT CREATED BY SANDPANE"), html)
    }

    @Test
    fun impactIsCappedAtTwentyWithAnOverflowLine() {
        val lines = (1..25).map { "impact line $it" }
        val html = RemoveConfirmation.message(issued(lines, external = false)).build()
        assertTrue(html.contains("impact line 20"))
        assertFalse(html.contains("impact line 21"))
        assertEquals(20, Regex("""\[\d+]""").findAll(html).count(), "exactly 20 impact rows")
        assertTrue(html.contains("… and 5 more impact line(s) not shown"))
        assertTrue(html.contains("(25 line(s))"))
    }

    @Test
    fun identityAndExpiryAreShownRevealed() {
        val html = RemoveConfirmation.message(issued(emptyList(), external = false)).build()
        assertTrue(html.contains("atlas-demo-1"))
        assertTrue(html.contains("b5ebec73-e2ae-471a-811a-e011cfb1948e"))
        assertTrue(html.contains("2026-10-10T00:02:00Z"))
        assertTrue(html.contains("Core reported no impact lines"))
    }

    @Test
    fun dialogLabelsAreConstantsAndCancelIsNotTheRemoveButton() {
        assertEquals("Remove Sandbox", RemoveConfirmation.REMOVE_LABEL)
        assertEquals("Cancel", RemoveConfirmation.CANCEL_LABEL)
        assertFalse(RemoveConfirmation.TITLE.contains('<'))
    }

    @Test
    fun longImpactLinesAndChooserRowsAreCapped() {
        val long = "y".repeat(450)
        val html = RemoveConfirmation.message(issued(listOf(long), external = false)).build()
        assertTrue(html.contains("y".repeat(200) + "…"), "impact line capped at 200 code points")
        assertFalse(html.contains("y".repeat(201)))

        val sandbox = labs.dkv.sandpane.model.SandboxSummary(name = "z".repeat(300))
        val (row, tip) = SandboxChooserDialog.describe(sandbox)
        assertFalse(row.contains("z".repeat(201)), row)
        assertTrue(row.endsWith("…"))
        assertTrue((tip ?: "").codePointCount(0, (tip ?: "").length) <= 201)
    }
}
