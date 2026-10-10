package labs.dkv.sandpane.services

import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.reported
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.GitApplyParams
import labs.dkv.sandpane.model.Reported
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** Review bug 7: the apply request names exactly the reviewed paths the user confirmed. */
class ApplyPlanTest {

    private val base = "0123456789abcdef0123456789abcdef01234567"

    private fun changeSet(vararg paths: String, dirty: Boolean = false, task: String = "task-1") = ChangeSet(
        taskId = task,
        baseCommit = base,
        hostDirty = dirty,
        changes = paths.map { FileChange(it, FileChangeStatus.MODIFIED.reported()) },
    )

    private fun change(path: String, status: Reported<FileChangeStatus>) = FileChange(path, status)

    @Test
    fun theWireSelectionIsExactlyTheReviewedPaths() {
        val ready = assertIs<ApplyPlan.Decision.Ready>(
            ApplyPlan.decide("task-1", changeSet("src/A.kt", "src/B.kt", "src/A.kt")),
        )
        assertEquals(listOf("src/A.kt", "src/B.kt"), ready.paths)
        val wire = CoreJson.encodeToJsonElement(GitApplyParams.serializer(), ready.params).jsonObject
        val selected = (wire["selectedFiles"] as JsonArray).map { it.jsonPrimitive.content }
        assertEquals(listOf("src/A.kt", "src/B.kt"), selected, "never null after the user confirmed named files")
        assertEquals(base, wire["expectedBase"]!!.jsonPrimitive.content)
        assertEquals("task-1", wire["taskId"]!!.jsonPrimitive.content)
    }

    @Test
    fun anEmptyChangeSetIsRefusedBeforeAnythingIsSent() {
        val refused = assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide("task-1", changeSet()))
        assertTrue(refused.reason.contains("no files"))
    }

    @Test
    fun aDirtyHostIsRefused() {
        assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide("task-1", changeSet("a", dirty = true)))
    }

    @Test
    fun aChangeSetForAnotherTaskIsRefused() {
        assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide("task-1", changeSet("a", task = "task-2")))
    }

    @Test
    fun theConfirmationListIsBounded() {
        val paths = (1..25).map { "f$it" }
        val text = ApplyPlan.describePaths(paths, limit = 20)
        assertEquals(21, text.lines().size)
        assertTrue(text.endsWith("… and 5 more"))
    }

    /**
     * S1: on a case-insensitive filesystem (the macOS and Windows default) `A.kt` and `a.kt` are
     * one file, as are NFC and NFD spellings. An unknown-status entry must exclude its fold-twin
     * too, and the excluded twin is listed as NOT sent rather than silently dropped.
     */
    @Test
    fun anUnknownStatusEntryAlsoExcludesItsCaseAndNormalizationTwins() {
        val nfd = "cafe\u0301.kt"
        val nfc = "caf\u00E9.kt"
        val reviewed = ChangeSet(
            taskId = "t1",
            baseCommit = base,
            hostDirty = false,
            changes = listOf(
                change("src/A.kt", Reported.Unknown("type_changed")),
                change("src/a.kt", FileChangeStatus.MODIFIED.reported()),
                change(nfd, Reported.Unknown("copied")),
                change(nfc, FileChangeStatus.MODIFIED.reported()),
                change("ok.kt", FileChangeStatus.MODIFIED.reported()),
            ),
        )
        val ready = assertIs<ApplyPlan.Decision.Ready>(ApplyPlan.decide("t1", reviewed))
        assertEquals(listOf("ok.kt"), ready.params.selectedFiles)
        assertEquals(listOf("src/A.kt", "src/a.kt", nfd, nfc), ready.notSent.map { it.path })
        val notSent = ApplyPlan.describeNotSent(ready.notSent).replace('\u00A0', ' ')
        assertTrue(notSent.contains("[x2] src/a.kt — same file as an unknown-status entry"), notSent)
    }

    @Test
    fun selectedPathsThatDifferOnlyInCaseAreSentButPointedOut() {
        val ready = assertIs<ApplyPlan.Decision.Ready>(
            ApplyPlan.decide("task-1", changeSet("README.md", "readme.md", "src/B.kt")),
        )
        assertEquals(listOf("README.md", "readme.md", "src/B.kt"), ready.paths, "legitimate on a case-sensitive filesystem")
        assertEquals(listOf(listOf("README.md", "readme.md")), ready.foldCollisions)
    }

    /** Security re-review W1: case-variant groups are bounded in count and in size. */
    @Test
    fun foldCollisionGroupsAreBoundedInTheDialog() {
        val paths = (1..30).flatMap { g -> (1..8).map { v -> "dir$g/" + "f".repeat(v) + "F".repeat(8 - v) + ".kt" } }
            .flatMap { listOf(it, it.lowercase()) }.distinct()
        val ready = assertIs<ApplyPlan.Decision.Ready>(ApplyPlan.decide("task-1", changeSet(*paths.toTypedArray())))
        assertEquals(30, ready.foldCollisions.size)
        val html = labs.dkv.sandpane.ui.ApplyConfirmation.message("task-1", changeSet(*paths.toTypedArray()), ready).build()
        assertEquals(ApplyPlan.MAX_LISTED_PATHS, Regex("""\[c\d+]""").findAll(html).count(), "group rows")
        assertTrue(html.contains("… and 10 more group(s)"), html.takeLast(400))
        assertTrue(html.contains("… and 3 more"), "per-group cap")
    }

    @Test
    fun aPathlessEntryIsRefusedNotSilentlyDropped() {
        val refused = assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide("task-1", changeSet("src/A.kt", " ")))
        assertTrue(refused.reason.contains("without a path"), refused.reason)
    }

    @Test
    fun renamesAreFlaggedBecauseTheProtocolCarriesNoSourcePath() {
        val reviewed = ChangeSet(
            taskId = "task-1",
            baseCommit = base,
            hostDirty = false,
            changes = listOf(
                FileChange("src/New.kt", FileChangeStatus.RENAMED.reported()),
                FileChange("src/B.kt", FileChangeStatus.MODIFIED.reported()),
            ),
        )
        val ready = assertIs<ApplyPlan.Decision.Ready>(ApplyPlan.decide("task-1", reviewed))
        assertEquals(listOf("src/New.kt"), ready.renamedWithoutSource)
        assertEquals(listOf("src/New.kt", "src/B.kt"), ready.paths)
    }
}
