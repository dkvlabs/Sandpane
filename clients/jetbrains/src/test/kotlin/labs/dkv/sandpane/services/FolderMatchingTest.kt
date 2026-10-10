package labs.dkv.sandpane.services

import labs.dkv.sandpane.model.Project
import labs.dkv.sandpane.model.reported
import labs.dkv.sandpane.model.SandboxSummary
import labs.dkv.sandpane.model.WorkspaceMode
import labs.dkv.sandpane.model.WorkspaceModeTone
import labs.dkv.sandpane.model.WorkspaceModeView
import java.nio.file.Files
import java.nio.file.Paths
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The two places a newer Core can make this client LIE if it is careless:
 *
 *  * folder→project resolution, where a name-match would point an agent at the wrong repository;
 *  * the workspace-mode label, where an absent `workspaceMode` rendered as neutral would hide a
 *    live-writable mount (docs/specs/02 §7, docs/specs/04 §3).
 *
 * Both are pure, so they are tested with real filesystem paths rather than mocks.
 */
class FolderMatchingTest {

    private fun project(id: String, name: String, repositories: List<String>) =
        Project(id = id, name = name, description = "", createdAt = "t", repositories = repositories)

    // -----------------------------------------------------------------------
    // folder → project
    // -----------------------------------------------------------------------

    @Test
    fun anExactRegisteredPathMatchesThatProject() {
        val dir = Files.createTempDirectory("sandpane-repo").toRealPath().toString()
        val association = FolderMatching.associate(
            listOf(project("p1", "Atlas Demo", listOf(dir))),
            dir,
        )
        assertIs<FolderAssociation.Matched>(association)
        assertEquals("p1", association.project.id)
        assertEquals(dir, association.matchedRepository)
    }

    @Test
    fun aSymlinkedCheckoutStillMatchesBecauseBothSidesAreCanonicalized() {
        // Core stores what was registered and canonicalizes only at mount time, so the client must
        // canonicalize BOTH sides or a symlinked checkout reads as "not registered".
        val real = Files.createTempDirectory("sandpane-real").toRealPath()
        val link = Paths.get(real.toString() + "-link")
        Files.deleteIfExists(link)
        val created = try {
            Files.createSymbolicLink(link, real)
        } catch (e: Exception) {
            null // A filesystem without symlink support: the case is skipped, never faked.
        }
        if (created == null) return
        try {
            val byLink = FolderMatching.associate(listOf(project("p1", "Atlas Demo", listOf(real.toString()))), link.toString())
            assertIs<FolderAssociation.Matched>(byLink, "registering the real path must still match a folder opened through a symlink")
        } finally {
            Files.deleteIfExists(link)
        }
    }

    @Test
    fun twoProjectsClaimingTheFolderAreAmbiguousNotSilentlyPicked() {
        val dir = Files.createTempDirectory("sandpane-dup").toRealPath().toString()
        val association = FolderMatching.associate(
            listOf(
                project("p1", "Atlas Demo", listOf(dir)),
                project("p2", "Nova Demo", listOf(dir)),
            ),
            dir,
        )
        assertIs<FolderAssociation.Ambiguous>(association, "a first-wins pick would be the client inventing a preference")
        assertEquals(listOf("p1", "p2"), association.candidates.map { it.id })
    }

    @Test
    fun anUnclaimedFolderIsReportedAsUnregistered() {
        val mine = Files.createTempDirectory("sandpane-mine").toRealPath().toString()
        val other = Files.createTempDirectory("sandpane-other").toRealPath().toString()
        val association = FolderMatching.associate(listOf(project("p1", "Atlas Demo", listOf(other))), mine)
        assertIs<FolderAssociation.Unregistered>(association)
    }

    @Test
    fun aCoreWithoutRepositoryPathsIsIndeterminateNotUnregistered() {
        // The distinction is the honest part: "this Core never told me" is not "this folder is not
        // registered". Collapsing them would let the plugin tell the user to register a folder that
        // may already be registered.
        val dir = Files.createTempDirectory("sandpane-old").toRealPath().toString()
        val oldCore = listOf(
            Project(id = "p1", name = "Atlas Demo", description = "", createdAt = "t"),
        )
        assertEquals(emptyList<String>(), oldCore.single().repositories)
        val association = FolderMatching.associate(oldCore, dir)
        assertIs<FolderAssociation.Indeterminate>(association)
        assertTrue(association.reason.contains("predates the additive"), association.reason)
    }

    @Test
    fun neverProbedAndEmptyProjectListsAreToldApart() {
        assertIs<FolderAssociation.Indeterminate>(FolderMatching.associate(null, "/tmp"))
        assertIs<FolderAssociation.Indeterminate>(FolderMatching.associate(emptyList(), "/tmp"))
        assertIs<FolderAssociation.Indeterminate>(FolderMatching.associate(listOf(project("p", "n", listOf("/tmp"))), null))
        assertIs<FolderAssociation.Indeterminate>(FolderMatching.associate(listOf(project("p", "n", listOf("/tmp"))), "   "))
    }

    @Test
    fun aRelativeOrUnresolvableFolderIsNeverCompared() {
        val projects = listOf(project("p1", "Atlas Demo", listOf("relative/repo")))
        // A relative registered path cannot be canonicalized, so nothing may match it.
        val association = FolderMatching.associate(projects, Files.createTempDirectory("sandpane-rel").toRealPath().toString())
        assertIs<FolderAssociation.Unregistered>(association)
        assertNull(FolderMatching.canonicalize("relative/repo"))
        assertNull(FolderMatching.canonicalize(""))
        assertNull(FolderMatching.canonicalize("   "))
    }

    // -----------------------------------------------------------------------
    // workspace mode labelling
    // -----------------------------------------------------------------------

    @Test
    fun directMountIsLabelledLiveWritable() {
        val view = WorkspaceModeView.forSandbox(
            SandboxSummary(name = "atlas-auth", probedState = "running", boundProjectId = "p1", workspaceMode = WorkspaceMode.DIRECT_MOUNT.reported()),
        )
        assertEquals(WorkspaceModeTone.LIVE_WRITABLE, view.tone)
        assertTrue(view.hostWritable, "direct_mount edits are already on the host")
        assertTrue(view.badge.contains("LIVE-WRITABLE", ignoreCase = true), view.badge)
    }

    @Test
    fun anAbsentModeIsUnverifiedAndAssumedHostWritable() {
        // Core returned `probedState` but no mode: the picker must NOT look safe.
        val view = WorkspaceModeView.forSandbox(
            SandboxSummary(name = "atlas-auth", probedState = "running", boundProjectId = "p1"),
        )
        assertEquals(WorkspaceModeTone.UNKNOWN, view.tone)
        assertTrue(view.hostWritable, "unknown is assumed to be the worst case, never isolated")
        assertFalse(view.badge.contains("safe", ignoreCase = true))
        assertTrue(view.badge.contains("UNVERIFIED"), view.badge)
        assertTrue(view.explanation.contains("never guesses"), view.explanation)
    }

    @Test
    fun everyNamedModeHasALabelAndOnlyDirectMountClaimsHostWrites() {
        val views = WorkspaceMode.entries.associateWith {
            WorkspaceModeView.forSandbox(SandboxSummary(name = "s", workspaceMode = it.reported()))
        }
        views.forEach { (mode, view) -> assertNotNull(view.label, "no label for $mode") }
        val writable = views.filterValues { it.hostWritable }.keys
        assertEquals(setOf(WorkspaceMode.DIRECT_MOUNT), writable, "only direct_mount may claim host writes")
    }

    @Test
    fun unknownAndAbsentViewsShareTheWorstCaseTone() {
        val unknown = WorkspaceModeView.unknown("some_new_mode")
        val absent = WorkspaceModeView.unverified()
        assertTrue(unknown.hostWritable && absent.hostWritable)
        assertEquals(WorkspaceModeTone.UNKNOWN, unknown.tone)
        assertEquals(WorkspaceModeTone.UNKNOWN, absent.tone)
        // The unrecognised name is shown, not swallowed: a newer Core's mode must be visible.
        assertTrue(unknown.label.contains("some_new_mode"), unknown.label)
    }

    @Test
    fun theSandboxSummaryProjectsItsOwnMode() {
        val bound = SandboxSummary(name = "s", workspaceMode = WorkspaceMode.SBX_CLONE.reported())
        assertEquals(WorkspaceModeTone.ISOLATED, bound.modeView().tone)
        assertEquals(WorkspaceModeTone.UNKNOWN, SandboxSummary(name = "s").modeView().tone)
    }
}
