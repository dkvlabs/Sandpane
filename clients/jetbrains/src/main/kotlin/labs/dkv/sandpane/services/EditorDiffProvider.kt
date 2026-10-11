package labs.dkv.sandpane.services

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.Reported
import labs.dkv.sandpane.model.WorkspaceMode
import labs.dkv.sandpane.model.describe
import labs.dkv.sandpane.text.VisibleText
import java.io.File

/**
 * Resolves and shows a Core-produced change set (docs/specs/04 §3 "Review changes").
 *
 * Division of labour is fixed by the spec: Core computes the real diff against the task's
 * recorded `base_commit`, including untracked files; this class only maps the reported paths
 * onto host files and drives navigation. It NEVER writes a host file, and it never recomputes
 * a diff locally to "help" (AGENTS.md rules 2 and 7).
 *
 * Native diff rendering is a JB3 deliverable (docs/specs/04 §4) and is deliberately NOT
 * stubbed as working here: [openNativeDiff] returns [DiffOutcome.Deferred] with the reason, so
 * the UI tells the user the truth and falls back to navigation + the file list. See
 * [DiffOutcome.Deferred] for the one API question JB0 must settle.
 */
class EditorDiffProvider(private val project: Project) {

    /** A reported path that maps onto a file this process can actually see. */
    data class Resolved(val change: FileChange, val file: VirtualFile, val absolutePath: String)

    /** Paths refused by containment validation, or simply absent on this host. */
    data class Unresolved(val change: FileChange, val reason: String)

    data class ReviewTarget(
        val changeSet: ChangeSet,
        val resolved: List<Resolved>,
        val unresolved: List<Unresolved>,
    ) {
        val nothingToShow: Boolean get() = changeSet.changes.isEmpty()
    }

    sealed class DiffOutcome {
        /** Native diff is available and was shown. */
        data object Shown : DiffOutcome()

        /** JB3: the public diff-content construction is not proven on the pinned baseline yet. */
        data class Deferred(val reason: String) : DiffOutcome()

        /** Nothing to show even by navigation (deleted file, path not visible, refused validation). */
        data class Unavailable(val reason: String) : DiffOutcome()
    }

    /**
     * Map every reported path against the task's repository root.
     *
     * Validation before use (AGENTS.md rule 2, client equivalent): the path must stay inside
     * the resolved root after canonicalization. A `../` escape or an absolute path pointing
     * elsewhere is refused and reported, not clamped silently.
     */
    fun resolve(changeSet: ChangeSet, repositoryRoot: String?): ReviewTarget {
        val base = repositoryRoot?.let { File(it) } ?: project.basePath?.let { File(it) }
        val resolved = ArrayList<Resolved>(changeSet.changes.size)
        val unresolved = ArrayList<Unresolved>()

        for (change in changeSet.changes) {
            if (base == null) {
                unresolved += Unresolved(change, "no repository root to resolve '${change.path}' against")
                continue
            }
            val contained = containWithin(base, change.path)
            if (contained == null) {
                unresolved += Unresolved(change, "path '${change.path}' escapes the repository root and was refused")
                continue
            }
            val virtual = findVisibleFile(contained)
            if (virtual == null) {
                unresolved += Unresolved(
                    change,
                    "not visible on this host (deleted, renamed away, or on another machine): ${contained.path}",
                )
                continue
            }
            resolved += Resolved(change, virtual, contained.path)
        }
        return ReviewTarget(changeSet, resolved, unresolved)
    }

    /**
     * @return the canonical file inside [root], or null when the path escapes it or is blank.
     * Deleted changes legitimately have no file on disk; callers handle that separately.
     */
    fun containWithin(root: File, relativePath: String): File? = containPath(root, relativePath)

    /** Look the file up in the VFS; a rescan is only ever attempted off the EDT. */
    fun findVisibleFile(file: File): VirtualFile? {
        val lfs = LocalFileSystem.getInstance()
        lfs.findFileByIoFile(file)?.takeIf { it.isValid }?.let { return it }
        if (!file.exists()) return null
        // A stale VFS entry needs a rescan. Synchronous refresh is acceptable only off the EDT;
        // on the EDT we report "not visible" rather than block (specs/04 §2: never block EDT).
        if (ApplicationManager.getApplication()?.isDispatchThread == true) return null
        return lfs.refreshAndFindFileByIoFile(file)
    }

    /** Open the host file at the reported path. Navigation only; no content is written. */
    fun navigate(resolved: Resolved, line: Int? = null): Boolean {
        if (!resolved.file.isValid) return false
        return try {
            ApplicationManager.getApplication().invokeLater {
                val descriptor = if (line != null && line > 0) {
                    OpenFileDescriptor(project, resolved.file, line - 1, 0)
                } else {
                    OpenFileDescriptor(project, resolved.file)
                }
                FileEditorManager.getInstance(project).openTextEditor(descriptor, true)
            }
            true
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Native diff request. Kept as an explicit deferral rather than a guess at the API:
     *
     * JB0 must confirm the supported way to build two `Content`s from in-memory text on the
     * pinned baseline (`com.intellij.diff.requests.SimpleDiffRequest` + the platform's content
     * factory) and then this becomes:
     *   DiffManager.getInstance().showDiff(project, request)
     *
     * Writing the call against an unverified factory would be exactly the "capability claimed
     * without a verified adapter path" the specs forbid (AGENTS.md rule 5), so it stays here as
     * a documented decision point returning Deferred until it is proven.
     */
    fun openNativeDiff(resolved: Resolved, workspaceMode: Reported<WorkspaceMode>?): DiffOutcome {
        // A missing mode is UNVERIFIED, which [liveWritableNotice] says out loud (S5).
        val modeWarning = liveWritableNotice(workspaceMode)
        val deferred = DiffOutcome.Deferred(
            "Native side-by-side diff is a JB3 feature (docs/specs/04 §4). Showing " +
                "'${ApplyPlan.displayPath(resolved.change.path)}' " +
                "(${resolved.change.status.describe()}) via the platform diff API is not yet proven on " +
                "this baseline. Opening the file instead." +
                (modeWarning?.let { " $it" } ?: ""),
        )
        return deferred
    }

    /**
     * Direct-mount changes are ALREADY on disk: the review UI must not imply they are safely
     * pending (docs/specs/04 §3, specs/02 §7).
     */
    fun liveWritableNotice(mode: Reported<WorkspaceMode>?): String? = modeNotice(mode)

    /** Human summary of a review, including the refusals — never only the successes. */
    fun summarize(target: ReviewTarget, mode: Reported<WorkspaceMode>?): String = summarizeTarget(target, mode)

    companion object {
        /**
         * Direct-mount changes are ALREADY on disk: the review UI must not imply they are safely
         * pending (docs/specs/04 §3, specs/02 §7). Same for `host_worktree` when the worktree is
         * the one the IDE is editing.
         */
        fun modeNotice(mode: Reported<WorkspaceMode>?): String? = when (mode) {
            null ->
                "Workspace mode is UNVERIFIED: Core has no readable sandbox_bindings row for this " +
                    "binding, and it never guesses one. Treated as live-writable until verified (specs/02 §7)."
            is Reported.Unknown ->
                "Workspace mode '${mode.wireName}' is unknown to this plugin build (a newer Core added it). " +
                    "Treated as live-writable — never as isolated — until the plugin is updated (specs/02 §7)."
            is Reported.Known -> knownModeNotice(mode.value)
        }

        private fun knownModeNotice(mode: WorkspaceMode): String = when (mode) {
            WorkspaceMode.DIRECT_MOUNT ->
                "Workspace mode direct_mount is live-writable: these edits are already applied on the host, " +
                    "and reviewing them cannot undo them."
            WorkspaceMode.HOST_WORKTREE ->
                "Workspace mode host_worktree writes to a host directory: confirm the IDE is showing that same " +
                    "worktree before treating this review as a gate."
            WorkspaceMode.SBX_CLONE ->
                "Workspace mode sbx_clone: the change set lives in the sandbox until it is applied through Core."
            WorkspaceMode.MOUNTLESS ->
                "Workspace mode mountless: no host project access is assumed."
        }

        /**
         * The canonical file inside [root] for an EXACT review path (A5: git.review paths are NUL-parsed,
         * never C-quoted), or null when it escapes [root], is empty, or holds a NUL. Never trimmed, and a
         * tab or newline is a legitimate file-name character, not a reason to refuse.
         */
        fun containPath(root: File, relativePath: String): File? {
            if (relativePath.isEmpty() || relativePath.contains(0.toChar())) return null
            return try {
                val rootCanonical = root.canonicalFile
                val asFile = File(relativePath)
                val candidate = if (asFile.isAbsolute) asFile.canonicalFile else File(rootCanonical, relativePath).canonicalFile
                if (candidate == rootCanonical || candidate.path.startsWith(rootCanonical.path + File.separator)) {
                    candidate
                } else {
                    null
                }
            } catch (e: Exception) {
                null
            }
        }

        /** A change's path, `old \u2192 new` for a rename, through the Apply dialog's [ApplyPlan.displayPath]. */
        fun changeLabel(change: FileChange): String =
            change.oldPath?.let { "${ApplyPlan.displayPath(it)} \u2192 ${ApplyPlan.displayPath(change.path)}" }
                ?: ApplyPlan.displayPath(change.path)

        /** Human summary of a review, including the refusals — never only the successes. */
        fun summarizeTarget(target: ReviewTarget, mode: Reported<WorkspaceMode>?): String = buildString {
            val cs = target.changeSet
            // Every Core/agent-supplied value is revealed single-line (paths through the same
            // [ApplyPlan.displayPath] as the Apply dialog), so none can fake a line of the summary.
            appendLine(
                "Task ${VisibleText.reveal(cs.taskId.take(8))} · base ${VisibleText.reveal(cs.baseCommit.take(10))} · " +
                    "${cs.changes.size} change(s)",
            )
            // A5: the host repository root Core reviewed against, revealed and capped.
            cs.repoPath?.let { appendLine("repository: ${VisibleText.reveal(labs.dkv.sandpane.text.DisplayCap.cap(it))}") }
            // A5: never claim a list is complete when Core says it could not inspect some paths.
            cs.uninspected?.takeIf { it.isNotEmpty() }?.let {
                appendLine("${it.size} paths were not inspected by Core \u2014 this change list is NOT complete.")
            }
            if (cs.hostDirty) {
                appendLine("Host working tree is DIRTY: apply in Core will refuse to overwrite uncommitted work.")
            }
            modeNotice(mode)?.let { appendLine(it) }
            target.resolved.forEach { appendLine("  ${it.change.status.describe()}  ${changeLabel(it.change)}") }
            target.unresolved.forEach {
                appendLine(
                    "  unresolved (${it.change.status.describe()})  ${changeLabel(it.change)} — " +
                        VisibleText.reveal(it.reason),
                )
            }
        }.trimEnd()

        fun instance(project: Project): EditorDiffProvider =
            project.getService(EditorDiffProvider::class.java)
    }
}
