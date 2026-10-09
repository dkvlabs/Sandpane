// Typed request wrappers for the Core RPC surface, with the protocol-v1 read methods.
//
// Design rules this file obeys:
//   * NOTHING is sent that the guards in [CoreGuards] refuse — an invalid id, limit or cursor
//     map never reaches the socket, and the returned future fails with [CoreValidationException],
//     which is this client's word, never a Core verdict (AGENTS.md rule 5).
//   * The three additive v1 methods are gated on ADVERTISEMENT (`CoreCapabilities.methods`), not
//     on a version number: `protocolVersion` stayed 1 across this revision, so assuming a method
//     from it would send a request an older Core answers with VALIDATION_FAILED.
//   * Every call returns a CompletableFuture and performs no Swing work; the caller owns the
//     EDT hop (docs/specs/04 §2).
package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.model.ConversationHistoryParams
import labs.dkv.sandpane.model.ConversationHistoryResult
import labs.dkv.sandpane.model.ConversationListParams
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
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
     * The advertisement gap for an additive v1 method, or null when it may be called.
     *
     * Refusing locally keeps a pre-revision Core from answering for a surface it never promised,
     * and keeps the refusal out of the wire entirely. The eleven original methods need no gate —
     * they are the protocol-v1 baseline every Core dispatches.
     */
    private fun advertisementGap(method: String): MethodNotSupportedException? {
        if (!CoreMethods.ADDITIVE_IN_V1.contains(method)) return null
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
            .thenApply { CoreJson.decodeFromJsonElement(ListSerializer(TaskSummary.serializer()), it) }
    }

    // -----------------------------------------------------------------------
    // conversation.list / conversation.history
    // -----------------------------------------------------------------------

    /**
     * `conversation.list` → the conversations Core says may be reopened. Archived rows are
     * excluded by Core, so this is exactly what the UI may offer.
     */
    fun conversationList(
        params: ConversationListParams = ConversationListParams(),
    ): CompletableFuture<List<Conversation>> {
        advertisementGap(CoreMethods.CONVERSATION_LIST)?.let { return CompletableFuture.failedFuture(it) }
        val payload = try {
            buildJsonObject {
                CoreGuards.optionalScopingId(params.projectId, "projectId")?.let { put("projectId", it) }
                params.limit?.let { put("limit", CoreGuards.clampLimit(it)) }
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
     * or archived conversation is Core's `NOT_FOUND` — surfaced as a failed future, not turned
     * into an empty list that reads as "no messages".
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
