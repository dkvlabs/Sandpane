package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText
import java.util.concurrent.TimeoutException

/**
 * A5 `git.diff` (design 2026-10-09 \u00A73.5): bounds and honest copy for Core's answers. `git.diff` is
 * read-only and display-only \u2014 every failure says nothing was read or changed, never "unknown".
 * Messages are Core's exact constants, drift-checked by ProtocolDriftGuardTest.
 */
object GitDiffs {
    /** Core's `MAX_DIFF_BYTES` / `DEFAULT_DIFF_BYTES` (diff.rs). */
    const val MAX_BYTES: Int = 524_288
    const val DEFAULT_BYTES: Int = 262_144

    const val MSG_TASK_NOT_FOUND: String = "task not found"
    const val MSG_NO_GIT_CONTEXT: String = "task has no Git context (repo binding + base_commit)"
    const val MSG_WORKTREE_REMOVED: String = "the task's worktree was removed (discarded); there is nothing left to review"
    const val MSG_WORK_TREE_REDIRECTED: String =
        "git does not place this task's work tree at its recorded directory (is a repository-local " +
            "core.worktree set?); nothing was read"
    const val MSG_PATH_NOT_IN_LIST: String = "path is not in this task's change list; nothing was read"
    const val MSG_PATH_LISTED_TWICE: String =
        "path is listed more than once in this task's change list; pass its status; nothing was read"
    const val MSG_PATH_NOT_EXACT: String =
        "this path is not valid UTF-8, so Core cannot name the file exactly; nothing was read"
    const val SUBMODULE_PREFIX: String = "repository contains submodule(s) "

    /** Core's suffix on the untracked-read refusals (`format!("{m}; nothing was read")`). */
    const val NOTHING_READ_SUFFIX: String = "; nothing was read"

    const val TIMEOUT_COPY: String = "Core did not answer in time \u2014 no file was changed (git.diff is read-only)"

    /** Omitted stays omitted (Core's default applies); otherwise 1..[MAX_BYTES], never more. */
    fun clampMaxBytes(requested: Int?): Int? = requested?.coerceIn(1, MAX_BYTES)

    /** One honest sentence for a failed `git.diff`. Core's text is revealed and capped. */
    fun describeFailure(error: Throwable?): String {
        val t = ErrorAttribution.unwrap(error)
        if (t is TimeoutException) return TIMEOUT_COPY
        if (t !is CoreRpcException || !t.raisedByCore) return ErrorAttribution.describe(CoreMethods.GIT_DIFF, error)
        val core = VisibleText.reveal(DisplayCap.cap(t.message))
        val read = "Nothing was read; git.diff never changes a file."
        return when {
            t.code == CoreErrorCodes.NOT_FOUND && t.message == MSG_TASK_NOT_FOUND ->
                "Core has no task with this id. $read"
            t.code != CoreErrorCodes.VALIDATION_FAILED && t.code != CoreErrorCodes.INTERNAL ->
                ErrorAttribution.describe(CoreMethods.GIT_DIFF, error)
            t.code == CoreErrorCodes.INTERNAL ->
                "git failed in Core (INTERNAL: $core). git.diff is read-only, so nothing was changed."
            t.message == MSG_NO_GIT_CONTEXT ->
                "This task has no Git context in Core (no repository binding and base commit), so there is no diff. $read"
            t.message == MSG_WORKTREE_REMOVED ->
                "This task's worktree was removed (discarded); there is nothing left to diff. $read"
            t.message == MSG_WORK_TREE_REDIRECTED ->
                "Core refused: git places this task's work tree somewhere other than its recorded directory " +
                    "(a repository-local core.worktree?). $read"
            t.message == MSG_PATH_NOT_IN_LIST ->
                "This file is no longer in the task's change list (Core recomputes it for every diff); review " +
                    "the task again. $read"
            t.message == MSG_PATH_LISTED_TWICE ->
                "Core lists this path more than once and could not tell which entry was meant. $read"
            t.message == MSG_PATH_NOT_EXACT ->
                "Git reports this file name as bytes that are not valid UTF-8, so Core cannot name it exactly. $read"
            t.message.startsWith(SUBMODULE_PREFIX) ->
                "Core refuses repositories with submodules (Core: $core). $read"
            t.message.endsWith(NOTHING_READ_SUFFIX) ->
                "Core refused to read this file (Core: $core). $read"
            else -> ErrorAttribution.describe(CoreMethods.GIT_DIFF, error)
        }
    }
}
