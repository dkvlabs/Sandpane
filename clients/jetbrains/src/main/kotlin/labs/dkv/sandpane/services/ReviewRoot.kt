// Which IDE VCS root a Core change set is mapped onto, as a pure function (A5 review item I3).
package labs.dkv.sandpane.services

import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText

/** The IDE root a review's paths resolve against, or a visible reason why none is used. */
sealed class ReviewRoot {
    /** [root] (as the IDE lists it) is the same directory as Core's `ChangeSet.repoPath`. */
    data class Matched(val root: String) : ReviewRoot()

    /** No root is used, so no path is resolved; [warning] is shown to the user, revealed and capped. */
    data class Refused(val warning: String) : ReviewRoot()
}

object ReviewRoots {

    /** An older Core sends no `repoPath`: nothing confirms which root it reviewed, so none is guessed. */
    const val NOT_REPORTED: String =
        "Core did not report its repository root (an older Core), so file paths were not resolved against any root of this project."

    fun notAVcsRoot(repoPath: String): String =
        "Core's repository (${VisibleText.reveal(DisplayCap.cap(repoPath))}) is not a VCS root of this project; " +
            "file paths were not resolved against any other root."

    /**
     * The VCS root whose path equals Core's [repoPath], compared exactly after
     * [FolderMatching.canonicalize] on BOTH sides (symlinks resolved when the path exists locally,
     * else a lexical normalize; never case-folded, never a parent or child match). No match, or no
     * [repoPath], is [ReviewRoot.Refused]: taking the first root, or the project base directory, would
     * point review navigation at a repository Core did not review.
     *
     * Does disk I/O (`toRealPath`): call it off the EDT.
     */
    fun choose(repoPath: String?, vcsRoots: List<String>): ReviewRoot {
        if (repoPath == null) return ReviewRoot.Refused(NOT_REPORTED)
        val core = FolderMatching.canonicalize(repoPath) ?: return ReviewRoot.Refused(notAVcsRoot(repoPath))
        val hit = vcsRoots.firstOrNull { root -> FolderMatching.canonicalize(root) == core }
        return hit?.let { ReviewRoot.Matched(it) } ?: ReviewRoot.Refused(notAVcsRoot(repoPath))
    }
}
