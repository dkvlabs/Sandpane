package labs.dkv.sandpane.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.LabeledComponent
import labs.dkv.sandpane.core.ConnectionManager
import java.awt.BorderLayout
import javax.swing.BorderFactory
import javax.swing.BoxLayout
import javax.swing.JCheckBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JTextField

/**
 * Sandpane UI settings (Settings → Tools → Sandpane).
 *
 * Scope discipline: transport discovery and rendering cadence only. Projects, sandboxes,
 * conversations and tasks are Core state and are never mirrored into IDE workspace files
 * (docs/specs/04 §2, AGENTS.md rule 2).
 *
 * `LabeledComponent` + `BorderLayout` are the plain public forms; no JCEF, so this page
 * renders in every runtime including dumb mode.
 */
class SandpaneConfigurable : Configurable {

    private var root: JPanel? = null
    private val socketField = JTextField(40)
    private val autoConnectBox = JCheckBox(AUTO_CONNECT_LABEL, true)

    /**
     * Session-only diagnostics switch (review bug 12): it used to exist only as an unread settings
     * field. It now drives [ConnectionManager.verboseLogging] directly and is deliberately NOT
     * persisted, so an IPC trace can never stay switched on across restarts by accident.
     */
    private val verboseLoggingBox = JCheckBox(VERBOSE_LABEL, false)

    override fun getDisplayName(): String = DISPLAY_NAME

    override fun createComponent(): JComponent {
        socketField.toolTipText = SOCKET_TOOLTIP
        autoConnectBox.toolTipText = SOCKET_TOOLTIP

        val form = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = BorderFactory.createEmptyBorder(8, 8, 8, 8)
            add(LabeledComponent.create(socketField, "Core socket path (empty = per-user default)"))
            add(autoConnectBox)
            add(verboseLoggingBox.apply { toolTipText = VERBOSE_TOOLTIP })
            add(JLabel(NOTICE).apply { border = BorderFactory.createEmptyBorder(12, 0, 0, 0) })
        }

        return JPanel(BorderLayout()).apply {
            add(BorderLayout.CENTER, form)
            add(BorderLayout.SOUTH, JPanel().apply {
                layout = BoxLayout(this, BoxLayout.X_AXIS)
                add(JLabel(FOOTER).apply { border = BorderFactory.createEmptyBorder(8, 8, 8, 8) })
            })
        }.also { root = it }
    }

    override fun isModified(): Boolean {
        val settings = SandpaneSettings.instance()
        return socketField.text.orEmpty().trim() != settings.socketPathOverride ||
            autoConnectBox.isSelected != settings.autoConnect ||
            verboseLoggingBox.isSelected != ConnectionManager.verboseLogging
    }

    override fun apply() {
        val settings = SandpaneSettings.instance()
        val socketChanged = socketField.text.orEmpty().trim() != settings.socketPathOverride
        // Mutate the live state instead of replacing it: a fresh State would silently
        // reset the rendering/timeout preferences that this page does not own.
        settings.setSocketPathOverride(socketField.text.orEmpty())
        settings.setAutoConnect(autoConnectBox.isSelected)
        ConnectionManager.verboseLogging = verboseLoggingBox.isSelected
        if (socketChanged) {
            // The old socket stays attached otherwise until it happens to drop (review bug 12).
            // reconnect() is non-blocking: the old client is closed on the IPC executor.
            ConnectionManager.instance().reconnect("socket path changed in Settings")
        }
    }

    override fun reset() {
        val settings = SandpaneSettings.instance()
        socketField.text = settings.socketPathOverride
        autoConnectBox.isSelected = settings.autoConnect
        verboseLoggingBox.isSelected = ConnectionManager.verboseLogging
    }

    override fun disposeUIResources() {
        root = null
    }

    companion object {
        const val DISPLAY_NAME = "Sandpane"
        private const val AUTO_CONNECT_LABEL = "Connect to the local Sandpane Core when the tool window opens"
        private const val VERBOSE_LABEL = "Verbose IPC logging for this IDE session (not saved)"
        private const val VERBOSE_TOOLTIP =
            "Writes bounded connection/poll diagnostics to the IDE's stderr log. Frames are truncated " +
                "and never dumped whole; turn it off again when done. Resets on IDE restart."
        private const val SOCKET_TOOLTIP =
            "Local Unix socket path only (Windows named pipes are not implemented by Core yet). " +
                "TCP is never used (docs/specs/02 §2)."
        private const val NOTICE =
            "Sandpane is independent software by DKV Labs, not affiliated with or endorsed by " +
                "Docker, Inc. or JetBrains s.r.o. No sbx binary or provider credential is stored here."
        private const val FOOTER =
            "Scaffold stage: these are transport/rendering preferences. Project, sandbox and " +
                "task state live in Core and are re-read on every refresh."
    }
}
