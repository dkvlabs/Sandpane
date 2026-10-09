// Wire types for the Sandpane Core protocol.
//
// MIRROR OF: core/crates/sandpane-protocol/src/lib.rs (Rust is the source of truth;
// schemas/*.json is hand-synced with it — see schemas/README.md "Sync status").
// Also mirrors core/crates/sandpane-service/src/lib.rs::MAX_FRAME_BYTES.
//
// Fidelity rules, exactly as in apps/desktop/src/lib/protocol.ts:
//   * struct fields are `camelCase` on the frame            (#[serde(rename_all = "camelCase")])
//   * TaskStatus / WorkspaceMode / FileChangeStatus / ContextRefKind are snake_case strings
//   * ErrorCode is SCREAMING_SNAKE_CASE
//   * AgentEvent is a union discriminated by `type`, with dotted variant names
//
// Where a wire name is a single lowercase word, the Kotlin property name IS the wire
// name (no @SerialName needed); every multi-word field carries an explicit @SerialName so
// the whole surface is greppable for the parity check. Do not "tidy" those away.
//
// RESOLVED DRIFT (re-checked 09.10.2026 against the current lib.rs): `AgentEvent::
// UnsupportedEvent` now carries `#[serde(rename = "providerType")]`, so the wire name is
// `providerType` — matching schemas/agent-event.schema.json and the TS mirrors. An earlier
// build of the crate emitted `provider_type` (serde does not apply an enum-level `rename_all`
// to struct-variant fields). AgentEventCodec still ACCEPTS `provider_type` as a fallback so
// this plugin works against an older Core that predates the fix; that is compatibility, not a
// drift claim. Note the drift gate (`scripts/schema_drift.py`) compares value sets only, so it
// could not have caught this field rename — field-level checking is the P1/P7 codegen item.
package labs.dkv.sandpane.model

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject

/** Bumped on any breaking frame/semantics change; negotiated in `system.probe`. */
const val PROTOCOL_VERSION: Int = 1

/**
 * Hard cap on one NDJSON frame; mirrors `sandpane_service::MAX_FRAME_BYTES` (4 MiB).
 * A client refuses to buffer beyond it instead of growing without bound (AGENTS.md rule 9).
 */
const val MAX_FRAME_BYTES: Int = 4 * 1024 * 1024

/**
 * Single Json configuration for the whole client. `ignoreUnknownKeys` is what lets a newer
 * Core add fields without breaking this plugin; `encodeDefaults` is what makes serde
 * `#[serde(default)]` fields (e.g. `attachments: []`) actually appear in requests.
 */
@OptIn(ExperimentalSerializationApi::class)
val CoreJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
    isLenient = false
    coerceInputValues = false
}

// ---------------------------------------------------------------------------
// Method + code allowlists
// ---------------------------------------------------------------------------

/**
 * The complete allowlisted method surface (`sandpane_protocol::Method`). There is
 * deliberately no free-form execution method, and a client must never invent one: an
 * unknown name is rejected by Core with `VALIDATION_FAILED`.
 */
object CoreMethods {
    const val SYSTEM_PROBE: String = "system.probe"
    const val PROJECT_CREATE: String = "project.create"
    const val PROJECT_LIST: String = "project.list"
    const val SANDBOX_LIST: String = "sandbox.list"
    const val SANDBOX_CREATE: String = "sandbox.create"
    const val CONVERSATION_CREATE: String = "conversation.create"
    const val CONVERSATION_SEND: String = "conversation.send"
    const val TASK_CANCEL: String = "task.cancel"
    const val TASK_SUBSCRIBE: String = "task.subscribe"
    const val GIT_REVIEW: String = "git.review"
    const val GIT_APPLY: String = "git.apply"

    /** Sent only to Core after this check; nothing here reaches a shell. */
    val ALL: Set<String> = setOf(
        SYSTEM_PROBE, PROJECT_CREATE, PROJECT_LIST, SANDBOX_LIST, SANDBOX_CREATE,
        CONVERSATION_CREATE, CONVERSATION_SEND, TASK_CANCEL, TASK_SUBSCRIBE,
        GIT_REVIEW, GIT_APPLY,
    )

    fun isAllowlisted(method: String): Boolean = ALL.contains(method)
}

/** `sandpane_protocol::ErrorCode`. Kept as strings on the wire so a newer Core's added
 *  code stays visible instead of failing the whole frame (fail-open on display, never on
 *  an action). */
object CoreErrorCodes {
    const val NOT_INSTALLED = "NOT_INSTALLED"
    const val DAEMON_DOWN = "DAEMON_DOWN"
    const val UNSUPPORTED_SBX_VERSION = "UNSUPPORTED_SBX_VERSION"
    const val PROVIDER_AUTH_REQUIRED = "PROVIDER_AUTH_REQUIRED"
    const val CONFLICT = "CONFLICT"
    const val TASK_INTERRUPTED = "TASK_INTERRUPTED"
    const val PERMISSION_DENIED = "PERMISSION_DENIED"
    const val VALIDATION_FAILED = "VALIDATION_FAILED"
    const val NOT_FOUND = "NOT_FOUND"
    const val INTERNAL = "INTERNAL"

    val ALL: Set<String> = setOf(
        NOT_INSTALLED, DAEMON_DOWN, UNSUPPORTED_SBX_VERSION, PROVIDER_AUTH_REQUIRED,
        CONFLICT, TASK_INTERRUPTED, PERMISSION_DENIED, VALIDATION_FAILED, NOT_FOUND, INTERNAL,
    )

    fun isKnown(code: String): Boolean = ALL.contains(code)
}

/** Core-emitted task-event kinds that are NOT normalized agent events. */
object CoreEventKinds {
    const val TASK_CREATED = "task.created"
    const val STATUS_CHANGED = "status.changed"
    const val MESSAGE_USER = "message.user"
    const val ADAPTER_UNAVAILABLE = "adapter.unavailable"
    const val SCHEDULER_DEFERRED = "scheduler.deferred"

    val ALL: Set<String> = setOf(
        TASK_CREATED, STATUS_CHANGED, MESSAGE_USER, ADAPTER_UNAVAILABLE, SCHEDULER_DEFERRED,
    )
}

// ---------------------------------------------------------------------------
// RPC frames
// ---------------------------------------------------------------------------

/** Client → Core request frame. Declaration order is the emitted key order: v, id, method, params. */
@Serializable
data class RpcRequest(
    val v: Int = PROTOCOL_VERSION,
    val id: String,
    val method: String,
    val params: JsonElement = buildJsonObject { },
)

/** `RpcError` — `details` never carries secrets or full prompt content. */
@Serializable
data class RpcErrorPayload(
    val code: String,
    val message: String,
    val details: JsonElement? = null,
)

/**
 * Core → client frame. Rust flattens `RpcOutcome::{Ok,Err}` into sibling `ok` / `err`
 * keys, exactly one of which is present (schemas/rpc-response.schema.json `oneOf`).
 * A frame with `id == ""` is Core's reply to a frame it could not parse.
 */
@Serializable
data class RpcResponseFrame(
    val v: Int,
    val id: String,
    val ok: JsonElement? = null,
    val err: RpcErrorPayload? = null,
) {
    val isError: Boolean get() = err != null || ok == null
}

// ---------------------------------------------------------------------------
// system.probe
// ---------------------------------------------------------------------------

@Serializable
data class CoreCapabilities(
    @SerialName("protocolVersion") val protocolVersion: Int,
    @SerialName("coreVersion") val coreVersion: String,
    /** Unique per running Core instance; changes across restarts, so restarts are detected. */
    @SerialName("instanceId") val instanceId: String,
    /** null when SBX was never located. */
    val sbx: SbxStatus? = null,
    val agents: List<AgentCapability> = emptyList(),
    val platform: String,
) {
    val versionCompatible: Boolean get() = protocolVersion == PROTOCOL_VERSION

    /**
     * Honest gate for JB2: chat/agent features may only be advertised when Core itself
     * reports a verified adapter (P0 in-SBX feasibility gate). Never inferred client-side.
     */
    val verifiedAgentIds: List<String> get() = agents.filter { it.verified }.map { it.id }
    val hasVerifiedAgent: Boolean get() = verifiedAgentIds.isNotEmpty()
}

@Serializable
data class SbxStatus(
    val installed: Boolean,
    @SerialName("binaryPath") val binaryPath: String? = null,
    val version: String? = null,
    @SerialName("daemonRunning") val daemonRunning: Boolean? = null,
)

@Serializable
data class AgentCapability(
    val id: String,
    /** True ONLY after the adapter passed its in-SBX feasibility gate (P0). */
    val verified: Boolean,
    @SerialName("supportsStreaming") val supportsStreaming: Boolean,
    @SerialName("supportsCancel") val supportsCancel: Boolean,
    /** Native-session resume is advertised ONLY after restart tests pass. */
    @SerialName("supportsResume") val supportsResume: Boolean,
)

// ---------------------------------------------------------------------------
// projects / sandboxes
// ---------------------------------------------------------------------------

@Serializable
data class Project(
    val id: String,
    val name: String,
    val description: String = "",
    @SerialName("createdAt") val createdAt: String,
)

@Serializable
data class ProjectCreateParams(
    val name: String,
    val repositories: List<String> = emptyList(),
)

@Serializable
data class SandboxCreateSpec(
    val name: String,
    @SerialName("projectId") val projectId: String,
    @SerialName("workspaceMode") val workspaceMode: WorkspaceMode,
    @SerialName("repoPath") val repoPath: String? = null,
)

@Serializable
data class SandboxSummary(
    val name: String,
    /** Last probed state — never assumed, never inferred from a cached row. */
    @SerialName("probedState") val probedState: String? = null,
    @SerialName("boundProjectId") val boundProjectId: String? = null,
)

/** Workspace mapping modes (specs/02 §7). */
@Serializable
enum class WorkspaceMode {
    /** Live-writable: edits are already on the host and must be labeled as such in every UI
     * surface (docs/specs/02 §7). */
    @SerialName("direct_mount") DIRECT_MOUNT,

    @SerialName("sbx_clone") SBX_CLONE,
    @SerialName("host_worktree") HOST_WORKTREE,
    @SerialName("mountless") MOUNTLESS;

    val wireName: String get() = name.lowercase()

    /** direct_mount edits are already on the host; review cannot retroactively block them. */
    val isLiveWritable: Boolean get() = this == DIRECT_MOUNT
}

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

@Serializable
data class ConversationCreateParams(
    @SerialName("projectId") val projectId: String,
    @SerialName("agentId") val agentId: String,
    @SerialName("sandboxId") val sandboxId: String? = null,
    val title: String = "",
)

@Serializable
data class Conversation(
    val id: String,
    @SerialName("projectId") val projectId: String,
    val title: String,
    @SerialName("agentId") val agentId: String,
    @SerialName("createdAt") val createdAt: String,
)

@Serializable
data class ConversationSendParams(
    @SerialName("conversationId") val conversationId: String,
    val content: String,
    val attachments: List<ContextRef> = emptyList(),
)

@Serializable
data class ContextRef(
    val kind: ContextRefKind,
    /** Path or identifier — validated by Core and never executed. */
    val target: String,
)

@Serializable
enum class ContextRefKind {
    @SerialName("file") FILE,
    @SerialName("selection") SELECTION,
    @SerialName("diagnostics") DIAGNOSTICS,
    @SerialName("diff_range") DIFF_RANGE;
}

/** `conversation.send` result. */
@Serializable
data class TaskAccepted(@SerialName("taskId") val taskId: String)

/** `task.cancel` result: only that a cancellation was *requested*. */
@Serializable
data class CancelAccepted(val requested: Boolean)

// ---------------------------------------------------------------------------
// task events
// ---------------------------------------------------------------------------

@Serializable
data class TaskSubscribeParams(
    @SerialName("projectId") val projectId: String? = null,
    @SerialName("taskId") val taskId: String? = null,
    /** Replay everything strictly after this per-task sequence number. */
    @SerialName("afterSequence") val afterSequence: Long = 0,
)

/** Durable, replayable task log entry (`task_events`). */
@Serializable
data class TaskEvent(
    @SerialName("taskId") val taskId: String,
    val sequence: Long,
    val kind: String,
    val payload: JsonElement = buildJsonObject { },
    val timestamp: String,
)

/** Task lifecycle states. Transitions are enforced in Core, never here (AGENTS.md rule 3). */
@Serializable
enum class TaskStatus {
    @SerialName("created") CREATED,
    @SerialName("queued") QUEUED,
    @SerialName("preparing") PREPARING,
    @SerialName("running") RUNNING,
    @SerialName("verifying") VERIFYING,
    @SerialName("awaiting_input") AWAITING_INPUT,
    @SerialName("awaiting_review") AWAITING_REVIEW,
    @SerialName("completed") COMPLETED,
    @SerialName("rejected") REJECTED,
    @SerialName("failed") FAILED,
    @SerialName("cancelled") CANCELLED,
    @SerialName("interrupted") INTERRUPTED;

    /** Terminal for display purposes only — never a client-side transition. */
    val isTerminal: Boolean
        get() = this == COMPLETED || this == REJECTED || this == FAILED ||
            this == CANCELLED || this == INTERRUPTED
}

@Serializable
data class TaskSummary(
    val id: String,
    @SerialName("conversationId") val conversationId: String,
    val status: TaskStatus,
    @SerialName("sandboxName") val sandboxName: String? = null,
    @SerialName("taskBranch") val taskBranch: String? = null,
    @SerialName("baseCommit") val baseCommit: String? = null,
)

// ---------------------------------------------------------------------------
// git review / apply
// ---------------------------------------------------------------------------

/** `git.review` result: the ACTUAL change set versus the task's recorded base. */
@Serializable
data class ChangeSet(
    @SerialName("taskId") val taskId: String,
    @SerialName("baseCommit") val baseCommit: String,
    @SerialName("hostDirty") val hostDirty: Boolean,
    val changes: List<FileChange> = emptyList(),
)

@Serializable
data class FileChange(
    val path: String,
    val status: FileChangeStatus,
)

@Serializable
enum class FileChangeStatus {
    @SerialName("added") ADDED,
    @SerialName("modified") MODIFIED,
    @SerialName("deleted") DELETED,
    @SerialName("renamed") RENAMED,
    @SerialName("untracked") UNTRACKED;
}

/** Apply is an explicit Git operation in Core, never a file overwrite here (rule 7). */
@Serializable
data class GitApplyParams(
    @SerialName("taskId") val taskId: String,
    @SerialName("selectedFiles") val selectedFiles: List<String>? = null,
    /** The client's recorded base; a mismatch aborts the apply in Core. */
    @SerialName("expectedBase") val expectedBase: String,
)

@Serializable
data class ApplyResult(
    val applied: Boolean,
    @SerialName("abortReason") val abortReason: String? = null,
    @SerialName("conflictedFiles") val conflictedFiles: List<String> = emptyList(),
)

// ---------------------------------------------------------------------------
// Normalized agent events (specs/02 §4)
// ---------------------------------------------------------------------------

/**
 * Union discriminated by `type`. Decoded manually (see [AgentEventCodec]) rather than via
 * sealed-class polymorphism, because kotlinx.serialization expects the discriminator to
 * lead the object while serde writes variant fields in declaration order — and because one
 * field name is ambiguous on this host (see the drift note at the top of this file).
 */
sealed class AgentEvent {
    /** The wire `type` value for this variant. */
    abstract val wireType: String

    data class MessageDelta(val text: String) : AgentEvent() {
        override val wireType: String get() = TYPE_MESSAGE_DELTA
    }

    data class ToolStarted(val name: String, val id: String) : AgentEvent() {
        override val wireType: String get() = TYPE_TOOL_STARTED
    }

    data class ToolFinished(val id: String, val ok: Boolean, val summary: String? = null) : AgentEvent() {
        override val wireType: String get() = TYPE_TOOL_FINISHED
    }

    data class FileChanged(val path: String) : AgentEvent() {
        override val wireType: String get() = TYPE_FILE_CHANGED
    }

    data class ApprovalRequired(val requestId: String, val description: String) : AgentEvent() {
        override val wireType: String get() = TYPE_APPROVAL_REQUIRED
    }

    data class TaskCompleted(val ok: Boolean) : AgentEvent() {
        override val wireType: String get() = TYPE_TASK_COMPLETED
    }

    /** `code` is SCREAMING_SNAKE_CASE; kept as String — see [CoreErrorCodes]. */
    data class Failed(val code: String, val message: String) : AgentEvent() {
        override val wireType: String get() = TYPE_ERROR
    }

    /** Adapter could not verify a provider event; surfaced, never guessed. */
    data class UnsupportedEvent(val providerType: String) : AgentEvent() {
        override val wireType: String get() = TYPE_UNSUPPORTED_EVENT
    }

    /**
     * Client-side only (NOT a wire type): the frame carried a discriminator or field this
     * build does not understand. Rendered as an explicit "unrecognized event" row instead of
     * being dropped or reinterpreted (AGENTS.md rule 5 — honesty).
     */
    data class Malformed(val rawType: String?, val reason: String) : AgentEvent() {
        override val wireType: String get() = rawType ?: "?"
    }

    companion object {
        const val TYPE_MESSAGE_DELTA = "message.delta"
        const val TYPE_TOOL_STARTED = "tool.started"
        const val TYPE_TOOL_FINISHED = "tool.finished"
        const val TYPE_FILE_CHANGED = "file.changed"
        const val TYPE_APPROVAL_REQUIRED = "approval.required"
        const val TYPE_TASK_COMPLETED = "task.completed"
        const val TYPE_ERROR = "error"
        const val TYPE_UNSUPPORTED_EVENT = "unsupported.event"

        val TYPES: Set<String> = setOf(
            TYPE_MESSAGE_DELTA, TYPE_TOOL_STARTED, TYPE_TOOL_FINISHED, TYPE_FILE_CHANGED,
            TYPE_APPROVAL_REQUIRED, TYPE_TASK_COMPLETED, TYPE_ERROR, TYPE_UNSUPPORTED_EVENT,
        )
    }
}

object AgentEventCodec {

    /**
     * Decode one agent-event object. Never throws and never guesses: a shape this build
     * cannot confirm becomes [AgentEvent.Malformed] so the UI can show "unrecognized".
     */
    fun decode(element: JsonElement): AgentEvent {
        if (element !is JsonObject) {
            return AgentEvent.Malformed(null, "agent event payload is not a JSON object")
        }
        val type = element.stringOrNull("type")
        return when (type) {
            AgentEvent.TYPE_MESSAGE_DELTA ->
                element.string("text")?.let { AgentEvent.MessageDelta(it) } ?: malformed(type, "text")

            AgentEvent.TYPE_TOOL_STARTED -> {
                val name = element.string("name")
                val id = element.string("id")
                if (name != null && id != null) AgentEvent.ToolStarted(name, id) else malformed(type, "name/id")
            }

            AgentEvent.TYPE_TOOL_FINISHED -> {
                val id = element.string("id")
                val ok = element.boolean("ok")
                when {
                    id == null || ok == null -> malformed(type, "id/ok")
                    else -> AgentEvent.ToolFinished(id, ok, element.string("summary"))
                }
            }

            AgentEvent.TYPE_FILE_CHANGED ->
                element.string("path")?.let { AgentEvent.FileChanged(it) } ?: malformed(type, "path")

            AgentEvent.TYPE_APPROVAL_REQUIRED -> {
                // Rust renames this field explicitly to `requestId`.
                val requestId = element.string("requestId") ?: element.string("request_id")
                val description = element.string("description")
                if (requestId != null && description != null) {
                    AgentEvent.ApprovalRequired(requestId, description)
                } else {
                    malformed(type, "requestId/description")
                }
            }

            AgentEvent.TYPE_TASK_COMPLETED ->
                element.boolean("ok")?.let { AgentEvent.TaskCompleted(it) } ?: malformed(type, "ok")

            AgentEvent.TYPE_ERROR -> {
                val code = element.string("code")
                val message = element.string("message")
                when {
                    code == null || message == null -> malformed(type, "code/message")
                    !CoreErrorCodes.isKnown(code) -> AgentEvent.Malformed(type, "unknown error code '$code'")
                    else -> AgentEvent.Failed(code, message)
                }
            }

            AgentEvent.TYPE_UNSUPPORTED_EVENT -> {
                // Canonical name is `providerType` (lib.rs pins it now); `provider_type` is
                // accepted only so an older Core build stays readable.
                val providerType = element.string("providerType") ?: element.string("provider_type")
                providerType?.let { AgentEvent.UnsupportedEvent(it) } ?: malformed(type, "providerType")
            }

            else -> AgentEvent.Malformed(type, "unrecognized agent event discriminator")
        }
    }

    private fun malformed(type: String?, missing: String) =
        AgentEvent.Malformed(type, "agent event '$type' is missing or mis-typed $missing")

    private fun JsonObject.string(key: String): String? =
        (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.stringOrNull(key: String): String? = string(key)

    private fun JsonObject.boolean(key: String): Boolean? =
        (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.let {
            when (it.content) {
                "true" -> true
                "false" -> false
                else -> null
            }
        }
}
