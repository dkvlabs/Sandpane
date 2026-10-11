// Typed request wrappers for the Core RPC surface, with the protocol-v1 read methods.
//
// Design rules this file obeys:
//   * NOTHING is sent that the guards in [CoreGuards] refuse — an invalid id, limit or cursor
//     map never reaches the socket, and the returned future fails with [CoreValidationException],
//     which is this client's word, never a Core verdict (AGENTS.md rule 5).
//   * The additive methods (the three v1 reads, the A1 sandbox lifecycle, the A3a project
//     lifecycle and the A3b conversation lifecycle) are gated on
//     ADVERTISEMENT (`CoreCapabilities.methods`), not on a version number: `protocolVersion` stayed
//     1 across these revisions, so assuming a method from it would send a request an older Core
//     answers with VALIDATION_FAILED.
//   * Every call returns a CompletableFuture and performs no Swing work; the caller owns the
//     EDT hop (docs/specs/04 §2).
package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.model.ConversationDeleteParams
import labs.dkv.sandpane.model.ConversationDeleteResult
import labs.dkv.sandpane.model.ConversationExportParams
import labs.dkv.sandpane.model.ConversationExportResult
import labs.dkv.sandpane.model.ConversationHistoryParams
import labs.dkv.sandpane.model.ConversationHistoryResult
import labs.dkv.sandpane.model.ConversationIdParams
import labs.dkv.sandpane.model.ConversationListParams
import labs.dkv.sandpane.model.ConversationRenameParams
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.Project
import labs.dkv.sandpane.model.ProjectDeleteParams
import labs.dkv.sandpane.model.ProjectDeleteResult
import labs.dkv.sandpane.model.ProjectIdParams
import labs.dkv.sandpane.model.ProjectListParams
import labs.dkv.sandpane.model.ProjectRepositoryParams
import labs.dkv.sandpane.model.ProjectUpdateParams
import labs.dkv.sandpane.model.SandboxRemoveParams
import labs.dkv.sandpane.model.SandboxRemoveResult
import labs.dkv.sandpane.model.SandboxStopParams
import labs.dkv.sandpane.model.SandboxStopResult
import labs.dkv.sandpane.model.TaskEvent
import labs.dkv.sandpane.model.TaskListParams
import labs.dkv.sandpane.model.TaskStatus
import labs.dkv.sandpane.model.TaskSubscribeParams
import labs.dkv.sandpane.model.TaskSummary
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.concurrent.CompletableFuture

/** The minimum transport a [CoreCommands] needs; [ConnectionManager] satisfies it. */
fun interface CoreRpc {
    fun request(method: String, params: JsonElement): CompletableFuture<JsonElement>
}

/**
 * Typed wrappers over [CoreRpc].
 *
 * @param rpc the transport (background-only; never call from the EDT — see
 *   [CoreClient.assertNotEdt]).
 * @param capabilities the live `system.probe` answer, or null when not Ready. Read per call so a
 *   reconnect that lands on a different Core build is reflected immediately.
 */
class CoreCommands(
    private val rpc: CoreRpc,
    private val capabilities: () -> CoreCapabilities?,
) {

    // -----------------------------------------------------------------------
    // feature discovery
    // -----------------------------------------------------------------------

    /** Does the connected Core advertise [method]? Absence of the list means "nothing added". */
    fun advertises(method: String): Boolean = capabilities()?.advertises(method) == true

    /**
     * The advertisement gap for an additive method, or null when it may be called.
     *
     * Refusing locally keeps a pre-revision Core from answering for a surface it never promised,
     * and keeps the refusal out of the wire entirely. The eleven original methods need no gate —
     * they are the protocol-v1 baseline every Core dispatches; everything in
     * [CoreMethods.REQUIRES_ADVERTISEMENT] (the discovery reads, the A1 sandbox lifecycle, the A3a
     * project lifecycle and the A3b conversation lifecycle) does.
     */
    fun advertisementGap(method: String): MethodNotSupportedException? {
        if (!CoreMethods.REQUIRES_ADVERTISEMENT.contains(method)) return null
        val caps = capabilities()
            ?: return MethodNotSupportedException(
                method,
                "this plugin is not connected to Core, so no advertised method list is known yet",
            )
        if (caps.advertises(method)) return null
        return MethodNotSupportedException(
            method,
            "its system.probe does not list it (Core ${caps.coreVersion} speaks protocol " +
                "v${caps.protocolVersion}, which predates this method). Nothing was sent.",
        )
    }

    // -----------------------------------------------------------------------
    // task.list — read-only hydration
    // -----------------------------------------------------------------------

    /**
     * `task.list` → Core's own task rows. Display/hydration only: statuses arrive as stored and
     * nothing here advances or repairs a lifecycle state (AGENTS.md rule 3).
     */
    fun taskList(params: TaskListParams = TaskListParams()): CompletableFuture<List<TaskSummary>> {
        advertisementGap(CoreMethods.TASK_LIST)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            buildJsonObject {
                CoreGuards.optionalScopingId(params.projectId, "projectId")?.let { put("projectId", it) }
                val statuses = CoreGuards.dedupeStatuses(params.statuses)
                if (statuses.isNotEmpty()) {
                    // Encoded through the enum's own serializer, so a status string can never be
                    // invented here — it is the @SerialName Core itself defines.
                    put(
                        "statuses",
                        JsonArray(statuses.map { CoreJson.encodeToJsonElement(TaskStatus.serializer(), it) }),
                    )
                }
                params.limit?.let { put("limit", CoreGuards.clampLimit(it)) }
            }
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.TASK_LIST, payload)
            .thenApply { ok ->
                // Review I3: a row that does not decode is never echoed (kotlinx quotes the input).
                decodeOrFixed(CoreMethods.TASK_LIST) { CoreJson.decodeFromJsonElement(ListSerializer(TaskSummary.serializer()), ok) }
            }
    }

    // -----------------------------------------------------------------------
    // conversation.list / conversation.history
    // -----------------------------------------------------------------------

    /**
     * `conversation.list` → Core's conversations for the scope. Live ones only unless
     * [ConversationListParams.includeArchived] is true — which is sent ONLY when Core advertises
     * `conversation.archive` (A3b): a pre-A3b Core silently ignores the flag, so sending it there would
     * present a live-only list as "including archived". Without it the frame is unchanged.
     */
    fun conversationList(
        params: ConversationListParams = ConversationListParams(),
    ): CompletableFuture<List<Conversation>> {
        advertisementGap(CoreMethods.CONVERSATION_LIST)?.let { return CompletableFuture.failedFuture(it) }
        if (params.includeArchived == true) {
            advertisementGap(CoreMethods.CONVERSATION_ARCHIVE)?.let {
                return CompletableFuture.failedFuture(
                    MethodNotSupportedException(
                        CoreMethods.CONVERSATION_LIST,
                        "listing archived conversations needs ${CoreMethods.CONVERSATION_ARCHIVE}, which this Core does not advertise. Nothing was sent.",
                    ),
                )
            }
        }
        val payload = try {
            buildJsonObject {
                CoreGuards.optionalScopingId(params.projectId, "projectId")?.let { put("projectId", it) }
                params.limit?.let { put("limit", CoreGuards.clampLimit(it)) }
                // Never `false` on the wire: absent already means live-only.
                if (params.includeArchived == true) put("includeArchived", true)
            }
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.CONVERSATION_LIST, payload)
            .thenApply { CoreJson.decodeFromJsonElement(ListSerializer(Conversation.serializer()), it) }
    }

    /**
     * `conversation.history` → one bounded page plus its disclosure flags.
     *
     * The result is an OBJECT (`messages` / `truncated` / `nextSequence`), never a bare array: a
     * page that stopped early must say so and hand back the cursor that continues it. An unknown
     * conversation is Core's `NOT_FOUND` — surfaced as a failed future, not turned into an empty list
     * that reads as "no messages". Since A3b Core also serves ARCHIVED conversations here.
     */
    fun conversationHistory(
        params: ConversationHistoryParams,
    ): CompletableFuture<ConversationHistoryResult> {
        advertisementGap(CoreMethods.CONVERSATION_HISTORY)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            buildJsonObject {
                put("conversationId", CoreGuards.requireId(params.conversationId, "conversationId"))
                // Core normalises a negative cursor to 0; doing the same here keeps the value we
                // send and the value Core acts on identical.
                put("afterSequence", params.afterSequence.coerceAtLeast(0L))
                params.limit?.let { put("limit", CoreGuards.clampLimit(it)) }
            }
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.CONVERSATION_HISTORY, payload)
            .thenApply { CoreJson.decodeFromJsonElement(ConversationHistoryResult.serializer(), it) }
    }

    // -----------------------------------------------------------------------
    // sandbox.stop / sandbox.remove (A1)
    // -----------------------------------------------------------------------

    /**
     * `sandbox.stop {name}` → [SandboxStopResult]. Not destructive, so no token; feature-detected,
     * name-guarded, and never retried (the caller words a missing answer as "outcome unknown").
     */
    fun sandboxStop(name: String): CompletableFuture<SandboxStopResult> {
        advertisementGap(CoreMethods.SANDBOX_STOP)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            buildStopPayload(name)
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.SANDBOX_STOP, payload)
            .thenApply { CoreJson.decodeFromJsonElement(SandboxStopResult.serializer(), it) }
    }

    /**
     * Step 1 of `sandbox.remove`: `{name}` with NO `confirmToken` key at all. Core changes nothing
     * and answers a confirmation; the caller must pass it through [RemoveConfirmationCheck.decide]
     * before anything else happens.
     */
    fun sandboxRemoveRequest(name: String): CompletableFuture<SandboxRemoveResult> {
        advertisementGap(CoreMethods.SANDBOX_REMOVE)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            buildRemovePayload(name, token = null)
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.SANDBOX_REMOVE, payload).thenApply(::decodeRemoveAnswer)
    }

    /**
     * Step 2 of `sandbox.remove`: the same name plus the token Core issued at step 1. It takes an
     * [IssuedRemoval] — which only [RemoveConfirmationCheck.decide] can make — rather than a raw
     * string, so there is no way to send a token that did not come from step 1 for this name.
     */
    fun sandboxRemoveConfirm(issued: IssuedRemoval): CompletableFuture<SandboxRemoveResult> {
        advertisementGap(CoreMethods.SANDBOX_REMOVE)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            buildRemovePayload(issued.name, token = issued.token)
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.SANDBOX_REMOVE, payload).thenApply(::decodeRemoveAnswer)
    }

    /**
     * Decode a `sandbox.remove` answer WITHOUT ever echoing it (security W2). kotlinx.serialization
     * puts the offending JSON input in its exception message, and a remove answer can carry a
     * confirmation token; that message would flow through [ErrorAttribution] into a notification.
     * A shape mismatch therefore becomes a fixed-text [CoreRpcException] raised by THIS plugin.
     */
    private fun decodeRemoveAnswer(ok: JsonElement): SandboxRemoveResult = try {
        CoreJson.decodeFromJsonElement(SandboxRemoveResult.serializer(), ok)
    } catch (_: Exception) {
        throw CoreRpcException(
            CoreErrorCodes.INTERNAL,
            "Core's ${CoreMethods.SANDBOX_REMOVE} answer did not have the expected shape; its content " +
                "is not shown because it may carry a confirmation token",
            raisedByCore = false,
        )
    }

    /** `{"name": …}` after the addressable-name guard. Side-effect-free, for the exact-frame tests. */
    internal fun buildStopPayload(name: String): JsonElement =
        CoreJson.encodeToJsonElement(
            SandboxStopParams.serializer(),
            SandboxStopParams(CoreGuards.requireAddressableSandboxName(name)),
        )

    /**
     * `{"name": …}` (step 1, token null ⇒ key ABSENT via `explicitNulls = false`) or
     * `{"name": …, "confirmToken": …}` (step 2). A token not shaped like Core's is refused here.
     */
    private fun buildRemovePayload(name: String, token: String?): JsonElement {
        val checked = CoreGuards.requireAddressableSandboxName(name)
        if (token != null && !CoreGuards.isConfirmTokenShape(token)) {
            throw CoreValidationException("confirmToken", "not the shape Core issues; nothing was sent")
        }
        return CoreJson.encodeToJsonElement(
            SandboxRemoveParams.serializer(),
            SandboxRemoveParams(name = checked, confirmToken = token),
        )
    }

    // -----------------------------------------------------------------------
    // project lifecycle (A3a)
    // -----------------------------------------------------------------------

    /**
     * `project.list`. With [includeArchived] the request carries `{"includeArchived":true}` and is
     * GATED on `project.archive` being advertised: a pre-A3a Core silently ignores the flag, so
     * sending it there would present a live-only list as "including archived". Without it the
     * frame is `{}` (live projects only) — the baseline every Core answers.
     */
    fun projectList(includeArchived: Boolean = false): CompletableFuture<List<Project>> {
        if (includeArchived) {
            advertisementGap(CoreMethods.PROJECT_ARCHIVE)?.let {
                return CompletableFuture.failedFuture(
                    MethodNotSupportedException(
                        CoreMethods.PROJECT_LIST,
                        "listing archived projects needs ${CoreMethods.PROJECT_ARCHIVE}, which this Core does not advertise. Nothing was sent.",
                    ),
                )
            }
        }
        return rpc.request(CoreMethods.PROJECT_LIST, buildProjectListPayload(includeArchived))
            .thenApply { ok ->
                decodeOrFixed(CoreMethods.PROJECT_LIST) { CoreJson.decodeFromJsonElement(ListSerializer(Project.serializer()), ok) }
            }
    }

    /** `project.update {projectId, name?, description?}`: only the given fields; at least one. */
    fun projectUpdate(projectId: String, name: String?, description: String?): CompletableFuture<Project> =
        projectCall(CoreMethods.PROJECT_UPDATE) { buildProjectUpdatePayload(projectId, name, description) }

    /** `project.archive {projectId}` (idempotent in Core). */
    fun projectArchive(projectId: String): CompletableFuture<Project> =
        projectCall(CoreMethods.PROJECT_ARCHIVE) { buildProjectIdPayload(projectId) }

    /** `project.unarchive {projectId}` (idempotent in Core). */
    fun projectUnarchive(projectId: String): CompletableFuture<Project> =
        projectCall(CoreMethods.PROJECT_UNARCHIVE) { buildProjectIdPayload(projectId) }

    /** `project.add_repository {projectId, path}`; Core resolves and validates the folder. */
    fun projectAddRepository(projectId: String, path: String): CompletableFuture<Project> =
        projectCall(CoreMethods.PROJECT_ADD_REPOSITORY) { buildProjectRepositoryPayload(projectId, path) }

    /** `project.remove_repository {projectId, path}`; the path should be one Core listed. */
    fun projectRemoveRepository(projectId: String, path: String): CompletableFuture<Project> =
        projectCall(CoreMethods.PROJECT_REMOVE_REPOSITORY) { buildProjectRepositoryPayload(projectId, path) }

    /**
     * Step 1 of `project.delete`: `{projectId}` with NO `confirmToken` key. Core changes nothing and
     * answers a confirmation, which must pass [ProjectDeleteCheck.decide] before anything else.
     */
    fun projectDeleteRequest(projectId: String): CompletableFuture<ProjectDeleteResult> {
        advertisementGap(CoreMethods.PROJECT_DELETE)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            buildProjectDeletePayload(projectId, token = null)
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.PROJECT_DELETE, payload).thenApply(::decodeDeleteAnswer)
    }

    /**
     * Step 2 of `project.delete`. Takes an [IssuedProjectDelete] — which only
     * [ProjectDeleteCheck.decide] can make — so no token that did not come from step 1 for this
     * project id can be sent.
     */
    fun projectDeleteConfirm(issued: IssuedProjectDelete): CompletableFuture<ProjectDeleteResult> {
        advertisementGap(CoreMethods.PROJECT_DELETE)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            buildProjectDeletePayload(issued.projectId, token = issued.token)
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.PROJECT_DELETE, payload).thenApply(::decodeDeleteAnswer)
    }

    private fun projectCall(method: String, build: () -> JsonElement): CompletableFuture<Project> {
        advertisementGap(method)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            build()
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(method, payload)
            .thenApply { ok -> decodeOrFixed(method) { CoreJson.decodeFromJsonElement(Project.serializer(), ok) } }
    }

    /** A shape mismatch becomes fixed text raised by THIS plugin; Core's payload is never echoed. */
    private fun <T> decodeOrFixed(method: String, decode: () -> T): T = try {
        decode()
    } catch (_: Exception) {
        throw CoreRpcException(
            CoreErrorCodes.INTERNAL,
            "Core's $method answer did not have the expected shape; its content is not shown",
            raisedByCore = false,
        )
    }

    /** As [decodeRemoveAnswer]: a delete answer can carry a token, so it is never echoed. */
    private fun decodeDeleteAnswer(ok: JsonElement): ProjectDeleteResult = try {
        CoreJson.decodeFromJsonElement(ProjectDeleteResult.serializer(), ok)
    } catch (_: Exception) {
        throw CoreRpcException(
            CoreErrorCodes.INTERNAL,
            "Core's ${CoreMethods.PROJECT_DELETE} answer did not have the expected shape; its content " +
                "is not shown because it may carry a confirmation token",
            raisedByCore = false,
        )
    }

    /** `{}` or `{"includeArchived":true}` — never `false` on the wire (absent already means live-only). */
    internal fun buildProjectListPayload(includeArchived: Boolean): JsonElement =
        CoreJson.encodeToJsonElement(
            ProjectListParams.serializer(),
            ProjectListParams(includeArchived = if (includeArchived) true else null),
        )

    /** Mirrors Core: at least one field; the name/description rules of [ProjectGuards] exactly. */
    internal fun buildProjectUpdatePayload(projectId: String, name: String?, description: String?): JsonElement {
        val id = CoreGuards.requireId(projectId, "projectId")
        if (name == null && description == null) {
            throw CoreValidationException("project.update", "neither a name nor a description was given; nothing was sent")
        }
        name?.let { n -> ProjectGuards.nameProblem(n)?.let { throw CoreValidationException("name", it) } }
        description?.let { d -> ProjectGuards.descriptionProblem(d)?.let { throw CoreValidationException("description", it) } }
        return CoreJson.encodeToJsonElement(
            ProjectUpdateParams.serializer(),
            ProjectUpdateParams(projectId = id, name = name, description = description),
        )
    }

    internal fun buildProjectIdPayload(projectId: String): JsonElement =
        CoreJson.encodeToJsonElement(ProjectIdParams.serializer(), ProjectIdParams(CoreGuards.requireId(projectId, "projectId")))

    /** Core requires an absolute path for both repository methods; a NUL can never be a path. */
    internal fun buildProjectRepositoryPayload(projectId: String, path: String): JsonElement {
        val id = CoreGuards.requireId(projectId, "projectId")
        if (path.isEmpty() || !File(path).isAbsolute) {
            throw CoreValidationException("path", "the repository path must be absolute; nothing was sent")
        }
        if (path.indexOf('\u0000') >= 0) throw CoreValidationException("path", "the path contains a NUL byte; nothing was sent")
        return CoreJson.encodeToJsonElement(ProjectRepositoryParams.serializer(), ProjectRepositoryParams(id, path))
    }

    /** `{projectId}` (step 1, key ABSENT) or `{projectId, confirmToken}` (step 2, Core's shape only). */
    internal fun buildProjectDeletePayload(projectId: String, token: String?): JsonElement {
        val id = CoreGuards.requireId(projectId, "projectId")
        if (token != null && !CoreGuards.isConfirmTokenShape(token)) {
            throw CoreValidationException("confirmToken", "not the shape Core issues; nothing was sent")
        }
        return CoreJson.encodeToJsonElement(ProjectDeleteParams.serializer(), ProjectDeleteParams(id, token))
    }

    // -----------------------------------------------------------------------
    // conversation lifecycle (A3b)
    // -----------------------------------------------------------------------

    /**
     * `conversation.rename {conversationId, title}` → Core's updated [Conversation]. The title must
     * pass [ConversationGuards.renameTitleProblem] (Core's rule exactly, blank refused) or nothing is sent.
     */
    fun conversationRename(conversationId: String, title: String): CompletableFuture<Conversation> =
        conversationCall(CoreMethods.CONVERSATION_RENAME) { buildConversationRenamePayload(conversationId, title) }

    /** `conversation.archive {conversationId}` (idempotent in Core; allowed in an archived project). */
    fun conversationArchive(conversationId: String): CompletableFuture<Conversation> =
        conversationCall(CoreMethods.CONVERSATION_ARCHIVE) { buildConversationIdPayload(conversationId) }

    /** `conversation.unarchive {conversationId}` (idempotent in Core; refused in an archived project). */
    fun conversationUnarchive(conversationId: String): CompletableFuture<Conversation> =
        conversationCall(CoreMethods.CONVERSATION_UNARCHIVE) { buildConversationIdPayload(conversationId) }

    /**
     * Step 1 of `conversation.delete`: `{conversationId}` with NO `confirmToken` key. Core deletes
     * nothing and answers a confirmation, which must pass [ConversationDeleteCheck.decide] first.
     */
    fun conversationDeleteRequest(conversationId: String): CompletableFuture<ConversationDeleteResult> {
        advertisementGap(CoreMethods.CONVERSATION_DELETE)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            buildConversationDeletePayload(conversationId, token = null)
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.CONVERSATION_DELETE, payload).thenApply(::decodeConversationDeleteAnswer)
    }

    /**
     * Step 2 of `conversation.delete`. Takes an [IssuedConversationDelete] — which only
     * [ConversationDeleteCheck.decide] can make — so no token that did not come from step 1 for this
     * conversation id can be sent.
     */
    fun conversationDeleteConfirm(issued: IssuedConversationDelete): CompletableFuture<ConversationDeleteResult> {
        advertisementGap(CoreMethods.CONVERSATION_DELETE)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            buildConversationDeletePayload(issued.conversationId, token = issued.token)
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.CONVERSATION_DELETE, payload).thenApply(::decodeConversationDeleteAnswer)
    }

    /**
     * One `conversation.export` page (read-only, always redacted by Core, best-effort). An answer that
     * does not decode is turned into fixed text: export content is never echoed into an error.
     */
    fun conversationExport(
        conversationId: String,
        afterSequence: Long = 0,
        limit: Int? = null,
    ): CompletableFuture<ConversationExportResult> {
        advertisementGap(CoreMethods.CONVERSATION_EXPORT)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            buildConversationExportPayload(conversationId, afterSequence, limit)
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.CONVERSATION_EXPORT, payload)
            .thenApply { ok ->
                decodeOrFixed(CoreMethods.CONVERSATION_EXPORT) {
                    CoreJson.decodeFromJsonElement(ConversationExportResult.serializer(), ok)
                }
            }
    }

    /**
     * `git.diff` (A5): one entry of the task's `git.review` change list. [change]'s `path` is sent
     * EXACTLY as Core listed it (no trim, normalization or validation), with its wire `status` (a path
     * can be listed twice). [maxBytes] is omitted for Core's default and clamped to 1..524 288. The
     * answer's patch is never echoed if it does not decode.
     */
    fun gitDiff(
        taskId: String,
        change: labs.dkv.sandpane.model.FileChange,
        maxBytes: Int? = null,
    ): CompletableFuture<labs.dkv.sandpane.model.GitDiffResult> {
        advertisementGap(CoreMethods.GIT_DIFF)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            buildGitDiffPayload(taskId, change, maxBytes)
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.GIT_DIFF, payload)
            .thenApply { ok ->
                decodeOrFixed(CoreMethods.GIT_DIFF) {
                    CoreJson.decodeFromJsonElement(labs.dkv.sandpane.model.GitDiffResult.serializer(), ok)
                }
            }
    }

    internal fun buildGitDiffPayload(taskId: String, change: labs.dkv.sandpane.model.FileChange, maxBytes: Int?): JsonElement =
        CoreJson.encodeToJsonElement(
            labs.dkv.sandpane.model.GitDiffParams.serializer(),
            labs.dkv.sandpane.model.GitDiffParams(
                taskId = CoreGuards.requireId(taskId, "taskId"),
                path = change.path,
                status = change.status.wireName,
                maxBytes = GitDiffs.clampMaxBytes(maxBytes),
            ),
        )

    /**
     * `git.apply` (A6, design 2026-10-09 §3.6). Sent ONLY when Core advertises the `git-apply`
     * feature (git.apply itself is a baseline method, so the method list proves nothing): without it
     * this fails locally with [MethodNotSupportedException] and nothing reaches the socket.
     * [params]'s entries are passed through untouched (no validation stricter than Core's; Core
     * checks every entry against its review). NOT replay-safe and NOT read-only: callers never retry,
     * and a timeout is reported as "may have been applied". The answer is never echoed if it does
     * not decode.
     */
    fun gitApply(params: labs.dkv.sandpane.model.GitApplyParams): CompletableFuture<labs.dkv.sandpane.model.ApplyResult> {
        val caps = capabilities()
        if (caps == null || !caps.hasFeature(labs.dkv.sandpane.model.CoreFeatures.GIT_APPLY)) {
            val why = if (caps == null) {
                "this plugin is not connected to Core, so its features are not known yet"
            } else {
                "Core ${caps.coreVersion} does not advertise the git-apply feature, so its git.apply predates " +
                    "reviewed-file apply. Nothing was sent."
            }
            return CompletableFuture.failedFuture(MethodNotSupportedException(CoreMethods.GIT_APPLY, why))
        }
        val payload = try {
            CoreJson.encodeToJsonElement(
                labs.dkv.sandpane.model.GitApplyParams.serializer(),
                params.copy(taskId = CoreGuards.requireId(params.taskId, "taskId")),
            )
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.GIT_APPLY, payload)
            .thenApply { ok ->
                decodeOrFixed(CoreMethods.GIT_APPLY) {
                    CoreJson.decodeFromJsonElement(labs.dkv.sandpane.model.ApplyResult.serializer(), ok)
                }
            }
    }

    // -----------------------------------------------------------------------
    // A7: verification commands + project.context (design 2026-10-09 \u00A73.7)
    // -----------------------------------------------------------------------

    /**
     * Why an A7 [method] may not be sent, or null: it must be ADVERTISED (a pre-A7 Core does not
     * dispatch it) AND Core must advertise the `verification` feature (\u00A73.7 item 1: the UI is
     * enabled only then). Nothing reaches the socket otherwise.
     */
    fun verificationGap(method: String): MethodNotSupportedException? {
        advertisementGap(method)?.let { return it }
        val caps = capabilities()
            ?: return MethodNotSupportedException(method, "this plugin is not connected to Core, so its features are not known yet")
        if (caps.hasFeature(labs.dkv.sandpane.model.CoreFeatures.VERIFICATION)) return null
        return MethodNotSupportedException(
            method,
            "Core ${caps.coreVersion} does not advertise the verification feature. Nothing was sent.",
        )
    }

    private fun <T> verificationCall(
        method: String,
        build: () -> JsonElement,
        decode: (JsonElement) -> T,
    ): CompletableFuture<T> {
        verificationGap(method)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            build()
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(method, payload).thenApply { ok -> decodeOrFixed(method) { decode(ok) } }
    }

    /** `verification.list {projectId}` (read-only) \u2192 the project's live commands, in Core's order. */
    fun verificationList(projectId: String): CompletableFuture<List<labs.dkv.sandpane.model.VerificationCommand>> =
        verificationCall(CoreMethods.VERIFICATION_LIST, { buildVerificationListPayload(projectId) }) {
            CoreJson.decodeFromJsonElement(labs.dkv.sandpane.model.VerificationListResult.serializer(), it).commands
        }

    /**
     * `verification.approve {projectId, label, argv}`: the EXACT list the user confirmed, element by
     * element (no trim, split, join or normalization). Refused locally only for a shape Core refuses
     * too ([VerificationGuards], never stricter); the secret check is Core's.
     */
    fun verificationApprove(
        projectId: String,
        label: String,
        argv: List<String>,
    ): CompletableFuture<labs.dkv.sandpane.model.VerificationCommand> =
        verificationCall(CoreMethods.VERIFICATION_APPROVE, { buildVerificationApprovePayload(projectId, label, argv) }) {
            CoreJson.decodeFromJsonElement(labs.dkv.sandpane.model.VerificationApproveResult.serializer(), it).command
        }

    /** `verification.revoke {commandId}` \u2192 Core's `revoked` flag (idempotent). */
    fun verificationRevoke(commandId: String): CompletableFuture<Boolean> =
        verificationCall(CoreMethods.VERIFICATION_REVOKE, { buildVerificationRevokePayload(commandId) }) {
            CoreJson.decodeFromJsonElement(labs.dkv.sandpane.model.VerificationRevokeResult.serializer(), it).revoked
        }

    /**
     * `verification.run` with params from [VerificationRuns] (a fresh key per gesture, the same key
     * only for "Retry safely"). NOT read-only and NOT replay-safe: the caller never retries on its own.
     */
    fun verificationRun(
        params: labs.dkv.sandpane.model.VerificationRunParams,
    ): CompletableFuture<labs.dkv.sandpane.model.VerificationRunResult> =
        verificationCall(CoreMethods.VERIFICATION_RUN, { buildVerificationRunPayload(params) }) {
            CoreJson.decodeFromJsonElement(labs.dkv.sandpane.model.VerificationRunResult.serializer(), it)
        }

    /** `verification.result {runId}` (read-only). Output is never echoed if the answer does not decode. */
    fun verificationResult(runId: String): CompletableFuture<labs.dkv.sandpane.model.VerificationResult> =
        verificationCall(CoreMethods.VERIFICATION_RESULT, { buildVerificationResultPayload(runId) }) {
            CoreJson.decodeFromJsonElement(labs.dkv.sandpane.model.VerificationResult.serializer(), it)
        }

    /** `project.context {projectId}` (read-only; 45 s deadline, [MethodDeadlines.PROJECT_CONTEXT_MS]). */
    fun projectContext(projectId: String): CompletableFuture<labs.dkv.sandpane.model.ProjectContextResult> =
        verificationCall(CoreMethods.PROJECT_CONTEXT, { buildProjectContextPayload(projectId) }) {
            CoreJson.decodeFromJsonElement(labs.dkv.sandpane.model.ProjectContextResult.serializer(), it)
        }

    internal fun buildVerificationListPayload(projectId: String): JsonElement =
        CoreJson.encodeToJsonElement(
            labs.dkv.sandpane.model.VerificationListParams.serializer(),
            labs.dkv.sandpane.model.VerificationListParams(CoreGuards.requireId(projectId, "projectId")),
        )

    internal fun buildVerificationApprovePayload(projectId: String, label: String, argv: List<String>): JsonElement {
        val id = CoreGuards.requireId(projectId, "projectId")
        VerificationGuards.labelProblem(label)?.let { throw CoreValidationException("label", "$it; nothing was sent") }
        VerificationGuards.argvProblem(argv)?.let { throw CoreValidationException("argv", "$it; nothing was sent") }
        return CoreJson.encodeToJsonElement(
            labs.dkv.sandpane.model.VerificationApproveParams.serializer(),
            labs.dkv.sandpane.model.VerificationApproveParams(projectId = id, label = label, argv = argv),
        )
    }

    internal fun buildVerificationRevokePayload(commandId: String): JsonElement =
        CoreJson.encodeToJsonElement(
            labs.dkv.sandpane.model.VerificationRevokeParams.serializer(),
            labs.dkv.sandpane.model.VerificationRevokeParams(CoreGuards.requireId(commandId, "commandId")),
        )

    internal fun buildVerificationRunPayload(params: labs.dkv.sandpane.model.VerificationRunParams): JsonElement {
        val key = params.idempotencyKey
        if (key != null && !IdempotencyKeys.isValid(key)) {
            throw CoreValidationException("idempotencyKey", "not in Core's format; nothing was sent")
        }
        return CoreJson.encodeToJsonElement(
            labs.dkv.sandpane.model.VerificationRunParams.serializer(),
            params.copy(
                taskId = CoreGuards.requireId(params.taskId, "taskId"),
                commandId = CoreGuards.requireId(params.commandId, "commandId"),
                expectedSandboxName = CoreGuards.requireAddressableSandboxName(params.expectedSandboxName),
            ),
        )
    }

    internal fun buildVerificationResultPayload(runId: String): JsonElement =
        CoreJson.encodeToJsonElement(
            labs.dkv.sandpane.model.VerificationResultParams.serializer(),
            labs.dkv.sandpane.model.VerificationResultParams(CoreGuards.requireId(runId, "runId")),
        )

    internal fun buildProjectContextPayload(projectId: String): JsonElement =
        CoreJson.encodeToJsonElement(
            labs.dkv.sandpane.model.ProjectContextParams.serializer(),
            labs.dkv.sandpane.model.ProjectContextParams(CoreGuards.requireId(projectId, "projectId")),
        )

    private fun conversationCall(method: String, build: () -> JsonElement): CompletableFuture<Conversation> {
        advertisementGap(method)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            build()
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(method, payload)
            .thenApply { ok -> decodeOrFixed(method) { CoreJson.decodeFromJsonElement(Conversation.serializer(), ok) } }
    }

    /** As [decodeDeleteAnswer]: a delete answer can carry a token, so it is never echoed. */
    private fun decodeConversationDeleteAnswer(ok: JsonElement): ConversationDeleteResult = try {
        CoreJson.decodeFromJsonElement(ConversationDeleteResult.serializer(), ok)
    } catch (_: Exception) {
        throw CoreRpcException(
            CoreErrorCodes.INTERNAL,
            "Core's ${CoreMethods.CONVERSATION_DELETE} answer did not have the expected shape; its content " +
                "is not shown because it may carry a confirmation token",
            raisedByCore = false,
        )
    }

    /** `{conversationId, title}` after the id guard and Core's title rule (blank refused). */
    internal fun buildConversationRenamePayload(conversationId: String, title: String): JsonElement {
        val id = CoreGuards.requireId(conversationId, "conversationId")
        ConversationGuards.renameTitleProblem(title)?.let { throw CoreValidationException("title", it) }
        return CoreJson.encodeToJsonElement(ConversationRenameParams.serializer(), ConversationRenameParams(id, title))
    }

    internal fun buildConversationIdPayload(conversationId: String): JsonElement =
        CoreJson.encodeToJsonElement(
            ConversationIdParams.serializer(),
            ConversationIdParams(CoreGuards.requireId(conversationId, "conversationId")),
        )

    /** `{conversationId}` (step 1, key ABSENT) or `{conversationId, confirmToken}` (step 2, Core's shape only). */
    internal fun buildConversationDeletePayload(conversationId: String, token: String?): JsonElement {
        val id = CoreGuards.requireId(conversationId, "conversationId")
        if (token != null && !CoreGuards.isConfirmTokenShape(token)) {
            throw CoreValidationException("confirmToken", "not the shape Core issues; nothing was sent")
        }
        return CoreJson.encodeToJsonElement(ConversationDeleteParams.serializer(), ConversationDeleteParams(id, token))
    }

    /** `{conversationId, afterSequence[, limit]}` — the cursor normalised like Core (negative ⇒ 0). */
    internal fun buildConversationExportPayload(conversationId: String, afterSequence: Long, limit: Int?): JsonElement {
        val id = CoreGuards.requireId(conversationId, "conversationId")
        return CoreJson.encodeToJsonElement(
            ConversationExportParams.serializer(),
            ConversationExportParams(id, afterSequence.coerceAtLeast(0L), limit?.let { CoreGuards.clampLimit(it) }),
        )
    }

    // -----------------------------------------------------------------------
    // task.subscribe — the three cursor shapes
    // -----------------------------------------------------------------------

    /**
     * `task.subscribe` with the cursor rules from `TaskSubscribeParams` in Rust, exactly:
     *
     * 1. `taskId` present → that ONE task replays from the scalar [TaskSubscribeParams.afterSequence].
     *    Core IGNORES `afterSequences` on this path, so the key is not even put on the wire —
     *    sending it would imply it had an effect.
     * 2. no `taskId`, `afterSequences` present → each task replays from its OWN cursor; a task
     *    missing from the map replays IN FULL (0). Plan for that: a catch-up that names only some
     *    tasks redelivers the rest.
     * 3. no `taskId`, no map → the legacy shared scalar applies to every task, unchanged.
     *
     * A refusal Core raises because the replay cannot fit one frame
     * ([CoreGuards.isOversizedReplayRefusal]) is returned as-is — it is structured and
     * recoverable, and retrying the identical request can never converge, so this wrapper does
     * not retry either.
     */
    fun taskSubscribe(params: TaskSubscribeParams): CompletableFuture<List<TaskEvent>> {
        val payload = try {
            buildSubscribePayload(params)
        } catch (e: CoreValidationException) {
            return CompletableFuture.failedFuture(e)
        }
        return rpc.request(CoreMethods.TASK_SUBSCRIBE, payload)
            .thenApply { CoreJson.decodeFromJsonElement(ListSerializer(TaskEvent.serializer()), it) }
    }

    /**
     * Build the subscribe payload. Package-visible and side-effect-free so the cursor semantics
     * are testable without a socket — the tests assert the EXACT key set that leaves this client.
     */
    internal fun buildSubscribePayload(params: TaskSubscribeParams): JsonObject {
        val taskId = params.taskId?.takeIf { it.isNotBlank() }
        val projectId = CoreGuards.optionalScopingId(params.projectId, "projectId")
        val cursor = params.afterSequence.coerceAtLeast(0L)
        // Validate the map even on the taskId path: a caller that passed one is holding per-task
        // state, and a malformed key must not silently travel toward Core.
        val cursors = CoreGuards.validateCursorMap(params.afterSequences)

        return buildJsonObject {
            projectId?.let { put("projectId", it) }
            if (taskId != null) {
                put("taskId", CoreGuards.requireId(taskId, "taskId"))
                put("afterSequence", cursor)
                // Path 1: scalar wins; no afterSequences key.
                return@buildJsonObject
            }
            put("afterSequence", cursor)
            // Path 2 vs path 3: a present map replays per task; absent keeps the shared scalar.
            cursors?.let { map ->
                put("afterSequences", JsonObject(map.entries.associate { (k, v) -> k to JsonPrimitive(v) }))
            }
        }
    }
}
