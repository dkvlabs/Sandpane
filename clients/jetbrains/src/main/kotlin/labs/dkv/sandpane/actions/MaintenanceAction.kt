package labs.dkv.sandpane.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.CheckBoxList
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.core.CoreRpcException
import labs.dkv.sandpane.model.MAINTENANCE_CONFLICT_TITLE
import labs.dkv.sandpane.model.MAINTENANCE_LOST_STEP2_TITLE
import labs.dkv.sandpane.model.MaintenanceCleanupResult
import labs.dkv.sandpane.model.MaintenanceItem
import labs.dkv.sandpane.model.maintenanceOutcomeHeadline
import labs.dkv.sandpane.model.maintenanceSizeText
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText
import labs.dkv.sandpane.ui.PlainText
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.Action
import labs.dkv.sandpane.model.CoreMethods

/**
 * A9 Maintenance (design 2026-10-09 §3.9 item 7): an action plus dialog. The whole flow runs on
 * user gestures — scan (this action), pick items (checkbox dialog), step 1, a MODAL confirmation of
 * Core's impact, step 2 — and the action always re-scans after step 2 settles. Step 2 is never
 * retried; a lost answer or a token refusal reads "some items may have been removed — scan again",
 * never "nothing was removed".
 *
 * Every Core-supplied string is rendered as revealed plain text ([VisibleText]); worktree paths are
 * copyable display values, never executed.
 */
class MaintenanceAction : AnAction() {

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
        val gap = if (problem == null) connection.commands.maintenanceGap(CoreMethods.MAINTENANCE_INVENTORY) else null
        when {
            problem != null -> {
                presentation.isEnabled = false
                presentation.description = PlainText.inert(problem)
            }
            gap != null -> {
                presentation.isEnabled = false
                presentation.text = "Sandpane: Clean Up Core State… (not supported by this Core)"
                presentation.description = PlainText.inert(gap.message ?: gap.method)
            }
            else -> {
                presentation.isEnabled = true
                presentation.text = "Sandpane: Clean Up Core State…"
                presentation.description = PlainText.inert(
                    "Scan what Core itself created (temporary directories, migration backups, stored " +
                        "verification output) and confirm a cleanup; worktrees are report-only",
                )
            }
        }
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val connection = ConnectionManager.instance()
        connection.connectionProblem()?.let {
            notify(project, "Sandpane: Core not ready", it, NotificationType.WARNING)
            return
        }
        connection.commands.maintenanceGap(CoreMethods.MAINTENANCE_INVENTORY)?.let {
            notify(project, "Sandpane: maintenance not supported by this Core", it.message ?: "not advertised", NotificationType.WARNING)
            return
        }
        if (!FLOW_OPEN.compareAndSet(false, true)) {
            notify(project, "Sandpane: maintenance busy", "A maintenance dialog is already open; finish it first. Nothing was sent.", NotificationType.WARNING)
            return
        }
        scanThenDialog(project)
    }

    /** Step A: the read-only inventory, then the pick dialog on the EDT. */
    private fun scanThenDialog(project: Project) {
        ConnectionManager.instance().commands.maintenanceInventory()
            .whenComplete { inventory, error ->
                onUi(project) {
                    try {
                        if (inventory == null) {
                            notifyScanFailure(project, error)
                            return@onUi
                        }
                        val removable = inventory.items.filter { it.removable }
                        val reportOnly = inventory.items.filterNot { it.removable }
                        if (inventory.items.isEmpty()) {
                            notify(project, "Sandpane: nothing to clean up", "Core found nothing to clean up.", NotificationType.INFORMATION)
                            return@onUi
                        }
                        if (inventory.truncated) {
                            notify(
                                project,
                                "Sandpane: the scan was cut short",
                                "Core left items out (too many entries or the answer hit its size cap). Clean up what is listed, then scan again.",
                                NotificationType.WARNING,
                            )
                        }
                        if (removable.isEmpty()) {
                            notify(
                                project,
                                "Sandpane: nothing is removable by Sandpane",
                                "${reportOnly.size} report-only item(s); their paths are in the scan. Worktree removal waits for a later protocol step.",
                                NotificationType.INFORMATION,
                            )
                            return@onUi
                        }
                        val dialog = MaintenanceItemsDialog(project, removable, reportOnly)
                        if (!dialog.showAndGet()) {
                            notify(project, "Sandpane: not confirmed", "Not confirmed; nothing was sent.", NotificationType.INFORMATION)
                            return@onUi
                        }
                        val selected = dialog.selectedItems()
                        if (selected.isEmpty()) {
                            notify(project, "Sandpane: not confirmed", "No item was selected; nothing was sent.", NotificationType.INFORMATION)
                            return@onUi
                        }
                        requestConfirmation(project, selected)
                    } finally {
                        // Re-opened by nothing: the flow continues through the dialogs, and the
                        // flag is released when the whole flow settles.
                    }
                }
            }
    }

    /** Step B: `maintenance.cleanup` step 1, then the modal confirmation of Core's impact. */
    private fun requestConfirmation(project: Project, items: List<MaintenanceItem>) {
        val ids = items.map { it.id }
        ConnectionManager.instance().commands.maintenanceCleanupRequest(ids)
            .whenComplete { answer, error ->
                onUi(project) {
                    if (answer == null) {
                        notifyStepFailure(project, error, step1 = true)
                        FLOW_OPEN.set(false)
                        return@onUi
                    }
                    val confirmation = answer.confirmation
                    if (confirmation == null) {
                        // A step-1 answer with no token: nothing was changed, but the shape is wrong.
                        notify(project, "Sandpane: unreadable answer", "Core's cleanup confirmation could not be read; nothing was sent. Scan again.", NotificationType.ERROR)
                        FLOW_OPEN.set(false)
                        return@onUi
                    }
                    val message = MaintenanceText.confirmationMessage(confirmation.impact, confirmation.expiresAt, ids.size)
                    val chosen = com.intellij.openapi.ui.Messages.showDialog(
                        project,
                        message,
                        MaintenanceText.CONFIRM_TITLE,
                        arrayOf(MaintenanceText.REMOVE_LABEL, MaintenanceText.CANCEL_LABEL),
                        1, // default option: Cancel (Enter does not remove)
                        com.intellij.openapi.ui.Messages.getWarningIcon(),
                    )
                    if (chosen != 0) {
                        notify(project, "Sandpane: not confirmed", "Not confirmed; nothing was sent.", NotificationType.INFORMATION)
                        FLOW_OPEN.set(false)
                        return@onUi
                    }
                    confirmCleanup(project, ids, confirmation.token)
                }
            }
    }

    /** Step C: step 2 (the token is spent exactly once, from this gesture), then always re-scan. */
    private fun confirmCleanup(project: Project, ids: List<String>, token: String) {
        ConnectionManager.instance().commands.maintenanceCleanupConfirm(ids, token)
            .whenComplete { outcome, error ->
                onUi(project) {
                    try {
                        if (outcome == null) {
                            notifyStepFailure(project, error, step1 = false)
                        } else if (outcome.removed == null) {
                            notify(
                                project,
                                "Sandpane: unreadable answer",
                                "Core's cleanup outcome could not be read. Some items may have been removed — scan again.",
                                NotificationType.ERROR,
                            )
                        } else {
                            notify(
                                project,
                                "Sandpane: cleanup finished",
                                MaintenanceText.outcomeMessage(outcome, ids.size),
                                if (outcome.skipped.orEmpty().isNotEmpty()) NotificationType.WARNING else NotificationType.INFORMATION,
                            )
                        }
                    } finally {
                        // §3.9 item 7.5: always re-scan after step 2, whatever happened. The
                        // re-scan is silent; its failures surface as an info balloon only.
                        FLOW_OPEN.set(false)
                        ConnectionManager.instance().commands.maintenanceInventory()
                            .whenComplete { _, rescanError ->
                                onUi(project) {
                                    if (rescanError != null) {
                                        notify(
                                            project,
                                            "Sandpane: re-scan failed",
                                            "The post-cleanup re-scan failed; run the action again to see what remains.",
                                            NotificationType.WARNING,
                                        )
                                    }
                                }
                            }
                    }
                }
            }
    }

    private fun notifyScanFailure(project: Project, error: Throwable?) {
        val rpc = error as? CoreRpcException
        if (rpc?.code == CoreErrorCodes.CONFLICT) {
            notify(project, MAINTENANCE_CONFLICT_TITLE, "Core refused the scan because another maintenance scan or cleanup is running; nothing was changed.", NotificationType.WARNING)
            return
        }
        notify(project, "Sandpane: the scan failed", error?.message ?: "Core did not answer the inventory. Nothing was changed.", NotificationType.WARNING)
    }

    /**
     * Step failures. CONFLICT is the busy copy; a step-2 failure (a lost answer or a token
     * refusal) reads "some items may have been removed — scan again": this client cannot tell an
     * expired token from one a lost earlier attempt already consumed, so it never claims nothing
     * was removed.
     */
    private fun notifyStepFailure(project: Project, error: Throwable?, step1: Boolean) {
        val rpc = error as? CoreRpcException
        if (rpc?.code == CoreErrorCodes.CONFLICT) {
            notify(project, MAINTENANCE_CONFLICT_TITLE, "Core refused because another maintenance scan or cleanup is running; nothing was changed.", NotificationType.WARNING)
            return
        }
        if (step1) {
            notify(project, "Sandpane: the cleanup was refused", error?.message ?: "Core refused the cleanup before anything was issued. Scan again.", NotificationType.WARNING)
            return
        }
        notify(
            project,
            MAINTENANCE_LOST_STEP2_TITLE,
            (error?.message?.let { "${DisplayCap.cap(it)} " } ?: "") +
                "If an earlier attempt's answer was lost, Core may already have removed some items. Scan again to see what remains.",
            NotificationType.WARNING,
        )
    }

    private fun onUi(project: Project, block: () -> Unit) {
        if (project.isDisposed) {
            FLOW_OPEN.set(false)
            return
        }
        ApplicationManager.getApplication().invokeLater(block, ModalityState.defaultModalityState())
    }

    companion object {
        /** One maintenance flow at a time (memory only; Core also enforces single-flight). */
        private val FLOW_OPEN = java.util.concurrent.atomic.AtomicBoolean(false)
    }
}

/** The dialog texts, separate so their exact content is unit-tested. */
object MaintenanceText {
    const val CONFIRM_TITLE: String = "Sandpane: Clean Up Core State"
    const val REMOVE_LABEL: String = "Remove Them (cannot be undone)"
    const val CANCEL_LABEL: String = "Cancel"

    /** Impact lines shown; the rest are counted in one overflow line. */
    const val MAX_IMPACT_LINES: Int = 20

    fun confirmationMessage(impact: List<String>, expiresAt: String, count: Int): String = buildString {
        append("Remove ").append(count).append(" confirmed item")
        if (count != 1) append("s")
        append("? This cannot be undone.\n\nCore's impact, as reported:\n")
        val lines = impact.take(MAX_IMPACT_LINES).map { DisplayCap.cap(it) }
        lines.forEach { append("• ").append(it).append('\n') }
        val more = impact.size - MAX_IMPACT_LINES
        if (more > 0) append("… and ").append(more).append(" more impact line(s) not shown\n")
        append("\nConfirmation valid until ").append(DisplayCap.cap(expiresAt))
        append(". Items that changed since the scan are skipped and reported, not removed silently. Cancel sends nothing.")
    }.let { PlainText.inert(it) }

    fun outcomeMessage(outcome: MaintenanceCleanupResult, confirmedCount: Int): String = buildString {
        append(maintenanceOutcomeHeadline(outcome, confirmedCount)).append('\n')
        outcome.skipped.orEmpty().take(10).forEach { append("not removed: ").append(DisplayCap.cap("${it.id}: ${it.reason}")).append('\n') }
        val more = (outcome.skipped?.size ?: 0) - 10
        if (more > 0) append("… and ").append(more).append(" more skipped item(s)\n")
        outcome.notes.forEach { append(DisplayCap.cap(it)).append('\n') }
    }.let { PlainText.inert(it) }

    /** One checkbox row: id, measured size, and (for report-only rows) Core's reason. */
    fun itemRow(item: MaintenanceItem): String {
        val parts = mutableListOf(VisibleText.reveal(item.id))
        maintenanceSizeText(item)?.let { parts.add(it) }
        if (!item.removable) parts.add(VisibleText.reveal(item.reason ?: "report-only"))
        return parts.joinToString(" · ")
    }

    /** The read-only preamble: report-only items with their paths (copyable text, never executed). */
    fun reportOnlyLines(items: List<MaintenanceItem>): List<String> = items.map { item ->
        val path = item.path?.let { " — ${DisplayCap.cap(VisibleText.reveal(it))}" } ?: ""
        val repo = item.repositoryPath?.let { " (repository ${DisplayCap.cap(VisibleText.reveal(it))})" } ?: ""
        "${DisplayCap.cap(VisibleText.reveal(item.id))}$path$repo"
    }
}

/**
 * The item picker: a checkbox list of REMOVABLE items (each pre-checked per Core's default —
 * `dbBackup` and unknown kinds stay unchecked), with the report-only items listed as text above.
 * Shown on the EDT; it makes no Core call.
 */
class MaintenanceItemsDialog(
    project: Project,
    removable: List<MaintenanceItem>,
    reportOnly: List<MaintenanceItem>,
) : DialogWrapper(project) {
    private val removableItems: List<MaintenanceItem> = removable
    private val reportOnlyItems: List<MaintenanceItem> = reportOnly

    private val list: CheckBoxList<MaintenanceItem> = CheckBoxList<MaintenanceItem>().apply {
        removableItems.forEach { item -> addItem(item, MaintenanceText.itemRow(item), item.checkedByDefault) }
    }

    init {
        setTitle(MaintenanceText.CONFIRM_TITLE)
        setOKButtonText("Request Confirmation…")
        setCancelButtonText("Cancel")
        init()
    }

    public override fun createCenterPanel(): JComponent = JPanel(BorderLayout()).apply {
        if (reportOnlyItems.isNotEmpty()) {
            val lines = MaintenanceText.reportOnlyLines(reportOnlyItems)
            add(
                com.intellij.ui.components.JBLabel(
                    PlainText.inert(
                        "Report-only (not removable by Sandpane, ${lines.size} item(s)):\n" +
                            lines.take(10).joinToString("\n") +
                            if (lines.size > 10) "\n… and ${lines.size - 10} more" else "",
                    ),
                ),
                BorderLayout.NORTH,
            )
        }
        add(list, BorderLayout.CENTER)
        preferredSize = Dimension(640, 420)
    }

    fun selectedItems(): List<MaintenanceItem> = removableIds()

    private fun removableIds(): List<MaintenanceItem> {
        val out = ArrayList<MaintenanceItem>()
        for (index in 0 until list.itemsCount) {
            val item = list.getItemAt(index) ?: continue
            if (list.isItemSelected(index)) out.add(item)
        }
        return out
    }

    override fun createActions(): Array<Action> = arrayOf(okAction, cancelAction)
}

