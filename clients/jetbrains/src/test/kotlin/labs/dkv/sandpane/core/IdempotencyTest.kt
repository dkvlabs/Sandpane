package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.ConversationSendParams
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreFeatures
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.SandboxCreateSpec
import labs.dkv.sandpane.model.SandboxSummary
import labs.dkv.sandpane.model.TaskSummary
import labs.dkv.sandpane.model.WorkspaceMode
import labs.dkv.sandpane.services.TaskMonitorService
import java.util.concurrent.TimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A2 (idempotency keys + features), client side. The units under test are the REAL seams the
 * services call ([KeyedRequests], [KeyedWrites], [IdempotencyKeys]) — no transport is involved, so
 * nothing is mocked.
 */
class IdempotencyTest {

    private fun caps(vararg features: String) = CoreCapabilities(
        protocolVersion = 1,
        coreVersion = "0.1.0",
        instanceId = "i",
        platform = "macos",
        methods = CoreMethods.ALL,
        features = features.toList(),
    )

    private val a2 = caps(CoreFeatures.IDEMPOTENCY_KEYS, CoreFeatures.SANDBOX_CREATE_AGENT)
    private val preA2 = caps()

    private val spec = SandboxCreateSpec(name = "atlas-auth", projectId = "p1", workspaceMode = WorkspaceMode.MOUNTLESS)
    private val send = ConversationSendParams(conversationId = "c1", content = "explain")

    private fun ready(p: KeyedRequests.Prepared<*>): Any? = assertIs<KeyedRequests.Prepared.Ready<*>>(p).params

    // -----------------------------------------------------------------------
    // features
    // -----------------------------------------------------------------------

    @Test
    fun featuresAreAbsentTolerantAndUnknownOnesAreIgnored() {
        val old = CoreJson.decodeFromString(
            CoreCapabilities.serializer(),
            """{"protocolVersion":1,"coreVersion":"0.1.0","instanceId":"i","sbx":null,"agents":[],"platform":"macos","methods":[]}""",
        )
        assertTrue(old.features.isEmpty())
        assertFalse(old.hasFeature(CoreFeatures.IDEMPOTENCY_KEYS))

        val newer = CoreJson.decodeFromString(
            CoreCapabilities.serializer(),
            """{"protocolVersion":1,"coreVersion":"9","instanceId":"i","platform":"macos","methods":[],""" +
                """"features":["idempotency-keys","teleport-v9"]}""",
        )
        assertTrue(newer.hasFeature(CoreFeatures.IDEMPOTENCY_KEYS))
        assertFalse(newer.hasFeature(CoreFeatures.SANDBOX_CREATE_AGENT))
        assertTrue(newer.hasFeature("teleport-v9"), "kept as data, simply not acted on")
    }

    // -----------------------------------------------------------------------
    // keys
    // -----------------------------------------------------------------------

    @Test
    fun freshKeysAre32LowercaseHexAndDistinct() {
        val keys = (1..200).map { IdempotencyKeys.fresh() }
        keys.forEach {
            assertTrue(Regex("^[0-9a-f]{32}$").matches(it), it)
            assertTrue(IdempotencyKeys.isValid(it))
        }
        assertEquals(keys.size, keys.toSet().size, "a CSPRNG key never repeats in practice")
    }

    @Test
    fun keyValidatorMatchesCoreExactly() {
        for (ok in listOf("k", "AZaz09._-", "0f1e2d3c4b5a69788796a5b4c3d2e1f0", "a".repeat(128))) {
            assertTrue(IdempotencyKeys.isValid(ok), ok)
        }
        for (bad in listOf("", "a".repeat(129), "a b", "a/b", "a:b", "ü", "a\nb", "a+b", "a=b")) {
            assertFalse(IdempotencyKeys.isValid(bad), bad)
        }
    }

    @Test
    fun keyIsSentOnlyWhenAdvertised() {
        val keyed = ready(KeyedRequests.newSend(send, a2)) as ConversationSendParams
        assertTrue(IdempotencyKeys.isValid(keyed.idempotencyKey!!))
        assertTrue(
            CoreJson.encodeToString(ConversationSendParams.serializer(), keyed).contains(""""idempotencyKey":"${keyed.idempotencyKey}""""),
        )

        val plain = ready(KeyedRequests.newSend(send, preA2)) as ConversationSendParams
        assertNull(plain.idempotencyKey)
        assertFalse(
            CoreJson.encodeToString(ConversationSendParams.serializer(), plain).contains("idempotencyKey"),
            "an older Core gets no key at all — it would silently drop it",
        )
        val plainCreate = ready(KeyedRequests.newCreate(spec, preA2)) as SandboxCreateSpec
        assertFalse(CoreJson.encodeToString(SandboxCreateSpec.serializer(), plainCreate).contains("idempotencyKey"))
        assertNull((ready(KeyedRequests.newCreate(spec, null)) as SandboxCreateSpec).idempotencyKey)
    }

    @Test
    fun everyNewActionGetsAFreshKey() {
        val first = ready(KeyedRequests.newSend(send, a2)) as ConversationSendParams
        val second = ready(KeyedRequests.newSend(send, a2)) as ConversationSendParams
        assertNotEquals(first.idempotencyKey, second.idempotencyKey, "identical content is still a new action")
        val c1 = ready(KeyedRequests.newCreate(spec, a2)) as SandboxCreateSpec
        val c2 = ready(KeyedRequests.newCreate(spec, a2)) as SandboxCreateSpec
        assertNotEquals(c1.idempotencyKey, c2.idempotencyKey)
    }

    @Test
    fun keyIsNeverDerivedFromContent() {
        val minted = mutableListOf<String>()
        val p = ready(KeyedRequests.newSend(send, a2) { "fixed-key".also { minted += it } }) as ConversationSendParams
        assertEquals("fixed-key", p.idempotencyKey, "the key comes from the minting source only")
        assertEquals(1, minted.size)
    }

    @Test
    fun aNewActionRefusesACallerSuppliedKey() {
        assertIs<KeyedRequests.Prepared.Refused<*>>(KeyedRequests.newSend(send.copy(idempotencyKey = "k"), a2))
        assertIs<KeyedRequests.Prepared.Refused<*>>(KeyedRequests.newCreate(spec.copy(idempotencyKey = "k"), a2))
    }

    @Test
    fun retrySafelyReusesTheSameKeyAndIdenticalParams() {
        val first = ready(KeyedRequests.newSend(send, a2)) as ConversationSendParams
        val again = ready(KeyedRequests.retrySend(first, a2)) as ConversationSendParams
        assertEquals(first, again, "identical params, same key")
        val created = ready(KeyedRequests.newCreate(spec.copy(agent = "codex"), a2)) as SandboxCreateSpec
        assertEquals(created, ready(KeyedRequests.retryCreate(created, a2)))
    }

    @Test
    fun retrySafelyIsRefusedWithoutAKeyOrOnACoreThatLostTheFeature() {
        val plain = ready(KeyedRequests.newSend(send, preA2)) as ConversationSendParams
        assertIs<KeyedRequests.Prepared.Refused<*>>(KeyedRequests.retrySend(plain, a2))
        val keyed = ready(KeyedRequests.newSend(send, a2)) as ConversationSendParams
        // A reconnect landed on a Core that no longer advertises keys: a resend could run twice.
        assertIs<KeyedRequests.Prepared.Refused<*>>(KeyedRequests.retrySend(keyed, preA2))
        assertIs<KeyedRequests.Prepared.Refused<*>>(KeyedRequests.retrySend(keyed.copy(idempotencyKey = "bad key"), a2))
    }

    // -----------------------------------------------------------------------
    // agent gated on the feature, not on sandbox.remove
    // -----------------------------------------------------------------------

    @Test
    fun agentIsGatedOnTheSandboxCreateAgentFeature() {
        val withAgent = spec.copy(agent = "codex")
        val onlyRemove = caps(CoreFeatures.IDEMPOTENCY_KEYS) // methods include sandbox.remove
        assertTrue(onlyRemove.advertises(CoreMethods.SANDBOX_REMOVE))
        val refused = assertIs<KeyedRequests.Prepared.Refused<*>>(KeyedRequests.newCreate(withAgent, onlyRemove))
        assertTrue(refused.reason.contains(CoreFeatures.SANDBOX_CREATE_AGENT), refused.reason)
        assertIs<KeyedRequests.Prepared.Ready<*>>(KeyedRequests.newCreate(withAgent, caps(CoreFeatures.SANDBOX_CREATE_AGENT)))
        // No agent chosen: nothing to gate.
        assertIs<KeyedRequests.Prepared.Ready<*>>(KeyedRequests.newCreate(spec, preA2))
    }

    // -----------------------------------------------------------------------
    // outcomes: unknown / CONFLICT mapping / Retry safely
    // -----------------------------------------------------------------------

    private fun text(error: Throwable, keyed: Boolean) =
        KeyedWrites.describe(CoreMethods.CONVERSATION_SEND, KeyedWrites.classify(error), keyed)

    @Test
    fun unknownOutcomesOfferRetrySafelyOnlyWhenKeyed() {
        for (error in listOf(
            TimeoutException("deadline"),
            CoreTransportException("connection closed: EOF"),
            CoreRpcException(CoreErrorCodes.INTERNAL, "store failed"),
            CoreRpcException(CoreErrorCodes.INTERNAL, "unusable", raisedByCore = false),
        )) {
            assertIs<KeyedWrites.Failure.OutcomeUnknown>(KeyedWrites.classify(error))
            val keyed = text(error, keyed = true)
            assertTrue(keyed.offerRetrySafely, "$error")
            assertTrue(keyed.body.contains("Retry safely"), keyed.body)
            val plain = text(error, keyed = false)
            assertFalse(plain.offerRetrySafely, "no key ⇒ no Retry safely")
            assertTrue(plain.body.contains("outcome unknown — check before trying again"), plain.body)
            for (t in listOf(keyed, plain)) assertFalse(t.body.contains("nothing was run"), t.body)
        }
    }

    @Test
    fun conflictMismatchAndPendingSayNothingWasRun() {
        for (message in listOf(KeyedWrites.CONFLICT_MISMATCH, KeyedWrites.CONFLICT_PENDING)) {
            val failure = KeyedWrites.classify(CoreRpcException(CoreErrorCodes.CONFLICT, message))
            assertIs<KeyedWrites.Failure.NothingRan>(failure)
            val t = KeyedWrites.describe(CoreMethods.SANDBOX_CREATE, failure, keyed = true)
            assertTrue(t.body.contains("nothing was run"), t.body)
            assertTrue(t.body.contains(message), "Core's own message is shown: ${t.body}")
            assertFalse(t.offerRetrySafely)
        }
    }

    @Test
    fun conflictNameLockSaysNothingWasRun() {
        val message = "another operation on sandbox \"atlas-auth\" is in progress; nothing was run"
        val failure = KeyedWrites.classify(CoreRpcException(CoreErrorCodes.CONFLICT, message))
        assertIs<KeyedWrites.Failure.NothingRan>(failure)
        val t = KeyedWrites.describe(CoreMethods.SANDBOX_CREATE, failure, keyed = true)
        assertTrue(t.body.contains("nothing was run"), t.body)
        assertFalse(t.offerRetrySafely)
    }

    /**
     * A6 W-N1 (review J-I4): a direct_mount `sandbox.create` refused because the repository is busy
     * (an apply, a discard or a writing task holds it) or another direct_mount create of it is in
     * flight. Nothing was created; trying again later (a new action, a new key) is the remedy, and
     * Core's own text stays visible. The fixtures are Core's `format!` templates, filled in.
     */
    @Test
    fun aBusyRepositoryRefusesADirectMountCreateAndNothingWasCreated() {
        val busy = "/repo/atlas-demo is busy: git.apply:t-1 holds its writer lock (a running writer task, an apply or " +
            "a worktree discard), and a direct_mount sandbox could change it while that runs" + KeyedWrites.CREATE_REPO_BUSY_SUFFIX
        val inProgress = "/repo/atlas-demo is busy: sandbox \"atlas-demo-2\"" + KeyedWrites.CREATE_MOUNT_IN_PROGRESS_SUFFIX
        for (message in listOf(busy, inProgress)) {
            val failure = KeyedWrites.classify(CoreRpcException(CoreErrorCodes.CONFLICT, message))
            assertIs<KeyedWrites.Failure.NothingRan>(failure, message)
            val t = KeyedWrites.describe(CoreMethods.SANDBOX_CREATE, failure, keyed = true)
            assertTrue(t.title.contains("repository busy \u2014 nothing was created"), t.title)
            assertTrue(t.body.contains("repository busy \u2014 nothing was created; try again when it finishes"), t.body)
            assertTrue(t.body.contains("Core said: /repo/atlas-demo is busy"), "Core's text stays visible: ${t.body}")
            assertFalse(t.body.contains("another operation on this sandbox"), t.body)
            assertFalse(t.offerRetrySafely, "the same key would only be refused again")
        }
        assertTrue(KeyedWrites.CREATE_REPO_BUSY_SUFFIX.endsWith("; nothing was created"))
        assertTrue(KeyedWrites.CREATE_MOUNT_IN_PROGRESS_SUFFIX.endsWith("; nothing was created"))
    }

    @Test
    fun conflictUnknownNeverSaysNothingWasRun() {
        val message = "the outcome of the earlier request with this idempotency key is unknown (Core restarted " +
            "or sbx failed while it ran); re-read state before retrying with a new key"
        val failure = KeyedWrites.classify(CoreRpcException(CoreErrorCodes.CONFLICT, message))
        assertIs<KeyedWrites.Failure.EarlierOutcomeUnknown>(failure)
        val t = KeyedWrites.describe(CoreMethods.SANDBOX_CREATE, failure, keyed = true)
        assertTrue(t.body.contains("outcome unknown"), t.body)
        assertTrue(t.body.contains("re-read state"), t.body)
        assertTrue(t.body.contains("a retry needs a new request"), t.body)
        assertFalse(t.body.replace(message, "").contains("nothing was run"), t.body)
        assertFalse(t.body.contains("nothing ran"), t.body)
        assertFalse(t.offerRetrySafely, "the same key would only be refused again")
    }

    @Test
    fun otherVerdictsAreCoresWordAndHostileTextIsRevealedAndCapped() {
        val hostile = "weird\u202E conflict\n" + "x".repeat(2_000)
        val failure = KeyedWrites.classify(CoreRpcException(CoreErrorCodes.CONFLICT, hostile))
        assertIs<KeyedWrites.Failure.CoreRefused>(failure)
        val t = KeyedWrites.describe(CoreMethods.SANDBOX_CREATE, failure, keyed = true)
        assertFalse(t.body.contains('\u202E'))
        assertFalse(t.body.contains('\n'))
        assertTrue(t.body.contains("\\u202E"))
        assertTrue(t.body.length < 1_000, "Core's message is capped: ${t.body.length}")
        assertFalse(t.offerRetrySafely)
        assertFalse(t.body.contains("nothing was run"))
    }

    @Test
    fun localRefusalsAreNotSentAndOfferNoRetry() {
        val t = text(CoreValidationException("idempotencyKey", "bad"), keyed = true)
        assertTrue(t.body.contains("before anything was sent"), t.body)
        assertFalse(t.offerRetrySafely)
    }

    @Test
    fun decodeFailuresNeverEchoThePayload() {
        // kotlinx puts the offending JSON in its message; that must not reach the user.
        val leak = runCatching {
            CoreJson.decodeFromString(SandboxSummary.serializer(), """{"name":{"x":"secret-payload-xyz"}}""")
        }.exceptionOrNull()!!
        assertTrue(leak.message!!.contains("secret-payload-xyz"), "precondition: the raw error echoes input")
        val t = text(leak, keyed = true)
        assertFalse(t.body.contains("secret-payload-xyz"), t.body)

        val decoded = runCatching {
            KeyedWrites.decodeCreateAnswer(CoreJson.parseToJsonElement("""{"name":{"x":"secret-payload-xyz"}}"""))
        }.exceptionOrNull()
        val rpc = assertIs<CoreRpcException>(decoded)
        assertFalse(rpc.raisedByCore)
        assertFalse(rpc.message.contains("secret-payload-xyz"))
        assertEquals("a1", KeyedWrites.decodeCreateAnswer(CoreJson.parseToJsonElement("""{"name":"a1"}""")).name)
    }

    // -----------------------------------------------------------------------
    // replay
    // -----------------------------------------------------------------------

    @Test
    fun replayedAnswersAreFlaggedAndNeverFresh() {
        assertEquals(
            "Core returned the result of your earlier identical request (replayed). It may be out of date; refreshing from Core.",
            KeyedWrites.REPLAY_NOTICE,
        )
        val task = CoreJson.decodeFromString(
            TaskSummary.serializer(),
            """{"id":"t1","conversationId":"c1","status":"queued","replayed":true}""",
        )
        assertEquals(true, task.replayed)
        val decoded = TaskMonitorService.decodeSendResult(CoreJson.parseToJsonElement(
            """{"id":"t1","conversationId":"c1","status":"queued","replayed":true}""",
        ))
        assertTrue(decoded.replayed)
        val fresh = TaskMonitorService.decodeSendResult(CoreJson.parseToJsonElement(
            """{"id":"t1","conversationId":"c1","status":"queued"}""",
        ))
        assertFalse(fresh.replayed)

        val sandbox = CoreJson.decodeFromString(SandboxSummary.serializer(), """{"name":"a1","probedState":"running","replayed":true}""")
        assertEquals(KeyedWrites.REPLAY_NOTICE, KeyedWrites.replayNotice(sandbox.replayed))
        assertNull(KeyedWrites.replayNotice(null))
        assertNull(KeyedWrites.replayNotice(false))
        assertNull(CoreJson.decodeFromString(SandboxSummary.serializer(), """{"name":"a1"}""").replayed)
    }

    @Test
    fun replayedSendIsNotSeededAsCurrentStatus() {
        // The replayed status is what it was THEN; the service must track the id without it.
        val replayed = TaskMonitorService.decodeSendResult(CoreJson.parseToJsonElement(
            """{"id":"t1","conversationId":"c1","status":"queued","replayed":true}""",
        ))
        assertNull(TaskMonitorService.summaryToSeed(replayed), "a replay never seeds the row's status")
        val fresh = TaskMonitorService.decodeSendResult(CoreJson.parseToJsonElement(
            """{"id":"t1","conversationId":"c1","status":"queued"}""",
        ))
        assertEquals("t1", TaskMonitorService.summaryToSeed(fresh)?.id)
    }
}
