package labs.dkv.sandpane.services

import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.reported
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * A5 review item I3: the review maps Core's paths onto the IDE VCS root whose path IS Core's
 * `ChangeSet.repoPath` (exact after canonicalization), never simply the first root; with no match it
 * says so visibly and resolves against nothing else. Pure, tested with real temp directories.
 */
class ReviewRootTest {

    private fun withDirs(block: (File) -> Unit) {
        val base = Files.createTempDirectory("sandpane-i3").toFile()
        try {
            block(base)
        } finally {
            base.deleteRecursively()
        }
    }

    @Test
    fun theRootThatEqualsCoresRepoPathIsChosenEvenWhenItIsNotTheFirst() = withDirs { base ->
        val first = File(base, "first").apply { mkdirs() }.path
        val second = File(base, "second").apply { mkdirs() }.path
        val chosen = ReviewRoots.choose(second, listOf(first, second))
        assertEquals(ReviewRoot.Matched(second), chosen)
        // A trailing separator and a `.` segment are the same directory.
        assertEquals(ReviewRoot.Matched(second), ReviewRoots.choose("$second/./", listOf(first, second)))
    }

    @Test
    fun aSymlinkedRepoPathMatchesItsRealRoot() = withDirs { base ->
        val real = File(base, "real").apply { mkdirs() }
        val link = File(base, "link")
        Files.createSymbolicLink(link.toPath(), real.toPath())
        assertEquals(ReviewRoot.Matched(real.path), ReviewRoots.choose(link.path, listOf(File(base, "other").path, real.path)))
    }

    @Test
    fun aMismatchWarnsVisiblyAndUsesNoOtherRoot() = withDirs { base ->
        val only = File(base, "ide").apply { mkdirs() }.path
        val core = File(base, "core\nrepo\u202E").path
        val chosen = assertIs<ReviewRoot.Refused>(ReviewRoots.choose(core, listOf(only)))
        assertTrue(chosen.warning.contains("is not a VCS root of this project"), chosen.warning)
        assertTrue(chosen.warning.startsWith("Core's repository ("), chosen.warning)
        assertTrue(chosen.warning.contains("core\\nrepo\\u202E"), "revealed: ${chosen.warning}")
        assertFalse(chosen.warning.contains('\n') || chosen.warning.contains('\u202E'), "one revealed line")
        assertFalse(chosen.warning.contains(only), "no other root is named as the one used")
        // A parent or child of a root is not that root.
        assertIs<ReviewRoot.Refused>(ReviewRoots.choose(File(only, "sub").path, listOf(only)))
        assertIs<ReviewRoot.Refused>(ReviewRoots.choose(base.path, listOf(only)))
        // No VCS roots at all is also a mismatch, never a fallback.
        assertIs<ReviewRoot.Refused>(ReviewRoots.choose(only, emptyList()))
        // A very long repoPath is capped.
        val long = assertIs<ReviewRoot.Refused>(ReviewRoots.choose("/" + "x".repeat(5000), listOf(only)))
        assertTrue(long.warning.length < 1000, "capped")
    }

    @Test
    fun anOlderCoreWithoutRepoPathResolvesAgainstNothingAndSaysSo() = withDirs { base ->
        val only = File(base, "ide").apply { mkdirs() }.path
        val chosen = assertIs<ReviewRoot.Refused>(ReviewRoots.choose(null, listOf(only)))
        assertEquals(ReviewRoots.NOT_REPORTED, chosen.warning)
        // No comparison was made, so no per-change reason may claim one was.
        val cs = ChangeSet(taskId = "t", baseCommit = "b", hostDirty = false, changes = listOf(FileChange("a.kt", FileChangeStatus.MODIFIED.reported())))
        val target = EditorDiffProvider.unresolvedTarget(cs, chosen.warning)
        assertTrue(target.unresolved.none { it.reason.contains("is Core's repository") || it.reason.contains("is not a VCS root") })
        assertTrue(EditorDiffProvider.summarizeTarget(target, null).contains(ReviewRoots.NOT_REPORTED))
        assertIs<ReviewRoot.Refused>(ReviewRoots.choose("relative/path", listOf(only)))
    }

    @Test
    fun aRefusedRootLeavesEveryChangeUnresolvedAndTheSummaryWarns() {
        val cs = ChangeSet(
            taskId = "5b0c7a1e-0000-4000-8000-00000000d1ff",
            baseCommit = "0123456789abcdef",
            hostDirty = false,
            changes = listOf(FileChange("a.kt", FileChangeStatus.MODIFIED.reported()), FileChange("b.kt", FileChangeStatus.ADDED.reported())),
            repoPath = "/repos/atlas",
        )
        val warning = ReviewRoots.notAVcsRoot("/repos/atlas")
        val target = EditorDiffProvider.unresolvedTarget(cs, warning)
        assertTrue(target.resolved.isEmpty())
        assertEquals(cs.changes, target.unresolved.map { it.change })
        assertEquals(warning, target.rootWarning)
        val text = EditorDiffProvider.summarizeTarget(target, null)
        assertTrue(text.contains("Core's repository (/repos/atlas) is not a VCS root of this project"), text)
    }
}
