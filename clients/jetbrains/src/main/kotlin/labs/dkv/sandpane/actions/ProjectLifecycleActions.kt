package labs.dkv.sandpane.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.core.IssuedProjectDelete
import labs.dkv.sandpane.core.ProjectDeleteFlow
import labs.dkv.sandpane.core.ProjectDeleteFollowUp
import labs.dkv.sandpane.core.ProjectOutcomes
import labs.dkv.sandpane.core.ProjectUiState
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.Project as SandpaneProject
import labs.dkv.sandpane.services.SandpaneContextProvider
import labs.dkv.sandpane.services.SbxService
import labs.dkv.sandpane.settings.SandpaneSettings
import labs.dkv.sandpane.text.VisibleText
import labs.dkv.sandpane.ui.PlainText
import labs.dkv.sandpane.ui.ProjectChooserDialog
import labs.dkv.sandpane.ui.ProjectDeleteConfirmation
import labs.dkv.sandpane.ui.ProjectEditDialog
import labs.dkv.sandpane.ui.RepositoryChooserDialog
import java.io.File
import java.util.concurrent.CompletableFuture

/**
 * Shared gate for the A3a project-lifecycle actions (design 2026-10-09 §3.2).
 *
 * `update()` runs on a background thread ([ActionUpdateThread.BGT]) and reads only the live connection
 * state and `system.probe`'s advertised methods — no IPC. An unadvertised method leaves the action
 * VISIBLE but disabled with a description saying so; it is never hidden and never sent.
 *
 * Every Core call is issued through [SbxService] / [labs.dkv.sandpane.core.CoreCommands], which run on
 * ConnectionManager's io pool: nothing here blocks the EDT. Every mutation re-reads `project.list`.
 */
abstract class ProjectLifecycleAction(
    protected val method: String,
    private val readyText: String,
    private val readyDescription: String,
    /** The archived-state rule this action obeys in the chooser ([ProjectUiState.blockedReason]). */
    protected val uiAction: ProjectUiState.Action,
) : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        val presentation = event.presentation
        if (event.project == null) {
            presentation.isEnabledAndVisible = false
            return
        }
        presentation.isVisible = true
        val connection = ConnectionManager.instance()
        val problem = connection.connectionProblem()
        val gap = if (problem == null) connection.commands.advertisementGap(method) else null
        when {
            problem != null -> {
                presentation.isEnabled = false
                presentation.text = readyText
                presentation.description = PlainText.inert(problem)
            }

            gap != null -> {
                presentation.isEnabled = false
                presentation.text = "$readyText (not supported by this Core)"
                presentation.description = PlainText.inert(
                    "$method is not supported by this Core: its system.probe does not advertise it. Nothing is sent.",
                )
            }

            else -> {
                presentation.isEnabled = true
                presentation.text = readyText
                presentation.description = readyDescription
            }
        }
    }

    /** Connection + advertisement preconditions on the EDT; false after telling the user why. */
    protected fun ready(project: Project): Boolean {
        val connection = ConnectionManager.instance()
        connection.connectionProblem()?.let {
            notify(project, "Sandpane: Core not ready", it, NotificationType.WARNING)
            return false
        }
        connection.commands.advertisementGap(method)?.let {
            notify(project, "Sandpane: $method not supported by this Core", it.message ?: method, NotificationType.WARNING)
            return false
        }
        return true
    }

    /**
     * The project to act on, picked from [projects] (default: the last Core snapshot). A project the
     * action may not touch — e.g. an ARCHIVED one for an edit — is listed but OK stays disabled with
     * Core's reason. Makes no Core call itself.
     */
    protected fun pickProject(
        project: Project,
        dialogTitle: String,
        okLabel: String,
        projects: List<SandpaneProject>? = null,
        age: String? = null,
    ): SandpaneProject? {
        val sbx = SbxService.instance(project)
        val snapshot = sbx.currentSnapshot()
        val listed = projects ?: snapshot.projects
        if (listed == null) {
            val why = snapshot.failure?.let { "the last refresh failed: ${VisibleText.reveal(it)}" }
                ?: "Core's project list has not been read in this window yet"
            sbx.refresh()
            notify(
                project,
                "Sandpane: no project list",
                "$why. It is being refreshed now; run the action again once it arrives — nothing was sent.",
                if (snapshot.failure != null) NotificationType.WARNING else NotificationType.INFORMATION,
            )
            return null
        }
        if (listed.isEmpty()) {
            notify(project, "Sandpane: no projects", "Core's list has no projects for this action. Nothing was sent.", NotificationType.INFORMATION)
            return null
        }
        val dialog = ProjectChooserDialog(
            project,
            dialogTitle,
            okLabel,
            listed,
            age ?: snapshot.describeAge(),
            blockedReason = { ProjectUiState.blockedReason(it, uiAction) },
        )
        return if (dialog.showAndGet()) dialog.selected else null
    }

    /** Report one project mutation (success copy names Core's answer; failure copy is honest). */
    protected fun report(project: Project, future: CompletableFuture<SandpaneProject>) {
        val sbx = SbxService.instance(project)
        future.whenComplete { result, error ->
            notifyOutcome(
                project,
                if (error != null) {
                    ProjectOutcomes.describeFailure(method, error, rereadIncludesArchived = sbx.canListArchived())
                } else {
                    ProjectOutcomes.describeSuccess(method, result)
                },
            )
        }
    }
}

/** Rename / edit description (`project.update`): only changed fields are sent; validation mirrors Core. */
class EditProjectAction : ProjectLifecycleAction(
    CoreMethods.PROJECT_UPDATE,
    "Sandpane: Edit Project…",
    "Rename a Core project or edit its description",
    ProjectUiState.Action.EDIT,
) {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        if (!ready(project)) return
        val target = pickProject(project, "Sandpane: Edit Project", "Edit…") ?: return
        val dialog = ProjectEditDialog(project, target)
        if (!dialog.showAndGet()) return
        val changes = dialog.result
        if (changes.isEmpty) {
            notify(project, "Sandpane: project not changed", "Nothing was changed, so nothing was sent.", NotificationType.INFORMATION)
            return
        }
        report(project, SbxService.instance(project).updateProject(target.id, changes.name, changes.description))
    }
}

/** `project.archive`: reversible, changes nothing outside Core — the explicit pick is the confirmation. */
class ArchiveProjectAction : ProjectLifecycleAction(
    CoreMethods.PROJECT_ARCHIVE,
    "Sandpane: Archive Project…",
    "Archive a Core project (reversible; Core then refuses new work on it)",
    ProjectUiState.Action.ARCHIVE,
) {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        if (!ready(project)) return
        val target = pickProject(project, "Sandpane: Archive Project", "Archive Project") ?: return
        report(project, SbxService.instance(project).archiveProject(target.id))
    }
}

/**
 * `project.unarchive`: lists ARCHIVED projects straight from Core (`includeArchived: true`, off the
 * EDT) whatever the "show archived" toggle says, then lets the user pick one.
 */
class UnarchiveProjectAction : ProjectLifecycleAction(
    CoreMethods.PROJECT_UNARCHIVE,
    "Sandpane: Unarchive Project…",
    "Return an archived Core project to the live list",
    ProjectUiState.Action.UNARCHIVE,
) {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        if (!ready(project)) return
        val sbx = SbxService.instance(project)
        sbx.listProjects(includeArchived = true).whenComplete { listed, error ->
            ApplicationManager.getApplication().invokeLater({
                if (project.isDisposed) return@invokeLater
                if (error != null) {
                    notifyOutcome(project, ProjectOutcomes.describeFailure(CoreMethods.PROJECT_LIST, error, rereadIncludesArchived = false))
                    return@invokeLater
                }
                val archived = listed.orEmpty().filter { it.isArchived }
                if (archived.isEmpty()) {
                    notify(project, "Sandpane: no archived projects", "Core lists no archived project. Nothing was sent.", NotificationType.INFORMATION)
                    return@invokeLater
                }
                val target = pickProject(project, "Sandpane: Unarchive Project", "Unarchive Project", archived, "read from Core just now")
                    ?: return@invokeLater
                report(project, sbx.unarchiveProject(target.id))
            }, ModalityState.nonModal())
        }
    }
}

/**
 * `project.add_repository` via the native folder chooser. Core resolves and validates the folder (Git
 * top level, registrable location); this plugin only refuses a folder its own process cannot see —
 * with a remote backend the IDE's files and Core may be on different hosts, and cross-host path
 * mapping is unsupported (stated, not guessed).
 */
class AddRepositoryAction : ProjectLifecycleAction(
    CoreMethods.PROJECT_ADD_REPOSITORY,
    "Sandpane: Add Repository…",
    "Register a Git folder with a Core project",
    ProjectUiState.Action.ADD_REPOSITORY,
) {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        if (!ready(project)) return
        val mapping = SandpaneContextProvider.instance(project).hostMapping()
        if (mapping is SandpaneContextProvider.HostMapping.Unsupported) {
            notify(project, "Sandpane: path mapping unsupported", VisibleText.reveal(mapping.reason), NotificationType.ERROR)
            return
        }
        val target = pickProject(project, "Sandpane: Add Repository", "Choose Folder…") ?: return
        val descriptor = FileChooserDescriptorFactory.createSingleFolderDescriptor()
            .withTitle("Sandpane: Repository Folder")
            .withDescription("Core registers the folder's Git top level with the project; no file is changed.")
        val chosen = FileChooser.chooseFile(descriptor, project, null) ?: return
        val path = if (chosen.fileSystem is LocalFileSystem) chosen.path else null
        if (path == null || !File(path).isDirectory) {
            notify(
                project,
                "Sandpane: folder not visible to Sandpane",
                "The chosen folder is not on a file system this process can see, so Core (on this host) could " +
                    "not resolve it. Cross-host path mapping is unsupported; nothing was sent.",
                NotificationType.ERROR,
            )
            return
        }
        report(project, SbxService.instance(project).addRepository(target.id, path))
    }
}

/** `project.remove_repository`: the path is picked from the project's own `repositories` (Core's list). */
class RemoveRepositoryAction : ProjectLifecycleAction(
    CoreMethods.PROJECT_REMOVE_REPOSITORY,
    "Sandpane: Remove Repository…",
    "Unregister a folder from a Core project (no file is touched)",
    ProjectUiState.Action.REMOVE_REPOSITORY,
) {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        if (!ready(project)) return
        val target = pickProject(project, "Sandpane: Remove Repository", "Choose Repository…") ?: return
        val dialog = RepositoryChooserDialog(project, target.name, target.repositories)
        if (!dialog.showAndGet()) return
        val path = dialog.selected ?: return
        report(project, SbxService.instance(project).removeRepository(target.id, path))
    }
}

/**
 * Delete Project (A3a): the A1 two-step server-side confirmation.
 *
 *  1. step 1 (`{projectId}`, no token) off the EDT — Core changes nothing and issues a confirmation;
 *  2. it is checked ([labs.dkv.sandpane.core.ProjectDeleteCheck]) and shown natively from
 *     [ProjectDeleteConfirmation] (name + id + expiry + up to 20 revealed impact lines), with the
 *     explicit "Delete Project" button and Cancel as both the default and the focused option;
 *  3. only on "Delete Project", and only if the expiry has not passed at click time, step 2 is sent
 *     off the EDT. Cancel sends nothing; neither step is retried.
 *
 * Allowed for archived projects too (Core's rule). Only `deleted: true` clears this window's state.
 */
class DeleteProjectAction : ProjectLifecycleAction(
    CoreMethods.PROJECT_DELETE,
    "Sandpane: Delete Project…",
    "Delete a Core project after Core's own confirmation (host files, branches and sandboxes are not touched)",
    ProjectUiState.Action.DELETE,
) {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        if (!ready(project)) return
        val target = pickProject(project, "Sandpane: Delete Project", "Continue…") ?: return
        val sbx = SbxService.instance(project)
        val connection = ConnectionManager.instance()
        val projectId = target.id
        ProjectDeleteFlow(
            connection.commands,
            DialogUi(project),
            // Step 2 is built and sent on the io pool, never on the EDT the dialog returned on.
            background = { task -> connection.background("project.delete step 2") { task() } },
        ).run(projectId)
            .whenComplete { outcome, error ->
                if (outcome == null) {
                    notify(
                        project,
                        "Sandpane: delete outcome unknown",
                        "The delete flow ended without an outcome (${error?.javaClass?.simpleName ?: "no detail"}). Nothing " +
                            "is retried; ${ProjectOutcomes.rereadSentence(sbx.canListArchived())}.",
                        NotificationType.ERROR,
                    )
                } else {
                    notifyOutcome(project, outcome.describe(rereadIncludesArchived = sbx.canListArchived()))
                }
                when (ProjectDeleteFollowUp.next(outcome)) {
                    ProjectDeleteFollowUp.Next.FORGET_AND_REREAD -> sbx.projectDeleted(projectId)
                    ProjectDeleteFollowUp.Next.REREAD -> sbx.refresh()
                    ProjectDeleteFollowUp.Next.REREAD_ALL_THEN_FORGET_IF_GONE ->
                        sbx.refresh(includeArchivedOverride = true).thenAccept { snapshot ->
                            if (ProjectDeleteFollowUp.goneAfterReread(projectId, snapshot.projects, snapshot.archivedIncluded)) {
                                sbx.forgetProject(projectId)
                                notify(
                                    project,
                                    "Sandpane: project no longer listed by Core",
                                    "Core's re-read list (archived projects included) no longer has this project, so this " +
                                        "window dropped its state for it. The delete's own outcome was not confirmed.",
                                    NotificationType.INFORMATION,
                                )
                            }
                        }
                }
            }
    }

    /** The IDE side of [ProjectDeleteFlow.Ui]: the EDT hop and the native modal dialog. */
    private class DialogUi(private val project: Project) : ProjectDeleteFlow.Ui {
        override fun onUiThread(block: () -> Unit) {
            ApplicationManager.getApplication().invokeLater(block, ModalityState.defaultModalityState())
        }

        override fun confirm(issued: IssuedProjectDelete): Boolean {
            if (project.isDisposed) return false
            val chosen = Messages.showDialog(
                project,
                ProjectDeleteConfirmation.message(issued).build(),
                ProjectDeleteConfirmation.TITLE,
                null,
                arrayOf(ProjectDeleteConfirmation.DELETE_LABEL, ProjectDeleteConfirmation.CANCEL_LABEL),
                1, // default option: Cancel (Enter does not delete)
                1, // focused option: Cancel
                Messages.getWarningIcon(),
            )
            return chosen == 0
        }
    }
}

/**
 * "Show Archived Projects": a client VIEW setting ([SandpaneSettings.showArchivedProjects]). When on,
 * the list is read with `includeArchived: true` and archived projects are labeled. Disabled — and
 * saying why — on a Core that does not advertise the A3a methods, since it cannot list them.
 */
class ShowArchivedProjectsAction : ToggleAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun isSelected(event: AnActionEvent): Boolean = SandpaneSettings.instance().showArchivedProjects

    override fun setSelected(event: AnActionEvent, state: Boolean) {
        SandpaneSettings.instance().setShowArchivedProjects(state)
        event.project?.let { SbxService.instance(it).refresh() }
    }

    override fun update(event: AnActionEvent) {
        super.update(event)
        val presentation = event.presentation
        if (event.project == null) {
            presentation.isEnabledAndVisible = false
            return
        }
        presentation.isVisible = true
        val connection = ConnectionManager.instance()
        val problem = connection.connectionProblem()
        val gap = if (problem == null) connection.commands.advertisementGap(CoreMethods.PROJECT_ARCHIVE) else null
        presentation.text = if (gap != null) "Sandpane: Show Archived Projects (not supported by this Core)" else "Sandpane: Show Archived Projects"
        presentation.isEnabled = problem == null && gap == null
        presentation.description = PlainText.inert(
            problem ?: if (gap != null) {
                "This Core does not advertise ${CoreMethods.PROJECT_ARCHIVE}, so it cannot list archived projects."
            } else {
                "Also list archived projects (labeled [archived]); Core refuses new work on them until unarchived"
            },
        )
    }
}
