package labs.dkv.sandpane.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A9 maintenance models (design 2026-10-09 §3.9): `maintenance.inventory` and the two-step,
 * token-confirmed `maintenance.cleanup` of state Core itself created (temp directories, migration
 * backups, stored verification output; worktrees report-only).
 *
 * Every string Core sends (`detail`, `reason`, `path`, `repositoryPath`, `impact`, `notes`,
 * skipped `reason`) is UNTRUSTED display text: the UI renders it as plain text with hidden
 * characters escaped, never as HTML/Markdown, and never executes a path.
 */

/** `MaintenanceItem.kind` values Core sends today; `kind` stays an OPEN string on the wire. */
object MaintenanceKinds {
    const val TEMP: String = "temp"
    const val DB_BACKUP: String = "dbBackup"
    const val VERIFICATION_OUTPUT: String = "verificationOutput"
    const val WORKTREE: String = "worktree"

    val KNOWN: Set<String> = setOf(TEMP, DB_BACKUP, VERIFICATION_OUTPUT, WORKTREE)
}

/** One inventory entry (§3.9 item 1). `bytes` is absent when Core did not measure a size. */
@Serializable
data class MaintenanceItem(
    val id: String,
    val kind: String,
    val removable: Boolean,
    val detail: String,
    val bytes: Long? = null,
    @SerialName("sizeIncomplete") val sizeIncomplete: Boolean? = null,
    @SerialName("createdAt") val createdAt: String? = null,
    val reason: String? = null,
    val path: String? = null,
    @SerialName("repositoryPath") val repositoryPath: String? = null,
) {
    /**
     * Whether the item's checkbox starts checked (§3.9 item 7.3): only a REMOVABLE item of a
     * KNOWN kind other than `dbBackup` — backups are the way back to an older Core, so they wait
     * for an explicit opt-in. Unknown kinds render unchecked and show Core's `detail`.
     */
    val checkedByDefault: Boolean
        get() = removable && kind != MaintenanceKinds.DB_BACKUP && MaintenanceKinds.KNOWN.contains(kind)

    /** Group label for the dialog list; an unknown kind keeps its (escaped) raw text. */
    val groupLabel: String
        get() = when (kind) {
            MaintenanceKinds.TEMP -> "Core temporary directories"
            MaintenanceKinds.DB_BACKUP -> "Database migration backups (unchecked by default)"
            MaintenanceKinds.VERIFICATION_OUTPUT -> "Stored verification output"
            MaintenanceKinds.WORKTREE -> "Worktrees (report-only)"
            else -> "Other (${labs.dkv.sandpane.text.VisibleText.reveal(kind)})"
        }
}

/** A kind Core could not inventory at all (e.g. no data directory). Open string kind. */
@Serializable
data class MaintenanceUnavailable(
    val kind: String,
    val reason: String,
)

/** `maintenance.inventory` result. Items are ordered by (kind, id) from Core. */
@Serializable
data class MaintenanceInventoryResult(
    val items: List<MaintenanceItem>,
    val truncated: Boolean,
    val unavailable: List<MaintenanceUnavailable> = emptyList(),
)

/** The confirmed item set of a `maintenance.cleanup` confirmation (§3.9, not `{name, id}`). */
@Serializable
data class MaintenanceTarget(
    val items: List<String>,
)

/** Step-1 answer of `maintenance.cleanup` (the §2 confirmation shape). */
@Serializable
data class MaintenanceConfirmation(
    /** Single-use, 64 lowercase hex; never printed, logged or persisted by this client. */
    val token: String,
    @SerialName("expiresAt") val expiresAt: String,
    val action: String,
    val target: MaintenanceTarget,
    val impact: List<String>,
    /** Always false for A9 (Core-created state only). */
    val external: Boolean,
)

/** An item step 2 did not remove, with Core's reason. */
@Serializable
data class MaintenanceSkipped(
    val id: String,
    val reason: String,
)

/** `maintenance.cleanup` result: exactly ONE of `confirmation` (step 1) or the step-2 outcome. */
@Serializable
data class MaintenanceCleanupResult(
    val confirmation: MaintenanceConfirmation? = null,
    val removed: List<String>? = null,
    val skipped: List<MaintenanceSkipped>? = null,
    @SerialName("freedBytes") val freedBytes: Long? = null,
    val notes: List<String> = emptyList(),
)

// ---------------------------------------------------------------------------
// Copy (cross-client wording; plain text only)
// ---------------------------------------------------------------------------

/** Client-side mirrors of Core's cleanup bounds (design §3.9 item 1); Core re-validates. */
object MaintenanceGuards {
    /** Core's `MAX_CLEANUP_ITEMS`. */
    const val MAX_CLEANUP_ITEMS: Int = 500
}

/** Cross-client copy for a CONFLICT from either maintenance method (client brief, §9 step 2). */
const val MAINTENANCE_CONFLICT_TITLE: String =
    "Another maintenance scan or cleanup is running; try again shortly"

/** Cross-client copy for a lost step-2 answer or a token refusal after one (§3.9 item 7). */
const val MAINTENANCE_LOST_STEP2_TITLE: String = "Some items may have been removed — scan again"

/** Binary-prefixed size, or null when Core did not measure one. */
fun maintenanceSizeText(item: MaintenanceItem): String? {
    val bytes = item.bytes ?: return null
    var value = bytes.toDouble()
    var unit = "B"
    for (next in listOf("KiB", "MiB", "GiB", "TiB")) {
        if (value < 1024) break
        value /= 1024
        unit = next
    }
    val text = if (bytes < 1024) "$bytes B"
    else "${if (value >= 10) Math.round(value) else Math.round(value * 10) / 10} $unit"
    return if (item.sizeIncomplete == true) "$text (incomplete measurement)" else text
}

/**
 * Step-2 outcome headline (honesty, §3.9 item 7.5): never "everything was cleaned" when something
 * was skipped. Freed bytes are file-system removals only (never `verificationOutput`).
 */
fun maintenanceOutcomeHeadline(result: MaintenanceCleanupResult, confirmedCount: Int): String {
    val removed = result.removed?.size ?: 0
    val skipped = result.skipped?.size ?: 0
    return if (confirmedCount > 0 && removed == confirmedCount && skipped == 0) {
        "Removed all $confirmedCount confirmed item${if (confirmedCount == 1) "" else "s"}."
    } else {
        "Removed $removed of $confirmedCount confirmed item${if (confirmedCount == 1) "" else "s"}" +
            "${if (skipped > 0) "; $skipped were not removed" else ""}."
    }
}
