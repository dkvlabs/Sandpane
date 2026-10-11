package labs.dkv.sandpane.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreEventKinds
import labs.dkv.sandpane.model.CoreFeatures
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.OutputRedaction
import labs.dkv.sandpane.model.Reported
import labs.dkv.sandpane.model.RpcResponseFrame
import labs.dkv.sandpane.model.SandboxSummary
import labs.dkv.sandpane.model.TaskEvent
import labs.dkv.sandpane.model.TaskStatus
import labs.dkv.sandpane.model.TaskSummary
import labs.dkv.sandpane.model.VerificationResult
import labs.dkv.sandpane.model.VerificationRunParams
import labs.dkv.sandpane.model.WorkspaceMode
import labs.dkv.sandpane.services.TaskMonitorService
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.TimeoutException
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A7 (verification commands + `project.context`, design 2026-10-09 §3.7), client side: the REAL
 * [CoreCommands] wrappers over a recording transport (so [Recorder.sent] is what would go on the
 * wire), the gating, the run's binding resolution, the keyed-run rules, and the honest copy in
 * [Verifications]. Every Core answer below is an illustrative fixture shaped like Core's output (the
 * message texts are Core's constants, pinned by ProtocolDriftGuardTest), not a capture from a
 * running Core. Hostile characters are written as `\u` escapes, never raw.
 */
private class Recorder(private val reply: (String) -> CompletableFuture<JsonElement>) : CoreRpc {
    val sent = ArrayList<Pair<String, JsonObject>>()
    override fun request(method: String, params: JsonElement): CompletableFuture<JsonElement> {
        sent += method to (params as JsonObject)
        return reply(method)
    }
}

class VerificationTest {

    private val projectId = "a7a7a7a7-0000-4000-8000-000000000001"
    private val taskId = "a7a7a7a7-0000-4000-8000-0000000000aa"
    private val commandId = "a7a7a7a7-0000-4000-8000-0000000000cc"
    private val runId = "a7a7a7a7-0000-4000-8000-0000000000ee"

    /** A fixed clock reading (injectable time, D-I5). */
    private val t0 = 1_760_000_000_000L
    private val hour = 3_600_000L

    /** Tab, newline, quote, backslash, non-ASCII, a leading space and an empty element. */
    private val hostileArgv = listOf("np\tm", "a\nb", "say \"hi\" \\ ok", "café 中文", " leading", "")

    private fun caps(features: List<String> = CoreFeatures.KNOWN, methods: List<String> = CoreMethods.ALL) = CoreCapabilities(
        protocolVersion = 1,
        coreVersion = "0.1.0",
        instanceId = "i",
        platform = "macos",
        methods = methods,
        features = features,
    )

    private fun ok(json: String): CompletableFuture<JsonElement> = CompletableFuture.completedFuture(CoreJson.parseToJsonElement(json))

    private val answers = mapOf(
        CoreMethods.VERIFICATION_LIST to """{"commands":[{"id":"$commandId","projectId":"$projectId","label":"unit","argv":["make","test"],"approvedAt":"2026-10-12T10:00:00Z"}]}""",
        CoreMethods.VERIFICATION_APPROVE to """{"command":{"id":"$commandId","projectId":"$projectId","label":"unit","argv":["make","test"],"approvedAt":"2026-10-12T10:00:00Z"}}""",
        CoreMethods.VERIFICATION_REVOKE to """{"revoked":true}""",
        CoreMethods.VERIFICATION_RUN to """{"runId":"$runId","startedSequence":7}""",
        CoreMethods.VERIFICATION_RESULT to """{"runId":"$runId","outcome":"running","stdout":"","stderr":"","stdoutTruncated":false,"stderrTruncated":false,"redactions":{"bestEffort":true,"replacements":0,"byKind":{}},"startedAt":"2026-10-12T10:00:00Z"}""",
        CoreMethods.PROJECT_CONTEXT to """{"repositories":[{"repoPath":"/Users/demo/Atlas Demo","detected":[{"manifest":"Makefile","suggestedCommands":[["make","test"]],"notes":["n1"]}],"unreadable":["package.json"]}],"approved":[]}""",
    )

    private fun recorder() = Recorder { method -> ok(answers.getValue(method)) }

    private fun commands(rpc: CoreRpc, c: CoreCapabilities? = caps()) = CoreCommands(rpc) { c }

    private fun bound() = RunTarget.Bound("atlas-demo", WorkspaceMode.DIRECT_MOUNT)

    @AfterTest
    fun reset() {
        VerificationActivity.clearForTests()
        VerificationInFlight.end(taskId)
    }

    // -----------------------------------------------------------------------
    // exact frames for all six methods
    // -----------------------------------------------------------------------

    @Test
    fun theSixMethodsSendExactFramesWithArgvByteExact() {
        val rpc = recorder()
        val c = commands(rpc)
        c.verificationList(projectId).join()
        c.verificationApprove(projectId, "  unit é ", listOf("make") + hostileArgv.drop(0)).join()
        c.verificationRevoke(commandId).join()
        c.verificationRun(VerificationRunParams(taskId, commandId, "atlas-demo", WorkspaceMode.HOST_WORKTREE, "0123abcd" .repeat(4))).join()
        c.verificationResult(runId).join()
        c.projectContext(projectId).join()

        assertEquals(CoreMethods.ADDITIVE_A7.toList().sortedBy { CoreMethods.ALL.indexOf(it) }, rpc.sent.map { it.first })
        val frames = rpc.sent.map { it.second.toString() }
        assertEquals("{\"projectId\":\"$projectId\"}", frames[0])
        assertEquals(
            "{\"projectId\":\"$projectId\",\"label\":\"  unit é \",\"argv\":[\"make\",\"np\\tm\",\"a\\nb\"," +
                "\"say \\\"hi\\\" \\\\ ok\",\"café 中文\",\" leading\",\"\"]}",
            frames[1],
        )
        // Every element survives byte for byte (no trim, split, join or normalization).
        val sentArgv = rpc.sent[1].second.getValue("argv").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("make") + hostileArgv, sentArgv)
        assertEquals(sentArgv.map { it.toByteArray(Charsets.UTF_8).toList() }, (listOf("make") + hostileArgv).map { it.toByteArray(Charsets.UTF_8).toList() })
        assertEquals("{\"commandId\":\"$commandId\"}", frames[2])
        assertEquals(
            "{\"taskId\":\"$taskId\",\"commandId\":\"$commandId\",\"expectedSandboxName\":\"atlas-demo\"," +
                "\"expectedWorkspaceMode\":\"host_worktree\",\"idempotencyKey\":\"${"0123abcd".repeat(4)}\"}",
            frames[3],
        )
        assertEquals("{\"runId\":\"$runId\"}", frames[4])
        assertEquals("{\"projectId\":\"$projectId\"}", frames[5])
    }

    @Test
    fun answersDecodeToTypedValues() {
        val c = commands(recorder())
        assertEquals(listOf("make", "test"), c.verificationList(projectId).join().single().argv)
        assertEquals(commandId, c.verificationApprove(projectId, "unit", listOf("make", "test")).join().id)
        assertTrue(c.verificationRevoke(commandId).join())
        val started = c.verificationRun(VerificationRunParams(taskId, commandId, "atlas-demo", WorkspaceMode.DIRECT_MOUNT, "k1")).join()
        assertEquals(runId, started.runId)
        assertEquals(7L, started.startedSequence)
        assertNull(started.replayed)
        assertEquals("running", c.verificationResult(runId).join().outcome)
        val ctx = c.projectContext(projectId).join()
        assertEquals(listOf(listOf("make", "test")), ctx.repositories.single().detected.single().suggestedCommands)
        assertEquals(listOf("package.json"), ctx.repositories.single().unreadable)
    }

    @Test
    fun decodingToleratesAbsenceAndUnknownValuesAndNeverEchoesABadAnswer() {
        val minimal = CoreJson.decodeFromJsonElement(VerificationResult.serializer(), CoreJson.parseToJsonElement("""{"runId":"r","outcome":"brand_new","extra":1}"""))
        assertEquals("brand_new", minimal.outcome)
        assertNull(minimal.stdoutTruncated)
        assertNull(minimal.redactions)
        assertEquals("", minimal.stdout)
        assertTrue(Verifications.outcomeLine(minimal).contains("'brand_new'"))
        assertTrue(Verifications.disclosures(minimal).any { it.contains("did not report whether stdout was truncated") })
        // A shape mismatch is fixed text raised by this plugin; the payload (here a fake secret) is never shown.
        val bad = Recorder { ok("""{"stdout":"TOKEN=hunter2-secret"}""") }
        val error = runCatching { commands(bad).verificationResult(runId).join() }.exceptionOrNull()
        val t = ErrorAttribution.unwrap(error)
        assertIs<CoreRpcException>(t)
        assertFalse(t.raisedByCore)
        assertFalse(t.message.contains("hunter2"))
    }

    // -----------------------------------------------------------------------
    // gating
    // -----------------------------------------------------------------------

    @Test
    fun nothingIsSentUnlessTheVerificationFeatureAndTheMethodAreAdvertised() {
        val noFeature = caps(features = CoreFeatures.KNOWN - CoreFeatures.VERIFICATION)
        val noMethods = caps(methods = CoreMethods.ALL - CoreMethods.ADDITIVE_A7)
        for (c in listOf(noFeature, noMethods, null)) {
            val rpc = recorder()
            val cmds = commands(rpc, c)
            val calls = listOf<() -> CompletableFuture<*>>(
                { cmds.verificationList(projectId) },
                { cmds.verificationApprove(projectId, "unit", listOf("make", "test")) },
                { cmds.verificationRevoke(commandId) },
                { cmds.verificationRun(VerificationRunParams(taskId, commandId, "atlas-demo", WorkspaceMode.DIRECT_MOUNT, "k1")) },
                { cmds.verificationResult(runId) },
                { cmds.projectContext(projectId) },
            )
            for (call in calls) {
                val e = ErrorAttribution.unwrap(runCatching { call().join() }.exceptionOrNull())
                assertIs<MethodNotSupportedException>(e)
            }
            assertTrue(rpc.sent.isEmpty(), "a frame left without the gate: ${rpc.sent.map { it.first }}")
        }
        assertEquals(Verifications.NOT_ADVERTISED, Verifications.gate(noFeature))
        assertNull(Verifications.gate(caps()))
        assertTrue(Verifications.gate(null)!!.contains("Not connected"))
    }

    @Test
    fun aShapeCoreRefusesIsRefusedLocallyButNeverStricterThanCore() {
        assertNull(VerificationGuards.argvProblem(listOf("make") + hostileArgv), "TAB, LF, quotes, non-ASCII, spaces and empty later elements are Core-valid")
        assertEquals("argument 2 contains a control character", VerificationGuards.argvProblem(listOf("x", "a\u001Bb")))
        assertEquals("argument 1 contains a control character", VerificationGuards.argvProblem(listOf("a\rb")))
        assertEquals("argument 2 contains a control character", VerificationGuards.argvProblem(listOf("x", "\u0085")))
        assertEquals("argument 2 contains a NUL character", VerificationGuards.argvProblem(listOf("x", "a\u0000")))
        assertEquals("argument 1 (the program) is empty", VerificationGuards.argvProblem(listOf("")))
        assertEquals("argument 1 (the program) must not start with '-'", VerificationGuards.argvProblem(listOf("-rf")))
        assertNull(VerificationGuards.argvProblem(listOf("x", "-u", "--privileged")), "later elements may start with '-'")
        assertNull(VerificationGuards.argvProblem(List(64) { "a" }))
        assertTrue(VerificationGuards.argvProblem(List(65) { "a" })!!.contains("1 to 64"))
        assertNull(VerificationGuards.argvProblem(listOf("é".repeat(2048))), "4096 bytes is allowed")
        assertTrue(VerificationGuards.argvProblem(listOf("é".repeat(2049)))!!.contains("4096 bytes"))
        assertNull(VerificationGuards.argvProblem(listOf("\u202Ebidi")), "format characters are Core's call, not a client refusal")
        assertNull(VerificationGuards.labelProblem("  x  "))
        assertEquals("the label is empty", VerificationGuards.labelProblem("   "))
        val rpc = recorder()
        val e = ErrorAttribution.unwrap(runCatching { commands(rpc).verificationApprove(projectId, "x", listOf("a\u001Bb")).join() }.exceptionOrNull())
        assertIs<CoreValidationException>(e)
        assertTrue(rpc.sent.isEmpty())
    }

    // -----------------------------------------------------------------------
    // the run's expected values: the binding and sandbox.list, never chosenSandboxName
    // -----------------------------------------------------------------------

    private fun sandbox(name: String, mode: Reported<WorkspaceMode>?) = SandboxSummary(name = name, workspaceMode = mode)

    private fun task(binding: String?, chosen: String?) = TaskSummary(
        id = taskId,
        conversationId = "conv",
        status = Reported.Known(TaskStatus.AWAITING_REVIEW),
        sandboxName = binding,
        chosenSandboxName = chosen,
    )

    @Test
    fun runTargetComesFromTheBindingAndTheSandboxListNeverFromChosenSandboxName() {
        val list = listOf(
            sandbox("atlas-demo", Reported.Known(WorkspaceMode.DIRECT_MOUNT)),
            sandbox("nova-demo", Reported.Known(WorkspaceMode.HOST_WORKTREE)),
        )
        // Not bound, although the chat CHOSE a sandbox that sbx lists: Run stays disabled.
        val unbound = RunTarget.resolve(task(binding = null, chosen = "atlas-demo").sandboxName, list)
        assertIs<RunTarget.Unbound>(unbound)
        assertEquals("this task is not bound to a sandbox", unbound.reason)
        // Bound to nova-demo while the chat chose atlas-demo: the binding wins, with ITS listed mode.
        val t = task(binding = "nova-demo", chosen = "atlas-demo")
        val target = RunTarget.resolve(t.sandboxName, list)
        assertEquals(RunTarget.Bound("nova-demo", WorkspaceMode.HOST_WORKTREE), target)
        val prepared = VerificationRuns.newRun(t.id, commandId, target, caps()) { "fixedkey1" }
        assertIs<KeyedRequests.Prepared.Ready<VerificationRunParams>>(prepared)
        assertEquals("nova-demo", prepared.params.expectedSandboxName)
        assertEquals(WorkspaceMode.HOST_WORKTREE, prepared.params.expectedWorkspaceMode)
        // Every other gap is "not bound", with the exact leading phrase.
        for (gap in listOf(
            RunTarget.resolve("atlas-demo", null),
            RunTarget.resolve("orbit-demo", list),
            RunTarget.resolve("atlas-demo", list + sandbox("atlas-demo", Reported.Known(WorkspaceMode.MOUNTLESS))),
            RunTarget.resolve("atlas-demo", listOf(sandbox("atlas-demo", null))),
            RunTarget.resolve("atlas-demo", listOf(sandbox("atlas-demo", Reported.Unknown("future_mode")))),
        )) {
            assertIs<RunTarget.Unbound>(gap)
            assertTrue(gap.reason.startsWith(Verifications.NOT_BOUND), gap.reason)
        }
        // An unbound target is refused before the socket.
        assertIs<KeyedRequests.Prepared.Refused<VerificationRunParams>>(VerificationRuns.newRun(taskId, commandId, unbound, caps()))
    }

    // -----------------------------------------------------------------------
    // idempotency: a fresh key per gesture, the same key only for "Retry safely"
    // -----------------------------------------------------------------------

    @Test
    fun everyGestureMintsAFreshKeyAndOnlyRetrySafelyReusesIt() {
        val a = VerificationRuns.newRun(taskId, commandId, bound(), caps()) as KeyedRequests.Prepared.Ready
        val b = VerificationRuns.newRun(taskId, commandId, bound(), caps()) as KeyedRequests.Prepared.Ready
        val ka = a.params.idempotencyKey!!
        assertTrue(IdempotencyKeys.isValid(ka))
        assertNotEquals(ka, b.params.idempotencyKey, "two gestures share a key")
        val retry = VerificationRuns.retryRun(a.params, caps(), t0, t0 + 1) as KeyedRequests.Prepared.Ready
        assertEquals(a.params, retry.params, "Retry safely must resend the identical params with the same key")
        // Without the keys feature a run is refused locally (a lost answer could never be retried safely).
        val noKeys = caps(features = CoreFeatures.KNOWN - CoreFeatures.IDEMPOTENCY_KEYS)
        assertIs<KeyedRequests.Prepared.Refused<VerificationRunParams>>(VerificationRuns.newRun(taskId, commandId, bound(), noKeys))
        assertIs<KeyedRequests.Prepared.Refused<VerificationRunParams>>(VerificationRuns.retryRun(a.params, noKeys, t0, t0 + 1))
        assertIs<KeyedRequests.Prepared.Refused<VerificationRunParams>>(VerificationRuns.retryRun(a.params.copy(idempotencyKey = null), caps(), t0, t0 + 1))
        assertIs<KeyedRequests.Prepared.Refused<VerificationRunParams>>(VerificationRuns.retryRun(a.params.copy(idempotencyKey = "bad key"), caps(), t0, t0 + 1))
        // An invalid key never reaches the socket.
        val rpc = recorder()
        val e = ErrorAttribution.unwrap(runCatching { commands(rpc).verificationRun(a.params.copy(idempotencyKey = "bad key")).join() }.exceptionOrNull())
        assertIs<CoreValidationException>(e)
        assertTrue(rpc.sent.isEmpty())
    }

    @Test
    fun retrySafelyIsOfferedOnlyAfterALostAnswerOfAKeyedRun() {
        val run = CoreMethods.VERIFICATION_RUN
        val lost = listOf<Throwable>(
            TimeoutException(),
            CompletionException(CoreTransportException("connection reset")),
            CoreRpcException(CoreErrorCodes.INTERNAL, "shape", raisedByCore = false),
            CoreRpcException(CoreErrorCodes.INTERNAL, "database is locked"),
        )
        for (e in lost) {
            val p = Verifications.describeFailure(run, e, keyed = true)
            assertTrue(p.offerRetrySafely, "$e")
            assertTrue(p.mayHaveStarted)
            assertTrue(p.body.contains("may have started"), p.body)
            assertFalse(p.body.contains("nothing was run", ignoreCase = true), p.body)
            assertFalse(Verifications.describeFailure(run, e, keyed = false).offerRetrySafely)
        }
        val refusals = listOf(
            CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, Verifications.MSG_NOT_BOUND),
            CoreRpcException(CoreErrorCodes.CONFLICT, Verifications.MSG_TASK_BUSY),
            CoreRpcException(CoreErrorCodes.CONFLICT, KeyedWrites.CONFLICT_MISMATCH),
            CoreRpcException(CoreErrorCodes.UNSUPPORTED_SBX_VERSION, Verifications.EXEC_UNVERIFIED_PREFIX + "0.47.0" + Verifications.EXEC_UNVERIFIED_SUFFIX),
            CoreRpcException(CoreErrorCodes.INTERNAL, Verifications.MSG_SHUTTING_DOWN),
            CoreValidationException("taskId", "identifier is required"),
        )
        for (e in refusals) assertFalse(Verifications.describeFailure(run, e, keyed = true).offerRetrySafely, "$e")
    }

    @Test
    fun runIsSingleFlightPerTask() {
        assertTrue(VerificationInFlight.begin(taskId, t0, "k1"))
        assertFalse(VerificationInFlight.begin(taskId, t0, "k1"), "a second run request for the same task while one is unresolved")
        assertTrue(VerificationInFlight.isActive(taskId))
        assertTrue(VerificationInFlight.begin("other-task", t0, "k2"))
        VerificationInFlight.end("other-task")
        VerificationInFlight.end(taskId)
        assertTrue(VerificationInFlight.begin(taskId, t0, "k1"))
    }

    // -----------------------------------------------------------------------
    // outcome copy and disclosures
    // -----------------------------------------------------------------------

    @Test
    fun everyOutcomeHasItsHonestCopyAndAnExitStatusIsNeverPassOrFail() {
        assertEquals("exit status 0 (as reported by sbx exec)", Verifications.outcomeLine("exited", 0))
        assertEquals("exit status 7 (as reported by sbx exec)", Verifications.outcomeLine("exited", 7))
        // 0 and 7 differ ONLY by the number: no colour, no word, no severity.
        assertEquals(Verifications.outcomeLine("exited", 0).replace("0", "N"), Verifications.outcomeLine("exited", 7).replace("7", "N"))
        assertEquals("ended by a signal (no exit status)", Verifications.outcomeLine("signaled", null))
        assertEquals(
            "stopped after 10 minutes; the command may still be running inside the sandbox",
            Verifications.outcomeLine("timed_out", null),
        )
        assertEquals(
            "Core restarted (or stopped) while this ran; the result is unknown; the command may still be running inside the sandbox",
            Verifications.outcomeLine("interrupted", null),
        )
        assertEquals(
            "possibly sbx's own error, or the command's own output; exit status 1 (as reported by sbx exec)",
            Verifications.outcomeLine("possibly_sbx_error", 1),
        )
        assertTrue(Verifications.outcomeLine("spawn_failed", null).contains("spawn_failed"))
        assertTrue(Verifications.outcomeLine("read_failed", null).contains("read_failed"))
        assertTrue(Verifications.outcomeLine("running", null).startsWith("running"))
        assertTrue(Verifications.outcomeLine("x\u001B[31m", null).contains("\\u001B"), "an unknown outcome is shown revealed")
        for (o in Verifications.KNOWN_OUTCOMES + listOf("brand_new", null)) {
            for (code in listOf(0, 1, 7, null)) {
                val line = Verifications.outcomeLine(o, code).lowercase()
                // `\b` treats `_` as a word character, so spawn_failed / read_failed are not the word "failed".
                for (word in listOf("pass", "passed", "fail", "failed", "success", "succeeded", "green", "ok")) {
                    assertFalse(Regex("\\b$word\\b").containsMatchIn(line), "'$word' in: $line")
                }
            }
        }
        // possibly_sbx_error never relays a `try:` hint as advice: only the fixed sentence plus the status.
        assertFalse(Verifications.outcomeLine("possibly_sbx_error", 1).contains("try"))
    }

    @Test
    fun everyDisclosureFlagIsShown() {
        val r = VerificationResult(
            runId = runId,
            outcome = "exited",
            exitCode = 0,
            stdoutTruncated = true,
            stderrTruncated = true,
            outputIncomplete = true,
            redactions = OutputRedaction(bestEffort = true, replacements = 3, byKind = mapOf("token" to 2L, "auth-header" to 1L)),
            elapsedMs = 1234,
        )
        val d = Verifications.disclosures(r)
        assertTrue(d.contains("stdout was truncated at Core's 64 KiB cap"), d.toString())
        assertTrue(d.contains("stderr was truncated at Core's 64 KiB cap"), d.toString())
        assertTrue(d.contains("output may be incomplete: a process kept the output open after the command exited"))
        assertTrue(d.any { it.startsWith("3 values were redacted (best effort)") && it.contains("token 2") }, d.toString())
        val one = Verifications.disclosures(r.copy(redactions = OutputRedaction(replacements = 1)))
        assertTrue(one.any { it.startsWith("1 value was redacted (best effort)") }, one.toString())
        val withheld = Verifications.disclosures(r.copy(redactions = OutputRedaction(replacements = 0, outputWithheld = true)))
        assertTrue(withheld.contains("output was not stored because the secret check was unavailable"))
        val clean = Verifications.disclosures(r.copy(stdoutTruncated = false, stderrTruncated = false, outputIncomplete = null, redactions = OutputRedaction(replacements = 0)))
        assertFalse(clean.any { it.contains("truncated") || it.contains("incomplete") || it.contains("not stored") }, clean.toString())
    }

    // -----------------------------------------------------------------------
    // refusal copy
    // -----------------------------------------------------------------------

    @Test
    fun unsupportedSbxVersionIsTheVersionGateNeverACommandFailure() {
        for (msg in listOf(
            Verifications.EXEC_UNVERIFIED_PREFIX + "0.47.0" + Verifications.EXEC_UNVERIFIED_SUFFIX,
            Verifications.MSG_VERSION_UNREADABLE,
        )) {
            val p = Verifications.describeFailure(CoreMethods.VERIFICATION_RUN, CoreRpcException(CoreErrorCodes.UNSUPPORTED_SBX_VERSION, msg), keyed = true)
            assertTrue(p.body.startsWith(Verifications.UNSUPPORTED_VERSION_COPY), p.body)
            assertTrue(p.body.contains("your approved commands are kept"))
            assertFalse(p.body.replace(msg, "").contains("fail", ignoreCase = true), p.body)
            assertFalse(p.title.contains("fail", ignoreCase = true), p.title)
            assertEquals(OutcomeSeverity.INFO, p.severity)
            assertFalse(p.offerRetrySafely)
        }
    }

    @Test
    fun frameRefusalsShowCoresTextAndDetailsAndAreNeverRetried() {
        val msg = "the response would exceed the frame limit (5000000 bytes, the limit is 4128768); the largest parts are " +
            "repository /Users/demo/Atlas Demo (4000000 bytes); remove repositories from the project or revoke approved commands; nothing was returned"
        val details = buildJsonObject {
            put("repositories", buildJsonArray { add(buildJsonObject { put("repoPath", "/Users/demo/Atlas\u202E Demo"); put("bytes", 4000000) }) })
            put("repositoryCount", 1)
            put("approvedBytes", 120)
        }
        val p = Verifications.describeFailure(CoreMethods.PROJECT_CONTEXT, CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, msg, details = details))
        assertTrue(p.title.contains("nothing was returned"))
        assertTrue(p.body.contains("nothing is retried automatically"))
        assertTrue(p.body.contains("/Users/demo/Atlas\\u202E Demo (4000000 bytes)"), p.body)
        assertTrue(p.body.contains("repositories in the project: 1"))
        assertFalse(p.body.contains("\u202E"))
        val ids = buildJsonObject { put("commandIds", buildJsonArray { repeat(25) { add(kotlinx.serialization.json.JsonPrimitive("cmd-$it")) } }) }
        val list = Verifications.describeFailure(CoreMethods.VERIFICATION_LIST, CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, msg, details = ids))
        assertTrue(list.body.contains("commands in the refused answer (25)") && list.body.contains("and 5 more"), list.body)
        val result = Verifications.describeFailure(CoreMethods.VERIFICATION_RESULT, CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, msg, details = buildJsonObject { put("runId", runId) }))
        assertTrue(result.body.contains("run: $runId"))
        assertFalse(p.offerRetrySafely || list.offerRetrySafely || result.offerRetrySafely)
    }

    @Test
    fun secretRefusalsShowCoresMessageAndItsHint() {
        val msg = "argument 3 looks like a secret (token); approved commands cannot hold secrets; nothing was approved"
        val details = buildJsonObject { put("hint", Verifications.SECRET_REFUSAL_HINT) }
        val p = Verifications.describeFailure(CoreMethods.VERIFICATION_APPROVE, CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, msg, details = details))
        assertTrue(p.body.contains(msg))
        assertTrue(p.body.contains("Core's hint: " + Verifications.SECRET_REFUSAL_HINT), p.body)
        val combined = "the arguments together look like a secret (token); approved commands cannot hold secrets; nothing was approved"
        assertTrue(Verifications.describeFailure(CoreMethods.VERIFICATION_APPROVE, CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, combined, details = details)).body.contains("Core's hint"))
        val unavailable = Verifications.describeFailure(CoreMethods.VERIFICATION_APPROVE, CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, Verifications.MSG_SECRET_CHECK_UNAVAILABLE))
        assertTrue(unavailable.body.contains("nothing was approved"))
        val shape = Verifications.describeFailure(
            CoreMethods.VERIFICATION_APPROVE,
            CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, "argv: value has an invalid shape: argument 2 contains a control character"),
        )
        assertTrue(shape.body.contains("nothing was approved") && shape.body.contains("argument 2 contains a control character"), shape.body)
        assertTrue(Verifications.describeFailure(CoreMethods.VERIFICATION_APPROVE, CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, Verifications.MSG_TOO_MANY_COMMANDS)).body.contains("nothing was approved"))
    }

    @Test
    fun coreErrorDetailsSurviveTheTransportAndStayOutOfTheMessage() {
        val frame = CoreJson.decodeFromString(
            RpcResponseFrame.serializer(),
            """{"v":1,"id":"7","err":{"code":"VALIDATION_FAILED","message":"m","details":{"hint":"h"}}}""",
        )
        val e = CoreRpcException.fromCore(frame.err!!)
        assertEquals("h", Verifications.hint(e.details))
        assertTrue(e.raisedByCore)
        assertEquals("VALIDATION_FAILED: m", e.localizedMessage)
    }

    @Test
    fun gateRefusalsSayNothingWasRunAndALostReadSaysNothingChanged() {
        for (msg in listOf(
            Verifications.MSG_NOT_BOUND, Verifications.MSG_SANDBOX_CHANGED, Verifications.MSG_IDENTITY,
            Verifications.MSG_COMMAND_REVOKED, Verifications.MSG_COMMAND_OTHER_PROJECT, Verifications.MSG_COMMAND_NO_LONGER_PASSES,
            Verifications.NOT_RUNNING_PREFIX + "atlas-demo" + Verifications.NOT_RUNNING_SUFFIX,
        )) {
            val p = Verifications.describeFailure(CoreMethods.VERIFICATION_RUN, CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, msg), keyed = true)
            assertTrue(p.body.contains("Nothing was run") && p.body.contains(msg), p.body)
        }
        for (msg in listOf(Verifications.MSG_TASK_BUSY, Verifications.MSG_SANDBOX_BUSY, Verifications.MSG_CORE_BUSY,
            "/Users/demo/Atlas Demo is busy: verification.run:x" + Verifications.REPO_BUSY_SUFFIX,
            "another operation on sandbox \"atlas-demo\" is in progress; nothing was run")) {
            val p = Verifications.describeFailure(CoreMethods.VERIFICATION_RUN, CoreRpcException(CoreErrorCodes.CONFLICT, msg), keyed = true)
            assertTrue(p.body.contains("Nothing was run") || p.body.contains("nothing was run"), p.body)
            assertFalse(p.offerRetrySafely)
        }
        val archived = Verifications.describeFailure(
            CoreMethods.VERIFICATION_RUN,
            CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, ProjectOutcomes.MSG_PROJECT_ARCHIVED),
            keyed = true,
        )
        assertTrue(archived.body.contains("ran nothing") && archived.body.contains(ProjectOutcomes.MSG_PROJECT_ARCHIVED), archived.body)
        val notFound = Verifications.describeFailure(CoreMethods.VERIFICATION_RESULT, CoreRpcException(CoreErrorCodes.NOT_FOUND, Verifications.MSG_RUN_NOT_FOUND))
        assertTrue(notFound.body.contains(Verifications.MSG_RUN_NOT_FOUND))
        val noSbx = Verifications.describeFailure(CoreMethods.VERIFICATION_RUN, CoreRpcException(CoreErrorCodes.NOT_INSTALLED, "sbx not found"), keyed = true)
        assertTrue(noSbx.body.contains("nothing was run"))
        val lostRead = Verifications.describeFailure(CoreMethods.VERIFICATION_LIST, TimeoutException())
        assertTrue(lostRead.body.contains("nothing changed in Core"))
        assertFalse(lostRead.offerRetrySafely)
        val lostApprove = Verifications.describeFailure(CoreMethods.VERIFICATION_APPROVE, TimeoutException())
        assertTrue(lostApprove.body.contains("may have been approved"))
        val local = Verifications.describeFailure(CoreMethods.VERIFICATION_RUN, MethodNotSupportedException(CoreMethods.VERIFICATION_RUN, "x"), keyed = true)
        assertTrue(local.body.endsWith("Nothing was sent."))
    }

    @Test
    fun deleteFlowsWordTheVerificationRunningRefusal() {
        val shown = RemoveOutcome.Step1Failed(
            "atlas-demo",
            CoreRpcException(CoreErrorCodes.CONFLICT, Verifications.MSG_SANDBOX_VERIFICATION_RUNNING),
        ).describe()
        assertTrue(shown.body.contains("Nothing was deleted"), shown.body)
        assertTrue(shown.title.contains("verification is running"))
        val step2 = RemoveOutcome.Step2Failed(
            "atlas-demo",
            CoreRpcException(CoreErrorCodes.CONFLICT, Verifications.MSG_SANDBOX_VERIFICATION_RUNNING),
        ).describe()
        assertTrue(step2.body.contains("Nothing was deleted"), step2.body)
        assertFalse(step2.body.contains("different sandbox now has this name"), "a verification refusal is not a name conflict")
        assertTrue(Verifications.STOP_DURING_RUN == "a verification is running in this sandbox; stopping it ends the run")
    }

    // -----------------------------------------------------------------------
    // events: notes and the activity registry; never output, never status
    // -----------------------------------------------------------------------

    private fun event(kind: String, payload: String, seq: Long = 5) =
        TaskEvent(taskId = taskId, sequence = seq, kind = kind, payload = CoreJson.parseToJsonElement(payload), timestamp = "2026-10-12T10:00:00Z")

    @Test
    fun verificationEventsAreNotesThatNeverCarryOutputOrChangeStatus() {
        val started = event(CoreEventKinds.VERIFICATION_STARTED, """{"runId":"$runId","commandId":"c","label":"unit\u001B]8;;http://x\u0007","argv":["make"],"sandbox":"atlas-demo","workspaceMode":"direct_mount"}""")
        val finished = event(
            CoreEventKinds.VERIFICATION_FINISHED,
            """{"runId":"$runId","startedSequence":5,"outcome":"exited","exitCode":0,"stdoutBytes":9,"stderrBytes":0,"stdoutTruncated":false,"stderrTruncated":false,"redactions":{"bestEffort":true,"replacements":0,"byKind":{}},"elapsedMs":10,"stdout":"LEAK-OUTPUT"}""",
            seq = 6,
        )
        val startNote = started.toRenderedEvent().note!!
        assertTrue(startNote.contains("verification started") && startNote.contains("atlas-demo"), startNote)
        assertFalse(startNote.contains("\u001B") || startNote.contains("\u0007"), "a control character reached a note")
        val finishNote = finished.toRenderedEvent().note!!
        assertTrue(finishNote.contains("exit status 0 (as reported by sbx exec)"), finishNote)
        assertFalse(finishNote.contains("LEAK-OUTPUT"))
        assertTrue(event(CoreEventKinds.VERIFICATION_FINISHED, "[1]").toRenderedEvent().note!!.contains("unreadable payload"))

        val row = TaskMonitorService.TaskView(taskId, "conv", Reported.Known(TaskStatus.AWAITING_REVIEW), "atlas-demo", null, null, 4, null, emptyList())
        val after = TaskMonitorService.fold(TaskMonitorService.fold(row, started, started.toRenderedEvent()), finished, finished.toRenderedEvent())
        assertEquals(Reported.Known(TaskStatus.AWAITING_REVIEW), after.status, "a verification changed the task's status")
    }

    @Test
    fun theActivityRegistryKnowsRunsInFlightPerSandboxFromEventsAndAnswers() {
        val started = event(CoreEventKinds.VERIFICATION_STARTED, """{"runId":"$runId","sandbox":"atlas-demo","label":"unit"}""")
        assertNull(VerificationActivity.observe(taskId, started.kind, started.payload))
        assertTrue(VerificationActivity.runningIn("atlas-demo"))
        assertFalse(VerificationActivity.runningIn("nova-demo"))
        val finished = event(CoreEventKinds.VERIFICATION_FINISHED, """{"runId":"$runId","outcome":"signaled"}""")
        assertEquals(runId, VerificationActivity.observe(taskId, finished.kind, finished.payload))
        assertFalse(VerificationActivity.runningIn("atlas-demo"))
        // Our own run answer counts as started until a finished event or a terminal result arrives.
        VerificationActivity.recordStarted(taskId, "run-2", "nova-demo", "unit", 9, replayed = false)
        assertTrue(VerificationActivity.runningIn("nova-demo"))
        VerificationActivity.recordResult(VerificationResult(runId = "run-2", taskId = taskId, outcome = "running"))
        assertTrue(VerificationActivity.runningIn("nova-demo"))
        VerificationActivity.recordResult(VerificationResult(runId = "run-2", taskId = taskId, outcome = "timed_out"))
        assertFalse(VerificationActivity.runningIn("nova-demo"))
        // Unknown kinds and unreadable payloads change nothing.
        assertNull(VerificationActivity.observe(taskId, "status.changed", started.payload))
        assertNull(VerificationActivity.observe(taskId, CoreEventKinds.VERIFICATION_STARTED, CoreJson.parseToJsonElement("[]")))
        assertEquals(setOf(runId, "run-2"), VerificationActivity.runsForTasks(setOf(taskId)).map { it.runId }.toSet())
    }

    // -----------------------------------------------------------------------
    // review fixes (J-W1, J-I1, J-I5, D-I5)
    // -----------------------------------------------------------------------

    @Test
    fun startingAVerificationNeverChangesATrackedTasksDisplayedStatus() {
        // The monitor already folded Core's events up to sequence 12: the task is completed.
        var view = TaskMonitorService.TaskView(taskId, "conv", Reported.Known(TaskStatus.COMPLETED), "atlas-demo", null, null, 12, null, emptyList())
        // The panel's task.list row is OLDER: it still says running.
        val stale = TaskSummary(taskId, "conv", Reported.Known(TaskStatus.RUNNING), sandboxName = "atlas-demo")
        val calls = ArrayList<Triple<String, String?, TaskSummary?>>()
        // The same shape as TaskMonitorService.track: a summary, when given, overwrites the row (fromSummary).
        VerificationRuns.followAfterStart(stale) { id, conversationId, summary ->
            calls += Triple(id, conversationId, summary)
            summary?.let { view = TaskMonitorService.fromSummary(it, view) }
        }
        assertEquals(listOf(Triple<String, String?, TaskSummary?>(taskId, "conv", null)), calls, "a TaskSummary was passed to track")
        assertEquals(Reported.Known(TaskStatus.COMPLETED), view.status, "starting a verification changed the task's displayed status")
        assertEquals(12L, view.lastSequence)
    }

    @Test
    fun aHeldClaimSaysWhereToResolveItAfterALostAnswer() {
        assertNull(VerificationInFlight.blockReason(taskId))
        assertTrue(VerificationInFlight.begin(taskId, t0, "k1"))
        assertEquals(Verifications.IN_FLIGHT_SENDING, VerificationInFlight.blockReason(taskId))
        VerificationInFlight.markLost(taskId)
        val why = VerificationInFlight.blockReason(taskId)!!
        assertEquals(Verifications.IN_FLIGHT_LOST, why)
        assertTrue(why.contains("Retry safely") && why.contains("Do not retry") && why.contains("Notifications tool window"), why)
        VerificationInFlight.markResending(taskId)
        assertEquals(Verifications.IN_FLIGHT_SENDING, VerificationInFlight.blockReason(taskId))
        VerificationInFlight.end(taskId)
        assertNull(VerificationInFlight.blockReason(taskId))
    }

    @Test
    fun aListRowNeverMakesOneElementLookLikeTwo() {
        // Every Zs space other than U+0020, plus the row's own delimiters, inside elements.
        val spaces = listOf('\u00A0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200A', '\u202F', '\u205F', '\u3000')
        for (c in spaces) assertEquals(Character.SPACE_SEPARATOR.toInt(), Character.getType(c), "precondition U+%04X".format(c.code))
        val argv = spaces.map { "a${it}b" } + listOf("x\u27E9 \u27E8y", "\u27E8\u27E9")
        val row = Verifications.commandRow("unit \u27E8z\u27E9", argv)
        for (c in spaces) assertFalse(row.contains(c), "raw U+%04X in a list row".format(c.code))
        for (c in spaces) assertTrue(row.contains("a\\u%04Xb".format(c.code)), "U+%04X is not shown escaped: $row".format(c.code))
        // The only delimiters left are the row's own: exactly two per element.
        assertEquals(argv.size, row.count { it == '\u27E8' }, row)
        assertEquals(argv.size, row.count { it == '\u27E9' }, row)
        assertTrue(row.contains("\u27E8x\\u27E9 \\u27E8y\u27E9"), row)
        // An ordinary space stays a space (delimiters already make it visible).
        assertTrue(Verifications.commandRow("u", listOf(" a")).contains("\u27E8 a\u27E9"))
    }

    @Test
    fun retrySafelyEndsBeforeCoreCanForgetTheKey() {
        val a = VerificationRuns.newRun(taskId, commandId, bound(), caps()) as KeyedRequests.Prepared.Ready
        val key = a.params.idempotencyKey!!
        val inWindow = VerificationRuns.retryRun(a.params, caps(), t0, t0 + 23 * hour - 1)
        assertEquals(a.params, (inWindow as KeyedRequests.Prepared.Ready).params)
        for (late in listOf(t0 + 23 * hour, t0 + 24 * hour, t0 + 72 * hour)) {
            val refused = VerificationRuns.retryRun(a.params, caps(), t0, late)
            assertIs<KeyedRequests.Prepared.Refused<VerificationRunParams>>(refused)
            assertTrue(refused.reason.startsWith(Verifications.TOO_LATE_TO_RETRY), refused.reason)
            assertTrue(refused.reason.contains("may have started"))
        }
        // No record of the original send (the claim was released): never retried.
        assertIs<KeyedRequests.Prepared.Refused<VerificationRunParams>>(VerificationRuns.retryRun(a.params, caps(), null, t0))
        // The claim records the ORIGINAL send of THIS key; a resend keeps it.
        assertTrue(VerificationInFlight.begin(taskId, t0, key))
        assertEquals(t0, VerificationInFlight.firstSentAt(taskId, key))
        assertNull(VerificationInFlight.firstSentAt(taskId, "another-key"), "a later run's claim answered for an earlier key")
        VerificationInFlight.markLost(taskId)
        VerificationInFlight.markResending(taskId)
        VerificationInFlight.markLost(taskId)
        assertEquals(t0, VerificationInFlight.firstSentAt(taskId, key))
        // A lost-answer claim is released once the window closes, never before.
        assertEquals(emptyList(), VerificationInFlight.releaseExpired(t0 + 23 * hour - 1))
        assertTrue(VerificationInFlight.isActive(taskId))
        assertEquals(listOf(taskId), VerificationInFlight.releaseExpired(t0 + 23 * hour))
        assertFalse(VerificationInFlight.isActive(taskId))
        // A claim still waiting for its first answer is not "expired" (the send has its own deadline).
        assertTrue(VerificationInFlight.begin(taskId, t0, key))
        assertEquals(emptyList(), VerificationInFlight.releaseExpired(t0 + 48 * hour))
        assertTrue(VerificationInFlight.isActive(taskId))
    }
}
