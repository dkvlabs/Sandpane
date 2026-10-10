package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.ConfirmationRequest
import labs.dkv.sandpane.model.ConfirmationTarget
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.RpcRequest
import labs.dkv.sandpane.model.SandboxCreateSpec
import labs.dkv.sandpane.model.SandboxRemoveResult
import labs.dkv.sandpane.model.SandboxStopResult
import labs.dkv.sandpane.model.SandboxSummary
import labs.dkv.sandpane.model.SbxAgents
import labs.dkv.sandpane.model.WorkspaceMode
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
 * A transport stand-in that records every request and answers from a per-call script. The unit
 * under test is the REAL [CoreCommands] / [RemoveConfirmationCheck] / [SandboxRemoveFlow]; only the
 * socket is replaced, so what these tests see in [sent] is exactly what would go on the wire.
 */
private class ScriptedRpc(vararg replies: () -> CompletableFuture<JsonElement>) : CoreRpc {
    val sent = ArrayList<Pair<String, JsonObject>>()
    private val script = ArrayDeque(replies.toList())

    override fun request(method: String, params: JsonElement): CompletableFuture<JsonElement> {
        sent += method to (params as JsonObject)
        val next = script.removeFirstOrNull() ?: error("unexpected extra request: $method $params")
        return next()
    }
}

private fun ok(json: String): () -> CompletableFuture<JsonElement> =
    { CompletableFuture.completedFuture(CoreJson.parseToJsonElement(json)) }

private fun fail(t: Throwable): () -> CompletableFuture<JsonElement> = { CompletableFuture.failedFuture(t) }

private fun caps(vararg methods: String) = CoreCapabilities(
    protocolVersion = 1,
    coreVersion = "0.1.0",
    instanceId = "i",
    platform = "macos",
    methods = methods.toList(),
)

/** Inline UI: no EDT in unit tests; records whether a dialog was shown and answers [answer]. */
private class FakeUi(private val answer: Boolean) : SandboxRemoveFlow.Ui {
    val shown = ArrayList<IssuedRemoval>()
    override fun onUiThread(block: () -> Unit) = block()
    override fun confirm(issued: IssuedRemoval): Boolean {
        shown += issued
        return answer
    }
}

class SandboxLifecycleTest {

    private val name = "atlas-demo-1"
    private val token = "0123456789abcdef".repeat(4)
    private val sbxId = "b5ebec73-e2ae-471a-811a-e011cfb1948e"
    private val future = "2999-01-01T00:00:00Z"

    private fun step1Json(
        action: String = "sandbox.remove",
        targetName: String = name,
        tok: String = token,
        expiresAt: String = future,
        external: Boolean = false,
        extra: String = "",
    ) = """{"confirmation":{"token":"$tok","expiresAt":"$expiresAt","action":"$action",""" +
        """"target":{"name":"$targetName","id":"$sbxId"},"impact":["removes sandbox $targetName"],""" +
        """"external":$external}$extra}"""

    private fun commands(rpc: CoreRpc, vararg advertised: String = CoreMethods.ALL.toTypedArray()) =
        CoreCommands(rpc) { caps(*advertised) }

    private fun frame(method: String, params: JsonObject): String =
        CoreJson.encodeToString(RpcRequest.serializer(), RpcRequest(id = "t-1", method = method, params = params))

    // -----------------------------------------------------------------------
    // exact frames
    // -----------------------------------------------------------------------

    @Test
    fun stopSendsExactlyTheNameFrame() {
        val rpc = ScriptedRpc(ok("""{"stopped":true}"""))
        commands(rpc).sandboxStop(name).get()
        val (method, params) = rpc.sent.single()
        assertEquals(
            """{"v":1,"id":"t-1","method":"sandbox.stop","params":{"name":"atlas-demo-1"}}""",
            frame(method, params),
        )
    }

    @Test
    fun removeStepOneOmitsTheTokenKeyAndStepTwoCarriesIt() {
        val rpc = ScriptedRpc(ok(step1Json()), ok("""{"removed":true}"""))
        val outcome = SandboxRemoveFlow(commands(rpc), FakeUi(answer = true)).run(name).get()

        assertIs<RemoveOutcome.Removed>(outcome)
        assertEquals(2, rpc.sent.size)
        assertEquals(
            """{"v":1,"id":"t-1","method":"sandbox.remove","params":{"name":"atlas-demo-1"}}""",
            frame(rpc.sent[0].first, rpc.sent[0].second),
            "step 1 must have no confirmToken key at all — not null, not empty",
        )
        assertEquals(
            """{"v":1,"id":"t-1","method":"sandbox.remove","params":{"name":"atlas-demo-1","confirmToken":"$token"}}""",
            frame(rpc.sent[1].first, rpc.sent[1].second),
        )
    }

    // -----------------------------------------------------------------------
    // never step 2 without the step-1 token
    // -----------------------------------------------------------------------

    @Test
    fun cancelSendsNothingAfterStepOne() {
        val rpc = ScriptedRpc(ok(step1Json()))
        val ui = FakeUi(answer = false)
        val outcome = SandboxRemoveFlow(commands(rpc), ui).run(name).get()
        assertIs<RemoveOutcome.Cancelled>(outcome)
        assertEquals(1, ui.shown.size, "the dialog was shown")
        assertEquals(1, rpc.sent.size, "only step 1 went out")
        assertFalse(rpc.sent.single().second.containsKey("confirmToken"))
        assertFalse(outcome.refreshList)
    }

    @Test
    fun unusableStepOneAnswersNeverReachTheDialogOrStepTwo() {
        val cases = mapOf(
            "no confirmation" to """{}""",
            "removed at step 1" to """{"removed":true}""",
            "removed alongside a confirmation" to step1Json(extra = ""","removed":true"""),
            "wrong action" to step1Json(action = "project.delete"),
            "different target name" to step1Json(targetName = "nova-demo-2"),
            "uppercase token" to step1Json(tok = token.uppercase()),
            "short token" to step1Json(tok = "abc123"),
        )
        for ((label, reply) in cases) {
            val rpc = ScriptedRpc(ok(reply))
            val ui = FakeUi(answer = true)
            val outcome = SandboxRemoveFlow(commands(rpc), ui).run(name).get()
            assertIs<RemoveOutcome.Refused>(outcome, label)
            assertTrue(ui.shown.isEmpty(), "$label: no dialog for an unusable confirmation")
            assertEquals(1, rpc.sent.size, "$label: step 2 must never be sent")
        }
    }

    @Test
    fun decideRefusesABlankBoundIdAndAcceptsTheExactAnswer() {
        val blank = SandboxRemoveResult(
            confirmation = ConfirmationRequest(token, future, "sandbox.remove", ConfirmationTarget(name, " "), emptyList(), false),
        )
        assertIs<RemoveConfirmationCheck.Decision.Refused>(RemoveConfirmationCheck.decide(name, blank))
        assertIs<RemoveConfirmationCheck.Decision.Refused>(RemoveConfirmationCheck.decide(name, null))

        val good = CoreJson.decodeFromString(SandboxRemoveResult.serializer(), step1Json(external = true))
        val ready = assertIs<RemoveConfirmationCheck.Decision.Ready>(RemoveConfirmationCheck.decide(name, good))
        assertEquals(name, ready.issued.name)
        assertEquals(sbxId, ready.issued.target.id)
        assertTrue(ready.issued.external)
        assertEquals(token, ready.issued.token)
    }

    @Test
    fun expiredConfirmationIsNotSent() {
        val rpc = ScriptedRpc(ok(step1Json(expiresAt = "2026-10-10T00:02:00Z")))
        val flow = SandboxRemoveFlow(commands(rpc), FakeUi(answer = true)) { Instant.parse("2026-10-10T00:02:01Z") }
        val outcome = flow.run(name).get()
        assertIs<RemoveOutcome.Expired>(outcome)
        assertEquals(1, rpc.sent.size)
    }

    @Test
    fun unparseableExpiryIsLeftToCore() {
        val rpc = ScriptedRpc(ok(step1Json(expiresAt = "soon")), ok("""{"removed":true}"""))
        val outcome = SandboxRemoveFlow(commands(rpc), FakeUi(answer = true)).run(name).get()
        assertIs<RemoveOutcome.Removed>(outcome)
    }

    @Test
    fun aDialogThatThrowsIsNotAYes() {
        val rpc = ScriptedRpc(ok(step1Json()))
        val ui = object : SandboxRemoveFlow.Ui {
            override fun onUiThread(block: () -> Unit) = block()
            override fun confirm(issued: IssuedRemoval): Boolean = throw IllegalStateException("no window")
        }
        assertIs<RemoveOutcome.Cancelled>(SandboxRemoveFlow(commands(rpc), ui).run(name).get())
        assertEquals(1, rpc.sent.size)
    }

    @Test
    fun stepTwoIsNeverRetried() {
        val rpc = ScriptedRpc(ok(step1Json()), fail(TimeoutException("deadline")))
        val outcome = SandboxRemoveFlow(commands(rpc), FakeUi(answer = true)).run(name).get()
        val failed = assertIs<RemoveOutcome.Step2Failed>(outcome)
        assertEquals(2, rpc.sent.size, "exactly one step 2, no retry")
        val text = failed.describe()
        assertTrue(text.body.contains("UNKNOWN"), text.body)
        assertFalse(text.body.contains("nothing was sent"), "a sent request must not be called unsent")
        assertTrue(outcome.refreshList)
    }

    @Test
    fun stepTwoCoreVerdictsAreWordedPerCode() {
        fun outcomeFor(code: String, message: String = "core says so"): OutcomeText {
            val rpc = ScriptedRpc(ok(step1Json()), fail(CoreRpcException(code, message)))
            val outcome = SandboxRemoveFlow(commands(rpc), FakeUi(answer = true)).run(name).get()
            assertEquals(2, rpc.sent.size)
            return assertIs<RemoveOutcome.Step2Failed>(outcome).describe()
        }
        // VALIDATION_FAILED means "ran nothing" ONLY for Core's token refusal or a name refusal.
        val tokenRejected = outcomeFor(
            CoreErrorCodes.VALIDATION_FAILED,
            "confirmation token is invalid, expired, already used, or not for this action and target; " +
                "request a new confirmation",
        )
        assertTrue(tokenRejected.body.contains("was not removed"), tokenRejected.body)
        val nameRefused = outcomeFor(CoreErrorCodes.VALIDATION_FAILED, "sandbox name: must be at least two characters")
        assertTrue(nameRefused.body.contains("was not removed"), nameRefused.body)
        // Any other VALIDATION_FAILED (e.g. a failure after `sbx rm` ran) is not known.
        val other = outcomeFor(CoreErrorCodes.VALIDATION_FAILED, "sbx rm exited 0 but the re-query failed (x)")
        assertTrue(other.body.contains("not known"), other.body)
        assertFalse(other.body.contains("was not removed"), other.body)
        assertFalse(other.body.contains("ran nothing"), other.body)

        // CONFLICT names both causes and shows Core's own message, revealed.
        val conflict = outcomeFor(CoreErrorCodes.CONFLICT, "sandbox busy\u202E: another operation")
        assertTrue(conflict.body.contains("a different sandbox now has this name"), conflict.body)
        assertTrue(conflict.body.contains("another operation on this sandbox is in progress"), conflict.body)
        assertTrue(conflict.body.contains("sandbox busy\\u202E: another operation"), conflict.body)
        assertFalse(conflict.body.contains('\u202E'), conflict.body)

        assertTrue(outcomeFor(CoreErrorCodes.NOT_FOUND).body.contains("no longer lists"))
        assertTrue(outcomeFor(CoreErrorCodes.INTERNAL).body.contains("not known"))
    }

    @Test
    fun malformedRemoveAnswersNeverEchoTheirPayload() {
        // A short step-1 answer (missing expiresAt/action/target/external) with a real-shaped token.
        val short = """{"confirmation":{"token":"$token"}}"""
        val rpc1 = ScriptedRpc(ok(short))
        val ui = FakeUi(answer = true)
        val step1 = SandboxRemoveFlow(commands(rpc1), ui).run(name).get()
        val failed1 = assertIs<RemoveOutcome.Step1Failed>(step1)
        val cause1 = assertIs<CoreRpcException>(ErrorAttribution.unwrap(failed1.error))
        assertEquals("INTERNAL", cause1.code)
        assertFalse(cause1.raisedByCore, "this plugin raised it, not Core")
        assertTrue(ui.shown.isEmpty())
        assertEquals(1, rpc1.sent.size)
        for (text in listOf(step1.describe().title, step1.describe().body, cause1.message, cause1.localizedMessage)) {
            assertFalse(text.contains(token), text)
        }

        // A malformed step-2 answer that carries the token back.
        val rpc2 = ScriptedRpc(ok(step1Json()), ok("""{"removed":"$token"}"""))
        val step2 = SandboxRemoveFlow(commands(rpc2), FakeUi(answer = true)).run(name).get()
        val failed2 = assertIs<RemoveOutcome.Step2Failed>(step2)
        assertFalse(step2.describe().body.contains(token), step2.describe().body)
        assertFalse(ErrorAttribution.describe(failed2.error).contains(token))
    }

    @Test
    fun removeParamsNeverPrintTheirToken() {
        val params = labs.dkv.sandpane.model.SandboxRemoveParams(name, token)
        assertFalse(params.toString().contains(token), params.toString())
        assertTrue(params.toString().contains(name))
        assertFalse(labs.dkv.sandpane.model.SandboxRemoveParams(name).toString().contains("<redacted>"))
    }

    @Test
    fun stepTwoWithoutRemovedTrueIsNotReportedAsRemoved() {
        val rpc = ScriptedRpc(ok(step1Json()), ok("""{}"""))
        assertIs<RemoveOutcome.Step2Unconfirmed>(SandboxRemoveFlow(commands(rpc), FakeUi(true)).run(name).get())
    }

    @Test
    fun stepOneFailureNeverReachesTheDialog() {
        val rpc = ScriptedRpc(fail(CoreRpcException(CoreErrorCodes.NOT_FOUND, "not listed")))
        val ui = FakeUi(answer = true)
        assertIs<RemoveOutcome.Step1Failed>(SandboxRemoveFlow(commands(rpc), ui).run(name).get())
        assertTrue(ui.shown.isEmpty())
        assertEquals(1, rpc.sent.size)
    }

    @Test
    fun theTokenNeverAppearsInDisplayedOrPrintedText() {
        val parsed = CoreJson.decodeFromString(SandboxRemoveResult.serializer(), step1Json())
        assertFalse(parsed.confirmation.toString().contains(token))
        val ready = RemoveConfirmationCheck.decide(name, parsed) as RemoveConfirmationCheck.Decision.Ready
        assertFalse(ready.issued.toString().contains(token))
        for (outcome in listOf(
            RemoveOutcome.Refused(name, "x"), RemoveOutcome.Cancelled(name), RemoveOutcome.Removed(name),
            RemoveOutcome.Expired(name, future), RemoveOutcome.Step2Failed(name, TimeoutException()),
        )) {
            assertFalse(outcome.describe().body.contains(token))
        }
    }

    @Test
    fun lateFramesAreLoggedWithTheirTokensMasked() {
        val late = """{"v":1,"id":"jb-1-7","ok":${step1Json()}}"""
        val masked = FrameRedaction.redact(late)
        assertFalse(masked.contains(token), masked)
        assertTrue(masked.contains(""""token":"<redacted>""""))
        assertTrue(masked.contains(sbxId), "only the secret is masked")
        val request = """{"v":1,"id":"x","method":"sandbox.remove","params":{"name":"a1","confirmToken" : "$token"}}"""
        assertFalse(FrameRedaction.redact(request).contains(token))
    }

    // -----------------------------------------------------------------------
    // gating and guards: nothing sent
    // -----------------------------------------------------------------------

    @Test
    fun unadvertisedMethodsAreRefusedLocallyAndNeverSent() {
        val rpc = ScriptedRpc()
        val baseline = commands(rpc, "system.probe", "sandbox.list")
        for (call in listOf({ baseline.sandboxStop(name) }, { baseline.sandboxRemoveRequest(name) })) {
            val error = assertFailsWith<ExecutionException> { call().get() }
            assertIs<MethodNotSupportedException>(error.cause)
        }
        assertTrue(rpc.sent.isEmpty())
        assertTrue(ErrorAttribution.refusedLocally(MethodNotSupportedException("sandbox.stop", "x")))
    }

    @Test
    fun invalidNamesAreRefusedBeforeSending() {
        val rpc = ScriptedRpc()
        val c = commands(rpc)
        for (bad in listOf("", "a", "-rm", ".hidden", "default", "DEFAULT", "a b", "a;b", "x".repeat(129), "--force")) {
            val error = assertFailsWith<ExecutionException>(bad) { c.sandboxStop(bad).get() }
            assertIs<CoreValidationException>(error.cause, bad)
            assertFailsWith<ExecutionException>(bad) { c.sandboxRemoveRequest(bad).get() }
        }
        assertTrue(rpc.sent.isEmpty())
        // Core's rule is looser than the create schema: sbx-named and external sandboxes stay reachable.
        for (good in listOf("ab", "Claude-Atlas.Demo", "9x", "x".repeat(128))) {
            assertEquals(good, CoreGuards.requireAddressableSandboxName(good))
        }
    }

    // -----------------------------------------------------------------------
    // stop: absent requeried is UNKNOWN
    // -----------------------------------------------------------------------

    @Test
    fun stopWithoutRequeriedIsUnknownNeverStopped() {
        val result = CoreJson.decodeFromString(SandboxStopResult.serializer(), """{"stopped":true}""")
        assertNull(result.requeried)
        val text = StopReport.describe(name, result, null)
        assertTrue(text.body.contains("UNKNOWN"), text.body)
        assertTrue(text.body.contains("NOT assumed stopped"), text.body)
        assertEquals(OutcomeSeverity.WARNING, text.severity)
    }

    @Test
    fun stopWithRequeriedReportsCoresProbedState() {
        val result = CoreJson.decodeFromString(
            SandboxStopResult.serializer(),
            """{"stopped":true,"requeried":{"name":"$name","probedState":"stopped","agent":"shell","futureField":1}}""",
        )
        assertEquals("shell", result.requeried?.agent)
        val text = StopReport.describe(name, result, null)
        assertTrue(text.body.contains("reports state: stopped"), text.body)
        assertTrue(text.body.contains(CoreMethods.SANDBOX_START_UNSUPPORTED))
    }

    @Test
    fun stopRequeriedForAnotherNameIsUnknown() {
        val result = SandboxStopResult(true, SandboxSummary(name = "nova-demo-2", probedState = "stopped"))
        assertTrue(StopReport.describe(name, result, null).body.contains("UNKNOWN"))
    }

    @Test
    fun stopTimeoutIsUnknownAndCoreVerdictsKeepTheirCode() {
        assertTrue(StopReport.describe(name, null, TimeoutException()).body.contains("UNKNOWN"))
        val refused = StopReport.describe(name, null, CoreRpcException(CoreErrorCodes.DAEMON_DOWN, "daemon down"))
        assertTrue(refused.body.contains("DAEMON_DOWN"), refused.body)
    }

    // -----------------------------------------------------------------------
    // deadlines, agent field
    // -----------------------------------------------------------------------

    @Test
    fun longMethodsGetTheirOwnDeadlinesAndOthersKeepTheSetting() {
        assertEquals(360_000, MethodDeadlines.forMethod(CoreMethods.SANDBOX_STOP, 15_000))
        assertEquals(400_000, MethodDeadlines.forMethod(CoreMethods.SANDBOX_REMOVE, 15_000))
        assertEquals(15_000, MethodDeadlines.forMethod(CoreMethods.SANDBOX_LIST, 15_000))
        assertEquals(120_000, MethodDeadlines.forMethod(CoreMethods.TASK_LIST, 120_000))
        // A user setting above the floor still wins.
        assertEquals(500_000, MethodDeadlines.forMethod(CoreMethods.SANDBOX_REMOVE, 500_000))
    }

    @Test
    fun createSpecAgentIsAbsentByDefaultAndAllowlisted() {
        val plain = SandboxCreateSpec(name = "atlas-auth", projectId = "p1", workspaceMode = WorkspaceMode.MOUNTLESS)
        assertFalse(
            CoreJson.encodeToString(SandboxCreateSpec.serializer(), plain).contains("agent"),
            "absent agent stays off the wire, so an older Core sees the same request",
        )
        val codex = plain.copy(agent = "codex")
        assertTrue(CoreJson.encodeToString(SandboxCreateSpec.serializer(), codex).contains(""""agent":"codex""""))

        assertNull(CoreGuards.optionalSbxAgent(null))
        assertEquals("shell", CoreGuards.optionalSbxAgent("shell"))
        for (bad in listOf("", "Shell", "./my-kit", "../kit.zip", "--clone", "oci://x", "git@host:kit.git")) {
            assertFailsWith<CoreValidationException>(bad) { CoreGuards.optionalSbxAgent(bad) }
        }
        assertEquals("shell (provider-free)", SbxAgents.label("shell"))
        assertTrue(SbxAgents.label("claude").contains("agent not verified"))
    }

    @Test
    fun summaryAgentIsAbsentTolerant() {
        val old = CoreJson.decodeFromString(SandboxSummary.serializer(), """{"name":"a1"}""")
        assertNull(old.agent)
    }
}
