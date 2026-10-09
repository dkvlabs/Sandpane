package labs.dkv.sandpane.services

import com.intellij.openapi.project.Project
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.core.ErrorAttribution
import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.model.ConversationCreateParams
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.Project as SandpaneProject
import labs.dkv.sandpane.model.ProjectCreateParams
import labs.dkv.sandpane.model.SandboxCreateSpec
import labs.dkv.sandpane.model.SandboxSummary
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
    ) {
        val isEmpty: Boolean get() = projects.isNullOrEmpty() && sandboxes.isNullOrEmpty()

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

    fun listProjects(): CompletableFuture<List<SandpaneProject>> =
        connection.call(
            CoreMethods.PROJECT_LIST,
            buildJsonObject { },
            ListSerializer(SandpaneProject.serializer()),
        )

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
    fun refresh(): CompletableFuture<Snapshot> {
        val started = System.currentTimeMillis()
        // NOTE: this blocks on two futures from inside an io-pool task. That is safe ONLY
        // because ConnectionManager uses an elastic cached thread pool; if that pool ever
        // becomes fixed-size, replace the blocking .get() calls with a composed future.
        return connection.background("sandbox.refresh") {
            val projects = runCatching { listProjects().get() }
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
     */
    fun createSandbox(spec: SandboxCreateSpec): CompletableFuture<SandboxSummary> {
        SbxClientValidation.requireSandboxName(spec.name)
        SbxClientValidation.requireOpaqueId(spec.projectId, "projectId")
        spec.repoPath?.let { SbxClientValidation.requireAbsolutePath(it, "repoPath") }
        return connection.call(
            CoreMethods.SANDBOX_CREATE,
            CoreJson.encodeToJsonElement(SandboxCreateSpec.serializer(), spec),
            SandboxSummary.serializer(),
        ).also { afterMutation(it) }
    }

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
    private const val PROJECT_NAME_MAX = 200
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

    fun requireProjectName(name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty() || trimmed.length > PROJECT_NAME_MAX) {
            throw IllegalArgumentException("project name must be 1..$PROJECT_NAME_MAX characters")
        }
        // A name is a label, never a path or an argument: refuse control characters outright.
        if (trimmed.any { it.code < 0x20 }) {
            throw IllegalArgumentException("project name contains control characters")
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
