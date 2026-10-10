// Wire types for the Sandpane Core protocol.
//
// MIRROR OF: core/crates/sandpane-protocol/src/lib.rs (Rust is the source of truth;
// schemas/*.json is hand-synced with it — see schemas/README.md "Sync status").
// Also mirrors core/crates/sandpane-service/src/lib.rs::MAX_FRAME_BYTES.
//
// Fidelity rules, exactly as in apps/desktop/src/lib/protocol.ts:
//   * struct fields are `camelCase` on the frame            (#[serde(rename_all = "camelCase")])
//   * TaskStatus / WorkspaceMode / FileChangeStatus / ContextRefKind are snake_case strings
//   * where Core REPORTS a TaskStatus / FileChangeStatus / WorkspaceMode, the field is a
//     [Reported] (Reported.kt): a value a newer Core added decodes as Reported.Unknown(raw)
//     instead of failing the whole frame. Outgoing fields keep the closed enums.
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
 * Rows Core returns from a bounded read when the caller asks for no limit; mirrors
 * `sandpane_service::DEFAULT_LIST_LIMIT`. The client does NOT substitute it onto the wire —
 * `limit` stays absent so Core's own default is the one that applies.
 */
const val DEFAULT_LIST_LIMIT: Int = 200

/**
 * Hard ceiling on rows from any single bounded read method; mirrors
 * `sandpane_service::MAX_LIST_LIMIT`. A larger request is clamped by Core, never honoured, so
 * the client clamps identically before sending (a local clamp is a display preference; Core's
 * clamp is the authority).
 */
const val MAX_LIST_LIMIT: Int = 500

/**
 * Content ceiling behind `conversation.history`'s `truncated` flag; mirrors
 * `sandpane_service::MAX_HISTORY_BYTES`. Used only to EXPLAIN a truncation — Core measures the
 * actual serialized bytes. Kept under [MAX_FRAME_BYTES] by Core's own compile-time assertion.
 */
const val MAX_HISTORY_BYTES: Int = 2 * 1024 * 1024

/** Maximum entries in a `task.subscribe` `afterSequences` map (`sandpane_service::MAX_SUBSCRIBE_CURSORS`). */
const val MAX_SUBSCRIBE_CURSORS: Int = 4096

/**
 * Maximum UTF-8 BYTE length of an `afterSequences` key; mirrors `sandpane_service::MAX_CURSOR_KEY_LEN`.
 * Rust measures `str::len()` (bytes), not characters, so the guard below must count bytes too.
 */
const val MAX_CURSOR_KEY_LEN: Int = 100

/**
 * Maximum length of an id that merely SCOPES a read (`projectId`, `conversationId`); mirrors
 * `sandpane_service::MAX_SCOPING_ID_LEN`. Core validates it through `Validator::display_text`,
 * which counts CHARACTERS — a different unit from the cursor-key bound above.
 */
const val MAX_SCOPING_ID_LEN: Int = 200

/**
 * Response ceiling for one `task.subscribe` replay (`sandpane_service::MAX_SUBSCRIBE_BYTES`).
 * Core refuses a replay that cannot fit one frame with a structured `VALIDATION_FAILED` instead
 * of emitting a frame the client must reject; the refusal is recoverable, see [CoreErrorCodes].
 */
const val MAX_SUBSCRIBE_BYTES: Int = MAX_FRAME_BYTES - 64 * 1024

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
 *
 * [ALL] is an ORDERED list mirroring `Method::ALL` in Rust — the single list `CoreCapabilities.methods`
 * is derived from — because [labs.dkv.sandpane.core.ProtocolDriftGuardTest] compares order as well as
 * membership. The three additive protocol-v1 discovery methods (`conversation.list`,
 * `conversation.history`, `task.list`) and the two A1 sandbox-lifecycle methods (`sandbox.stop`,
 * `sandbox.remove`) sit at their Rust positions; nothing existing was renamed or removed.
 *
 * There is deliberately NO `sandbox.start`: sbx v0.47 has no `start` command (restart is the
 * interactive `sbx run --name`), so Core does not dispatch one and this client never sends one —
 * see [SANDBOX_START_UNSUPPORTED].
 */
object CoreMethods {
    const val SYSTEM_PROBE: String = "system.probe"
    const val PROJECT_CREATE: String = "project.create"
    const val PROJECT_LIST: String = "project.list"
    const val SANDBOX_LIST: String = "sandbox.list"
    const val SANDBOX_CREATE: String = "sandbox.create"

    /** A1: `sbx stop NAME` + `ls --json` re-query. Not destructive, so no confirmation token. */
    const val SANDBOX_STOP: String = "sandbox.stop"

    /** A1: two-step server-side confirmation (design 2026-10-09 §2) before `sbx rm`. */
    const val SANDBOX_REMOVE: String = "sandbox.remove"
    const val CONVERSATION_CREATE: String = "conversation.create"
    const val CONVERSATION_SEND: String = "conversation.send"
    const val CONVERSATION_LIST: String = "conversation.list"
    const val CONVERSATION_HISTORY: String = "conversation.history"
    const val TASK_CANCEL: String = "task.cancel"
    const val TASK_LIST: String = "task.list"
    const val TASK_SUBSCRIBE: String = "task.subscribe"
    const val GIT_REVIEW: String = "git.review"
    const val GIT_APPLY: String = "git.apply"

    /** Wire order of `Method::ALL` — 16 methods as of protocol-v1 addition A1. */
    val ALL: List<String> = listOf(
        SYSTEM_PROBE, PROJECT_CREATE, PROJECT_LIST, SANDBOX_LIST, SANDBOX_CREATE,
        SANDBOX_STOP, SANDBOX_REMOVE,
        CONVERSATION_CREATE, CONVERSATION_SEND, CONVERSATION_LIST, CONVERSATION_HISTORY,
        TASK_CANCEL, TASK_LIST, TASK_SUBSCRIBE, GIT_REVIEW, GIT_APPLY,
    )

    /**
     * The methods the protocol-v1 discovery revision ADDED, which a pre-discovery Core does NOT
     * dispatch.
     */
    val ADDITIVE_IN_V1: Set<String> = setOf(CONVERSATION_LIST, CONVERSATION_HISTORY, TASK_LIST)

    /** The methods addition A1 ADDED (design 2026-10-09 §3); a pre-A1 Core does NOT dispatch them. */
    val ADDITIVE_A1: Set<String> = setOf(SANDBOX_STOP, SANDBOX_REMOVE)

    /**
     * Every method beyond the eleven-method v1 baseline. Feature detection is mandatory for exactly
     * these — see [CoreCapabilities.advertises]: a call is refused locally, before a byte is written,
     * when the connected Core's `system.probe` does not list it (design 2026-10-09 §1 rule 3).
     */
    val REQUIRES_ADVERTISEMENT: Set<String> = ADDITIVE_IN_V1 + ADDITIVE_A1

    /**
     * The honest unsupported state for starting a sandbox (design 2026-10-09 §3 row A1). Shown to the
     * user verbatim; never turned into a request.
     */
    const val SANDBOX_START_UNSUPPORTED: String =
        "Start: not supported by sbx v0.47 (use `sbx run --name <name>` in a terminal)"

    /** Sent only to Core after this check; nothing here reaches a shell. */
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
    /**
     * Wire names of every method THIS Core actually dispatches, derived in Rust from
     * `Method::ALL` (never a hand-written list). Additive in protocol v1: a pre-discovery Core
     * omits it (`#[serde(default)]` on the Rust side), so an absent or empty list means
     * **"not advertised"**, never "everything".
     */
    val methods: List<String> = emptyList(),
    /**
     * A2, additive: optional protocol behaviours this Core implements, which a client cannot infer
     * from [methods] (a pre-A2 Core silently drops an unknown request field). Absent on an older
     * Core ⇒ EMPTY ⇒ nothing advertised. Deliberately a list of plain strings, not an enum: a feature
     * this build does not know is simply ignored, never a decode failure ([CoreFeatures]).
     */
    val features: List<String> = emptyList(),
) {
    val versionCompatible: Boolean get() = protocolVersion == PROTOCOL_VERSION

    /** Does THIS Core advertise the protocol feature [name]? Unknown names are just "no". */
    fun hasFeature(name: String): Boolean = features.contains(name)

    /**
     * Feature discovery: does THIS Core advertise `method`? A version number is not evidence —
     * `protocolVersion` stayed `1` across the discovery revision, so `task.list` and friends are
     * gated on this list instead of being assumed.
     */
    fun advertises(method: String): Boolean = methods.contains(method)

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
    /**
     * Host paths registered with this project (the `repositories` table's `canonical_path`,
     * insertion-ordered). Additive in protocol v1: a pre-revision Core omits it, so the Kotlin
     * default is the EMPTY list — "Core told me nothing", never "the project has no folders".
     *
     * Honest caveat carried from the Rust doc: `project.create` requires an ABSOLUTE path but
     * Core canonicalizes (resolves symlinks) at `sandbox.create` mount time, NOT at registration.
     * A client matching an IDE folder against these values must canonicalize BOTH sides — never
     * plain string-compare. See [labs.dkv.sandpane.services.SbxService.associateFolder].
     */
    val repositories: List<String> = emptyList(),
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
    /**
     * A1, additive: the built-in sbx agent to create the sandbox with. NULL keeps the key off the
     * wire (`explicitNulls = false`), and Core then uses the provider-free `shell` — so the request
     * an older Core sees is byte-identical to before. A value must be in [SbxAgents.V0_47]; anything
     * else (a sandbox-kit path, ZIP, git or OCI ref) is refused locally before sending
     * ([labs.dkv.sandpane.core.CoreGuards.optionalSbxAgent]) and by Core again.
     */
    val agent: String? = null,
    /**
     * A2, additive: retry-safety key, sent ONLY when Core advertises [CoreFeatures.IDEMPOTENCY_KEYS]
     * (a pre-A2 Core would silently drop it and promise a safety it does not have). NULL keeps the key
     * off the wire. One fresh key per user action; only an explicit "Retry safely" reuses it
     * ([labs.dkv.sandpane.core.IdempotencyKeys]).
     */
    @SerialName("idempotencyKey") val idempotencyKey: String? = null,
)

/**
 * The built-in agents of the pinned sbx v0.47.0 (`sbx create --help`, captured in Core's fixtures),
 * mirrored from `sandpane_core::validation::SBX_AGENTS_V0_47` and the `agent` enum of
 * `schemas/sandbox-create-spec.schema.json`; [labs.dkv.sandpane.core.ProtocolDriftGuardTest] pins
 * all three together.
 *
 * Being on this list is NOT a verification claim. Whether Sandpane has a verified adapter for an
 * agent is stated only by `CoreCapabilities.agents[].verified`.
 */
object SbxAgents {
    /** Core's default when `agent` is absent: no provider account, no sign-in. */
    const val DEFAULT: String = "shell"

    val V0_47: List<String> = listOf(
        "claude", "codex", "copilot", "cursor", "devin", "docker-agent", "droid", "gemini", "kiro",
        "opencode", "shell",
    )

    fun isAllowlisted(agent: String): Boolean = V0_47.contains(agent)

    /**
     * The label a create surface shows for [agent]. `shell` is the only provider-free choice;
     * every other entry says plainly that it is unverified and may need a provider sign-in inside
     * the sandbox (no provider credential is ever handled by this plugin).
     */
    fun label(agent: String): String =
        if (agent == DEFAULT) {
            "shell (provider-free)"
        } else {
            "$agent — agent not verified — may need provider sign-in inside the sandbox"
        }
}

@Serializable
data class SandboxSummary(
    val name: String,
    /** Last probed state — never assumed, never inferred from a cached row. */
    @SerialName("probedState") val probedState: String? = null,
    @SerialName("boundProjectId") val boundProjectId: String? = null,
    /**
     * The workspace mode recorded in Core's newest `sandbox_bindings` row for this name — a
     * RECORD of what Core was asked to bind, NOT a live SBX verification ([probedState] is the
     * probe). Additive in protocol v1.
     *
     * NULL means Core has no readable binding row for this name, and it never guesses one. A UI
     * that shows `probedState` with a null mode must render the mode as UNVERIFIED — never as
     * safe — because an unverified `direct_mount` mount writes straight through to host files
     * (docs/specs/02 §7). Do not default this to a benign mode; [WorkspaceModeView] is the
     * single place that turns absence into the explicit unverified label.
     *
     * A mode a newer Core added is [Reported.Unknown] and gets the same worst-case
     * (live-writable, never isolated) rendering — see [WorkspaceModeView.forSandbox].
     */
    @Serializable(with = ReportedWorkspaceModeSerializer::class)
    @SerialName("workspaceMode") val workspaceMode: Reported<WorkspaceMode>? = null,
    /**
     * A1, additive: the agent `sbx ls --json` reports for this sandbox — a probed FACT, never a
     * verification claim (`CoreCapabilities.agents[].verified` is the only such claim). NULL when
     * sbx reported none or the Core predates A1; shown as "not reported", never guessed.
     */
    val agent: String? = null,
    /**
     * A2, additive: `true` when this is Core's STORED first response to an earlier identical keyed
     * `sandbox.create`, returned instead of running again. It is NOT current state (the sandbox may
     * since have been stopped or removed): the UI shows the replay notice and re-reads `sandbox.list`.
     * Absent on a first response.
     */
    val replayed: Boolean? = null,
) {
    /** Presentation of the mode exactly as Core reported it (absent ⇒ unverified, never safe). */
    fun modeView(): WorkspaceModeView = WorkspaceModeView.forSandbox(this)
}

/** `sandbox.stop` params (A1). Not destructive: no confirmation token. */
@Serializable
data class SandboxStopParams(val name: String)

/**
 * The protocol features this client build knows (A2; mirror of `sandpane_protocol::FEATURES` and the
 * `features.items.examples` of `schemas/core-capabilities.schema.json`, pinned together by
 * `ProtocolDriftGuardTest`). Any other string a Core advertises is ignored.
 */
object CoreFeatures {
    /** `sandbox.create` / `conversation.send` honour `idempotencyKey` (design 2026-10-09 §3.1). */
    const val IDEMPOTENCY_KEYS: String = "idempotency-keys"

    /** `sandbox.create` honours `agent` (A1). Replaces the old "sandbox.remove is advertised" inference. */
    const val SANDBOX_CREATE_AGENT: String = "sandbox-create-agent"

    val KNOWN: List<String> = listOf(IDEMPOTENCY_KEYS, SANDBOX_CREATE_AGENT)
}

/**
 * `sandbox.stop` result. `stopped: true` only says `sbx stop` exited 0. The state is whatever the
 * post-stop re-query reports in [requeried]; ABSENT means the sandbox is no longer listed or the
 * re-query failed, and the UI must then say the state is UNKNOWN — never "stopped" (specs/02 §5:
 * exit 0 is not desired state).
 */
@Serializable
data class SandboxStopResult(
    val stopped: Boolean,
    val requeried: SandboxSummary? = null,
)

/**
 * `sandbox.remove` params (A1, two-step confirmation). Step 1 leaves [confirmToken] NULL, so the key
 * is absent on the wire and Core changes nothing; step 2 carries the token step 1 issued.
 */
@Serializable
data class SandboxRemoveParams(
    val name: String,
    @SerialName("confirmToken") val confirmToken: String? = null,
) {
    /** The token is a single-use secret: never printed, even from a debug or error path. */
    override fun toString(): String =
        "SandboxRemoveParams(name=$name, confirmToken=${if (confirmToken == null) "absent" else "<redacted>"})"
}

/** The identity a confirmation token is bound to: the name AND the sbx id it had at issue. */
@Serializable
data class ConfirmationTarget(val name: String, val id: String)

/**
 * Core's server-side destructive-action confirmation (design 2026-10-09 §2).
 *
 * [token] is a single-use secret: it is never rendered, logged or put in a notification, and
 * [toString] redacts it so no error path can print it by accident.
 */
@Serializable
data class ConfirmationRequest(
    val token: String,
    /** RFC 3339 UTC; Core's TTL is 120 s. Shown to the user, and checked before step 2 is sent. */
    @SerialName("expiresAt") val expiresAt: String,
    val action: String,
    val target: ConfirmationTarget,
    val impact: List<String> = emptyList(),
    /**
     * True when Core cannot confirm Sandpane created the target: no Sandpane binding is recorded for
     * this sbx id. Not proof it was made outside Sandpane — a pre-A1 binding without a recorded sbx id,
     * or a binding for an earlier sandbox of the same name, also reads as `true`. Shown prominently.
     */
    val external: Boolean,
) {
    override fun toString(): String =
        "ConfirmationRequest(token=<redacted>, expiresAt=$expiresAt, action=$action, target=$target, " +
            "impact=${impact.size} line(s), external=$external)"
}

/**
 * `sandbox.remove` result: exactly one field is present — [confirmation] for step 1 (nothing
 * changed), [removed] for step 2.
 */
@Serializable
data class SandboxRemoveResult(
    val confirmation: ConfirmationRequest? = null,
    val removed: Boolean? = null,
)

/** Workspace mapping modes (specs/02 §7). */
@Serializable
enum class WorkspaceMode : WireEnum {
    /** Live-writable: edits are already on the host and must be labeled as such in every UI
     * surface (docs/specs/02 §7). */
    @SerialName("direct_mount") DIRECT_MOUNT,

    @SerialName("sbx_clone") SBX_CLONE,
    @SerialName("host_worktree") HOST_WORKTREE,
    @SerialName("mountless") MOUNTLESS;

    /** The exact `@SerialName`, read from the generated serializer rather than re-derived. */
    override val wireName: String get() = serializer().descriptor.getElementName(ordinal)

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

/**
 * `conversation.list` params — read-only chat enumeration (ADDITIVE protocol v1).
 *
 * Every field is optional: absent `projectId` means "every conversation Core knows about", and
 * absent `limit` means "Core's own [DEFAULT_LIST_LIMIT]". A wrapper must therefore keep the
 * field null rather than inventing a value — see [labs.dkv.sandpane.core.CoreCommands].
 */
@Serializable
data class ConversationListParams(
    @SerialName("projectId") val projectId: String? = null,
    /** Rows to return; Core clamps to `1..=[MAX_LIST_LIMIT]` and defaults to 200. */
    val limit: Int? = null,
)

/**
 * `conversation.history` params — bounded transcript read (ADDITIVE protocol v1).
 *
 * `conversationId` is REQUIRED on the wire (`conversation.history` on an unknown or archived
 * conversation is Core's `NOT_FOUND`, never an empty-but-successful answer that reads as
 * "no messages").
 */
@Serializable
data class ConversationHistoryParams(
    @SerialName("conversationId") val conversationId: String,
    /** Return messages strictly after this per-conversation sequence; negative ⇒ Core reads 0. */
    @SerialName("afterSequence") val afterSequence: Long = 0,
    val limit: Int? = null,
)

/**
 * One stored chat message (the `messages` table). Content is data, never a command: it is
 * rendered as plain text and is never interpreted (docs/specs/02 §3).
 */
@Serializable
data class MessageRecord(
    val id: String,
    @SerialName("conversationId") val conversationId: String,
    val role: String,
    val content: String,
    val sequence: Long,
)

/**
 * `conversation.history` result — an OBJECT, not a bare array, because BOTH bounds are
 * disclosed. When the row limit OR the [MAX_HISTORY_BYTES] ceiling stopped the scan,
 * [truncated] is true and [nextSequence] is the last sequence actually returned, so paging
 * forward cannot lose rows.
 */
@Serializable
data class ConversationHistoryResult(
    /**
     * REQUIRED, with no Kotlin default. Rust always serialises it, so a frame without `messages`
     * is a broken answer, not an empty transcript: defaulting it here would let a malformed page
     * render as "Core reports no messages" (AGENTS.md rule 5).
     */
    val messages: List<MessageRecord>,
    val truncated: Boolean,
    /** Highest sequence returned, or the request cursor when nothing was returned. */
    @SerialName("nextSequence") val nextSequence: Long,
) {
    /**
     * How to say "the page filled up" honestly. A byte-ceiling stop and a row-limit stop are
     * indistinguishable from the frame alone, so the disclosure names both possibilities rather
     * than guessing one (AGENTS.md rule 5).
     */
    fun truncationNote(): String? = when {
        !truncated -> null
        messages.isEmpty() ->
            "Core returned no rows yet reports more remain — the transcript cannot be read from " +
                "here; retry from the same cursor and narrow the request."

        else ->
            "${messages.size} message(s) returned and Core says more remain (stopped by the row " +
                "limit or the ${MAX_HISTORY_BYTES / 1024 / 1024} MiB content ceiling — the frame " +
                "does not say which). Continue from sequence $nextSequence."
    }
}

@Serializable
data class ConversationSendParams(
    @SerialName("conversationId") val conversationId: String,
    val content: String,
    val attachments: List<ContextRef> = emptyList(),
    /** A2, additive: see [SandboxCreateSpec.idempotencyKey]; the same rules apply. */
    @SerialName("idempotencyKey") val idempotencyKey: String? = null,
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
    /**
     * Per-task replay cursors for a project-wide (or global) replay: task id → last sequence the
     * client has durably seen for THAT task. Additive in protocol v1; sequences are not
     * comparable across tasks, which is why one shared scalar could skip a quieter task's events
     * (the recorded v1 gap in docs/compatibility.md).
     *
     * NULL means "no map at all" — Core then applies the shared [afterSequence] scalar to every
     * task, exactly the legacy behaviour. Absence must stay absence: an empty map is NOT the same
     * request as no map (Core would replay every named-in-scope task from 0), so
     * [labs.dkv.sandpane.core.CoreCommands.taskSubscribe] refuses to put an empty map on the wire.
     *
     * IGNORED by Core whenever [taskId] is set (the scalar is that task's cursor).
     */
    @SerialName("afterSequences") val afterSequences: Map<String, Long>? = null,
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
enum class TaskStatus : WireEnum {
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

    override val wireName: String get() = serializer().descriptor.getElementName(ordinal)

    /** Terminal for display purposes only — never a client-side transition. */
    val isTerminal: Boolean
        get() = this == COMPLETED || this == REJECTED || this == FAILED ||
            this == CANCELLED || this == INTERRUPTED
}

/**
 * `task.list` params — read-only discovery of Core task state (ADDITIVE protocol v1).
 *
 * This is the method that removes the old client-side workaround: a project's tasks can be
 * enumerated without replaying the whole event log, and a *checkpointed* poll can now see a
 * brand-new task (whose sequence restarts at 1).
 */
@Serializable
data class TaskListParams(
    /** Scope to one project (tasks reached through its conversations). Absent = every task. */
    @SerialName("projectId") val projectId: String? = null,
    /**
     * Only tasks currently in one of these statuses. These are Core's OWN stored values;
     * an unknown status string is refused, never normalized (AGENTS.md rule 3 — the client does
     * not get to invent a state).
     */
    val statuses: List<TaskStatus> = emptyList(),
    /** Rows to return; Core clamps to `1..=[MAX_LIST_LIMIT]` and defaults to 200. */
    val limit: Int? = null,
)

/** Core's one task row, exactly as stored. Read and displayed here; never advanced here. */
@Serializable
data class TaskSummary(
    val id: String,
    @SerialName("conversationId") val conversationId: String,
    /** Core's stored status; one a newer Core added is [Reported.Unknown], shown as such. */
    @Serializable(with = ReportedTaskStatusSerializer::class)
    val status: Reported<TaskStatus>,
    @SerialName("sandboxName") val sandboxName: String? = null,
    @SerialName("taskBranch") val taskBranch: String? = null,
    @SerialName("baseCommit") val baseCommit: String? = null,
    /**
     * A2, additive: `true` when this is Core's STORED first answer to an earlier identical keyed
     * `conversation.send`. Its [status] is what it was THEN (a `queued` task may since have been
     * reconciled to `interrupted`), so it is never shown as current; the UI re-reads `task.list`.
     */
    val replayed: Boolean? = null,
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
    /**
     * A status a newer Core added is [Reported.Unknown]: the file is listed with its raw status
     * but is never selectable for apply ([labs.dkv.sandpane.services.ApplyPlan]).
     */
    @Serializable(with = ReportedFileChangeStatusSerializer::class)
    val status: Reported<FileChangeStatus>,
)

@Serializable
enum class FileChangeStatus : WireEnum {
    @SerialName("added") ADDED,
    @SerialName("modified") MODIFIED,
    @SerialName("deleted") DELETED,
    @SerialName("renamed") RENAMED,
    @SerialName("untracked") UNTRACKED;

    override val wireName: String get() = serializer().descriptor.getElementName(ordinal)
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
