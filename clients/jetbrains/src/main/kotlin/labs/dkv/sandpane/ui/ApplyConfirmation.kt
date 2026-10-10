package labs.dkv.sandpane.ui

import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.services.ApplyPlan

/**
 * The Apply confirmation message (docs/specs/04 §3), separate from the action so its rendered
 * layout can be tested with the platform's own word-wrapping HTML kit.
 *
 * Every Core/agent-supplied value goes through [DialogHtml], which reveals and escapes it; the
 * lists of paths are table rows, so no path can lay itself out as a fake entry or header.
 */
object ApplyConfirmation {

    /** Paths shown per case/normalization collision group. */
    const val MAX_PATHS_PER_GROUP = 5

    fun message(taskId: String, reviewed: ChangeSet, plan: ApplyPlan.Decision.Ready): DialogHtml {
        val html = DialogHtml()
            .line("Apply task ${taskId.take(8)} through Core?")
            .blank()
            .header("files (${plan.paths.size}) — exactly these are sent as the selection:")
        val listed = ApplyPlan.listPaths(plan.paths)
        html.entries("", listed.cells)
        listed.overflow?.let(html::line)
        if (plan.foldCollisions.isNotEmpty()) {
            html.blank().header(
                "same file on a case-insensitive filesystem (${plan.foldCollisions.size} group(s)) — these " +
                    "paths differ only in letter case or Unicode normalization:",
            )
            // Bounded like every list here (security re-review W1): an agent must not be able to
            // bury the dialog under case variants.
            val groups = plan.foldCollisions
            html.entries(
                "c",
                groups.take(ApplyPlan.MAX_LISTED_PATHS).map { group ->
                    group.take(MAX_PATHS_PER_GROUP).joinToString("  ⟷  ", transform = ApplyPlan::displayPath) +
                        if (group.size > MAX_PATHS_PER_GROUP) "  … and ${group.size - MAX_PATHS_PER_GROUP} more" else ""
                },
            )
            if (groups.size > ApplyPlan.MAX_LISTED_PATHS) {
                html.line("… and ${groups.size - ApplyPlan.MAX_LISTED_PATHS} more group(s)")
            }
        }
        if (plan.notSent.isNotEmpty()) {
            html.blank().header(
                "NOT sent (${plan.notSent.size}) — Core reported a file status this plugin build does not " +
                    "define, so these are not selectable and stay unapplied:",
            )
            val notSent = ApplyPlan.listNotSent(plan.notSent)
            html.entries("x", notSent.cells)
            notSent.overflow?.let(html::line)
        }
        html.blank()
        if (plan.renamedWithoutSource.isNotEmpty()) {
            html.line(
                "renamed (${plan.renamedWithoutSource.size}): Core reports only the new path; the original " +
                    "path is not part of the protocol's change set, so it is not shown here.",
            )
        }
        return html
            .line("base commit: ${reviewed.baseCommit}")
            .line("host dirty: ${reviewed.hostDirty} (checked again by Core before it touches anything)")
            .blank()
            .line("This is an explicit Git operation. If the repository moved since the review, Core aborts.")
    }
}
