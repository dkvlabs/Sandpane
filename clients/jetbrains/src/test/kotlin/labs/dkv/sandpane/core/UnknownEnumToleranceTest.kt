package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.Reported
import labs.dkv.sandpane.model.SandboxSummary
import labs.dkv.sandpane.model.TaskEvent
import labs.dkv.sandpane.model.TaskStatus
import labs.dkv.sandpane.model.TaskSummary
import labs.dkv.sandpane.model.WorkspaceMode
import labs.dkv.sandpane.model.WorkspaceModeTone
import labs.dkv.sandpane.model.describe
import labs.dkv.sandpane.model.isTerminal
import labs.dkv.sandpane.model.reported
import labs.dkv.sandpane.services.ApplyPlan
import labs.dkv.sandpane.services.TaskMonitorService
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Protocol tolerance: a NEWER Core may add an enum value this plugin build does not define. That
 * must surface as a visible "unknown" — never fail a whole call, never be mistaken for a known
 * state, and never be presented as safe.
 */
class UnknownEnumToleranceTest {

    @Test
    fun conversationSendWithAnUnknownStatusIsReportedAsAccepted() {
        // Before: decoding failed and the plugin raised INTERNAL AFTER Core had already queued the
        // task, inviting a duplicate retry.
        val result = TaskMonitorService.decodeSendResult(
            buildJsonObject {
                put("id", "task-7")
                put("conversationId", "c1")
                put("status", "paused_for_quota")
            },
        )
        val accepted = assertIs<TaskMonitorService.SendResult.FromSummary>(result)
        assertEquals("task-7", accepted.taskId)
        assertEquals(Reported.Unknown("paused_for_quota"), accepted.summary.status)
        assertEquals(
            "Unknown status 'paused_for_quota' — this plugin is older than Core",
            accepted.summary.status.describe(),
        )
    }

    @Test
    fun taskListRowsWithAnUnknownStatusStillDecode() {
        val rows = CoreJson.decodeFromString(
            ListSerializer(TaskSummary.serializer()),
            """[{"id":"t1","conversationId":"c1","status":"completed"},
                {"id":"t2","conversationId":"c1","status":"paused_for_quota"}]""",
        )
        assertEquals(listOf("t1", "t2"), rows.map { it.id })
        assertEquals(TaskStatus.COMPLETED.reported(), rows[0].status)
        assertEquals(Reported.Unknown("paused_for_quota"), rows[1].status)
    }

    @Test
    fun aReviewWithAnUnknownFileStatusStillDecodes() {
        val changeSet = CoreJson.decodeFromString(
            ChangeSet.serializer(),
            """{"taskId":"t1","baseCommit":"abc","hostDirty":false,
                "changes":[{"path":"a.kt","status":"modified"},{"path":"b.kt","status":"type_changed"}]}""",
        )
        assertEquals(listOf("a.kt", "b.kt"), changeSet.changes.map { it.path })
        assertEquals(FileChangeStatus.MODIFIED.reported(), changeSet.changes[0].status)
        assertEquals(Reported.Unknown("type_changed"), changeSet.changes[1].status)
        assertEquals("unknown status 'type_changed' (not selectable for apply)", changeSet.changes[1].status.describe())
    }

    @Test
    fun anUnknownWorkspaceModeRendersAsTheWorstCaseNeverIsolated() {
        val sandbox = CoreJson.decodeFromString(
            SandboxSummary.serializer(),
            """{"name":"atlas-auth","probedState":"running","workspaceMode":"overlay_mount"}""",
        )
        val view = sandbox.modeView()
        assertTrue(view.hostWritable, "an unidentified mode must never be shown as isolated")
        assertEquals(WorkspaceModeTone.UNKNOWN, view.tone)
        assertTrue(view.label.contains("overlay_mount"), view.label)
    }

    @Test
    fun anUnknownStatusChangedIsSurfacedNotDropped() {
        val event = TaskEvent(
            taskId = "t",
            sequence = 1,
            kind = "status.changed",
            payload = buildJsonObject { put("to", "paused_for_quota") },
            timestamp = "2026-10-09T00:00:01Z",
        )
        val empty = TaskMonitorService.TaskView("t", null, null, null, null, null, 0, null, emptyList())
        val view = TaskMonitorService.fold(empty, event, event.toRenderedEvent())
        assertTrue(
            view.statusLabel.contains("Unknown status 'paused_for_quota'"),
            "the raw value must be shown: ${view.statusLabel}",
        )
        assertTrue(view.statusLabel.contains("older than Core"), view.statusLabel)
        assertFalse(view.awaitingReview, "an unknown status never enables review/apply")
    }

    @Test
    fun anUnknownStatusIsNeitherTerminalNorRunningAndDisablesActions() {
        val unknown: Reported<TaskStatus> = Reported.Unknown("paused_for_quota")
        assertFalse(unknown.isTerminal)
        assertTrue(TaskStatus.COMPLETED.reported().isTerminal)
        val view = TaskMonitorService.TaskView("t", "c", unknown, null, null, null, 3, null, emptyList())
        assertTrue(view.hasUnknownStatus)
        assertFalse(view.awaitingReview)
        assertFalse(view.status == TaskStatus.RUNNING.reported())
    }

    @Test
    fun anUnknownStatusChangedReplacesTheOlderKnownStatusAndLeavesANote() {
        val running = TaskMonitorService.TaskView(
            "t", null, TaskStatus.AWAITING_REVIEW.reported(), null, null, null, 1, null, emptyList(),
        )
        val event = TaskEvent(
            taskId = "t",
            sequence = 2,
            kind = "status.changed",
            payload = buildJsonObject { put("to", "paused_for_quota") },
            timestamp = "2026-10-09T00:00:02Z",
        )
        val view = TaskMonitorService.fold(running, event, event.toRenderedEvent())
        assertEquals(Reported.Unknown("paused_for_quota"), view.status)
        assertFalse(view.awaitingReview, "review/apply must turn off once Core reports an unknown status")
        assertTrue(view.notes.any { it.contains("'paused_for_quota'") && it.contains("does not define") }, "${view.notes}")
        assertTrue(TaskMonitorService.unknownStatusNote(listOf(view)).contains("paused_for_quota"))
        assertEquals("", TaskMonitorService.unknownStatusNote(listOf(running)))
    }

    @Test
    fun anUnreadableStatusChangedKeepsTheLastStatusAndSaysSo() {
        val queued = TaskMonitorService.TaskView("t", null, TaskStatus.QUEUED.reported(), null, null, null, 1, null, emptyList())
        for (payload in listOf(buildJsonObject { }, buildJsonObject { put("to", 7) }, buildJsonObject { put("to", "Not Snake") })) {
            val event = TaskEvent("t", 2, "status.changed", payload, "2026-10-09T00:00:02Z")
            val view = TaskMonitorService.fold(queued, event, event.toRenderedEvent())
            assertEquals(TaskStatus.QUEUED.reported(), view.status, "payload $payload")
            assertTrue(view.notes.any { it.contains("unreadable payload") }, "payload $payload: ${view.notes}")
        }
    }

    @Test
    fun malformedEnumValuesStillFailTheFrame() {
        val bad = listOf(
            "7",
            "true",
            "null",
            "{}",
            "\"\"",
            "\"Paused\"",
            "\"paused for quota\"",
            "\"paused-for-quota\"",
            "\"_paused\"",
            "\"paused\\u202e\"",
            "\"" + "a".repeat(65) + "\"",
        )
        for (value in bad) {
            assertFailsWith<SerializationException>("status $value must fail") {
                CoreJson.decodeFromString(
                    TaskSummary.serializer(),
                    """{"id":"t","conversationId":"c","status":$value}""",
                )
            }
            assertFailsWith<SerializationException>("file status $value must fail") {
                CoreJson.decodeFromString(FileChange.serializer(), """{"path":"a","status":$value}""")
            }
        }
        // A required field that is simply missing is still a broken frame.
        assertFailsWith<SerializationException> {
            CoreJson.decodeFromString(TaskSummary.serializer(), """{"id":"t","conversationId":"c"}""")
        }
        // 64 chars of snake_case is the most an unknown value may be.
        val longest = "a".repeat(64)
        assertEquals(
            Reported.Unknown(longest),
            CoreJson.decodeFromString(FileChange.serializer(), """{"path":"a","status":"$longest"}""").status,
        )
    }

    @Test
    fun anAbsentOrNullWorkspaceModeStaysUnverifiedNotUnknown() {
        val absent = """{"name":"s","probedState":"running"}"""
        val explicitNull = """{"name":"s","probedState":"running","workspaceMode":null}"""
        for (json in listOf(absent, explicitNull)) {
            val fromString = CoreJson.decodeFromString(SandboxSummary.serializer(), json)
            val fromTree = CoreJson.decodeFromJsonElement(SandboxSummary.serializer(), CoreJson.parseToJsonElement(json))
            for (sandbox in listOf(fromString, fromTree)) {
                assertNull(sandbox.workspaceMode, json)
                assertTrue(sandbox.modeView().label.contains("unverified"), sandbox.modeView().label)
                assertTrue(sandbox.modeView().hostWritable)
            }
        }
        val known = CoreJson.decodeFromJsonElement(
            SandboxSummary.serializer(),
            CoreJson.parseToJsonElement("""{"name":"s","workspaceMode":"sbx_clone"}"""),
        )
        assertEquals(WorkspaceMode.SBX_CLONE.reported(), known.workspaceMode)
        assertFalse(known.modeView().hostWritable)
    }

    @Test
    fun knownValuesStillEncodeToTheirWireNames() {
        val summary = TaskSummary("t", "c", TaskStatus.AWAITING_INPUT.reported())
        assertTrue(CoreJson.encodeToString(TaskSummary.serializer(), summary).contains("\"status\":\"awaiting_input\""))
        val sandbox = SandboxSummary(name = "s", workspaceMode = WorkspaceMode.DIRECT_MOUNT.reported())
        assertTrue(CoreJson.encodeToString(SandboxSummary.serializer(), sandbox).contains("\"workspaceMode\":\"direct_mount\""))
    }

    // -- apply selection ------------------------------------------------------

    private val base = "0123456789abcdef0123456789abcdef01234567"

    private fun session(changes: String) = labs.dkv.sandpane.services.ReviewSession.fromAnswer(
        CoreJson.parseToJsonElement(
            """{"taskId":"t1","baseCommit":"$base","hostDirty":false,"reviewId":"r1","changes":[$changes]}""",
        ),
        coreInstanceId = "i",
    )

    private val blob = "a".repeat(40)

    @Test
    fun unknownFileStatusesAreListedButNeverSelected() {
        val s = session(
            """{"path":"a.kt","status":"modified","taskBlob":"$blob","taskMode":"100644"},""" +
                """{"path":"b.kt","status":"type_changed","taskBlob":"$blob","taskMode":"100644"}""",
        )
        assertIs<Reported.Unknown>(s.changeSet.changes[1].status)
        assertNull(ApplyPlan.selectability(s.changeSet, s.changeSet.changes[0]))
        assertEquals(ApplyPlan.REASON_UNKNOWN_STATUS, ApplyPlan.selectability(s.changeSet, s.changeSet.changes[1]))
        val row = ApplyPlan.rowLabel(s, s.changeSet.changes[1])
        assertTrue(row.startsWith("type_changed  b.kt"), row)
        assertTrue(row.contains("not selectable"), row)
        val ready = assertIs<ApplyPlan.Decision.Ready>(ApplyPlan.decide(s, listOf(0)))
        assertEquals(listOf("a.kt"), ready.entries.map { it.path })
    }

    @Test
    fun anUnknownStatusEntryIsRefusedNotSent() {
        val s = session("""{"path":"b.kt","status":"type_changed","taskBlob":"$blob","taskMode":"100644"}""")
        val refused = assertIs<ApplyPlan.Decision.Refused>(ApplyPlan.decide(s, listOf(0)))
        assertTrue(refused.reason.contains(ApplyPlan.REASON_UNKNOWN_STATUS), refused.reason)
    }
}
