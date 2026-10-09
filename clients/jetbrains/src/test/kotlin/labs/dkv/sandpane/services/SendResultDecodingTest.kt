package labs.dkv.sandpane.services

import labs.dkv.sandpane.core.CoreRpcException
import labs.dkv.sandpane.core.ErrorAttribution
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** Review bug 11: no "Core accepted task " success line with an empty id. */
class SendResultDecodingTest {

    private val decode = TaskMonitorService.Companion::decodeSendResult

    @Test
    fun aTaskSummaryIsAccepted() {
        val result = decode(
            buildJsonObject {
                put("id", "task-123")
                put("conversationId", "conv-1")
                put("status", "queued")
            },
        )
        val summary = assertIs<TaskMonitorService.SendResult.FromSummary>(result)
        assertEquals("task-123", summary.taskId)
    }

    @Test
    fun anIdOnlyReplyIsAccepted() {
        val result = decode(buildJsonObject { put("taskId", "task-9") })
        assertEquals("task-9", assertIs<TaskMonitorService.SendResult.TaskIdOnly>(result).taskId)
    }

    @Test
    fun repliesWithoutAUsableTaskIdFailAsThisPluginsVerdictNotCores() {
        val unusable = listOf(
            buildJsonObject { },
            buildJsonObject { put("taskId", "") },
            buildJsonObject { put("taskId", "   ") },
            buildJsonObject { put("taskId", JsonNull) },
            JsonPrimitive("task-1"),
            JsonNull,
        )
        for (element in unusable) {
            val error = assertFailsWith<CoreRpcException>("must not decode: $element") { decode(element) }
            assertEquals("INTERNAL", error.code)
            assertFalse(error.raisedByCore, "Core did not raise this; the reply was unusable")
            assertTrue(ErrorAttribution.describe(error).contains("raised by this plugin"))
        }
    }
}
