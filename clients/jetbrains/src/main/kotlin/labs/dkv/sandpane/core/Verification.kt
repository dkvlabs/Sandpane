// A7 verification commands + `project.context` (design 2026-10-09 §3.7), client side: Core's
// message constants, the honest copy for every outcome and refusal, the run's binding resolution,
// the keyed-run preparation, single-flight per task, the in-memory activity registry fed by
// durable events, and the plain-text rendering of untrusted output.
//
// Pure: no Swing, no socket, no IDE service, so every sentence and rule is unit-tested as shipped.
//
// Rules the copy obeys (§3.7 items 6 and 8; AGENTS.md rule 5):
//  * an exit status is "exit status N (as reported by sbx exec)" and is NEVER "passed" or "failed";
//    0 and non-zero present identically apart from the number (no colour, no severity change);
//  * UNSUPPORTED_SBX_VERSION is the version gate, never a failure of the command;
//  * a lost `verification.run` answer reads "may have started", never "nothing was run";
//  * "nothing was run" / "nothing was approved" is said only when Core said it, or when this plugin
//    refused before the socket ("nothing was sent");
//  * Core's own words are revealed (hidden, bidi and control characters shown as escapes) and
//    capped; output, argv, labels, notes, sandbox names and paths are untrusted display text.
package labs.dkv.sandpane.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreEventKinds
import labs.dkv.sandpane.model.CoreFeatures
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.Reported
import labs.dkv.sandpane.model.SandboxSummary
import labs.dkv.sandpane.model.TaskSummary
import labs.dkv.sandpane.model.VerificationResult
import labs.dkv.sandpane.model.VerificationRunParams
import labs.dkv.sandpane.model.WorkspaceMode
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeoutException

object Verifications {

    // -----------------------------------------------------------------------
    // Core's constants (sandpane-service verification.rs, sandpane-core verification.rs /
    // validation.rs / context.rs), drift-checked byte for byte by ProtocolDriftGuardTest.
    // -----------------------------------------------------------------------

    const val NOTHING_WAS_RUN: String = "nothing was run"
    const val MSG_NOT_BOUND: String = "this task is not bound to a sandbox; nothing was run"
    const val MSG_SANDBOX_CHANGED: String = "the task's sandbox changed since you confirmed; nothing was run"
    const val MSG_IDENTITY: String = "Core cannot confirm the sandbox's identity; nothing was run"
    const val MSG_TASK_BUSY: String =
        "a verification is already running for this task; wait for it to finish; nothing was run"
    const val MSG_SANDBOX_BUSY: String =
        "a verification is already running in this sandbox; wait for it to finish; nothing was run"
    const val MSG_CORE_BUSY: String =
        "a verification is already running in each of Core's 4 verification slots; wait for one to finish; nothing was run"
    const val MSG_SHUTTING_DOWN: String = "Core is shutting down; nothing was run"
    const val MSG_COMMAND_NOT_FOUND: String = "verification command not found"
    const val MSG_COMMAND_REVOKED: String = "this verification command was revoked; nothing was run"
    const val MSG_COMMAND_OTHER_PROJECT: String = "this verification command belongs to another project; nothing was run"
    const val MSG_RUN_NOT_FOUND: String = "verification run not found"
    const val MSG_TASK_NOT_FOUND: String = "task not found"
    const val MSG_TOO_MANY_COMMANDS: String =
        "this project already has 50 approved verification commands, the most it can hold; revoke one first; nothing was approved"
    const val MSG_VERSION_UNREADABLE: String =
        "sbx exec argument passing has not been verified for this sbx (Core could not read its version); nothing was run"
    const val MSG_PROJECT_VERIFICATION_RUNNING: String =
        "a verification is running for a task of this project; wait for it to finish; nothing was deleted"
    const val MSG_CONVERSATION_VERIFICATION_RUNNING: String =
        "a verification is running for a task of this conversation; wait for it to finish; nothing was deleted"
    const val MSG_SANDBOX_VERIFICATION_RUNNING: String =
        "a verification is running in this sandbox; wait for it to finish; nothing was deleted"
    const val MSG_COMMAND_NO_LONGER_PASSES: String =
        "this command no longer passes the secret check; revoke it; nothing was run"
    const val MSG_RUN_SECRET_CHECK_UNAVAILABLE: String = "the secret check is unavailable, so nothing was run"

    /** Approve: `RedactorUnavailable` (sandpane-core verification.rs). */
    const val MSG_SECRET_CHECK_UNAVAILABLE: String = "the secret check is unavailable, so nothing was approved"

    /** I-g advice Core puts in `details.hint` of a secret refusal. */
    const val SECRET_REFUSAL_HINT: String =
        "if this is not a secret, rename the argument or move it into a script; approved commands cannot hold secrets and there is no override"

    /** `msg_exec_unverified(version)` = this + version + [EXEC_UNVERIFIED_SUFFIX] (UNSUPPORTED_SBX_VERSION). */
    const val EXEC_UNVERIFIED_PREFIX: String = "sbx exec argument passing has not been verified for sbx "
    const val EXEC_UNVERIFIED_SUFFIX: String = "; nothing was run"

    /** `msg_sandbox_not_running(name)` = this + name + [NOT_RUNNING_SUFFIX]. */
    const val NOT_RUNNING_PREFIX: String = "sandbox \""
    const val NOT_RUNNING_SUFFIX: String =
        "\" is not running; sbx exec would start it; start it with `sbx run` in a terminal; nothing was run"

    /** `msg_verification_repo_busy(repo, holder)` = repo + " is busy: " + holder + [REPO_BUSY_SUFFIX] (CONFLICT). */
    const val REPO_BUSY_SUFFIX: String =
        " holds its writer lock (a running writer task, an apply, a worktree discard or another verification); " +
            "a verification is already running or the repository is being written; nothing was run"

    /** `msg_command_shape_no_longer_passes(why)` = this + why + [SHAPE_NO_LONGER_PASSES_SUFFIX]. */
    const val SHAPE_NO_LONGER_PASSES_PREFIX: String = "this command no longer passes the argument checks ("
    const val SHAPE_NO_LONGER_PASSES_SUFFIX: String = "); revoke it; nothing was run"

    /** The secret-refusal templates (C1): `argument N looks like a secret (kinds); …`, label, combined. */
    const val SECRET_REFUSAL_SUFFIX: String = "; approved commands cannot hold secrets; nothing was approved"
    const val SECRET_REFUSAL_INFIX: String = " like a secret ("

    /** The frame-refusal template (W1 backstop): `the response would exceed the frame limit (…); …; nothing was returned`. */
    const val FRAME_REFUSAL_PREFIX: String = "the response would exceed the frame limit ("
    const val FRAME_REFUSAL_SUFFIX: String = "; nothing was returned"

    /** Approve shape messages Core prefixes (`argv: value has an invalid shape: …`, `label: …`). */
    const val ARGV_SHAPE_PREFIX: String = "argv: "
    const val LABEL_SHAPE_PREFIX: String = "label: "

    /** Event kinds (also in [CoreEventKinds]). */
    const val EVENT_STARTED: String = CoreEventKinds.VERIFICATION_STARTED
    const val EVENT_FINISHED: String = CoreEventKinds.VERIFICATION_FINISHED

    /** Outcome strings Core sends today (open set: anything else is shown as-is). */
    const val OUTCOME_RUNNING: String = "running"
    const val OUTCOME_EXITED: String = "exited"
    const val OUTCOME_SIGNALED: String = "signaled"
    const val OUTCOME_TIMED_OUT: String = "timed_out"
    const val OUTCOME_SPAWN_FAILED: String = "spawn_failed"
    const val OUTCOME_READ_FAILED: String = "read_failed"
    const val OUTCOME_POSSIBLY_SBX_ERROR: String = "possibly_sbx_error"
    const val OUTCOME_INTERRUPTED: String = "interrupted"

    val KNOWN_OUTCOMES: List<String> = listOf(
        OUTCOME_RUNNING, OUTCOME_EXITED, OUTCOME_SIGNALED, OUTCOME_TIMED_OUT, OUTCOME_SPAWN_FAILED,
        OUTCOME_READ_FAILED, OUTCOME_POSSIBLY_SBX_ERROR, OUTCOME_INTERRUPTED,
    )

    /** Core's caps, for the disclosure copy only (Core measures). */
    const val MAX_OUTPUT_KIB: Int = 64
    const val TIMEOUT_MINUTES: Int = 10

    // -----------------------------------------------------------------------
    // the plugin's own copy (§3.7 items 4, 6, 8; shared wording with the other clients)
    // -----------------------------------------------------------------------

    const val NOT_ADVERTISED: String =
        "Verification is not supported by this Core (it does not advertise the verification feature); nothing is sent."
    const val NOT_BOUND: String = "this task is not bound to a sandbox"
    const val DO_NOT_PUT_SECRETS: String = "Do not put tokens or passwords in arguments"
    const val APPROVAL_BINDS: String =
        "Approval binds this exact argument list, not what it executes. Commands such as `npm run test`, " +
            "`make test` or `./gradlew test` run code from the repository that the agent can change after you approve."
    const val DIRECT_MOUNT_WARNING: String =
        "this sandbox mounts your repository directly; the command can change your working tree, including " +
            "`.git/hooks` that later run on your machine"
    const val RUN_WHERE: String =
        "Runs in sbx's default working directory inside the sandbox; the result is the exit status reported by " +
            "sbx exec; not yet verified against a real sbx"
    const val HOST_WORKTREE_WARNING: String =
        "The command can change files in the task's workspace, so a review taken before may no longer match: a " +
            "later apply then refuses \"changed since reviewed\" — review again before applying."
    const val UNSUPPORTED_VERSION_COPY: String =
        "Running is disabled until this sbx version's `sbx exec` behaviour has been captured and verified; your " +
            "approved commands are kept. Nothing was run."
    const val STOP_DURING_RUN: String = "a verification is running in this sandbox; stopping it ends the run"
    const val UNVERIFIED_NOTE: String =
        "UNVERIFIED: Core runs a command only for an sbx version whose `sbx exec` behaviour has been captured " +
            "(none yet, so every real run is refused), and no task created over the wire is bound to a sandbox yet."
    const val LOST_RUN_ANSWER: String =
        "Core's answer was lost — the verification may have started. \"Retry safely\" resends the identical " +
            "request with the same key: if it started, Core returns that run instead of starting another. " +
            "Nothing is retried automatically."
    /** Why Run is disabled while a request for the task awaits Core's answer. */
    const val IN_FLIGHT_SENDING: String = "a run request for this task is waiting for Core's answer"

    /** Why Run is disabled while a keyed run's answer is lost (J-I1): where to resolve it. */
    const val IN_FLIGHT_LOST: String =
        "an earlier run's outcome is unknown — choose Retry safely or Do not retry in the Notifications tool window"

    /** Shown instead of a retry once Core may have forgotten the key (D-I5). */
    const val TOO_LATE_TO_RETRY: String =
        "too late to retry safely — the earlier run may have started; check the Runs list and the task's events " +
            "before running again"

    /**
     * Core keeps an idempotency key for 24 h; "Retry safely" is offered only within 23 h of the
     * ORIGINAL keyed send, so a resend can never reach a Core that has forgotten the key.
     */
    const val RETRY_WINDOW_MILLIS: Long = 23L * 60 * 60 * 1000

    const val REPLAY_NOTICE: String =
        "Core returned the run your earlier identical request started (replayed); it was not started again."

    /** Cap for one Core message shown in copy. */
    const val MAX_CORE_TEXT: Int = 2_000

    /** Cap for an untrusted label / argv element / note / name in a list or dialog line. */
    const val MAX_ITEM_CODE_POINTS: Int = 512

    /** Entries listed from a frame refusal's `details` before a count. */
    const val MAX_LISTED: Int = 20

    fun core(text: String?): String = VisibleText.reveal(DisplayCap.cap(text ?: "no message", MAX_CORE_TEXT))

    /** One untrusted single-line item (label, argv element, note, name, path): revealed and capped. */
    fun item(text: String): String = VisibleText.reveal(DisplayCap.cap(text, MAX_ITEM_CODE_POINTS))

    /** The delimiters around an argv element in every list row and dialog line. */
    const val ELEMENT_OPEN: Char = '\u27E8'
    const val ELEMENT_CLOSE: Char = '\u27E9'

    /**
     * The inside of an argv element (or a label in a row), revealed, with every space that is not
     * U+0020 (category Zs: U+00A0, U+2000–U+200A, U+202F, U+205F, U+3000, …) and both delimiters
     * shown as `\uXXXX` (J-I5): a no-break space or a delimiter inside one element can never make
     * it look like two. [capped] = false only where Core's own 4096-byte bound applies (a confirmation).
     */
    fun elementBody(text: String, capped: Boolean = true): String {
        val revealed = if (capped) item(text) else VisibleText.reveal(text)
        val out = StringBuilder(revealed.length + 8)
        for (ch in revealed) {
            val hidden = ch == ELEMENT_OPEN || ch == ELEMENT_CLOSE ||
                (ch != ' ' && Character.getType(ch) == Character.SPACE_SEPARATOR.toInt())
            if (hidden) out.append("\\u%04X".format(ch.code)) else out.append(ch)
        }
        return out.toString()
    }

    /** An argv element with visible delimiters, so `" x"`, `""` and a trailing space are distinguishable. */
    fun element(text: String): String = "$ELEMENT_OPEN" + elementBody(text) + ELEMENT_CLOSE

    /** One row text for an approved command: its label, then every element delimited, with the count. */
    fun commandRow(label: String, argv: List<String>): String =
        elementBody(label) + "  —  " + argv.size + (if (argv.size == 1) " element: " else " elements: ") +
            argv.joinToString(" ") { element(it) }

    // -----------------------------------------------------------------------
    // gating
    // -----------------------------------------------------------------------

    /** Why the verification surface is off for [caps], or null when Core advertises it. */
    fun gate(caps: CoreCapabilities?): String? = when {
        caps == null -> "Not connected to Core; the verification surface is off."
        !caps.hasFeature(CoreFeatures.VERIFICATION) -> NOT_ADVERTISED
        else -> null
    }

    // -----------------------------------------------------------------------
    // results (§3.7 items 5 and 6)
    // -----------------------------------------------------------------------

    private fun exitStatus(code: Int?): String =
        code?.let { "exit status $it (as reported by sbx exec)" } ?: "no exit status was reported"

    /**
     * The one-line outcome. NEVER "passed" / "failed": an exit status is a number sbx exec reported
     * (that sbx passes the command's own status through is UNVERIFIED, C-2).
     */
    fun outcomeLine(outcome: String?, exitCode: Int?): String = when (outcome) {
        null -> "Core did not report an outcome"
        OUTCOME_RUNNING -> "running (Core reports this run in flight)"
        OUTCOME_EXITED -> exitStatus(exitCode)
        OUTCOME_SIGNALED -> "ended by a signal (no exit status)"
        OUTCOME_TIMED_OUT ->
            "stopped after $TIMEOUT_MINUTES minutes; the command may still be running inside the sandbox"
        OUTCOME_INTERRUPTED ->
            "Core restarted (or stopped) while this ran; the result is unknown; the command may still be running " +
                "inside the sandbox"
        OUTCOME_POSSIBLY_SBX_ERROR ->
            "possibly sbx's own error, or the command's own output; ${exitStatus(exitCode)}"
        OUTCOME_SPAWN_FAILED -> "Core could not start sbx exec (spawn_failed); no exit status"
        OUTCOME_READ_FAILED -> "Core could not read the command's output to the end (read_failed); no exit status"
        else -> "outcome '${item(outcome)}' (not known to this plugin build; shown as Core reported it)" +
            (exitCode?.let { "; ${exitStatus(it)}" } ?: "")
    }

    fun outcomeLine(result: VerificationResult): String = outcomeLine(result.outcome, result.exitCode)

    /** Every disclosure flag Core set on [result], in a fixed order. */
    fun disclosures(result: VerificationResult): List<String> = buildList {
        when (result.stdoutTruncated) {
            true -> add("stdout was truncated at Core's $MAX_OUTPUT_KIB KiB cap")
            null -> add("Core did not report whether stdout was truncated")
            false -> {}
        }
        when (result.stderrTruncated) {
            true -> add("stderr was truncated at Core's $MAX_OUTPUT_KIB KiB cap")
            null -> add("Core did not report whether stderr was truncated")
            false -> {}
        }
        if (result.outputIncomplete == true) {
            add("output may be incomplete: a process kept the output open after the command exited")
        }
        val redactions = result.redactions
        if (redactions == null) {
            add("Core did not report what its secret check did to this output")
        } else {
            if (redactions.outputWithheld == true) {
                add("output was not stored because the secret check was unavailable")
            }
            val n = redactions.replacements ?: 0
            if (n > 0) {
                val kinds = redactions.byKind.entries.take(MAX_LISTED)
                    .joinToString(", ") { (kind, count) -> "${item(kind)} $count" }
                add(
                    (if (n == 1L) "1 value was redacted (best effort)" else "$n values were redacted (best effort)") +
                        (if (kinds.isNotEmpty()) ": $kinds" else ""),
                )
            } else if (redactions.outputWithheld != true) {
                add("no values were redacted (the secret check is best effort; a secret can survive, e.g. cut at the cap)")
            }
        }
        result.elapsedMs?.let { add("elapsed $it ms (as Core measured it)") }
    }

    /**
     * The output text for the read-only text area (§3.7 item 6): split on LF ONLY, each line
     * revealed on its own (TAB stays real), rejoined with LF. A CR — whether a CRLF ending or a lone
     * one — is shown as `\r`; every other C0/C1 control (ESC, so OSC 8 links and OSC 52 clipboard
     * writes), DEL, bidi and invisible format character is shown as an escape and never obeyed.
     */
    fun outputText(raw: String): String = raw.split('\n').joinToString("\n") { VisibleText.revealMultiline(it) }

    // -----------------------------------------------------------------------
    // failures
    // -----------------------------------------------------------------------

    /** How one failed call is presented. [offerRetrySafely] only for a lost answer of a keyed run. */
    data class Presentation(
        val title: String,
        val body: String,
        val severity: OutcomeSeverity,
        val offerRetrySafely: Boolean = false,
        /** The run may have started (lost answer); the UI keeps the task's run single-flight until resolved. */
        val mayHaveStarted: Boolean = false,
    )

    /** `details.hint` of a Core refusal, when present and a string. */
    fun hint(details: JsonElement?): String? =
        ((details as? JsonObject)?.get("hint") as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    fun isSecretRefusal(message: String): Boolean =
        message.endsWith(SECRET_REFUSAL_SUFFIX) && message.contains(SECRET_REFUSAL_INFIX)

    fun isFrameRefusal(message: String): Boolean =
        message.startsWith(FRAME_REFUSAL_PREFIX) && message.endsWith(FRAME_REFUSAL_SUFFIX)

    fun isUnsupportedVersion(code: String, message: String): Boolean =
        code == CoreErrorCodes.UNSUPPORTED_SBX_VERSION ||
            (message.startsWith(EXEC_UNVERIFIED_PREFIX) && message.endsWith(EXEC_UNVERIFIED_SUFFIX)) ||
            message == MSG_VERSION_UNREADABLE

    /** The lines a frame refusal's `details` adds: what was too large (capped, revealed). */
    fun frameRefusalDetails(details: JsonElement?): List<String> {
        val obj = details as? JsonObject ?: return emptyList()
        return buildList {
            (obj["commandIds"] as? JsonArray)?.let { ids ->
                val shown = ids.take(MAX_LISTED).mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.let(::item) }
                add("commands in the refused answer (${ids.size}): " + shown.joinToString(", ") +
                    if (ids.size > MAX_LISTED) ", … and ${ids.size - MAX_LISTED} more" else "")
            }
            (obj["repositories"] as? JsonArray)?.let { repos ->
                val shown = repos.take(MAX_LISTED).mapNotNull { r ->
                    val o = r as? JsonObject ?: return@mapNotNull null
                    val path = (o["repoPath"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
                    val bytes = (o["bytes"] as? JsonPrimitive)?.longOrNull
                    item(path) + (bytes?.let { " ($it bytes)" } ?: "")
                }
                add("largest repositories: " + shown.joinToString("; "))
            }
            ((obj["repositoryCount"] as? JsonPrimitive)?.longOrNull)?.let { add("repositories in the project: $it") }
            ((obj["approvedBytes"] as? JsonPrimitive)?.longOrNull)?.let { add("approved commands: $it bytes") }
            ((obj["runId"] as? JsonPrimitive)?.contentOrNull)?.let { add("run: ${item(it)}") }
        }
    }

    /**
     * Words a failed call of an A7 [method]. [keyed] says whether the failed request carried an
     * idempotency key (only `verification.run` does).
     */
    fun describeFailure(method: String, error: Throwable?, keyed: Boolean = false): Presentation {
        val t = ErrorAttribution.unwrap(error)
        if (t is CoreValidationException || t is MethodNotSupportedException || t is ReplayPausedException) {
            return Presentation(
                ErrorAttribution.headline(method, t),
                ErrorAttribution.describe(method, t) + " Nothing was sent.",
                OutcomeSeverity.WARNING,
            )
        }
        val readOnly = method in CoreMethods.VERIFICATION_READ_ONLY
        if (t !is CoreRpcException || !t.raisedByCore || (t.code == CoreErrorCodes.INTERNAL && !t.message.endsWith(NOTHING_WAS_RUN))) {
            return lostAnswer(method, t, keyed, readOnly)
        }
        val msg = t.message
        val shown = core(msg)
        val coreSaid = "Core said (${t.code}): $shown"
        return when {
            isUnsupportedVersion(t.code, msg) -> Presentation(
                "Sandpane: running is disabled for this sbx version",
                "$UNSUPPORTED_VERSION_COPY\n$coreSaid",
                OutcomeSeverity.INFO,
            )
            t.code == CoreErrorCodes.VALIDATION_FAILED && isFrameRefusal(msg) -> Presentation(
                "Sandpane: $method answer too large — nothing was returned",
                "Core refused to send this answer because it would not fit one frame; nothing is retried " +
                    "automatically.\n$coreSaid" +
                    frameRefusalDetails(t.details).joinToString("") { "\n$it" },
                OutcomeSeverity.WARNING,
            )
            t.code == CoreErrorCodes.VALIDATION_FAILED && isSecretRefusal(msg) -> Presentation(
                "Sandpane: not approved — an argument looks like a secret",
                "$coreSaid" + (hint(t.details)?.let { "\nCore's hint: ${core(it)}" } ?: ""),
                OutcomeSeverity.WARNING,
            )
            msg == MSG_SECRET_CHECK_UNAVAILABLE -> Presentation(
                "Sandpane: not approved — secret check unavailable",
                "Core could not run its secret check, so nothing was approved.\n$coreSaid",
                OutcomeSeverity.WARNING,
            )
            t.code == CoreErrorCodes.CONFLICT && (msg.startsWith(KeyedWrites.CONFLICT_MISMATCH) || msg.startsWith(KeyedWrites.CONFLICT_PENDING)) -> {
                val text = KeyedWrites.describe(method, KeyedWrites.classify(t), keyed)
                Presentation(text.title, text.body, text.severity)
            }
            t.code == CoreErrorCodes.CONFLICT && msg.startsWith(KeyedWrites.CONFLICT_UNKNOWN_PREFIX) -> {
                val text = KeyedWrites.describe(method, KeyedWrites.classify(t), keyed)
                Presentation(text.title, text.body, text.severity)
            }
            t.code == CoreErrorCodes.CONFLICT && msg.endsWith(NOTHING_WAS_RUN) -> Presentation(
                "Sandpane: verification not started — busy",
                "Another verification or operation is in progress (Core names it below); wait for it to finish. " +
                    "Nothing was run.\n$coreSaid",
                OutcomeSeverity.WARNING,
            )
            msg.endsWith(NOTHING_WAS_RUN) -> Presentation(
                "Sandpane: verification not started",
                "Core refused before running anything. Nothing was run.\n$coreSaid",
                OutcomeSeverity.WARNING,
            )
            msg.endsWith("nothing was approved") -> Presentation(
                "Sandpane: not approved",
                "Core refused the approval; nothing was approved.\n$coreSaid",
                OutcomeSeverity.WARNING,
            )
            t.code == CoreErrorCodes.VALIDATION_FAILED && (msg.startsWith(ARGV_SHAPE_PREFIX) || msg.startsWith(LABEL_SHAPE_PREFIX)) &&
                method == CoreMethods.VERIFICATION_APPROVE -> Presentation(
                "Sandpane: not approved",
                "Core refused the label or an argument (Core names which); nothing was approved.\n$coreSaid",
                OutcomeSeverity.WARNING,
            )
            msg == ProjectOutcomes.MSG_PROJECT_ARCHIVED || msg == ConversationOutcomes.MSG_CONVERSATION_ARCHIVED -> Presentation(
                "Sandpane: $method refused \u2014 archived",
                "The project or conversation is archived; unarchive it first. Core changed nothing" +
                    (if (method == CoreMethods.VERIFICATION_RUN) " and ran nothing" else "") + ".\n$coreSaid",
                OutcomeSeverity.WARNING,
            )
            t.code == CoreErrorCodes.NOT_FOUND -> Presentation(
                "Sandpane: $method — not found",
                "Core does not know this id (it may have been deleted or revoked). Nothing changed.\n$coreSaid",
                OutcomeSeverity.WARNING,
            )
            t.code == CoreErrorCodes.NOT_INSTALLED -> Presentation(
                "Sandpane: sbx is not installed",
                "Core could not find sbx, so nothing was run.\n$coreSaid",
                OutcomeSeverity.WARNING,
            )
            else -> Presentation(
                "Sandpane: $method refused by Core",
                coreSaid,
                OutcomeSeverity.ERROR,
            )
        }
    }

    private fun lostAnswer(method: String, t: Throwable?, keyed: Boolean, readOnly: Boolean): Presentation {
        val why = when (t) {
            is TimeoutException -> "no answer before the deadline"
            is CoreTransportException -> "the connection to Core failed"
            is FrameExceedsCapException -> "the reply passed the frame cap"
            is CoreRpcException -> if (t.raisedByCore) "Core reported ${t.code}: ${core(t.message)}" else "the reply was unusable"
            null -> "no answer"
            // Never echoed: a decode message can quote the frame.
            else -> "an unexpected ${t.javaClass.simpleName} while handling the answer (details not shown)"
        }
        if (readOnly) {
            return Presentation(
                "Sandpane: $method — no usable answer",
                "No usable answer ($why). This is a read, so nothing changed in Core; refresh to try again.",
                OutcomeSeverity.WARNING,
            )
        }
        return when (method) {
            CoreMethods.VERIFICATION_RUN -> Presentation(
                "Sandpane: verification outcome unknown",
                if (keyed) {
                    "$LOST_RUN_ANSWER ($why)"
                } else {
                    "Core's answer was lost ($why) — the verification may have started. This request had no " +
                        "idempotency key, so sending it again could start a second run; check the task's events first."
                },
                OutcomeSeverity.ERROR,
                offerRetrySafely = keyed,
                mayHaveStarted = true,
            )
            CoreMethods.VERIFICATION_APPROVE -> Presentation(
                "Sandpane: approval outcome unknown",
                "Core's answer was lost ($why) — the command may have been approved. Refresh the list before " +
                    "approving again (approving the same argument list again returns the existing command).",
                OutcomeSeverity.ERROR,
            )
            CoreMethods.VERIFICATION_REVOKE -> Presentation(
                "Sandpane: revoke outcome unknown",
                "Core's answer was lost ($why) — the command may have been revoked. Refresh the list; revoking " +
                    "again is safe (it is idempotent).",
                OutcomeSeverity.ERROR,
            )
            else -> Presentation("Sandpane: $method outcome unknown", "No usable answer ($why).", OutcomeSeverity.ERROR)
        }
    }

    // -----------------------------------------------------------------------
    // events (§3.7 item 5): open payloads, never output, never a status change
    // -----------------------------------------------------------------------

    private fun str(obj: JsonObject, key: String): String? =
        (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    /** A transcript note for a verification event kind, or null for any other kind. Never echoes a payload. */
    fun eventNote(kind: String, payload: JsonElement): String? {
        if (kind !in CoreEventKinds.VERIFICATION) return null
        val obj = payload as? JsonObject ?: return "$kind event with an unreadable payload (not shown)"
        val run = str(obj, "runId")?.let { " (run ${item(it.take(8))})" } ?: ""
        return if (kind == CoreEventKinds.VERIFICATION_STARTED) {
            val label = str(obj, "label")?.let { " '${item(DisplayCap.cap(it, 80))}'" } ?: ""
            val sandbox = str(obj, "sandbox")?.let { " in sandbox ${item(DisplayCap.cap(it, 128))}" } ?: ""
            "verification started$run:$label$sandbox — the task's status is unchanged"
        } else {
            val outcome = str(obj, "outcome")
            val code = (obj["exitCode"] as? JsonPrimitive)?.longOrNull?.toInt()
            val reconciled = if ((obj["reconciledAfterRestart"] as? JsonPrimitive)?.booleanOrNull == true) {
                " (recorded after a Core restart)"
            } else {
                ""
            }
            "verification finished$run: ${outcomeLine(outcome, code)}$reconciled — read the output with Refresh"
        }
    }
}

/**
 * The client mirror of Core's approve rules, for EARLY FEEDBACK ONLY. Never stricter than Core
 * (`Validator::verification_argv` exactly; the label only for emptiness). Core remains the authority.
 */
object VerificationGuards {
    const val MAX_ARGS: Int = 64
    const val MAX_ARG_BYTES: Int = 4096
    const val MAX_ARGV_BYTES: Int = 16 * 1024

    /** Core's argv shape rule, or null when Core would accept the shape (the secret check is Core's). */
    fun argvProblem(argv: List<String>): String? {
        if (argv.isEmpty() || argv.size > MAX_ARGS) return "argv must have 1 to $MAX_ARGS elements (it has ${argv.size})"
        var total = 0
        argv.forEachIndexed { i, a ->
            val n = i + 1
            val bytes = a.toByteArray(Charsets.UTF_8).size
            if (bytes > MAX_ARG_BYTES) return "argument $n is longer than $MAX_ARG_BYTES bytes"
            if (a.indexOf('\u0000') >= 0) return "argument $n contains a NUL character"
            var j = 0
            while (j < a.length) {
                val cp = a.codePointAt(j)
                if (Character.getType(cp) == Character.CONTROL.toInt() && cp != '\t'.code && cp != '\n'.code) {
                    return "argument $n contains a control character"
                }
                j += Character.charCount(cp)
            }
            total += bytes
        }
        if (total > MAX_ARGV_BYTES) return "argv is longer than $MAX_ARGV_BYTES bytes in total"
        if (argv[0].isEmpty()) return "argument 1 (the program) is empty"
        if (argv[0].startsWith("-")) return "argument 1 (the program) must not start with '-'"
        return null
    }

    /** Only emptiness: Core trims and checks length and characters itself. */
    fun labelProblem(label: String): String? = if (label.isBlank()) "the label is empty" else null
}

/**
 * Where a run would go (§3.7 items 1 and 4): the task's BINDING ([labs.dkv.sandpane.model.TaskSummary.sandboxName],
 * never the chat's chosen sandbox name, an A4 display-only field) and the `workspaceMode` of the ONE `sandbox.list` entry with exactly
 * that name. Anything else is [Unbound], and Run is disabled with [Verifications.NOT_BOUND].
 */
sealed class RunTarget {
    data class Bound(val sandboxName: String, val mode: WorkspaceMode) : RunTarget()
    data class Unbound(val reason: String) : RunTarget()

    companion object {
        fun resolve(bindingSandboxName: String?, sandboxes: List<SandboxSummary>?): RunTarget {
            val name = bindingSandboxName ?: return Unbound(Verifications.NOT_BOUND)
            if (sandboxes == null) {
                return Unbound("${Verifications.NOT_BOUND} that this window can confirm (Core's sandbox list has not been read)")
            }
            val matches = sandboxes.filter { it.name == name }
            if (matches.size != 1) {
                return Unbound("${Verifications.NOT_BOUND} that Core's sandbox list names exactly once")
            }
            val mode = (matches.single().workspaceMode as? Reported.Known)?.value
                ?: return Unbound("${Verifications.NOT_BOUND} with a workspace mode Core reported")
            return Bound(name, mode)
        }
    }
}

/**
 * Single-flight per task across every window of this IDE: one Run (including its "Retry safely")
 * per task until the answer is known. Core enforces one run per task too; this keeps a double click
 * from minting two keys.
 */
object VerificationInFlight {
    private data class Claim(val firstSentAtMillis: Long, val key: String?, val lostAnswer: Boolean)

    private val active = ConcurrentHashMap<String, Claim>()

    /** Claims [taskId] for a NEW run sent at [nowMillis] with [key]; false when a claim is already held. */
    fun begin(taskId: String, nowMillis: Long, key: String?): Boolean =
        active.putIfAbsent(taskId, Claim(nowMillis, key, lostAnswer = false)) == null

    /** The answer to the claimed run was lost: the claim stays until Retry safely / Do not retry / expiry. */
    fun markLost(taskId: String) {
        active.computeIfPresent(taskId) { _, c -> c.copy(lostAnswer = true) }
    }

    /** A "Retry safely" resend is under way (same key, same original send time). */
    fun markResending(taskId: String) {
        active.computeIfPresent(taskId) { _, c -> c.copy(lostAnswer = false) }
    }

    /** When the ORIGINAL keyed send of [key] for [taskId] happened, or null when no such claim is held. */
    fun firstSentAt(taskId: String, key: String?): Long? =
        active[taskId]?.takeIf { key != null && it.key == key }?.firstSentAtMillis

    /** Why Run is disabled for [taskId] because of a held claim, or null when there is none. */
    fun blockReason(taskId: String): String? = when (active[taskId]?.lostAnswer) {
        null -> null
        true -> Verifications.IN_FLIGHT_LOST
        false -> Verifications.IN_FLIGHT_SENDING
    }

    /**
     * Releases lost-answer claims whose retry window ([Verifications.RETRY_WINDOW_MILLIS] after the
     * original send) has closed at [nowMillis]; returns their task ids. A claim still waiting for its
     * first answer is kept: that request has its own deadline.
     */
    fun releaseExpired(nowMillis: Long): List<String> {
        val released = ArrayList<String>()
        for ((taskId, claim) in active.entries.toList()) {
            if (claim.lostAnswer && !VerificationRuns.retryWindowOpen(claim.firstSentAtMillis, nowMillis) &&
                active.remove(taskId, claim)
            ) {
                released += taskId
            }
        }
        return released.sorted()
    }

    fun end(taskId: String) {
        active.remove(taskId)
    }

    fun isActive(taskId: String): Boolean = active.containsKey(taskId)
}

/** Builds `verification.run` params for one user gesture, or for an explicit "Retry safely". */
object VerificationRuns {

    /**
     * A NEW run: a fresh key, always. Refused locally when Core does not advertise
     * `idempotency-keys` (a lost answer could then never be retried safely), when [target] is not
     * [RunTarget.Bound], or when a key was already present.
     */
    fun newRun(
        taskId: String,
        commandId: String,
        target: RunTarget,
        caps: CoreCapabilities?,
        mint: () -> String = IdempotencyKeys::fresh,
    ): KeyedRequests.Prepared<VerificationRunParams> {
        Verifications.gate(caps)?.let { return KeyedRequests.Prepared.Refused(it, field = "feature") }
        if (caps?.hasFeature(CoreFeatures.IDEMPOTENCY_KEYS) != true) {
            return KeyedRequests.Prepared.Refused(
                "this Core does not advertise '${CoreFeatures.IDEMPOTENCY_KEYS}', so a lost answer could not be " +
                    "retried safely; nothing was sent",
            )
        }
        val bound = target as? RunTarget.Bound
            ?: return KeyedRequests.Prepared.Refused((target as RunTarget.Unbound).reason + "; nothing was sent", field = "task")
        return KeyedRequests.Prepared.Ready(
            VerificationRunParams(
                taskId = taskId,
                commandId = commandId,
                expectedSandboxName = bound.sandboxName,
                expectedWorkspaceMode = bound.mode,
                idempotencyKey = mint(),
            ),
        )
    }

    /**
     * After Core started a run: follow the task's durable events so `verification.finished` arrives
     * (read-only). [track] has [labs.dkv.sandpane.services.TaskMonitorService.track]'s shape.
     */
    fun followAfterStart(task: TaskSummary, track: (String, String?, TaskSummary?) -> Unit) {
        // NEVER the summary: the panel's task.list row may be older than the monitor's folded view,
        // and track(…, summary) overwrites the displayed status (J-W1, AGENTS.md rule 3).
        track(task.id, task.conversationId, null)
    }

    /** Whether a "Retry safely" of a keyed send made at [firstSentAtMillis] may still go out at [nowMillis]. */
    fun retryWindowOpen(firstSentAtMillis: Long?, nowMillis: Long): Boolean =
        firstSentAtMillis != null && nowMillis - firstSentAtMillis in 0 until Verifications.RETRY_WINDOW_MILLIS

    /** "Retry safely": the IDENTICAL params, same key; refused without a valid key or keys feature. */
    fun retryRun(
        previous: VerificationRunParams,
        caps: CoreCapabilities?,
        firstSentAtMillis: Long?,
        nowMillis: Long,
    ): KeyedRequests.Prepared<VerificationRunParams> {
        Verifications.gate(caps)?.let { return KeyedRequests.Prepared.Refused(it, field = "feature") }
        if (!retryWindowOpen(firstSentAtMillis, nowMillis)) {
            return KeyedRequests.Prepared.Refused(Verifications.TOO_LATE_TO_RETRY + "; nothing was sent")
        }
        val key = previous.idempotencyKey
        return when {
            key == null -> KeyedRequests.Prepared.Refused("this request carried no idempotency key, so a resend could run it twice; nothing was sent")
            !IdempotencyKeys.isValid(key) -> KeyedRequests.Prepared.Refused("this request's idempotency key is not in Core's format; nothing was sent")
            caps?.hasFeature(CoreFeatures.IDEMPOTENCY_KEYS) != true -> KeyedRequests.Prepared.Refused(
                "the connected Core does not advertise '${CoreFeatures.IDEMPOTENCY_KEYS}', so it would ignore the key " +
                    "and a resend could run twice; nothing was sent",
            )
            else -> KeyedRequests.Prepared.Ready(previous)
        }
    }
}

/**
 * What this IDE knows about runs, from Core's durable events and its own `verification.run` answers
 * only (never a guess): which run belongs to which task and sandbox, whether a `verification.finished`
 * was seen, and the last `verification.result` read. Bounded; in memory; Core is the authority.
 */
object VerificationActivity {
    data class Run(
        val runId: String,
        val taskId: String,
        val sandbox: String?,
        val label: String?,
        val startedSequence: Long?,
        val finished: Boolean,
        val result: VerificationResult? = null,
        val replayed: Boolean = false,
    ) {
        /** Ids and flags only: the label and sandbox name are untrusted display text, never logged. */
        override fun toString(): String =
            "Run(runId=$runId, taskId=$taskId, finished=$finished, resultRead=${result != null}, replayed=$replayed)"
    }

    const val MAX_RUNS: Int = 200

    private val runs = java.util.LinkedHashMap<String, Run>()

    @Synchronized
    fun all(): List<Run> = runs.values.toList().asReversed()

    @Synchronized
    fun get(runId: String): Run? = runs[runId]

    @Synchronized
    fun runsForTasks(taskIds: Set<String>): List<Run> = runs.values.filter { it.taskId in taskIds }.asReversed()

    /** A run Core reports in flight in [sandbox] (a started event or answer without a finished event). */
    @Synchronized
    fun runningIn(sandbox: String): Boolean = runs.values.any { !it.finished && it.sandbox == sandbox }

    /** Our own `verification.run` answer. */
    @Synchronized
    fun recordStarted(taskId: String, runId: String, sandbox: String, label: String?, startedSequence: Long?, replayed: Boolean) {
        val prior = runs[runId]
        put(
            Run(
                runId, taskId, sandbox, label ?: prior?.label, startedSequence ?: prior?.startedSequence,
                finished = prior?.finished ?: false, result = prior?.result, replayed = replayed,
            ),
        )
    }

    /**
     * A durable task event. Returns the run id of a `verification.finished` event (so the UI may
     * fetch its result), else null. Unknown kinds and unreadable payloads change nothing.
     */
    @Synchronized
    fun observe(taskId: String, kind: String, payload: JsonElement): String? {
        if (kind !in CoreEventKinds.VERIFICATION) return null
        val obj = payload as? JsonObject ?: return null
        val runId = (obj["runId"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
        val prior = runs[runId]
        return if (kind == CoreEventKinds.VERIFICATION_STARTED) {
            put(
                Run(
                    runId, taskId,
                    sandbox = (obj["sandbox"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: prior?.sandbox,
                    label = (obj["label"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: prior?.label,
                    startedSequence = prior?.startedSequence,
                    finished = prior?.finished ?: false,
                    result = prior?.result,
                    replayed = prior?.replayed ?: false,
                ),
            )
            null
        } else {
            put((prior ?: Run(runId, taskId, null, null, null, finished = true)).copy(finished = true))
            runId
        }
    }

    /** A `verification.result` answer; a terminal outcome marks the run finished. */
    @Synchronized
    fun recordResult(result: VerificationResult) {
        val prior = runs[result.runId]
        val finished = (prior?.finished == true) || (result.outcome != null && result.outcome != Verifications.OUTCOME_RUNNING)
        put(
            Run(
                result.runId, result.taskId ?: prior?.taskId ?: "", result.sandbox ?: prior?.sandbox,
                result.label.ifEmpty { prior?.label ?: "" }, prior?.startedSequence, finished, result, prior?.replayed ?: false,
            ),
        )
    }

    @Synchronized
    internal fun clearForTests() = runs.clear()

    private fun put(run: Run) {
        runs.remove(run.runId)
        runs[run.runId] = run
        while (runs.size > MAX_RUNS) runs.remove(runs.keys.first())
    }
}
