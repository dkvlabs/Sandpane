package labs.dkv.sandpane.services

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import labs.dkv.sandpane.core.CoreCommands
import labs.dkv.sandpane.core.CoreRpc
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreFeatures
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.GitDiffResult
import labs.dkv.sandpane.model.Reported
import labs.dkv.sandpane.model.reported
import java.util.concurrent.CompletableFuture
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A6 (§3.6): what a confirmed Apply sends, derived ONLY from one `git.review` answer
 * ([ReviewSession]) and the user's checkbox selection. Selectability, the diff/entry mismatch
 * refusal, flags (a)/(b)/(c) and the verbatim entries. The review answer is an illustrative fixture
 * shaped like Core's output, not a capture.
 */
class ApplyPlanTest {

    private val base = "0123456789abcdef0123456789abcdef01234567"
    private val blobA = "a".repeat(40)
    private val blobB = "b".repeat(40)

    private fun answer(changes: String, reviewId: String? = "rev-1", hooks: String? = null, dirty: Boolean = false): JsonElement =
        CoreJson.parseToJsonElement(
            """{"taskId":"task-1","baseCommit":"$base","hostDirty":$dirty,"repoPath":"/repo/atlas-demo",""" +
                (reviewId?.let { "\"reviewId\":\"$it\"," } ?: "") +
                (hooks?.let { "\"hostHooksPath\":\"$it\"," } ?: "") +
                "\"changes\":[$changes]}",
        )

    private val standard = """
        {"path":"src/a\tb.kt","status":"modified","taskBlob":"$blobA","taskMode":"100644"},
        {"path":"bin/run.sh","status":"added","taskBlob":"$blobB","taskMode":"100755"},
        {"path":"gone.txt","status":"deleted"},
        {"path":"new/name.kt","status":"renamed","oldPath":"old/name.kt","taskBlob":"$blobA","taskMode":"100644"},
        {"path":"link","status":"added","taskBlob":"$blobB","taskMode":"120000"},
        {"path":"huge.bin","status":"untracked"},
        {"path":"half.kt","status":"modified","taskBlob":"$blobA"},
        {"path":"later.kt","status":"copied_later","taskBlob":"$blobA","taskMode":"100644"}
    """

    private fun session(changes: String = standard, reviewId: String? = "rev-1", hooks: String? = null, dirty: Boolean = false) =
        ReviewSession.fromAnswer(answer(changes, reviewId, hooks, dirty), coreInstanceId = "core-1")

    private fun diff(change: FileChange, blob: String?, binary: Boolean = false, truncated: Boolean = false) =
        GitDiffResult(change.path, change.oldPath, change.status, "", binary, truncated, false, null, blob, change.taskMode)

    // -----------------------------------------------------------------------
    // review session
    // -----------------------------------------------------------------------

    @Test
    fun aReviewSessionKeepsTheAnswersOwnEntryObjects() {
        val s = session()
        assertEquals("rev-1", s.changeSet.reviewId)
        assertEquals("core-1", s.coreInstanceId)
        assertEquals(s.changeSet.changes.size, s.rawChanges.size)
        assertEquals(answer(standard).jsonObject["changes"]!!.jsonArray.map { it.jsonObject }, s.rawChanges)
        assertEquals("src/a\tb.kt", s.changeSet.changes[0].path)
        assertEquals(blobA, s.changeSet.changes[0].taskBlob)
        assertEquals("100644", s.changeSet.changes[0].taskMode)
        assertEquals("old/name.kt", s.changeSet.changes[3].oldPath)
    }

    // -----------------------------------------------------------------------
    // selectability
    // -----------------------------------------------------------------------

    @Test
    fun selectabilityFollowsTheReviewedContentBinding() {
        val s = session()
        val reasons = s.changeSet.changes.map { ApplyPlan.selectability(s.changeSet, it) }
        assertNull(reasons[0], "modified with blob + mode")
        assertNull(reasons[1], "added executable")
        assertNull(reasons[2], "deleted needs no blob")
        assertNull(reasons[3], "a rename is one entry")
        assertEquals(ApplyPlan.REASON_SYMLINK, reasons[4])
        assertEquals("symlinks are never applied", ApplyPlan.REASON_SYMLINK)
        assertEquals(ApplyPlan.REASON_TOO_LARGE, reasons[5])
        assertEquals("too large or unreadable to apply (over 32 MiB)", ApplyPlan.REASON_TOO_LARGE)
        assertEquals(ApplyPlan.REASON_NO_CONTENT_ID, reasons[6], "a blob without a mode binds nothing")
        assertEquals("no reviewed content id", ApplyPlan.REASON_NO_CONTENT_ID)
        assertEquals(ApplyPlan.REASON_UNKNOWN_STATUS, reasons[7])
    }

    @Test
    fun aReviewWithoutReviewIdHasNothingSelectable() {
        val s = session(reviewId = null)
        s.changeSet.changes.forEach { assertNotNull(ApplyPlan.selectability(s.changeSet, it), it.path) }
        val refused = assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide(s, listOf(0)))
        assertTrue(refused.reason.contains("no reviewId"), refused.reason)
    }

    // -----------------------------------------------------------------------
    // decide
    // -----------------------------------------------------------------------

    @Test
    fun theWireEntriesAreTheSelectedReviewObjectsVerbatim() {
        val s = session()
        val ready = assertIs<ApplyPlan.Decision.Ready>(ApplyPlan.decide(s, listOf(3, 0, 2)))
        assertEquals("rev-1", ready.params.reviewId)
        assertEquals(base, ready.params.expectedBase)
        assertEquals("task-1", ready.params.taskId)
        // In review order, regardless of the order the boxes were ticked.
        assertEquals(listOf(s.rawChanges[0], s.rawChanges[2], s.rawChanges[3]), ready.params.entries)
        assertEquals(listOf("src/a\tb.kt", "gone.txt", "new/name.kt"), ready.entries.map { it.path })
    }

    /**
     * Verbatim means the review's own object, not a re-encoding of the typed view: a field this
     * build does not model (a newer Core's) and the key order survive; a typed re-encode would drop
     * the field and reorder the keys.
     */
    @Test
    fun entriesAreNeverRebuiltFromTheTypedView() {
        val s = session("""{"taskMode":"100644","futureField":{"x":[1,2]},"path":"z.kt","taskBlob":"$blobA","status":"modified"}""")
        val ready = assertIs<ApplyPlan.Decision.Ready>(ApplyPlan.decide(s, listOf(0)))
        val sent = ready.params.entries.single()
        assertEquals(listOf("taskMode", "futureField", "path", "taskBlob", "status"), sent.keys.toList())
        assertEquals(CoreJson.parseToJsonElement("""{"x":[1,2]}"""), sent["futureField"])
        assertEquals(s.rawChanges[0], sent)
    }

    @Test
    fun emptyUnselectableOrOversizedSelectionsAreRefused() {
        val s = session()
        assertTrue(assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide(s, emptyList())).reason.contains("no file"))
        assertTrue(assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide(s, listOf(4))).reason.contains("symlinks are never applied"))
        assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide(s, listOf(99)))
        val many = (1..1001).joinToString(",") { """{"path":"f$it","status":"modified","taskBlob":"$blobA","taskMode":"100644"}""" }
        val big = session(many)
        assertTrue(assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide(big, (0 until 1001).toList())).reason.contains("1000"))
        assertIs<ApplyPlan.Decision.Ready>(ApplyPlan.decide(big, (0 until 1000).toList()), "Core's own limit is not tightened")
    }

    @Test
    fun aDirtyHostIsDisclosedNotRefused() {
        // Core's A6 gate covers the touched paths only; refusing the whole apply here would be stricter.
        val s = session(dirty = true)
        assertIs<ApplyPlan.Decision.Ready>(ApplyPlan.decide(s, listOf(0)))
    }

    @Test
    fun aDiffThatShowedOtherContentRefusesTheSendAndSendsNoFrame() {
        val s = session()
        val entry = s.changeSet.changes[0]
        s.recordDiff(diff(entry, blobB))
        val refused = assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide(s, listOf(1)))
        assertEquals("src/a\\tb.kt changed after you reviewed it — review again", refused.reason)
        assertTrue(refused.reviewAgain)
        val sent = ArrayList<String>()
        val commands = CoreCommands(CoreRpc { m, _ -> sent += m; CompletableFuture.completedFuture(CoreJson.parseToJsonElement("""{"applied":true}""")) }) {
            CoreCapabilities(1, "0.1.0", "i", platform = "macos", methods = CoreMethods.ALL, features = CoreFeatures.KNOWN)
        }
        assertNull(ApplyPlan.submit(ApplyPlan.decide(s, listOf(0, 1)), commands), "refused: nothing is submitted")
        assertTrue(sent.isEmpty(), "no git.apply frame")
        // A diff that answered with no taskBlob for an entry that has one is not proof either: fail closed.
        val s2 = session()
        s2.recordDiff(diff(s2.changeSet.changes[0], null))
        assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide(s2, listOf(0)))
        // The matching diff lets it through, and the frame is then sent.
        val s3 = session()
        s3.recordDiff(diff(s3.changeSet.changes[0], blobA))
        assertNotNull(ApplyPlan.submit(ApplyPlan.decide(s3, listOf(0)), commands))
        assertEquals(listOf(CoreMethods.GIT_APPLY), sent)
    }

    // -----------------------------------------------------------------------
    // flags
    // -----------------------------------------------------------------------

    @Test
    fun flagANamesEntriesWhoseContentWasNeverFullyShown() {
        val s = session()
        val changes = s.changeSet.changes
        s.recordDiff(diff(changes[0], blobA))
        s.recordDiff(diff(changes[1], blobB, binary = true))
        s.recordDiff(diff(changes[3], blobA, truncated = true))
        assertNull(ApplyPlan.notFullyShown(s, changes[0]), "opened, text, complete")
        assertEquals(ApplyPlan.UNSEEN_BINARY, ApplyPlan.notFullyShown(s, changes[1]))
        assertEquals(ApplyPlan.UNSEEN_NEVER_OPENED, ApplyPlan.notFullyShown(s, changes[2]))
        assertEquals(ApplyPlan.UNSEEN_TRUNCATED, ApplyPlan.notFullyShown(s, changes[3]))
        // A fresh review forgets every diff (the selection and its evidence are per review).
        val fresh = session()
        assertEquals(ApplyPlan.UNSEEN_NEVER_OPENED, ApplyPlan.notFullyShown(fresh, fresh.changeSet.changes[0]))
    }

    @Test
    fun flagBNamesExecutableEntries() {
        val s = session()
        assertEquals(listOf("bin/run.sh"), s.changeSet.changes.filter(ApplyPlan::isExecutable).map { it.path })
    }

    @Test
    fun flagCMatchesPathsThatRunAutomaticallyByComponent() {
        fun fc(path: String, old: String? = null) =
            FileChange(path, (if (old != null) FileChangeStatus.RENAMED else FileChangeStatus.MODIFIED).reported(), old, blobA, "100644")
        val flagged = listOf(
            ".husky/pre-commit", ".githooks/pre-push", ".github/workflows/ci.yml", ".envrc", "sub/.envrc",
            ".vscode/tasks.json", ".idea/workspace.xml", ".gitattributes", "docs/.gitattributes", ".gitmodules",
            ".HUSKY/pre-commit", "tools/hooks/pre-commit",
        )
        for (p in flagged) assertTrue(ApplyPlan.runsAutomatically(fc(p), "./tools/hooks/"), p)
        // A rename OUT of a hooks directory is flagged too.
        assertTrue(ApplyPlan.runsAutomatically(fc("scripts/x.sh", old = ".husky/x.sh"), null))
        val clean = listOf(
            "src/.huskyrc.kt", ".github/workflows-old/x.yml", ".githubx/workflows/ci.yml", "envrc", "tools/hooksx/a",
            "tools/hook", "a/.github/workflows/ci.yml", "x.gitattributes",
        )
        for (p in clean) assertFalse(ApplyPlan.runsAutomatically(fc(p), "tools/hooks"), p)
        // No hostHooksPath: nothing extra is matched.
        assertFalse(ApplyPlan.runsAutomatically(fc("tools/hooks/pre-commit"), null))
        assertFalse(ApplyPlan.runsAutomatically(fc("tools/hooks/pre-commit"), ""))
    }

    @Test
    fun unknownStatusesStayListedButNeverSelectable() {
        val s = session("""{"path":"x","status":"type_changed","taskBlob":"$blobA","taskMode":"100644"}""")
        assertIs<Reported.Unknown>(s.changeSet.changes[0].status)
        assertEquals(ApplyPlan.REASON_UNKNOWN_STATUS, ApplyPlan.selectability(s.changeSet, s.changeSet.changes[0]))
        assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide(s, listOf(0)))
    }

    @Test
    fun theRowLabelShowsStatusRenameAndWhyARowIsDisabled() {
        val s = session()
        val rows = s.changeSet.changes.map { ApplyPlan.rowLabel(s, it) }
        assertTrue(rows[0].startsWith("modified  src/a\\tb.kt"), rows[0])
        assertTrue(rows[3].contains("old/name.kt → new/name.kt"), rows[3])
        assertTrue(rows[4].contains("not selectable: symlinks are never applied"), rows[4])
        assertTrue(rows[1].contains("executable"), rows[1])
        assertTrue(rows[0].contains("never opened in the Diff view"), rows[0])
    }

    @Test
    fun theDialogListingHelpersStillBoundAndRevealPaths() {
        val text = ApplyPlan.describePaths((1..25).map { "f$it" }, limit = 20)
        assertEquals(21, text.lines().size)
        assertTrue(text.endsWith("… and 5 more"))
        assertTrue(ApplyPlan.displayPath("a\rb").contains("a\\rb"), "CR is shown as \\r")
        // The fixture really carries a TAB (decoded from JSON), not the two characters backslash-t.
        assertTrue(answer(standard).jsonObject["changes"]!!.jsonArray[0].jsonObject["path"]!!.jsonPrimitive.content.contains('\t'))
    }
}
