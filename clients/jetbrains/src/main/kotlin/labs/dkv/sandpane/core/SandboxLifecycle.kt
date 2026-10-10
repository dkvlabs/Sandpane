// Sandbox lifecycle (protocol-v1 addition A1): `sandbox.stop` and the two-step `sandbox.remove`.
//
// Everything here is pure or depends only on [CoreCommands] plus an injected UI seam, so the
// safety rules are unit-tested against the code that ships rather than against a mock of it:
//   * step 2 of a removal can only be built from an [IssuedRemoval], and an [IssuedRemoval] can only
//     be made by [RemoveConfirmationCheck.decide] from Core's step-1 answer — there is no other path
//     to a `confirmToken` on the wire;
//   * a cancelled, refused or locally-expired confirmation sends nothing further;
//   * neither step is ever retried automatically, and a step-2 answer that did not arrive is
//     reported as "outcome unknown", never as "nothing was sent" (the request may be running in Core);
//   * a stop whose re-query is absent is reported as state UNKNOWN, never as "stopped".
// No Swing here: the caller owns the EDT hop and the notification.
package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.ConfirmationTarget
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.SandboxRemoveResult
import labs.dkv.sandpane.model.SandboxStopResult
import labs.dkv.sandpane.text.VisibleText
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeoutException

/**
 * Masks confirmation tokens in a raw frame before it is logged. A step-1 answer that arrives after
 * its deadline is uncorrelated and reaches the unsolicited-frame log verbatim; the token in it is a
 * single-use secret and must not land in a log (AGENTS.md rule 6). Applied before truncation.
 */
object FrameRedaction {
    private val TOKEN_FIELD = Regex("\"(token|confirmToken)\"(\\s*):(\\s*)\"[^\"]*\"")

    fun redact(line: String): String = TOKEN_FIELD.replace(line) { m ->
        "\"${m.groupValues[1]}\"${m.groupValues[2]}:${m.groupValues[3]}\"<redacted>\""
    }
}

/**
 * A step-1 confirmation that passed every client-side check, and the ONLY carrier of a token toward
 * step 2. The constructor is private and the factory is module-internal; its only caller is
 * [RemoveConfirmationCheck.decide], after it accepted Core's answer for exactly the name the user
 * picked (nothing outside this module can construct one).
 *
 * [token] is internal and redacted from [toString]: it is a single-use secret and is never displayed,
 * logged or put in a notification.
 */
class IssuedRemoval private constructor(
    /** The name the user picked AND Core's `target.name` (checked equal). */
    val name: String,
    val target: ConfirmationTarget,
    /** Core's RFC 3339 expiry, verbatim — shown to the user. */
    val expiresAt: String,
    val impact: List<String>,
    /**
     * Core cannot confirm Sandpane created the target: no Sandpane binding is recorded for this sbx id.
     * That covers a sandbox made outside Sandpane, but ALSO a pre-A1 binding with no recorded sbx id
     * and a binding for an earlier sandbox of the same name — so it never means "made outside
     * Sandpane", only "not confirmed as created by Sandpane".
     */
    val external: Boolean,
    internal val token: String,
) {
    /** [expiresAt] as an instant, or null when Core's string does not parse (then Core alone decides). */
    val expiresAtInstant: Instant? = parseRfc3339(expiresAt)

    /** True only when the expiry parsed and has passed; an unparseable expiry is never "expired" here. */
    fun isExpired(now: Instant): Boolean = expiresAtInstant?.let { !now.isBefore(it) } ?: false

    override fun toString(): String =
        "IssuedRemoval(name=$name, target=$target, expiresAt=$expiresAt, impact=${impact.size} line(s), " +
            "external=$external, token=<redacted>)"

    internal companion object {
        fun of(name: String, target: ConfirmationTarget, expiresAt: String, impact: List<String>, external: Boolean, token: String) =
            IssuedRemoval(name, target, expiresAt, impact, external, token)

        private fun parseRfc3339(value: String): Instant? = try {
            OffsetDateTime.parse(value).toInstant()
        } catch (_: DateTimeParseException) {
            null
        }
    }
}

/** Judges Core's step-1 answer before anything is shown or sent. */
object RemoveConfirmationCheck {

    sealed class Decision {
        /** Safe to show the confirmation dialog; step 2 may be built from [issued] after a yes. */
        data class Ready(val issued: IssuedRemoval) : Decision()

        /** Core's step-1 answer is unusable for this request; step 2 is never sent. */
        data class Refused(val reason: String) : Decision()
    }

    /**
     * Accept Core's step-1 answer only when it is a confirmation, for `sandbox.remove`, for the very
     * name the user picked, with a token of the shape Core issues and a non-blank bound sbx id.
     * Anything else — a `removed` flag at step 1, a different target, a malformed token — is refused
     * and nothing further is sent (fail closed: an answer this client cannot verify is not acted on).
     */
    fun decide(requestedName: String, result: SandboxRemoveResult?): Decision {
        if (result == null) return Decision.Refused("Core returned no step-1 answer")
        if (result.removed != null) {
            return Decision.Refused(
                "Core's step-1 answer carries `removed` — step 1 must change nothing, so this answer is not trusted",
            )
        }
        val confirmation = result.confirmation
            ?: return Decision.Refused("Core's step-1 answer carries no confirmation")
        if (confirmation.action != CoreMethods.SANDBOX_REMOVE) {
            return Decision.Refused(
                "the confirmation is for '${VisibleText.reveal(confirmation.action)}', not ${CoreMethods.SANDBOX_REMOVE}",
            )
        }
        if (confirmation.target.name != requestedName) {
            return Decision.Refused(
                "the confirmation names sandbox '${VisibleText.reveal(confirmation.target.name)}', not " +
                    "'${VisibleText.reveal(requestedName)}'",
            )
        }
        if (confirmation.target.id.isBlank()) {
            return Decision.Refused("the confirmation is not bound to an sbx id, so a replacement could not be told apart")
        }
        if (!CoreGuards.isConfirmTokenShape(confirmation.token)) {
            // The token's value is never quoted: it is a secret even when malformed.
            return Decision.Refused("the confirmation token does not have the shape Core issues (64 lowercase hex)")
        }
        return Decision.Ready(
            IssuedRemoval.of(
                name = requestedName,
                target = confirmation.target,
                expiresAt = confirmation.expiresAt,
                impact = confirmation.impact,
                external = confirmation.external,
                token = confirmation.token,
            ),
        )
    }
}

/**
 * Core's two step-2 `VALIDATION_FAILED` refusals that happen BEFORE anything runs, recognised by the
 * start of Core's own message (pinned against the Rust source by `ProtocolDriftGuardTest`):
 * `confirm::TOKEN_REJECTED_MESSAGE` and `validate_sandbox_name`'s `"sandbox name: {e}"`. Only these
 * may be worded "Core ran nothing"; any other `VALIDATION_FAILED` is "not known" (security W1).
 */
object CoreRemoveRefusals {
    const val TOKEN_REJECTED_PREFIX: String = "confirmation token is invalid, expired, already used"
    const val NAME_REFUSAL_PREFIX: String = "sandbox name: "

    fun ranNothing(message: String?): Boolean =
        message != null && (message.startsWith(TOKEN_REJECTED_PREFIX) || message.startsWith(NAME_REFUSAL_PREFIX))
}

/** How severe an outcome is for display; mapped to the platform's notification type by the action. */
enum class OutcomeSeverity { INFO, WARNING, ERROR }

/** One user-facing outcome: a plugin-written title plus a body in which Core text is revealed. */
data class OutcomeText(val title: String, val body: String, val severity: OutcomeSeverity)

/** Every way one remove attempt can end; [describe] is the one place that words it. */
sealed class RemoveOutcome {
    abstract val name: String

    /** Whether the list should be re-probed (anything that may have touched sbx or found drift). */
    abstract val refreshList: Boolean

    /** Step 1 did not produce a confirmation (step 1 never changes anything). */
    data class Step1Failed(override val name: String, val error: Throwable?) : RemoveOutcome() {
        override val refreshList: Boolean get() = true
    }

    /** Core answered step 1, but not with something this client can act on. Step 2 not sent. */
    data class Refused(override val name: String, val reason: String) : RemoveOutcome() {
        override val refreshList: Boolean get() = false
    }

    /** The user cancelled (or the window went away). Step 2 not sent. */
    data class Cancelled(override val name: String) : RemoveOutcome() {
        override val refreshList: Boolean get() = false
    }

    /** The confirmation had expired by the time the user answered. Step 2 not sent. */
    data class Expired(override val name: String, val expiresAt: String) : RemoveOutcome() {
        override val refreshList: Boolean get() = false
    }

    /** Core answered step 2 with `removed: true`. */
    data class Removed(override val name: String) : RemoveOutcome() {
        override val refreshList: Boolean get() = true
    }

    /** Step 2 was sent and Core answered, but not with `removed: true`. */
    data class Step2Unconfirmed(override val name: String) : RemoveOutcome() {
        override val refreshList: Boolean get() = true
    }

    /** Step 2 was attempted and failed — see [describe] for what is and is not known. */
    data class Step2Failed(override val name: String, val error: Throwable?) : RemoveOutcome() {
        override val refreshList: Boolean get() = true
    }

    fun describe(): OutcomeText {
        val shown = VisibleText.reveal(name)
        return when (this) {
            is Step1Failed -> OutcomeText(
                ErrorAttribution.headline(CoreMethods.SANDBOX_REMOVE, error),
                "No confirmation was issued for '$shown', so nothing can be removed (step 1 never changes " +
                    "anything): ${ErrorAttribution.describe(error)}",
                if (ErrorAttribution.refusedLocally(error)) OutcomeSeverity.WARNING else OutcomeSeverity.ERROR,
            )

            is Refused -> OutcomeText(
                "Sandpane: sandbox not removed — confirmation not usable",
                "Core's confirmation for '$shown' was not acted on: ${VisibleText.reveal(reason)}. The " +
                    "confirming request was NOT sent; nothing was removed.",
                OutcomeSeverity.ERROR,
            )

            is Cancelled -> OutcomeText(
                "Sandpane: sandbox not removed",
                "Cancelled. The confirming request was not sent; '$shown' was not removed.",
                OutcomeSeverity.INFO,
            )

            is Expired -> OutcomeText(
                "Sandpane: confirmation expired — sandbox not removed",
                "Core's confirmation for '$shown' expired at ${VisibleText.reveal(expiresAt)} before it was " +
                    "confirmed, so it was not sent. Run Remove Sandbox again for a fresh confirmation.",
                OutcomeSeverity.WARNING,
            )

            is Removed -> OutcomeText(
                "Sandpane: sandbox removed",
                "Core reports '$shown' removed (removed: true). The sandbox list is re-probed from sbx.",
                OutcomeSeverity.INFO,
            )

            is Step2Unconfirmed -> OutcomeText(
                "Sandpane: removal not confirmed by Core",
                "Core answered the confirming request for '$shown' without `removed: true`. Whether it was " +
                    "removed is not known from this answer; the list is re-probed and nothing is retried.",
                OutcomeSeverity.WARNING,
            )

            is Step2Failed -> step2Failure(shown, error)
        }
    }

    private fun step2Failure(shown: String, error: Throwable?): OutcomeText {
        val t = ErrorAttribution.unwrap(error)
        return when {
            // Refused before a byte was written: genuinely not sent.
            t is CoreValidationException || t is MethodNotSupportedException -> OutcomeText(
                ErrorAttribution.headline(CoreMethods.SANDBOX_REMOVE, t),
                "'$shown' was not removed: ${ErrorAttribution.describe(t)}",
                OutcomeSeverity.WARNING,
            )

            t is CoreRpcException && t.raisedByCore -> {
                val coreSaid = "Core refused ${t.code}: ${VisibleText.reveal(t.message)}"
                when (t.code) {
                    CoreErrorCodes.VALIDATION_FAILED -> if (CoreRemoveRefusals.ranNothing(t.message)) {
                        OutcomeText(
                            "Sandpane: confirmation rejected — sandbox not removed",
                            "$coreSaid. Core refused the request before running anything (an invalid, " +
                                "expired or already-used confirmation, or a refused name), so Core ran " +
                                "nothing and '$shown' was not removed. Run Remove Sandbox again for a fresh one.",
                            OutcomeSeverity.WARNING,
                        )
                    } else {
                        // Not one of Core's two before-anything-runs refusals: do not claim either way.
                        OutcomeText(
                            ErrorAttribution.headline(CoreMethods.SANDBOX_REMOVE, t),
                            "$coreSaid. Whether '$shown' was removed is not known from this answer; the " +
                                "list is re-probed and nothing is retried.",
                            OutcomeSeverity.ERROR,
                        )
                    }

                    CoreErrorCodes.CONFLICT -> OutcomeText(
                        "Sandpane: removal refused with a conflict",
                        "$coreSaid. Either a different sandbox now has this name (its sbx id changed since " +
                            "you confirmed), or another operation on this sandbox is in progress — Core's own " +
                            "message above says which. The list is re-probed and nothing is retried; review " +
                            "it before trying again.",
                        OutcomeSeverity.WARNING,
                    )

                    CoreErrorCodes.NOT_FOUND -> OutcomeText(
                        "Sandpane: sandbox already gone",
                        "$coreSaid. sbx no longer lists '$shown'; this request removed nothing.",
                        OutcomeSeverity.INFO,
                    )

                    else -> OutcomeText(
                        ErrorAttribution.headline(CoreMethods.SANDBOX_REMOVE, t),
                        "$coreSaid. Whether '$shown' was removed is not known from this answer; the list " +
                            "is re-probed and nothing is retried.",
                        OutcomeSeverity.ERROR,
                    )
                }
            }

            else -> OutcomeText(
                "Sandpane: removal outcome unknown",
                "The confirming request for '$shown' did not get a usable answer (${unknownCause(t)}). It may " +
                    "still be running in Core, so the outcome is UNKNOWN — it is not assumed removed or kept, " +
                    "and it is not retried. The sandbox list is re-probed.",
                OutcomeSeverity.ERROR,
            )
        }
    }
}

/** A failure whose request may have reached Core, worded without claiming either way. */
private fun unknownCause(t: Throwable?): String = when (t) {
    is TimeoutException -> "no answer before the deadline"
    is CoreTransportException -> "connection problem: ${VisibleText.reveal(t.message ?: "no detail")}"
    is CoreRpcException -> "unusable reply: ${VisibleText.reveal(t.message)}"
    null -> "no answer"
    else -> VisibleText.reveal("${t.javaClass.simpleName}: ${t.message ?: "no message"}")
}

/** Words a `sandbox.stop` result. Absent `requeried` is UNKNOWN state, never "stopped". */
object StopReport {

    fun describe(name: String, result: SandboxStopResult?, error: Throwable?): OutcomeText {
        val shown = VisibleText.reveal(name)
        if (error != null) {
            val t = ErrorAttribution.unwrap(error)
            return when {
                t is CoreValidationException || t is MethodNotSupportedException -> OutcomeText(
                    ErrorAttribution.headline(CoreMethods.SANDBOX_STOP, t),
                    "'$shown' was not stopped: ${ErrorAttribution.describe(t)}",
                    OutcomeSeverity.WARNING,
                )

                t is CoreRpcException && t.raisedByCore -> OutcomeText(
                    ErrorAttribution.headline(CoreMethods.SANDBOX_STOP, t),
                    "Core refused ${t.code}: ${VisibleText.reveal(t.message)}. The state of '$shown' is " +
                        "whatever the re-probed list shows; nothing is retried.",
                    OutcomeSeverity.ERROR,
                )

                else -> OutcomeText(
                    "Sandpane: stop outcome unknown",
                    "The stop request for '$shown' did not get a usable answer (${unknownCause(t)}). It may " +
                        "still be running in Core, so the state is UNKNOWN and nothing is retried. The " +
                        "sandbox list is re-probed.",
                    OutcomeSeverity.ERROR,
                )
            }
        }
        if (result == null || !result.stopped) {
            return OutcomeText(
                "Sandpane: stop not confirmed by Core",
                "Core's answer for '$shown' does not say `stopped: true`; the state is UNKNOWN.",
                OutcomeSeverity.WARNING,
            )
        }
        val requeried = result.requeried
        return when {
            requeried == null -> OutcomeText(
                "Sandpane: sandbox stop sent — state unknown",
                "sbx stop exited 0 for '$shown', but its state is UNKNOWN: the sandbox is no longer listed, " +
                    "or Core's re-query failed. It is NOT assumed stopped. ${CoreMethods.SANDBOX_START_UNSUPPORTED}.",
                OutcomeSeverity.WARNING,
            )

            requeried.name != name -> OutcomeText(
                "Sandpane: sandbox stop sent — state unknown",
                "sbx stop exited 0 for '$shown', but Core's re-query describes '${VisibleText.reveal(requeried.name)}', " +
                    "so the state of '$shown' is UNKNOWN. It is NOT assumed stopped.",
                OutcomeSeverity.WARNING,
            )

            else -> OutcomeText(
                "Sandpane: sandbox stop sent",
                "sbx stop exited 0 for '$shown'. Core's re-query reports state: " +
                    "${requeried.probedState?.let(VisibleText::reveal) ?: "not probed"}. " +
                    "${CoreMethods.SANDBOX_START_UNSUPPORTED}.",
                OutcomeSeverity.INFO,
            )
        }
    }
}

/**
 * The two-step remove, end to end, with the UI injected so the ordering rules are testable:
 * step 1 → [RemoveConfirmationCheck.decide] → (UI thread) [Ui.confirm] → expiry check → step 2.
 * Every exit before step 2 sends nothing more; neither step is ever retried.
 */
class SandboxRemoveFlow(
    private val commands: CoreCommands,
    private val ui: Ui,
    private val clock: () -> Instant = Instant::now,
) {
    interface Ui {
        /** Run [block] on the UI thread (the EDT in the IDE; inline in tests). */
        fun onUiThread(block: () -> Unit)

        /** Show the native confirmation; true ONLY for the explicit "Remove Sandbox" choice. */
        fun confirm(issued: IssuedRemoval): Boolean
    }

    fun run(name: String): CompletableFuture<RemoveOutcome> {
        val done = CompletableFuture<RemoveOutcome>()
        commands.sandboxRemoveRequest(name).whenComplete { result, error ->
            if (error != null) {
                done.complete(RemoveOutcome.Step1Failed(name, error))
                return@whenComplete
            }
            when (val decision = RemoveConfirmationCheck.decide(name, result)) {
                is RemoveConfirmationCheck.Decision.Refused -> done.complete(RemoveOutcome.Refused(name, decision.reason))
                is RemoveConfirmationCheck.Decision.Ready -> askThenConfirm(decision.issued, done)
            }
        }
        return done
    }

    private fun askThenConfirm(issued: IssuedRemoval, done: CompletableFuture<RemoveOutcome>) {
        try {
            ui.onUiThread {
                val confirmed = try {
                    ui.confirm(issued)
                } catch (_: Throwable) {
                    // A dialog that failed to show is not a yes.
                    done.complete(RemoveOutcome.Cancelled(issued.name))
                    return@onUiThread
                }
                if (!confirmed) {
                    done.complete(RemoveOutcome.Cancelled(issued.name))
                    return@onUiThread
                }
                if (issued.isExpired(clock())) {
                    done.complete(RemoveOutcome.Expired(issued.name, issued.expiresAt))
                    return@onUiThread
                }
                commands.sandboxRemoveConfirm(issued).whenComplete { result, error ->
                    done.complete(
                        when {
                            error != null -> RemoveOutcome.Step2Failed(issued.name, error)
                            result?.removed == true -> RemoveOutcome.Removed(issued.name)
                            else -> RemoveOutcome.Step2Unconfirmed(issued.name)
                        },
                    )
                }
            }
        } catch (_: Throwable) {
            // The UI hop itself was refused (e.g. the application is shutting down): not a yes.
            done.complete(RemoveOutcome.Cancelled(issued.name))
        }
    }
}
