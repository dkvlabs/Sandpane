package labs.dkv.sandpane.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.core.IssuedRemoval
import labs.dkv.sandpane.core.OutcomeSeverity
import labs.dkv.sandpane.core.OutcomeText
import labs.dkv.sandpane.core.SandboxRemoveFlow
import labs.dkv.sandpane.core.StopReport
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.SandboxSummary
import labs.dkv.sandpane.services.SbxService
import labs.dkv.sandpane.ui.PlainText
import labs.dkv.sandpane.ui.RemoveConfirmation
import labs.dkv.sandpane.ui.SandboxChooserDialog

/**
 * Shared gate for the A1 sandbox-lifecycle actions (design 2026-10-09 §1 rule 3, §4).
 *
 * `update()` runs on a background thread ([ActionUpdateThread.BGT]) and reads only the live
 * connection state and `system.probe`'s advertised methods — no IPC. A method the connected Core
 * does not advertise leaves the action VISIBLE but disabled, with a description saying so; it is
 * never hidden and never sent.
 */
abstract class SandboxLifecycleAction(
    private val method: String,
    private val readyText: String,
    private val readyDescription: String,
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

    /**
     * Common preconditions on the EDT; returns the sandbox the user picked, or null after telling
     * them why nothing happens. Makes no Core call itself (the chooser reads the last snapshot).
     */
    protected fun pickSandbox(project: Project, dialogTitle: String, okLabel: String): SandboxSummary? {
        val connection = ConnectionManager.instance()
        connection.connectionProblem()?.let {
            notify(project, "Sandpane: Core not ready", it, NotificationType.WARNING)
            return null
        }
        connection.commands.advertisementGap(method)?.let {
            notify(project, "Sandpane: $method not supported by this Core", it.message ?: method, NotificationType.WARNING)
            return null
        }
        val sbx = SbxService.instance(project)
        val snapshot = sbx.currentSnapshot()
        val sandboxes = snapshot.sandboxes
        if (sandboxes == null) {
            // Why there is no list matters: a failed refresh is not "not read yet" (review I5).
            val gap = snapshot.sandboxListGap() ?: "Core's sandbox list is unavailable"
            sbx.refresh()
            notify(
                project,
                "Sandpane: no sandbox list",
                "$gap. It is being refreshed now; run the action again once it arrives — nothing was sent.",
                if (snapshot.failure != null) NotificationType.WARNING else NotificationType.INFORMATION,
            )
            return null
        }
        if (sandboxes.isEmpty()) {
            notify(
                project,
                "Sandpane: no sandboxes",
                "Core's last list (${snapshot.describeAge()}) has no sandboxes. Refresh if that looks wrong.",
                NotificationType.INFORMATION,
            )
            return null
        }
        val dialog = SandboxChooserDialog(project, dialogTitle, okLabel, sandboxes, snapshot.describeAge())
        return if (dialog.showAndGet()) dialog.selected else null
    }
}

internal fun notifyOutcome(project: Project, outcome: OutcomeText) {
    notify(
        project,
        outcome.title,
        outcome.body,
        when (outcome.severity) {
            OutcomeSeverity.INFO -> NotificationType.INFORMATION
            OutcomeSeverity.WARNING -> NotificationType.WARNING
            OutcomeSeverity.ERROR -> NotificationType.ERROR
        },
    )
}

/**
 * Stop Sandbox (A1): `sandbox.stop` for the sandbox the user picks. Not destructive (sbx keeps the
 * sandbox and `sbx run --name` restarts it), so the explicit pick is the confirmation and Core issues
 * no token. Runs off the EDT; the result is reported from Core's re-query — absent re-query ⇒ state
 * UNKNOWN — and the list is re-probed. Never retried.
 */
class StopSandboxAction : SandboxLifecycleAction(
    method = CoreMethods.SANDBOX_STOP,
    readyText = "Sandpane: Stop Sandbox…",
    readyDescription = "Stop a sandbox through Core (sbx stop), then show the state Core re-queries",
) {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val picked = pickSandbox(project, "Sandpane: Stop Sandbox", "Stop Sandbox") ?: return
        val name = picked.name
        // stopSandbox issues the RPC through ConnectionManager's io pool; nothing blocks the EDT.
        SbxService.instance(project).stopSandbox(name).whenComplete { result, error ->
            notifyOutcome(project, StopReport.describe(name, result, error))
        }
    }
}

/**
 * Remove Sandbox (A1): the two-step server-side confirmation.
 *
 *  1. step 1 (`{name}`, no token) off the EDT — Core changes nothing and issues a confirmation;
 *  2. the confirmation is checked ([labs.dkv.sandpane.core.RemoveConfirmationCheck]) and shown in a
 *     native dialog built from [RemoveConfirmation] (every Core string revealed and escaped, impact
 *     capped at 20 lines, "NOT CONFIRMED AS CREATED BY SANDPANE" first when `external`), with the explicit
 *     button "Remove Sandbox" and Cancel as both the default and the focused option;
 *  3. only on "Remove Sandbox", and only if the expiry has not passed, step 2 with that token is
 *     sent off the EDT. Cancel sends nothing. Neither step is ever retried.
 */
class RemoveSandboxAction : SandboxLifecycleAction(
    method = CoreMethods.SANDBOX_REMOVE,
    readyText = "Sandpane: Remove Sandbox…",
    readyDescription = "Remove a sandbox through Core after Core's own confirmation (sbx rm)",
) {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val picked = pickSandbox(project, "Sandpane: Remove Sandbox", "Continue…") ?: return
        val connection = ConnectionManager.instance()
        val flow = SandboxRemoveFlow(
            connection.commands,
            DialogUi(project),
            // Step 2 is built and sent on the io pool, never on the EDT the dialog returned on.
            background = { task -> connection.background("sandbox.remove step 2") { task() } },
        )
        flow.run(picked.name).whenComplete { outcome, error ->
            if (outcome == null) {
                notify(
                    project,
                    "Sandpane: removal outcome unknown",
                    "The remove flow ended without an outcome (${error?.javaClass?.simpleName ?: "no detail"}). " +
                        "Nothing is retried; the list is re-probed.",
                    NotificationType.ERROR,
                )
                SbxService.instance(project).refresh()
                return@whenComplete
            }
            notifyOutcome(project, outcome.describe())
            if (outcome.refreshList) SbxService.instance(project).refresh()
        }
    }

    /** The IDE side of [SandboxRemoveFlow.Ui]: the EDT hop and the native modal dialog. */
    private class DialogUi(private val project: Project) : SandboxRemoveFlow.Ui {
        override fun onUiThread(block: () -> Unit) {
            ApplicationManager.getApplication().invokeLater(block, ModalityState.defaultModalityState())
        }

        override fun confirm(issued: IssuedRemoval): Boolean {
            // A project closed while step 1 was in flight gets no dialog — and no step 2.
            if (project.isDisposed) return false
            val chosen = Messages.showDialog(
                project,
                RemoveConfirmation.message(issued).build(),
                RemoveConfirmation.TITLE,
                null,
                arrayOf(RemoveConfirmation.REMOVE_LABEL, RemoveConfirmation.CANCEL_LABEL),
                1, // default option: Cancel (Enter does not remove)
                1, // focused option: Cancel
                Messages.getWarningIcon(),
            )
            return chosen == 0
        }
    }
}

/**
 * Start Sandbox: an honest unsupported state (design 2026-10-09 §3 row A1). sbx v0.47 has no
 * `start`, Core dispatches no `sandbox.start`, and this action sends nothing. It stays enabled — like
 * Start Task's "chat is unsupported" path — so the user can learn WHY, and how to restart a sandbox
 * themselves, instead of finding a silently greyed item.
 */
class StartSandboxAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        val presentation = event.presentation
        presentation.isEnabledAndVisible = event.project != null
        presentation.text = "Sandpane: Start Sandbox (not supported)"
        presentation.description = PlainText.inert(CoreMethods.SANDBOX_START_UNSUPPORTED)
    }

    override fun actionPerformed(event: AnActionEvent) {
        notify(
            event.project,
            "Sandpane: starting a sandbox is not supported",
            CoreMethods.SANDBOX_START_UNSUPPORTED + ". Nothing was sent to Core.",
            NotificationType.INFORMATION,
        )
    }
}
