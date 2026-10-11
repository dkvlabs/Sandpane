package labs.dkv.sandpane.core

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import labs.dkv.sandpane.model.ApplyResult
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreEventKinds
import labs.dkv.sandpane.model.CoreFeatures
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.GitApplyParams
import labs.dkv.sandpane.model.ModeChange
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.TimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A6 (`git.apply` for reviewed files, design 2026-10-09 §3.6), client side: the REAL
 * [CoreCommands.gitApply] over a recording transport (so [ApplyRpc.sent] is what would go on the
 * wire), and the result / failure copy in [GitApplies]. Every Core answer and reason below is an
 * illustrative fixture shaped like Core's output (the reason texts are Core's constants, pinned by
 * ProtocolDriftGuardTest), not a capture from a running Core.
 */
private class ApplyRpc(private val reply: () -> CompletableFuture<JsonElement>) : CoreRpc {
    val sent = ArrayList<Pair<String, JsonObject>>()
    override fun request(method: String, params: JsonElement): CompletableFuture<JsonElement> {
        sent += method to (params as JsonObject)
        return reply()
    }
}

class GitApplyTest {

    private val taskId = "5b0c7a1e-0000-4000-8000-00000000a6a6"
    private val base = "0123456789abcdef0123456789abcdef01234567"
    private val repo = "/Users/demo/Atlas Demo"

    private fun caps(features: List<String> = CoreFeatures.KNOWN, methods: List<String> = CoreMethods.ALL) = CoreCapabilities(
        protocolVersion = 1,
        coreVersion = "0.1.0",
        instanceId = "i",
        platform = "macos",
        methods = methods,
        features = features,
    )

    private fun ok(json: String): () -> CompletableFuture<JsonElement> = { CompletableFuture.completedFuture(CoreJson.parseToJsonElement(json)) }

    private val okApplied = ok("""{"applied":true,"conflictedFiles":[],"appliedFiles":["a"]}""")

    /** Entries exactly as a `git.review` answer carries them (tab, quote, newline, non-ASCII, rename, delete). */
    private val reviewChanges: JsonArray = CoreJson.parseToJsonElement(
        """[
          {"path":" src/a\tb\"c\\dé\nz.kt ","status":"modified","taskBlob":"${"a".repeat(40)}","taskMode":"100644"},
          {"path":"new/name.kt","status":"renamed","oldPath":"old/na\u202Eme.kt","taskBlob":"${"b".repeat(64)}","taskMode":"100755"},
          {"path":"gone.txt","status":"deleted"}
        ]""",
    ).jsonArray

    private fun params(entries: List<JsonObject> = reviewChanges.map { it.jsonObject }) =
        GitApplyParams(taskId = taskId, expectedBase = base, reviewId = "rev-1", entries = entries)

    // -----------------------------------------------------------------------
    // frames
    // -----------------------------------------------------------------------

    @Test
    fun theFrameCarriesReviewIdAndTheReviewEntriesVerbatim() {
        val rpc = ApplyRpc(okApplied)
        CoreCommands(rpc) { caps() }.gitApply(params()).get()
        val (method, frame) = rpc.sent.single()
        assertEquals(CoreMethods.GIT_APPLY, method)
        assertEquals(setOf("taskId", "expectedBase", "reviewId", "entries"), frame.keys)
        assertEquals("rev-1", frame["reviewId"]!!.jsonPrimitive.content)
        assertEquals(base, frame["expectedBase"]!!.jsonPrimitive.content)
        assertEquals(taskId, frame["taskId"]!!.jsonPrimitive.content)
        // The review's own objects, unchanged: same keys, same order, same values; absent stays absent.
        assertEquals(reviewChanges, frame["entries"])
        val first = frame["entries"]!!.jsonArray[0].jsonObject
        assertEquals(" src/a\tb\"c\\dé\nz.kt ", first["path"]!!.jsonPrimitive.content, "the path is byte-exact")
        assertEquals(listOf("path", "status", "taskBlob", "taskMode"), first.keys.toList())
        val deleted = frame["entries"]!!.jsonArray[2].jsonObject
        assertEquals(setOf("path", "status"), deleted.keys, "a deleted entry gains no blob, mode or oldPath")
        // And the encoded text round-trips to the same JSON (nothing normalized on the way out).
        val text = CoreJson.encodeToString(JsonObject.serializer(), frame)
        assertEquals(reviewChanges, CoreJson.parseToJsonElement(text).jsonObject["entries"])
    }

    @Test
    fun selectedFilesIsNeverSent() {
        val rpc = ApplyRpc(okApplied)
        CoreCommands(rpc) { caps() }.gitApply(params()).get()
        assertFalse(rpc.sent.single().second.containsKey("selectedFiles"))
        // The type cannot carry it at all.
        assertFalse(GitApplyParams::class.java.declaredFields.any { it.name == "selectedFiles" })
    }

    @Test
    fun gitApplyIsRefusedLocallyWithoutTheGitApplyFeature() {
        val rpc = ApplyRpc(okApplied)
        val pre = caps(features = CoreFeatures.KNOWN - CoreFeatures.GIT_APPLY)
        val error = runCatching { CoreCommands(rpc) { pre }.gitApply(params()).get() }.exceptionOrNull()
        val refused = assertIs<MethodNotSupportedException>(ErrorAttribution.unwrap(error))
        assertTrue(refused.message!!.contains("git-apply"), refused.message)
        assertTrue(rpc.sent.isEmpty(), "nothing was sent")
        // Not connected at all: also refused locally.
        val none = runCatching { CoreCommands(rpc) { null }.gitApply(params()).get() }.exceptionOrNull()
        assertIs<MethodNotSupportedException>(ErrorAttribution.unwrap(none))
        assertTrue(rpc.sent.isEmpty())
        // The local refusal is worded as "nothing was sent", never as an outcome at Core.
        val shown = GitApplies.presentFailure(error, repo)
        assertTrue(shown.body.contains("nothing was sent", ignoreCase = true), shown.body)
        assertFalse(shown.mayHaveWritten)
        assertFalse(shown.sentToCore, "only a pre-socket refusal keeps the review")
        assertTrue(GitApplies.NOT_IMPLEMENTED.contains("not implemented by this Core"), GitApplies.NOT_IMPLEMENTED)
    }

    @Test
    fun anInvalidTaskIdIsRefusedBeforeTheSocket() {
        val rpc = ApplyRpc(okApplied)
        val bad = CoreCommands(rpc) { caps() }.gitApply(params().copy(taskId = ""))
        assertIs<CoreValidationException>(ErrorAttribution.unwrap(runCatching { bad.get() }.exceptionOrNull()))
        assertTrue(rpc.sent.isEmpty())
    }

    @Test
    fun theApplyDeadlineIsTheGitDeadline() {
        assertEquals(45_000, MethodDeadlines.GIT_APPLY_MS)
        assertEquals(45_000, MethodDeadlines.forMethod(CoreMethods.GIT_APPLY, 15_000))
        assertEquals(28, CoreMethods.ALL.size, "A6 adds no method")
        assertFalse(CoreMethods.REQUIRES_ADVERTISEMENT.contains(CoreMethods.GIT_APPLY), "git.apply is baseline; gated on the feature")
    }

    // -----------------------------------------------------------------------
    // decoding
    // -----------------------------------------------------------------------

    @Test
    fun applyResultDecodesThePreA6AndTheA6Shapes() {
        val old = CoreJson.decodeFromString(ApplyResult.serializer(), """{"applied":true}""")
        assertTrue(old.applied)
        assertNull(old.appliedFiles)
        assertNull(old.partial)
        val a6 = CoreJson.decodeFromString(
            ApplyResult.serializer(),
            """{"applied":true,"conflictedFiles":[],"appliedFiles":["bin/run.sh"],
               "modeChanges":[{"path":"bin/run.sh","from":"100644","to":"100755"}],"snapshotTree":"${"c".repeat(40)}","later":1}""",
        )
        assertEquals(listOf("bin/run.sh"), a6.appliedFiles)
        assertEquals(listOf(ModeChange("bin/run.sh", "100644", "100755")), a6.modeChanges)
        val partial = CoreJson.decodeFromString(ApplyResult.serializer(), """{"applied":false,"abortReason":"x","partial":true}""")
        assertEquals(true, partial.partial)
    }

    // -----------------------------------------------------------------------
    // result copy
    // -----------------------------------------------------------------------

    @Test
    fun successNamesTheRepositoryAndSaysStagedNotCommitted() {
        val result = ApplyResult(
            applied = true,
            appliedFiles = listOf("a.kt", "bin/run.sh", "c.kt"),
            modeChanges = listOf(ModeChange("bin/run.sh", "100644", "100755")),
            snapshotTree = "c".repeat(40),
        )
        val shown = GitApplies.presentResult(result, repo, sent = 3)
        assertTrue(shown.body.startsWith("Applied 3 files to $repo (staged, not committed)"), shown.body)
        assertTrue(shown.body.contains("bin/run.sh 100644 → 100755"), shown.body)
        assertEquals(GitApplies.Severity.INFO, shown.severity)
        assertTrue(shown.mayHaveWritten)
        assertFalse(shown.body.contains("committed.") && !shown.body.contains("not committed"))
    }

    @Test
    fun partialIsAWarningThatQuotesCoreExactlyAndIsNeverSuccess() {
        val reason = "the write failed after git's checks passed; some files may have been written or staged " +
            "— check `git status` in $repo; `.git/index.lock` may remain — remove it only after checking " +
            "that no git process is running"
        val result = ApplyResult(applied = false, abortReason = reason, appliedFiles = listOf("a.kt", "b.kt"), partial = true)
        val shown = GitApplies.presentResult(result, repo, sent = 2)
        assertEquals(GitApplies.Severity.WARNING, shown.severity)
        assertTrue(shown.body.contains(reason), "Core's whole reason, uncut: ${shown.body}")
        assertTrue(shown.body.contains("may have been written"), shown.body)
        assertTrue(shown.body.contains("a.kt") && shown.body.contains("b.kt"), shown.body)
        for (claim in listOf("Applied ", "nothing was written", "succeeded")) {
            assertFalse(shown.title.contains(claim) || shown.body.startsWith(claim), "partial must not read as '$claim': $shown")
        }
        assertTrue(shown.mayHaveWritten)
        // W-B: an unverifiable result is a partial as well.
        val unverified = GitApplies.presentResult(
            ApplyResult(applied = false, abortReason = "could not verify the staged content — check `git status` in $repo", partial = true),
            repo,
            sent = 1,
        )
        assertEquals(GitApplies.Severity.WARNING, unverified.severity)
        assertTrue(unverified.body.contains("could not verify the staged content"), unverified.body)
    }

    @Test
    fun anAbortSaysNothingWasWrittenAndListsConflicts() {
        val result = ApplyResult(applied = false, abortReason = GitApplies.MSG_CHECK_FAILED, conflictedFiles = listOf("src/a.kt", "x\ny.kt"))
        val shown = GitApplies.presentResult(result, repo, sent = 2)
        assertTrue(shown.title.contains("nothing was written"), shown.title)
        assertTrue(shown.body.contains("does not apply cleanly"), shown.body)
        assertTrue(shown.body.contains("src/a.kt") && shown.body.contains("x\\ny.kt"), "conflicts listed, revealed: ${shown.body}")
        assertFalse(shown.mayHaveWritten)
        assertFalse(shown.offerReviewAgain)
    }

    /** Review J-I1: both "git apply was not started" texts are non-partial and say nothing was written. */
    @Test
    fun aWriteThatNeverStartedSaysNothingWasWritten() {
        for (reason in listOf(GitApplies.MSG_WRITE_NOT_RUN, GitApplies.MSG_WRITE_TOO_LATE)) {
            val shown = GitApplies.presentResult(ApplyResult(applied = false, abortReason = reason), repo, 2)
            assertTrue(shown.title.contains("nothing was written"), shown.title)
            assertTrue(shown.body.contains("git apply was never started"), shown.body)
            assertTrue(shown.body.contains(reason), "Core's text stays visible: ${shown.body}")
            assertEquals(GitApplies.Severity.WARNING, shown.severity)
            assertFalse(shown.mayHaveWritten)
            assertFalse(shown.body.contains("may have been written"), shown.body)
        }
    }

    @Test
    fun aCheckThatCouldNotRunIsNeverWordedAsAConflict() {
        val shown = GitApplies.presentResult(ApplyResult(applied = false, abortReason = GitApplies.MSG_CHECK_UNAVAILABLE), repo, sent = 1)
        assertTrue(shown.body.contains(GitApplies.MSG_CHECK_UNAVAILABLE), shown.body)
        assertFalse(shown.body.contains("does not apply cleanly"), shown.body)
        assertFalse(shown.title.contains("conflict", ignoreCase = true), shown.title)
    }

    @Test
    fun staleReviewAbortsOfferReviewAgain() {
        val notReviewed = GitApplies.presentResult(ApplyResult(applied = false, abortReason = GitApplies.MSG_ENTRIES_NOT_REVIEWED), repo, 1)
        assertTrue(notReviewed.offerReviewAgain)
        assertTrue(notReviewed.body.contains("review again", ignoreCase = true), notReviewed.body)
        val changed = GitApplies.presentResult(
            ApplyResult(applied = false, abortReason = "\"src/a.kt\"" + GitApplies.CHANGED_SUFFIX),
            repo,
            1,
        )
        assertTrue(changed.offerReviewAgain)
        assertTrue(changed.body.contains("changed since you reviewed it"), changed.body)
        assertFalse(changed.mayHaveWritten)
    }

    @Test
    fun anUnknownReasonIsShownVerbatimRevealedAndCapped() {
        val hostile = "a future reason \u202Etxt.exe\nfake line " + "z".repeat(3000)
        val shown = GitApplies.presentResult(ApplyResult(applied = false, abortReason = hostile), repo, 1)
        assertFalse(shown.body.contains('\u202E'))
        assertTrue(shown.body.contains("\\u202E") && shown.body.contains("\\n"), shown.body.take(200))
        assertFalse(shown.body.contains("z".repeat(2001)), "capped")
        assertFalse(shown.title.contains("nothing was written"), "Core did not say so")
    }

    @Test
    fun noGitContextOverTheWireIsAnHonestAbort() {
        // The only apply answer reachable over the wire until A4b.
        val reason = "task has no Git context (repo binding + base_commit); nothing was written"
        val shown = GitApplies.presentResult(ApplyResult(applied = false, abortReason = reason), null, 1)
        assertTrue(shown.body.contains(reason), shown.body)
        assertTrue(shown.title.contains("nothing was written"), shown.title)
    }

    // -----------------------------------------------------------------------
    // errors
    // -----------------------------------------------------------------------

    private fun coreError(code: String, message: String) = CompletionException(CoreRpcException(code, message))

    @Test
    fun theWriterLockConflictIsRetryableLater() {
        val msg = "$repo is busy: git.apply:other holds its writer lock (a running writer task, another apply or " +
            "a worktree discard); nothing was written"
        val shown = GitApplies.presentFailure(coreError(CoreErrorCodes.CONFLICT, msg), repo)
        assertTrue(shown.body.contains("busy"), shown.body)
        assertTrue(shown.body.contains("after that operation finishes"), shown.body)
        assertTrue(shown.body.contains("Nothing was written"), shown.body)
        assertFalse(shown.body.contains("stop or remove", ignoreCase = true), shown.body)
        assertFalse(shown.mayHaveWritten)
    }

    @Test
    fun theDirectMountConflictSaysStopOrRemoveFirstNotTryAgain() {
        val msg = "sandbox \"atlas-demo-1\"" + GitApplies.MOUNTED_SUFFIX
        val shown = GitApplies.presentFailure(coreError(CoreErrorCodes.CONFLICT, msg), repo)
        assertTrue(shown.body.contains("Stop or remove that sandbox or task first"), shown.body)
        assertTrue(shown.body.contains("atlas-demo-1"), shown.body)
        assertFalse(shown.body.contains("try again", ignoreCase = true), shown.body)
        assertFalse(shown.body.contains("after that operation finishes"), shown.body)
        val task = GitApplies.presentFailure(coreError(CoreErrorCodes.CONFLICT, "direct_mount task t-9" + GitApplies.MOUNTED_SUFFIX), repo)
        assertTrue(task.body.contains("Stop or remove that sandbox or task first"), task.body)
    }

    /** W-N1: the third CONFLICT text — a direct_mount sandbox of the repository is being created. */
    @Test
    fun aMountBeingCreatedIsNeitherTheBusyLockNorTryAgain() {
        val msg = "$repo is busy: sandbox \"atlas-demo-2\"" + GitApplies.MOUNT_BEING_CREATED_SUFFIX
        val shown = GitApplies.presentFailure(coreError(CoreErrorCodes.CONFLICT, msg), repo)
        assertTrue(shown.title.contains("being created"), shown.title)
        assertTrue(shown.body.contains("stop or remove it"), shown.body)
        assertTrue(shown.body.contains("atlas-demo-2"), shown.body)
        assertFalse(shown.body.contains("after that operation finishes"), shown.body)
        assertFalse(shown.body.contains("try again", ignoreCase = true), shown.body)
        assertFalse(shown.mayHaveWritten)
    }

    @Test
    fun aTimeoutIsALostAnswerNeverNothingChanged() {
        val shown = GitApplies.presentFailure(CompletionException(TimeoutException()), repo)
        assertEquals(
            "Core did not answer in time — the apply may have been applied; check `git status` in $repo before retrying",
            shown.body,
        )
        assertTrue(shown.mayHaveWritten)
        assertFalse(shown.body.contains("nothing", ignoreCase = true), shown.body)
        assertEquals(GitApplies.timeoutCopy(repo), shown.body)
    }

    @Test
    fun aDroppedConnectionOrAnUnreadableAnswerIsAlsoALostAnswer() {
        for (lost in listOf<Throwable>(
            CoreTransportException("connection closed: EOF"),
            SerializationException("{\"applied\": 7, \"secret\": \"payload\"}"),
            CoreRpcException("INTERNAL", "Core returned neither ok nor err", raisedByCore = false),
        )) {
            val shown = GitApplies.presentFailure(CompletionException(lost), repo)
            assertTrue(shown.body.contains("may have been applied"), shown.body)
            assertTrue(shown.body.contains("check `git status` in $repo before retrying"), shown.body)
            assertFalse(shown.body.contains("payload"), "an undecodable answer is never echoed: ${shown.body}")
            assertTrue(shown.mayHaveWritten)
            assertTrue(shown.sentToCore, "the frame may have reached Core, so the used review is discarded")
        }
    }

    @Test
    fun malformedRequestRefusalsAndNotFoundAreCoresWords() {
        for (msg in listOf(GitApplies.MSG_NEEDS_REVIEW, GitApplies.MSG_SELECTED_FILES, GitApplies.MSG_TOO_MANY_ENTRIES)) {
            val shown = GitApplies.presentFailure(coreError(CoreErrorCodes.VALIDATION_FAILED, msg), repo)
            assertTrue(shown.body.contains(msg), shown.body)
            assertFalse(shown.mayHaveWritten)
        }
        val missing = GitApplies.presentFailure(coreError(CoreErrorCodes.NOT_FOUND, "task not found"), repo)
        assertTrue(missing.body.contains("no task with this id"), missing.body)
        // INTERNAL after git ran: never "nothing was written" unless Core says so.
        val internal = GitApplies.presentFailure(
            coreError(CoreErrorCodes.INTERNAL, "git ran, but Core could not record the outcome (disk full) — check `git status` in $repo"),
            repo,
        )
        assertTrue(internal.mayHaveWritten)
        assertFalse(internal.body.contains("nothing was written", ignoreCase = true), internal.body)
    }

    // -----------------------------------------------------------------------
    // single flight + events
    // -----------------------------------------------------------------------

    @Test
    fun applyIsSingleFlightPerTask() {
        assertTrue(ApplyInFlight.begin("t-sf"))
        assertFalse(ApplyInFlight.begin("t-sf"), "a second apply for the same task is refused while one runs")
        assertTrue(ApplyInFlight.isActive("t-sf"))
        assertTrue(ApplyInFlight.begin("t-other"))
        ApplyInFlight.end("t-sf")
        ApplyInFlight.end("t-other")
        assertFalse(ApplyInFlight.isActive("t-sf"))
        assertTrue(ApplyInFlight.begin("t-sf"))
        ApplyInFlight.end("t-sf")
    }

    @Test
    fun theFourApplyEventsAreDescribedHonestly() {
        fun note(kind: String, payload: JsonElement) = GitApplies.eventNote(kind, payload)!!
        val started = note(CoreEventKinds.GIT_APPLY_STARTED, buildJsonObject { put("files", JsonArray(listOf(JsonPrimitive("a"), JsonPrimitive("b")))) })
        assertTrue(started.contains("2 file(s)"), started)
        val applied = note(CoreEventKinds.GIT_APPLIED, buildJsonObject { put("startedSequence", 4); put("files", JsonArray(listOf(JsonPrimitive("a")))) })
        assertTrue(applied.contains("staged, not committed"), applied)
        val partial = note(
            CoreEventKinds.GIT_APPLY_FAILED,
            buildJsonObject { put("startedSequence", 4); put("partial", true); put("reason", "the write failed \u202E") },
        )
        assertTrue(partial.contains("may have been written"), partial)
        assertTrue(partial.contains("\\u202E") && !partial.contains('\u202E'), partial)
        val failed = note(CoreEventKinds.GIT_APPLY_FAILED, buildJsonObject { put("partial", false); put("reason", "git apply was not started") })
        assertFalse(failed.contains("may have been written"), failed)
        val reconciled = note(CoreEventKinds.GIT_APPLY_RECONCILED, buildJsonObject { put("outcome", "unknown"); put("startedSequence", 4) })
        assertTrue(reconciled.contains("restarted"), reconciled)
        assertTrue(reconciled.contains("check `git status`"), reconciled)
        assertTrue(reconciled.contains("'unknown'"), reconciled)
        // An unreadable payload is said to be unreadable and never echoed.
        val odd = note(CoreEventKinds.GIT_APPLIED, JsonPrimitive("secret-payload"))
        assertFalse(odd.contains("secret-payload"), odd)
        assertTrue(odd.contains("unreadable"), odd)
        assertNull(GitApplies.eventNote(CoreEventKinds.STATUS_CHANGED, buildJsonObject { }))
        // The stream renders them as Core lifecycle kinds with that note, not as "unrecognized".
        val rendered = labs.dkv.sandpane.model.TaskEvent(taskId, 5, CoreEventKinds.GIT_APPLIED, buildJsonObject { put("files", JsonArray(emptyList())) }, "t")
            .toRenderedEvent()
        assertTrue(rendered.note!!.contains("staged, not committed"), rendered.note)
    }
}
