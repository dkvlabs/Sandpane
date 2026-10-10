package labs.dkv.sandpane.actions

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Every id the tool-window toolbar adds ([ActionIds.ALL]) is declared in plugin.xml with the class
 * that implements it, inside the Sandpane group — so an A3a action can neither silently vanish from
 * the toolbar nor be bound to the wrong class.
 */
class ActionRegistrationTest {

    private val pluginXml: String by lazy { File("src/main/resources/META-INF/plugin.xml").readText() }

    private val expected = mapOf(
        ActionIds.STOP_SANDBOX to StopSandboxAction::class,
        ActionIds.REMOVE_SANDBOX to RemoveSandboxAction::class,
        ActionIds.START_SANDBOX to StartSandboxAction::class,
        ActionIds.EDIT_PROJECT to EditProjectAction::class,
        ActionIds.ARCHIVE_PROJECT to ArchiveProjectAction::class,
        ActionIds.UNARCHIVE_PROJECT to UnarchiveProjectAction::class,
        ActionIds.SHOW_ARCHIVED_PROJECTS to ShowArchivedProjectsAction::class,
        ActionIds.ADD_REPOSITORY to AddRepositoryAction::class,
        ActionIds.REMOVE_REPOSITORY to RemoveRepositoryAction::class,
        ActionIds.DELETE_PROJECT to DeleteProjectAction::class,
    )

    @Test
    fun everyToolbarActionIsDeclaredWithItsClass() {
        for (id in ActionIds.ALL) {
            assertTrue(pluginXml.contains("<action id=\"$id\""), "plugin.xml does not declare $id")
        }
        for ((id, cls) in expected) {
            val block = Regex("""<action id="${Regex.escape(id)}"\s+class="([^"]+)"""").find(pluginXml)
                ?: error("no <action id=\"$id\" class=…>")
            assertEquals(cls.qualifiedName, block.groupValues[1], id)
        }
        assertEquals(14, ActionIds.ALL.size)
        assertEquals(ActionIds.ALL.size, ActionIds.ALL.toSet().size, "duplicate action id")
    }
}
