package labs.dkv.sandpane.ui

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.HTMLEditorKitBuilder
import labs.dkv.sandpane.core.GitDiffs
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.GitDiffResult
import labs.dkv.sandpane.services.ApplyPlan
import labs.dkv.sandpane.services.ReviewSession
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.util.concurrent.CompletableFuture
import javax.swing.Action
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JEditorPane
import javax.swing.JPanel

/**
 * A6 step 1 (design 2026-10-09 §3.6): per-file checkboxes over the entries of ONE `git.review`
 * answer ([session]), plus "Select all". A row that cannot be applied is shown disabled with the
 * reason ([ApplyPlan.selectability]). Nothing is ticked initially: the selection is the user's,
 * made fresh for every review. Each selectable row has a "Diff…" button (when [openDiff] is not
 * null, i.e. Core advertises `git.diff`) whose answer is recorded in the session, so the
 * confirmation can say which content was fully shown and the mismatch rule can see it.
 *
 * Row text is plain (HTML disabled, hidden characters revealed); a row is never parsed back — the
 * selection is the row INDEX into the review. Constructed only from ApplyTaskAction.actionPerformed.
 */
class ApplySelectionDialog(
    project: Project,
    private val session: ReviewSession,
    private val openDiff: ((FileChange) -> CompletableFuture<GitDiffResult>)?,
) : DialogWrapper(project, true) {

    private val changes = session.changeSet.changes
    private val boxes: List<JCheckBox> = changes.map { change ->
        PlainText.disableHtml(JCheckBox()).apply {
            text = ApplyPlan.rowLabel(session, change)
            isEnabled = ApplyPlan.selectability(session.changeSet, change) == null
            addActionListener { onSelectionChanged() }
        }
    }
    private val selectAll = PlainText.disableHtml(JCheckBox("Select all")).apply {
        isEnabled = boxes.any { it.isEnabled }
        addActionListener {
            boxes.filter { it.isEnabled }.forEach { box -> box.isSelected = isSelected }
            onSelectionChanged()
        }
    }
    private val status = PlainText.label(" ")

    init {
        title = "Sandpane: Choose Files to Apply"
        init()
        onSelectionChanged()
    }

    /** Indices into the review's change list, in review order. */
    val selectedIndices: List<Int> get() = boxes.indices.filter { boxes[it].isEnabled && boxes[it].isSelected }

    private fun onSelectionChanged() {
        val n = selectedIndices.size
        okAction.putValue(Action.NAME, "Continue with ${if (n == 1) "1 file" else "$n files"}…")
        isOKActionEnabled = n > 0
        val enabled = boxes.filter { it.isEnabled }
        selectAll.isSelected = enabled.isNotEmpty() && enabled.all { it.isSelected }
    }

    override fun createCenterPanel(): JComponent {
        val review = session.changeSet
        val header = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(PlainText.label("Repository: " + (review.repoPath?.let { VisibleText.reveal(DisplayCap.cap(it)) } ?: "not reported by Core")))
            add(PlainText.label("Task ${VisibleText.reveal(review.taskId.take(8))} · review ${VisibleText.reveal(DisplayCap.cap(review.reviewId ?: "none", 40))}"))
            add(PlainText.label("Only files Core bound to the content it hashed at review can be applied. You confirm in the next step."))
            if (openDiff == null) add(PlainText.label(GitDiffText.UNSUPPORTED))
            add(selectAll)
        }
        val rows = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            changes.forEachIndexed { i, change ->
                add(JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
                    add(boxes[i])
                    val diff = openDiff
                    if (diff != null && boxes[i].isEnabled) {
                        add(JButton("Diff…").apply { addActionListener { showDiff(i, change, diff) } })
                    }
                    alignmentX = 0f
                })
            }
        }
        return JPanel(BorderLayout(0, 6)).apply {
            add(header, BorderLayout.NORTH)
            add(JBScrollPane(rows).apply { preferredSize = Dimension(760, 360) }, BorderLayout.CENTER)
            add(status, BorderLayout.SOUTH)
        }
    }

    /** The click handler runs on the EDT; `git.diff` runs on the io pool; the viewer opens back on the EDT. */
    private fun showDiff(index: Int, change: FileChange, diff: (FileChange) -> CompletableFuture<GitDiffResult>) {
        status.text = "Asking Core for the diff of " + GitDiffText.pathLabel(change.path, change.oldPath) + "…"
        val modality = ModalityState.stateForComponent(contentPanel)
        diff(change).whenComplete { result, error ->
            ApplicationManager.getApplication().invokeLater({
                if (isDisposed) return@invokeLater
                if (result == null) {
                    status.text = GitDiffs.describeFailure(error)
                    return@invokeLater
                }
                session.recordDiff(result)
                boxes[index].text = ApplyPlan.rowLabel(session, change)
                status.text = " "
                GitDiffViewerDialog(contentPanel, result, null).show()
            }, modality)
        }
    }

    override fun getPreferredFocusedComponent(): JComponent = selectAll
}

/**
 * A6 step 2: the MANDATORY confirmation (§3.6 item 9). Modal, on the EDT, constructed only from
 * ApplyTaskAction.actionPerformed. [html] is [ApplyConfirmation.message], laid out by the platform's
 * word-wrapping HTML kit (the layout DialogLayoutTest checks) in a scroll pane, so every file is
 * listed. The explicit OK button reads "Apply N files"; Cancel is the DEFAULT button and has the
 * initial focus, so Enter or Escape on open cancels.
 */
class ApplyConfirmationDialog(
    project: Project,
    private val html: String,
    count: Int,
) : DialogWrapper(project, true) {

    init {
        title = ApplyConfirmation.TITLE
        okAction.putValue(Action.NAME, ApplyConfirmation.okLabel(count))
        okAction.putValue(DEFAULT_ACTION, null)
        cancelAction.putValue(Action.NAME, ApplyConfirmation.CANCEL_LABEL)
        cancelAction.putValue(DEFAULT_ACTION, true)
        init()
    }

    override fun createCenterPanel(): JComponent {
        val pane = JEditorPane().apply {
            contentType = "text/html"
            editorKit = HTMLEditorKitBuilder().withWordWrapViewFactory().build()
            isEditable = false
            text = html
            caretPosition = 0
        }
        return JBScrollPane(pane).apply { preferredSize = Dimension(720, 460) }
    }

    override fun createActions(): Array<Action> = arrayOf(okAction, cancelAction)

    override fun getPreferredFocusedComponent(): JComponent? = getButton(cancelAction)
}
