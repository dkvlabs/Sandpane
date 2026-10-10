package labs.dkv.sandpane.ui

import labs.dkv.sandpane.text.DisplayCap
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import labs.dkv.sandpane.core.IssuedProjectDelete
import labs.dkv.sandpane.core.ProjectGuards
import labs.dkv.sandpane.core.ProjectUiState
import labs.dkv.sandpane.model.Project as SandpaneProject
import labs.dkv.sandpane.text.VisibleText
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.Action
import javax.swing.DefaultComboBoxModel
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTextArea
import javax.swing.JTextField

/**
 * The `project.delete` confirmation message (A3a, the A1 two-step pattern), separate from the action
 * so its exact content is unit-tested. Every Core value — name, id, expiry, impact lines — goes
 * through [DialogHtml] (revealed single-line, HTML-escaped, impact lines as table rows). The token is
 * never shown. `external` is never true for a project, so there is no external banner
 * ([labs.dkv.sandpane.core.ProjectDeleteCheck] refuses an answer that claims it).
 */
object ProjectDeleteConfirmation {

    const val MAX_IMPACT_LINES: Int = 20

    /** Constant title and labels: the platform renders the title as HTML too. */
    const val TITLE: String = "Sandpane: Delete Project"
    const val DELETE_LABEL: String = "Delete Project"
    const val CANCEL_LABEL: String = "Cancel"

    fun message(issued: IssuedProjectDelete): DialogHtml {
        val html = DialogHtml()
            .line("Delete this project from Sandpane Core? This cannot be undone in Core.")
            .fields(
                "project" to DisplayCap.cap(issued.name),
                "project id" to DisplayCap.cap(issued.projectId),
                "confirmation expires" to DisplayCap.cap(issued.expiresAt),
            )
            .blank()
        if (issued.impact.isEmpty()) {
            html.line("Core reported no impact lines for this delete.")
        } else {
            html.header("Impact, as reported by Core (${issued.impact.size} line(s)):")
            // Each line capped at DisplayCap.MAX_CODE_POINTS: Core does not bound a line's length.
            html.entries("", issued.impact.take(MAX_IMPACT_LINES).map { DisplayCap.cap(it) })
            val more = issued.impact.size - MAX_IMPACT_LINES
            if (more > 0) html.line("… and $more more impact line(s) not shown")
        }
        return html
            .blank()
            .line("The confirmation is single-use and bound to this project id; it expires as shown and is")
            .line("checked again when you click. Cancel sends nothing further.")
    }
}

/**
 * Picks the project a lifecycle action targets, from the last Core snapshot. Archived projects are
 * labeled ([ProjectUiState.label]); rows go through [PlainTextListRenderer] (revealed, never HTML).
 * Shown on the EDT; it makes no Core call.
 */
class ProjectChooserDialog(
    project: Project,
    dialogTitle: String,
    private val okLabel: String,
    projects: List<SandpaneProject>,
    private val snapshotAge: String,
    /** Why the action may not touch a project (Core's rule), or null; OK stays disabled while set. */
    private val blockedReason: (SandpaneProject) -> String? = { null },
) : DialogWrapper(project, true) {

    private val model = DefaultComboBoxModel(projects.toTypedArray())
    private val combo = JComboBox(model).apply {
        renderer = PlainTextListRenderer { value -> describe(value as? SandpaneProject) }
    }

    init {
        title = dialogTitle
        init()
        initValidation()
    }

    val selected: SandpaneProject? get() = combo.selectedItem as? SandpaneProject

    override fun doValidate(): ValidationInfo? {
        val picked = selected ?: return ValidationInfo("Pick a project.", combo)
        return blockedReason(picked)?.let { ValidationInfo("Not available for this project — ${VisibleText.reveal(it)}", combo) }
    }

    override fun createCenterPanel(): JComponent = JPanel(BorderLayout(0, 8)).apply {
        add(PlainText.label("Project (from Core's list, $snapshotAge):"), BorderLayout.NORTH)
        add(combo.apply { preferredSize = Dimension(460, preferredSize.height) }, BorderLayout.CENTER)
    }

    override fun createActions(): Array<Action> {
        okAction.putValue(Action.NAME, okLabel)
        return arrayOf(okAction, cancelAction)
    }

    override fun getPreferredFocusedComponent(): JComponent = combo

    companion object {
        fun describe(project: SandpaneProject?): Pair<String, String?> {
            if (project == null) return "no project" to null
            val repos = "${project.repositories.size} repository path(s)"
            val archived = project.archivedAt?.let { "\narchived at $it (Core)" } ?: ""
            return DisplayCap.cap("${ProjectUiState.label(project)} · $repos") to DisplayCap.cap("Core project ${project.id}$archived")
        }
    }
}

/**
 * Picks one of the paths Core lists in the project's `repositories` for Remove Repository. Only
 * Core's own values are offered, so the path sent is one Core registered.
 */
class RepositoryChooserDialog(
    project: Project,
    projectName: String,
    repositories: List<String>,
) : DialogWrapper(project, true) {

    private val shownName = VisibleText.reveal(DisplayCap.cap(projectName))
    private val combo = JComboBox(DefaultComboBoxModel(repositories.toTypedArray())).apply {
        renderer = PlainTextListRenderer { value -> describe(value as? String) }
    }

    init {
        title = "Sandpane: Remove Repository"
        init()
    }

    val selected: String? get() = combo.selectedItem as? String

    override fun createCenterPanel(): JComponent = JPanel(BorderLayout(0, 8)).apply {
        add(
            PlainText.label("Repository registered with '$shownName' (Core's list). Core only unregisters it; no file is touched:"),
            BorderLayout.NORTH,
        )
        add(combo.apply { preferredSize = Dimension(520, preferredSize.height) }, BorderLayout.CENTER)
    }

    override fun createActions(): Array<Action> {
        okAction.putValue(Action.NAME, "Remove Repository")
        return arrayOf(okAction, cancelAction)
    }

    override fun getPreferredFocusedComponent(): JComponent = combo

    companion object {
        /** One row: the registered path, capped; the full path is what is sent (Core's own value). */
        fun describe(path: String?): Pair<String, String?> =
            DisplayCap.cap(path ?: "") to "registered in Core for this project"
    }
}

/**
 * Edit Project (A3a `project.update`): name and a multi-line description. Validation mirrors Core
 * EXACTLY ([ProjectGuards]) — no trimming, empty description allowed (it clears the field) — and only
 * the fields that changed are sent ([ProjectEdits.changes]).
 */
class ProjectEditDialog(
    project: Project,
    private val original: SandpaneProject,
) : DialogWrapper(project, true) {

    private val nameField = JTextField(original.name, 40)
    private val descriptionArea = JTextArea(original.description, 8, 40).apply {
        lineWrap = true
        wrapStyleWord = true
    }

    /**
     * The fields' text right after construction — the baseline for "changed". NOT `original.name`: a
     * JTextField turns a newline into a space, so a pre-rule name holding one would otherwise look
     * edited and be renamed by a description-only edit.
     */
    private val baselineName: String = nameField.text
    private val baselineDescription: String = descriptionArea.text

    init {
        title = "Sandpane: Edit Project"
        init()
    }

    /** What to send: null = unchanged (the key stays off the wire). */
    val result: ProjectEdits.Changes
        get() = ProjectEdits.changes(baselineName, baselineDescription, nameField.text, descriptionArea.text)

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(GridBagLayout())
        val c = GridBagConstraints().apply {
            gridx = 0
            fill = GridBagConstraints.HORIZONTAL
            weightx = 1.0
            insets = Insets(2, 0, 2, 0)
        }
        fun add(component: JComponent, weightY: Double = 0.0) {
            c.gridy++
            c.weighty = weightY
            c.fill = if (weightY > 0) GridBagConstraints.BOTH else GridBagConstraints.HORIZONTAL
            panel.add(component, c)
        }
        c.gridy = -1
        // Core's current values, revealed (a pre-rule name may hold characters the field would hide).
        add(PlainText.label("Core project ${VisibleText.reveal(original.id)} — current name: ${VisibleText.reveal(original.name)}"))
        add(PlainText.label("Name (1–${ProjectGuards.MAX_NAME_CHARS} characters, one line):"))
        add(nameField)
        add(PlainText.label("Description (up to ${ProjectGuards.MAX_DESCRIPTION_CHARS} characters; empty clears it):"))
        add(JScrollPane(descriptionArea).apply { preferredSize = Dimension(480, 160) }, 1.0)
        return panel
    }

    override fun doValidate(): ValidationInfo? {
        val r = result
        r.name?.let { name -> ProjectGuards.nameProblem(name)?.let { return ValidationInfo("Core would refuse: $it", nameField) } }
        r.description?.let { d ->
            ProjectGuards.descriptionProblem(d)?.let { return ValidationInfo("Core would refuse: $it", descriptionArea) }
        }
        if (r.isEmpty) return ValidationInfo("Nothing changed.", nameField).asWarning().withOKEnabled()
        return null
    }

    override fun createActions(): Array<Action> {
        okAction.putValue(Action.NAME, "Save to Core")
        return arrayOf(okAction, cancelAction)
    }

    override fun getPreferredFocusedComponent(): JComponent = nameField
}

/** The pure part of [ProjectEditDialog], unit-tested without Swing. */
object ProjectEdits {
    data class Changes(val name: String?, val description: String?) {
        val isEmpty: Boolean get() = name == null && description == null
    }

    /**
     * Only fields whose text differs from the editor's own [baselineName] / [baselineDescription] (what
     * the fields showed when opened); values are sent exactly as typed (Core does not trim, neither do we).
     */
    fun changes(baselineName: String, baselineDescription: String, name: String, description: String): Changes =
        Changes(
            name = name.takeIf { it != baselineName },
            description = description.takeIf { it != baselineDescription },
        )
}
