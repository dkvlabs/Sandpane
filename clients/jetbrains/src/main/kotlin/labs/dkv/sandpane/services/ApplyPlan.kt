package labs.dkv.sandpane.services

import labs.dkv.sandpane.core.CoreCommands
import labs.dkv.sandpane.core.GitApplies
import labs.dkv.sandpane.model.ApplyResult
import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.GitApplyParams
import labs.dkv.sandpane.model.Reported
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText
import java.util.concurrent.CompletableFuture
import java.text.Normalizer
import java.util.Locale

/**
 * What a confirmed "Apply" sends to Core (A6, design 2026-10-09 \u00A73.6), derived ONLY from one
 * `git.review` answer ([ReviewSession]) and the user's checkbox selection over it. Pure, no I/O.
 *
 *  - An entry is selectable only when it has a known status and is bound to reviewed content:
 *    `taskBlob` AND `taskMode`, or `deleted` (no content to bind), and never mode `120000`.
 *  - The wire entries are the review answer's OWN JSON objects for the selected rows, in review
 *    order (never rebuilt from the typed [FileChange]), with that answer's `reviewId`.
 *  - If a `git.diff` the user opened in this review showed a `taskBlob` other than the entry's, the
 *    review is stale: nothing is sent and the user is asked to review again (\u00A73.6 item 9).
 *  - Nothing is stricter than Core: Core's own 1000-entry limit is the only count limit, an empty
 *    selection is refused because Core refuses it too, and a dirty host is a disclosure (Core's gate
 *    covers the touched paths only), not a refusal.
 */
object ApplyPlan {

    sealed class Decision {
        /** Ready to confirm and send; [entries] are the typed views of [GitApplyParams.entries]. */
        data class Ready(val params: GitApplyParams, val entries: List<FileChange>) : Decision()

        /** Nothing is sent; [reason] is user-facing. [reviewAgain] offers a fresh `git.review`. */
        data class Refused(val reason: String, val reviewAgain: Boolean = false) : Decision()
    }

    const val REASON_SYMLINK: String = "symlinks are never applied"
    const val REASON_TOO_LARGE: String = "too large or unreadable to apply (over 32 MiB)"
    const val REASON_NO_CONTENT_ID: String = "no reviewed content id"
    const val REASON_UNKNOWN_STATUS: String = "status unknown to this plugin build"

    const val UNSEEN_NEVER_OPENED: String = "never opened in the Diff view"
    const val UNSEEN_BINARY: String = "shown as binary (no text diff)"
    const val UNSEEN_TRUNCATED: String = "the diff was truncated"

    private const val SYMLINK_MODE = "120000"
    private const val EXECUTABLE_MODE = "100755"

    /**
     * Null when [change] may be selected, else why not. Splitting the two "no content" reasons:
     * with a `reviewId`, an entry Core left without blob AND mode was over the 32 MiB cap or not a
     * file Core could read; an entry with only one of them, or any entry of a review without a
     * `reviewId` (not a `host_worktree` task, or a pre-A6 Core), carries no reviewed content id.
     */
    fun selectability(changeSet: ChangeSet, change: FileChange): String? {
        if (change.status is Reported.Unknown) return REASON_UNKNOWN_STATUS
        if (change.taskMode == SYMLINK_MODE) return REASON_SYMLINK
        if (changeSet.reviewId.isNullOrEmpty()) return REASON_NO_CONTENT_ID
        if (change.status == Reported.Known(FileChangeStatus.DELETED)) return null
        return when {
            change.taskBlob != null && change.taskMode != null -> null
            change.taskBlob == null && change.taskMode == null -> REASON_TOO_LARGE
            else -> REASON_NO_CONTENT_ID
        }
    }

    /** The first entry of the review whose opened diff showed other content, or null. */
    fun changedAfterReview(session: ReviewSession): FileChange? =
        session.changeSet.changes.firstOrNull { change ->
            val seen = session.diffFor(change) ?: return@firstOrNull false
            // Nullable comparison: a diff with no taskBlob for an entry that has one is not proof
            // the content is the same, so it fails closed as well.
            seen.taskBlob != change.taskBlob
        }

    /** The copy for [changedAfterReview] (\u00A73.6 item 9). */
    fun changedCopy(change: FileChange): String =
        "${VisibleText.reveal(DisplayCap.cap(change.path))} changed after you reviewed it \u2014 review again"

    fun decide(session: ReviewSession, selected: List<Int>): Decision {
        val review = session.changeSet
        val reviewId = review.reviewId
        if (reviewId.isNullOrEmpty()) {
            return Decision.Refused(
                "Core gave this review no reviewId, so none of its files is bound to reviewed content (only " +
                    "host_worktree tasks can be applied); nothing is sent",
            )
        }
        if (review.baseCommit.isBlank()) {
            return Decision.Refused("Core reported no base commit for this review; nothing is sent")
        }
        val indices = selected.distinct().sorted()
        if (indices.isEmpty()) return Decision.Refused("no file is selected; nothing is sent")
        if (indices.size > GitApplies.MAX_ENTRIES) {
            return Decision.Refused(
                "Core applies at most ${GitApplies.MAX_ENTRIES} files at once and ${indices.size} are selected; " +
                    "select fewer. Nothing is sent",
            )
        }
        val out = indices.firstOrNull { it !in review.changes.indices || it !in session.rawChanges.indices }
        if (out != null) return Decision.Refused("the selection does not match this review; review again", reviewAgain = true)
        for (i in indices) {
            selectability(review, review.changes[i])?.let { why ->
                return Decision.Refused("${displayPath(review.changes[i].path)} cannot be applied: $why; nothing is sent")
            }
        }
        changedAfterReview(session)?.let { return Decision.Refused(changedCopy(it), reviewAgain = true) }
        return Decision.Ready(
            GitApplyParams(
                taskId = review.taskId,
                expectedBase = review.baseCommit,
                reviewId = reviewId,
                entries = indices.map { session.rawChanges[it] },
            ),
            indices.map { review.changes[it] },
        )
    }

    /**
     * Send a [Decision.Ready] through [commands]; a [Decision.Refused] sends nothing and returns
     * null. The ONLY way the Apply action reaches the socket, so a refusal can never leak a frame.
     */
    fun submit(decision: Decision, commands: CoreCommands): CompletableFuture<ApplyResult>? = when (decision) {
        is Decision.Refused -> null
        is Decision.Ready -> commands.gitApply(decision.params)
    }

    // -----------------------------------------------------------------------
    // confirmation flags (\u00A73.6 item 9)
    // -----------------------------------------------------------------------

    /** (a) Null when the user saw this entry's full content as a text diff in this review, else why not. */
    fun notFullyShown(session: ReviewSession, change: FileChange): String? {
        val seen = session.diffFor(change) ?: return UNSEEN_NEVER_OPENED
        return when {
            seen.taskBlob != change.taskBlob -> UNSEEN_NEVER_OPENED
            seen.binary -> UNSEEN_BINARY
            seen.truncated -> UNSEEN_TRUNCATED
            else -> null
        }
    }

    /** (b) An executable addition or an exec-bit change: the reviewed mode is `100755`. */
    fun isExecutable(change: FileChange): Boolean = change.taskMode == EXECUTABLE_MODE

    /**
     * (c) A path that runs automatically. Matched on path COMPONENTS, case-folded ([foldKey]), on
     * both `path` and a rename's `oldPath`:
     *  - a directory component `.husky`, `.githooks`, `.vscode` or `.idea` at any depth (hooks and
     *    editor tasks; a sub-folder opened on its own reads its own);
     *  - `.github/workflows/` at the root (CI);
     *  - `.envrc`, `.gitattributes` at ANY depth (direnv and git read nested ones), `.gitmodules`
     *    at the root;
     *  - anything under Core's repo-relative `hostHooksPath`, when Core reports one.
     * Over-matching only adds a flag; it never blocks.
     */
    fun runsAutomatically(change: FileChange, hostHooksPath: String?): Boolean =
        listOfNotNull(change.path, change.oldPath).any { autoRunPath(it, hostHooksPath) }

    private val TOOL_DIRS = setOf(".husky", ".githooks", ".vscode", ".idea")
    private val ANY_DEPTH_FILES = setOf(".envrc", ".gitattributes")

    private fun components(path: String): List<String> =
        foldKey(path).split('/').filter { it.isNotEmpty() && it != "." }

    private fun autoRunPath(path: String, hostHooksPath: String?): Boolean {
        val parts = components(path)
        if (parts.isEmpty()) return false
        if (parts.dropLast(1).any { it in TOOL_DIRS }) return true
        if (parts.size > 2 && parts[0] == ".github" && parts[1] == "workflows") return true
        if (parts.last() in ANY_DEPTH_FILES) return true
        if (parts.size == 1 && parts[0] == ".gitmodules") return true
        val hooks = hostHooksPath?.let(::components).orEmpty()
        return hooks.isNotEmpty() && parts.size > hooks.size && parts.subList(0, hooks.size) == hooks
    }

    /**
     * One checkbox row of the selection dialog: wire status, `oldPath \u2192 path` (revealed and
     * shortened by [displayPath]) and, for a row that cannot be selected, why not; otherwise the
     * flags the confirmation will raise for it. Plain text (the dialog never renders it as HTML).
     */
    fun rowLabel(session: ReviewSession, change: FileChange): String {
        val name = change.oldPath?.let { "${displayPath(it)} \u2192 ${displayPath(change.path)}" } ?: displayPath(change.path)
        val head = "${VisibleText.reveal(change.status.wireName)}  $name"
        selectability(session.changeSet, change)?.let { return "$head   \u2014 not selectable: $it" }
        val notes = listOfNotNull(
            notFullyShown(session, change),
            "executable (mode 100755)".takeIf { isExecutable(change) },
            "runs automatically".takeIf { runsAutomatically(change, session.changeSet.hostHooksPath) },
        )
        return if (notes.isEmpty()) head else "$head   [${notes.joinToString("; ")}]"
    }

    /** Lines of a bounded path list (notifications, plain surfaces) before collapsing the rest into a count. */
    const val MAX_LISTED_PATHS = 20

    /**
     * Suffix on a listed path that was shown escaped, or that literally contains text which reads
     * like an escape (`\n`, `\u202E`, …) — the two are indistinguishable once displayed (S6).
     */
    const val HIDDEN_CHARS_FLAG = "[!] hidden, control or look-alike characters, or a literal escape sequence"

    /**
     * Identity of a path on a case-insensitive, normalizing filesystem (the macOS and Windows
     * defaults): NFC, then locale-independent lower case. An APPROXIMATION of APFS/NTFS folding —
     * edge cases such as Greek final sigma or NTFS upcase-table entries can differ. Used to match
     * the "runs automatically" components of flag (c) case-insensitively (over-matching only flags).
     */
    fun foldKey(path: String): String = Normalizer.normalize(path, Normalizer.Form.NFC).lowercase(Locale.ROOT)

    /** A bounded list for a dialog: the entries shown, plus a line saying what was not. */
    data class Listing(val cells: List<String>, val overflow: String?)

    /**
     * The reviewed paths as dialog entries, bounded: one display-safe cell per path ([displayPath])
     * and, past [limit], an overflow line that still counts the flagged ones. The dialog lays each
     * cell out in its own table row ([labs.dkv.sandpane.ui.DialogHtml]), never as free text.
     */
    fun listPaths(paths: List<String>, limit: Int = MAX_LISTED_PATHS): Listing {
        val overflow = if (paths.size > limit) {
            val flagged = paths.drop(limit).count(::needsFlag)
            "… and ${paths.size - limit} more" + if (flagged > 0) " ($flagged of them flagged [!])" else ""
        } else {
            null
        }
        return Listing(paths.take(limit).map(::displayPath), overflow)
    }

    /**
     * Plain-text rendering of [listPaths]: one numbered `  [<n>] ` line per path, then the overflow.
     *
     * Paths are agent-controlled (they come from the sandbox's change set), so each cell is made
     * unable to spoof a list (security reviews of af8949b and of this change):
     *  - control, line-break, bidi and zero-width characters are shown escaped ([VisibleText]),
     *    so a path can never start a fake extra line or reorder its own characters, and the entry
     *    is suffixed with [HIDDEN_CHARS_FLAG] whenever anything was escaped — or whenever the path
     *    literally contains an escape-looking sequence, which would otherwise read the same, or
     *    look-alike compatibility characters (mathematical bold, full-width, …);
     *  - the path's own spaces are NO-BREAK spaces and a non-ASCII space is escaped (and flagged),
     *    so a path cannot choose a break point;
     *  - an absurdly long path keeps its head and tail and says how much was elided. The full
     *    path is still what is sent — only its display is shortened.
     * None of that stops a word-wrapping pane from force-breaking an over-long run at its width.
     * That is why the dialog never shows this text: [labs.dkv.sandpane.ui.DialogHtml] puts every
     * cell in its own table column, so a wrapped tail always starts to the right of the markers.
     */
    fun describePaths(paths: List<String>, limit: Int = MAX_LISTED_PATHS): String = plain(listPaths(paths, limit), "")

    private fun plain(listing: Listing, markerPrefix: String): String = buildString {
        listing.cells.forEachIndexed { index, cell -> appendLine("  [$markerPrefix${index + 1}]$NBSP$cell") }
        listing.overflow?.let { append("  $it") }
    }.trimEnd()

    private const val NBSP = '\u00A0'

    /** Space separators other than U+0020 (NBSP, en/em spaces, ideographic space, …). */
    private fun isOddSpace(c: Char): Boolean =
        c != ' ' && Character.getType(c) == Character.SPACE_SEPARATOR.toInt()

    /**
     * Whether [displayPath] flags [path]: it escapes something in it, or the path literally
     * contains a backslash sequence that looks like one of those escapes (S6).
     */
    private fun needsFlag(path: String): Boolean =
        VisibleText.inspect(path).altered || path.any(::isOddSpace) || LITERAL_ESCAPE.containsMatchIn(path) ||
            hasLookAlikes(path)

    /**
     * Compatibility characters that render like other text — mathematical bold/italic letters,
     * full-width forms, ligatures, superscripts (security re-review W2: `𝐍𝐎𝐓 sent` looks like a
     * bold header). Compared against NFC, so a merely decomposed (NFD) path is not flagged.
     */
    private fun hasLookAlikes(path: String): Boolean =
        Normalizer.normalize(path, Normalizer.Form.NFKC) != Normalizer.normalize(path, Normalizer.Form.NFC)

    /** `\n`, `\r`, `\t`, `\u…`, `\U…` written as ordinary characters. */
    private val LITERAL_ESCAPE = Regex("""\\[nrtuU]""")

    /** Code points of a path shown before eliding its middle. */
    const val MAX_DISPLAYED_PATH_CODE_POINTS = 240

    /**
     * One path as a single, visibly-escaped line with no break opportunity of the path's choosing
     * (see [describePaths]): hidden characters and non-ASCII spaces escaped, ASCII spaces turned
     * into no-break spaces. Only the separator before [HIDDEN_CHARS_FLAG] is breakable, and what
     * follows it is this plugin's own text. Shared by the Apply dialog, the review summary and
     * the conflict notification.
     */
    fun displayPath(path: String): String {
        // Measured over the WHOLE path, so a hidden character in an elided middle still flags it.
        val altered = needsFlag(path)
        val total = path.codePointCount(0, path.length)
        val shown = if (total <= MAX_DISPLAYED_PATH_CODE_POINTS) {
            unbreakable(path)
        } else {
            val keep = MAX_DISPLAYED_PATH_CODE_POINTS / 2
            val headEnd = path.offsetByCodePoints(0, keep)
            val tailStart = path.offsetByCodePoints(path.length, -keep)
            unbreakable(path.substring(0, headEnd)) +
                "$NBSP…(${total - 2 * keep}${NBSP}chars${NBSP}elided)…$NBSP" +
                unbreakable(path.substring(tailStart))
        }
        return if (altered) "$shown   $HIDDEN_CHARS_FLAG" else shown
    }

    /** Reveal, escape non-ASCII spaces as `\uXXXX`, then make the remaining ASCII spaces no-break. */
    private fun unbreakable(part: String): String = buildString(part.length + 8) {
        for (c in VisibleText.reveal(part)) {
            when {
                c == ' ' -> append(NBSP)
                isOddSpace(c) -> append("\\u%04X".format(c.code))
                else -> append(c)
            }
        }
    }
}
