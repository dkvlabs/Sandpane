package labs.dkv.sandpane.ui

import labs.dkv.sandpane.core.GitDiffs
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.GitDiffResult
import labs.dkv.sandpane.model.Reported
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText

/**
 * What the read-only diff viewer shows for one `git.diff` answer (A5). The patch is UNTRUSTED data:
 * revealed (hidden and bidi characters become visible escapes), shown as plain text, never rendered,
 * executed, applied or written. Names come from the JSON `path` / `oldPath` only, never the patch header.
 * Copy never claims more than Core said: no "no changes" for a binary, truncated or empty answer.
 */
object GitDiffText {
    const val BINARY_COPY: String = "treated as binary (possibly by repository attributes) \u2014 no text diff shown"
    const val LOSSY_COPY: String = "contains bytes that are not valid UTF-8; shown with replacement characters"
    const val EMPTY_COPY: String = "Core returned an empty patch"
    const val UNSUPPORTED: String =
        "Per-file diff: not supported by this Core (it does not advertise git.diff); nothing is sent."
    /**
     * W3: how a carriage return in the patch is shown: the same `\r` escape [VisibleText] uses, so a CR
     * is never obeyed (it cannot return the caret and overwrite the start of the line) and never hidden
     * (a CRLF ending is NOT folded into the line break, as [VisibleText.revealMultiline] does for chat).
     */
    const val CR_MARKER: String = "\\r"
    const val READ_ONLY_NOTE: String =
        "Read-only view of Core's patch. It is never applied, copied into the project or run."

    private fun shown(path: String): String = VisibleText.reveal(DisplayCap.cap(path))

    /** `old \u2192 new` for a rename, else the path; revealed and capped. */
    fun pathLabel(path: String, oldPath: String?): String =
        oldPath?.let { "${shown(it)} \u2192 ${shown(path)}" } ?: shown(path)

    fun truncatedCopy(maxBytes: Int?): String =
        "diff truncated at ${GitDiffs.clampMaxBytes(maxBytes) ?: GitDiffs.DEFAULT_BYTES} bytes"

    fun title(result: GitDiffResult): String = "Sandpane: git.diff \u00B7 " + pathLabel(result.path, result.oldPath)

    /** One chooser row: the wire status and the (revealed) path, from Core's change entry. */
    fun entryLabel(change: FileChange): String = "${change.status.wireName}  ${pathLabel(change.path, change.oldPath)}"

    fun disclosures(result: GitDiffResult, requestedMaxBytes: Int?): List<String> = buildList {
        add("status: ${VisibleText.reveal(result.status.wireName)}")
        result.oldPath?.let { add("renamed: ${pathLabel(result.path, it)}") }
        symlinkTarget(result)?.let { add(it) }
        if (result.binary) add(BINARY_COPY)
        if (result.truncated) add(truncatedCopy(requestedMaxBytes))
        if (result.lossy) add(LOSSY_COPY)
        if (!result.binary) crlfLineCount(result.patch).takeIf { it > 0 }?.let { add(crlfCopy(it)) }
        if (result.patch.isEmpty() && !result.binary && !result.truncated) add(EMPTY_COPY)
        result.baseBlob?.let { add("base blob ${VisibleText.reveal(it.take(12))}") }
    }

    /**
     * "symlink \u2192 target" for Core's untracked mode-120000 patch, whose single `+` line is the link
     * text (never the target's content). Read from the patch's fixed line positions: Core C-quotes a
     * newline in a header name, so a file name cannot forge the mode line.
     */
    fun symlinkTarget(result: GitDiffResult): String? {
        if (result.status != Reported.Known(FileChangeStatus.UNTRACKED) || result.binary || result.truncated) return null
        val lines = result.patch.split("\n")
        if (lines.size < 6 || !lines[0].startsWith("diff --git ") || lines[1] != "new file mode 120000") return null
        val hunk = lines.indexOfFirst { it.startsWith("@@ ") }
        if (hunk < 0 || lines[hunk] != "@@ -0,0 +1 @@") return null
        val added = lines.drop(hunk + 1).filter { it.startsWith("+") }
        if (added.size != 1) return null
        return "symlink \u2192 " + shown(added.single().drop(1))
    }

    fun crlfCopy(lines: Int): String =
        "contains $lines ${if (lines == 1) "line" else "lines"} with carriage returns (CRLF) \u2014 shown as $CR_MARKER"

    /** Lines (split on `\n` only; never [String.lines], which also splits on a bare CR) ending in CR. */
    fun crlfLineCount(patch: String): Int = patch.split('\n').count { it.endsWith('\r') }

    /**
     * The patch for the read-only text area; empty when binary. Split on `\n` ONLY, each line revealed
     * on its own (tabs stay real), then rejoined with `\n`: a CR, whether a CRLF ending or a lone one
     * inside a line, becomes the visible [CR_MARKER] and is never turned into, or swallowed by, a break.
     */
    fun body(result: GitDiffResult): String =
        if (result.binary) "" else result.patch.split('\n').joinToString("\n") { VisibleText.revealMultiline(it) }
}
