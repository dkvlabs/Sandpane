package labs.dkv.sandpane.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.GitDiffResult
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Font
import javax.swing.Action
import javax.swing.BoxLayout
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTextArea
import javax.swing.ListSelectionModel

/**
 * A5: pick one entry of Core's `git.review` change set to diff. The selection IS the [FileChange]
 * Core returned (its exact `path` and `status` are what `git.diff` sends); the row text is only a
 * revealed label, never parsed back. Rows are plain text ([PlainTextListRenderer], HTML disabled).
 */
class FileDiffChooserDialog(
    project: Project,
    changes: List<FileChange>,
) : DialogWrapper(project, true) {

    private val list = JBList(changes).apply {
        selectionMode = ListSelectionModel.SINGLE_SELECTION
        cellRenderer = PlainTextListRenderer { value ->
            val change = value as? FileChange
            (change?.let { GitDiffText.entryLabel(it) } ?: "") to null
        }
        if (changes.isNotEmpty()) selectedIndex = 0
    }

    init {
        title = "Sandpane: Show File Diff"
        init()
    }

    /** The entry exactly as Core listed it, or null when nothing is selected. */
    val selected: FileChange? get() = list.selectedValue

    override fun createCenterPanel(): JComponent = JPanel(BorderLayout()).apply {
        add(PlainText.label("Diff one file from Core's change set (read-only; nothing is applied or written):"), BorderLayout.NORTH)
        add(JBScrollPane(list).apply { preferredSize = Dimension(560, 260) }, BorderLayout.CENTER)
    }

    override fun createActions(): Array<Action> {
        okAction.putValue(Action.NAME, "Show Diff")
        return arrayOf(okAction, cancelAction)
    }

    override fun getPreferredFocusedComponent(): JComponent = list
}

/**
 * A5: the read-only viewer for one `git.diff` answer. The patch is UNTRUSTED: shown revealed in a
 * non-editable [JTextArea] (which never interprets markup), with Core's flags disclosed above it. There
 * is no apply, copy-to-project or run action, and nothing is written anywhere (no temp file either).
 */
class GitDiffViewerDialog(
    project: Project,
    private val result: GitDiffResult,
    private val requestedMaxBytes: Int?,
) : DialogWrapper(project, false) {

    init {
        title = GitDiffText.title(result)
        isModal = false
        init()
    }

    override fun createCenterPanel(): JComponent {
        val header = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(PlainText.label(GitDiffText.READ_ONLY_NOTE))
            GitDiffText.disclosures(result, requestedMaxBytes).forEach { add(PlainText.label(it)) }
        }
        val body = JTextArea(GitDiffText.body(result)).apply {
            isEditable = false
            lineWrap = false
            font = Font(Font.MONOSPACED, Font.PLAIN, font.size)
            caretPosition = 0
        }
        return JPanel(BorderLayout(0, 6)).apply {
            add(header, BorderLayout.NORTH)
            add(JBScrollPane(body).apply { preferredSize = Dimension(820, 520) }, BorderLayout.CENTER)
        }
    }

    override fun createActions(): Array<Action> {
        okAction.putValue(Action.NAME, "Close")
        return arrayOf(okAction)
    }
}
