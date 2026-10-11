// Protocol-v1 addition A2 (design 2026-10-09 §3.1): idempotency keys for the two write methods
// that create something — `sandbox.create` and `conversation.send` — plus the `features` gate.
//
// Rules this file encodes, all pure so they are unit-tested as shipped:
//   * a key is sent ONLY when Core advertises "idempotency-keys" (a pre-A2 Core silently drops an
//     unknown field, so a key sent to it would promise a safety it does not have);
//   * one fresh 128-bit key per user action, from SecureRandom, never derived from content;
//   * only an explicit "Retry safely" reuses a key, with byte-identical params — never automatically;
//   * CONFLICT texts are matched against Core's own strings (pinned by ProtocolDriftGuardTest) and
//     worded without claiming more than Core knows: "nothing was run" for mismatch / pending / the
//     name lock, "outcome unknown" for an earlier request whose outcome Core lost;
//   * a replayed answer is announced as such and is never presented as fresh or current.
package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.ConversationSendParams
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreFeatures
import labs.dkv.sandpane.model.SandboxCreateSpec
import labs.dkv.sandpane.text.VisibleText
import java.security.SecureRandom
import java.util.concurrent.TimeoutException

/** Key minting and the exact Core rule for a key's shape. */
object IdempotencyKeys {

    /** Core's bound (`Validator::idempotency_key`): 1..=128 bytes. */
    const val MAX_LEN: Int = 128

    private val random = SecureRandom()

    /** One fresh key: 16 bytes from a CSPRNG as 32 lowercase hex characters. */
    fun fresh(): String {
        val bytes = ByteArray(16)
        synchronized(random) { random.nextBytes(bytes) }
        return bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    /**
     * Exactly Core's rule — never stricter: 1..=128 characters from `[A-Za-z0-9._-]` (all ASCII, so
     * characters and bytes coincide).
     */
    fun isValid(key: String): Boolean =
        key.length in 1..MAX_LEN && key.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '.' || it == '_' || it == '-' }
}

/** Builds the params for one user action, or for an explicit "Retry safely" of that action. */
object KeyedRequests {

    sealed class Prepared<P> {
        data class Ready<P>(val params: P) : Prepared<P>()

        /** Nothing is sent; [reason] is this plugin's word; [field] names the request field it is about. */
        data class Refused<P>(val reason: String, val field: String = "idempotencyKey") : Prepared<P>()
    }

    private fun keysAdvertised(caps: CoreCapabilities?): Boolean = caps?.hasFeature(CoreFeatures.IDEMPOTENCY_KEYS) == true

    /**
     * A NEW `sandbox.create` action. The agent choice is honoured only when Core advertises
     * [CoreFeatures.SANDBOX_CREATE_AGENT] (A2 replaces A1's "sandbox.remove is advertised" inference);
     * otherwise it is refused locally rather than silently ignored by Core. A fresh key is attached
     * only when Core advertises [CoreFeatures.IDEMPOTENCY_KEYS].
     */
    fun newCreate(
        spec: SandboxCreateSpec,
        caps: CoreCapabilities?,
        mint: () -> String = IdempotencyKeys::fresh,
    ): Prepared<SandboxCreateSpec> {
        if (spec.idempotencyKey != null) return Prepared.Refused(NEW_ACTION_HAS_KEY)
        if (spec.agent != null && caps?.hasFeature(CoreFeatures.SANDBOX_CREATE_AGENT) != true) {
            return Prepared.Refused(
                "this Core does not advertise '${CoreFeatures.SANDBOX_CREATE_AGENT}', so it would ignore the " +
                    "agent choice and create a different sandbox than the one chosen; nothing was sent",
            )
        }
        return Prepared.Ready(if (keysAdvertised(caps)) spec.copy(idempotencyKey = mint()) else spec)
    }

    /** A NEW `conversation.send` action: a fresh key when advertised, none otherwise. */
    fun newSend(
        params: ConversationSendParams,
        caps: CoreCapabilities?,
        mint: () -> String = IdempotencyKeys::fresh,
    ): Prepared<ConversationSendParams> {
        if (params.idempotencyKey != null) return Prepared.Refused(NEW_ACTION_HAS_KEY)
        SendModes.refusal(params, caps)?.let { return Prepared.Refused(it, field = "mode") }
        return Prepared.Ready(if (keysAdvertised(caps)) params.copy(idempotencyKey = mint()) else params)
    }

    /** "Retry safely" of a create: the identical spec, same key. */
    fun retryCreate(previous: SandboxCreateSpec, caps: CoreCapabilities?): Prepared<SandboxCreateSpec> =
        retryGate(previous.idempotencyKey, caps)?.let { Prepared.Refused(it) } ?: Prepared.Ready(previous)

    /** "Retry safely" of a send: the identical params, same key. */
    fun retrySend(previous: ConversationSendParams, caps: CoreCapabilities?): Prepared<ConversationSendParams> =
        retryGate(previous.idempotencyKey, caps)?.let { Prepared.Refused(it) }
            // A4: a reconnect to a pre-A4 Core would drop `mode` and record a task.
            ?: SendModes.refusal(previous, caps)?.let { Prepared.Refused(it, field = "mode") }
            ?: Prepared.Ready(previous)

    /**
     * Why a resend would NOT be safe, or null when it is. Without a key a resend could run twice;
     * and if the connection now reaches a Core that does not advertise keys (a downgrade across a
     * reconnect), that Core would drop the key and could run it twice too.
     */
    private fun retryGate(key: String?, caps: CoreCapabilities?): String? = when {
        key == null -> "this request carried no idempotency key, so a resend could run it twice; nothing was sent"
        !IdempotencyKeys.isValid(key) -> "this request's idempotency key is not in Core's format; nothing was sent"
        !keysAdvertised(caps) ->
            "the connected Core does not advertise '${CoreFeatures.IDEMPOTENCY_KEYS}', so it would ignore the key " +
                "and a resend could run twice; nothing was sent"
        else -> null
    }

    private const val NEW_ACTION_HAS_KEY =
        "a new action mints its own idempotency key; only \"Retry safely\" reuses one — nothing was sent"
}

/** Classification and wording of a keyed write's failure, plus the replay notice. */
object KeyedWrites {

    /** Core's `IDEM_MSG_MISMATCH`, verbatim. */
    const val CONFLICT_MISMATCH: String =
        "idempotency key was already used with different parameters; nothing was run"

    /** Core's `IDEM_MSG_PENDING`, verbatim. */
    const val CONFLICT_PENDING: String =
        "an operation with this idempotency key is still in progress; nothing was run"

    /** Start of Core's `IDEM_MSG_UNKNOWN` — the earlier request's outcome is unknown. */
    const val CONFLICT_UNKNOWN_PREFIX: String =
        "the outcome of the earlier request with this idempotency key is unknown"

    /** A1's per-name lock CONFLICT: `another operation on sandbox "<name>" is in progress; nothing was run`. */
    const val NAME_LOCK_PREFIX: String = "another operation on sandbox "
    const val NAME_LOCK_SUFFIX: String = " is in progress; nothing was run"

    /** The one user action that reuses a key (exact shared label). */
    const val RETRY_SAFELY_LABEL: String = "Retry safely"

    /** Shown whenever Core answers with `replayed: true` (the exact shared wording). */
    const val REPLAY_NOTICE: String =
        "Core returned the result of your earlier identical request (replayed). It may be out of date; refreshing from Core."

    /** Core text shown inside a message is revealed single-line and capped to this many characters. */
    const val MAX_CORE_TEXT: Int = 300

    sealed class Failure {
        /** Refused before anything ran — by Core (CONFLICT 1, 2, name lock) or locally before sending. */
        data class NothingRan(val coreMessage: String?, val local: Throwable? = null) : Failure()

        /** CONFLICT 3: Core does not know whether the EARLIER request with this key ran. */
        data class EarlierOutcomeUnknown(val coreMessage: String) : Failure()

        /** This request may or may not have run: no usable answer, or Core INTERNAL. */
        data class OutcomeUnknown(val cause: Throwable?) : Failure()

        /** Any other Core verdict — Core's word, no claim either way about what ran. */
        data class CoreRefused(val code: String, val coreMessage: String) : Failure()
    }

    fun classify(error: Throwable?): Failure {
        val t = ErrorAttribution.unwrap(error)
        return when {
            t is CoreValidationException || t is MethodNotSupportedException -> Failure.NothingRan(null, t)
            t is CoreRpcException && !t.raisedByCore -> Failure.OutcomeUnknown(t)
            t is CoreRpcException && t.code == CoreErrorCodes.INTERNAL -> Failure.OutcomeUnknown(t)
            t is CoreRpcException && t.code == CoreErrorCodes.CONFLICT -> classifyConflict(t.message)
            t is CoreRpcException -> Failure.CoreRefused(t.code, t.message)
            // Timeout, transport loss, anything else: the request may have reached Core.
            else -> Failure.OutcomeUnknown(t)
        }
    }

    private fun classifyConflict(message: String): Failure = when {
        message.startsWith(CONFLICT_MISMATCH) || message.startsWith(CONFLICT_PENDING) -> Failure.NothingRan(message)
        message.startsWith(NAME_LOCK_PREFIX) && message.endsWith(NAME_LOCK_SUFFIX) -> Failure.NothingRan(message)
        message.startsWith(CONFLICT_UNKNOWN_PREFIX) -> Failure.EarlierOutcomeUnknown(message)
        else -> Failure.CoreRefused(CoreErrorCodes.CONFLICT, message)
    }

    /** The user-facing text, and whether "Retry safely" may be offered for it. */
    data class Text(val title: String, val body: String, val severity: OutcomeSeverity, val offerRetrySafely: Boolean)

    /**
     * @param keyed whether the failed request carried an idempotency key. "Retry safely" is offered
     *   ONLY for an unknown outcome of a keyed request: resending the same key then either replays
     *   the stored result or runs it for the first time — never twice (within Core's 24 h retention).
     */
    fun describe(method: String, failure: Failure, keyed: Boolean): Text = when (failure) {
        is Failure.NothingRan -> if (failure.local != null) {
            Text(
                ErrorAttribution.headline(method, failure.local),
                ErrorAttribution.describe(method, failure.local),
                OutcomeSeverity.WARNING,
                false,
            )
        } else {
            val core = coreText(failure.coreMessage)
            val why = when {
                failure.coreMessage!!.startsWith(CONFLICT_MISMATCH) ->
                    "this request's key was already used for a different request"
                failure.coreMessage.startsWith(CONFLICT_PENDING) ->
                    "the earlier request with this key is still in progress in Core"
                else -> "another operation on this sandbox is in progress"
            }
            Text(
                "Sandpane: $method not run",
                "Core refused CONFLICT — $why, so nothing was run for this request. Core said: $core",
                OutcomeSeverity.WARNING,
                false,
            )
        }

        is Failure.EarlierOutcomeUnknown -> Text(
            "Sandpane: $method outcome unknown",
            "Core refused CONFLICT — outcome unknown: Core cannot tell whether the earlier request with this " +
                "key ran (Core restarted or sbx failed while it ran). Re-read state before acting; a retry needs " +
                "a new request (a new action, which gets a new key). Core said: ${coreText(failure.coreMessage)}",
            OutcomeSeverity.ERROR,
            false,
        )

        is Failure.OutcomeUnknown -> if (keyed) {
            Text(
                "Sandpane: $method outcome unknown",
                "Outcome unknown: ${cause(failure.cause)}. It may have run in Core. \"Retry safely\" resends the " +
                    "identical request with the same key: if it already ran, Core returns that earlier result " +
                    "instead of running it again (Core keeps keys for 24 hours). Nothing is retried automatically.",
                OutcomeSeverity.ERROR,
                true,
            )
        } else {
            Text(
                "Sandpane: $method outcome unknown",
                "outcome unknown — check before trying again: ${cause(failure.cause)}. This Core does not " +
                    "advertise idempotency keys, so sending it again could run it twice.",
                OutcomeSeverity.ERROR,
                false,
            )
        }

        is Failure.CoreRefused -> Text(
            "Sandpane: $method refused by Core",
            "Core refused ${failure.code}: ${coreText(failure.coreMessage)}",
            OutcomeSeverity.ERROR,
            false,
        )
    }

    /** [REPLAY_NOTICE] when an answer is flagged `replayed: true`, otherwise null. */
    fun replayNotice(replayed: Boolean?): String? = if (replayed == true) REPLAY_NOTICE else null

    /** Core's text revealed single-line and capped, so it can neither fake lines nor bury the message. */
    fun coreText(message: String?): String {
        val shown = VisibleText.reveal(message ?: "no message")
        return if (shown.length <= MAX_CORE_TEXT) shown else shown.take(MAX_CORE_TEXT) + "… (${shown.length} chars)"
    }

    private fun cause(t: Throwable?): String = when (t) {
        is TimeoutException -> "no answer before the deadline"
        is CoreTransportException -> "the connection to Core failed (${coreText(t.message)}) — the request may or may not have reached Core"
        is CoreRpcException -> if (t.raisedByCore) {
            "Core reported ${t.code}: ${coreText(t.message)}"
        } else {
            "Core's reply was unusable (${coreText(t.message)})"
        }
        null -> "no answer"
        // Not a Core verdict: its message may quote the raw frame (kotlinx decode errors do), so it
        // is never shown — only the kind of failure.
        else -> "an unexpected ${t.javaClass.simpleName} while handling the answer (details not shown)"
    }

    /**
     * Decode a `sandbox.create` answer without ever echoing it: a shape mismatch becomes a fixed-text
     * [CoreRpcException] raised by THIS plugin (an unusable reply ⇒ outcome unknown).
     */
    fun decodeCreateAnswer(ok: kotlinx.serialization.json.JsonElement): labs.dkv.sandpane.model.SandboxSummary = try {
        labs.dkv.sandpane.model.CoreJson.decodeFromJsonElement(labs.dkv.sandpane.model.SandboxSummary.serializer(), ok)
    } catch (_: Exception) {
        throw CoreRpcException(
            CoreErrorCodes.INTERNAL,
            "Core's sandbox.create answer did not have the expected shape; its content is not shown",
            raisedByCore = false,
        )
    }
}

/**
 * One dispatched keyed write: the exact [params] that went out (so "Retry safely" can resend them
 * byte-identically) and the pending [result]. [idempotencyKey] is null when Core does not advertise
 * keys — then no "Retry safely" is ever offered.
 */
class KeyedCall<P, R>(val params: P, val idempotencyKey: String?, val result: java.util.concurrent.CompletableFuture<R>) {
    val keyed: Boolean get() = idempotencyKey != null
}
