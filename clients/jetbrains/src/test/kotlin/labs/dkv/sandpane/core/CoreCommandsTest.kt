package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.model.ConversationHistoryParams
import labs.dkv.sandpane.model.ConversationHistoryResult
import labs.dkv.sandpane.model.ConversationListParams
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.MAX_CURSOR_KEY_LEN
import labs.dkv.sandpane.model.MAX_LIST_LIMIT
import labs.dkv.sandpane.model.MAX_SCOPING_ID_LEN
import labs.dkv.sandpane.model.MAX_SUBSCRIBE_CURSORS
import labs.dkv.sandpane.model.MessageRecord
import labs.dkv.sandpane.model.TaskListParams
import labs.dkv.sandpane.model.TaskStatus
import labs.dkv.sandpane.model.TaskSubscribeParams
import labs.dkv.sandpane.model.TaskSummary
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.net.UnixDomainSocketAddress
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A recording stand-in for the transport, so these tests assert what WOULD have gone on the wire
 * without a socket, an IDE, or a running Core.
 *
 * The framing/wire-name tests cover the byte level; this covers the request-building rules:
 * guard refusals, feature gating, and the three `task.subscribe` cursor shapes.
 */
private class RecordingRpc : CoreRpc {
    val sent = ArrayList<Pair<String, JsonObject>>()

    /** Default is the shape every list-returning read decodes; object reads set their own reply. */
    var reply: String = "[]"

    override fun request(method: String, params: kotlinx.serialization.json.JsonElement): CompletableFuture<kotlinx.serialization.json.JsonElement> {
        sent += method to (params as JsonObject)
        return CompletableFuture.completedFuture(CoreJson.parseToJsonElement(reply))
    }

    fun only(): Pair<String, JsonObject> {
        assertEquals(1, sent.size, "expected exactly one request")
        return sent.single()
    }
}

private fun caps(vararg methods: String): CoreCapabilities = CoreCapabilities(
    protocolVersion = 1,
    coreVersion = "0.1.0",
    instanceId = "test-instance",
    platform = "macos",
    methods = methods.toList(),
)

/**
 * CoreCommands: guards refuse before anything is sent, feature detection gates the additive
 * methods, and the cursor rules match `TaskSubscribeParams` in Rust exactly.
 *
 * Each guard test asserts BOTH halves of the promise — the future fails AND `sent` is empty —
 * because "we validated" only means something if nothing reached the transport.
 */
class CoreCommandsTest {

    private val allV1: CoreCapabilities = caps(*CoreMethods.ALL.toTypedArray())

    private fun await(execution: ExecutionException): Throwable = execution.cause ?: execution

    // -----------------------------------------------------------------------
    // guards: no write on invalid input
    // -----------------------------------------------------------------------

    @Test
    fun blankProjectIdIsRefusedLocallyAndNeverSent() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        val error = assertFailsWith<ExecutionException> {
            commands.taskList(TaskListParams(projectId = "   ")).get()
        }
        val cause = await(error)
        assertTrue(cause is CoreValidationException, "expected a client guard, got ${cause::class.simpleName}")
        assertEquals("projectId", (cause as CoreValidationException).field)
        assertTrue(cause.message!!.contains("identifier is required"))
        assertTrue(rpc.sent.isEmpty(), "an invalid scope must never reach the transport")
    }

    @Test
    fun oversizedScopingIdIsRefusedAndNeverSent() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        val tooLong = "p".repeat(MAX_SCOPING_ID_LEN + 1)
        val error = assertFailsWith<ExecutionException> {
            commands.conversationList(ConversationListParams(projectId = tooLong)).get()
        }
        assertTrue(await(error) is CoreValidationException)
        assertTrue(rpc.sent.isEmpty())
    }

    /**
     * `Validator::display_text` bounds `chars().count()` = Unicode scalar values.
     * Each 🧵 is one scalar but two UTF-16 units, so counting `String.length` would
     * refuse an id Core accepts (AGENTS.md rule 2: the client mirror must match).
     */
    @Test
    fun scopingIdIsBoundedByCodePointsNotUtf16Units() {
        val threads = "🧵".repeat(MAX_SCOPING_ID_LEN)
        assertEquals(MAX_SCOPING_ID_LEN, threads.codePointCount(0, threads.length))
        assertEquals(MAX_SCOPING_ID_LEN * 2, threads.length, "the trap this test exists for")
        assertEquals(threads, CoreGuards.requireScopingId(threads, "projectId"))
        val error = assertFailsWith<CoreValidationException> {
            CoreGuards.requireScopingId(threads + "🧵", "projectId")
        }
        assertTrue(error.message!!.contains("exceeds max length"))
    }

    /**
     * `Validator::display_text` refuses control characters EXCEPT `\n` and `\t`, so the mirror
     * must tolerate exactly those two and refuse the rest — refusing a newline here would be the
     * client inventing a stricter rule than Core has, and accepting `\u0007` would be sending
     * something Core answers with VALIDATION_FAILED.
     */
    @Test
    fun disallowedControlCharactersAreRefusedBeforeTheSocket() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        val error = assertFailsWith<ExecutionException> {
            commands.conversationHistory(ConversationHistoryParams(conversationId = "c1\u0007rm -rf /"))
                .get()
        }
        assertTrue(await(error) is CoreValidationException, "a disallowed control char must be refused locally")
        assertTrue(rpc.sent.isEmpty())

        // DEL is refused too, per the same Rust rule (`c as u32 == 0x7f`).
        rpc.sent.clear()
        assertFailsWith<ExecutionException> {
            commands.taskList(TaskListParams(projectId = "p1\u007f")).get()
        }
        assertTrue(rpc.sent.isEmpty())
    }

    @Test
    fun newlineAndTabAreToleratedBecauseCoreToleratesThem() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        // Mirroring Core is the requirement; a stricter client rule would reject ids Core accepts.
        commands.taskList(TaskListParams(projectId = "p1\n")).get()
        val payload = rpc.only().second
        assertEquals("p1\n", payload["projectId"]!!.jsonPrimitive.content)
    }

    @Test
    fun blankConversationIdIsRefusedForHistory() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        assertFailsWith<ExecutionException> {
            commands.conversationHistory(ConversationHistoryParams(conversationId = "")).get()
        }
        assertTrue(rpc.sent.isEmpty())
    }

    @Test
    fun negativeLimitIsRefusedButLargeLimitsAreClamped() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        assertFailsWith<ExecutionException> { commands.taskList(TaskListParams(limit = -5)).get() }
        assertTrue(rpc.sent.isEmpty(), "a negative limit is not representable in Rust's u32")

        // Oversized asks are clamped into the same range Core would clamp to — never honoured.
        val clamped = commands.taskList(TaskListParams(limit = 10_000))
        assertNotNull(clamped)
        val sent = rpc.only()
        assertEquals(CoreMethods.TASK_LIST, sent.first)
        assertEquals(MAX_LIST_LIMIT, (sent.second["limit"] ?: error("limit missing")).jsonPrimitive.int)
    }

    @Test
    fun absentLimitStaysAbsentSoCoreOwnsTheDefault() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        commands.conversationList(ConversationListParams(projectId = "p1")).get()
        val payload = rpc.only().second
        assertFalse(payload.containsKey("limit"), "the client must not invent Core's default on the wire")
        assertEquals("p1", payload["projectId"]!!.jsonPrimitive.content)
    }

    @Test
    fun unknownStatusIsNeverNormalized() {
        // TaskStatus is a closed enum in both languages, so an unknown string cannot even be
        // constructed here; what IS testable is that a duplicate filter collapses rather than
        // multiplying bound parameters, and that the wire spelling stays snake_case.
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        commands.taskList(
            TaskListParams(
                statuses = listOf(TaskStatus.RUNNING, TaskStatus.RUNNING, TaskStatus.AWAITING_REVIEW),
            ),
        ).get()
        val statuses = rpc.only().second["statuses"] as JsonArray
        assertEquals(2, statuses.size, "duplicate statuses must collapse, as Core does")
        assertEquals("running", statuses[0].jsonPrimitive.content)
        assertEquals("awaiting_review", statuses[1].jsonPrimitive.content)
    }

    @Test
    fun emptyStatusFilterIsOmittedRatherThanSentAsAnEmptyList() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        commands.taskList(TaskListParams(statuses = emptyList())).get()
        assertFalse(rpc.only().second.containsKey("statuses"))
    }

    // -----------------------------------------------------------------------
    // feature detection gates the additive methods
    // -----------------------------------------------------------------------

    @Test
    fun nonAdvertisedMethodIsNeverSent() {
        val rpc = RecordingRpc()
        // A Core from before the discovery revision: it answers `system.probe` without `methods`.
        val oldCore = CoreCapabilities(
            protocolVersion = 1, coreVersion = "0.0.9", instanceId = "i", platform = "macos",
        )
        val commands = CoreCommands(rpc) { oldCore }

        listOf(
            { commands.taskList() },
            { commands.conversationList() },
            { commands.conversationHistory(ConversationHistoryParams(conversationId = "c1")) },
        ).forEach { call ->
            val error = assertFailsWith<ExecutionException> { call().get() }
            val cause = await(error)
            assertTrue(cause is MethodNotSupportedException, "expected advertisement gate, got $cause")
        }
        assertTrue(rpc.sent.isEmpty(), "a method Core does not advertise must never be sent")
    }

    @Test
    fun disconnectedCoreRefusesAdditiveCallsWithoutSending() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { null }
        val error = assertFailsWith<ExecutionException> { commands.taskList().get() }
        assertTrue(await(error) is MethodNotSupportedException)
        assertTrue(rpc.sent.isEmpty())
    }

    @Test
    fun advertisedMethodsAreSentWithTheirPayload() {
        val rpc = RecordingRpc().apply {
            reply = """[{"id":"t1","conversationId":"c1","status":"completed"}]"""
        }
        val commands = CoreCommands(rpc) { allV1 }
        val rows = commands.taskList(TaskListParams(projectId = "p1")).get()
        assertEquals(CoreMethods.TASK_LIST, rpc.only().first)
        assertEquals(1, rows.size)
        assertEquals(TaskStatus.COMPLETED, rows.single().status)
        assertEquals("t1", rows.single().id)
    }

    @Test
    fun originalMethodsAreNotGatedOnAdvertisement() {
        // task.subscribe/git.review/etc. are the protocol-v1 baseline: an old Core still dispatches
        // them, so gating them would break the plugin against a Core it must support.
        val rpc = RecordingRpc().apply { reply = "[]" }
        val oldCore = caps("system.probe", "task.subscribe", "git.review")
        val events = CoreCommands(rpc) { oldCore }.taskSubscribe(TaskSubscribeParams(taskId = "t1")).get()
        assertTrue(events.isEmpty())
        assertEquals(CoreMethods.TASK_SUBSCRIBE, rpc.only().first)
    }

    // -----------------------------------------------------------------------
    // the three task.subscribe cursor shapes
    // -----------------------------------------------------------------------

    @Test
    fun taskIdPathSendsTheScalarAndNeverTheMap() {
        val rpc = RecordingRpc().apply { reply = "[]" }
        val commands = CoreCommands(rpc) { allV1 }
        // A caller that passes BOTH keeps its old semantics: Core ignores the map alongside taskId.
        commands.taskSubscribe(
            TaskSubscribeParams(
                taskId = "task-a",
                afterSequence = 7,
                afterSequences = mapOf("task-a" to 3L, "task-b" to 9L),
            ),
        ).get()
        val payload = rpc.only().second
        assertEquals("task-a", payload["taskId"]!!.jsonPrimitive.content)
        assertEquals(7L, payload["afterSequence"]!!.jsonPrimitive.long)
        assertFalse(
            payload.containsKey("afterSequences"),
            "sending a map Core would discard implies an effect it does not have",
        )
    }

    @Test
    fun projectWideMapPathSendsPerTaskCursorsAndNoTaskId() {
        val rpc = RecordingRpc().apply { reply = "[]" }
        val commands = CoreCommands(rpc) { allV1 }
        commands.taskSubscribe(
            TaskSubscribeParams(
                projectId = "p1",
                afterSequence = 0,
                afterSequences = linkedMapOf("task-a" to 5L, "task-b" to 2L),
            ),
        ).get()
        val payload = rpc.only().second
        assertEquals("p1", payload["projectId"]!!.jsonPrimitive.content)
        assertFalse(payload.containsKey("taskId"))
        val cursors = payload["afterSequences"] as JsonObject
        assertEquals(5L, cursors["task-a"]!!.jsonPrimitive.long)
        assertEquals(2L, cursors["task-b"]!!.jsonPrimitive.long)
    }

    @Test
    fun noMapIsTheLegacySharedScalarShape() {
        val rpc = RecordingRpc().apply { reply = "[]" }
        val commands = CoreCommands(rpc) { allV1 }
        commands.taskSubscribe(TaskSubscribeParams(projectId = "p1", afterSequence = 4)).get()
        val payload = rpc.only().second
        assertEquals(4L, payload["afterSequence"]!!.jsonPrimitive.long)
        assertFalse(payload.containsKey("afterSequences"), "absence must stay absence, not become {}")
    }

    @Test
    fun emptyCursorMapIsRefusedNotSilentlyDowngradedToTheScalar() {
        // `{}` and "no map" are DIFFERENT requests to Core: the first replays every scoped task
        // from 0, the second applies the shared scalar. Collapsing them would silently change how
        // much of the log lands in the UI.
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        val error = assertFailsWith<ExecutionException> {
            commands.taskSubscribe(TaskSubscribeParams(projectId = "p1", afterSequences = emptyMap())).get()
        }
        assertTrue(await(error) is CoreValidationException)
        assertTrue(rpc.sent.isEmpty())
    }

    @Test
    fun negativeCursorsAreClampedToZeroLikeCore() {
        val rpc = RecordingRpc().apply { reply = "[]" }
        val commands = CoreCommands(rpc) { allV1 }
        commands.taskSubscribe(TaskSubscribeParams(taskId = "t1", afterSequence = -9)).get()
        assertEquals(0L, rpc.only().second["afterSequence"]!!.jsonPrimitive.long)

        rpc.sent.clear()
        commands.taskSubscribe(
            TaskSubscribeParams(projectId = "p1", afterSequences = mapOf("t1" to -3L)),
        ).get()
        assertEquals(0L, (rpc.only().second["afterSequences"] as JsonObject)["t1"]!!.jsonPrimitive.long)
    }

    @Test
    fun oversizedCursorMapIsRefused() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        val huge = (0..MAX_SUBSCRIBE_CURSORS).associate { "task-$it" to 1L }
        val error = assertFailsWith<ExecutionException> {
            commands.taskSubscribe(TaskSubscribeParams(projectId = "p1", afterSequences = huge)).get()
        }
        val cause = await(error) as CoreValidationException
        assertTrue(cause.message!!.contains(MAX_SUBSCRIBE_CURSORS.toString()))
        assertTrue(rpc.sent.isEmpty())
    }

    @Test
    fun oversizedCursorKeyIsRefusedByByteLengthNotCharLength() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        // Rust measures `str::len()` (bytes). A multi-byte key must be measured the same way, so a
        // 100-CHAR / 150-byte key is refused here and would be refused by Core.
        val wideKey = "ü".repeat(MAX_CURSOR_KEY_LEN)
        assertTrue(wideKey.length == MAX_CURSOR_KEY_LEN && wideKey.toByteArray().size > MAX_CURSOR_KEY_LEN)
        val error = assertFailsWith<ExecutionException> {
            commands.taskSubscribe(TaskSubscribeParams(projectId = "p1", afterSequences = mapOf(wideKey to 1L))).get()
        }
        assertTrue(await(error) is CoreValidationException)
        assertTrue(rpc.sent.isEmpty())

        // The empty key is the other half of the same rule.
        rpc.sent.clear()
        assertFailsWith<ExecutionException> {
            commands.taskSubscribe(TaskSubscribeParams(projectId = "p1", afterSequences = mapOf("" to 1L))).get()
        }
        assertTrue(rpc.sent.isEmpty())
    }

    // -----------------------------------------------------------------------
    // conversation.history result decoding + disclosure
    // -----------------------------------------------------------------------

    @Test
    fun truncatedPageDisclosesAndCarriesTheContinuationCursor() {
        val rpc = RecordingRpc().apply {
            reply = """
                {"messages":[
                   {"id":"m1","conversationId":"c1","role":"user","content":"a","sequence":1},
                   {"id":"m2","conversationId":"c1","role":"assistant","content":"b","sequence":2}],
                 "truncated":true,"nextSequence":2}
            """.trimIndent()
        }
        val page = CoreCommands(rpc) { allV1 }
            .conversationHistory(ConversationHistoryParams(conversationId = "c1", limit = 2)).get()
        assertEquals(2, page.messages.size)
        assertTrue(page.truncated)
        assertEquals(2L, page.nextSequence)
        // The disclosure is human-readable and names the cursor the next call must use.
        val note = page.truncationNote()
        assertNotNull(note)
        assertTrue(note.contains("more remain"), note)
        assertTrue(note.contains("sequence 2"), note)
    }

    @Test
    fun fullPageDisclosesNothing() {
        val page = ConversationHistoryResult(
            messages = listOf(MessageRecord("m1", "c1", "user", "a", 1)),
            truncated = false,
            nextSequence = 1,
        )
        assertNull(page.truncationNote())
    }

    @Test
    fun truncatedButEmptyPageSaysItCannotProceedInsteadOfLookingComplete() {
        // Core's first row is always allowed through, so this shape means the cursor is already
        // past everything readable — "0 messages, truncated" must not render as a full transcript.
        val page = ConversationHistoryResult(messages = emptyList(), truncated = true, nextSequence = 0)
        val note = page.truncationNote()
        assertNotNull(note)
        assertTrue(note.contains("no rows"), note)
    }

    @Test
    fun coreErrorOnHistoryPropagatesInsteadOfBecomingAnEmptyPage() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        // Emulate the manager surfacing Core's NOT_FOUND as a failed future.
        rpc.reply = "not-an-object"
        val error = assertFailsWith<Exception> {
            commands.conversationHistory(ConversationHistoryParams(conversationId = "gone")).get()
        }
        assertNotNull(error, "a malformed/failed history answer must never decode into an empty page")
    }

    @Test
    fun conversationListDecodesCoreRows() {
        val rpc = RecordingRpc().apply {
            reply = """[{"id":"c1","projectId":"p1","title":"Atlas chat","agentId":"codex","createdAt":"t"}]"""
        }
        val rows = CoreCommands(rpc) { allV1 }.conversationList(ConversationListParams(projectId = "p1")).get()
        assertEquals(listOf(Conversation("c1", "p1", "Atlas chat", "codex", "t")), rows)
    }

    @Test
    fun taskListRejectsAMissingRequiredIdBeforeSending() {
        val rpc = RecordingRpc()
        val commands = CoreCommands(rpc) { allV1 }
        // An unvalidated external value must not flow into an argument position (AGENTS.md rule 2).
        assertFailsWith<ExecutionException> { commands.taskList(TaskListParams(projectId = "p".repeat(500))).get() }
        assertTrue(rpc.sent.isEmpty())
    }

    /**
     * A guard refusal and a Core verdict must be tellable apart by their TYPES *and* by the text a
     * UI or a log ends up rendering (AGENTS.md rule 5: this client's word must never read like
     * Core's judgment, and Core's judgment must never be shown stripped of what makes it Core's).
     *
     * Two properties, each pinned here, and they pull in opposite directions on purpose:
     *
     *  1. `.message` on a [CoreRpcException] is Core's wording VERBATIM, with no code prefix.
     *     That is not cosmetic: [labs.dkv.sandpane.core.ConnectionManager.recordReplayRefusal]
     *     hands `code to message` to [CoreGuards.isOversizedReplayRefusal], which matches
     *     `message.startsWith("replay of ")`. Prefixing `.message` would silently break that
     *     recognition, so re-prefixing here is forbidden, not merely unfashionable.
     *  2. The code is part of the verdict, so EVERY default rendering of the throwable must carry
     *     it: `toString()`, a stack trace, and — the one the UI actually sees — the message of the
     *     `CompletionException` that a `whenComplete { _, error -> }` handler receives, because
     *     `ChatPanel` shows `error.message` for the additive reads.
     */
    @Test
    fun localGuardsAndCoreVerdictsAreDistinguishableByTypeAndInRenderedText() {
        val guard = CoreValidationException("limit", "limit must not be negative")
        assertEquals("limit", guard.field)
        assertFalse(
            (guard.message ?: "").matches(CORE_VERDICT_SHAPE),
            "a guard message must not read like a Core error code: ${guard.message}",
        )
        assertTrue((guard.message ?: "").startsWith("limit:"), guard.message)
        // A guard has no code to render, so nothing it prints can match the verdict shape either.
        assertFalse(
            detail(guard).matches(CORE_VERDICT_SHAPE),
            "a rendered guard refusal must not look like Core's verdict: ${guard.toString()}",
        )

        val verdict = CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, "projectId: value is empty")
        assertEquals(CoreErrorCodes.VALIDATION_FAILED, verdict.code)
        // (1) Core's wording is passed through verbatim, not re-prefixed here.
        assertEquals("projectId: value is empty", verdict.message)
        // (2) ...but every default rendering composes the code back in.
        assertTrue(
            verdict.toString().contains("VALIDATION_FAILED: projectId: value is empty"),
            "a Core verdict rendered without its code is indistinguishable from this client's " +
                "own words: ${verdict.toString()}",
        )
        assertEquals("VALIDATION_FAILED: projectId: value is empty", verdict.localizedMessage)
        // What a `whenComplete { _, error -> }` UI handler reads is the WRAPPER's message, which
        // Java builds from the cause's toString() — so the code survives that hop too.
        val wrapped = CompletionException(verdict)
        assertTrue(
            (wrapped.message ?: "").contains("VALIDATION_FAILED"),
            "the string ChatPanel shows for a failed future must name Core's code: ${wrapped.message}",
        )
        assertNotEquals<Throwable>(guard, verdict)
    }

    /**
     * A method this client never puts on the wire is refused as THIS CLIENT'S word.
     *
     * `CoreClient.request` used to answer an un-allowlisted method with a `CoreRpcException`
     * carrying `VALIDATION_FAILED` — Core's code, on a request Core never saw, rendered as Core's
     * verdict. The allowlist refusal is a local guard, so it must not be typed as a verdict.
     */
    @Test
    fun unAdvertisedAllowlistRefusalIsNotTypedAsACoreVerdict() {
        val refusal = CoreClient(UnixDomainSocketAddress.of(Path.of("/tmp/sandpane-drift-check.sock")))
            .request("shell.exec")
        val error = assertFailsWith<ExecutionException> { refusal.get() }
        val cause = await(error)
        assertTrue(
            cause !is CoreRpcException,
            "a refusal raised before any byte was written must not be typed as Core's verdict: $cause",
        )
        assertTrue(
            cause is CoreValidationException,
            "expected the client's own guard type, got ${cause::class.simpleName}",
        )
        assertEquals("method", (cause as CoreValidationException).field)
    }

    /** The text after `ClassName: ` in a throwable's default rendering. */
    private fun detail(t: Throwable): String =
        t.toString().removePrefix("${t.javaClass.name}: ")

    private companion object {
        /** Core's wire shape for a verdict: SCREAMING_SNAKE code, colon, Core's own sentence. */
        val CORE_VERDICT_SHAPE: Regex = Regex("^[A-Z][A-Z_0-9]*: .*$")
    }
}
