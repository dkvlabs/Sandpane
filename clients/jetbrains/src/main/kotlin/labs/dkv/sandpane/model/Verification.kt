// A7 wire types: verification commands + `project.context` (design 2026-10-09 §3.7).
//
// MIRROR OF: the A7 section of core/crates/sandpane-protocol/src/lib.rs (field order included,
// pinned by ProtocolDriftGuardTest) and schemas/verification.schema.json /
// schemas/project-context.schema.json.
//
// Decoding is TOLERANT of absence: every field Core may omit (or that an older/newer Core might not
// send) is nullable or defaulted, and the open strings (`outcome`, `workspaceMode` in a result, the
// `byKind` keys) stay plain strings, so an unknown value is shown as-is instead of failing the frame.
// Every string in these types that came from Core is UNTRUSTED display text (labels, argv, output,
// notes, sandbox names, repository paths): it is rendered revealed and capped, never as HTML,
// Markdown, a terminal or a link (§3.7 item 6).
package labs.dkv.sandpane.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** A user-approved exact argv (§3.7 item 1). Proven free of secret-shaped strings at approve. */
@Serializable
data class VerificationCommand(
    val id: String,
    @SerialName("projectId") val projectId: String? = null,
    val label: String = "",
    val argv: List<String> = emptyList(),
    @SerialName("approvedAt") val approvedAt: String? = null,
) {
    /** Output and argv are never logged; this keeps a debug print from carrying them. */
    override fun toString(): String = "VerificationCommand(id=$id, argv=${argv.size} element(s))"
}

/** `verification.list {projectId}`. */
@Serializable
data class VerificationListParams(@SerialName("projectId") val projectId: String)

/** `verification.list` result: live commands ordered by `approvedAt`. */
@Serializable
data class VerificationListResult(val commands: List<VerificationCommand> = emptyList())

/** `verification.approve {projectId, label, argv}`: the exact list the user confirmed. */
@Serializable
data class VerificationApproveParams(
    @SerialName("projectId") val projectId: String,
    val label: String,
    val argv: List<String>,
) {
    override fun toString(): String = "VerificationApproveParams(projectId=$projectId, argv=${argv.size} element(s))"
}

/** `verification.approve` result. A byte-equal live argv returns the EXISTING command, label unchanged. */
@Serializable
data class VerificationApproveResult(val command: VerificationCommand)

/** `verification.revoke {commandId}` (idempotent; allowed even on an archived project). */
@Serializable
data class VerificationRevokeParams(@SerialName("commandId") val commandId: String)

@Serializable
data class VerificationRevokeResult(val revoked: Boolean = false)

/**
 * `verification.run` params. Never argv, never a path: only an approved command can run. The two
 * `expected*` values are what the run dialog showed the user: [expectedSandboxName] is the task's
 * BINDING (`TaskSummary.sandboxName`, never the chat's chosen sandbox name, an A4 display-only field) and [expectedWorkspaceMode] the
 * `sandbox.list` mode of that name. Field order is Core's A2 fingerprint order; [idempotencyKey]
 * is omitted when null (`explicitNulls = false`).
 */
@Serializable
data class VerificationRunParams(
    @SerialName("taskId") val taskId: String,
    @SerialName("commandId") val commandId: String,
    @SerialName("expectedSandboxName") val expectedSandboxName: String,
    @SerialName("expectedWorkspaceMode") val expectedWorkspaceMode: WorkspaceMode,
    @SerialName("idempotencyKey") val idempotencyKey: String? = null,
)

/** `verification.run` result: the run STARTED (asynchronously). A keyed replay adds `replayed: true`. */
@Serializable
data class VerificationRunResult(
    @SerialName("runId") val runId: String,
    @SerialName("startedSequence") val startedSequence: Long? = null,
    val replayed: Boolean? = null,
)

/** `verification.result {runId}`. */
@Serializable
data class VerificationResultParams(@SerialName("runId") val runId: String)

/**
 * What best-effort redaction did to a run's stored output. `outputWithheld: true` = the redactor was
 * unavailable, so NO output was stored (never raw output).
 */
@Serializable
data class OutputRedaction(
    @SerialName("bestEffort") val bestEffort: Boolean? = null,
    val replacements: Long? = null,
    @SerialName("byKind") val byKind: Map<String, Long> = emptyMap(),
    @SerialName("outputWithheld") val outputWithheld: Boolean? = null,
)

/**
 * `verification.result`. [outcome] is an OPEN string (`running`, `exited`, `signaled`, `timed_out`,
 * `spawn_failed`, `read_failed`, `possibly_sbx_error`, `interrupted` today). [exitCode] is the exit
 * status of `sbx exec` (UNVERIFIED that it is the command's own, C-2). [stdout] / [stderr] are
 * capped, lossily decoded and redacted (best effort) before storage, and UNTRUSTED.
 */
@Serializable
data class VerificationResult(
    @SerialName("runId") val runId: String,
    @SerialName("taskId") val taskId: String? = null,
    @SerialName("commandId") val commandId: String? = null,
    val label: String = "",
    val argv: List<String> = emptyList(),
    val sandbox: String? = null,
    @SerialName("workspaceMode") val workspaceMode: String? = null,
    val outcome: String? = null,
    @SerialName("exitCode") val exitCode: Int? = null,
    val stdout: String = "",
    val stderr: String = "",
    @SerialName("stdoutTruncated") val stdoutTruncated: Boolean? = null,
    @SerialName("stderrTruncated") val stderrTruncated: Boolean? = null,
    val redactions: OutputRedaction? = null,
    @SerialName("elapsedMs") val elapsedMs: Long? = null,
    @SerialName("startedAt") val startedAt: String? = null,
    @SerialName("finishedAt") val finishedAt: String? = null,
    @SerialName("outputIncomplete") val outputIncomplete: Boolean? = null,
    /**
     * A9 (additive, §3.9 item 2): `maintenance.cleanup` removed this run's stored output. Takes
     * precedence over [stdoutTruncated] / [stderrTruncated] / [outputIncomplete] in rendering —
     * pruned output is not "truncated" output, so those flags are never shown beside it.
     */
    @SerialName("outputPruned") val outputPruned: Boolean? = null,
) {
    /** Output, argv and labels are never logged: a debug print shows sizes only. */
    override fun toString(): String =
        "VerificationResult(runId=$runId, outcome=$outcome, stdout=${stdout.length} chars, stderr=${stderr.length} chars)"
}

/** `project.context {projectId}`. */
@Serializable
data class ProjectContextParams(@SerialName("projectId") val projectId: String)

/** One detected root manifest. Suggestions and notes are UNTRUSTED display strings: never auto-approved or run. */
@Serializable
data class DetectedManifest(
    val manifest: String = "",
    @SerialName("suggestedCommands") val suggestedCommands: List<List<String>> = emptyList(),
    val notes: List<String> = emptyList(),
) {
    /** Counts only: the manifest name, argv and notes are untrusted and never logged. */
    override fun toString(): String =
        "DetectedManifest(${suggestedCommands.size} suggestion(s), ${notes.size} note(s))"
}

/** One registered repository's detection. `unreadable` names files nothing was taken from (`"."` = the root). */
@Serializable
data class RepositoryContext(
    @SerialName("repoPath") val repoPath: String = "",
    val detected: List<DetectedManifest> = emptyList(),
    val unreadable: List<String> = emptyList(),
) {
    /** Counts only: the repository path and file names are never logged. */
    override fun toString(): String =
        "RepositoryContext(${detected.size} manifest(s), ${unreadable.size} unreadable)"
}

/** `project.context` result; [approved] repeats `verification.list`. */
@Serializable
data class ProjectContextResult(
    val repositories: List<RepositoryContext> = emptyList(),
    val approved: List<VerificationCommand> = emptyList(),
) {
    override fun toString(): String =
        "ProjectContextResult(${repositories.size} repository(ies), ${approved.size} approved)"
}
