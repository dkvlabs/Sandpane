// Tolerant decoding of the wire enums Core may EXTEND in a newer, compatible protocol revision.
//
// A plain @Serializable enum fails the whole frame on a value it does not define, so one new
// `TaskStatus` from a newer Core used to fail an entire `task.list`, `git.review`, `sandbox.list`
// or — worst — a `conversation.send` AFTER Core had already queued the task (inviting a duplicate
// retry). Each such field now decodes into [Reported]: the known enum value, or an explicit
// [Reported.Unknown] carrying the raw wire string, which every consumer must render visibly and
// must never treat as a known state (AGENTS.md rule 5).
//
// What still fails, on purpose: a value that is not a JSON string (number, object, null where
// the field is required) or a string that is not a plausible enum wire name (empty, longer than
// [MAX_UNKNOWN_WIRE_NAME_LEN], or not snake_case). Every Rust enum mirrored here is
// `#[serde(rename_all = "snake_case")]` — `ProtocolDriftGuardTest` pins that — so anything else is
// a malformed frame, not a newer Core.
package labs.dkv.sandpane.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/** A wire enum mirrored from `sandpane-protocol`; [wireName] is its exact `@SerialName`. */
interface WireEnum {
    val wireName: String
}

/** A wire-enum value as Core reported it: one this plugin build defines, or one it does not. */
sealed interface Reported<out E : WireEnum> {
    /** The exact string Core sent. */
    val wireName: String

    data class Known<out E : WireEnum>(val value: E) : Reported<E> {
        override val wireName: String get() = value.wireName
    }

    /**
     * A value a newer Core sent that this plugin build does not define. [wireName] has passed the
     * snake_case/length check, so it is safe to show verbatim; it is never mapped to a known value.
     */
    data class Unknown(override val wireName: String) : Reported<Nothing>
}

/** Wrap a known value — for building fixtures and outgoing comparisons. */
fun <E : WireEnum> E.reported(): Reported<E> = Reported.Known(this)

/** The known value, or null when Core sent one this build does not define. */
val <E : WireEnum> Reported<E>.knownOrNull: E?
    get() = (this as? Reported.Known<E>)?.value

/** Longest raw value accepted as "unknown but plausible"; longer is a malformed frame. */
const val MAX_UNKNOWN_WIRE_NAME_LEN: Int = 64

/** The serde `snake_case` shape every mirrored Rust enum variant has on the wire. */
private val SNAKE_CASE_WIRE_NAME = Regex("^[a-z][a-z0-9]*(_[a-z0-9]+)*$")

/**
 * Decodes a JSON string into [Reported]: [Reported.Known] for a defined `@SerialName`,
 * [Reported.Unknown] for a plausible new one, and a [SerializationException] for anything else.
 */
abstract class ReportedEnumSerializer<E>(
    serialName: String,
    entries: List<E>,
) : KSerializer<Reported<E>> where E : Enum<E>, E : WireEnum {

    private val byWireName: Map<String, E> = entries.associateBy { it.wireName }

    /** The wire names this build knows, in declaration order (pinned against Rust by tests). */
    val knownWireNames: List<String> = entries.map { it.wireName }

    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor(serialName, PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): Reported<E> {
        // decodeString refuses a number, boolean, object or null token: still a malformed frame.
        val raw = decoder.decodeString()
        byWireName[raw]?.let { return Reported.Known(it) }
        if (raw.length > MAX_UNKNOWN_WIRE_NAME_LEN || !SNAKE_CASE_WIRE_NAME.matches(raw)) {
            throw SerializationException(
                "'${descriptor.serialName}' got a value that is neither known nor a plausible newer " +
                    "snake_case variant (${raw.length} chars); refusing the frame",
            )
        }
        return Reported.Unknown(raw)
    }

    override fun serialize(encoder: Encoder, value: Reported<E>) {
        encoder.encodeString(value.wireName)
    }
}

object ReportedTaskStatusSerializer :
    ReportedEnumSerializer<TaskStatus>("labs.dkv.sandpane.model.Reported.TaskStatus", TaskStatus.entries)

object ReportedFileChangeStatusSerializer :
    ReportedEnumSerializer<FileChangeStatus>(
        "labs.dkv.sandpane.model.Reported.FileChangeStatus",
        FileChangeStatus.entries,
    )

object ReportedWorkspaceModeSerializer :
    ReportedEnumSerializer<WorkspaceMode>("labs.dkv.sandpane.model.Reported.WorkspaceMode", WorkspaceMode.entries)

// ---------------------------------------------------------------------------
// presentation helpers — wording only, no state logic (AGENTS.md rule 3)
// ---------------------------------------------------------------------------

/**
 * A task status for display. An unknown one says so loudly instead of passing for a real state.
 */
@JvmName("describeTaskStatus")
fun Reported<TaskStatus>.describe(): String = when (this) {
    is Reported.Known -> wireName
    is Reported.Unknown -> "Unknown status '$wireName' — this plugin is older than Core"
}

/**
 * Terminal for display purposes only. An unknown status is NEITHER terminal nor running: nothing
 * about it is assumed.
 */
val Reported<TaskStatus>.isTerminal: Boolean
    @JvmName("isTerminalTaskStatus")
    get() = knownOrNull?.isTerminal ?: false

/** A file change status for display; an unknown one is named and marked as not applicable. */
@JvmName("describeFileChangeStatus")
fun Reported<FileChangeStatus>.describe(): String = when (this) {
    is Reported.Known -> wireName
    is Reported.Unknown -> "unknown status '$wireName' (not selectable for apply)"
}
