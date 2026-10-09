// Folder → Core project resolution, as a pure function.
//
// Extracted from [labs.dkv.sandpane.services.SbxService] so the matching rules — the place where a
// wrong answer would silently point an agent at the wrong repository — are unit-testable without an
// IDE `Project`. The service supplies the snapshot; this decides what it means.
package labs.dkv.sandpane.services

import labs.dkv.sandpane.model.Project
import java.io.File
import java.nio.file.Path
import java.nio.file.Paths

/**
 * How an IDE folder relates to a Core project, answered from `project.list` alone.
 *
 * Every case is Core's data or an explicit "cannot tell" — there is no branch that guesses.
 */
sealed class FolderAssociation {
    /** Exactly one Core project lists a repository that resolves to this folder. */
    data class Matched(val project: Project, val matchedRepository: String) : FolderAssociation()

    /**
     * Several Core projects claim the same folder. This is Core's state, so the user picks;
     * taking the first would be this client inventing a preference it does not have.
     */
    data class Ambiguous(val candidates: List<Project>) : FolderAssociation()

    /**
     * No Core project claims this folder — a real answer now that `repositories` is on the wire,
     * meaning "not registered", NOT "we could not tell".
     */
    data object Unregistered : FolderAssociation()

    /**
     * Undecidable because an input is missing, with the reason stated instead of being reported as
     * "not registered": an absent field and an absent registration are different facts.
     */
    data class Indeterminate(val reason: String) : FolderAssociation()
}

object FolderMatching {

    /**
     * Resolve [folderPath] against the projects Core reported.
     *
     * Canonicalization happens on BOTH sides, exactly as the Rust doc on `Project.repositories`
     * warns: `project.create` only requires an absolute path, while Core canonicalizes (resolves
     * symlinks) at `sandbox.create` mount time. A plain string-compare would miss every symlinked
     * checkout, and comparing only one side would match a path to itself.
     *
     * A folder this process cannot resolve is [FolderAssociation.Indeterminate], never a mismatch:
     * in a remote-backend or WSL layout the files may live on a host this plugin's process does not
     * share (docs/specs/04 §5 risk 1), and cross-host mapping is not guessed here.
     */
    fun associate(projects: List<Project>?, folderPath: String?): FolderAssociation {
        if (folderPath.isNullOrBlank()) {
            return FolderAssociation.Indeterminate("there is no folder path to resolve")
        }
        if (projects == null) {
            return FolderAssociation.Indeterminate("projects have never been read from Core")
        }
        if (projects.isEmpty()) {
            return FolderAssociation.Indeterminate("Core reports no projects")
        }
        // An older Core answers with no `repositories` on ANY row. Calling that "unregistered"
        // would be a false negative about the user's setup, so the absence is named instead.
        if (projects.none { it.repositories.isNotEmpty() }) {
            return FolderAssociation.Indeterminate(
                "no Core project reports repository paths — this Core predates the additive " +
                    "project.repositories field, or nothing was ever registered with it",
            )
        }
        val folder = canonicalize(folderPath)
            ?: return FolderAssociation.Indeterminate(
                "'$folderPath' cannot be resolved by the process running Sandpane (a remote backend " +
                    "may keep the folder on another host) — no path comparison was attempted",
            )

        val matches = ArrayList<FolderAssociation.Matched>()
        for (project in projects) {
            val hit = project.repositories.firstOrNull { repo ->
                val canonical = canonicalize(repo)
                canonical != null && canonical == folder
            }
            if (hit != null) matches += FolderAssociation.Matched(project, hit)
        }
        return when (matches.size) {
            0 -> FolderAssociation.Unregistered
            1 -> matches.single()
            else -> FolderAssociation.Ambiguous(matches.map { it.project })
        }
    }

    /**
     * Absolute, and symlink-resolved when the path exists locally.
     *
     * Falls back to a lexical `normalize()` when it does not, so an unresolvable registered path
     * still gets a textual comparison rather than being dropped — and returns null only for
     * genuinely unusable input (blank or relative), which can never equal anything.
     */
    fun canonicalize(path: String): String? {
        if (path.isBlank()) return null
        val parsed: Path = try {
            Paths.get(path)
        } catch (e: Exception) {
            return null
        }
        if (!parsed.isAbsolute) return null
        return try {
            parsed.toRealPath().toString()
        } catch (e: Exception) {
            // NoSuchFileException / access problems: compare lexically rather than pretending to
            // know the real path.
            parsed.normalize().toString().ifBlank { File(path).absolutePath }
        }
    }
}
