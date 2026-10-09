// Presentation projection of `SandboxSummary.workspaceMode`.
//
// This file maps a wire ENUM VALUE to a label. It computes no state transition and holds no
// authority (AGENTS.md rule 3): the mode is whatever Core recorded in its newest
// `sandbox_bindings` row, and `probedState` is SBX's separately probed truth.
//
// The honesty rule this exists to enforce (docs/specs/02 §7, docs/specs/04 §3): a
// `direct_mount` mount is LIVE-WRITABLE and must be labeled as such on every surface. When Core
// reports no mode at all — it never guesses one — the surface must show UNVERIFIED and assume
// the worst case, never a neutral "safe" look.
package labs.dkv.sandpane.model

/** Tone a UI uses to pick colours/emphasis; the wording itself is the deliverable. */
enum class WorkspaceModeTone { LIVE_WRITABLE, ISOLATED, SCRATCH, UNKNOWN }

/**
 * One rendered workspace-mode claim.
 *
 * @param label human-readable name of the mode (or of its absence).
 * @param badge the short, loud qualifier a picker/status bar shows.
 * @param explanation why the badge says that, in the user's terms.
 * @param hostWritable whether edits inside the sandbox are already on the host. This is the
 *   field a confirm-before-write flow must read, so an UNKNOWN mode sets it to `true`: treating
 *   an unverifiable mount as read-only would be the false promise.
 */
data class WorkspaceModeView(
    val label: String,
    val badge: String,
    val explanation: String,
    val hostWritable: Boolean,
    val tone: WorkspaceModeTone,
) {
    companion object {

        /**
         * The four modes Core can name, from the wire value Core recorded.
         *
         * `sbx_clone`/`host_worktree`/`mountless` are labelled as what the RECORD claims; the
         * record is not a live SBX verification, which is why none of them says "verified".
         */
        private fun forMode(mode: WorkspaceMode): WorkspaceModeView = when (mode) {
            WorkspaceMode.DIRECT_MOUNT -> WorkspaceModeView(
                label = "Direct mount",
                badge = "LIVE-WRITABLE",
                explanation =
                    "Core records this sandbox as mounting the host tree directly, so agent edits land " +
                        "on these files immediately — review cannot retroactively block them.",
                hostWritable = true,
                tone = WorkspaceModeTone.LIVE_WRITABLE,
            )

            WorkspaceMode.SBX_CLONE -> WorkspaceModeView(
                label = "SBX clone",
                badge = "ISOLATED (clone)",
                explanation =
                    "Core records an isolated clone inside the sandbox. The host tree is not the mount, " +
                        "so changes come back as a change set to review and apply.",
                hostWritable = false,
                tone = WorkspaceModeTone.ISOLATED,
            )

            WorkspaceMode.HOST_WORKTREE -> WorkspaceModeView(
                label = "Host worktree",
                badge = "ISOLATED (host dir)",
                explanation =
                    "Core records a separate host directory and branch. Isolation holds only while the " +
                        "mount and the sandbox really point at that worktree; otherwise this behaves " +
                        "like a direct mount on the wrong tree.",
                hostWritable = false,
                tone = WorkspaceModeTone.ISOLATED,
            )

            WorkspaceMode.MOUNTLESS -> WorkspaceModeView(
                label = "Mountless",
                badge = "NO HOST ACCESS",
                explanation =
                    "Core records scratch execution with no automatic access to the host project: " +
                        "nothing is written to these files, and there is nothing to review host-side.",
                hostWritable = false,
                tone = WorkspaceModeTone.SCRATCH,
            )
        }

        /**
         * Core returned NO readable `sandbox_bindings` row for this name.
         *
         * Rendered with the loud tone on purpose: an unverified mount that turns out to be
         * `direct_mount` is host-writable, so absence is assumed to be the worst case until Core
         * can say otherwise. Never silently become `mountless` or `sbx_clone`.
         */
        fun unverified(): WorkspaceModeView = WorkspaceModeView(
            label = "Workspace mode unverified",
            badge = "UNVERIFIED — TREAT AS LIVE-WRITABLE",
            explanation =
                "Core has no readable sandbox_bindings row for this sandbox, so its workspace mode is " +
                    "unknown — Core never guesses one. A direct_mount mount writes straight through to " +
                    "these host files, so an unverified binding is treated as live-writable until " +
                    "verified.",
            hostWritable = true,
            tone = WorkspaceModeTone.UNKNOWN,
        )

        /**
         * Core named a mode this plugin build does not know (a newer Core added an enum value).
         *
         * Same worst-case rule as absence: unidentified ⇒ assume host-writable rather than
         * promising isolation the wire never claimed.
         */
        fun unknown(rawName: String): WorkspaceModeView = WorkspaceModeView(
            label = "Unknown workspace mode \"$rawName\"",
            badge = "UNKNOWN — TREAT AS LIVE-WRITABLE",
            explanation =
                "Core reported a workspace mode this plugin build does not define. Until it is " +
                    "identified, the worst case is assumed rather than promising isolation.",
            hostWritable = true,
            tone = WorkspaceModeTone.UNKNOWN,
        )

        /**
         * The view for one sandbox summary: the recorded mode when Core sent one, [unverified]
         * when the field was absent.
         *
         * kotlinx maps a null to [WorkspaceMode]? = null, and an unrecognized string fails
         * decoding upstream — so the only two states here are a known mode and absence.
         */
        fun forSandbox(summary: SandboxSummary): WorkspaceModeView =
            summary.workspaceMode?.let(::forMode) ?: unverified()

        /** One-line form for a crowded picker row. */
        fun labelFor(summary: SandboxSummary): String = forSandbox(summary).let {
            if (it.tone == WorkspaceModeTone.UNKNOWN) it.label else "${it.label} · ${it.badge}"
        }
    }
}
