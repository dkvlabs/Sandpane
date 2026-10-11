package labs.dkv.sandpane.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import labs.dkv.sandpane.model.ApplyResult
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreEventKinds
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeoutException

/**
 * A6 `git.apply` (design 2026-10-09 §3.6): Core's message constants and the honest copy for every
 * outcome. Pure string building, no Swing and no socket, so every sentence is unit-tested.
 *
 * Rules the copy obeys:
 *  - `applied: true` is the ONLY success. A `partial` result is a warning that files MAY have been
 *    written or staged, quoting Core's reason (which names `git status` / `.git/index.lock`) uncut.
 *  - `git.apply` is not read-only and not replay-safe: a timeout, a dropped connection or an answer
 *    this plugin could not read is a LOST answer — "the apply may have been applied" — never
 *    "nothing changed", and nothing is ever retried automatically.
 *  - Only a refusal raised by this plugin before the socket says "nothing was sent".
 *  - Core's own words are revealed (hidden and bidi characters shown as escapes) and capped; an
 *    unknown reason is shown verbatim, never reinterpreted.
 *
 * The messages below are Core's constants (sandpane-core `apply.rs`, sandpane-service
 * `git_apply.rs`), drift-checked byte for byte by ProtocolDriftGuardTest.
 */
object GitApplies {
    const val NOTHING_WRITTEN: String = "; nothing was written"
    const val MSG_NEEDS_REVIEW: String =
        "git.apply needs reviewId and a non-empty entries list copied from a git.review answer; nothing was written"
    const val MSG_SELECTED_FILES: String =
        "selectedFiles is not accepted: send reviewId and entries copied from a git.review answer instead; nothing was written"
    const val MSG_TOO_MANY_ENTRIES: String = "at most 1000 entries can be applied at once; nothing was written"
    const val MSG_ENTRIES_NOT_REVIEWED: String =
        "entries do not match a review Core produced; review again; nothing was written"
    const val MSG_CHECK_FAILED: String = "the patch does not apply cleanly; nothing was written"
    const val MSG_CHECK_UNAVAILABLE: String = "git could not check the patch (timed out or failed); nothing was written"

    /** W-B: `git apply` never started (configuration read timed out or failed). Not partial. */
    const val MSG_WRITE_NOT_RUN: String =
        "git apply was not started (reading the repository's configuration timed out or failed); nothing was written"

    /** W-B: `git apply` never started (too little of the time budget left). Not partial. */
    const val MSG_WRITE_TOO_LATE: String =
        "git apply was not started (too little of its time budget was left to finish it safely); nothing was written"

    /** `msg_changed(path)` = `<"path">` + this. */
    const val CHANGED_SUFFIX: String = " changed since it was reviewed; review it again$NOTHING_WRITTEN"

    /** `msg_mounted(what)` = `<sandbox "name" | direct_mount task id>` + this (CONFLICT). */
    const val MOUNTED_SUFFIX: String =
        ": a sandbox mounts this repository directly and can change it while Core writes; stop or remove it first$NOTHING_WRITTEN"

    /** `msg_locked(repo, holder)` = repo + [LOCKED_INFIX] + holder + [LOCKED_SUFFIX] (CONFLICT). */
    const val LOCKED_INFIX: String = " is busy: "
    const val LOCKED_SUFFIX: String =
        " holds its writer lock (a running writer task, another apply or a worktree discard)$NOTHING_WRITTEN"

    /**
     * W-N1 (CONFLICT): `msg_mount_being_created(repo, sandbox)` = repo + [LOCKED_INFIX] +
     * `sandbox "<name>"` + this. A direct_mount sandbox of the repository is being created.
     */
    const val MOUNT_BEING_CREATED_SUFFIX: String =
        " is being created with a direct mount of it and could change it while Core writes$NOTHING_WRITTEN"

    /** Core's `MAX_APPLY_ENTRIES`: entries per call. */
    const val MAX_ENTRIES: Int = 1000

    /** The gate copy when Core does not advertise `git-apply` (§3.6 item 10). */
    const val NOT_IMPLEMENTED: String =
        "Apply is not implemented by this Core (it does not advertise the git-apply feature); nothing is sent."

    /** Cap for one Core reason: long enough that a partial's `git status` / index.lock text is never cut. */
    const val MAX_REASON_CODE_POINTS: Int = 2_000

    /** Paths listed per notification section before a count. */
    const val MAX_LISTED: Int = 20

    enum class Severity { INFO, WARNING, ERROR }

    /**
     * What one apply outcome shows. [mayHaveWritten] is true whenever files may have changed on
     * disk (success, partial, lost answer), so the caller refreshes the VCS view; [offerReviewAgain]
     * adds a "Review again" action for the stale-review outcomes. [sentToCore] is false ONLY for a
     * refusal this plugin raised before the socket: a dropped connection, a timeout or an unreadable
     * reply all count as sent (the frame may have reached Core), so the used review is discarded.
     */
    data class Presentation(
        val title: String,
        val body: String,
        val severity: Severity,
        val offerReviewAgain: Boolean,
        val mayHaveWritten: Boolean,
        val sentToCore: Boolean = true,
    )

    fun repoLabel(repoPath: String?): String =
        repoPath?.let { VisibleText.reveal(DisplayCap.cap(it)) } ?: "the task's repository (Core did not report its path)"

    /** Core's text, single-line revealed and capped generously. */
    fun core(text: String): String = VisibleText.reveal(DisplayCap.cap(text, MAX_REASON_CODE_POINTS))

    /** §3.6 item 8: a lost answer for git.apply. Exact wording shared by every client. */
    fun timeoutCopy(repoPath: String?): String =
        "Core did not answer in time — the apply may have been applied; check `git status` in ${repoLabel(repoPath)} before retrying"

    private fun lostCopy(why: String, repoPath: String?): String =
        "Core's answer was lost ($why) — the apply may have been applied; check `git status` in ${repoLabel(repoPath)} " +
            "before retrying"

    private fun pathList(label: String, paths: List<String>): String {
        if (paths.isEmpty()) return ""
        val shown = paths.take(MAX_LISTED).joinToString(", ") { VisibleText.reveal(DisplayCap.cap(it)) }
        val more = paths.size - MAX_LISTED
        return "\n$label (${paths.size}): $shown" + if (more > 0) ", … and $more more" else ""
    }

    private fun files(n: Int): String = if (n == 1) "1 file" else "$n files"

    /** The copy for an `ok` answer. [sent] is the number of entries this plugin sent. */
    fun presentResult(result: ApplyResult, repoPath: String?, sent: Int): Presentation {
        val repo = repoLabel(repoPath)
        val reason = result.abortReason
        if (result.applied) {
            val n = result.appliedFiles?.size ?: sent
            val modes = result.modeChanges.orEmpty().take(MAX_LISTED).joinToString("") {
                "\nmode change: ${VisibleText.reveal(DisplayCap.cap(it.path))} ${core(it.from)} → ${core(it.to)}"
            }
            val moreModes = (result.modeChanges?.size ?: 0) - MAX_LISTED
            return Presentation(
                title = "Sandpane: applied ${files(n)} (staged, not committed)",
                body = "Applied ${files(n)} to $repo (staged, not committed)." + modes +
                    (if (moreModes > 0) "\n… and $moreModes more mode change(s)" else "") +
                    pathList("files", result.appliedFiles.orEmpty()) +
                    "\nRefresh your VCS view to see them. Nothing was committed.",
                severity = Severity.INFO,
                offerReviewAgain = false,
                mayHaveWritten = true,
            )
        }
        if (result.partial == true) {
            return Presentation(
                title = "Sandpane: apply did NOT complete — files may have been written",
                body = "Not a success: some files may have been written or staged in $repo.\nCore said: " +
                    (reason?.let(::core) ?: "no reason given") +
                    pathList("files in this apply (may have been written)", result.appliedFiles.orEmpty()) +
                    "\nNothing was committed. Check `git status` before you apply or review again.",
                severity = Severity.WARNING,
                offerReviewAgain = true,
                mayHaveWritten = true,
            )
        }
        val conflicts = pathList("files git names", result.conflictedFiles)
        val saidNothing = reason?.endsWith(NOTHING_WRITTEN) == true
        val title = if (saidNothing) "Sandpane: not applied — nothing was written" else "Sandpane: not applied"
        val (body, again) = when {
            reason == null -> "Core did not apply the files and gave no reason." to false
            reason == MSG_ENTRIES_NOT_REVIEWED ->
                "Core no longer knows the review these files came from (Core restarted, or a newer review " +
                    "replaced it). Review again, then choose the files again. Core: ${core(reason)}" to true
            reason.endsWith(CHANGED_SUFFIX) ->
                "A file changed since you reviewed it, so Core refused rather than apply content you did not " +
                    "review. Review again. Core: ${core(reason)}" to true
            reason == MSG_CHECK_FAILED ->
                "The patch does not apply cleanly to your working tree; nothing was written." to false
            reason == MSG_WRITE_NOT_RUN || reason == MSG_WRITE_TOO_LATE ->
                "git apply was never started, so nothing was written. Core: ${core(reason)}" to false
            reason == MSG_CHECK_UNAVAILABLE ->
                "Core: ${core(reason)}. git could not run its check, so Core cannot say whether the files would apply." to false
            else -> "Core said: ${core(reason)}" to false
        }
        return Presentation(title, body + conflicts, Severity.WARNING, again, mayHaveWritten = false)
    }

    /** The copy for a failed call: who refused, and whether files may have been written. */
    fun presentFailure(error: Throwable?, repoPath: String?): Presentation {
        val method = CoreMethods.GIT_APPLY
        val t = ErrorAttribution.unwrap(error)
        if (t is CoreValidationException || t is MethodNotSupportedException || t is ReplayPausedException) {
            return Presentation(
                ErrorAttribution.headline(method, error),
                ErrorAttribution.describe(method, error) + " Nothing was sent, so nothing was written.",
                Severity.ERROR,
                offerReviewAgain = false,
                mayHaveWritten = false,
                sentToCore = false,
            )
        }
        if (t is TimeoutException) {
            return Presentation(
                "Sandpane: git.apply did not answer in time",
                timeoutCopy(repoPath),
                Severity.WARNING,
                offerReviewAgain = true,
                mayHaveWritten = true,
            )
        }
        if (t !is CoreRpcException || !t.raisedByCore) {
            // Sent (or possibly sent), but no usable answer: the dropped connection, an oversized or
            // undecodable reply. Never echoed (ErrorAttribution keeps decode messages out).
            val why = when (t) {
                is CoreTransportException -> "the connection to Core was lost"
                is FrameExceedsCapException -> "the reply passed the frame cap"
                is CoreRpcException -> "the reply was unusable"
                null -> "no answer"
                else -> "the reply could not be read"
            }
            return Presentation(
                "Sandpane: git.apply outcome unknown",
                lostCopy(why, repoPath),
                Severity.WARNING,
                offerReviewAgain = true,
                mayHaveWritten = true,
            )
        }
        val msg = t.message
        val shown = core(msg)
        val repo = repoLabel(repoPath)
        return when {
            t.code == CoreErrorCodes.CONFLICT && msg.endsWith(LOCKED_SUFFIX) && msg.contains(LOCKED_INFIX) -> Presentation(
                "Sandpane: repository busy — nothing was written",
                "$repo is busy: another Core operation holds its writer lock (Core: $shown). Nothing was written. " +
                    "Apply again after that operation finishes.",
                Severity.WARNING,
                offerReviewAgain = false,
                mayHaveWritten = false,
            )
            t.code == CoreErrorCodes.CONFLICT && msg.endsWith(MOUNT_BEING_CREATED_SUFFIX) -> Presentation(
                "Sandpane: apply refused \u2014 a direct-mount sandbox is being created",
                "Core: $shown\nA sandbox that mounts $repo directly is being created. Once it exists, Core refuses " +
                    "every apply until you stop or remove it. Nothing was written.",
                Severity.WARNING,
                offerReviewAgain = false,
                mayHaveWritten = false,
            )
            t.code == CoreErrorCodes.CONFLICT && msg.endsWith(MOUNTED_SUFFIX) -> Presentation(
                "Sandpane: apply refused — a sandbox mounts this repository directly",
                "Core: $shown\nA sandbox or direct_mount task mounts $repo directly and could change it while Core " +
                    "writes. Stop or remove that sandbox or task first (Core names it above); until then every apply " +
                    "is refused. Nothing was written.",
                Severity.WARNING,
                offerReviewAgain = false,
                mayHaveWritten = false,
            )
            t.code == CoreErrorCodes.NOT_FOUND -> Presentation(
                ErrorAttribution.headline(method, error),
                "Core has no task with this id (Core: $shown), so there was nothing to apply.",
                Severity.ERROR,
                offerReviewAgain = false,
                mayHaveWritten = false,
            )
            t.code == CoreErrorCodes.INTERNAL && !msg.endsWith(NOTHING_WRITTEN) -> Presentation(
                ErrorAttribution.headline(method, error),
                "Core reported an internal error: $shown\nCore did not say whether files were written — check " +
                    "`git status` in $repo before retrying.",
                Severity.ERROR,
                offerReviewAgain = true,
                mayHaveWritten = true,
            )
            else -> Presentation(
                ErrorAttribution.headline(method, error),
                "Core refused ${t.code}: $shown",
                Severity.ERROR,
                offerReviewAgain = false,
                mayHaveWritten = false,
            )
        }
    }

    // -----------------------------------------------------------------------
    // durable apply events (§3.6 item 8), decoded as optional/open
    // -----------------------------------------------------------------------

    /** A note for one of the four apply event kinds, or null for any other kind. Never echoes a payload. */
    fun eventNote(kind: String, payload: JsonElement): String? {
        if (kind !in CoreEventKinds.APPLY) return null
        val obj = payload as? JsonObject ?: return "$kind event with an unreadable payload (not shown)"
        val files = (obj["files"] as? JsonArray)?.size
        val count = files?.let { " ${it} file(s)" } ?: ""
        val reason = ((obj["reason"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull)?.let { ": ${core(it)}" } ?: ""
        return when (kind) {
            CoreEventKinds.GIT_APPLY_STARTED ->
                "apply started:$count — Core records this before it writes into the repository"
            CoreEventKinds.GIT_APPLIED ->
                "apply recorded as done:$count written into the working tree and staged, not committed"
            CoreEventKinds.GIT_APPLY_FAILED ->
                if ((obj["partial"] as? JsonPrimitive)?.booleanOrNull == true) {
                    "apply did NOT complete — some files may have been written or staged$reason"
                } else {
                    "apply did not happen$reason"
                }
            else -> {
                val outcome = (obj["outcome"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
                    ?.let { core(DisplayCap.cap(it, 40)) } ?: "not reported"
                "Core restarted during an apply and cannot know for sure what was written; its check of the " +
                    "repository afterwards says '$outcome' — check `git status`"
            }
        }
    }
}

/**
 * §3.6 item 7: Apply is single-flight per task, across every window of this IDE. There is no
 * "Retry safely" for `git.apply` (Core gives no idempotency, and a retry after success is refused by
 * Core's dirty gate), so a second click while one apply runs is refused here.
 */
object ApplyInFlight {
    private val active: MutableSet<String> = ConcurrentHashMap.newKeySet()

    /** True when this call claimed [taskId]; false while another apply for it runs. */
    fun begin(taskId: String): Boolean = active.add(taskId)

    fun end(taskId: String) {
        active.remove(taskId)
    }

    fun isActive(taskId: String): Boolean = taskId in active
}
