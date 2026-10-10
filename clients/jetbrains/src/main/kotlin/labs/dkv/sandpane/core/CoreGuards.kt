// Client-side mirrors of the `sandpane_service` request guards.
//
// Why this exists: Core validates every value again — its verdict is the one that counts
// (docs/specs/06 §4). Refusing locally first is not a second authority, it is (a) a fast, clear
// explanation instead of a round trip, and (b) the AGENTS.md rule-2 guarantee that no
// externally-derived value reaches an argument position unvalidated.
//
// The bounds below are copied from `core/crates/sandpane-service/src/lib.rs` and are pinned by
// [labs.dkv.sandpane.core.ProtocolDriftGuardTest], which READS that file and fails if a constant
// or a wire name changes without a matching update here.
package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.MAX_CURSOR_KEY_LEN
import labs.dkv.sandpane.model.MAX_LIST_LIMIT
import labs.dkv.sandpane.model.MAX_SCOPING_ID_LEN
import labs.dkv.sandpane.model.MAX_SUBSCRIBE_CURSORS
import labs.dkv.sandpane.model.TaskStatus

/**
 * A refusal raised BEFORE a request leaves this client. It is deliberately not a
 * [CoreRpcException]: a local guard must never look like a verdict from Core (AGENTS.md rule 5).
 */
class CoreValidationException(val field: String, message: String) :
    Exception("$field: $message")

/**
 * A method the connected Core does not advertise. The request is never sent, so a pre-revision
 * Core is never asked to answer for a method it does not dispatch.
 */
class MethodNotSupportedException(val method: String, reason: String) :
    Exception("$method is not available on this Core: $reason")

/**
 * A request this plugin WITHHELD because Core's earlier refusal makes an identical retry incapable
 * of converging (an oversized project-wide replay). Nothing was sent this time, so this is
 * deliberately not a [CoreRpcException]: answering with Core's code again would present this
 * client's own circuit-breaker as a fresh verdict from Core (AGENTS.md rule 5). The refusal it
 * stands on is quoted, not softened.
 */
class ReplayPausedException(val coreRefusal: String) :
    Exception(
        "not sent by this plugin: a project-wide replay is paused behind Core's earlier refusal — $coreRefusal",
    )

object CoreGuards {

    /**
     * `sandpane_service::validate_scoping_id` → `Validator::display_text(value, MAX_SCOPING_ID_LEN)`.
     *
     * An id that only SCOPES a read must still be an id: non-empty, control-character-free, and
     * bounded in CHARACTERS (Rust counts `chars`, not bytes, here). A typo'd empty `projectId`
     * must be a structured refusal rather than a silently empty list that reads as "no tasks".
     */
    fun requireScopingId(value: String, field: String): String {
        if (value.isEmpty()) throw CoreValidationException(field, "value is empty")
        // Rust compares `chars().count()` = Unicode scalar values; `String.length` is
        // UTF-16 code units, so an astral-plane id would be refused here but accepted
        // by Core. Count code points to stay equivalent (AGENTS.md rule 2).
        if (value.codePointCount(0, value.length) > MAX_SCOPING_ID_LEN) {
            throw CoreValidationException(field, "value exceeds max length $MAX_SCOPING_ID_LEN")
        }
        for (ch in value) {
            val code = ch.code
            if (code < 0x20 && ch != '\n' && ch != '\t') {
                throw CoreValidationException(field, "contains a disallowed control character U+${code.toString(16)}")
            }
            if (code == 0x7f) {
                throw CoreValidationException(field, "contains a disallowed character U+7f")
            }
        }
        return value
    }

    /**
     * `sandpane_service::optional_scoping_id` — absent means unscoped; an empty or blank string
     * is a client bug and is refused.
     *
     * @return the validated value, or null when the caller asked for no scope. The wrapper then
     *   OMITS the key instead of sending null, so absence stays absence on the wire.
     */
    fun optionalScopingId(value: String?, field: String): String? {
        if (value == null) return null
        if (value.isBlank()) throw CoreValidationException(field, "identifier is required")
        return requireScopingId(value, field)
    }

    /** A required id (conversation/task): blank is a client bug, never a Core query. */
    fun requireId(value: String, field: String): String {
        if (value.isBlank()) throw CoreValidationException(field, "identifier is required")
        return requireScopingId(value, field)
    }

    /**
     * `sandpane_service::clamp_limit` — absent → Core's own default (so the key is omitted and
     * Core's default is the one that applies); anything else is clamped into `1..=500`.
     *
     * A negative limit is refused locally: `limit` is a `u32` on the wire, so `-5` would be a
     * parse-time `VALIDATION_FAILED` at Core and must not leave here looking like a request.
     */
    fun clampLimit(limit: Int?): Int {
        if (limit == null) return DEFAULT_ROWS
        if (limit < 0) throw CoreValidationException("limit", "limit must not be negative")
        return limit.coerceIn(1, MAX_LIST_LIMIT)
    }

    /**
     * The limit the wrapper puts on the wire. Core's `clamp_limit(None)` is 200 and its
     * `clamp_limit(Some(1..500))` is the value itself, so sending the resolved number is
     * behaviour-identical to omitting it while keeping the row budget VISIBLE to the caller —
     * which matters here because the JB transcript pager compares `limit` against the returned
     * message count to detect a byte-ceiling stop.
     */
    fun effectiveLimit(limit: Int?): Int = clampLimit(limit)

    private const val DEFAULT_ROWS = 200

    /**
     * `sandpane_service::validate_cursor_map` — bounded entries, non-empty id-sized keys.
     *
     * Key length is measured in UTF-8 BYTES because Rust's bound is `str::len()`. Values are
     * normalised exactly like Core's `.max(0)` (a negative cursor means "from the start", which
     * is what 0 already does).
     *
     * @return the validated+normalised map, or null when no map was supplied. An EMPTY map is
     *   refused rather than dropped: with a `taskId`-less request, `{}` means "replay every task
     *   in full" while absence means "apply the shared scalar" — collapsing them would silently
     *   change what the user sees after a reconnect.
     */
    fun validateCursorMap(map: Map<String, Long>?): Map<String, Long>? {
        if (map == null) return null
        if (map.isEmpty()) {
            throw CoreValidationException(
                "afterSequences",
                "an empty map is not the same request as no map — omit it for the shared " +
                    "afterSequence, or supply the cursors you actually have",
            )
        }
        if (map.size > MAX_SUBSCRIBE_CURSORS) {
            throw CoreValidationException(
                "afterSequences",
                "has ${map.size} entries, the bound is $MAX_SUBSCRIBE_CURSORS",
            )
        }
        val out = LinkedHashMap<String, Long>(map.size)
        for ((key, value) in map) {
            if (key.isEmpty() || key.toByteArray(Charsets.UTF_8).size > MAX_CURSOR_KEY_LEN) {
                throw CoreValidationException("afterSequences", "key must be 1..=$MAX_CURSOR_KEY_LEN bytes")
            }
            out[key] = value.coerceAtLeast(0L)
        }
        return out
    }

    /**
     * `sandpane_core::validation::Validator::sandbox_name` — the rule Core applies to a name it must
     * ADDRESS (`sandbox.stop` / `sandbox.remove`), which is the `sbx v0.47 --name` rule: 2..=128
     * characters, ASCII letters, digits, `-` and `.` only, a letter or digit first (so no value can be
     * read as an option), and not the reserved `default`.
     *
     * Deliberately LOOSER than the create-spec schema pattern (lowercase, no `.`): sandboxes sbx named
     * itself, or that were created outside Sandpane, must still be stoppable and removable. A name
     * that fails here never reaches the wire (AGENTS.md rule 2); Core validates it again.
     */
    fun requireAddressableSandboxName(name: String): String {
        if (name.isEmpty()) throw CoreValidationException("name", "sandbox name is empty")
        if (name.length > MAX_SANDBOX_NAME_LEN) {
            throw CoreValidationException("name", "sandbox name exceeds max length $MAX_SANDBOX_NAME_LEN")
        }
        if (name.length < 2) throw CoreValidationException("name", "sandbox name must be at least two characters")
        if (!name.all { it.isAsciiAlphanumeric() || it == '-' || it == '.' }) {
            throw CoreValidationException("name", "sandbox name may contain only ASCII letters, digits, '-' and '.'")
        }
        if (!name[0].isAsciiAlphanumeric()) {
            throw CoreValidationException("name", "sandbox name must start with an ASCII letter or digit")
        }
        if (name.equals("default", ignoreCase = true)) {
            throw CoreValidationException("name", "'default' is a reserved sandbox name")
        }
        return name
    }

    /** Mirrors Core's 128-character sanity bound on an addressed sandbox name. */
    const val MAX_SANDBOX_NAME_LEN: Int = 128

    private fun Char.isAsciiAlphanumeric(): Boolean = this in 'a'..'z' || this in 'A'..'Z' || this in '0'..'9'

    /**
     * `SandboxCreateSpec.agent` (A1): absent stays absent (Core defaults to `shell`); a present value
     * must be an exact built-in agent of the pinned sbx ([labs.dkv.sandpane.model.SbxAgents.V0_47]).
     * Sandbox-kit references — local paths, ZIPs, git or OCI refs — run third-party code and are
     * refused here as well as in Core.
     */
    fun optionalSbxAgent(agent: String?): String? {
        if (agent == null) return null
        if (!labs.dkv.sandpane.model.SbxAgents.isAllowlisted(agent)) {
            throw CoreValidationException(
                "agent",
                "not a built-in sbx v0.47 agent (allowed: ${labs.dkv.sandpane.model.SbxAgents.V0_47.joinToString(", ")})",
            )
        }
        return agent
    }

    /** Shape of a Core confirmation token: 256 random bits as 64 lowercase hex characters. */
    private val CONFIRM_TOKEN: Regex = Regex("^[0-9a-f]{64}$")

    /** Whether [token] has the exact shape Core issues; anything else is never sent back. */
    fun isConfirmTokenShape(token: String): Boolean = CONFIRM_TOKEN.matches(token)

    /**
     * `task.list.statuses` are Core's OWN stored values, deserialized into a closed enum — an
     * unknown string is `VALIDATION_FAILED`, never normalized into a state that happens to
     * exist. Duplicates are collapsed here because they mean nothing in an SQL IN-list, and
     * collapsing keeps the bound-parameter count finite (Rust does the same).
     */
    fun dedupeStatuses(statuses: List<TaskStatus>?): List<TaskStatus> =
        statuses?.distinct() ?: emptyList()

    /**
     * Whether one event-sequence replay was refused by Core as too large to deliver.
     *
     * Core's `MAX_SUBSCRIBE_BYTES` guard answers `VALIDATION_FAILED` with a message of the shape
     * `replay of N task(s) passed the <ceiling>-byte ceiling …; narrow the request …`
     * (`sandpane-service::task_subscribe`). Matching that shape rather than one whole sentence
     * keeps this robust if Core rewords the guidance, while still refusing to treat an ordinary
     * `VALIDATION_FAILED` (a bad id, a bad status) as the same thing.
     *
     * This is RECOGNITION only. The caller decides what to do — narrow the request, resync from a
     * cursor, or tell the user — because retrying the identical oversized request can never
     * converge.
     */
    fun isOversizedReplayRefusal(code: String?, message: String?): Boolean =
        code == CoreErrorCodes.VALIDATION_FAILED &&
            message != null &&
            message.startsWith("replay of ") &&
            message.contains("ceiling") &&
            message.contains("narrow the request")

    /** Core's own words, attributed to Core — the refusal is never softened into a warning. */
    fun describeOversizedReplay(message: String?): String =
        "Core refused this replay as too large to fit one IPC frame" +
            (if (message == null) "" else ": $message") +
            " Narrowing it (per-task cursors from a newer checkpoint, a single taskId, or a full " +
            "resync) changes what is fetched, so it is a user decision and nothing is retried " +
            "automatically."
}
