package labs.dkv.sandpane.ui

import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.GitDiffResult
import labs.dkv.sandpane.services.ApplyPlan
import labs.dkv.sandpane.services.ReviewSession
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * A6 confirmation contract (§3.6 item 9). The modal's text is built by [ApplyConfirmation] (pure, so
 * it can be checked here); [ApplyConfirmationDialog] only lays it out. Fixtures are illustrative.
 */
class ApplyConfirmationTest {

    private val blob = "a".repeat(40)

    private fun session(changes: String, hooks: String? = null, dirty: Boolean = false): ReviewSession =
        ReviewSession.fromAnswer(
            CoreJson.parseToJsonElement(
                """{"taskId":"task-1","baseCommit":"${"0".repeat(40)}","hostDirty":$dirty,"repoPath":"/Users/demo/Nova Demo\u202E",""" +
                    """"reviewId":"rev-1",""" + (hooks?.let { "\"hostHooksPath\":\"$it\"," } ?: "") + "\"changes\":[$changes]}",
            ),
            coreInstanceId = "core-1",
        )

    private fun entry(path: String, mode: String = "100644", status: String = "modified") =
        """{"path":"$path","status":"$status","taskBlob":"$blob","taskMode":"$mode"}"""

    private fun ready(s: ReviewSession, indices: List<Int> = s.changeSet.changes.indices.toList()) =
        assertIs<ApplyPlan.Decision.Ready>(ApplyPlan.decide(s, indices))

    @Test
    fun itNamesTheRepositoryAndListsEveryFileWithItsStatus() {
        val many = (1..60).joinToString(",") { entry("src/f$it.kt") }
        val s = session(
            "$many,${entry("a\\rb.kt")}," +
                """{"path":"gone.txt","status":"deleted"},""" +
                """{"path":"new.kt","status":"renamed","oldPath":"old.kt","taskBlob":"$blob","taskMode":"100644"}""",
        )
        val html = ApplyConfirmation.message(s, ready(s)).build()
        assertTrue(html.contains("Nova Demo\\u202E"), "repoPath named, revealed")
        assertFalse(html.contains('\u202E'))
        // Every file, no "… and N more" overflow (the list scrolls instead).
        assertEquals(63, Regex("""\[\d+]""").findAll(html).count(), "one numbered row per file")
        assertFalse(html.contains("more</"), "no overflow line")
        assertTrue(html.contains("src/f60.kt"))
        assertTrue(html.contains("a\\rb.kt"), "a carriage return is shown as \\r")
        assertTrue(html.contains("deleted"))
        assertTrue(html.contains("old.kt → new.kt"), "renames as oldPath → path")
        assertTrue(html.contains(ApplyConfirmation.STATEMENT.replace("'", "&#39;")), html.takeLast(600))
        assertEquals(
            "Writes these files into your working tree and stages them. Nothing is committed. " +
                "The content is the version Core hashed when you reviewed.",
            ApplyConfirmation.STATEMENT,
        )
    }

    @Test
    fun itFlagsUnseenExecutableAndAutoRunningEntriesSeparately() {
        val s = session(
            listOf(
                entry("src/seen.kt"),
                entry("src/binary.png"),
                entry("bin/run.sh", mode = "100755"),
                entry(".github/workflows/ci.yml"),
                entry("tools/hooks/pre-commit"),
            ).joinToString(","),
            hooks = "tools/hooks",
        )
        val changes = s.changeSet.changes
        s.recordDiff(GitDiffResult(changes[0].path, null, changes[0].status, "@@", false, false, false, null, blob, "100644"))
        s.recordDiff(GitDiffResult(changes[1].path, null, changes[1].status, "", true, false, false, null, blob, "100644"))
        val flags = ApplyConfirmation.flags(s, ready(s).entries)
        assertEquals(listOf("src/binary.png", "bin/run.sh", ".github/workflows/ci.yml", "tools/hooks/pre-commit"), flags.notFullyShown.map { it.first.path })
        assertEquals(listOf("bin/run.sh"), flags.executable.map { it.path })
        assertEquals(listOf(".github/workflows/ci.yml", "tools/hooks/pre-commit"), flags.autoRun.map { it.path })
        val html = ApplyConfirmation.message(s, ready(s)).build()
        for (marker in listOf("[a1]", "[a4]", "[b1]", "[c1]", "[c2]")) assertTrue(html.contains(marker), marker)
        assertFalse(html.contains("[a5]"))
        assertTrue(html.contains("(a) content never fully shown"), html)
        assertTrue(html.contains("(b) executable"), html)
        assertTrue(html.contains("(c) runs automatically"), html)
    }

    @Test
    fun aDirtyHostIsDisclosed() {
        val s = session(entry("a.kt"), dirty = true)
        val html = ApplyConfirmation.message(s, ready(s)).build()
        assertTrue(html.contains("other uncommitted changes"), html)
    }

    @Test
    fun theButtonsAreAnExplicitApplyAndADefaultCancel() {
        assertEquals("Apply 3 files", ApplyConfirmation.okLabel(3))
        assertEquals("Apply 1 file", ApplyConfirmation.okLabel(1))
        assertEquals("Cancel", ApplyConfirmation.CANCEL_LABEL)
        assertFalse(ApplyConfirmation.TITLE.contains('<'))
        // The dialog makes Cancel the default AND focused button, and OK is not the default.
        val dialog = source("ui/ApplyDialogs.kt")
        assertTrue(dialog.contains("cancelAction.putValue(DEFAULT_ACTION, true)"), "Cancel is the default button")
        assertTrue(dialog.contains("okAction.putValue(DEFAULT_ACTION, null)"), "OK is not the default button")
        assertTrue(dialog.contains("getButton(cancelAction)"), "Cancel has the initial focus")
    }

    /**
     * §3.6 item 9: the modal opens ONLY from a direct user gesture. The selection and confirmation
     * dialogs are constructed in exactly one place, the body of [labs.dkv.sandpane.actions.ApplyTaskAction]'s
     * `actionPerformed`; no other source file, timer, listener, chat or event path constructs them.
     */
    @Test
    fun theConfirmationOpensOnlyFromTheActionsActionPerformed() {
        val all = File("src/main/kotlin").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        for (dialog in listOf("ApplyConfirmationDialog(", "ApplySelectionDialog(")) {
            val users = all.filter { f -> f.readText().contains(dialog) && !f.path.endsWith("ui/ApplyDialogs.kt") }
            assertEquals(listOf("ApplyTaskAction.kt"), users.map { it.name }, "$dialog is constructed elsewhere")
            val action = users.single().readText()
            assertEquals(1, Regex(Regex.escape(dialog)).findAll(action).count(), "$dialog constructed more than once")
            val at = action.indexOf(dialog)
            val performed = action.lastIndexOf("override fun actionPerformed(", at)
            assertTrue(performed >= 0, "$dialog is not inside actionPerformed")
            assertFalse(action.substring(performed, at).contains("\n    override fun ") || action.substring(performed, at).contains("\n    private fun "),
                "$dialog must be in actionPerformed's own body")
            assertFalse(action.substring(performed, at).contains("invokeLater"), "never deferred to a later EDT event")
        }
        // The apply call itself is never made from the EDT-blocking path: it goes through the
        // CoreCommands wrapper, whose transport runs on ConnectionManager's io pool.
        val action = all.single { it.name == "ApplyTaskAction.kt" }.readText()
        assertTrue(action.contains("ApplyPlan.submit("), "the send goes through ApplyPlan.submit")
        assertFalse(action.contains(".get("), "never blocks on the answer")
    }

    private fun source(relative: String) = File("src/main/kotlin/labs/dkv/sandpane/$relative").readText()
}
