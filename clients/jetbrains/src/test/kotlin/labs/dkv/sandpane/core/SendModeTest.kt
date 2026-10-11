package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.ConversationSendParams
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreFeatures
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.TaskSummary
import labs.dkv.sandpane.services.TaskMonitorService
import labs.dkv.sandpane.ui.TaskRowText
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A4 (`conversation.send` mode, design 2026-10-09 §3.4), client side. The units under test are the
 * REAL seams the chat panel calls: [SendModes.sendParams] (what the composer builds),
 * [KeyedRequests.newSend] / [KeyedRequests.retrySend] (what goes on the wire) and [CoreJson] (the
 * bytes). No transport is involved, so nothing is mocked.
 */
class SendModeTest {

    private fun caps(vararg features: String) = CoreCapabilities(
        protocolVersion = 1,
        coreVersion = "0.1.0",
        instanceId = "i",
        platform = "macos",
        methods = CoreMethods.ALL,
        features = features.toList(),
    )

    private val a4 = caps(CoreFeatures.IDEMPOTENCY_KEYS, CoreFeatures.CONVERSATION_SEND_MODE)
    private val preA4 = caps(CoreFeatures.IDEMPOTENCY_KEYS, CoreFeatures.SANDBOX_CREATE_AGENT, CoreFeatures.CONVERSATION_SANDBOX_ID)

    private fun frame(p: ConversationSendParams): String = CoreJson.encodeToString(ConversationSendParams.serializer(), p)

    private fun ready(p: KeyedRequests.Prepared<ConversationSendParams>): ConversationSendParams =
        assertIs<KeyedRequests.Prepared.Ready<ConversationSendParams>>(p).params

    /** What the composer builds for the user's SELECTED choice (review W3: never downgraded). */
    private fun composed(choice: SendModes.Choice, caps: CoreCapabilities?): ConversationSendParams =
        assertIs<SendModes.ComposerSend.Ready>(SendModes.composerSend("c1", "explain", emptyList(), choice, caps)).params

    @Test
    fun taskOmitsTheModeKeySoTheFrameIsByteIdenticalToAnA3bFrame() {
        val task = ready(KeyedRequests.newSend(composed(SendModes.Choice.TASK, a4), a4) { "k-1" })
        // What an A2/A3b build sent for the same message, built without A4 at all.
        val a3b = ConversationSendParams(conversationId = "c1", content = "explain", idempotencyKey = "k-1")
        assertEquals(frame(a3b), frame(task))
        assertFalse(frame(task).contains("mode"), frame(task))
    }

    @Test
    fun discussSendsModeDiscussOnlyWhenAdvertised() {
        val discuss = ready(KeyedRequests.newSend(composed(SendModes.Choice.DISCUSS, a4), a4) { "k-2" })
        assertTrue(frame(discuss).contains("\"mode\":\"discuss\""), frame(discuss))
        assertEquals("discuss", SendModes.Choice.DISCUSS.wire)
        assertNull(SendModes.Choice.TASK.wire, "Task is never spelled out on the wire")
        assertEquals(SendModes.Choice.TASK, SendModes.Choice.entries.first(), "the choice defaults to Task")
    }

    @Test
    fun aCoreThatDoesNotAdvertiseSendModeNeverReceivesIt() {
        for (c in listOf(preA4, caps(), null)) {
            // The combo is shown disabled at Task, saying why (display state only).
            val state = assertIs<SendModes.ChoiceState.Disabled>(SendModes.choiceState(c))
            assertTrue(state.reason.contains("not supported by this Core"), state.reason)
            assertEquals(SendModes.Choice.TASK, SendModes.effectiveChoice(SendModes.Choice.DISCUSS, c))
            // Task is still sendable there, with no mode key at all.
            val p = KeyedRequests.newSend(composed(SendModes.Choice.TASK, c), c) { "k" }
            assertFalse(frame(ready(p)).contains("mode"))
        }
        assertIs<SendModes.ChoiceState.Enabled>(SendModes.choiceState(a4))
        // A mode that reaches the gate anyway (a reconnect raced the composer) is refused: nothing is sent.
        var minted = 0
        val raced = KeyedRequests.newSend(ConversationSendParams("c1", "explain", mode = "discuss"), preA4) { minted++; "k" }
        val refused = assertIs<KeyedRequests.Prepared.Refused<ConversationSendParams>>(raced)
        assertEquals("mode", refused.field)
        assertTrue(refused.reason.contains(CoreFeatures.CONVERSATION_SEND_MODE) && refused.reason.contains("nothing was sent"), refused.reason)
        assertEquals(0, minted, "no key is minted for a refused send")
    }

    /**
     * Review W3: a reconnect to a pre-A4 Core can land after the user picked Discuss and before the
     * combo is reset. The send must then be REFUSED visibly (nothing sent) \u2014 never silently sent as Task.
     */
    @Test
    fun aDiscussChoiceMeetingACoreWithoutTheFeatureIsRefusedNeverSentAsTask() {
        for (c in listOf(preA4, caps(), null)) {
            val refused = assertIs<SendModes.ComposerSend.Refused>(
                SendModes.composerSend("c1", "explain", emptyList(), SendModes.Choice.DISCUSS, c),
            )
            assertTrue(refused.reason.contains(CoreFeatures.CONVERSATION_SEND_MODE) && refused.reason.contains("nothing was sent"), refused.reason)
            // The gate behind it refuses too, so no frame (and no Task frame) can be built for it.
            var minted = 0
            val params = SendModes.sendParams("c1", "explain", emptyList(), SendModes.Choice.DISCUSS)
            assertEquals("discuss", params.mode, "the user's choice is passed as-is, never downgraded")
            assertIs<KeyedRequests.Prepared.Refused<ConversationSendParams>>(KeyedRequests.newSend(params, c) { minted++; "k" })
            assertEquals(0, minted)
        }
        // With the feature, the selected choice is what is sent; no selection means Task.
        assertEquals("discuss", composed(SendModes.Choice.DISCUSS, a4).mode)
        assertNull(assertIs<SendModes.ComposerSend.Ready>(SendModes.composerSend("c1", "x", emptyList(), null, a4)).params.mode)
    }

    /** Review I3: a row Core sent with a non-string field is never echoed into user-visible text. */
    @Test
    fun aMalformedTaskListRowIsNeverEchoed() {
        val row = """[{"id":"t-row-secret-0001","conversationId":"c-row-secret","status":"queued","mode":7}]"""
        val rpc = object : CoreRpc {
            override fun request(method: String, params: kotlinx.serialization.json.JsonElement) =
                java.util.concurrent.CompletableFuture.completedFuture(CoreJson.parseToJsonElement(row))
        }
        val error = CoreCommands(rpc) { caps() }.taskList().handle { _, e -> e }.get()
        assertTrue(error != null, "a non-string mode must not decode")
        // A decode failure that reaches the shared seam by any other path is fixed text too.
        val raw = runCatching {
            CoreJson.decodeFromString(kotlinx.serialization.builtins.ListSerializer(TaskSummary.serializer()), row)
        }.exceptionOrNull()!!
        for (e in listOf(error, raw, IllegalArgumentException("Unexpected JSON token at offset 9: ... JSON input: $row"))) {
            val text = ErrorAttribution.describe(CoreMethods.TASK_LIST, e)
            for (part in listOf("t-row-secret", "c-row-secret", "\"mode\"", "JSON input", "queued")) {
                assertFalse(text.contains(part), "user-visible text echoes '$part': $text")
            }
            assertTrue(text.contains("its content is not shown"), text)
        }
    }

    @Test
    fun aKeyedRetryResendsIdenticalParamsIncludingMode() {
        val first = ready(KeyedRequests.newSend(composed(SendModes.Choice.DISCUSS, a4), a4) { "k-3" })
        // Whatever the composer shows now is irrelevant: the retry reuses the prepared params.
        val again = ready(KeyedRequests.retrySend(first, a4))
        assertEquals(first, again)
        assertEquals(frame(first), frame(again))
        assertTrue(frame(again).contains("\"mode\":\"discuss\"") && frame(again).contains("\"idempotencyKey\":\"k-3\""))
        // A reconnect to a pre-A4 Core would drop mode and record a task: the retry is refused instead.
        val downgraded = assertIs<KeyedRequests.Prepared.Refused<ConversationSendParams>>(KeyedRequests.retrySend(first, preA4))
        assertEquals("mode", downgraded.field)
        // A Task retry on that Core is still fine (no mode key at all).
        val task = ready(KeyedRequests.newSend(composed(SendModes.Choice.TASK, a4), a4) { "k-4" })
        assertEquals(task, ready(KeyedRequests.retrySend(task, preA4)))
    }

    @Test
    fun anUnknownTaskModeDecodesAndIsShownRevealedAndCapped() {
        val odd = "plan\u202E" + "x".repeat(400)
        val json = """{"id":"t1","conversationId":"c1","status":"queued","mode":"${"plan\\u202E" + "x".repeat(400)}","chosenSandboxName":"atlas-auth"}"""
        val summary = CoreJson.decodeFromString(TaskSummary.serializer(), json)
        assertEquals(odd, summary.mode)
        assertEquals("atlas-auth", summary.chosenSandboxName)
        val lines = SendModes.details(summary.mode, summary.chosenSandboxName)
        assertEquals(2, lines.size, lines.toString())
        assertTrue(lines[0].startsWith("Send mode: plan\\u202E"), lines[0])
        assertFalse(lines[0].contains("\u202E"), "revealed, never passed through")
        assertFalse(lines[0].contains("x".repeat(201)), "capped")
        assertEquals("sandbox chosen by its chat \u2014 not where it runs: atlas-auth", lines[1])
        // Old tasks: both absent, nothing shown, nothing invented.
        val old = CoreJson.decodeFromString(TaskSummary.serializer(), """{"id":"t1","conversationId":"c1","status":"queued"}""")
        assertNull(old.mode)
        assertNull(old.chosenSandboxName)
        assertTrue(SendModes.details(old.mode, old.chosenSandboxName).isEmpty())
        assertEquals(listOf("Send mode: discuss"), SendModes.details("discuss", null))
    }

    @Test
    fun taskRowsShowCoresSendModeAndChosenSandboxName() {
        val summary = TaskSummary(
            id = "t1234567890",
            conversationId = "c1",
            status = labs.dkv.sandpane.model.TaskStatus.QUEUED.let { labs.dkv.sandpane.model.Reported.Known(it) },
            mode = "discuss",
            chosenSandboxName = "atlas-auth",
        )
        val view = TaskMonitorService.fromSummary(summary, null)
        assertEquals("discuss", view.mode)
        assertEquals("atlas-auth", view.chosenSandboxName)
        val meta = TaskRowText.meta("t1234567890", view)
        assertTrue(meta.contains("Send mode: discuss"), meta)
        assertTrue(meta.contains("sandbox chosen by its chat \u2014 not where it runs: atlas-auth"), meta)
        // A later summary without the fields keeps what Core said before (never invented, never dropped).
        val later = TaskMonitorService.fromSummary(summary.copy(mode = null, chosenSandboxName = null), view)
        assertEquals("discuss", later.mode)
        assertEquals("atlas-auth", later.chosenSandboxName)
        // A pre-A4 task row reads exactly as before.
        val plain = TaskMonitorService.fromSummary(summary.copy(mode = null, chosenSandboxName = null), null)
        assertEquals("task t1234567 \u00B7 ${plain.statusLabel} (reported by Core)", TaskRowText.meta("t1234567890", plain))
    }

    @Test
    fun theChosenSandboxNameNeverBecomesTheBindingOrFeedsAnyOtherLogic() {
        val summary = TaskSummary(
            id = "t1",
            conversationId = "c1",
            status = labs.dkv.sandpane.model.Reported.Known(labs.dkv.sandpane.model.TaskStatus.QUEUED),
            chosenSandboxName = "atlas-auth",
        )
        val view = TaskMonitorService.fromSummary(summary, null)
        assertNull(view.sandboxName, "sandboxName keeps its pre-A4 binding-only meaning")
        assertNull(TaskMonitorService.fromSummary(summary, view).sandboxName)
        // Only display code may read it: no isolation label, stop/remove count or scope logic exists
        // that could (this plugin has none today), and none may start reading it unnoticed.
        val main = File(System.getProperty("user.dir"), "src/main/kotlin")
        val readers = main.walkTopDown().filter { it.isFile && it.extension == "kt" && it.readText().contains("chosenSandboxName") }
            .map { it.name }.toSortedSet()
        assertEquals(sortedSetOf("Models.kt", "SendMode.kt", "TaskMonitorService.kt", "TaskRowText.kt"), readers)
    }

    @Test
    fun theComposerCopySaysNeitherModeRunsAnAgent() {
        val copy = SendModes.COMPOSER_COPY
        assertTrue(copy.contains("Neither Task nor Discuss runs an agent in this build"), copy)
        assertTrue(copy.contains("queued"), copy)
        for (claim in listOf("safe", "read-only", "isolated", "sandboxed", "executes")) {
            assertFalse(copy.lowercase().contains(claim), "the copy must not claim '$claim': $copy")
        }
        assertTrue(SendModes.NOT_SUPPORTED.contains("not supported by this Core"))
    }

    @Test
    fun coresInvalidModeRefusalGetsHonestCopy() {
        val hint = ConversationOutcomes.sendRefusalHint(CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, SendModes.MSG_SEND_MODE_INVALID))
        assertTrue(hint != null && hint.contains("Core did not accept the message") && hint.contains(SendModes.MSG_SEND_MODE_INVALID), hint.toString())
        assertFalse(hint!!.lowercase().contains("unknown"))
        assertNull(
            ConversationOutcomes.sendRefusalHint(CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, SendModes.MSG_SEND_MODE_INVALID, raisedByCore = false)),
            "only Core's own refusal is worded as Core's",
        )
        assertEquals("mode must be \"task\" or \"discuss\"", SendModes.MSG_SEND_MODE_INVALID)
        assertEquals(listOf("task", "discuss"), SendModes.WIRE_VALUES)
    }
}
