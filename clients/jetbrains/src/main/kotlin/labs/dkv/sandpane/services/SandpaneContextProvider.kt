package labs.dkv.sandpane.services

import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.ProjectLevelVcsManager
import com.intellij.openapi.vfs.VirtualFile
import labs.dkv.sandpane.model.ContextRef
import labs.dkv.sandpane.model.ContextRefKind
import labs.dkv.sandpane.settings.SandpaneSettings
import java.io.File

/**
 * Bounded, read-only editor context for Core requests (docs/specs/04 §3).
 *
 * What is collected: the active file path, the selected text (size-capped), the selection
 * range, and the VCS root Core needs to resolve the repository. What is NEVER collected:
 * credentials, environment dumps, the whole tree, or blanket file contents (docs/specs/02 §8,
 * AGENTS.md rules 7 and 8 of the security spec).
 *
 * Threading: [collect] takes a short read action and is meant to be called ON the EDT from an
 * action's `actionPerformed` — that snapshot is cheap and bounded, and it is what makes the
 * capture race-free against the user's next keystroke. The RPC that follows must be dispatched
 * on a background thread (ConnectionManager.background / call). Nothing in this class does I/O.
 */
class SandpaneContextProvider(private val project: Project) {

    /** One capture of what the user is looking at. */
    data class Snapshot(
        val activeFile: String?,
        val selectionText: String?,
        val selectionStartLine: Int?,
        val selectionEndLine: Int?,
        val vcsRoot: String?,
        val truncated: Boolean,
    ) {
        val hasSelection: Boolean get() = !selectionText.isNullOrEmpty()

        /** Only a clean absolute path becomes a ContextRef; see [attachments]. */
        val attachments: List<ContextRef>
            get() = activeFile?.let { listOf(ContextRef(kind = ContextRefKind.FILE, target = it)) }
                ?: emptyList()

        fun describeForStatusBar(): String {
            val parts = listOfNotNull(
                activeFile?.substringAfterLast(File.separatorChar)?.let { it },
                if (hasSelection) "selection ${selectionStartLine ?: 0}–${selectionEndLine ?: 0}" else null,
                vcsRoot?.let { "root ${it.substringAfterLast(File.separatorChar)}" },
            )
            return if (parts.isEmpty()) "no editor context" else parts.joinToString(" · ")
        }
    }

    /**
     * Host/path viability, resolved BEFORE any task is created.
     *
     * specs/04 §2 step 6 and §5 risk 1: in remote-development setups the process running this
     * plugin may not see the folder shown in the UI. A path the plugin cannot stat is reported
     * as unsupported and the task actions stay disabled — cross-host mapping is never guessed,
     * and there is no fallback to a path Core would interpret differently.
     *
     * JB4 open item: JetBrains Remote Dev exposes backend-host information through product
     * internals that are outside the public SDK this plugin may use. Until a supported API is
     * confirmed, detection is "can this process see the folder", which is conservative: a
     * visible-but-redirected path could still be accepted. That limitation is stated in the
     * README rather than papered over.
     */
    sealed class HostMapping {
        data class Supported(val projectRoot: String, val vcsRoots: List<String>) : HostMapping()
        data class Unsupported(val reason: String) : HostMapping()
    }

    fun hostMapping(): HostMapping {
        val root = project.basePath
            ?: return HostMapping.Unsupported(
                "this IDE window has no project base directory, so there is no folder to bind a sandbox to",
            )
        if (!File(root).isDirectory) {
            return HostMapping.Unsupported(
                "the project folder '$root' is not visible to the process running Sandpane. With a remote " +
                    "backend or WSL layout the plugin may run on a different host than the files: cross-host " +
                    "path mapping is unsupported, and no task will be created.",
            )
        }
        return HostMapping.Supported(root, vcsRootPaths())
    }

    /** Public VCS API only; returns empty when no VCS is mapped, never a guessed `.git` walk. */
    fun vcsRootPaths(): List<String> = try {
        ProjectLevelVcsManager.getInstance(project).allVcsRoots.mapNotNull { it.path?.path?.takeIf { p -> p.isNotBlank() } }
    } catch (e: Exception) {
        // VCS not initialized yet (e.g. very early startup): report none rather than guess.
        emptyList()
    }

    fun currentFile(): VirtualFile? = try {
        FileEditorManager.getInstance(project).selectedFiles.firstOrNull()
    } catch (e: Exception) {
        null
    }

    /**
     * Capture the editor snapshot. Runs the read lock inline; must be called on the EDT (or
     * from any thread that may legitimately take a read action) and stays bounded by
     * [maxSelectionChars]. With `editor = null` the active text editor is used.
     */
    fun collect(editor: Editor? = null): Snapshot {
        val limit = maxSelectionChars()
        return ReadAction.compute<Snapshot, RuntimeException> {
            val target = editor ?: FileEditorManager.getInstance(project).selectedTextEditor
            val file = target?.let { currentFileFor(it.document) } ?: currentFile()
            val selection = target?.selectionModel?.selectedText
            val caretModel = target?.caretModel
            val startLine = if (selection.isNullOrEmpty()) null else target?.let { t ->
                t.offsetToLogicalPosition(t.selectionModel.selectionStart).line.plus(1)
            }
            val endLine = if (selection.isNullOrEmpty()) null else target?.let { t ->
                t.offsetToLogicalPosition(t.selectionModel.selectionEnd).line.plus(1)
            }

            val raw = selection.orEmpty()
            val clamped = if (raw.length > limit) raw.substring(0, limit) else raw
            Snapshot(
                activeFile = file?.path,
                selectionText = clamped.takeIf { it.isNotEmpty() },
                selectionStartLine = startLine,
                selectionEndLine = endLine,
                vcsRoot = file?.let { ProjectLevelVcsManager.getInstance(project).getVcsRootFor(it)?.path },
                truncated = raw.length > limit,
            )
        }
    }

    /**
     * The prompt body. A selection is quoted as DATA inside the content — Core treats prompts
     * as inert text, never as a command (docs/specs/02 §2).
     *
     * Protocol open item: `ContextRef(kind: selection)` needs an identifier contract that
     * `sandpane_core::validation` accepts. Rather than invent one client-side, the selection is
     * quoted into `content` here and only the FILE path is attached. Resolve it in the protocol
     * (schemas + Rust + all clients together, AGENTS.md rule 8).
     */
    fun buildContent(instruction: String, snapshot: Snapshot): String {
        val header = buildString {
            snapshot.activeFile?.let { appendLine("Active file: $it") }
            if (snapshot.hasSelection) {
                appendLine("Selection: lines ${snapshot.selectionStartLine}–${snapshot.selectionEndLine}")
            }
            snapshot.vcsRoot?.let { appendLine("VCS root: $it") }
            if (snapshot.truncated) appendLine("(selection truncated to fit the context budget)")
        }.trim()

        val body = buildString {
            if (header.isNotEmpty()) {
                append(header)
                appendLine()
                appendLine()
            }
            appendLine(instruction)
            if (snapshot.hasSelection) {
                appendLine()
                appendLine("Selected code:")
                appendLine("```")
                append(snapshot.selectionText)
                appendLine()
                append("```")
            }
        }
        return clampToContentBudget(body)
    }

    /** Never exceed Core's own `display_text` bound; truncation is visible, not silent. */
    private fun clampToContentBudget(body: String): String {
        val budget = SandpaneSettings.instance().maxContentBytes
        if (body.length <= budget) return body
        return body.take(budget - MARKER.length) + MARKER
    }

    /** Bound the quoted selection so one action cannot upload a whole file on purpose or by accident. */
    private fun maxSelectionChars(): Int {
        val budget = SandpaneSettings.instance().maxContentBytes
        return minOf(SELECTION_CAP_CHARS, maxOf(budget / 2, MIN_SELECTION_CHARS))
    }

    private fun currentFileFor(document: com.intellij.openapi.editor.Document): VirtualFile? =
        com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getFile(document)

    companion object {
        private const val SELECTION_CAP_CHARS = 8_000
        private const val MIN_SELECTION_CHARS = 512
        private const val MARKER = "…[truncated]"

        fun instance(project: Project): SandpaneContextProvider =
            project.getService(SandpaneContextProvider::class.java)
    }
}
