package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.model.ConversationDeleteParams
import labs.dkv.sandpane.model.ConversationListParams
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreFeatures
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.Project
import labs.dkv.sandpane.model.RpcRequest
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.ui.ConversationDeleteConfirmation
import labs.dkv.sandpane.ui.ConversationRenames
import labs.dkv.sandpane.ui.ConversationSelection
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A3b (conversation lifecycle). The unit under test is the REAL [CoreCommands] / [ConversationDeleteCheck]
 * / [ConversationDeleteFlow] / [ConversationOutcomes] / [ConversationGuards] / [ConversationUiState];
 * only the socket is replaced, so [ConversationRpc.sent] is exactly what would go on the wire.
 */
private class ConversationRpc(vararg replies: () -> CompletableFuture<JsonElement>) : CoreRpc {
    val sent = ArrayList<Pair<String, JsonObject>>()
    private val script = ArrayDeque(replies.toList())

    override fun request(method: String, params: JsonElement): CompletableFuture<JsonElement> {
        sent += method to (params as JsonObject)
        val next = script.removeFirstOrNull() ?: error("unexpected extra request: $method")
        return next()
    }
}

private fun answer(json: String): () -> CompletableFuture<JsonElement> =
    { CompletableFuture.completedFuture(CoreJson.parseToJsonElement(json)) }

private fun failWith(t: Throwable): () -> CompletableFuture<JsonElement> = { CompletableFuture.failedFuture(t) }

private fun capsOf(methods: List<String>, features: List<String> = emptyList()) = CoreCapabilities(
    protocolVersion = 1,
    coreVersion = "0.1.0",
    instanceId = "i",
    platform = "macos",
    methods = methods,
    features = features,
)

/** Inline UI: no EDT in unit tests; records each dialog shown and answers [yes]. */
private class ConversationDeleteUi(private val yes: Boolean) : ConversationDeleteFlow.Ui {
    val shown = ArrayList<IssuedConversationDelete>()
    override fun onUiThread(block: () -> Unit) = block()
    override fun confirm(issued: IssuedConversationDelete): Boolean {
        shown += issued
        return yes
    }
}

class ConversationLifecycleTest {

    private val id = "7c2e9a10-0000-4000-8000-00000000c0de"
    private val projectId = "3f1c2a9e-0000-4000-8000-00000000a71a"
    private val token = "0123456789abcdef".repeat(4)
    private val future = "2999-01-01T00:00:00Z"
    private val conversationJson =
        """{"id":"$id","projectId":"$projectId","title":"Atlas Demo chat","agentId":"codex","createdAt":"2026-10-01T00:00:00Z"}"""

    private fun commands(rpc: CoreRpc, methods: List<String> = CoreMethods.ALL) = CoreCommands(rpc) { capsOf(methods) }

    private fun sentFrame(rpc: ConversationRpc, index: Int = 0): String =
        CoreJson.encodeToString(
            RpcRequest.serializer(),
            RpcRequest(id = "t-1", method = rpc.sent[index].first, params = rpc.sent[index].second),
        )

    private fun step1Json(
        action: String = "conversation.delete",
        targetId: String = id,
        targetName: String = "Atlas Demo chat",
        tok: String = token,
        expiresAt: String = future,
        external: Boolean = false,
        impact: List<String> = listOf("deletes conversation Atlas Demo chat and all of its Core records; this cannot be undone"),
        extra: String = "",
    ): String {
        val lines = impact.joinToString(",") { CoreJson.encodeToString(String.serializer(), it) }
        return """{"confirmation":{"token":"$tok","expiresAt":"$expiresAt","action":"$action",""" +
            """"target":{"name":${CoreJson.encodeToString(String.serializer(), targetName)},"id":"$targetId"},""" +
            """"impact":[$lines],"external":$external}$extra}"""
    }

    private fun conversation(archivedAt: String? = null, sandboxId: String? = null, title: String = "Atlas Demo chat") =
        Conversation(id, projectId, title, "codex", "2026-10-01T00:00:00Z", archivedAt = archivedAt, sandboxId = sandboxId)

    private fun project(archivedAt: String? = null) =
        Project(id = projectId, name = "Atlas Demo", createdAt = "2026-10-01T00:00:00Z", archivedAt = archivedAt)

    // -----------------------------------------------------------------------
    // exact frames
    // -----------------------------------------------------------------------

    @Test
    fun listSendsIncludeArchivedOnlyWhenAskedAndLiveFramesAreUnchanged() {
        val rpc = ConversationRpc(answer("[$conversationJson]"), answer("[]"), answer("[]"))
        val live = commands(rpc).conversationList(ConversationListParams(projectId = projectId)).get()
        commands(rpc).conversationList(ConversationListParams(projectId = projectId, includeArchived = true)).get()
        commands(rpc).conversationList(ConversationListParams(projectId = projectId, includeArchived = false, limit = 500)).get()
        assertEquals("""{"v":1,"id":"t-1","method":"conversation.list","params":{"projectId":"$projectId"}}""", sentFrame(rpc, 0))
        assertEquals(
            """{"v":1,"id":"t-1","method":"conversation.list","params":{"projectId":"$projectId","includeArchived":true}}""",
            sentFrame(rpc, 1),
        )
        assertEquals(
            """{"v":1,"id":"t-1","method":"conversation.list","params":{"projectId":"$projectId","limit":500}}""",
            sentFrame(rpc, 2),
            "false is never put on the wire",
        )
        val row = live.single()
        assertNull(row.archivedAt, "archivedAt is absent-tolerant: missing means live")
        assertNull(row.sandboxId, "sandboxId is absent-tolerant")
        assertFalse(row.isArchived)
    }

    @Test
    fun includeArchivedIsNeverSentToACoreThatWouldIgnoreIt() {
        val rpc = ConversationRpc()
        val preA3b = CoreMethods.ALL - CoreMethods.ADDITIVE_A3B
        val error = assertFailsWith<ExecutionException> {
            commands(rpc, preA3b).conversationList(ConversationListParams(projectId = projectId, includeArchived = true)).get()
        }
        assertIs<MethodNotSupportedException>(error.cause)
        assertTrue(rpc.sent.isEmpty(), "nothing may reach a Core that would silently list live conversations only")
    }

    @Test
    fun archivedAtAndSandboxIdDecodeWhenPresent() {
        val json = conversationJson.replace("}", ""","archivedAt":"2026-10-11T00:00:00Z","sandboxId":"atlas-auth"}""")
        val rpc = ConversationRpc(answer("[$json]"))
        val row = commands(rpc).conversationList().get().single()
        assertEquals("2026-10-11T00:00:00Z", row.archivedAt)
        assertEquals("atlas-auth", row.sandboxId)
        assertTrue(row.isArchived)
    }

    @Test
    fun renameArchiveUnarchiveSendExactFrames() {
        val archived = conversationJson.replace("}", ""","archivedAt":"2026-10-11T00:00:00Z"}""")
        val rpc = ConversationRpc(answer(conversationJson), answer(archived), answer(conversationJson))
        val c = commands(rpc)
        c.conversationRename(id, " Nova Demo chat ").get()
        val a = c.conversationArchive(id).get()
        c.conversationUnarchive(id).get()
        assertEquals(
            """{"v":1,"id":"t-1","method":"conversation.rename","params":{"conversationId":"$id","title":" Nova Demo chat "}}""",
            sentFrame(rpc, 0),
            "the title is sent exactly as typed (Core does not trim)",
        )
        assertEquals("""{"v":1,"id":"t-1","method":"conversation.archive","params":{"conversationId":"$id"}}""", sentFrame(rpc, 1))
        assertEquals("""{"v":1,"id":"t-1","method":"conversation.unarchive","params":{"conversationId":"$id"}}""", sentFrame(rpc, 2))
        assertTrue(a.isArchived)
    }

    @Test
    fun exportSendsTheCursorAndOptionalLimit() {
        val page = """{"format":"sandpane.conversation-export.v1","exportedAt":"2026-10-11T00:00:00Z","conversation":$conversationJson,""" +
            """"messages":[],"truncated":false,"nextSequence":0,"redaction":{"bestEffort":true,"replacements":0,"byKind":{}}}"""
        val rpc = ConversationRpc(answer(page), answer(page), answer(page))
        val c = commands(rpc)
        c.conversationExport(id).get()
        c.conversationExport(id, afterSequence = 41, limit = 9999).get()
        c.conversationExport(id, afterSequence = -5).get()
        assertEquals("""{"v":1,"id":"t-1","method":"conversation.export","params":{"conversationId":"$id","afterSequence":0}}""", sentFrame(rpc, 0))
        assertEquals(
            """{"v":1,"id":"t-1","method":"conversation.export","params":{"conversationId":"$id","afterSequence":41,"limit":500}}""",
            sentFrame(rpc, 1),
            "the limit is clamped like Core",
        )
        assertEquals(
            """{"v":1,"id":"t-1","method":"conversation.export","params":{"conversationId":"$id","afterSequence":0}}""",
            sentFrame(rpc, 2),
            "a negative cursor is normalised like Core",
        )
    }

    @Test
    fun deleteStepOneOmitsTheTokenKeyAndStepTwoCarriesIt() {
        val rpc = ConversationRpc(answer(step1Json()), answer("""{"deleted":true}"""))
        val ui = ConversationDeleteUi(yes = true)
        val outcome = ConversationDeleteFlow(commands(rpc), ui).run(id).get()
        assertIs<ConversationDeleteOutcome.Deleted>(outcome)
        assertEquals("""{"v":1,"id":"t-1","method":"conversation.delete","params":{"conversationId":"$id"}}""", sentFrame(rpc, 0))
        assertEquals(
            """{"v":1,"id":"t-1","method":"conversation.delete","params":{"conversationId":"$id","confirmToken":"$token"}}""",
            sentFrame(rpc, 1),
        )
        assertEquals(1, ui.shown.size)
        assertTrue(outcome.confirmedDeleted)
        val body = outcome.describe(true).body
        assertTrue(body.contains("deleted: true") && body.contains("not touched"), body)
    }

    @Test
    fun everyA3bMethodIsRefusedLocallyWhenUnadvertised() {
        val rpc = ConversationRpc()
        val c = commands(rpc, CoreMethods.ALL - CoreMethods.ADDITIVE_A3B)
        for (call in listOf(
            { c.conversationRename(id, "Nova Demo chat") },
            { c.conversationArchive(id) },
            { c.conversationUnarchive(id) },
            { c.conversationDeleteRequest(id) },
            { c.conversationExport(id) },
        )) {
            val error = assertFailsWith<ExecutionException> { call().get() }
            assertIs<MethodNotSupportedException>(error.cause)
        }
        assertTrue(rpc.sent.isEmpty(), "nothing is sent to a Core that does not advertise the method")
        assertEquals(CoreMethods.ADDITIVE_A3B, CoreMethods.ADDITIVE_A3B intersect CoreMethods.REQUIRES_ADVERTISEMENT)
        // The UI gate says so too, visibly.
        for (action in listOf(ConversationUiState.Action.RENAME, ConversationUiState.Action.DELETE, ConversationUiState.Action.EXPORT)) {
            val gap = c.advertisementGap(action.method)
            val reason = ConversationUiState.gate(action, conversation(), project(), null, gap)
            assertTrue(reason!!.contains("not supported by this Core"), reason)
        }
    }

    @Test
    fun invalidIdsOrTitlesSendNothing() {
        val rpc = ConversationRpc()
        val c = commands(rpc)
        for (call in listOf(
            { c.conversationRename(id, "") },
            { c.conversationRename(id, "   ") },
            { c.conversationRename(id, "a\nb") },
            { c.conversationRename("", "Nova Demo chat") },
            { c.conversationArchive(" ") },
            { c.conversationDeleteRequest("") },
            { c.conversationExport("") },
        )) {
            val error = assertFailsWith<ExecutionException> { call().get() }
            assertIs<CoreValidationException>(error.cause)
        }
        assertTrue(rpc.sent.isEmpty())
    }

    // -----------------------------------------------------------------------
    // the two-step delete
    // -----------------------------------------------------------------------

    @Test
    fun cancelSendsNothingAfterStepOne() {
        val rpc = ConversationRpc(answer(step1Json()))
        val outcome = ConversationDeleteFlow(commands(rpc), ConversationDeleteUi(yes = false)).run(id).get()
        assertIs<ConversationDeleteOutcome.Cancelled>(outcome)
        assertEquals(1, rpc.sent.size, "step 2 is never sent after Cancel")
        assertTrue(outcome.describe(true).body.contains("nothing was deleted"))
    }

    @Test
    fun aDialogThatThrowsIsNotAYes() {
        val rpc = ConversationRpc(answer(step1Json()))
        val ui = object : ConversationDeleteFlow.Ui {
            override fun onUiThread(block: () -> Unit) = block()
            override fun confirm(issued: IssuedConversationDelete): Boolean = error("dialog blew up")
        }
        assertIs<ConversationDeleteOutcome.Cancelled>(ConversationDeleteFlow(commands(rpc), ui).run(id).get())
        assertEquals(1, rpc.sent.size)
    }

    @Test
    fun expiryIsRecheckedAtClickTimeAndAnExpiredTokenIsNeverSent() {
        val rpc = ConversationRpc(answer(step1Json(expiresAt = "2026-10-11T00:00:00Z")))
        val outcome = ConversationDeleteFlow(commands(rpc), ConversationDeleteUi(yes = true), clock = { Instant.parse("2026-10-11T00:00:01Z") })
            .run(id).get()
        assertIs<ConversationDeleteOutcome.Expired>(outcome)
        assertEquals(1, rpc.sent.size)
    }

    @Test
    fun anUnreadableExpiryFailsClosed() {
        val rpc = ConversationRpc(answer(step1Json(expiresAt = "soon")))
        val ui = ConversationDeleteUi(yes = true)
        val outcome = ConversationDeleteFlow(commands(rpc), ui).run(id).get()
        assertIs<ConversationDeleteOutcome.Refused>(outcome)
        assertTrue(outcome.reason.contains("cannot be used"), outcome.reason)
        assertEquals(1, rpc.sent.size, "step 2 is never sent")
        assertTrue(ui.shown.isEmpty())
        assertTrue(IssuedConversationDelete.of(id, "t", "soon", emptyList(), token).isExpired(Instant.EPOCH))
        assertFalse(IssuedConversationDelete.of(id, "t", future, emptyList(), token).isExpired(Instant.EPOCH))
    }

    @Test
    fun stepTwoIsSentFromTheBackgroundNeverFromTheUiThread() {
        var inUi = false
        val sentInUi = ArrayList<Boolean>()
        val rpc = object : CoreRpc {
            val replies = ArrayDeque(listOf(step1Json(), """{"deleted":true}"""))
            override fun request(method: String, params: JsonElement): CompletableFuture<JsonElement> {
                sentInUi += inUi
                return CompletableFuture.completedFuture(CoreJson.parseToJsonElement(replies.removeFirst()))
            }
        }
        val ui = object : ConversationDeleteFlow.Ui {
            override fun onUiThread(block: () -> Unit) {
                inUi = true
                try { block() } finally { inUi = false }
            }
            override fun confirm(issued: IssuedConversationDelete) = true
        }
        val queued = ArrayList<() -> Unit>()
        val done = ConversationDeleteFlow(commands(rpc), ui, background = { queued += it }).run(id)
        assertEquals(listOf(false), sentInUi, "only step 1 so far: step 2 waits for the background")
        assertFalse(done.isDone)
        queued.forEach { it() }
        assertEquals(listOf(false, false), sentInUi, "step 2 was not written on the UI thread")
        assertIs<ConversationDeleteOutcome.Deleted>(done.get())
    }

    @Test
    fun aStepTwoThatCannotBeScheduledIsNotSent() {
        val rpc = ConversationRpc(answer(step1Json()))
        val outcome = ConversationDeleteFlow(commands(rpc), ConversationDeleteUi(yes = true), background = { error("pool shut down") }).run(id).get()
        assertIs<ConversationDeleteOutcome.Refused>(outcome)
        assertEquals(1, rpc.sent.size)
    }

    @Test
    fun aRenameBetweenTheStepsIsFineAndTheDialogShowsCoresStoredTitle() {
        val rpc = ConversationRpc(answer(step1Json(targetName = "Nova Demo chat")), answer("""{"deleted":true}"""))
        val ui = ConversationDeleteUi(yes = true)
        assertIs<ConversationDeleteOutcome.Deleted>(ConversationDeleteFlow(commands(rpc), ui).run(id).get())
        assertEquals("Nova Demo chat", ui.shown.single().name)
    }

    @Test
    fun unusableStepOneAnswersAreRefusedAndStepTwoIsNotSent() {
        val bad = listOf(
            step1Json(action = "project.delete"),
            step1Json(targetId = "another-conversation"),
            step1Json(tok = "short"),
            step1Json(tok = token.uppercase()),
            step1Json(external = true),
            step1Json(extra = ""","deleted":true"""),
            """{"deleted":true}""",
            """{}""",
        )
        for (json in bad) {
            val rpc = ConversationRpc(answer(json))
            val ui = ConversationDeleteUi(yes = true)
            val outcome = ConversationDeleteFlow(commands(rpc), ui).run(id).get()
            assertIs<ConversationDeleteOutcome.Refused>(outcome, json)
            assertEquals(1, rpc.sent.size, json)
            assertTrue(ui.shown.isEmpty(), "no dialog for an answer that was not understood: $json")
            assertFalse(outcome.describe(true).body.contains(token), "the token is never shown")
        }
    }

    @Test
    fun stepTwoWithoutDeletedTrueIsUnconfirmedNeverDeleted() {
        val rpc = ConversationRpc(answer(step1Json()), answer("""{"deleted":false}"""))
        val outcome = ConversationDeleteFlow(commands(rpc), ConversationDeleteUi(yes = true)).run(id).get()
        assertIs<ConversationDeleteOutcome.Step2Unconfirmed>(outcome)
        assertFalse(outcome.confirmedDeleted)
        val text = outcome.describe(rereadIncludesArchived = true).body
        assertTrue(text.contains("UNKNOWN"))
        assertFalse(text.contains("Core reports"))
    }

    @Test
    fun stepTwoInternalOrTransportFailureIsUnknownAndNotRetried() {
        for (error in listOf<Throwable>(
            CoreRpcException(CoreErrorCodes.INTERNAL, "database is locked"),
            CoreTransportException("socket closed"),
            TimeoutException(),
            CoreRpcException(CoreErrorCodes.INTERNAL, "unusable frame", raisedByCore = false),
        )) {
            val rpc = ConversationRpc(answer(step1Json()), failWith(error))
            val outcome = ConversationDeleteFlow(commands(rpc), ConversationDeleteUi(yes = true)).run(id).get()
            assertIs<ConversationDeleteOutcome.Step2Failed>(outcome)
            assertEquals(2, rpc.sent.size, "never retried")
            assertTrue(ConversationOutcomes.isUnknown(outcome.error))
            val body = outcome.describe(rereadIncludesArchived = true).body
            assertTrue(body.contains("UNKNOWN"), body)
            assertTrue(body.contains("including archived conversations"), body)
            assertFalse(body.contains("nothing was"), "an unknown outcome never claims nothing happened: $body")
        }
    }

    @Test
    fun stepTwoTokenRejectionSaysNothingWasDeleted() {
        val rejected = CoreRpcException(
            CoreErrorCodes.VALIDATION_FAILED,
            "confirmation token is invalid, expired, already used, or not for this action and target; request a new confirmation",
        )
        val rpc = ConversationRpc(answer(step1Json()), failWith(rejected))
        val outcome = ConversationDeleteFlow(commands(rpc), ConversationDeleteUi(yes = true)).run(id).get()
        val body = outcome.describe(true).body
        assertTrue(body.contains("nothing was deleted"), body)
        assertFalse(ConversationOutcomes.isUnknown((outcome as ConversationDeleteOutcome.Step2Failed).error))
        assertEquals(ConversationDeleteFollowUp.Next.REREAD, ConversationDeleteFollowUp.next(outcome))
    }

    @Test
    fun aStepOneFailureIsNeverAnUnknownOutcome() {
        for (error in listOf<Throwable>(CoreTransportException("socket closed"), TimeoutException(), CoreRpcException(CoreErrorCodes.INTERNAL, "x"))) {
            val rpc = ConversationRpc(failWith(error))
            val outcome = ConversationDeleteFlow(commands(rpc), ConversationDeleteUi(yes = true)).run(id).get()
            assertIs<ConversationDeleteOutcome.Step1Failed>(outcome)
            val text = outcome.describe(true)
            assertTrue(text.body.contains("was not deleted"), text.body)
            assertFalse(text.body.contains("UNKNOWN"), text.body)
        }
        val rpc = ConversationRpc(failWith(CoreRpcException(CoreErrorCodes.CONFLICT, ConversationOutcomes.MSG_CONVERSATION_HAS_TASKS)))
        val body = ConversationDeleteFlow(commands(rpc), ConversationDeleteUi(yes = true)).run(id).get().describe(true).body
        assertTrue(body.contains("unfinished tasks"), body)
    }

    @Test
    fun theTokenNeverAppearsInAnyPrintableForm() {
        val rpc = ConversationRpc(answer(step1Json()))
        val ui = ConversationDeleteUi(yes = false)
        ConversationDeleteFlow(commands(rpc), ui).run(id).get()
        val issued = ui.shown.single()
        assertFalse(issued.toString().contains(token))
        assertFalse(ConversationDeleteParams(id, token).toString().contains(token))
        assertTrue(ConversationDeleteParams(id, token).toString().contains("<redacted>"))
        assertTrue(ConversationDeleteParams(id).toString().contains("absent"))
        assertFalse(ConversationDeleteConfirmation.message(issued).build().contains(token))
    }

    @Test
    fun undecodableAnswersAreNeverEchoed() {
        val secret = "secret-payload-xyz"
        val rpc = ConversationRpc(
            answer("""{"title":{"x":"$secret"}}"""),
            answer("""{"confirmation":{"token":"$token","expiresAt":1,"x":"$secret"}}"""),
            answer("""{"format":"sandpane.conversation-export.v1","messages":[{"content":"$secret"}]}"""),
            answer("""[{"id":{"x":"$secret"}}]"""),
        )
        val c = commands(rpc)
        for (call in listOf({ c.conversationRename(id, "Nova") }, { c.conversationDeleteRequest(id) }, { c.conversationExport(id) })) {
            val cause = assertFailsWith<ExecutionException> { call().get() }.cause
            assertIs<CoreRpcException>(cause)
            assertFalse(cause.raisedByCore)
            assertFalse(cause.message.contains(secret), cause.message)
            assertFalse(cause.message.contains(token), cause.message)
        }
    }

    // -----------------------------------------------------------------------
    // after the delete: when may the window forget the conversation?
    // -----------------------------------------------------------------------

    @Test
    fun theWindowForgetsAConversationOnlyWhenCoreSaysItIsGone() {
        val notFound = CoreRpcException(CoreErrorCodes.NOT_FOUND, ConversationOutcomes.MSG_CONVERSATION_NOT_FOUND)
        val f = ConversationDeleteFollowUp
        assertEquals(ConversationDeleteFollowUp.Next.FORGET_AND_REREAD, f.next(ConversationDeleteOutcome.Deleted(id, "t")))
        assertEquals(ConversationDeleteFollowUp.Next.FORGET_AND_REREAD, f.next(ConversationDeleteOutcome.Step2Failed(id, ExecutionException(notFound))))
        assertEquals(ConversationDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE, f.next(ConversationDeleteOutcome.Step2Unconfirmed(id)))
        assertEquals(ConversationDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE, f.next(ConversationDeleteOutcome.Step2Failed(id, CoreTransportException("closed"))))
        assertEquals(ConversationDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE, f.next(ConversationDeleteOutcome.Step2Failed(id, TimeoutException())))
        assertEquals(ConversationDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE, f.next(null))
        assertEquals(
            ConversationDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE,
            f.next(ConversationDeleteOutcome.Step2Failed(id, CoreRpcException(CoreErrorCodes.NOT_FOUND, "x", raisedByCore = false))),
            "a NOT_FOUND this plugin raised is not Core's word",
        )
        for (known in listOf(
            ConversationDeleteOutcome.Cancelled(id), ConversationDeleteOutcome.Expired(id, future), ConversationDeleteOutcome.Refused(id, "x"),
            ConversationDeleteOutcome.Step1Failed(id, notFound),
            ConversationDeleteOutcome.Step2Failed(id, CoreRpcException(CoreErrorCodes.CONFLICT, ConversationOutcomes.MSG_CONVERSATION_HAS_TASKS)),
        )) {
            assertEquals(ConversationDeleteFollowUp.Next.REREAD, f.next(known), known.toString())
        }
    }

    @Test
    fun goneAfterRereadNeedsACompleteSuccessfulListWithArchivedRows() {
        val f = ConversationDeleteFollowUp
        val other = conversation().copy(id = "other")
        assertTrue(f.goneAfterReread(id, listOf(other), archivedIncluded = true))
        assertFalse(f.goneAfterReread(id, listOf(conversation(archivedAt = "2026-10-11T00:00:00Z")), archivedIncluded = true))
        assertFalse(f.goneAfterReread(id, emptyList(), archivedIncluded = false), "a live-only list proves nothing")
        assertFalse(f.goneAfterReread(id, null, archivedIncluded = true), "a failed read proves nothing")
        // conversation.list has no truncation flag: a FULL page (Core's maximum) proves nothing either.
        assertEquals(500, ConversationDeleteFollowUp.REREAD_LIMIT)
        val fullPage = (1..500).map { conversation().copy(id = "c-$it") }
        assertFalse(f.goneAfterReread(id, fullPage, archivedIncluded = true), "500 rows without the id is not proof")
        assertTrue(f.goneAfterReread(id, fullPage.dropLast(1), archivedIncluded = true))
    }

    // -----------------------------------------------------------------------
    // honest copy for every exact Core message
    // -----------------------------------------------------------------------

    @Test
    fun everyExactCoreRefusalMapsToNothingWasCopy() {
        val cases = listOf(
            Triple(CoreMethods.CONVERSATION_RENAME, CoreErrorCodes.VALIDATION_FAILED, ConversationOutcomes.MSG_CONVERSATION_ARCHIVED) to "nothing was changed",
            Triple(CoreMethods.CONVERSATION_RENAME, CoreErrorCodes.VALIDATION_FAILED, ConversationOutcomes.MSG_TITLE_BLANK) to "nothing was changed",
            Triple(CoreMethods.CONVERSATION_UNARCHIVE, CoreErrorCodes.VALIDATION_FAILED, ConversationOutcomes.MSG_PROJECT_ARCHIVED) to "nothing was changed",
            Triple(CoreMethods.CONVERSATION_DELETE, CoreErrorCodes.CONFLICT, ConversationOutcomes.MSG_CONVERSATION_HAS_TASKS) to "nothing was deleted",
            Triple(CoreMethods.CONVERSATION_ARCHIVE, CoreErrorCodes.NOT_FOUND, ConversationOutcomes.MSG_CONVERSATION_NOT_FOUND) to "nothing was changed",
        )
        assertEquals(ConversationOutcomes.KNOWN_MESSAGES, cases.map { it.first.third }.toSet(), "every known message has a case")
        for ((case, expected) in cases) {
            val (method, code, message) = case
            val text = ConversationOutcomes.describeFailure(method, CoreRpcException(code, message), rereadIncludesArchived = true)
            assertTrue(text.title.contains("refused by Core"), text.title)
            assertTrue(text.body.contains(expected), "$message \u2192 ${text.body}")
            assertTrue(text.body.contains("Core said: $message"), "Core's own text is shown: ${text.body}")
            assertFalse(text.body.contains("UNKNOWN"))
            assertFalse(ConversationOutcomes.isUnknown(CoreRpcException(code, message)))
        }
        // Export is a read: Core's NOT_FOUND gets plain copy and "no file was written", never "unknown".
        val export = ConversationOutcomes.describeExportFailure(CoreRpcException(CoreErrorCodes.NOT_FOUND, ConversationOutcomes.MSG_CONVERSATION_NOT_FOUND))
        assertTrue(export.body.contains("Core no longer has this conversation") && export.body.contains("No file was written"), export.body)
        assertFalse(export.body.contains("UNKNOWN"))
    }

    @Test
    fun anUnlistedOrMismatchedRefusalMakesNoClaim() {
        val unlisted = listOf(
            CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, "title: contains a disallowed character"),
            CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, ConversationOutcomes.MSG_CONVERSATION_HAS_TASKS),
            CoreRpcException(CoreErrorCodes.NOT_FOUND, ConversationOutcomes.MSG_CONVERSATION_NOT_FOUND + ": extra"),
            CoreRpcException(CoreErrorCodes.CONFLICT, ConversationOutcomes.MSG_CONVERSATION_ARCHIVED),
        )
        for (error in unlisted) {
            for (method in CoreMethods.ADDITIVE_A3B - CoreMethods.CONVERSATION_EXPORT) {
                val text = ConversationOutcomes.describeFailure(method, error, rereadIncludesArchived = true)
                assertEquals("Core refused ${error.code}: ${KeyedWrites.coreText(error.message)}", text.body)
            }
        }
    }

    @Test
    fun internalTransportAndTimeoutAreUnknownAndTheRereadSentenceIsTrue() {
        for (error in listOf<Throwable>(
            CoreRpcException(CoreErrorCodes.INTERNAL, "boom"),
            CoreTransportException("closed"),
            TimeoutException(),
            IllegalStateException("decoder blew up with secret-xyz"),
        )) {
            assertTrue(ConversationOutcomes.isUnknown(error))
            val with = ConversationOutcomes.describeFailure(CoreMethods.CONVERSATION_ARCHIVE, error, rereadIncludesArchived = true)
            val without = ConversationOutcomes.describeFailure(CoreMethods.CONVERSATION_ARCHIVE, error, rereadIncludesArchived = false)
            assertTrue(with.body.contains("UNKNOWN"))
            assertTrue(with.body.contains("including archived conversations"))
            assertFalse(without.body.contains("including archived"), without.body)
            assertFalse(with.body.contains("secret-xyz"), "an unexpected exception's text is never shown")
            assertFalse(with.body.contains("nothing was"))
            // An export read that fails this way writes nothing and is NOT worded as an unknown mutation.
            val export = ConversationOutcomes.describeExportFailure(error)
            assertTrue(export.body.contains("No file was written"), export.body)
            assertFalse(export.body.contains("UNKNOWN"), export.body)
            assertFalse(export.body.contains("secret-xyz"))
        }
        assertFalse(ConversationOutcomes.isUnknown(CoreValidationException("title", "empty")))
        assertFalse(ConversationOutcomes.isUnknown(MethodNotSupportedException(CoreMethods.CONVERSATION_ARCHIVE, "not advertised")))
    }

    @Test
    fun aSendToAnArchivedConversationIsWordedAsArchivedNotAsNotFound() {
        val archived = CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, ConversationOutcomes.MSG_CONVERSATION_ARCHIVED)
        val hint = ConversationOutcomes.sendRefusalHint(ExecutionException(archived))
        assertTrue(hint!!.contains("archived"), hint)
        assertTrue(ConversationOutcomes.sendRefusalHint(CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, ConversationOutcomes.MSG_PROJECT_ARCHIVED))!!.contains("project"))
        assertNull(ConversationOutcomes.sendRefusalHint(CoreRpcException(CoreErrorCodes.NOT_FOUND, ConversationOutcomes.MSG_CONVERSATION_NOT_FOUND)))
        assertNull(ConversationOutcomes.sendRefusalHint(CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, ConversationOutcomes.MSG_CONVERSATION_ARCHIVED, raisedByCore = false)))
        // The keyed-send copy shows Core's own verdict and claims nothing it does not know.
        val text = KeyedWrites.describe(CoreMethods.CONVERSATION_SEND, KeyedWrites.classify(archived), keyed = true)
        assertTrue(text.body.contains(ConversationOutcomes.MSG_CONVERSATION_ARCHIVED), text.body)
        assertFalse(text.offerRetrySafely, "a Core refusal is not an unknown outcome")
    }

    @Test
    fun archiveSuccessSaysArchivedConversationsAreHiddenUnlessShowArchivedIsOn() {
        val c = conversation(archivedAt = "2026-10-11T00:00:00Z")
        val hidden = ConversationOutcomes.describeSuccess(CoreMethods.CONVERSATION_ARCHIVE, c, archivedListed = false)
        assertTrue(hidden.body.contains(ConversationOutcomes.ARCHIVED_HIDDEN_HINT), hidden.body)
        assertEquals(
            "Archived conversations are hidden; turn on Show archived to see or unarchive it.",
            ConversationOutcomes.ARCHIVED_HIDDEN_HINT,
        )
        val listed = ConversationOutcomes.describeSuccess(CoreMethods.CONVERSATION_ARCHIVE, c, archivedListed = true)
        assertFalse(listed.body.contains(ConversationOutcomes.ARCHIVED_HIDDEN_HINT), "it is listed, so not hidden")
        for (method in listOf(CoreMethods.CONVERSATION_RENAME, CoreMethods.CONVERSATION_UNARCHIVE)) {
            assertFalse(ConversationOutcomes.describeSuccess(method, conversation(), archivedListed = false).body.contains("hidden"), method)
        }
    }

    @Test
    fun withNothingSelectedTheComposerOnlyAsksToSelectWhenThereIsSomethingToSelect() {
        // Rows to pick from: ask the user to pick one.
        val pick = ConversationUiState.noSelectionBlocker(2, "Core lists 2 conversations", projectSelected = true)
        assertTrue(pick.contains("select a conversation to continue"), pick)
        // conversation.list unadvertised: visibly unsupported, never an instruction that cannot be followed.
        val unsupported = ConversationUiState.noSelectionBlocker(
            0,
            "this Core does not advertise conversation.list \u2014 chats cannot be enumerated, and none is invented",
            projectSelected = true,
        )
        assertTrue(unsupported.contains("does not advertise"), unsupported)
        assertFalse(unsupported.contains("select a conversation"), unsupported)
        // Core lists none: say so, with Core's (revealed, capped) state.
        val none = ConversationUiState.noSelectionBlocker(0, "Core reports no open conversations\u202E" + "x".repeat(400), projectSelected = true)
        assertTrue(none.contains("Core reports no open conversations"), none)
        assertFalse(none.contains("select a conversation"), none)
        assertFalse(none.contains("\u202E"), "revealed")
        assertFalse(none.contains("x".repeat(201)), "capped")
        // No project: nothing to select a conversation from.
        val noProject = ConversationUiState.noSelectionBlocker(0, "no project selected", projectSelected = false)
        assertTrue(noProject.contains("No project is selected"), noProject)
        assertFalse(noProject.contains("select a conversation"), noProject)
        for (text in listOf(pick, unsupported, none, noProject)) assertTrue(text.contains("Nothing is sent"), text)
    }

    @Test
    fun aSecondDeleteOrExportClickWhileOneIsInFlightSendsNothing() {
        val flight = SingleFlight()
        val first = CompletableFuture<String>()
        var starts = 0
        val started = flight.launch { starts++; first }
        val done = assertIs<SingleFlight.Launch.Started<String>>(started).done
        assertTrue(flight.isBusy)
        // The second click while step 1 / the export is running starts nothing.
        assertIs<SingleFlight.Launch.Busy<String>>(flight.launch { starts++; CompletableFuture.completedFuture("again") })
        assertEquals(1, starts, "the busy click never reaches Core")
        // The refusal is visible and says nothing was sent.
        for (action in listOf(ConversationUiState.Action.DELETE, ConversationUiState.Action.EXPORT)) {
            val notice = ConversationUiState.inFlightNotice(action)
            assertTrue(notice.contains("already in progress") && notice.contains("Nothing was sent"), notice)
        }
        // Completion (success or failure) releases the guard before `done` completes.
        first.completeExceptionally(CoreTransportException("socket closed"))
        assertTrue(done.isCompletedExceptionally)
        val cause = assertFailsWith<ExecutionException> { done.get() }.cause
        assertIs<CoreTransportException>(cause, "the original failure is passed through unchanged")
        assertFalse(flight.isBusy)
        assertIs<SingleFlight.Launch.Started<String>>(flight.launch { starts++; CompletableFuture.completedFuture("ok") })
        assertEquals(2, starts)
        assertFalse(flight.isBusy)
        // A click the user cancels before anything is sent (null) and a start that throws both release it.
        assertIs<SingleFlight.Launch.Declined<String>>(flight.launch<String> { null })
        assertFalse(flight.isBusy)
        assertFailsWith<IllegalStateException> { flight.launch<String> { error("boom") } }
        assertFalse(flight.isBusy)
    }

    @Test
    fun successCopyUsesCoresAnswerRevealedAndCapped() {
        val c = conversation(archivedAt = "2026-10-11T00:00:00Z", title = "Atlas\u202EDemo" + "x".repeat(400))
        val text = ConversationOutcomes.describeSuccess(CoreMethods.CONVERSATION_ARCHIVE, c)
        assertTrue(text.body.contains("2026-10-11T00:00:00Z"))
        assertFalse(text.body.contains("\u202E"), "hidden characters are revealed, never passed through")
        assertFalse(text.body.contains("x".repeat(201)), "Core's title is capped")
    }

    // -----------------------------------------------------------------------
    // the title validator vs Core's corpus (Validator::conversation_title + rename's trim check)
    // -----------------------------------------------------------------------

    @Test
    fun titleValidatorAcceptsWhatCoreAccepts() {
        val accepted = listOf(
            "Atlas Demo chat", "a", "\u00E9".repeat(200), "\uD83D\uDE00".repeat(200), "Nova\u200BDemo", " Orbit Demo ",
            "\u6F22\u5B57 \u2014 \u00FC", "\u200B", "a\u00A0b",
        )
        accepted.forEach {
            assertNull(ConversationGuards.titleProblem(it), "Core accepts '$it'")
            assertNull(ConversationGuards.renameTitleProblem(it), "rename accepts '$it'")
        }
        // ZERO WIDTH SPACE is not White_Space in Rust, so a title of only U+200B is not blank.
        assertFalse(ConversationGuards.isBlankForCore("\u200B"))
    }

    @Test
    fun titleValidatorRefusesWhatCoreRefuses() {
        val refused = listOf(
            "", "x".repeat(201), "\uD83D\uDE00".repeat(201), "a\nb", "a\tb", "a\rb", "a\u0000b", "a\u007Fb", "a\u0085b", "a\u009Bb",
            "a\u001B[31m", "a\u2028b", "a\u2029b", "a\u200Eb", "a\u200Fb", "a\u061Cb",
            "a\u202Ab", "a\u202Bb", "a\u202Cb", "a\u202Db", "a\u202Eb", "a\u2066b", "a\u2067b", "a\u2068b", "a\u2069b",
            "a\uD800b",
        )
        refused.forEach {
            assertTrue(ConversationGuards.titleProblem(it) != null, "Core refuses ${it.take(12).map { c -> "%04X".format(c.code) }}")
            assertTrue(ConversationGuards.renameTitleProblem(it) != null)
        }
        assertEquals(200, ConversationGuards.MAX_TITLE_CHARS)
    }

    @Test
    fun renameRefusesWhitespaceOnlyExactlyLikeRustTrim() {
        // Rust `str::trim` strips the Unicode White_Space set: these alone are blank on rename.
        val blank = listOf("", " ", "   ", "\u00A0", "\u3000", "\u0085", "\u1680", "\u2000", "\u200A", "\u202F", "\u205F", " \u3000 ")
        blank.forEach {
            assertTrue(ConversationGuards.isBlankForCore(it), it.map { c -> "%04X".format(c.code) }.toString())
            assertEquals("the title is empty or whitespace-only", ConversationGuards.renameTitleProblem(it))
        }
        // Not White_Space: Kotlin's isWhitespace would call U+001C blank; Rust does not (it is then refused as a control).
        assertFalse(ConversationGuards.isBlankForCore("\u001C"))
        assertTrue(ConversationGuards.renameTitleProblem("\u001C")!!.contains("U+001C"))
        // The exact White_Space set over the whole BMP.
        val expected = (0x09..0x0D) + listOf(0x20, 0x85, 0xA0, 0x1680) + (0x2000..0x200A) + listOf(0x2028, 0x2029, 0x202F, 0x205F, 0x3000)
        for (cp in 0..0xFFFF) {
            assertEquals(expected.contains(cp), ConversationGuards.isCoreWhitespace(cp), "U+%04X".format(cp))
        }
    }

    @Test
    fun aCreateTitleDerivedFromAMultiLinePromptIsAlwaysAcceptedByCore() {
        val prompt = "Fix the login bug\n\tin auth.rs\r\n\u2028and add a test\u202E please"
        val title = ConversationGuards.titleForCreate(prompt)
        assertEquals("Fix the login bug in auth.rs and add a test please", title)
        assertNull(ConversationGuards.titleProblem(title), "Core's title rule accepts it")
        assertEquals("", ConversationGuards.titleForCreate("\n\t \u3000\u0000"), "blank: Core stores Untitled conversation")
        assertEquals("", ConversationGuards.titleForCreate(""))
        // Long prompts are cut by code point to 80 and never refused.
        val long = ConversationGuards.titleForCreate("word ".repeat(100))
        assertTrue(long.codePointCount(0, long.length) <= 80, long)
        assertNull(ConversationGuards.titleProblem(long))
    }

    @Test
    fun aCreateTitleCutNeverSplitsASurrogatePair() {
        val emoji = "\uD83D\uDE00"
        // 79 ASCII + an emoji at the cut + more: the emoji is code point 80 and stays whole.
        val title = ConversationGuards.titleForCreate("a".repeat(79) + emoji + "tail")
        assertEquals("a".repeat(79) + emoji, title)
        val all = ConversationGuards.titleForCreate(emoji.repeat(100))
        assertEquals(emoji.repeat(80), all)
        assertNull(ConversationGuards.titleProblem(all))
        // A lone surrogate (which Core can never accept) becomes a space, then is trimmed.
        assertEquals("a b", ConversationGuards.titleForCreate("a\uD800b"))
    }

    @Test
    fun renameSendsOnlyAChangeExactlyAsTypedAndNeverAPreRuleTitleTheFieldCannotShow() {
        assertNull(ConversationRenames.change("Atlas Demo chat", "Atlas Demo chat"))
        assertEquals(" Atlas Demo chat ", ConversationRenames.change("Atlas Demo chat", " Atlas Demo chat "))
        val field = javax.swing.JTextField("Atlas\nDemo")
        val shown = field.text
        assertNull(ConversationRenames.change(shown, shown), "an untouched pre-rule title is never sent (field shows '$shown')")
    }

    // -----------------------------------------------------------------------
    // archived UI state (Core's rule; project first)
    // -----------------------------------------------------------------------

    @Test
    fun anArchivedConversationRefusesSendAndRenameWithCoresReason() {
        val archived = conversation(archivedAt = "2026-10-11T00:00:00Z")
        val live = project()
        assertEquals(ConversationOutcomes.MSG_CONVERSATION_ARCHIVED, ConversationUiState.blockedReason(archived, live, ConversationUiState.Action.SEND))
        assertEquals(ConversationOutcomes.MSG_CONVERSATION_ARCHIVED, ConversationUiState.blockedReason(archived, live, ConversationUiState.Action.RENAME))
        assertNull(ConversationUiState.blockedReason(archived, live, ConversationUiState.Action.UNARCHIVE))
        assertNull(ConversationUiState.blockedReason(archived, live, ConversationUiState.Action.DELETE))
        assertNull(ConversationUiState.blockedReason(archived, live, ConversationUiState.Action.EXPORT), "history and export stay readable")
        assertTrue(ConversationUiState.blockedReason(archived, live, ConversationUiState.Action.ARCHIVE) != null)
        assertEquals("Atlas Demo chat [archived]", ConversationUiState.label(archived))
        val blocker = ConversationUiState.composerBlocker(archived)!!
        assertTrue(blocker.contains("2026-10-11T00:00:00Z") && blocker.contains(ConversationOutcomes.MSG_CONVERSATION_ARCHIVED), blocker)
        assertTrue(blocker.contains("Nothing was sent"))
    }

    @Test
    fun inAnArchivedProjectTheProjectReasonComesFirstAndOnlyArchiveAndDeleteRemain() {
        val archivedProject = project(archivedAt = "2026-10-10T00:00:00Z")
        for (c in listOf(conversation(), conversation(archivedAt = "2026-10-11T00:00:00Z"))) {
            assertEquals(ConversationOutcomes.MSG_PROJECT_ARCHIVED, ConversationUiState.blockedReason(c, archivedProject, ConversationUiState.Action.SEND))
            assertEquals(ConversationOutcomes.MSG_PROJECT_ARCHIVED, ConversationUiState.blockedReason(c, archivedProject, ConversationUiState.Action.RENAME))
            assertEquals(ConversationOutcomes.MSG_PROJECT_ARCHIVED, ConversationUiState.blockedReason(c, archivedProject, ConversationUiState.Action.UNARCHIVE))
            assertNull(ConversationUiState.blockedReason(c, archivedProject, ConversationUiState.Action.DELETE))
            assertNull(ConversationUiState.blockedReason(c, archivedProject, ConversationUiState.Action.EXPORT))
        }
        assertNull(ConversationUiState.blockedReason(conversation(), archivedProject, ConversationUiState.Action.ARCHIVE), "archive is allowed in an archived project")
    }

    @Test
    fun aLiveConversationAllowsEverythingButUnarchiveAndTheGateOrderIsConnectionThenAdvertisementThenSelection() {
        val live = conversation()
        for (action in ConversationUiState.Action.entries - ConversationUiState.Action.UNARCHIVE) {
            assertNull(ConversationUiState.blockedReason(live, project(), action), action.name)
        }
        assertTrue(ConversationUiState.blockedReason(live, project(), ConversationUiState.Action.UNARCHIVE) != null)
        assertNull(ConversationUiState.composerBlocker(live))
        assertTrue(ConversationUiState.composerBlocker(null)!!.contains("select a conversation to continue"))
        val gap = MethodNotSupportedException(CoreMethods.CONVERSATION_DELETE, "x")
        assertEquals("Core down", ConversationUiState.gate(ConversationUiState.Action.DELETE, live, project(), "Core down", gap))
        assertTrue(ConversationUiState.gate(ConversationUiState.Action.DELETE, live, project(), null, gap)!!.contains("not supported"))
        assertEquals("no conversation is selected", ConversationUiState.gate(ConversationUiState.Action.DELETE, null, project(), null, null))
        assertNull(ConversationUiState.gate(ConversationUiState.Action.DELETE, live, project(), null, null))
    }

    @Test
    fun sandboxChosenAtCreationIsAStoredNameNeverALiveBinding() {
        val withName = conversation(sandboxId = "atlas-auth")
        assertTrue(ConversationUiState.sandboxLine(withName, featureAdvertised = false, listOf("atlas-auth")).contains("not reported by this Core"))
        assertEquals("sandbox chosen at creation: none", ConversationUiState.sandboxLine(conversation(), true, listOf("atlas-auth")))
        val listed = ConversationUiState.sandboxLine(withName, true, listOf("atlas-auth"))
        assertTrue(listed.contains("atlas-auth") && listed.contains("not a live binding"), listed)
        assertFalse(listed.contains("not in the current sandbox list"))
        val gone = ConversationUiState.sandboxLine(withName, true, listOf("nova-api"))
        assertTrue(gone.contains("not in the current sandbox list"), gone)
        val unknown = ConversationUiState.sandboxLine(withName, true, null)
        assertFalse(unknown.contains("not in the current sandbox list"), "only claimed when the list was read")
        assertTrue(unknown.contains("unavailable"), unknown)
        val hostile = ConversationUiState.sandboxLine(conversation(sandboxId = "x\u202E" + "y".repeat(400)), true, emptyList())
        assertFalse(hostile.contains("\u202E"))
        assertFalse(hostile.contains("y".repeat(201)))
        assertEquals("conversation-sandbox-id", CoreFeatures.CONVERSATION_SANDBOX_ID)
    }

    @Test
    fun pickerAndTargetLinesCapLongCoreTitles() {
        val long = conversation(title = "t".repeat(500))
        assertEquals("t".repeat(DisplayCap.MAX_CODE_POINTS) + "\u2026", ConversationSelection.displayName(long))
        assertFalse(ConversationSelection.targetLine(long).contains("t".repeat(201)))
    }

    // -----------------------------------------------------------------------
    // the delete dialog
    // -----------------------------------------------------------------------

    @Test
    fun deleteDialogShowsTitleIdExpiryAndAtMostTwentyRevealedCappedImpactLines() {
        val impact = (1..25).map { "impact line $it" } + listOf("spoof\u202Eline", "z".repeat(500))
        val rpc = ConversationRpc(answer(step1Json(targetName = "Atlas\u202EDemo" + "N".repeat(400), impact = impact)))
        val ui = ConversationDeleteUi(yes = false)
        ConversationDeleteFlow(commands(rpc), ui).run(id).get()
        val html = ConversationDeleteConfirmation.message(ui.shown.single()).build()
        assertTrue(html.contains(id), "the conversation id is shown")
        assertTrue(html.contains(future), "the expiry is shown")
        assertTrue(html.contains("impact line 20"))
        assertFalse(html.contains("impact line 21"), "capped at ${ConversationDeleteConfirmation.MAX_IMPACT_LINES}")
        assertTrue(html.contains("7 more impact line(s) not shown"))
        assertFalse(html.contains("\u202E"), "Core text is revealed, never passed through")
        assertFalse(html.contains("N".repeat(201)), "the title is capped")
        assertFalse(html.contains(token))
        assertFalse(html.contains("NOT CONFIRMED AS CREATED BY SANDPANE"), "no external banner for a conversation")
        assertEquals(20, ConversationDeleteConfirmation.MAX_IMPACT_LINES)
        assertEquals("Cancel", ConversationDeleteConfirmation.CANCEL_LABEL)
    }

    // -----------------------------------------------------------------------
    // deadlines and settings
    // -----------------------------------------------------------------------

    @Test
    fun allFiveMethodsKeepTheDefaultDeadline() {
        for (method in CoreMethods.ADDITIVE_A3B) {
            assertEquals(15_000, MethodDeadlines.forMethod(method, 15_000), method)
        }
    }

    @Test
    fun showArchivedConversationsIsAViewSettingThatDefaultsOffAndSurvivesLoading() {
        val fresh = labs.dkv.sandpane.settings.SandpaneSettings()
        assertFalse(fresh.showArchivedConversations, "archived conversations are hidden unless asked for")
        val loaded = labs.dkv.sandpane.settings.SandpaneSettings().apply {
            loadState(labs.dkv.sandpane.settings.SandpaneSettings.State().apply { showArchivedConversations = true })
        }
        assertTrue(loaded.showArchivedConversations)
        // No conversation id is ever persisted: nothing to clear after a delete.
        val fields = labs.dkv.sandpane.settings.SandpaneSettings.State::class.java.declaredFields.map { it.name }
        assertFalse(fields.any { it.contains("conversation", ignoreCase = true) && it != "showArchivedConversations" }, fields.toString())
    }
}
