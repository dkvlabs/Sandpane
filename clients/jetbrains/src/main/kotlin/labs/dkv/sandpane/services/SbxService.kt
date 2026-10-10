package labs.dkv.sandpane.services

import com.intellij.openapi.project.Project
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.core.CoreValidationException
import labs.dkv.sandpane.core.ErrorAttribution
import labs.dkv.sandpane.core.KeyedCall
import labs.dkv.sandpane.core.KeyedRequests
import labs.dkv.sandpane.core.KeyedWrites
import labs.dkv.sandpane.core.ProjectGuards
import labs.dkv.sandpane.core.ProjectOutcomes
import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.model.ConversationCreateParams
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.Project as SandpaneProject
import labs.dkv.sandpane.model.ProjectCreateParams
import labs.dkv.sandpane.model.SandboxCreateSpec
import labs.dkv.sandpane.model.SandboxStopResult
import labs.dkv.sandpane.model.SandboxSummary
import labs.dkv.sandpane.model.SbxAgents
import labs.dkv.sandpane.settings.SandpaneSettings
import labs.dkv.sandpane.text.VisibleText
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Typed, thin wrapper over the project/sandbox RPCs plus a NON-authoritative snapshot.
 *
 * The snapshot is explicitly last-probed data (`SandboxSummary.probedState` is documented as
 * "last probed state, never assumed"): it is stamped with the time it was taken so the UI can
 * say how stale it is, and a refresh replaces it wholesale from Core. Nothing here is a
 * client-side database (AGENTS.md rule 2), and every mutating call is followed by a re-probe
 * rather than an optimistic local write (docs/specs/02 §5).
 *
 * [SbxClientValidation] mirrors the JSON-schema guards so a bad value is refused before a
 * round trip. It is a convenience mirror, NOT a substitute for `sandpane_core::validation`,
 * which is the gate that actually protects the CLI argument vectors.
 */
class SbxService(private val project: Project) {

    /** Last successful or failed probe. A null list means "never fetched", not "empty". */
    data class Snapshot(
        val projects: List<SandpaneProject>?,
        val sandboxes: List<SandboxSummary>?,
        val probedAtMillis: Long,
        val failure: String?,
        /** A3a: true only when [projects] came from `project.list {includeArchived:true}`. */
        val archivedIncluded: Boolean = false,
    ) {
        val isEmpty: Boolean get() = projects.isNullOrEmpty() && sandboxes.isNullOrEmpty()

        /**
         * Why [sandboxes] is unavailable, or null when Core's list is present. A failed refresh is
         * named with its reason (revealed single-line) instead of being worded as "not read yet".
         */
        fun sandboxListGap(): String? = when {
            sandboxes != null -> null
            failure != null -> "the last refresh failed: ${VisibleText.reveal(failure)}"
            else -> "Core's sandbox list has not been read in this window yet"
        }

        fun ageSeconds(nowMillis: Long = System.currentTimeMillis()): Long =
            if (probedAtMillis <= 0) Long.MAX_VALUE else (nowMillis - probedAtMillis) / 1_000

        fun describeAge(nowMillis: Long = System.currentTimeMillis()): String {
            val seconds = ageSeconds(nowMillis)
            return when {
                seconds == Long.MAX_VALUE -> "never probed"
                seconds < 60 -> "probed ${seconds}s ago"
                seconds < 3_600 -> "probed ${seconds / 60}m ago"
                else -> "probed ${seconds / 3_600}h ago"
            }
        }
    }

    fun interface SnapshotListener {
        /** Invoked on a background thread; the UI must hop to the EDT itself. */
        fun onSnapshot(snapshot: Snapshot)
    }

    @Volatile
    private var snapshot: Snapshot = Snapshot(null, null, 0, null)

    private val listeners = CopyOnWriteArrayList<SnapshotListener>()

    private val connection: ConnectionManager get() = ConnectionManager.instance()

    fun currentSnapshot(): Snapshot = snapshot

    /** @return a remover. */
    fun addSnapshotListener(listener: SnapshotListener): () -> Unit {
        listeners.add(listener)
        listener.onSnapshot(snapshot)
        return { listeners.remove(listener) }
    }

    // -----------------------------------------------------------------------
    // read-only paths (JB0 / JB1)
    // -----------------------------------------------------------------------

    /**
     * `project.list`: `{}` (live projects only), or `{"includeArchived":true}` — which
     * [labs.dkv.sandpane.core.CoreCommands.projectList] sends only when Core advertises the A3a
     * methods, since a pre-A3a Core would silently ignore the flag.
     */
    fun listProjects(includeArchived: Boolean = false): CompletableFuture<List<SandpaneProject>> =
        connection.commands.projectList(includeArchived)

    /** Can this Core list archived projects at all (A3a advertised)? */
    fun canListArchived(): Boolean = connection.commands.advertises(CoreMethods.PROJECT_ARCHIVE)

    fun listSandboxes(): CompletableFuture<List<SandboxSummary>> =
        connection.call(
            CoreMethods.SANDBOX_LIST,
            buildJsonObject { },
            ListSerializer(SandboxSummary.serializer()),
        )

    /**
     * Re-probe projects and sandboxes, then publish one consistent snapshot.
     *
     * A failure is published as `failure` text instead of being swallowed, so the tool window
     * shows the real state rather than a stale list pretending to be current (AGENTS.md
     * rule 5). Both RPCs are issued from this single background task, never from the EDT.
     */
    fun refresh(includeArchivedOverride: Boolean = false): CompletableFuture<Snapshot> {
        val started = System.currentTimeMillis()
        // The "show archived" view setting, or an unknown-outcome re-read (which must find the project
        // wherever it ended up) — and never on a Core that cannot honour it.
        val includeArchived = (includeArchivedOverride || SandpaneSettings.instance().showArchivedProjects) && canListArchived()
        // NOTE: this blocks on two futures from inside an io-pool task. That is safe ONLY
        // because ConnectionManager uses an elastic cached thread pool; if that pool ever
        // becomes fixed-size, replace the blocking .get() calls with a composed future.
        return connection.background("sandbox.refresh") {
            val projects = runCatching { listProjects(includeArchived).get() }
            val sandboxes = runCatching { listSandboxes().get() }
            val problems = listOfNotNull(
                projects.exceptionOrNull()?.let { ErrorAttribution.describe(CoreMethods.PROJECT_LIST, it) },
                sandboxes.exceptionOrNull()?.let { ErrorAttribution.describe(CoreMethods.SANDBOX_LIST, it) },
            )
            val next = Snapshot(
                projects = projects.getOrNull(),
                sandboxes = sandboxes.getOrNull(),
                probedAtMillis = if (problems.isEmpty()) System.currentTimeMillis() else started,
                failure = problems.takeIf { it.isNotEmpty() }?.joinToString("; "),
                archivedIncluded = includeArchived && projects.isSuccess,
            )
            snapshot = next
            listeners.forEach { runCatching { it.onSnapshot(next) } }
            next
        }
    }

    /** Sandboxes bound to a project, using Core's own `boundProjectId`. */
    fun sandboxesFor(projectId: String?): List<SandboxSummary> =
        if (projectId == null) emptyList()
        else snapshot.sandboxes.orEmpty().filter { it.boundProjectId == projectId }

    // -----------------------------------------------------------------------
    // folder → Core project (protocol-v1 `project.list.repositories`)
    // -----------------------------------------------------------------------

    /**
     * Resolve which Core project, if any, this IDE folder belongs to — the answer `StartTaskAction`
     * needed and JB1 could not get, because `Project` used to carry no repository paths.
     *
     * The matching rules live in [FolderMatching] (pure, unit-tested); this only feeds it the
     * current snapshot. Canonicalizes BOTH sides, because Core stores what was registered and
     * resolves symlinks only at mount time.
     */
    fun associateFolder(folderPath: String?): FolderAssociation =
        FolderMatching.associate(currentSnapshot().projects, folderPath)

    /**
     * `conversation.list` for [projectId], or a failed [ConversationEnumeration] when this Core
     * does not advertise the method. Chat enumeration was impossible before the discovery
     * revision; the list is Core's, including its exclusion of archived conversations.
     */
    fun enumerateConversations(projectId: String): CompletableFuture<ConversationEnumeration> {
        if (!connection.commands.advertises(CoreMethods.CONVERSATION_LIST)) {
            return CompletableFuture.completedFuture(ConversationEnumeration.Unavailable)
        }
        return connection.listConversations(projectId)
            .thenApply<ConversationEnumeration> { ConversationEnumeration.Available(it) }
            .exceptionally { err ->
                // Attributed, not assumed: this can be a refusal this plugin raised before sending.
                ConversationEnumeration.Failed(ErrorAttribution.describe(err))
            }
    }

    /** Enumeration result as a value, so the UI never has to guess between empty and unknown. */
    sealed class ConversationEnumeration {
        data class Available(val conversations: List<Conversation>) : ConversationEnumeration()

        /** Core does not advertise `conversation.list` — nothing was asked, nothing is claimed. */
        data object Unavailable : ConversationEnumeration()

        /**
         * The read did not produce a list. `reason` names who refused — Core with its code and its
         * own wording, or this plugin before a byte was sent — as [ErrorAttribution] puts it.
         */
        data class Failed(val reason: String) : ConversationEnumeration()

        val conversationsOrEmpty: List<Conversation>
            get() = (this as? Available)?.conversations ?: emptyList()

        fun explain(): String = when (this) {
            is Available -> "${conversations.size} conversation(s) Core reports for this project"
            Unavailable -> "Chat enumeration is unavailable on this Core (no fake list is shown)."
            is Failed -> "${CoreMethods.CONVERSATION_LIST} — $reason"
        }
    }

    // -----------------------------------------------------------------------
    // mutating paths — JB1 wires these to confirmed actions; nothing calls them implicitly
    // -----------------------------------------------------------------------

    fun createProject(name: String, repositories: List<String>): CompletableFuture<SandpaneProject> {
        SbxClientValidation.requireProjectName(name)
        repositories.forEach { SbxClientValidation.requireAbsolutePath(it, "repository path") }
        return connection.call(
            CoreMethods.PROJECT_CREATE,
            CoreJson.encodeToJsonElement(
                ProjectCreateParams.serializer(),
                ProjectCreateParams(name = name, repositories = repositories),
            ),
            SandpaneProject.serializer(),
        ).also { afterMutation(it) }
    }

    /**
     * `direct_mount` is live-writable and every surface rendering the result must label it as
     * such (docs/specs/02 §7); this method only refuses an invalid spec.
     *
     * One call = one user action (A2): the agent is honoured only when Core advertises
     * `sandbox-create-agent` (otherwise refused locally — never silently ignored), and a fresh
     * idempotency key is attached only when Core advertises `idempotency-keys`. A `replayed: true`
     * answer is Core's stored earlier result, not current state: [KeyedWrites.replayNotice] words it
     * and the post-call re-probe re-reads `sandbox.list`. No UI calls this yet.
     */
    fun createSandbox(spec: SandboxCreateSpec): KeyedCall<SandboxCreateSpec, SandboxSummary> =
        dispatchCreate(spec, KeyedRequests.newCreate(spec, connection.capabilities))

    /** A2 "Retry safely" of an unknown-outcome create: identical spec, same key, explicit only. */
    fun retryCreateSafely(previous: SandboxCreateSpec): KeyedCall<SandboxCreateSpec, SandboxSummary> =
        dispatchCreate(previous, KeyedRequests.retryCreate(previous, connection.capabilities))

    private fun dispatchCreate(
        original: SandboxCreateSpec,
        prepared: KeyedRequests.Prepared<SandboxCreateSpec>,
    ): KeyedCall<SandboxCreateSpec, SandboxSummary> {
        val spec = when (prepared) {
            is KeyedRequests.Prepared.Refused -> return KeyedCall(
                original,
                null,
                CompletableFuture.failedFuture(CoreValidationException("sandbox.create", prepared.reason)),
            )
            is KeyedRequests.Prepared.Ready -> prepared.params
        }
        SbxClientValidation.requireSandboxName(spec.name)
        SbxClientValidation.requireOpaqueId(spec.projectId, "projectId")
        spec.repoPath?.let { SbxClientValidation.requireAbsolutePath(it, "repoPath") }
        // A1: absent stays absent (Core defaults to the provider-free `shell`); a present value must
        // be an exact built-in sbx agent — nothing outside the allowlist is ever sent.
        spec.agent?.let { SbxClientValidation.requireSbxAgent(it) }
        val future = connection.callJson(
            CoreMethods.SANDBOX_CREATE,
            CoreJson.encodeToJsonElement(SandboxCreateSpec.serializer(), spec),
        ).thenApply(KeyedWrites::decodeCreateAnswer).also { afterMutation(it) }
        return KeyedCall(spec, spec.idempotencyKey, future)
    }

    /**
     * `sandbox.stop` (A1) for an explicit user choice, followed by a re-probe whatever the outcome —
     * the result's `requeried` is Core's word for the state, and the list must not keep showing the
     * pre-stop row. Never retried here: a missing answer is "outcome unknown" ([labs.dkv.sandpane.core.StopReport]).
     */
    fun stopSandbox(name: String): CompletableFuture<SandboxStopResult> =
        connection.commands.sandboxStop(name).also { afterMutation(it) }

    /** Creating a conversation mutates Core state; called only from an explicit user action. */
    fun createConversation(params: ConversationCreateParams): CompletableFuture<Conversation> {
        SbxClientValidation.requireOpaqueId(params.projectId, "projectId")
        SbxClientValidation.requireOpaqueId(params.agentId, "agentId")
        return connection.call(
            CoreMethods.CONVERSATION_CREATE,
            CoreJson.encodeToJsonElement(ConversationCreateParams.serializer(), params),
            Conversation.serializer(),
        )
    }

    // -----------------------------------------------------------------------
    // project lifecycle (A3a) — explicit user actions only; every one re-reads project.list
    // -----------------------------------------------------------------------

    fun updateProject(projectId: String, name: String?, description: String?): CompletableFuture<SandpaneProject> =
        afterProjectMutation(connection.commands.projectUpdate(projectId, name, description))

    fun archiveProject(projectId: String): CompletableFuture<SandpaneProject> =
        afterProjectMutation(connection.commands.projectArchive(projectId))

    fun unarchiveProject(projectId: String): CompletableFuture<SandpaneProject> =
        afterProjectMutation(connection.commands.projectUnarchive(projectId))

    fun addRepository(projectId: String, path: String): CompletableFuture<SandpaneProject> =
        afterProjectMutation(connection.commands.projectAddRepository(projectId, path))

    fun removeRepository(projectId: String, path: String): CompletableFuture<SandpaneProject> =
        afterProjectMutation(connection.commands.projectRemoveRepository(projectId, path))

    /**
     * Re-read `project.list` after every project mutation whatever the outcome; an UNKNOWN outcome
     * re-reads with archived projects included ([ProjectOutcomes.isUnknown]).
     */
    private fun afterProjectMutation(call: CompletableFuture<SandpaneProject>): CompletableFuture<SandpaneProject> {
        call.whenComplete { _, error -> refresh(includeArchivedOverride = error != null && ProjectOutcomes.isUnknown(error)) }
        return call
    }

    fun interface ProjectDeletedListener {
        /** Invoked on a background thread after Core confirmed `deleted: true` for [projectId]. */
        fun onProjectDeleted(projectId: String)
    }

    private val deletedListeners = CopyOnWriteArrayList<ProjectDeletedListener>()

    /** @return a remover. */
    fun addProjectDeletedListener(listener: ProjectDeletedListener): () -> Unit {
        deletedListeners.add(listener)
        return { deletedListeners.remove(listener) }
    }

    /**
     * Core says the project is gone — `deleted: true`, a step-2 NOT_FOUND, or (after an unknown
     * outcome) a successful re-read with archived projects that no longer lists it: tell every window
     * to drop its in-memory state for that project (selection, tracked tasks). Nothing is persisted
     * per project by this plugin (see [SandpaneSettings]), so there is nothing on disk to clear.
     */
    fun forgetProject(projectId: String) {
        deletedListeners.forEach { runCatching { it.onProjectDeleted(projectId) } }
    }

    /** [forgetProject], then re-read Core. */
    fun projectDeleted(projectId: String) {
        forgetProject(projectId)
        refresh()
    }

    /** Command success is not desired state: re-probe (docs/specs/02 §5). */
    private fun afterMutation(call: CompletableFuture<*>) {
        call.whenComplete { _, _ -> refresh() }
    }

    companion object {
        fun instance(project: Project): SbxService = project.getService(SbxService::class.java)
    }
}

/**
 * Client-side mirrors of the JSON-Schema guards under `schemas/`: fast, honest refusals.
 * (Note the wording: a literal glob here would open a nested block comment, which is why
 * this doc does not spell one.)
 *
 * These never replace Core validation and never build a command. A value that passes here is
 * only ever placed into a JSON payload for an allowlisted RPC method; the argument vectors
 * are constructed in Core behind `sandpane_core::validation` (AGENTS.md rule 2).
 */
object SbxClientValidation {

    /**
     * schemas/sandbox-create-spec.schema.json `name` pattern, including the no-`--`
     * option-smuggling guard. Keep in sync with the schema (AGENTS.md rule 8).
     */
    private val SANDBOX_NAME: Regex = Regex("^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$")

    private const val SANDBOX_NAME_MAX = 63
    private const val OPAQUE_ID_MAX = 128

    fun isSandboxNameValid(name: String): Boolean =
        name.length in 1..SANDBOX_NAME_MAX && SANDBOX_NAME.matches(name)

    fun requireSandboxName(name: String) {
        if (!isSandboxNameValid(name)) {
            throw IllegalArgumentException(
                "sandbox name '${truncate(name)}' violates the schema pattern (lowercase alphanumerics, " +
                    "single hyphens, alphanumeric ends, no '--', max $SANDBOX_NAME_MAX characters)",
            )
        }
    }

    /**
     * `Validator::project_name` exactly (A3a review: never stricter, never looser) — no trimming,
     * because Core does not trim either. See [ProjectGuards.nameProblem].
     */
    fun requireProjectName(name: String) {
        ProjectGuards.nameProblem(name)?.let { throw IllegalArgumentException("project name: $it") }
    }

    /** `SandboxCreateSpec.agent` must be an exact built-in sbx v0.47 agent ([SbxAgents.V0_47]). */
    fun requireSbxAgent(agent: String) {
        if (!SbxAgents.isAllowlisted(agent)) {
            throw IllegalArgumentException(
                "agent '${truncate(agent)}' is not a built-in sbx v0.47 agent (allowed: " +
                    "${SbxAgents.V0_47.joinToString(", ")}); sandbox-kit references are never sent",
            )
        }
    }

    fun requireOpaqueId(value: String, field: String) {
        if (value.isBlank() || value.length > OPAQUE_ID_MAX || value.any { it.code < 0x20 }) {
            throw IllegalArgumentException("$field must be a non-blank id of at most $OPAQUE_ID_MAX characters")
        }
    }

    /**
     * Paths are data: absolute, no NUL byte, and never spliced into a shell. This module
     * contains no subprocess call at all, so there is nothing here to interpolate.
     */
    fun requireAbsolutePath(path: String, field: String) {
        if (path.isBlank() || !File(path).isAbsolute) {
            throw IllegalArgumentException("$field must be an absolute host path, got '${truncate(path)}'")
        }
        if (path.any { it.code == 0 || it.code < 0x20 }) {
            throw IllegalArgumentException("$field contains control characters")
        }
    }

    private fun truncate(value: String): String =
        if (value.length <= 48) value else value.take(48) + "…"
}
