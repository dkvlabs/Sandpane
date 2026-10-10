package labs.dkv.sandpane.services

import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.GitApplyParams
import labs.dkv.sandpane.model.Reported
import labs.dkv.sandpane.text.VisibleText
import java.text.Normalizer
import java.util.Locale

/**
 * What a confirmed "Apply" sends to Core, derived ONLY from the change set the user reviewed.
 *
 * Review bug 7: the action confirmed "N reviewed files" but sent `selectedFiles = null`, which
 * Core reads as "no selection given". The request now names exactly the reviewed paths, so what
 * the user confirmed and what Core is asked to apply are the same list. Pure, no I/O.
 *
 * Protocol limit (stated, not papered over): `FileChange` carries only `path` and `status` — no
 * original path for a `renamed` entry (sandpane-protocol `FileChange`). The dialog therefore says
 * which entries are renames whose source Core did not report; this plan does not invent one.
 *
 * Protocol tolerance: an entry whose status a newer Core added ([Reported.Unknown]) is listed but
 * never selected — this build cannot know what applying it means. Such paths go to
 * [Decision.Ready.notSent] and are shown as NOT sent; a change set made only of them is refused.
 */
object ApplyPlan {

    sealed class Decision {
        /**
         * Ready to confirm and send; [params] carries exactly [paths]. [renamedWithoutSource] lists
         * the renamed entries, whose original path the protocol does not carry. [notSent] lists
         * the entries left out of the selection: every entry whose status is unknown to this build,
         * plus every known-status entry that names the same file as one of those on a
         * case-insensitive or normalizing filesystem ([foldKey]). [foldCollisions] groups selected
         * paths that differ only in case or Unicode normalization: legitimate on a case-sensitive
         * filesystem, the same file on the macOS/Windows default, so the dialog points them out.
         */
        data class Ready(
            val params: GitApplyParams,
            val paths: List<String>,
            val renamedWithoutSource: List<String> = emptyList(),
            val notSent: List<FileChange> = emptyList(),
            val foldCollisions: List<List<String>> = emptyList(),
        ) : Decision()

        /** Nothing is sent; [reason] is user-facing. */
        data class Refused(val reason: String) : Decision()
    }

    /** Lines of the confirmation dialog that list paths before collapsing the rest into a count. */
    const val MAX_LISTED_PATHS = 20

    /**
     * Suffix on a listed path that was shown escaped, or that literally contains text which reads
     * like an escape (`\n`, `\u202E`, …) — the two are indistinguishable once displayed (S6).
     */
    const val HIDDEN_CHARS_FLAG = "[!] hidden, control or look-alike characters, or a literal escape sequence"

    fun decide(taskId: String, reviewed: ChangeSet): Decision {
        if (reviewed.taskId != taskId) {
            return Decision.Refused(
                "the reviewed change set belongs to task ${reviewed.taskId}, not $taskId; review this task first",
            )
        }
        if (reviewed.hostDirty) {
            return Decision.Refused(
                "Core reports uncommitted changes in the host working tree for task $taskId. Commit or " +
                    "stash your own work before applying an agent's change set; Sandpane will not overwrite it.",
            )
        }
        if (reviewed.baseCommit.isBlank()) {
            return Decision.Refused("Core reported no base commit for task $taskId, so there is nothing to assert")
        }
        val blank = reviewed.changes.count { it.path.isBlank() }
        if (blank > 0) {
            // Review suggestion 5: a change set with a pathless entry is malformed. Dropping the
            // entry would send a smaller selection than the one Core reported and the user saw.
            return Decision.Refused(
                "Core's change set for task $taskId has $blank entr${if (blank == 1) "y" else "ies"} without a " +
                    "path; refusing rather than applying a selection that differs from the reviewed one",
            )
        }
        // A path reported with ANY unknown status is left out entirely, even if another entry for
        // the same path has a known one: this build cannot tell what applying it would do. "The
        // same path" is compared on [foldKey], so `A.kt` (unknown) also excludes `a.kt` (known):
        // on a case-insensitive filesystem they are one file.
        val unknown = reviewed.changes.filter { it.status is Reported.Unknown }
        val excluded = unknown.map { foldKey(it.path) }.toSet()
        val unknownPaths = unknown.map { it.path }.toSet()
        val notSent = reviewed.changes.filter {
            it.status is Reported.Unknown || (foldKey(it.path) in excluded && it.path !in unknownPaths)
        }
        val paths = reviewed.changes.map { it.path }.distinct().filterNot { foldKey(it) in excluded }
        if (paths.isEmpty() && notSent.isNotEmpty()) {
            return Decision.Refused(
                "every file in Core's change set for task $taskId has a status this plugin build does " +
                    "not define (${unknown.map { it.status.wireName }.distinct().joinToString(", ")}); " +
                    "nothing is selectable, so nothing is sent — update the plugin",
            )
        }
        if (paths.isEmpty()) {
            // An empty selection is a different request from "no selection" — and neither is what
            // a user who reviewed zero files meant. Nothing is sent.
            return Decision.Refused("Core's change set for task $taskId lists no files; there is nothing to apply")
        }
        return Decision.Ready(
            GitApplyParams(taskId = taskId, selectedFiles = paths, expectedBase = reviewed.baseCommit),
            paths,
            reviewed.changes.filter { it.status == Reported.Known(FileChangeStatus.RENAMED) }
                .map { it.path }.distinct().filterNot { foldKey(it) in excluded },
            notSent,
            paths.groupBy(::foldKey).values.filter { it.size > 1 },
        )
    }

    /**
     * Identity of a path on a case-insensitive, normalizing filesystem (the macOS and Windows
     * defaults): NFC, then locale-independent lower case. An APPROXIMATION of APFS/NTFS folding —
     * edge cases such as Greek final sigma or NTFS upcase-table entries can differ. A missed twin
     * means a known-status file is sent as listed; Core's base check still applies.
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

    /** The entries left out of the selection, each with why, as dialog entries. */
    fun listNotSent(notSent: List<FileChange>, limit: Int = MAX_LISTED_PATHS): Listing = Listing(
        notSent.take(limit).map { change ->
            when (val status = change.status) {
                is Reported.Unknown -> "${displayPath(change.path)} — unknown status '${status.wireName}'"
                is Reported.Known ->
                    "${displayPath(change.path)} — same file as an unknown-status entry on a case-insensitive filesystem"
            }
        },
        if (notSent.size > limit) "… and ${notSent.size - limit} more" else null,
    )

    /**
     * Plain-text rendering of [listNotSent] (`  [x<n>] …` lines). The confirmation dialog does not
     * use it — it lays the same cells out as table rows — but plain surfaces and tests do.
     */
    fun describeNotSent(notSent: List<FileChange>, limit: Int = MAX_LISTED_PATHS): String =
        plain(listNotSent(notSent, limit), "x")

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
