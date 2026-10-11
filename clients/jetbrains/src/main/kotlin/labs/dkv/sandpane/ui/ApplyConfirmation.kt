package labs.dkv.sandpane.ui

import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.services.ApplyPlan
import labs.dkv.sandpane.services.ReviewSession
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText

/**
 * The A6 Apply confirmation text (design 2026-10-09 §3.6 item 9), separate from the dialog so it
 * can be unit-tested and laid out by the platform's own word-wrapping HTML kit (DialogLayoutTest).
 *
 * It names the repository, lists EVERY file that will be sent with its status (renames as
 * `oldPath → path`), separately flags (a) content never fully shown, (b) executable entries and
 * (c) paths that run automatically, and states what Apply does. Every Core/agent value goes
 * through [DialogHtml] (revealed single-line, so a CR reads `\r`; HTML-escaped; each list entry in
 * its own table row), so no path can lay itself out as a fake entry or header.
 */
object ApplyConfirmation {

    const val TITLE: String = "Sandpane: Apply Reviewed Files"
    const val CANCEL_LABEL: String = "Cancel"
    const val STATEMENT: String =
        "Writes these files into your working tree and stages them. Nothing is committed. " +
            "The content is the version Core hashed when you reviewed."

    /** The explicit OK button: "Apply N files". */
    fun okLabel(count: Int): String = if (count == 1) "Apply 1 file" else "Apply $count files"

    /** The three flag lists, each in the order the files are listed. */
    data class Flags(
        val notFullyShown: List<Pair<FileChange, String>>,
        val executable: List<FileChange>,
        val autoRun: List<FileChange>,
    )

    fun flags(session: ReviewSession, entries: List<FileChange>): Flags = Flags(
        entries.mapNotNull { e -> ApplyPlan.notFullyShown(session, e)?.let { e to it } },
        entries.filter(ApplyPlan::isExecutable),
        entries.filter { ApplyPlan.runsAutomatically(it, session.changeSet.hostHooksPath) },
    )

    private fun name(change: FileChange): String =
        change.oldPath?.let { "${ApplyPlan.displayPath(it)} → ${ApplyPlan.displayPath(change.path)}" }
            ?: ApplyPlan.displayPath(change.path)

    fun message(session: ReviewSession, ready: ApplyPlan.Decision.Ready): DialogHtml {
        val review = session.changeSet
        val entries = ready.entries
        val html = DialogHtml()
            .line("Apply ${entries.size} reviewed file(s) to your repository?")
            .fields(
                "repository" to (review.repoPath?.let { DisplayCap.cap(it) } ?: "not reported by Core"),
                "task" to DisplayCap.cap(review.taskId),
                "base commit" to DisplayCap.cap(review.baseCommit),
                "review" to DisplayCap.cap(ready.params.reviewId),
            )
            .blank()
            .header("Files (${entries.size}) — exactly these are sent:")
            .entries("", entries.map { "${VisibleText.reveal(it.status.wireName)}  ${name(it)}" })
        val flags = flags(session, entries)
        if (flags.notFullyShown.isNotEmpty()) {
            html.blank().header(
                "(a) content never fully shown to you (${flags.notFullyShown.size}) — binary, truncated, or never " +
                    "opened in the Diff view in this review:",
            ).entries("a", flags.notFullyShown.map { (e, why) -> "${name(e)} — $why" })
        }
        if (flags.executable.isNotEmpty()) {
            html.blank().header(
                "(b) executable (${flags.executable.size}) — mode 100755: an executable addition or an " +
                    "exec-bit change:",
            ).entries("b", flags.executable.map(::name))
        }
        if (flags.autoRun.isNotEmpty()) {
            html.blank().header(
                "(c) runs automatically (${flags.autoRun.size}) — git hooks, CI workflows, editor or " +
                    "environment configuration, git attributes or submodules:",
            ).entries("c", flags.autoRun.map(::name))
        }
        if (review.hostDirty) {
            html.blank().line(
                "Core reports other uncommitted changes in your working tree. Core refuses the apply if any " +
                    "selected file is among them; the rest are not touched.",
            )
        }
        return html
            .blank()
            .line(STATEMENT)
            .line("If your repository moved or a file changed since the review, Core refuses and writes nothing.")
    }
}
