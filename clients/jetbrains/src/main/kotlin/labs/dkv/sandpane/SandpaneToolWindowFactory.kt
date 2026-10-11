package labs.dkv.sandpane

import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.settings.SandpaneSettings
import labs.dkv.sandpane.ui.ChatPanel
import labs.dkv.sandpane.ui.VerificationPanel

/**
 * Registers and fills the Sandpane tool window (docs/specs/04 §2 "Tool WindowFactory":
 * native Swing components by default, tabbed chat UI).
 *
 * Dumb awareness: the panel is created in indexing modes too, because every Core call it can
 * make is read-only IPC that does not depend on the IDE index. Context-dependent actions
 * disable themselves while Core/`DumbService` says so (specs/04 §3).
 *
 * Lifecycle (specs/04 §2): opening the window attaches a subscription and triggers the
 * connection; closing it or the project disposes the panel's listeners only. The shared
 * application-scoped [ConnectionManager] and every Core-side task keep running.
 *
 * JCEF is not used here. If rich Markdown rendering is added, it arrives as an optional
 * enhancement with this Swing panel remaining the fallback (specs/04 §2, §5 risk 3).
 */
class SandpaneToolWindowFactory : DumbAware, ToolWindowFactory {

    override fun shouldBeAvailable(project: Project): Boolean = true

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        // Created on the EDT by the platform; ChatPanel starts its flush timer here.
        val panel = ChatPanel(project, project)
        val content: Content = ContentFactory.getInstance().createContent(panel, CONTENT_TITLE, false)
        // Dispose the panel's own subscriptions when the content is closed. Content.setDisposer
        // takes the Disposable directly, so no extra wrapper object is retained.
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)

        // A7: the Verification section (design 2026-10-09 \u00A73.7), a second native Swing tab. Its
        // controls are enabled only when Core advertises the `verification` feature. Closing the
        // content disposes the panel's listeners only; Core and every run keep going.
        val verification = VerificationPanel(project)
        val verificationContent = ContentFactory.getInstance().createContent(verification, VERIFICATION_TITLE, false)
        verificationContent.setDisposer(verification)
        toolWindow.contentManager.addContent(verificationContent)

        val connection = ConnectionManager.instance()
        if (SandpaneSettings.instance().autoConnect && !connection.isReady) {
            connection.connectAsync("tool window activated")
        }
    }

    companion object {
        /**
         * The identifier the brief calls `factoryId`. `<toolWindow>` in the current
         * descriptor bean is addressed by its `id` attribute plus `factoryClass`; there is no
         * documented `factoryId` attribute, so the string is carried here (and in plugin.xml's
         * `id`) instead of inventing an undocumented XML attribute. JB0: confirm the bean's
         * attribute set against the pinned baseline.
         */
        const val FACTORY_ID: String = "SandpaneToolWindow"

        /** The `id` attribute in plugin.xml — what `ToolWindowManager.getToolWindow(id)` uses. */
        const val TOOL_WINDOW_ID: String = "Sandpane"

        private const val CONTENT_TITLE = "Chat"
        private const val VERIFICATION_TITLE = "Verification"
    }
}
