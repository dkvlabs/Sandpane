package labs.dkv.sandpane.ui

import labs.dkv.sandpane.core.SendModes
import labs.dkv.sandpane.services.TaskMonitorService

/** The task row's meta line: Core's status plus, when Core reported them, the A4 send mode and chosen name. */
object TaskRowText {
    fun meta(taskId: String, view: TaskMonitorService.TaskView): String =
        (listOf("task ${taskId.take(8)} \u00B7 ${view.statusLabel} (reported by Core)") +
            SendModes.details(view.mode, view.chosenSandboxName)).joinToString(" \u00B7 ")
}
