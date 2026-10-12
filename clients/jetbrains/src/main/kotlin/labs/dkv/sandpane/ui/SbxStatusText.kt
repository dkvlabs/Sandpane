package labs.dkv.sandpane.ui

import labs.dkv.sandpane.model.SbxStatus
import labs.dkv.sandpane.text.VisibleText

/**
 * A8a (design 2026-10-09 §3.8 item 1; security review W2): the plain-text lines that describe Core's `system.probe`
 * sbx status. Pure, so the exact wording is unit-tested; callers put the lines into an escaped
 * plain-text surface (the refresh notification goes through `notify`, which escapes).
 *
 * Wording rules:
 *  - a running daemon is only "running", never "ready"/"healthy": the captured errors show a running
 *    daemon can still be unusable (not signed in, policy not initialised);
 *  - `execVerified` / `versionCaptured` absent ⇒ no line at all (an older Core, or an unknown
 *    version, does not say — absent is never rendered as "no");
 *  - the captured line is a statement about evidence, never a support claim, so callers must not
 *    give it a success tone.
 *
 * There is deliberately nothing here (or anywhere in this plugin) that starts or stops the sbx
 * daemon: that is a machine-wide setting the user changes with the sbx CLI.
 */
object SbxStatusText {

    // "(at last check)": the daemon state is Core's `system.probe` reading from the connection
    // handshake, not from the refresh. A later `sandbox.list` runs `sbx ls`, which sbx 0.47.0 was
    // captured auto-starting the daemon, so the reading may be stale by the time it is shown.
    const val DAEMON_RUNNING: String = "SBX daemon running (at last check)"
    const val DAEMON_STOPPED: String = "SBX daemon stopped (at last check)"
    const val DAEMON_UNKNOWN: String = "SBX daemon state unknown"

    /** Appended after the sbx lines of the refresh notification, whose title says "refreshed · <age>". */
    const val FROM_CONNECTION_CHECK: String = "SBX status is from the connection check, not this refresh"

    const val EXEC_ENABLED: String = "Verification runs are enabled for this sbx version"
    const val EXEC_NOT_ENABLED: String = "Verification runs are not enabled for this sbx version"

    const val CAPTURED_PREFIX: String =
        "Same sbx version number as Sandpane's captured fixtures (macOS; build not compared)"

    /** `daemonRunning`: true / false / null-or-absent. */
    fun daemon(daemonRunning: Boolean?): String = when (daemonRunning) {
        true -> DAEMON_RUNNING
        false -> DAEMON_STOPPED
        null -> DAEMON_UNKNOWN
    }

    /** `execVerified`: a line only when Core sent the field. */
    fun exec(execVerified: Boolean?): String? = when (execVerified) {
        true -> EXEC_ENABLED
        false -> EXEC_NOT_ENABLED
        null -> null
    }

    /** `versionCaptured`: a line only when Core sent the field. */
    fun captured(versionCaptured: Boolean?): String? = when (versionCaptured) {
        true -> "$CAPTURED_PREFIX: yes"
        false -> "$CAPTURED_PREFIX: no"
        null -> null
    }

    /**
     * The status lines that follow the "SBX: installed …" / "SBX: NOT INSTALLED …" headline.
     *
     * The daemon line is shown only when sbx is installed: with no sbx binary there is no daemon to
     * describe, and Core reports no daemon state then. The exec/captured lines follow Core — Core
     * omits them when sbx is not installed — so they are shown whenever present.
     */
    fun lines(sbx: SbxStatus): List<String> = listOfNotNull(
        if (sbx.installed) daemon(sbx.daemonRunning) else null,
        exec(sbx.execVerified),
        captured(sbx.versionCaptured),
    )

    const val NOT_REPORTED: String = "SBX: not reported by this Core"
    const val NOT_INSTALLED: String =
        "SBX: NOT INSTALLED — sandbox features cannot work until the user installs Docker " +
            "Sandboxes separately (Sandpane bundles no sbx binary)"

    /**
     * Every sbx line of the "refreshed" notification (RefreshSandboxesAction): the headline, then
     * [lines], then [FROM_CONNECTION_CHECK] — the sbx status is the connect-time `system.probe`
     * reading, so it must not read as part of the fresh refresh data under the "refreshed · <age>"
     * title. [sbx] null = this Core reported no sbx status at all. The version string is Core's,
     * shown single-line with hidden characters revealed.
     */
    fun refreshLines(sbx: SbxStatus?, coreProjectCount: Int): List<String> = when {
        sbx == null -> listOf(NOT_REPORTED)
        sbx.installed -> listOf(
            "SBX: installed ${sbx.version?.let { "(${VisibleText.reveal(it)})" } ?: "(version not probed)"}" +
                "; $coreProjectCount project(s) in Core",
        ) + lines(sbx) + FROM_CONNECTION_CHECK

        else -> listOf(NOT_INSTALLED) + lines(sbx) + FROM_CONNECTION_CHECK
    }
}
