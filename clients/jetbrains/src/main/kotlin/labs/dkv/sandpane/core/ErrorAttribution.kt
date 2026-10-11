// Rendering a failure with its PROVENANCE.
//
// Why this exists as a separate seam (AGENTS.md rule 5): this client refuses some requests before
// a byte is written — an invalid id, an over-long limit, a method the connected Core never
// advertised, a project-wide replay paused behind an earlier refusal — and Core refuses others with
// a structured `err` frame carrying a SCREAMING_SNAKE code. Those are different facts, and a
// surface that prints `"$method failed: ${error.message}"` blurs them: the user reads "task.list
// failed", a Core verdict, for a request Core never saw. Every display site goes through here so
// there is exactly one sentence for "this plugin refused" and one for "Core answered".
//
// Pure string building: no Swing, no socket, no IDE service, so it is unit-testable and safe to
// call from the EDT.
package labs.dkv.sandpane.core

import kotlinx.serialization.SerializationException
import labs.dkv.sandpane.text.VisibleText
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeoutException

/**
 * Turns a failed future's throwable into one honest sentence naming WHO refused.
 *
 * [describe] is the entry point; [unwrap] exists because `CompletableFuture` puts a
 * [CompletionException] between the failure and a `whenComplete { _, error -> }` handler, and the
 * wrapper's own message is a Java-built `cause.toString()` — showing it raw hands the user a
 * `java.util.concurrent` class name and no provenance.
 */
object ErrorAttribution {

    /** Peel [CompletionException] / [ExecutionException] wrappers down to the failure itself. */
    fun unwrap(error: Throwable?): Throwable? {
        var current = error
        while (current is CompletionException || current is ExecutionException) {
            current = current.cause ?: return current
        }
        return current
    }

    /**
     * Who refused, in the user's terms — no method prefix. Always ONE line with hidden characters
     * escaped ([VisibleText.reveal]): the text carries Core's own messages, and every surface that
     * shows it (notification bodies keep real newlines) must not let it fake a line (S2).
     */
    fun describe(error: Throwable?): String = VisibleText.reveal(describeRaw(error))

    private fun describeRaw(error: Throwable?): String = when (val t = unwrap(error)) {
        null ->
            "Core gave no answer: the request finished with neither a result nor an error"

        // ---- this client's word: nothing was sent -------------------------------------------
        is CoreValidationException ->
            "refused by this plugin before anything was sent — guard on '${t.field}': " +
                (t.message?.removePrefix("${t.field}: ") ?: "no reason given")

        is MethodNotSupportedException ->
            "not sent by this plugin — ${t.message}"

        is ReplayPausedException ->
            "not sent by this plugin — a project-wide replay is paused behind Core's earlier " +
                "refusal, and retrying it unchanged cannot converge: ${t.coreRefusal}"

        // ---- Core's verdict -----------------------------------------------------------------
        is CoreRpcException ->
            if (t.raisedByCore) {
                "Core refused ${t.code}: ${t.message}"
            } else {
                // Core's frame was unusable; this plugin raised the code, Core did not.
                "Core's reply was unusable (${t.code} raised by this plugin, not by Core): ${t.message}"
            }

        // ---- the wire, not a judgment -------------------------------------------------------
        is CoreTransportException ->
            "Core could not be reached — nothing was sent: ${t.message}"

        is FrameExceedsCapException ->
            "Core's answer passed the ${t.limitBytes}-byte frame cap (saw ${t.sawBytes}); the " +
                "stream was dropped rather than truncated"

        is TimeoutException ->
            "Core did not answer before the deadline; the request may still be running there, " +
                "so no result is assumed"

        // ---- a reply that did not decode: never echoed (review I3) --------------------------
        // kotlinx puts a snippet of the JSON input in these messages, so the message is never shown.
        is SerializationException ->
            "Core sent a reply this plugin could not decode; its content is not shown"

        is IllegalArgumentException ->
            "this plugin could not process Core's reply (${t.javaClass.simpleName}); its content is not shown"

        else ->
            "${t.javaClass.simpleName}: ${t.message ?: "no message"}"
    }

    /** [describe] with the RPC method in front: `task.list — Core refused VALIDATION_FAILED: …`. */
    fun describe(method: String, error: Throwable?): String = "$method — ${describe(error)}"

    /**
     * True when NOTHING reached Core, so a surface must not present the operation as a failure AT
     * Core. A [CoreRpcException] this plugin raised about an unusable reply is NOT included: that
     * request was sent and did get an answer, it was just not a usable one.
     */
    fun refusedLocally(error: Throwable?): Boolean =
        when (unwrap(error)) {
            is CoreValidationException, is MethodNotSupportedException, is ReplayPausedException,
            is CoreTransportException -> true

            else -> false
        }

    /**
     * A notification title whose verb matches the provenance. `"<method> failed"` over a request
     * this client never sent is the misattribution [describe] exists to prevent, so titles come
     * from here too.
     */
    fun headline(method: String, error: Throwable?): String {
        val t = unwrap(error)
        return when {
            refusedLocally(error) -> "Sandpane: $method not sent"
            t is CoreRpcException && t.raisedByCore -> "Sandpane: $method refused by Core"
            t is CoreRpcException -> "Sandpane: $method answer unusable"
            t is TimeoutException -> "Sandpane: $method did not answer in time"
            else -> "Sandpane: $method failed"
        }
    }
}
