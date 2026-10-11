package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.Project
import labs.dkv.sandpane.model.ProjectDeleteParams
import labs.dkv.sandpane.model.RpcRequest
import labs.dkv.sandpane.ui.ProjectDeleteConfirmation
import labs.dkv.sandpane.ui.ProjectEdits
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
 * A3a (project lifecycle). The unit under test is the REAL [CoreCommands] / [ProjectDeleteCheck] /
 * [ProjectDeleteFlow] / [ProjectOutcomes] / [ProjectGuards] / [ProjectUiState]; only the socket is
 * replaced, so [ProjectRpc.sent] is exactly what would go on the wire.
 */
private class ProjectRpc(vararg replies: () -> CompletableFuture<JsonElement>) : CoreRpc {
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

private fun capsOf(methods: List<String>) = CoreCapabilities(
    protocolVersion = 1,
    coreVersion = "0.1.0",
    instanceId = "i",
    platform = "macos",
    methods = methods,
)

/** Inline UI: no EDT in unit tests; records each dialog shown and answers [yes]. */
private class DeleteUi(private val yes: Boolean) : ProjectDeleteFlow.Ui {
    val shown = ArrayList<IssuedProjectDelete>()
    override fun onUiThread(block: () -> Unit) = block()
    override fun confirm(issued: IssuedProjectDelete): Boolean {
        shown += issued
        return yes
    }
}

class ProjectLifecycleTest {

    private val id = "3f1c2a9e-0000-4000-8000-00000000a71a"
    private val token = "fedcba9876543210".repeat(4)
    private val future = "2999-01-01T00:00:00Z"
    private val projectJson =
        """{"id":"$id","name":"Atlas Demo","description":"","createdAt":"2026-10-01T00:00:00Z","repositories":["/work/atlas"]}"""

    private fun commands(rpc: CoreRpc, methods: List<String> = CoreMethods.ALL) = CoreCommands(rpc) { capsOf(methods) }

    private fun frame(method: String, params: JsonObject): String =
        CoreJson.encodeToString(RpcRequest.serializer(), RpcRequest(id = "t-1", method = method, params = params))

    private fun sentFrame(rpc: ProjectRpc, index: Int = 0): String = frame(rpc.sent[index].first, rpc.sent[index].second)

    private fun step1Json(
        action: String = "project.delete",
        targetId: String = id,
        targetName: String = "Atlas Demo",
        tok: String = token,
        expiresAt: String = future,
        external: Boolean = false,
        impact: List<String> = listOf("deletes 2 conversation(s)"),
        extra: String = "",
    ): String {
        val lines = impact.joinToString(",") { CoreJson.encodeToString(String.serializer(), it) }
        return """{"confirmation":{"token":"$tok","expiresAt":"$expiresAt","action":"$action",""" +
            """"target":{"name":${CoreJson.encodeToString(String.serializer(), targetName)},"id":"$targetId"},""" +
            """"impact":[$lines],"external":$external}$extra}"""
    }

    private fun project(archivedAt: String? = null, repositories: List<String> = listOf("/work/atlas")) =
        Project(id = id, name = "Atlas Demo", createdAt = "2026-10-01T00:00:00Z", repositories = repositories, archivedAt = archivedAt)

    // -----------------------------------------------------------------------
    // exact frames
    // -----------------------------------------------------------------------

    @Test
    fun listSendsAnEmptyObjectAndIncludeArchivedOnlyWhenAsked() {
        val rpc = ProjectRpc(answer("[$projectJson]"), answer("[]"))
        val live = commands(rpc).projectList().get()
        commands(rpc).projectList(includeArchived = true).get()
        assertEquals("""{"v":1,"id":"t-1","method":"project.list","params":{}}""", sentFrame(rpc, 0))
        assertEquals("""{"v":1,"id":"t-1","method":"project.list","params":{"includeArchived":true}}""", sentFrame(rpc, 1))
        assertNull(live.single().archivedAt, "archivedAt is absent-tolerant: missing means live")
        assertFalse(live.single().isArchived)
    }

    @Test
    fun includeArchivedIsNeverSentToACoreThatWouldIgnoreIt() {
        val rpc = ProjectRpc()
        val preA3a = CoreMethods.ALL - CoreMethods.ADDITIVE_A3A
        val error = assertFailsWith<ExecutionException> { commands(rpc, preA3a).projectList(includeArchived = true).get() }
        assertIs<MethodNotSupportedException>(error.cause)
        assertTrue(rpc.sent.isEmpty(), "nothing may reach a Core that would silently list live projects only")
    }

    @Test
    fun updateSendsOnlyTheGivenFieldsAndAnEmptyDescriptionClearsIt() {
        val rpc = ProjectRpc(answer(projectJson), answer(projectJson), answer(projectJson))
        val c = commands(rpc)
        c.projectUpdate(id, "Nova Demo", null).get()
        c.projectUpdate(id, null, "").get()
        c.projectUpdate(id, "Orbit Demo", "line one\nline two").get()
        assertEquals("""{"v":1,"id":"t-1","method":"project.update","params":{"projectId":"$id","name":"Nova Demo"}}""", sentFrame(rpc, 0))
        assertEquals("""{"v":1,"id":"t-1","method":"project.update","params":{"projectId":"$id","description":""}}""", sentFrame(rpc, 1))
        assertEquals(
            """{"v":1,"id":"t-1","method":"project.update","params":{"projectId":"$id","name":"Orbit Demo","description":"line one\nline two"}}""",
            sentFrame(rpc, 2),
        )
    }

    @Test
    fun updateWithNothingOrAnInvalidValueSendsNothing() {
        val rpc = ProjectRpc()
        val c = commands(rpc)
        for (call in listOf(
            { c.projectUpdate(id, null, null) },
            { c.projectUpdate(id, "", null) },
            { c.projectUpdate(id, "a\nb", null) },
            { c.projectUpdate(id, null, "a\tb") },
            { c.projectUpdate("", "Atlas Demo", null) },
        )) {
            val error = assertFailsWith<ExecutionException> { call().get() }
            assertIs<CoreValidationException>(error.cause)
        }
        assertTrue(rpc.sent.isEmpty())
    }

    @Test
    fun archiveAndUnarchiveSendTheProjectIdOnly() {
        val rpc = ProjectRpc(answer(projectJson.replace("}", ""","archivedAt":"2026-10-10T00:00:00Z"}""")), answer(projectJson))
        val archived = commands(rpc).projectArchive(id).get()
        commands(rpc).projectUnarchive(id).get()
        assertEquals("""{"v":1,"id":"t-1","method":"project.archive","params":{"projectId":"$id"}}""", sentFrame(rpc, 0))
        assertEquals("""{"v":1,"id":"t-1","method":"project.unarchive","params":{"projectId":"$id"}}""", sentFrame(rpc, 1))
        assertEquals("2026-10-10T00:00:00Z", archived.archivedAt)
        assertTrue(archived.isArchived)
    }

    @Test
    fun repositoryMethodsSendProjectIdAndAbsolutePath() {
        val rpc = ProjectRpc(answer(projectJson), answer(projectJson))
        commands(rpc).projectAddRepository(id, "/work/nova").get()
        commands(rpc).projectRemoveRepository(id, "/work/atlas").get()
        assertEquals(
            """{"v":1,"id":"t-1","method":"project.add_repository","params":{"projectId":"$id","path":"/work/nova"}}""",
            sentFrame(rpc, 0),
        )
        assertEquals(
            """{"v":1,"id":"t-1","method":"project.remove_repository","params":{"projectId":"$id","path":"/work/atlas"}}""",
            sentFrame(rpc, 1),
        )
    }

    @Test
    fun relativeOrNulRepositoryPathsAreRefusedLocally() {
        val rpc = ProjectRpc()
        val c = commands(rpc)
        for (path in listOf("", "work/atlas", "./atlas", "/work/a\u0000b")) {
            assertIs<CoreValidationException>(assertFailsWith<ExecutionException> { c.projectAddRepository(id, path).get() }.cause)
            assertIs<CoreValidationException>(assertFailsWith<ExecutionException> { c.projectRemoveRepository(id, path).get() }.cause)
        }
        assertTrue(rpc.sent.isEmpty())
    }

    // -----------------------------------------------------------------------
    // gating
    // -----------------------------------------------------------------------

    @Test
    fun everyA3aMethodIsRefusedLocallyWhenUnadvertised() {
        val rpc = ProjectRpc()
        val c = commands(rpc, CoreMethods.ALL - CoreMethods.ADDITIVE_A3A)
        val calls: List<Pair<String, () -> CompletableFuture<*>>> = listOf(
            CoreMethods.PROJECT_UPDATE to { c.projectUpdate(id, "Nova Demo", null) },
            CoreMethods.PROJECT_ARCHIVE to { c.projectArchive(id) },
            CoreMethods.PROJECT_UNARCHIVE to { c.projectUnarchive(id) },
            CoreMethods.PROJECT_DELETE to { c.projectDeleteRequest(id) },
            CoreMethods.PROJECT_ADD_REPOSITORY to { c.projectAddRepository(id, "/work/nova") },
            CoreMethods.PROJECT_REMOVE_REPOSITORY to { c.projectRemoveRepository(id, "/work/atlas") },
        )
        assertEquals(CoreMethods.ADDITIVE_A3A, calls.map { it.first }.toSet())
        for ((method, call) in calls) {
            val cause = assertFailsWith<ExecutionException> { call().get() }.cause
            assertIs<MethodNotSupportedException>(cause, method)
            assertEquals(method, cause.method)
            assertTrue(c.advertisementGap(method) != null)
        }
        assertTrue(rpc.sent.isEmpty(), "an unadvertised method never reaches the wire")
        // Not connected at all: also refused, with no list to consult.
        val offline = CoreCommands(rpc) { null }
        assertIs<MethodNotSupportedException>(assertFailsWith<ExecutionException> { offline.projectArchive(id).get() }.cause)
        assertTrue(rpc.sent.isEmpty())
    }

    // -----------------------------------------------------------------------
    // delete: both steps
    // -----------------------------------------------------------------------

    @Test
    fun deleteStepOneOmitsTheTokenKeyAndStepTwoCarriesIt() {
        val rpc = ProjectRpc(answer(step1Json()), answer("""{"deleted":true}"""))
        val ui = DeleteUi(yes = true)
        val outcome = ProjectDeleteFlow(commands(rpc), ui).run(id).get()
        assertIs<ProjectDeleteOutcome.Deleted>(outcome)
        assertTrue(outcome.confirmedDeleted)
        assertEquals(2, rpc.sent.size)
        assertEquals("""{"v":1,"id":"t-1","method":"project.delete","params":{"projectId":"$id"}}""", sentFrame(rpc, 0))
        assertEquals(
            """{"v":1,"id":"t-1","method":"project.delete","params":{"projectId":"$id","confirmToken":"$token"}}""",
            sentFrame(rpc, 1),
        )
        assertEquals(1, ui.shown.size)
        assertTrue(outcome.describe(rereadIncludesArchived = true).body.contains("deleted: true"))
    }

    @Test
    fun cancelSendsNothingAfterStepOne() {
        val rpc = ProjectRpc(answer(step1Json()))
        val outcome = ProjectDeleteFlow(commands(rpc), DeleteUi(yes = false)).run(id).get()
        assertIs<ProjectDeleteOutcome.Cancelled>(outcome)
        assertFalse(outcome.confirmedDeleted)
        assertEquals(1, rpc.sent.size, "Cancel must not send step 2")
        assertTrue(outcome.describe(true).body.contains("nothing was deleted"))
    }

    @Test
    fun aDialogThatThrowsIsNotAYes() {
        val rpc = ProjectRpc(answer(step1Json()))
        val ui = object : ProjectDeleteFlow.Ui {
            override fun onUiThread(block: () -> Unit) = block()
            override fun confirm(issued: IssuedProjectDelete): Boolean = error("dialog failed")
        }
        assertIs<ProjectDeleteOutcome.Cancelled>(ProjectDeleteFlow(commands(rpc), ui).run(id).get())
        assertEquals(1, rpc.sent.size)
    }

    @Test
    fun expiryIsRecheckedAtClickTimeAndAnExpiredTokenIsNeverSent() {
        val rpc = ProjectRpc(answer(step1Json(expiresAt = "2026-10-10T12:00:00Z")))
        val clock = { Instant.parse("2026-10-10T12:00:01Z") }
        val outcome = ProjectDeleteFlow(commands(rpc), DeleteUi(yes = true), clock).run(id).get()
        assertIs<ProjectDeleteOutcome.Expired>(outcome)
        assertEquals(1, rpc.sent.size, "an expired confirmation is not sent")
    }

    @Test
    fun anUnreadableExpiryFailsClosed() {
        val rpc = ProjectRpc(answer(step1Json(expiresAt = "soon")))
        val ui = DeleteUi(yes = true)
        val outcome = ProjectDeleteFlow(commands(rpc), ui).run(id).get()
        assertIs<ProjectDeleteOutcome.Refused>(outcome)
        assertTrue(outcome.reason.contains("cannot be used; run Delete Project again"), outcome.reason)
        assertEquals(1, rpc.sent.size, "step 2 is never sent")
        assertTrue(ui.shown.isEmpty())
        // Second net: an issued confirmation whose expiry cannot be read counts as expired.
        assertTrue(IssuedProjectDelete.of(id, "Atlas Demo", "soon", emptyList(), token).isExpired(Instant.EPOCH))
        assertFalse(IssuedProjectDelete.of(id, "Atlas Demo", future, emptyList(), token).isExpired(Instant.EPOCH))
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
        val ui = object : ProjectDeleteFlow.Ui {
            override fun onUiThread(block: () -> Unit) {
                inUi = true
                try { block() } finally { inUi = false }
            }
            override fun confirm(issued: IssuedProjectDelete) = true
        }
        val queued = ArrayList<() -> Unit>()
        val done = ProjectDeleteFlow(commands(rpc), ui, background = { queued += it }).run(id)
        assertEquals(listOf(false), sentInUi, "only step 1 so far: step 2 waits for the background")
        assertFalse(done.isDone)
        queued.forEach { it() }
        assertEquals(listOf(false, false), sentInUi, "step 2 was not written on the UI thread")
        assertIs<ProjectDeleteOutcome.Deleted>(done.get())
    }

    @Test
    fun aStepTwoThatCannotBeScheduledIsNotSent() {
        val rpc = ProjectRpc(answer(step1Json()))
        val outcome = ProjectDeleteFlow(commands(rpc), DeleteUi(yes = true), background = { error("pool shut down") }).run(id).get()
        assertIs<ProjectDeleteOutcome.Refused>(outcome)
        assertEquals(1, rpc.sent.size)
        assertTrue(outcome.describe(true).body.contains("nothing was deleted"))
    }

    @Test
    fun theWindowForgetsAProjectOnlyWhenCoreSaysItIsGone() {
        val notFound = CoreRpcException(CoreErrorCodes.NOT_FOUND, ProjectOutcomes.MSG_PROJECT_NOT_FOUND)
        val f = ProjectDeleteFollowUp
        assertEquals(ProjectDeleteFollowUp.Next.FORGET_AND_REREAD, f.next(ProjectDeleteOutcome.Deleted(id, "Atlas Demo")))
        assertEquals(ProjectDeleteFollowUp.Next.FORGET_AND_REREAD, f.next(ProjectDeleteOutcome.Step2Failed(id, ExecutionException(notFound))))
        assertEquals(ProjectDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE, f.next(ProjectDeleteOutcome.Step2Unconfirmed(id)))
        assertEquals(ProjectDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE, f.next(ProjectDeleteOutcome.Step2Failed(id, CoreTransportException("closed"))))
        assertEquals(ProjectDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE, f.next(ProjectDeleteOutcome.Step2Failed(id, TimeoutException())))
        assertEquals(ProjectDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE, f.next(null))
        // A NOT_FOUND this plugin raised over an unusable reply is not Core's word: unknown, not "gone".
        assertEquals(
            ProjectDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE,
            f.next(ProjectDeleteOutcome.Step2Failed(id, CoreRpcException(CoreErrorCodes.NOT_FOUND, "x", raisedByCore = false))),
        )
        for (known in listOf(
            ProjectDeleteOutcome.Cancelled(id), ProjectDeleteOutcome.Expired(id, future), ProjectDeleteOutcome.Refused(id, "x"),
            ProjectDeleteOutcome.Step1Failed(id, notFound),
            ProjectDeleteOutcome.Step2Failed(id, CoreRpcException(CoreErrorCodes.CONFLICT, ProjectOutcomes.MSG_PROJECT_HAS_TASKS)),
        )) {
            assertEquals(ProjectDeleteFollowUp.Next.REREAD, f.next(known), known.toString())
        }
        // Only Core's complete, successful list (archived included) that lacks the id counts as gone.
        assertTrue(f.goneAfterReread(id, emptyList(), archivedIncluded = true))
        assertFalse(f.goneAfterReread(id, listOf(project(archivedAt = "2026-10-10T00:00:00Z")), archivedIncluded = true))
        assertFalse(f.goneAfterReread(id, emptyList(), archivedIncluded = false), "a live-only list proves nothing")
        assertFalse(f.goneAfterReread(id, null, archivedIncluded = true), "a failed read proves nothing")
    }

    @Test
    fun longCoreLinesAreCappedInTheDialogAndTheChoosers() {
        val long = "x".repeat(500)
        assertEquals(labs.dkv.sandpane.text.DisplayCap.MAX_CODE_POINTS, 200)
        val capped = labs.dkv.sandpane.text.DisplayCap.cap(long)
        assertEquals("x".repeat(200) + "…", capped)
        assertEquals("short", labs.dkv.sandpane.text.DisplayCap.cap("short"))
        // Never splits a surrogate pair: 201 emoji → 200 whole emoji + the mark.
        val emoji = "\uD83D\uDE00"
        assertEquals(emoji.repeat(200) + "…", labs.dkv.sandpane.text.DisplayCap.cap(emoji.repeat(201)))

        val rpc = ProjectRpc(answer(step1Json(targetName = "N".repeat(400), impact = listOf(long))))
        val ui = DeleteUi(yes = false)
        ProjectDeleteFlow(commands(rpc), ui).run(id).get()
        val html = ProjectDeleteConfirmation.message(ui.shown.single()).build()
        assertTrue(html.contains("x".repeat(200) + "…"), "impact line capped")
        assertFalse(html.contains("x".repeat(201)))
        assertFalse(html.contains("N".repeat(201)), "name capped")

        val row = labs.dkv.sandpane.ui.ProjectChooserDialog.describe(project().copy(name = long))
        assertFalse(row.first.contains("x".repeat(201)), row.first)
        assertTrue(row.first.endsWith("…"))
        val repo = labs.dkv.sandpane.ui.RepositoryChooserDialog.describe("/" + long)
        assertTrue(repo.first.endsWith("…"))
        assertEquals(201, repo.first.codePointCount(0, repo.first.length))
    }

    @Test
    fun aRenameBetweenTheStepsIsFineAndTheDialogShowsCoresCurrentName() {
        val rpc = ProjectRpc(answer(step1Json(targetName = "Nova Demo")), answer("""{"deleted":true}"""))
        val ui = DeleteUi(yes = true)
        val outcome = ProjectDeleteFlow(commands(rpc), ui).run(id).get()
        assertIs<ProjectDeleteOutcome.Deleted>(outcome)
        assertEquals("Nova Demo", ui.shown.single().name)
    }

    @Test
    fun unusableStepOneAnswersAreRefusedAndStepTwoIsNotSent() {
        val bad = listOf(
            step1Json(action = "sandbox.remove"),
            step1Json(targetId = "another-project"),
            step1Json(tok = "short"),
            step1Json(tok = token.uppercase()),
            step1Json(external = true),
            step1Json(extra = ""","deleted":true"""),
            """{"deleted":true}""",
            """{}""",
        )
        for (json in bad) {
            val rpc = ProjectRpc(answer(json))
            val ui = DeleteUi(yes = true)
            val outcome = ProjectDeleteFlow(commands(rpc), ui).run(id).get()
            assertIs<ProjectDeleteOutcome.Refused>(outcome, json)
            assertEquals(1, rpc.sent.size, json)
            assertTrue(ui.shown.isEmpty(), "no dialog for an answer that was not understood: $json")
            assertFalse(outcome.describe(true).body.contains(token), "the token is never shown")
        }
    }

    @Test
    fun stepTwoWithoutDeletedTrueIsUnconfirmedNeverDeleted() {
        val rpc = ProjectRpc(answer(step1Json()), answer("""{"deleted":false}"""))
        val outcome = ProjectDeleteFlow(commands(rpc), DeleteUi(yes = true)).run(id).get()
        assertIs<ProjectDeleteOutcome.Step2Unconfirmed>(outcome)
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
            val rpc = ProjectRpc(answer(step1Json()), failWith(error))
            val outcome = ProjectDeleteFlow(commands(rpc), DeleteUi(yes = true)).run(id).get()
            assertIs<ProjectDeleteOutcome.Step2Failed>(outcome)
            assertEquals(2, rpc.sent.size, "never retried")
            assertTrue(ProjectOutcomes.isUnknown(outcome.error))
            val body = outcome.describe(rereadIncludesArchived = true).body
            assertTrue(body.contains("UNKNOWN"), body)
            assertFalse(body.contains("nothing was"), "an unknown outcome never claims nothing happened: $body")
        }
    }

    @Test
    fun stepTwoTokenRejectionSaysNothingWasDeleted() {
        val rejected = CoreRpcException(
            CoreErrorCodes.VALIDATION_FAILED,
            CoreRemoveRefusals.TOKEN_REJECTED_PREFIX + ", or bound to another target; nothing was changed",
        )
        val rpc = ProjectRpc(answer(step1Json()), failWith(rejected))
        val outcome = ProjectDeleteFlow(commands(rpc), DeleteUi(yes = true)).run(id).get()
        val body = outcome.describe(true).body
        assertTrue(body.contains("nothing was deleted"), body)
        assertFalse(ProjectOutcomes.isUnknown((outcome as ProjectDeleteOutcome.Step2Failed).error))
    }

    @Test
    fun aStepOneFailureIsNeverAnUnknownOutcome() {
        for (error in listOf<Throwable>(CoreTransportException("socket closed"), TimeoutException(), CoreRpcException(CoreErrorCodes.INTERNAL, "x"))) {
            val rpc = ProjectRpc(failWith(error))
            val outcome = ProjectDeleteFlow(commands(rpc), DeleteUi(yes = true)).run(id).get()
            assertIs<ProjectDeleteOutcome.Step1Failed>(outcome)
            val text = outcome.describe(true)
            assertTrue(text.body.contains("was not deleted"), text.body)
            assertFalse(text.body.contains("UNKNOWN"), text.body)
        }
        val rpc = ProjectRpc(failWith(CoreRpcException(CoreErrorCodes.CONFLICT, ProjectOutcomes.MSG_PROJECT_HAS_SANDBOXES)))
        val body = ProjectDeleteFlow(commands(rpc), DeleteUi(yes = true)).run(id).get().describe(true).body
        assertTrue(body.contains("remove them first"), body)
    }

    @Test
    fun theTokenNeverAppearsInAnyPrintableForm() {
        val rpc = ProjectRpc(answer(step1Json()))
        val ui = DeleteUi(yes = false)
        ProjectDeleteFlow(commands(rpc), ui).run(id).get()
        val issued = ui.shown.single()
        assertFalse(issued.toString().contains(token))
        assertFalse(ProjectDeleteParams(id, token).toString().contains(token))
        assertTrue(ProjectDeleteParams(id, token).toString().contains("<redacted>"))
        assertFalse(ProjectDeleteConfirmation.message(issued).build().contains(token))
    }

    @Test
    fun undecodableAnswersAreNeverEchoed() {
        val secret = "secret-payload-xyz"
        val rpc = ProjectRpc(
            answer("""{"name":{"x":"$secret"}}"""),
            answer("""{"confirmation":{"token":"$token","expiresAt":1,"x":"$secret"}}"""),
            answer("""[{"id":{"x":"$secret"}}]"""),
        )
        val c = commands(rpc)
        for (call in listOf({ c.projectArchive(id) }, { c.projectDeleteRequest(id) }, { c.projectList() })) {
            val cause = assertFailsWith<ExecutionException> { call().get() }.cause
            assertIs<CoreRpcException>(cause)
            assertFalse(cause.raisedByCore)
            assertFalse(cause.message.contains(secret), cause.message)
            assertFalse(cause.message.contains(token), cause.message)
        }
    }

    // -----------------------------------------------------------------------
    // honest copy for every exact Core message
    // -----------------------------------------------------------------------

    @Test
    fun everyExactCoreRefusalMapsToNothingWasCopy() {
        val cases = listOf(
            Triple(CoreMethods.PROJECT_UPDATE, CoreErrorCodes.VALIDATION_FAILED, ProjectOutcomes.MSG_PROJECT_ARCHIVED) to "nothing was changed",
            Triple(CoreMethods.PROJECT_ADD_REPOSITORY, CoreErrorCodes.VALIDATION_FAILED, ProjectOutcomes.MSG_PROJECT_ARCHIVED) to "nothing was added",
            Triple(CoreMethods.PROJECT_DELETE, CoreErrorCodes.CONFLICT, ProjectOutcomes.MSG_PROJECT_HAS_TASKS) to "nothing was deleted",
            Triple(CoreMethods.PROJECT_DELETE, CoreErrorCodes.CONFLICT, ProjectOutcomes.MSG_PROJECT_HAS_SANDBOXES) to "nothing was deleted",
            Triple(CoreMethods.PROJECT_DELETE, CoreErrorCodes.CONFLICT, ProjectOutcomes.MSG_PROJECT_CREATE_IN_FLIGHT) to "nothing was deleted",
            Triple(CoreMethods.PROJECT_REMOVE_REPOSITORY, CoreErrorCodes.CONFLICT, ProjectOutcomes.MSG_REPOSITORY_IN_USE) to "nothing was removed",
            Triple(CoreMethods.PROJECT_REMOVE_REPOSITORY, CoreErrorCodes.CONFLICT, ProjectOutcomes.MSG_REPOSITORY_REMOVE_WHILE_CREATING) to "nothing was removed",
            Triple(CoreMethods.SANDBOX_CREATE, CoreErrorCodes.CONFLICT, ProjectOutcomes.MSG_REPOSITORY_UNREGISTERED_DURING_CREATE) to "nothing was run",
            Triple(CoreMethods.PROJECT_ARCHIVE, CoreErrorCodes.NOT_FOUND, ProjectOutcomes.MSG_PROJECT_NOT_FOUND) to "nothing was changed",
            Triple(CoreMethods.PROJECT_REMOVE_REPOSITORY, CoreErrorCodes.NOT_FOUND, ProjectOutcomes.MSG_REPOSITORY_NOT_REGISTERED) to "nothing was removed",
            Triple(CoreMethods.PROJECT_UPDATE, CoreErrorCodes.VALIDATION_FAILED, ProjectOutcomes.MSG_UPDATE_NEEDS_A_FIELD) to "nothing was changed",
            // A7: Core refuses a delete while a verification runs for one of the project's tasks.
            Triple(CoreMethods.PROJECT_DELETE, CoreErrorCodes.CONFLICT, Verifications.MSG_PROJECT_VERIFICATION_RUNNING) to "nothing was deleted",
        )
        assertEquals(ProjectOutcomes.KNOWN_MESSAGES, cases.map { it.first.third }.toSet(), "every known message has a case")
        for ((case, expected) in cases) {
            val (method, code, message) = case
            val text = ProjectOutcomes.describeFailure(method, CoreRpcException(code, message), rereadIncludesArchived = true)
            assertTrue(text.title.contains("refused by Core"), text.title)
            assertTrue(text.body.contains(expected), "$message → ${text.body}")
            assertTrue(text.body.contains("Core said: $message"), "Core's own text is shown: ${text.body}")
            assertFalse(text.body.contains("UNKNOWN"))
            assertFalse(ProjectOutcomes.isUnknown(CoreRpcException(code, message)))
        }
    }

    @Test
    fun anUnlistedOrMismatchedRefusalMakesNoClaim() {
        val unlisted = listOf(
            CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, "repository path must be absolute: atlas"),
            CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, "project name: contains a disallowed character"),
            CoreRpcException("PERMISSION_DENIED", "/etc is a system tree"),
            // Exact text but under a code Core never uses for it: not trusted either.
            CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, ProjectOutcomes.MSG_PROJECT_HAS_TASKS),
            // A prefix match is not an exact match.
            CoreRpcException(CoreErrorCodes.NOT_FOUND, ProjectOutcomes.MSG_PROJECT_NOT_FOUND + ": extra"),
        )
        for (error in unlisted) {
            for (method in CoreMethods.ADDITIVE_A3A) {
                val text = ProjectOutcomes.describeFailure(method, error, rereadIncludesArchived = true)
                // Core's own text only — no plain copy, no "nothing was …" sentence of this client's.
                assertEquals("Core refused ${error.code}: ${KeyedWrites.coreText(error.message)}", text.body)
                assertEquals("Sandpane: $method refused by Core", text.title)
            }
        }
    }

    @Test
    fun internalTransportAndTimeoutAreUnknownAndTheRereadSentenceIsTrue() {
        val errors = listOf<Throwable>(
            CoreRpcException(CoreErrorCodes.INTERNAL, "boom"),
            CoreTransportException("closed"),
            TimeoutException(),
            CoreRpcException(CoreErrorCodes.INTERNAL, "bad frame", raisedByCore = false),
            IllegalStateException("decoder blew up with secret-xyz"),
        )
        for (error in errors) {
            assertTrue(ProjectOutcomes.isUnknown(error))
            val with = ProjectOutcomes.describeFailure(CoreMethods.PROJECT_ARCHIVE, error, rereadIncludesArchived = true)
            val without = ProjectOutcomes.describeFailure(CoreMethods.PROJECT_ARCHIVE, error, rereadIncludesArchived = false)
            assertTrue(with.body.contains("UNKNOWN"))
            assertTrue(with.body.contains("including archived projects"))
            assertFalse(without.body.contains("including archived"), without.body)
            assertFalse(with.body.contains("secret-xyz"), "an unexpected exception's text is never shown")
            assertFalse(with.body.contains("nothing was"))
        }
        // Local refusals are known: nothing was sent.
        assertFalse(ProjectOutcomes.isUnknown(CoreValidationException("name", "empty")))
        assertFalse(ProjectOutcomes.isUnknown(MethodNotSupportedException(CoreMethods.PROJECT_ARCHIVE, "not advertised")))
    }

    @Test
    fun successCopyUsesCoresAnswerRevealed() {
        val p = project(archivedAt = "2026-10-10T00:00:00Z").copy(name = "Atlas\u202EDemo")
        val text = ProjectOutcomes.describeSuccess(CoreMethods.PROJECT_ARCHIVE, p)
        assertTrue(text.body.contains("2026-10-10T00:00:00Z"))
        assertFalse(text.body.contains("\u202E"), "hidden characters are revealed, never passed through")
    }

    // -----------------------------------------------------------------------
    // validators vs Core's corpus (Validator::project_name / project_description)
    // -----------------------------------------------------------------------

    @Test
    fun nameValidatorAcceptsWhatCoreAccepts() {
        val accepted = listOf(
            "Atlas Demo", "a", "é".repeat(120), "😀".repeat(120), "Nova\u200BDemo", "   ", " Orbit Demo ",
            "漢字 — ü",
        )
        accepted.forEach { assertNull(ProjectGuards.nameProblem(it), "Core accepts '$it'") }
    }

    @Test
    fun nameValidatorRefusesWhatCoreRefuses() {
        val refused = listOf(
            "", "x".repeat(121), "😀".repeat(121), "a\nb", "a\tb", "a\rb", "a\u0000b", "a\u007Fb", "a\u0085b", "a\u009Bb",
            "a\u001B[31m", "a\u2028b", "a\u2029b", "a\u200Eb", "a\u200Fb", "a\u061Cb",
            "a\u202Ab", "a\u202Bb", "a\u202Cb", "a\u202Db", "a\u202Eb", "a\u2066b", "a\u2067b", "a\u2068b", "a\u2069b",
            "a\uD800b",
        )
        refused.forEach { assertTrue(ProjectGuards.nameProblem(it) != null, "Core refuses ${it.map { c -> "%04X".format(c.code) }}") }
        assertEquals(120, ProjectGuards.MAX_NAME_CHARS)
    }

    @Test
    fun descriptionValidatorMirrorsCore() {
        val accepted = listOf("", "line one\nline two — ü 漢字", "é".repeat(2000), "Nova\u200BDemo", "\n\n")
        accepted.forEach { assertNull(ProjectGuards.descriptionProblem(it), "Core accepts it") }
        val refused = listOf(
            "x".repeat(2001), "a\tb", "a\rb", "a\u0000b", "a\u007Fb", "a\u0085b", "a\u009Bb", "a\u001B[31m",
            "a\u2028b", "a\u2029b", "a\u200Eb", "a\u200Fb", "a\u061Cb", "a\u202Eb", "a\u2066b", "a\u2069b",
        )
        refused.forEach { assertTrue(ProjectGuards.descriptionProblem(it) != null, "Core refuses ${it.take(12).map { c -> "%04X".format(c.code) }}") }
        assertEquals(2000, ProjectGuards.MAX_DESCRIPTION_CHARS)
    }

    @Test
    fun editSendsOnlyChangedFieldsExactlyAsTyped() {
        assertTrue(ProjectEdits.changes("Atlas Demo", "old", "Atlas Demo", "old").isEmpty)
        assertEquals(ProjectEdits.Changes(" Atlas Demo ", null), ProjectEdits.changes("Atlas Demo", "old", " Atlas Demo ", "old"))
        assertEquals(ProjectEdits.Changes(null, ""), ProjectEdits.changes("Atlas Demo", "old", "Atlas Demo", ""))
    }

    @Test
    fun aDescriptionOnlyEditNeverRenamesAPreRuleNameTheFieldCannotShow() {
        // Core keeps names stored before the A3a rule; one may hold a newline. The edit field's own text
        // is the baseline, so whatever the field does to it, an untouched name is never sent.
        val stored = "Atlas\nDemo"
        val field = javax.swing.JTextField(stored)
        val shown = field.text
        val changes = ProjectEdits.changes(shown, "", shown, "new description")
        assertNull(changes.name, "the untouched name must not be sent (field shows '$shown')")
        assertEquals("new description", changes.description)
    }

    // -----------------------------------------------------------------------
    // archived UI state
    // -----------------------------------------------------------------------

    @Test
    fun anArchivedProjectAllowsOnlyUnarchiveAndDeleteWithCoresReason() {
        val archived = project(archivedAt = "2026-10-10T00:00:00Z")
        assertTrue(archived.isArchived)
        assertNull(ProjectUiState.blockedReason(archived, ProjectUiState.Action.UNARCHIVE))
        assertNull(ProjectUiState.blockedReason(archived, ProjectUiState.Action.DELETE))
        for (action in listOf(ProjectUiState.Action.EDIT, ProjectUiState.Action.ADD_REPOSITORY, ProjectUiState.Action.REMOVE_REPOSITORY)) {
            assertEquals(ProjectOutcomes.MSG_PROJECT_ARCHIVED, ProjectUiState.blockedReason(archived, action))
        }
        assertTrue(ProjectUiState.blockedReason(archived, ProjectUiState.Action.ARCHIVE) != null)
        assertEquals("Atlas Demo [archived]", ProjectUiState.label(archived))
    }

    @Test
    fun aLiveProjectCannotBeUnarchivedAndNeedsARepositoryToRemoveOne() {
        val live = project()
        assertEquals("Atlas Demo", ProjectUiState.label(live))
        assertTrue(ProjectUiState.blockedReason(live, ProjectUiState.Action.UNARCHIVE) != null)
        for (action in listOf(ProjectUiState.Action.EDIT, ProjectUiState.Action.ARCHIVE, ProjectUiState.Action.ADD_REPOSITORY,
            ProjectUiState.Action.REMOVE_REPOSITORY, ProjectUiState.Action.DELETE)) {
            assertNull(ProjectUiState.blockedReason(live, action), action.name)
        }
        assertTrue(ProjectUiState.blockedReason(project(repositories = emptyList()), ProjectUiState.Action.REMOVE_REPOSITORY) != null)
    }

    // -----------------------------------------------------------------------
    // the delete dialog
    // -----------------------------------------------------------------------

    @Test
    fun deleteDialogShowsNameIdExpiryAndAtMostTwentyRevealedImpactLines() {
        val impact = (1..25).map { "impact line $it" } + listOf("spoof\u202Eline")
        val rpc = ProjectRpc(answer(step1Json(targetName = "Atlas\u202EDemo", impact = impact)))
        val ui = DeleteUi(yes = false)
        ProjectDeleteFlow(commands(rpc), ui).run(id).get()
        val html = ProjectDeleteConfirmation.message(ui.shown.single()).build()
        assertTrue(html.contains(id), "the project id is shown")
        assertTrue(html.contains(future), "the expiry is shown")
        assertTrue(html.contains("impact line 20"))
        assertFalse(html.contains("impact line 21"), "capped at ${ProjectDeleteConfirmation.MAX_IMPACT_LINES}")
        assertTrue(html.contains("6 more impact line(s) not shown"))
        assertFalse(html.contains("\u202E"), "Core text is revealed, never passed through")
        assertFalse(html.contains(token))
        assertFalse(html.contains("NOT CONFIRMED AS CREATED BY SANDPANE"), "no external banner for a project")
        assertEquals(20, ProjectDeleteConfirmation.MAX_IMPACT_LINES)
    }

    @Test
    fun showArchivedIsAViewSettingThatDefaultsOffAndSurvivesLoading() {
        val fresh = labs.dkv.sandpane.settings.SandpaneSettings()
        assertFalse(fresh.showArchivedProjects, "archived projects are hidden unless asked for")
        val loaded = labs.dkv.sandpane.settings.SandpaneSettings().apply {
            loadState(labs.dkv.sandpane.settings.SandpaneSettings.State().apply { showArchivedProjects = true })
        }
        assertTrue(loaded.showArchivedProjects)
        // The persisted state holds UI settings only: no project id field exists to leak after a delete.
        val fields = labs.dkv.sandpane.settings.SandpaneSettings.State::class.java.declaredFields.map { it.name }
        assertFalse(fields.any { it.contains("project", ignoreCase = true) && it != "showArchivedProjects" }, fields.toString())
    }

    @Test
    fun addRepositoryWaitsLongerThanCoresGitQuery() {
        assertEquals(
            MethodDeadlines.PROJECT_ADD_REPOSITORY_MS,
            MethodDeadlines.forMethod(CoreMethods.PROJECT_ADD_REPOSITORY, 15_000),
        )
        assertEquals(15_000, MethodDeadlines.forMethod(CoreMethods.PROJECT_UPDATE, 15_000))
        assertEquals(90_000, MethodDeadlines.forMethod(CoreMethods.PROJECT_ADD_REPOSITORY, 90_000), "a larger setting wins")
    }
}
