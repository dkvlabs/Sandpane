package labs.dkv.sandpane.services

import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.GitApplyParams
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
        changes = paths.map { FileChange(it, FileChangeStatus.MODIFIED) },
    )

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
                FileChange("src/New.kt", FileChangeStatus.RENAMED),
                FileChange("src/B.kt", FileChangeStatus.MODIFIED),
            ),
        )
        val ready = assertIs<ApplyPlan.Decision.Ready>(ApplyPlan.decide("task-1", reviewed))
        assertEquals(listOf("src/New.kt"), ready.renamedWithoutSource)
        assertEquals(listOf("src/New.kt", "src/B.kt"), ready.paths)
    }
}
