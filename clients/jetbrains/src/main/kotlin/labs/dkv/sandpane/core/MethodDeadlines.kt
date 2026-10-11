package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.CoreMethods

/**
 * Per-method read deadlines: how long this client waits for Core's answer to one request.
 *
 * Most methods answer within the user's configured request timeout (default 15 s, settings cap
 * 120 s). The A1 sandbox-lifecycle methods do not. Core's worst case, from its own sbx limits:
 *  - `sandbox.stop`: `sbx stop` (~300 s mutation bound) + the `ls --json` re-query (~30 s) ≈ 330 s;
 *  - `sandbox.remove` step 2: the `ls --json` identity check (~30 s) + `sbx rm --force` (~300 s) +
 *    the post-rm re-query (~30 s) ≈ 360 s (step 1 is one ~30 s query).
 * The 360 s / 400 s values below are CLIENT floors with margin over those figures — not Core
 * constants. `ProtocolDriftGuardTest` reads Core's `RunLimits::QUERY`/`MUTATION` (30 s / 300 s) and
 * fails if a floor stops outlasting the worst case. Waiting only the default
 * would report "no answer" for an operation still running in Core, and the late answer would then be
 * dropped as uncorrelated. A user setting larger than a floor still wins.
 *
 * Every layer that waits applies the SAME function — [CoreClient.request]'s `orTimeout`, the
 * blocking `get`s in [CoreClient], and [ConnectionManager.call] — because the shortest layer is the
 * one that fires. A timeout is reported as "outcome unknown", never retried (stop and remove are
 * not replay-safe).
 */
object MethodDeadlines {

    /** `sandbox.stop` floor: Core's stop + re-query worst case ≈ 300 + 30 s, plus margin. */
    const val SANDBOX_STOP_MS: Int = 360_000

    /** `sandbox.remove` floor: step 2 worst case ≈ 30 + 300 + 30 s, plus margin (both steps share it). */
    const val SANDBOX_REMOVE_MS: Int = 400_000

    /**
     * `project.add_repository` floor (A3a): Core resolves the folder with one QUERY-class
     * `git rev-parse --show-toplevel` (≈ 30 s worst case) before a short DB write; plus margin.
     */
    const val PROJECT_ADD_REPOSITORY_MS: Int = 45_000

    /**
     * `git.review` / `git.diff` (A5): Core runs QUERY-bounded git (30 s per run; one call may run
     * git several times). The 45 s git deadline from A3a W2; a timeout is "no answer in time" — both
     * are read-only, so nothing changed.
     */
    const val GIT_REVIEW_MS: Int = 45_000
    const val GIT_DIFF_MS: Int = 45_000

    /** The deadline for [method] given the user's [configuredMs]; never shorter than [configuredMs]. */
    fun forMethod(method: String, configuredMs: Int): Int = when (method) {
        CoreMethods.SANDBOX_STOP -> maxOf(configuredMs, SANDBOX_STOP_MS)
        CoreMethods.SANDBOX_REMOVE -> maxOf(configuredMs, SANDBOX_REMOVE_MS)
        CoreMethods.PROJECT_ADD_REPOSITORY -> maxOf(configuredMs, PROJECT_ADD_REPOSITORY_MS)
        CoreMethods.GIT_REVIEW -> maxOf(configuredMs, GIT_REVIEW_MS)
        CoreMethods.GIT_DIFF -> maxOf(configuredMs, GIT_DIFF_MS)
        else -> configuredMs
    }
}
