package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.ConversationHistoryResult
import labs.dkv.sandpane.model.DEFAULT_LIST_LIMIT
import labs.dkv.sandpane.model.MAX_CURSOR_KEY_LEN
import labs.dkv.sandpane.model.MAX_FRAME_BYTES
import labs.dkv.sandpane.model.MAX_HISTORY_BYTES
import labs.dkv.sandpane.model.MAX_LIST_LIMIT
import labs.dkv.sandpane.model.MAX_SCOPING_ID_LEN
import labs.dkv.sandpane.model.MAX_SUBSCRIBE_BYTES
import labs.dkv.sandpane.model.MAX_SUBSCRIBE_CURSORS
import labs.dkv.sandpane.model.PROTOCOL_VERSION
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.MAX_UNKNOWN_WIRE_NAME_LEN
import labs.dkv.sandpane.model.ReportedFileChangeStatusSerializer
import labs.dkv.sandpane.model.ReportedTaskStatusSerializer
import labs.dkv.sandpane.model.ReportedWorkspaceModeSerializer
import labs.dkv.sandpane.model.TaskStatus
import labs.dkv.sandpane.model.WorkspaceMode
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * THE drift gate for this client: it READS the Rust sources and the JSON schemas in this repo and
 * fails if the Kotlin mirror below them has gone stale (AGENTS.md rule 8 — protocol and client
 * types move together, or the build breaks here instead of shipping a silent desync).
 *
 * It is deliberately name-driven rather than a quoted copy of the protocol: the method list is
 * recovered from `Method::ALL` + `Method::as_str` in `sandpane-protocol/src/lib.rs`, and the
 * bounds from `pub const NAME: type = value;` in `sandpane-service/src/lib.rs`. Rename a method,
 * reorder `Method::ALL`, or change a limit in Rust and this test fails with a message pointing at
 * the Rust spelling — the same way `clients/vscode/test/protocolWire.test.ts` works for TS.
 *
 * Like the VS Code guard, it compares names, order, and numeric values; it does NOT prove the
 * running Core implements them (that is the compatibility matrix, docs/compatibility.md).
 */
class ProtocolDriftGuardTest {

    // ------------------------------------------------------------------
    // locating the sources (no git, no shell, no network)
    // ------------------------------------------------------------------

    /**
     * Locate the sources to compare against.
     *
     * `-Dsandpane.repo.root` wins when set (forwarded from the build by `build.gradle.kts`), so a
     * human or CI can point this gate at any checkout — and so the guard itself can be FALSIFIED
     * against a mutated COPY of the Rust source without editing the real `core/`. Otherwise the
     * test walks up from its working directory looking for the crate: a plain filesystem read, no
     * git, no shell, no network.
     */
    private fun repoRoot(): File {
        System.getProperty("sandpane.repo.root")?.takeIf { it.isNotBlank() }?.let { override ->
            val given = File(override).canonicalFile
            if (File(given, "core/crates/sandpane-protocol/src/lib.rs").isFile) return given
            fail("-Dsandpane.repo.root=$override has no core/crates/sandpane-protocol/src/lib.rs")
        }
        var dir: File? = File(System.getProperty("user.dir")).canonicalFile
        while (dir != null) {
            if (File(dir, "core/crates/sandpane-protocol/src/lib.rs").isFile) return dir
            dir = dir.parentFile
        }
        fail(
            "cannot find core/crates/sandpane-protocol/src/lib.rs above ${System.getProperty("user.dir")} — " +
                "run the tests from the repository (clients/jetbrains) or pass -Dsandpane.repo.root=<checkout>",
        )
    }

    private val root: File by lazy { repoRoot() }

    private fun read(relative: String): String {
        val file = File(root, relative)
        if (!file.isFile) fail("drift guard cannot read ${file.absolutePath}")
        return file.readText()
    }

    private val rust by lazy { read("core/crates/sandpane-protocol/src/lib.rs") }
    private val service by lazy { read("core/crates/sandpane-service/src/lib.rs") }
    private val validation by lazy { read("core/crates/sandpane-core/src/validation.rs") }
    private val confirm by lazy { read("core/crates/sandpane-service/src/confirm.rs") }
    private val projectLifecycle by lazy { read("core/crates/sandpane-service/src/project_lifecycle.rs") }
    private val conversationLifecycle by lazy { read("core/crates/sandpane-service/src/conversation_lifecycle.rs") }
    private val requestSchema by lazy { read("schemas/rpc-request.schema.json") }
    private val capabilitiesSchema by lazy { read("schemas/core-capabilities.schema.json") }
    private val sandboxSpecSchema by lazy { read("schemas/sandbox-create-spec.schema.json") }
    private val changeSetSchema by lazy { read("schemas/change-set.schema.json") }
    private val kotlinMirror by lazy { read("clients/jetbrains/src/main/kotlin/labs/dkv/sandpane/model/Models.kt") }

    // ------------------------------------------------------------------
    // parsers (same shapes the VS Code guard uses)
    // ------------------------------------------------------------------

    /** `Self::Variant => "a.b",` arms of `Method::as_str`. */
    private fun asStrTable(): Map<String, String> {
        val table = LinkedHashMap<String, String>()
        Regex("""Self::([A-Z][A-Za-z0-9]*) => "([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)"""").findAll(rust)
            .forEach { table[it.groupValues[1]] = it.groupValues[2] }
        if (table.isEmpty()) fail("no `Self::Variant => \"a.b\"` arms found — Method::as_str changed shape")
        return table
    }

    /** The wire names in `Method::ALL` ORDER — what `CoreCapabilities.methods` is derived from. */
    private fun methodAllWireNames(): List<String> {
        val decl = Regex("""pub const ALL: \[Method; (\d+)\] = \[([\s\S]*?)\];""").find(rust)
            ?: fail("sandpane-protocol has no `pub const ALL: [Method; N] = [...]`")
        val declared = decl.groupValues[1].toInt()
        val variants = Regex("""Self::([A-Z][A-Za-z0-9]*),""").findAll(decl.groupValues[2])
            .map { it.groupValues[1] }.toList()
        assertEquals(declared, variants.size, "Method::ALL entries vs its declared array length")
        val table = asStrTable()
        return variants.map { table[it] ?: fail("Method::ALL names $it, which as_str does not map to a wire name") }
    }

    /** `"a.b" =>` arms of `Method::parse`. */
    private fun parseArms(): List<String> =
        Regex(""""([a-z][a-z_]*\.[a-z][a-z_]*)" =>""").findAll(rust).map { it.groupValues[1] }.toList()

    /** `pub const NAME: <type> = <expr>;` from the service crate (raw right-hand side). */
    private fun serviceConst(name: String): String {
        val found = Regex("""pub const $name: [A-Za-z0-9_<>]+ = ([^;]+);""").find(service)
            ?: fail("sandpane-service has no `pub const $name`")
        return found.groupValues[1].trim()
    }

    /**
     * Evaluate a service constant by NAME — `4 * 1024 * 1024`, or `MAX_FRAME_BYTES - 64 * 1024`,
     * whose identifier resolves from the same source. No shell, no `eval`: top-level `-` terms,
     * `*` factors, numbers or known identifiers only, with a cycle guard. An expression this gate
     * cannot parse FAILS the test rather than guessing a value, because a silent misread here is
     * exactly the desync the gate exists to prevent.
     */
    private fun evalConst(name: String, resolving: MutableList<String> = mutableListOf()): Long {
        if (resolving.contains(name)) fail("constant cycle resolving $name")
        val rhs = serviceConst(name)
        resolving.add(name)
        try {
            return rhs.split("-").map { it.trim() }.mapIndexed { index, term ->
                val value = term.split("*").map { evalFactor(it.trim(), name, resolving) }
                    .fold(1L) { acc, factor -> acc * factor }
                if (index == 0) value else -value
            }.sum()
        } finally {
            resolving.removeAt(resolving.size - 1)
        }
    }

    private fun evalFactor(token: String, via: String, resolving: MutableList<String>): Long {
        if (Regex("""^\d+$""").matches(token)) return token.toLong()
        if (!Regex("""^[A-Za-z_][A-Za-z0-9_]*$""").matches(token)) {
            fail("token \"$token\" in `$via` is neither a number nor an identifier — pin the bound in Kotlin too")
        }
        return evalConst(token, resolving)
    }

    /** A `"…"` string enum from a JSON schema, matched on the property name. */
    private fun schemaStringEnum(json: String, property: String): List<String> {
        // Small, dependency-free extraction: find the property block, then its `enum` array.
        val key = indexInPropertyBlock(json, property)
        val enumStart = json.indexOf("\"enum\"", key)
        if (enumStart < 0) fail("schema property `$property` has no enum")
        val open = json.indexOf('[', enumStart)
        val close = json.indexOf(']', open)
        if (open < 0 || close < 0) fail("malformed enum array for `$property`")
        return Regex(""""([^"]+)"""").findAll(json.substring(open + 1, close)).map { it.groupValues[1] }.toList()
    }

    /** Index of the object that declares `"name": {` for a property, past any `required` list. */
    private fun indexInPropertyBlock(json: String, name: String): Int {
        val needle = "\"$name\""
        var from = 0
        while (true) {
            val hit = json.indexOf(needle, from)
            if (hit < 0) fail("schema has no `$name` property declaration")
            // A property declaration is `"name"` then `:` then `{`; the same string inside a
            // `required` list is followed by `,` or `]`, so the colon-plus-brace test is what
            // distinguishes the two.
            val after = json.substring(hit + needle.length).trimStart()
            if (after.startsWith(":") && after.substring(1).trimStart().startsWith("{")) return hit
            from = hit + needle.length
        }
    }

    // ------------------------------------------------------------------
    // the gate
    // ------------------------------------------------------------------

    @Test
    fun protocolVersionAndFrameCapArePinned() {
        assertEquals(1, PROTOCOL_VERSION)
        assertTrue(
            rust.contains("pub const PROTOCOL_VERSION: u32 = 1;"),
            "PROTOCOL_VERSION changed in Rust without a client update",
        )
        assertEquals(4L * 1024 * 1024, evalConst("MAX_FRAME_BYTES"))
        assertEquals(MAX_FRAME_BYTES.toLong(), evalConst("MAX_FRAME_BYTES"))
    }

    @Test
    fun kotlinMethodsMatchRustMethodAllExactlyIncludingOrder() {
        val fromAll = methodAllWireNames()
        assertEquals(CoreMethods.ALL, fromAll, "CoreMethods.ALL drifted from Method::ALL (order included)")
        assertEquals(36, fromAll.size, "addition A9 advertises 36 methods")
        // A5: git.diff sits immediately after git.review and before git.apply.
        assertEquals(fromAll.indexOf("git.review") + 1, fromAll.indexOf("git.diff"))
        assertEquals(fromAll.indexOf("git.diff") + 1, fromAll.indexOf("git.apply"))
        // A7: the six verification methods follow git.apply, in this exact order; A9 appended
        // the two maintenance methods at the end.
        assertEquals(
            listOf(
                "verification.list", "verification.approve", "verification.revoke", "verification.run",
                "verification.result", "project.context", "maintenance.inventory", "maintenance.cleanup",
            ),
            fromAll.subList(fromAll.indexOf("git.apply") + 1, fromAll.size),
        )

        // parse() must accept every advertised name, and the schema enum must carry the same set.
        val parsed = parseArms().toSet()
        fromAll.forEach { assertTrue(parsed.contains(it), "Method::parse has no arm for $it") }
        assertEquals(fromAll.toSet(), parsed, "Method::parse and Method::ALL no longer describe the same set")
        assertEquals(
            fromAll,
            schemaStringEnum(requestSchema, "method"),
            "schemas/rpc-request.schema.json `method` enum drifted from Method::ALL",
        )

        // A rename must break THIS test, not ship silently: the names the plugin sends are taken
        // from the same list Core dispatches, and no invented name is ever allowlisted.
        listOf(
            "task.list", "conversation.list", "conversation.history", "sandbox.stop", "sandbox.remove",
            "project.update", "project.archive", "project.unarchive", "project.delete",
            "project.add_repository", "project.remove_repository",
            "conversation.rename", "conversation.archive", "conversation.unarchive", "conversation.delete",
            "conversation.export", "git.diff",
            "verification.list", "verification.approve", "verification.revoke", "verification.run",
            "verification.result", "project.context", "maintenance.inventory", "maintenance.cleanup",
        ).forEach { added ->
            assertTrue(fromAll.contains(added), "Rust no longer advertises $added")
            assertTrue(CoreMethods.ALL.contains(added), "the Kotlin mirror dropped $added")
            assertTrue(rust.contains("=> \"$added\""), "as_str has no arm for $added")
        }
        // sbx v0.47 has no `start`: neither Rust nor this client may grow a sandbox.start.
        assertFalse(fromAll.contains("sandbox.start"), "Rust advertises sandbox.start, which sbx v0.47 cannot do")
        assertFalse(rust.contains("\"sandbox.start\" =>"), "Method::parse accepts sandbox.start")
        listOf("shell.exec", "sbx.raw", "fs.read", "process.spawn", "sandbox.start").forEach { forbidden ->
            assertFalse(CoreMethods.isAllowlisted(forbidden), "$forbidden must never be callable")
        }
    }

    @Test
    fun methodAdvertisementIsDerivedNotHandWritten() {
        assertTrue(
            rust.contains("pub const ALL: [Method; 36]"),
            "Method::ALL's declared length changed — update CoreMethods.ALL and this gate",
        )
        assertTrue(
            Regex("""pub fn wire_names\(\) -> Vec<&'static str> \{[\s\S]{0,200}Self::ALL\.iter\(\)""").containsMatchIn(rust),
            "wire_names() no longer derives from Method::ALL",
        )
        assertTrue(
            Regex("""methods:[\s\S]{0,220}Method::wire_names\(\)""").containsMatchIn(service),
            "system.probe no longer answers with the derived method list",
        )
        assertTrue(rust.contains("pub methods: Vec<String>"))
        // Additive: `methods` is NOT required, so a pre-discovery Core still validates.
        assertFalse(requiredOf(capabilitiesSchema, root).contains("methods"), "methods became required — not additive")

        // Absence means "not advertised", never "everything".
        val caps = CoreJsonCapabilities(listOf("system.probe"))
        assertTrue(caps.advertises("system.probe"))
        assertFalse(caps.advertises("task.list"))
        assertTrue(CoreJsonCapabilities(emptyList()).methods.isEmpty())
    }

    /** Small stand-in so the gate exercises the real type without a socket. */
    private class CoreJsonCapabilities(methods: List<String>) {
        private val caps = labs.dkv.sandpane.model.CoreCapabilities(
            protocolVersion = 1,
            coreVersion = "test",
            instanceId = "i",
            platform = "macos",
            methods = methods,
        )

        val methods: List<String> get() = caps.methods
        fun advertises(method: String): Boolean = caps.advertises(method)
    }

    private fun requiredOf(json: String, @Suppress("UNUSED_PARAMETER") at: File): List<String> {
        val start = json.indexOf("\"required\"")
        if (start < 0) return emptyList()
        val open = json.indexOf('[', start)
        val close = json.indexOf(']', open)
        return Regex(""""([^"]+)"""").findAll(json.substring(open + 1, close)).map { it.groupValues[1] }.toList()
    }

    @Test
    fun boundedReadConstantsMatchTheService() {
        assertEquals(DEFAULT_LIST_LIMIT.toLong(), evalConst("DEFAULT_LIST_LIMIT"), "DEFAULT_LIST_LIMIT drifted")
        assertEquals(MAX_LIST_LIMIT.toLong(), evalConst("MAX_LIST_LIMIT"), "MAX_LIST_LIMIT drifted")
        assertEquals(MAX_HISTORY_BYTES.toLong(), evalConst("MAX_HISTORY_BYTES"), "MAX_HISTORY_BYTES drifted")
        assertEquals(MAX_SUBSCRIBE_CURSORS.toLong(), evalConst("MAX_SUBSCRIBE_CURSORS"), "MAX_SUBSCRIBE_CURSORS drifted")
        assertEquals(MAX_CURSOR_KEY_LEN.toLong(), evalConst("MAX_CURSOR_KEY_LEN"), "MAX_CURSOR_KEY_LEN drifted")
        assertEquals(MAX_SCOPING_ID_LEN.toLong(), evalConst("MAX_SCOPING_ID_LEN"), "MAX_SCOPING_ID_LEN drifted")
        assertEquals(MAX_SUBSCRIBE_BYTES.toLong(), evalConst("MAX_SUBSCRIBE_BYTES"), "MAX_SUBSCRIBE_BYTES drifted")

        // Core asserts these relationships at compile time; the mirror must keep them too.
        assertTrue(MAX_HISTORY_BYTES < MAX_FRAME_BYTES)
        assertTrue(MAX_SUBSCRIBE_BYTES < MAX_FRAME_BYTES)
        assertTrue(
            service.contains("const _: () = assert!(MAX_HISTORY_BYTES < MAX_FRAME_BYTES);"),
            "Core's history/frame relationship assertion disappeared",
        )
        assertTrue(
            service.contains("const _: () = assert!(MAX_SUBSCRIBE_BYTES < MAX_FRAME_BYTES);"),
            "Core's subscribe/frame relationship assertion disappeared",
        )
    }

    @Test
    fun additiveFieldNamesExistOnBothSides() {
        // Every field this revision added is `#[serde(default)]` in Rust and nullable-or-defaulted
        // in Kotlin; the wire spelling is camelCase.
        val added: List<Pair<String, String>> = listOf(
            "pub methods: Vec<String>" to "methods",
            "pub repositories: Vec<String>" to "repositories",
            "pub workspace_mode: Option<WorkspaceMode>" to "workspaceMode",
            "pub after_sequences: Option<HashMap<String, i64>>" to "afterSequences",
            "pub next_sequence: i64" to "nextSequence",
            "pub truncated: bool" to "truncated",
            "pub messages: Vec<MessageRecord>" to "messages",
            "pub statuses: Vec<TaskStatus>" to "statuses",
            "pub limit: Option<u32>" to "limit",
            // A3a
            "pub archived_at: Option<String>" to "@SerialName(\"archivedAt\")",
            "pub include_archived: Option<bool>" to "@SerialName(\"includeArchived\")",
            "pub deleted: Option<bool>" to "val deleted: Boolean? = null",
            // A3b
            "pub sandbox_id: Option<String>" to "@SerialName(\"sandboxId\") val sandboxId: String? = null",
            "pub best_effort: bool" to "@SerialName(\"bestEffort\")",
            "pub by_kind: std::collections::BTreeMap<String, u64>" to "@SerialName(\"byKind\")",
            "pub exported_at: String" to "@SerialName(\"exportedAt\")",
            // A5
            "pub repo_path: Option<String>" to "@SerialName(\"repoPath\") val repoPath: String? = null",
            "pub uninspected: Option<Vec<String>>" to "val uninspected: List<String>? = null",
            "pub old_path: Option<String>" to "@SerialName(\"oldPath\") val oldPath: String? = null",
            "pub max_bytes: Option<u64>" to "@SerialName(\"maxBytes\") val maxBytes: Int? = null",
            "pub base_blob: Option<String>" to "@SerialName(\"baseBlob\") val baseBlob: String? = null",
            "pub lossy: bool" to "val lossy: Boolean",
            // A4
            "pub mode: Option<String>" to "val mode: String? = null",
            "pub chosen_sandbox_name: Option<String>" to "@SerialName(\"chosenSandboxName\") val chosenSandboxName: String? = null",
            // A1
            "pub agent: Option<String>" to "val agent: String? = null",
            "pub confirm_token: Option<String>" to "confirmToken",
            "pub requeried: Option<SandboxSummary>" to "requeried",
            "pub expires_at: String" to "expiresAt",
            "pub removed: Option<bool>" to "removed",
            "pub confirmation: Option<ConfirmationRequest>" to "confirmation",
            "pub external: bool" to "external",
            "pub impact: Vec<String>" to "impact",
        )
        for ((rustField, wireName) in added) {
            assertTrue(rust.contains(rustField), "Rust no longer has `$rustField`")
            assertTrue(kotlinMirror.contains(wireName), "the Kotlin mirror lost the wire name `$wireName`")
        }
        for (struct in listOf(
            "pub struct TaskListParams",
            "pub struct ConversationListParams",
            "pub struct ConversationHistoryParams",
            "pub struct MessageRecord",
            "pub struct ConversationHistoryResult",
            "pub struct SandboxStopParams",
            "pub struct SandboxStopResult",
            "pub struct SandboxRemoveParams",
            "pub struct SandboxRemoveResult",
            "pub struct ConfirmationRequest",
            "pub struct ConfirmationTarget",
            "pub struct ProjectListParams",
            "pub struct ProjectUpdateParams",
            "pub struct ProjectIdParams",
            "pub struct ProjectDeleteParams",
            "pub struct ProjectDeleteResult",
            "pub struct ProjectRepositoryParams",
            "pub struct ConversationRenameParams",
            "pub struct ConversationIdParams",
            "pub struct ConversationDeleteParams",
            "pub struct ConversationDeleteResult",
            "pub struct ConversationExportParams",
            "pub struct ConversationExportResult",
            "pub struct ExportRedaction",
        )) {
            assertTrue(rust.contains(struct), "Rust no longer defines $struct")
        }
        // `conversation.history` answers with an OBJECT, never a bare array.
        assertTrue(
            Regex("""pub struct ConversationHistoryResult \{\s+pub messages""").containsMatchIn(rust),
            "ConversationHistoryResult no longer leads with `messages`",
        )
        assertTrue(service.contains("fn conversation_history"))
        assertNotNull(ConversationHistoryResult(messages = emptyList(), truncated = false, nextSequence = 0))
    }

    @Test
    fun perTaskCursorRulesAreMirrored() {
        // taskId present → the scalar is the cursor and the map is ignored.
        assertTrue(
            service.contains("Some(task_id) => vec![(task_id.clone(), p.after_sequence)]"),
            "the taskId-present cursor rule changed in Core — update CoreCommands.taskSubscribe",
        )
        // no taskId → each task's own cursor; missing from the map ⇒ 0, negative ⇒ 0.
        assertTrue(
            service.contains("map.get(&tid).copied().unwrap_or(0).max(0)"),
            "the per-task cursor resolution changed in Core",
        )
        // no map → the legacy shared scalar.
        assertTrue(service.contains("None => p.after_sequence,"), "the legacy shared-scalar path changed")
        // An over-ceiling replay is refused structurally, not sent as an undeliverable frame.
        assertTrue(service.contains("MAX_SUBSCRIBE_BYTES"), "the replay ceiling disappeared")
        assertTrue(
            Regex("""ErrorCode::ValidationFailed[\s\S]{0,400}replay of""").containsMatchIn(service) ||
                Regex("""replay of \{replayed_tasks\} task\(s\) passed the""").containsMatchIn(service),
            "the oversized-replay refusal no longer looks like what CoreGuards.isOversizedReplayRefusal matches",
        )
    }

    @Test
    fun workspaceModesAndStatusesMatchTheirEnums() {
        // The Kotlin side is read from the GENERATED serializers (each enum's `wireName` is its
        // descriptor element name, i.e. the exact @SerialName), not re-derived from `name`. The
        // tolerant [Reported] decoders must know exactly the same set — an unknown value is only
        // "unknown" relative to this list.
        val block = enumBlock("WorkspaceMode")
        assertTrue(block.contains("rename_all = \"snake_case\""), "WorkspaceMode casing rule changed")
        val modes = enumVariants(block).map { it.toSnakeCase() }
        assertEquals(
            WorkspaceMode.entries.map { it.wireName },
            modes,
            "WorkspaceMode variants drifted between Rust and Kotlin",
        )
        assertEquals(modes, ReportedWorkspaceModeSerializer.knownWireNames)
        assertEquals(
            modes,
            schemaStringEnum(sandboxSpecSchema, "workspaceMode"),
            "schemas/sandbox-create-spec.schema.json workspaceMode enum drifted",
        )

        val statuses = enumBlock("TaskStatus")
        assertTrue(statuses.contains("rename_all = \"snake_case\""), "TaskStatus casing rule changed")
        val statusNames = enumVariants(statuses).map { it.toSnakeCase() }
        assertEquals(
            TaskStatus.entries.map { it.wireName },
            statusNames,
            "TaskStatus variants drifted between Rust and Kotlin",
        )
        assertEquals(statusNames, ReportedTaskStatusSerializer.knownWireNames)

        val fileStatuses = enumBlock("FileChangeStatus")
        assertTrue(fileStatuses.contains("rename_all = \"snake_case\""), "FileChangeStatus casing rule changed")
        val fileStatusNames = enumVariants(fileStatuses).map { it.toSnakeCase() }
        assertEquals(
            FileChangeStatus.entries.map { it.wireName },
            fileStatusNames,
            "FileChangeStatus variants drifted between Rust and Kotlin",
        )
        assertEquals(fileStatusNames, ReportedFileChangeStatusSerializer.knownWireNames)
        assertEquals(
            fileStatusNames,
            schemaStringEnum(changeSetSchema, "status"),
            "schemas/change-set.schema.json changes[].status enum drifted",
        )
    }

    /**
     * The tolerant decoders accept an unknown value only if it has the serde `snake_case` shape.
     * That is sound exactly while every mirrored Rust enum keeps `rename_all = "snake_case"` (pinned
     * above) and every CURRENT variant has that shape — checked here so a future variant spelled
     * otherwise fails this gate instead of being refused as a malformed frame at runtime.
     */
    @Test
    fun everyCurrentVariantFitsTheUnknownValueShape() {
        val shape = Regex("^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
        for (name in listOf("WorkspaceMode", "TaskStatus", "FileChangeStatus")) {
            enumVariants(enumBlock(name)).map { it.toSnakeCase() }.forEach { wire ->
                assertTrue(shape.matches(wire), "$name::$wire does not fit the tolerant decoder's shape")
                assertTrue(wire.length <= MAX_UNKNOWN_WIRE_NAME_LEN, "$name::$wire is longer than the decoder accepts")
            }
        }
    }

    @Test
    fun coreAppendsOnlyTheEventKindsTheClientKnows() {
        val appended = Regex("""log\.append\(\s*&?task_id,\s*"([a-z._]+)"""").findAll(service)
            .map { it.groupValues[1] }.toSet()
        assertTrue(appended.isNotEmpty(), "no durable event kinds found in sandpane-service — the probe changed")
        val agentTypes = labs.dkv.sandpane.model.AgentEvent.TYPES
        val lifecycle = labs.dkv.sandpane.model.CoreEventKinds.ALL
        appended.forEach { kind ->
            assertTrue(
                agentTypes.contains(kind) || lifecycle.contains(kind),
                "Core appends `$kind`, which this client renders as unrecognized — add it deliberately",
            )
        }
    }

    /**
     * A1: the Kotlin agent allowlist, the schema's `agent` enum and Core's `SBX_AGENTS_V0_47` are the
     * same ordered list — so a create spec can never carry an agent Core would refuse, and Core can
     * never accept one this client's surface does not know.
     */
    @Test
    fun sbxAgentAllowlistMatchesSchemaAndCore() {
        assertEquals(
            labs.dkv.sandpane.model.SbxAgents.V0_47,
            schemaStringEnum(sandboxSpecSchema, "agent"),
            "schemas/sandbox-create-spec.schema.json agent enum drifted from SbxAgents.V0_47",
        )
        val decl = Regex("""pub const SBX_AGENTS_V0_47: &\[&str\] = &\[([\s\S]*?)\];""").find(validation)
            ?: fail("sandpane-core validation.rs has no SBX_AGENTS_V0_47")
        val core = Regex(""""([^"]+)"""").findAll(decl.groupValues[1]).map { it.groupValues[1] }.toList()
        assertEquals(labs.dkv.sandpane.model.SbxAgents.V0_47, core, "Core's SBX_AGENTS_V0_47 drifted")
        assertEquals("shell", labs.dkv.sandpane.model.SbxAgents.DEFAULT)
        assertFalse(requiredOf(sandboxSpecSchema, root).contains("agent"), "agent became required — not additive")
    }

    /**
     * A1: [CoreGuards.requireAddressableSandboxName] mirrors `Validator::sandbox_name` (the rule Core
     * applies before `sbx stop`/`sbx rm`), not the stricter create-schema pattern. Pinned on the Rust
     * text so a change there fails here.
     */
    @Test
    fun addressableSandboxNameRuleMatchesCore() {
        val fn = Regex("""pub fn sandbox_name\(name: &str\)[\s\S]*?\n    \}""").find(validation)?.value
            ?: fail("Validator::sandbox_name not found")
        assertTrue(fn.contains("Self::bounded(name, 128)?;"), "Core's sandbox-name length bound changed")
        assertEquals(128, CoreGuards.MAX_SANDBOX_NAME_LEN)
        assertTrue(fn.contains("c.is_ascii_alphanumeric() || c == '-' || c == '.'"), "Core's sandbox-name charset changed")
        assertTrue(fn.contains("name.chars().count() < 2"), "Core's two-character minimum changed")
        assertTrue(fn.contains("eq_ignore_ascii_case(\"default\")"), "Core's reserved name changed")
    }

    /** A1: the confirmation token shape the client accepts is the one Core issues (64 lowercase hex). */
    @Test
    fun confirmationTokenShapeMatchesCore() {
        assertTrue(confirm.contains("pub const TOKEN_HEX_LEN: usize = 64;"), "Core's token length changed")
        assertTrue(CoreGuards.isConfirmTokenShape("0123456789abcdef".repeat(4)))
        assertFalse(CoreGuards.isConfirmTokenShape("0123456789ABCDEF".repeat(4)))
    }

    /**
     * Security W1: a step-2 `VALIDATION_FAILED` is worded "Core ran nothing" ONLY when Core's message
     * is its token refusal or its sandbox-name refusal. Both prefixes are read from the Rust source,
     * so a reworded refusal fails here instead of silently falling into the "not known" branch.
     */
    @Test
    fun ranNothingRefusalPrefixesMatchCore() {
        val decl = Regex("""pub const TOKEN_REJECTED_MESSAGE: &str =\s*"([^"]*)""").find(confirm)
            ?: fail("confirm.rs has no TOKEN_REJECTED_MESSAGE")
        assertTrue(
            decl.groupValues[1].startsWith(CoreRemoveRefusals.TOKEN_REJECTED_PREFIX),
            "Core's TOKEN_REJECTED_MESSAGE no longer starts with the prefix the client matches",
        )
        assertTrue(
            service.contains("format!(\"${CoreRemoveRefusals.NAME_REFUSAL_PREFIX}{e}\")"),
            "Core's sandbox-name refusal no longer starts with '${CoreRemoveRefusals.NAME_REFUSAL_PREFIX}'",
        )
    }

    /**
     * Review I2: the client deadline floors must outlast Core's worst case, computed from the
     * `RunLimits` Core really uses (`sandpane-core/src/process.rs`): stop = mutation + query,
     * remove step 2 = query + mutation + query.
     */
    @Test
    fun lifecycleDeadlineFloorsOutlastCoresRunLimits() {
        val process = read("core/crates/sandpane-core/src/process.rs")
        fun secs(name: String): Int {
            val m = Regex("""pub const $name: RunLimits = RunLimits \{\s*timeout: Duration::from_secs\((\d+)\)""").find(process)
                ?: fail("process.rs has no RunLimits::$name with a from_secs timeout")
            return m.groupValues[1].toInt()
        }
        val query = secs("QUERY") * 1000
        val mutation = secs("MUTATION") * 1000
        assertTrue(MethodDeadlines.SANDBOX_STOP_MS > mutation + query, "stop floor no longer outlasts Core")
        assertTrue(MethodDeadlines.SANDBOX_REMOVE_MS > query + mutation + query, "remove floor no longer outlasts Core")
        // A3a: add_repository runs one QUERY-class `git rev-parse --show-toplevel` before its DB write.
        assertTrue(MethodDeadlines.PROJECT_ADD_REPOSITORY_MS > query, "add_repository floor no longer outlasts Core's git query")
        // A5: git.review and git.diff run QUERY-bounded git; both get the 45 s git deadline.
        assertEquals(45_000, MethodDeadlines.GIT_REVIEW_MS)
        assertEquals(45_000, MethodDeadlines.GIT_DIFF_MS)
        assertTrue(MethodDeadlines.GIT_DIFF_MS > query && MethodDeadlines.GIT_REVIEW_MS > query)
        assertEquals(45_000, MethodDeadlines.forMethod(CoreMethods.GIT_DIFF, 15_000))
        assertEquals(45_000, MethodDeadlines.forMethod(CoreMethods.GIT_REVIEW, 15_000))
        assertEquals(120_000, MethodDeadlines.forMethod(CoreMethods.GIT_DIFF, 120_000), "a longer user setting still wins")
        // A5 moved show_toplevel onto `exec_output(..., &self.limits)`; the runner's default limits are QUERY.
        val gitRs = read("core/crates/sandpane-core/src/git.rs")
        assertTrue(
            Regex("""pub fn show_toplevel[\s\S]{0,120}self\.run\(""").containsMatchIn(gitRs) ||
                Regex("""pub fn show_toplevel[\s\S]{0,400}&self\.limits,""").containsMatchIn(gitRs),
            "show_toplevel no longer goes through the QUERY-bounded runner",
        )
        assertTrue(gitRs.contains("limits: RunLimits::QUERY"), "the git runner's default limits are no longer QUERY")
    }

    // ------------------------------------------------------------------
    // A3a: project lifecycle — exact messages, validators, wire shapes
    // ------------------------------------------------------------------

    /** Every exact message the client words is Core's constant, byte for byte. */
    @Test
    fun projectLifecycleMessagesMatchCore() {
        val pairs = listOf(
            "MSG_PROJECT_ARCHIVED" to ProjectOutcomes.MSG_PROJECT_ARCHIVED,
            "MSG_PROJECT_HAS_TASKS" to ProjectOutcomes.MSG_PROJECT_HAS_TASKS,
            "MSG_PROJECT_HAS_SANDBOXES" to ProjectOutcomes.MSG_PROJECT_HAS_SANDBOXES,
            "MSG_REPOSITORY_IN_USE" to ProjectOutcomes.MSG_REPOSITORY_IN_USE,
            "MSG_PROJECT_CREATE_IN_FLIGHT" to ProjectOutcomes.MSG_PROJECT_CREATE_IN_FLIGHT,
            "MSG_REPOSITORY_REMOVE_WHILE_CREATING" to ProjectOutcomes.MSG_REPOSITORY_REMOVE_WHILE_CREATING,
            "MSG_REPOSITORY_UNREGISTERED_DURING_CREATE" to ProjectOutcomes.MSG_REPOSITORY_UNREGISTERED_DURING_CREATE,
            "MSG_PROJECT_NOT_FOUND" to ProjectOutcomes.MSG_PROJECT_NOT_FOUND,
            "MSG_REPOSITORY_NOT_REGISTERED" to ProjectOutcomes.MSG_REPOSITORY_NOT_REGISTERED,
            "MSG_UPDATE_NEEDS_A_FIELD" to ProjectOutcomes.MSG_UPDATE_NEEDS_A_FIELD,
        )
        for ((name, kotlin) in pairs) {
            assertEquals(rustStringConst(projectLifecycle, name), kotlin, "$name drifted from project_lifecycle.rs")
        }
        // A7 adds one message raised by the project delete checks; it lives in verification.rs (pinned in
        // verificationMessagesMatchCore) and is CONFLICT there.
        assertEquals(
            pairs.map { it.second }.toSet() + Verifications.MSG_PROJECT_VERIFICATION_RUNNING,
            ProjectOutcomes.KNOWN_MESSAGES,
            "a worded message is not drift-checked",
        )
        // Every `pub const MSG_*` Core declares there is mirrored (a new refusal must not ship unworded).
        val rustNames = Regex("""pub const (MSG_[A-Z_]+): &str""").findAll(projectLifecycle).map { it.groupValues[1] }.toSet()
        assertEquals(pairs.map { it.first }.toSet(), rustNames, "project_lifecycle.rs gained or lost a message const")
        assertEquals(rustStringConst(projectLifecycle, "PROJECT_DELETE_ACTION"), CoreMethods.PROJECT_DELETE)
        // The step-2 token rejection is A1's message (confirm.rs) and still starts with the matched prefix.
        assertTrue(
            rustStringConst(confirm, "TOKEN_REJECTED_MESSAGE").startsWith(CoreRemoveRefusals.TOKEN_REJECTED_PREFIX),
            "Core's token-rejection text no longer starts with the matched prefix",
        )
        // The code the client pairs with each message (ProjectOutcomes matches code AND text) is the one
        // Core raises it under — read from every use site, so a wrong pairing cannot silently drop the copy.
        val expectedCode = mapOf(
            "MSG_PROJECT_ARCHIVED" to "ValidationFailed",
            "MSG_REPOSITORY_IN_USE" to "Conflict",
            "MSG_REPOSITORY_REMOVE_WHILE_CREATING" to "Conflict",
            "MSG_REPOSITORY_UNREGISTERED_DURING_CREATE" to "Conflict",
            "MSG_REPOSITORY_NOT_REGISTERED" to "NotFound",
            "MSG_UPDATE_NEEDS_A_FIELD" to "ValidationFailed",
        )
        val sources = listOf(projectLifecycle, service)
        for ((const, code) in expectedCode) {
            val sites = sources.flatMap { src -> Regex("""\b$const\.to_string\(\)""").findAll(src).map { src to it.range.first }.toList() }
            assertTrue(sites.isNotEmpty(), "$const is never raised")
            for ((src, at) in sites) {
                val before = src.substring(maxOf(0, at - 150), at)
                assertTrue(before.contains("ErrorCode::$code"), "$const is raised without ErrorCode::$code nearby: …${before.takeLast(80)}")
            }
            val known = ProjectOutcomes.describeFailure(CoreMethods.PROJECT_UPDATE, CoreRpcException(wireCode(code), rustStringConst(projectLifecycle, const)), true)
            assertTrue(known.body.contains("nothing was"), "the client does not word $const under ${wireCode(code)}")
        }
        // The three delete blockers come back from delete_blocker() and are raised through conflict().
        val blocker = Regex("""fn delete_blocker\([\s\S]*?\n\}""").find(projectLifecycle)?.value ?: fail("delete_blocker not found")
        for (const in listOf("MSG_PROJECT_HAS_TASKS", "MSG_PROJECT_HAS_SANDBOXES", "MSG_PROJECT_CREATE_IN_FLIGHT")) {
            assertTrue(blocker.contains("return Ok(Some($const))"), "$const is no longer a delete blocker")
            val known = ProjectOutcomes.describeFailure(CoreMethods.PROJECT_DELETE, CoreRpcException(CoreErrorCodes.CONFLICT, rustStringConst(projectLifecycle, const)), true)
            assertTrue(known.body.contains("nothing was deleted"), const)
        }
        assertEquals(2, Regex("""delete_blocker\(inner, [^\n]*\)\? \{\s*return Err\(conflict\(m\)\);""").findAll(projectLifecycle).count(), "a delete blocker is no longer raised as conflict(m)")
        assertTrue(Regex("""fn conflict\([^)]*\)[^{]*\{[\s\S]{0,120}ErrorCode::Conflict""").containsMatchIn(projectLifecycle), "conflict() no longer raises CONFLICT")
        assertTrue(Regex("""fn not_found\(\)[\s\S]{0,160}ErrorCode::NotFound[\s\S]{0,80}MSG_PROJECT_NOT_FOUND""").containsMatchIn(projectLifecycle))
    }

    // ------------------------------------------------------------------
    // A3b: conversation lifecycle — exact messages, validator, wire shapes
    // ------------------------------------------------------------------

    /** Every exact message the client words is Core's constant, byte for byte, raised under the paired code. */
    @Test
    fun conversationLifecycleMessagesMatchCore() {
        val pairs = listOf(
            "MSG_CONVERSATION_ARCHIVED" to ConversationOutcomes.MSG_CONVERSATION_ARCHIVED,
            "MSG_CONVERSATION_HAS_TASKS" to ConversationOutcomes.MSG_CONVERSATION_HAS_TASKS,
            "MSG_CONVERSATION_NOT_FOUND" to ConversationOutcomes.MSG_CONVERSATION_NOT_FOUND,
            "MSG_TITLE_BLANK" to ConversationOutcomes.MSG_TITLE_BLANK,
        )
        for ((name, kotlin) in pairs) {
            assertEquals(rustStringConst(conversationLifecycle, name), kotlin, "$name drifted from conversation_lifecycle.rs")
        }
        // Every `pub const MSG_*` Core declares there is mirrored (a new refusal must not ship unworded).
        val rustNames = Regex("""pub const (MSG_[A-Z_]+): &str""").findAll(conversationLifecycle).map { it.groupValues[1] }.toSet()
        assertEquals(pairs.map { it.first }.toSet(), rustNames, "conversation_lifecycle.rs gained or lost a message const")
        // The worded set = these four + A3a's project message, which Core raises FIRST in an archived project.
        // A7 adds the verification-running delete refusal (verification.rs, pinned in verificationMessagesMatchCore).
        assertEquals(
            pairs.map { it.second }.toSet() + ProjectOutcomes.MSG_PROJECT_ARCHIVED + Verifications.MSG_CONVERSATION_VERIFICATION_RUNNING,
            ConversationOutcomes.KNOWN_MESSAGES,
        )
        assertEquals(rustStringConst(projectLifecycle, "MSG_PROJECT_ARCHIVED"), ConversationOutcomes.MSG_PROJECT_ARCHIVED)
        assertEquals(rustStringConst(conversationLifecycle, "CONVERSATION_DELETE_ACTION"), CoreMethods.CONVERSATION_DELETE)
        assertEquals(rustStringConst(rust, "CONVERSATION_EXPORT_FORMAT"), labs.dkv.sandpane.model.CONVERSATION_EXPORT_FORMAT)

        // The code each message is raised under, read from its use sites.
        val expectedCode = mapOf(
            "MSG_CONVERSATION_ARCHIVED" to "ValidationFailed",
            "MSG_CONVERSATION_HAS_TASKS" to "Conflict",
            "MSG_CONVERSATION_NOT_FOUND" to "NotFound",
            "MSG_TITLE_BLANK" to "ValidationFailed",
        )
        for ((const, code) in expectedCode) {
            val sites = Regex("""\b$const\.to_string\(\)""").findAll(conversationLifecycle).map { it.range.first }.toList()
            assertTrue(sites.isNotEmpty(), "$const is never raised")
            for (at in sites) {
                val before = conversationLifecycle.substring(maxOf(0, at - 120), at)
                assertTrue(before.contains("ErrorCode::$code"), "$const is raised without ErrorCode::$code nearby: …${before.takeLast(80)}")
            }
            val method = if (const == "MSG_CONVERSATION_HAS_TASKS") CoreMethods.CONVERSATION_DELETE else CoreMethods.CONVERSATION_RENAME
            val known = ConversationOutcomes.describeFailure(method, CoreRpcException(wireCode(code), rustStringConst(conversationLifecycle, const)), true)
            assertTrue(known.body.contains("nothing was"), "the client does not word $const under ${wireCode(code)}")
        }
        // Check order: the PROJECT refusal comes first for send/rename (require_writable_conversation).
        val writable = Regex("""fn require_writable_conversation\([\s\S]*?\n\}""").find(conversationLifecycle)?.value
            ?: fail("require_writable_conversation not found")
        assertTrue(
            writable.indexOf("require_live_project") in 0 until writable.indexOf("MSG_CONVERSATION_ARCHIVED"),
            "Core no longer checks the project before the conversation — ConversationUiState must follow",
        )
        // Unarchive is refused in an archived project; archive is not.
        assertTrue(
            Regex("""if !archive \{\s*project_lifecycle::require_live_project""").containsMatchIn(conversationLifecycle),
            "Core's archive/unarchive project rule changed",
        )
        // The step-2 token rejection is A1's message and still starts with the matched prefix.
        assertTrue(conversationLifecycle.contains("confirm::TOKEN_REJECTED_MESSAGE.to_string()"))
        // external is always false for a conversation.
        assertTrue(conversationLifecycle.contains("external: false,"), "conversation.delete may now be marked external")
    }

    /** `Validator::conversation_title` + rename's whitespace-only refusal, mirrored exactly. */
    @Test
    fun conversationTitleValidatorMirrorsCore() {
        val max = Regex("""pub const MAX_CONVERSATION_TITLE_CHARS: usize = (\d+);""").find(validation)?.groupValues?.get(1)?.toInt()
            ?: fail("validation.rs has no MAX_CONVERSATION_TITLE_CHARS")
        assertEquals(max, ConversationGuards.MAX_TITLE_CHARS)
        val fn = Regex("""pub fn conversation_title\(value: &str\)[\s\S]*?\n    \}""").find(validation)?.value
            ?: fail("Validator::conversation_title not found")
        assertTrue(fn.contains("Self::bounded(value, MAX_CONVERSATION_TITLE_CHARS)?"), "conversation_title's bound changed")
        assertTrue(fn.contains(".find(|c| c.is_control() || is_spoofing_format_char(*c))"), "conversation_title's char rule changed")
        assertFalse(fn.contains("trim"), "Core started trimming titles in the validator — the client must follow")
        // Rename: whitespace-only (Rust `trim`, Unicode White_Space) is refused BEFORE the validator.
        val rename = Regex("""pub\(crate\) fn conversation_rename\([\s\S]*?\n\}""").find(conversationLifecycle)?.value
            ?: fail("conversation_rename not found")
        val blank = rename.indexOf("if p.title.trim().is_empty()")
        assertTrue(blank >= 0, "rename's whitespace-only check changed")
        assertTrue(blank < rename.indexOf("Validator::conversation_title(&p.title)"), "rename now validates before the blank check")
        // The spoofing set is the one ProjectGuards mirrors (pinned in projectValidatorsMirrorCoreExactly).
        assertTrue(validation.contains("fn is_spoofing_format_char(c: char) -> bool"))
    }

    /** A3b wire shapes: Kotlin encodes the same camelCase keys Rust (rename_all) expects. */
    @Test
    fun conversationLifecycleParamsUseCoresWireNames() {
        assertTrue(Regex("""pub struct ConversationRenameParams \{\s*pub conversation_id: String,\s*pub title: String,""").containsMatchIn(rust))
        assertTrue(Regex("""pub struct ConversationIdParams \{\s*pub conversation_id: String,\s*\}""").containsMatchIn(rust))
        assertTrue(Regex("""pub struct ConversationDeleteParams \{\s*pub conversation_id: String,[\s\S]{0,120}pub confirm_token: Option<String>""").containsMatchIn(rust))
        assertTrue(Regex("""pub struct ConversationDeleteResult \{[\s\S]{0,120}pub confirmation: Option<ConfirmationRequest>,[\s\S]{0,120}pub deleted: Option<bool>""").containsMatchIn(rust))
        assertTrue(Regex("""pub struct ConversationExportParams \{\s*pub conversation_id: String,\s*#\[serde\(default\)\]\s*pub after_sequence: i64,""").containsMatchIn(rust))
        val result = Regex("""pub struct ConversationExportResult \{([\s\S]*?)\n\}""").find(rust)?.groupValues?.get(1)
            ?: fail("ConversationExportResult not found")
        val fields = Regex("""pub ([a-z_]+):""").findAll(result).map { it.groupValues[1] }.toList()
        assertEquals(listOf("format", "exported_at", "conversation", "messages", "truncated", "next_sequence", "redaction"), fields)
        assertFalse(result.contains("serde(default"), "an export page field became optional — the Kotlin mirror requires them")
        assertTrue(Regex("""pub struct ConversationListParams \{[\s\S]*?pub include_archived: Option<bool>""").containsMatchIn(rust))
        // Conversation gains archivedAt / sandboxId, both absent-tolerant.
        val conv = Regex("""pub struct Conversation \{([\s\S]*?)\n\}""").find(rust)?.groupValues?.get(1) ?: fail("Conversation not found")
        assertTrue(Regex("""#\[serde\(default, skip_serializing_if = "Option::is_none"\)\]\s*pub archived_at: Option<String>""").containsMatchIn(conv))
        assertTrue(Regex("""#\[serde\(default, skip_serializing_if = "Option::is_none"\)\]\s*pub sandbox_id: Option<String>""").containsMatchIn(conv))
        // Decoding a pre-A3b row and an A3b row with the Kotlin mirror.
        val old = CoreJson.decodeFromString(labs.dkv.sandpane.model.Conversation.serializer(), """{"id":"c","projectId":"p","title":"t","agentId":"a","createdAt":"x"}""")
        assertEquals(null, old.archivedAt)
        assertEquals(null, old.sandboxId)
        // The redaction kinds the client may display are Core's (by name only; byKind keys are not enumerated client-side).
        val kinds = read("core/crates/sandpane-core/src/redact.rs")
        assertTrue(kinds.contains("pub const KINDS: [&str; 7]"), "Core's redaction kind list changed size")
    }

    private fun wireCode(rustVariant: String): String = when (rustVariant) {
        "ValidationFailed" -> CoreErrorCodes.VALIDATION_FAILED
        "Conflict" -> CoreErrorCodes.CONFLICT
        "NotFound" -> CoreErrorCodes.NOT_FOUND
        else -> fail("unmapped ErrorCode::$rustVariant")
    }

    /** `Validator::project_name` / `project_description` mirrored exactly (never stricter, never looser). */
    @Test
    fun projectValidatorsMirrorCoreExactly() {
        fun usizeConst(name: String): Int =
            Regex("""pub const $name: usize = (\d+);""").find(validation)?.groupValues?.get(1)?.toInt()
                ?: fail("validation.rs has no `pub const $name: usize`")
        assertEquals(usizeConst("MAX_PROJECT_NAME_CHARS"), ProjectGuards.MAX_NAME_CHARS)
        assertEquals(usizeConst("MAX_PROJECT_DESCRIPTION_CHARS"), ProjectGuards.MAX_DESCRIPTION_CHARS)

        val name = Regex("""pub fn project_name\(value: &str\)[\s\S]*?\n    \}""").find(validation)?.value
            ?: fail("Validator::project_name not found")
        assertTrue(name.contains("Self::bounded(value, MAX_PROJECT_NAME_CHARS)?"), "project_name's bound changed")
        assertTrue(name.contains(".find(|c| c.is_control() || is_spoofing_format_char(*c))"), "project_name's char rule changed")
        assertFalse(name.contains("trim"), "Core started trimming names — the client must follow")
        val bounded = Regex("""fn bounded\(value: &str, max: usize\)[\s\S]*?\n    \}""").find(validation)?.value
            ?: fail("Validator::bounded not found")
        assertTrue(bounded.contains("value.is_empty()") && bounded.contains("value.chars().count() > max"), "bounded() changed")

        val desc = Regex("""pub fn project_description\(value: &str\)[\s\S]*?\n    \}""").find(validation)?.value
            ?: fail("Validator::project_description not found")
        assertTrue(desc.contains("value.chars().count() > MAX_PROJECT_DESCRIPTION_CHARS"), "project_description's bound changed")
        assertTrue(
            desc.contains(".find(|c| (c.is_control() && *c != '\\n') || is_spoofing_format_char(*c))"),
            "project_description's char rule changed",
        )
        assertFalse(desc.contains("is_empty"), "Core started refusing an empty description — the client must follow")

        // is_spoofing_format_char: parse Core's exact set and compare over the whole BMP.
        val spoof = Regex("""fn is_spoofing_format_char\(c: char\) -> bool \{([\s\S]*?)\n\}""").find(validation)?.groupValues?.get(1)
            ?: fail("is_spoofing_format_char not found")
        val rustSet = HashSet<Int>()
        Regex("""'\\u\{([0-9A-Fa-f]+)\}'(\s*\.\.=\s*'\\u\{([0-9A-Fa-f]+)\}')?""").findAll(spoof).forEach { m ->
            val lo = m.groupValues[1].toInt(16)
            val hi = m.groupValues[3].takeIf { it.isNotEmpty() }?.toInt(16) ?: lo
            (lo..hi).forEach { rustSet += it }
        }
        assertEquals(14, rustSet.size, "Core's spoofing set changed size: ${rustSet.sorted().map { "%04X".format(it) }}")
        for (cp in 0..0xFFFF) {
            assertEquals(rustSet.contains(cp), ProjectGuards.isSpoofingFormatChar(cp), "U+%04X".format(cp))
        }
    }

    /** A3a wire shapes: Kotlin encodes the same camelCase keys Rust (rename_all) expects. */
    @Test
    fun projectLifecycleParamsUseCoresWireNames() {
        assertTrue(Regex("""rename_all = "camelCase"\)\]\s*pub struct ProjectListParams \{\s*#\[serde\(default, skip_serializing_if = "Option::is_none"\)\]\s*pub include_archived""").containsMatchIn(rust))
        assertTrue(Regex("""pub struct ProjectUpdateParams \{\s*pub project_id: String,""").containsMatchIn(rust))
        assertTrue(Regex("""pub struct ProjectDeleteParams \{\s*pub project_id: String,[\s\S]{0,120}pub confirm_token: Option<String>""").containsMatchIn(rust))
        assertTrue(Regex("""pub struct ProjectRepositoryParams \{\s*pub project_id: String,\s*pub path: String,""").containsMatchIn(rust))
        assertTrue(Regex("""pub struct ProjectIdParams \{\s*pub project_id: String,\s*\}""").containsMatchIn(rust))
        assertTrue(Regex("""pub struct ProjectDeleteResult \{[\s\S]{0,120}pub confirmation: Option<ConfirmationRequest>,[\s\S]{0,120}pub deleted: Option<bool>""").containsMatchIn(rust))
        // includeArchived defaults to live-only: absent/false keep today's behaviour.
        assertTrue(rust.contains("self.include_archived.unwrap_or(false)"))
    }

    /** A2: the features this build knows equal Rust `FEATURES` and the schema's `items.examples`. */
    @Test
    fun knownFeaturesMatchRustAndSchema() {
        val decl = Regex("""pub const FEATURES: \[&str; (\d+)\] = \[([^\]]*)\];""").find(rust)
            ?: fail("sandpane-protocol has no `pub const FEATURES: [&str; N] = [...]`")
        val rustFeatures = Regex(""""([^"]+)"""").findAll(decl.groupValues[2]).map { it.groupValues[1] }.toList()
        assertEquals(decl.groupValues[1].toInt(), rustFeatures.size)
        assertEquals(labs.dkv.sandpane.model.CoreFeatures.KNOWN, rustFeatures, "CoreFeatures drifted from Rust FEATURES")

        val featuresBlock = capabilitiesSchema.substring(indexInPropertyBlock(capabilitiesSchema, "features"))
        val examplesAt = featuresBlock.indexOf("\"examples\"")
        if (examplesAt < 0) fail("core-capabilities features.items has no examples")
        val open = featuresBlock.indexOf('[', examplesAt)
        val close = featuresBlock.indexOf(']', open)
        val examples = Regex(""""([^"]+)"""").findAll(featuresBlock.substring(open + 1, close)).map { it.groupValues[1] }.toList()
        assertEquals(labs.dkv.sandpane.model.CoreFeatures.KNOWN, examples, "schema features.items.examples drifted")
        assertFalse(requiredOf(capabilitiesSchema, root).contains("features"), "features became required — not additive")
        assertTrue(rust.contains("pub features: Vec<String>"))
        assertTrue(kotlinMirror.contains("val features: List<String> = emptyList()"))
    }

    /**
     * A8a (\u00A73.8 item 1): every `capabilities.sbx` property the schema defines is a field of the Kotlin
     * [labs.dkv.sandpane.model.SbxStatus] (same wire names, same order), and only `installed` is
     * required \u2014 so `execVerified` / `versionCaptured` cannot be added to the schema without the
     * client learning them, and stay additive.
     */
    @Test
    fun sbxStatusFieldsMatchSchema() {
        val sbxAt = indexInPropertyBlock(capabilitiesSchema, "sbx")
        val agentsAt = indexInPropertyBlock(capabilitiesSchema, "agents")
        assertTrue(agentsAt > sbxAt, "core-capabilities: `sbx` is no longer declared before `agents`")
        val block = capabilitiesSchema.substring(sbxAt, agentsAt)
        val propertiesAt = block.indexOf("\"properties\"")
        if (propertiesAt < 0) fail("core-capabilities sbx has no properties")
        val schemaNames = Regex(""""([A-Za-z][A-Za-z0-9]*)"\s*:\s*\{""").findAll(block.substring(propertiesAt + 1))
            .map { it.groupValues[1] }.toList()
        val descriptor = labs.dkv.sandpane.model.SbxStatus.serializer().descriptor
        val kotlinNames = (0 until descriptor.elementsCount).map { descriptor.getElementName(it) }
        assertEquals(kotlinNames, schemaNames, "SbxStatus drifted from schemas/core-capabilities.schema.json sbx.properties")
        for (i in 0 until descriptor.elementsCount) {
            assertEquals(
                descriptor.getElementName(i) == "installed",
                !descriptor.isElementOptional(i),
                "only `installed` may be required in SbxStatus (${descriptor.getElementName(i)})",
            )
        }
        assertTrue(Regex(""""required"\s*:\s*\[\s*"installed"\s*\]""").containsMatchIn(block), "sbx.required changed")
    }

    /** A5 (\u00A73.5): git.diff's exact refusals, bounds and wire shape are Core's. */
    @Test
    fun gitDiffMessagesAndBoundsMatchCore() {
        val diff = read("core/crates/sandpane-core/src/diff.rs")
        val git = read("core/crates/sandpane-core/src/git.rs")
        assertEquals(rustStringConst(service, "MSG_WORK_TREE_REDIRECTED"), GitDiffs.MSG_WORK_TREE_REDIRECTED)
        assertEquals(rustStringConst(service, "MSG_DIFF_PATH_NOT_IN_LIST"), GitDiffs.MSG_PATH_NOT_IN_LIST)
        assertEquals(rustStringConst(service, "MSG_DIFF_PATH_LISTED_TWICE"), GitDiffs.MSG_PATH_LISTED_TWICE)
        assertEquals(rustStringConst(service, "MSG_DIFF_PATH_NOT_EXACT"), GitDiffs.MSG_PATH_NOT_EXACT)
        // A6 turned the literal into a `pub const` (git.apply reuses it for its no-Git-context abort).
        assertEquals(rustStringConst(service, "MSG_NO_GIT_CONTEXT"), GitDiffs.MSG_NO_GIT_CONTEXT, "no-Git-context text changed")
        assertTrue(service.contains("(ErrorCode::NotFound, \"${GitDiffs.MSG_TASK_NOT_FOUND}\".to_string())"))
        val removed = Regex(""""(the task's worktree was removed[^"]*)"""").find(service)?.groupValues?.get(1)
            ?.replace(Regex("""\\\n\s*"""), "") ?: fail("worktree-removed message not found")
        assertEquals(removed, GitDiffs.MSG_WORKTREE_REMOVED)
        assertTrue(service.contains("format!(\"{m}${GitDiffs.NOTHING_READ_SUFFIX}\")"), "the untracked refusal suffix changed")
        assertTrue(diff.contains("changed while it was being read"))
        assertTrue(git.contains("\"${GitDiffs.SUBMODULE_PREFIX}{}{extra};"), "the submodule refusal prefix changed")
        fun usize(name: String) = Regex("""pub const $name: usize = ([0-9_]+);""").find(diff)?.groupValues?.get(1)?.replace("_", "")?.toInt()
            ?: fail("diff.rs has no $name")
        assertEquals(usize("MAX_DIFF_BYTES"), GitDiffs.MAX_BYTES)
        assertEquals(usize("DEFAULT_DIFF_BYTES"), GitDiffs.DEFAULT_BYTES)
        val params = Regex("""pub struct GitDiffParams \{([\s\S]*?)\n\}""").find(rust)?.groupValues?.get(1) ?: fail("GitDiffParams not found")
        assertEquals(listOf("task_id", "path", "max_bytes", "status"), Regex("""pub ([a-z_]+):""").findAll(params).map { it.groupValues[1] }.toList())
        assertTrue(params.contains("pub status: Option<FileChangeStatus>"))
        val result = Regex("""pub struct GitDiffResult \{([\s\S]*?)\n\}""").find(rust)?.groupValues?.get(1) ?: fail("GitDiffResult not found")
        assertEquals(
            listOf("path", "old_path", "status", "patch", "binary", "truncated", "lossy", "base_blob", "task_blob", "task_mode"),
            Regex("""pub ([a-z_]+):""").findAll(result).map { it.groupValues[1] }.toList(),
        )
        assertTrue(Regex("""#\[serde\(default, skip_serializing_if = "Option::is_none"\)\]\s*pub uninspected: Option<Vec<String>>""").containsMatchIn(rust))
        assertTrue(Regex("""#\[serde\(default, skip_serializing_if = "Option::is_none"\)\]\s*pub repo_path: Option<String>""").containsMatchIn(rust))
        // git.diff stays out of every replay/retry path: this plugin keeps no replay-safe list, and
        // Core's own replay-safe set does not name it.
        assertFalse(Regex("""replay_safe[\s\S]{0,400}GitDiff""").containsMatchIn(rust + service), "git.diff became replay-safe")
    }

    // ------------------------------------------------------------------
    // A6: git.apply for reviewed files (design 2026-10-09 \u00A73.6)
    // ------------------------------------------------------------------

    private val applyRs by lazy { read("core/crates/sandpane-core/src/apply.rs") }
    private val gitApplyRs by lazy { read("core/crates/sandpane-service/src/git_apply.rs") }

    /** The `format!` template of a Rust `pub fn NAME(...) -> String`, `\`-newline continuations joined. */
    private fun rustFormat(source: String, fn: String): String {
        val m = Regex("""pub fn $fn\([^)]*\) -> String \{\s*format!\(\s*"((?:[^"\\]|\\[\s\S])*)"""").find(source)
            ?: fail("no `pub fn $fn(...) -> String { format!(\"...\"` found")
        return m.groupValues[1].replace(Regex("""\\\n\s*"""), "")
    }

    /** Every Core message this client's apply copy keys on is Core's constant, byte for byte. */
    @Test
    fun gitApplyMessagesTheCopyKeysOnMatchCore() {
        val pairs = listOf(
            "MSG_NEEDS_REVIEW" to GitApplies.MSG_NEEDS_REVIEW,
            "MSG_SELECTED_FILES" to GitApplies.MSG_SELECTED_FILES,
            "MSG_TOO_MANY_ENTRIES" to GitApplies.MSG_TOO_MANY_ENTRIES,
            "MSG_ENTRIES_NOT_REVIEWED" to GitApplies.MSG_ENTRIES_NOT_REVIEWED,
            "MSG_CHECK_FAILED" to GitApplies.MSG_CHECK_FAILED,
            "MSG_CHECK_UNAVAILABLE" to GitApplies.MSG_CHECK_UNAVAILABLE,
            "MSG_WRITE_NOT_RUN" to GitApplies.MSG_WRITE_NOT_RUN,
            "MSG_WRITE_TOO_LATE" to GitApplies.MSG_WRITE_TOO_LATE,
        )
        for ((name, kotlin) in pairs) assertEquals(rustStringConst(applyRs, name), kotlin, name)
        assertTrue(applyRs.contains("const NOTHING_WRITTEN: &str = \"${GitApplies.NOTHING_WRITTEN}\";"), "NOTHING_WRITTEN changed")
        // msg_changed: "{q(path)} changed since it was reviewed; review it again{NOTHING_WRITTEN}".
        assertEquals("{} changed since it was reviewed; review it again{NOTHING_WRITTEN}", rustFormat(applyRs, "msg_changed"))
        assertEquals(" changed since it was reviewed; review it again" + GitApplies.NOTHING_WRITTEN, GitApplies.CHANGED_SUFFIX)
        // The two CONFLICT kinds.
        assertEquals(
            "{what}: a sandbox mounts this repository directly and can change it while Core writes; stop or remove it first{NOTHING_WRITTEN}",
            rustFormat(applyRs, "msg_mounted"),
        )
        assertEquals(
            ": a sandbox mounts this repository directly and can change it while Core writes; stop or remove it first" +
                GitApplies.NOTHING_WRITTEN,
            GitApplies.MOUNTED_SUFFIX,
        )
        val locked = rustFormat(gitApplyRs, "msg_locked")
        assertEquals("{repo}" + GitApplies.LOCKED_INFIX + "{holder}" + GitApplies.LOCKED_SUFFIX, locked)
        assertEquals(
            "{repo}" + GitApplies.LOCKED_INFIX + "sandbox {sandbox:?}" + GitApplies.MOUNT_BEING_CREATED_SUFFIX.removeSuffix(GitApplies.NOTHING_WRITTEN) +
                "; nothing was written",
            rustFormat(gitApplyRs, "msg_mount_being_created"),
        )
        // W-N1 (review J-I4): the two direct_mount sandbox.create CONFLICT texts the create copy keys on.
        val createBusy = rustFormat(gitApplyRs, "msg_create_repo_busy")
        assertTrue(createBusy.startsWith("{repo}" + GitApplies.LOCKED_INFIX + "{holder} holds its writer lock"), createBusy)
        assertTrue(createBusy.endsWith(KeyedWrites.CREATE_REPO_BUSY_SUFFIX), createBusy)
        assertEquals(
            "{repo}" + GitApplies.LOCKED_INFIX + "sandbox {sandbox:?}" + KeyedWrites.CREATE_MOUNT_IN_PROGRESS_SUFFIX,
            rustFormat(gitApplyRs, "msg_create_mount_in_progress"),
        )
        val creator = Regex("""fn create_locked\([\s\S]*?\n\}""").find(gitApplyRs)?.value ?: fail("create_locked not found")
        assertTrue(creator.contains("msg_create_repo_busy(") && creator.contains("msg_create_mount_in_progress("), creator)
        assertTrue(creator.contains("ErrorCode::Conflict"), "a busy direct_mount create is no longer CONFLICT")
        // Both writer-lock texts are CONFLICT (W6, W-N1), chosen by the holder in `apply_locked`.
        val locker = Regex("""fn apply_locked\([\s\S]*?\n\}""").find(gitApplyRs)?.value ?: fail("apply_locked not found")
        assertTrue(locker.contains("msg_mount_being_created(") && locker.contains("msg_locked("), locker)
        assertTrue(locker.contains("ErrorCode::Conflict"), "the writer lock is no longer CONFLICT")
        assertTrue(gitApplyRs.contains(".map_err(|holder| apply_locked("), "apply no longer maps the lock holder through apply_locked")
        assertTrue(Regex("""ErrorCode::Conflict,\s*apply::msg_mounted\(""").containsMatchIn(gitApplyRs), "direct mounts are no longer CONFLICT")
        // The partial texts name `git status` (and index.lock) — the copy shows them verbatim.
        assertTrue(rustFormat(applyRs, "msg_write_failed").contains("check `git status` in {repo}"))
        assertTrue(applyRs.contains("`.git/index.lock` may remain"))
        assertTrue(rustFormat(applyRs, "msg_verify_unavailable").startsWith("could not verify the staged content"))
        assertTrue(rustFormat(applyRs, "msg_verify_failed").contains("check `git status` in {repo}"))
        // MSG_CHECK_UNAVAILABLE is distinct from "does not apply cleanly" (I3).
        assertFalse(GitApplies.MSG_CHECK_UNAVAILABLE.contains("does not apply cleanly"))
    }

    /** Feature, limits, deadline, wire shapes and event kinds of A6. */
    @Test
    fun gitApplyShapesLimitsDeadlineAndEventsMatchCore() {
        assertTrue(labs.dkv.sandpane.model.CoreFeatures.KNOWN.contains("git-apply"))
        assertEquals(labs.dkv.sandpane.model.CoreFeatures.GIT_APPLY, "git-apply")
        assertEquals(36, CoreMethods.ALL.size, "A6 added no method (A7 added six, A9 two more)")
        val max = Regex("""pub const MAX_APPLY_ENTRIES: usize = (\d+);""").find(applyRs)?.groupValues?.get(1)?.toInt()
            ?: fail("apply.rs has no MAX_APPLY_ENTRIES")
        assertEquals(max, GitApplies.MAX_ENTRIES)
        fun secs(name: String) = Regex("""pub const $name: Duration = Duration::from_secs\((\d+)\);""").find(applyRs)
            ?.groupValues?.get(1)?.toInt() ?: fail("apply.rs has no $name")
        assertEquals(secs("CLIENT_APPLY_DEADLINE") * 1000, MethodDeadlines.GIT_APPLY_MS)
        val verify = Regex("""verify_budget: Duration::from_secs\((\d+)\)""").find(applyRs)?.groupValues?.get(1)?.toInt()
            ?: fail("apply.rs has no default verify_budget")
        val coreTotal = (secs("APPLY_PREPARE_BUDGET") + secs("APPLY_WRITE_TIMEOUT") + verify) * 1000
        assertTrue(coreTotal < MethodDeadlines.GIT_APPLY_MS, "Core's apply budget ($coreTotal ms) no longer fits the client deadline")
        assertEquals(MethodDeadlines.GIT_APPLY_MS, MethodDeadlines.forMethod(CoreMethods.GIT_APPLY, 15_000))
        // Wire shapes.
        fun fields(struct: String) = (Regex("""pub struct $struct \{([\s\S]*?)\n\}""").find(rust)?.groupValues?.get(1)
            ?: fail("$struct not found")).let { body -> Regex("""pub ([a-z_]+):""").findAll(body).map { it.groupValues[1] }.toList() }
        assertEquals(listOf("task_id", "selected_files", "expected_base", "review_id", "entries"), fields("GitApplyParams"))
        assertEquals(listOf("path", "status", "old_path", "task_blob", "task_mode"), fields("FileChange"))
        assertEquals(
            listOf("applied", "abort_reason", "conflicted_files", "applied_files", "mode_changes", "snapshot_tree", "partial"),
            fields("ApplyResult"),
        )
        assertEquals(listOf("path", "from", "to"), fields("ModeChange"))
        val changeSet = fields("ChangeSet")
        assertTrue(changeSet.containsAll(listOf("review_id", "host_hooks_path")), changeSet.toString())
        for (f in listOf("taskBlob", "taskMode", "reviewId", "hostHooksPath", "appliedFiles", "modeChanges", "snapshotTree")) {
            assertTrue(kotlinMirror.contains("@SerialName(\"$f\")"), "Kotlin mirror lacks $f")
        }
        assertFalse(kotlinMirror.contains("@SerialName(\"selectedFiles\")"), "selectedFiles must not be sendable")
        // Durable event kinds, appended through constants the old `log.append(…"kind")` probe cannot see.
        for ((name, kind) in listOf(
            "EVENT_APPLY_STARTED" to labs.dkv.sandpane.model.CoreEventKinds.GIT_APPLY_STARTED,
            "EVENT_APPLIED" to labs.dkv.sandpane.model.CoreEventKinds.GIT_APPLIED,
            "EVENT_APPLY_FAILED" to labs.dkv.sandpane.model.CoreEventKinds.GIT_APPLY_FAILED,
            "EVENT_APPLY_RECONCILED" to labs.dkv.sandpane.model.CoreEventKinds.GIT_APPLY_RECONCILED,
        )) {
            assertEquals(rustStringConst(gitApplyRs, name), kind, name)
            assertTrue(labs.dkv.sandpane.model.CoreEventKinds.ALL.contains(kind))
        }
        // git.apply is never replay-safe: Core's replay-safe set does not name it.
        assertFalse(Regex("""replay_safe[\s\S]{0,400}GitApply""").containsMatchIn(rust + service), "git.apply became replay-safe")
    }

    // ------------------------------------------------------------------
    // A7: verification commands + project.context (design 2026-10-09 \u00A73.7)
    // ------------------------------------------------------------------

    private val verificationSvc by lazy { read("core/crates/sandpane-service/src/verification.rs") }
    private val verificationCore by lazy { read("core/crates/sandpane-core/src/verification.rs") }
    private val contextCore by lazy { read("core/crates/sandpane-core/src/context.rs") }
    private val verificationSchema by lazy { read("schemas/verification.schema.json") }
    private val contextSchema by lazy { read("schemas/project-context.schema.json") }
    private val taskEventSchema by lazy { read("schemas/task-event.schema.json") }

    /** Every Core message the A7 copy keys on is Core's constant, byte for byte. */
    @Test
    fun verificationMessagesMatchCore() {
        val svc = listOf(
            "MSG_VERIFICATION_NOT_BOUND" to Verifications.MSG_NOT_BOUND,
            "MSG_VERIFICATION_SANDBOX_CHANGED" to Verifications.MSG_SANDBOX_CHANGED,
            "MSG_VERIFICATION_IDENTITY" to Verifications.MSG_IDENTITY,
            "MSG_VERIFICATION_TASK_BUSY" to Verifications.MSG_TASK_BUSY,
            "MSG_VERIFICATION_SANDBOX_BUSY" to Verifications.MSG_SANDBOX_BUSY,
            "MSG_VERIFICATION_CORE_BUSY" to Verifications.MSG_CORE_BUSY,
            "MSG_VERIFICATION_SHUTTING_DOWN" to Verifications.MSG_SHUTTING_DOWN,
            "MSG_COMMAND_NOT_FOUND" to Verifications.MSG_COMMAND_NOT_FOUND,
            "MSG_COMMAND_REVOKED" to Verifications.MSG_COMMAND_REVOKED,
            "MSG_COMMAND_OTHER_PROJECT" to Verifications.MSG_COMMAND_OTHER_PROJECT,
            "MSG_RUN_NOT_FOUND" to Verifications.MSG_RUN_NOT_FOUND,
            "MSG_TASK_NOT_FOUND" to Verifications.MSG_TASK_NOT_FOUND,
            "MSG_TOO_MANY_COMMANDS" to Verifications.MSG_TOO_MANY_COMMANDS,
            "MSG_VERSION_UNREADABLE" to Verifications.MSG_VERSION_UNREADABLE,
            "MSG_PROJECT_VERIFICATION_RUNNING" to Verifications.MSG_PROJECT_VERIFICATION_RUNNING,
            "MSG_CONVERSATION_VERIFICATION_RUNNING" to Verifications.MSG_CONVERSATION_VERIFICATION_RUNNING,
            "MSG_SANDBOX_VERIFICATION_RUNNING" to Verifications.MSG_SANDBOX_VERIFICATION_RUNNING,
            "MSG_COMMAND_NO_LONGER_PASSES" to Verifications.MSG_COMMAND_NO_LONGER_PASSES,
            "MSG_RUN_SECRET_CHECK_UNAVAILABLE" to Verifications.MSG_RUN_SECRET_CHECK_UNAVAILABLE,
        )
        for ((name, kotlin) in svc) assertEquals(rustStringConst(verificationSvc, name), kotlin, "$name drifted from verification.rs")
        // Every message const Core declares there is mirrored (a new refusal must not ship unworded).
        val rustNames = Regex("""pub const (MSG_[A-Z_]+): &str""").findAll(verificationSvc).map { it.groupValues[1] }.toSet()
        assertEquals(svc.map { it.first }.toSet(), rustNames, "verification.rs gained or lost a message const")
        assertEquals(rustStringConst(verificationCore, "MSG_SECRET_CHECK_UNAVAILABLE"), Verifications.MSG_SECRET_CHECK_UNAVAILABLE)
        assertEquals(rustStringConst(verificationCore, "SECRET_REFUSAL_HINT"), Verifications.SECRET_REFUSAL_HINT)
        assertTrue(verificationSvc.contains("serde_json::json!({ \"hint\": vcore::SECRET_REFUSAL_HINT })"), "the hint left details.hint")
        // The templates the copy matches by prefix / suffix.
        assertEquals(
            Verifications.EXEC_UNVERIFIED_PREFIX + "{version}" + Verifications.EXEC_UNVERIFIED_SUFFIX,
            rustFormat(verificationSvc, "msg_exec_unverified"),
        )
        assertEquals(
            Verifications.NOT_RUNNING_PREFIX.replace("\"", "\\\"") + "{name}" + Verifications.NOT_RUNNING_SUFFIX.replace("\"", "\\\""),
            rustFormat(verificationSvc, "msg_sandbox_not_running"),
        )
        assertEquals("{repo} is busy: {holder}" + Verifications.REPO_BUSY_SUFFIX, rustFormat(verificationSvc, "msg_verification_repo_busy"))
        assertEquals(
            Verifications.SHAPE_NO_LONGER_PASSES_PREFIX + "{why}" + Verifications.SHAPE_NO_LONGER_PASSES_SUFFIX,
            rustFormat(verificationSvc, "msg_command_shape_no_longer_passes"),
        )
        // The secret-refusal templates live in match arms; pinned by their fixed parts.
        assertTrue(verificationCore.contains("\"argument {number} looks like a secret ({}); approved commands cannot hold \\"))
        assertTrue(verificationCore.contains("\"the label looks like a secret ({}); approved commands cannot hold secrets; \\"))
        assertTrue(verificationCore.contains("\"the arguments together look like a secret ({}); approved commands cannot hold \\"))
        assertTrue(
            Regex("""secrets; nothing was approved""").findAll(verificationCore.substringBefore("#[cfg(test)]")).count() >= 3,
            "a secret-refusal template changed its ending",
        )
        assertTrue(Verifications.isSecretRefusal("argument 3 looks like a secret (token); approved commands cannot hold secrets; nothing was approved"))
        assertTrue(Verifications.isSecretRefusal("the label looks like a secret (auth-header); approved commands cannot hold secrets; nothing was approved"))
        // The frame refusal.
        assertTrue(verificationSvc.contains("\"the response would exceed the frame limit ({bytes} bytes, the limit is \\"))
        assertTrue(verificationSvc.contains("{MAX_RESPONSE_BYTES}); {what}; nothing was returned\""))
        // The argv shape messages Core prefixes with "argv: " / "label: ".
        assertTrue(verificationSvc.contains("invalid(format!(\"label: {e}\"))"))
        assertTrue(verificationSvc.contains("invalid(format!(\"argv: {e}\"))"))
        assertTrue(validation.contains("return shape(format!(\"argument {n} contains a control character\"));"))
        // The three delete refusals are CONFLICT at their use sites.
        assertTrue(Regex("""ErrorCode::Conflict,\s*MSG_SANDBOX_VERIFICATION_RUNNING\.to_string\(\)""").containsMatchIn(service))
        assertTrue(Regex("""ErrorCode::Conflict,\s*crate::MSG_CONVERSATION_VERIFICATION_RUNNING\.to_string\(\)""").containsMatchIn(conversationLifecycle))
        assertTrue(projectLifecycle.contains("return Ok(Some(crate::MSG_PROJECT_VERIFICATION_RUNNING));"))
        // ... and each is worded "nothing was deleted" by this client.
        assertTrue(
            ProjectOutcomes.describeFailure(
                CoreMethods.PROJECT_DELETE,
                CoreRpcException(CoreErrorCodes.CONFLICT, Verifications.MSG_PROJECT_VERIFICATION_RUNNING),
                true,
            ).body.contains("nothing was deleted"),
        )
        assertTrue(
            ConversationOutcomes.describeFailure(
                CoreMethods.CONVERSATION_DELETE,
                CoreRpcException(CoreErrorCodes.CONFLICT, Verifications.MSG_CONVERSATION_VERIFICATION_RUNNING),
                true,
            ).body.contains("nothing was deleted"),
        )
        // UNSUPPORTED_SBX_VERSION is the version gate's code.
        assertTrue(Regex("""ErrorCode::UnsupportedSbxVersion,\s*[\s\S]{0,80}msg_exec_unverified\(""").containsMatchIn(verificationSvc) ||
            Regex("""UnsupportedSbxVersion[\s\S]{0,200}msg_exec_unverified""").containsMatchIn(verificationSvc),
            "the version gate no longer raises UNSUPPORTED_SBX_VERSION with msg_exec_unverified")
    }

    /** Feature, outcomes, wire shapes (field order), limits, event kinds and the deadline of A7. */
    @Test
    fun verificationShapesOutcomesEventsAndDeadlineMatchCore() {
        assertEquals("verification", labs.dkv.sandpane.model.CoreFeatures.VERIFICATION)
        assertEquals(7, labs.dkv.sandpane.model.CoreFeatures.KNOWN.size)
        fun fields(struct: String) = (Regex("""pub struct $struct \{([\s\S]*?)\n\}""").find(rust)?.groupValues?.get(1)
            ?: fail("$struct not found")).let { body -> Regex("""pub ([a-z_]+):""").findAll(body).map { it.groupValues[1] }.toList() }
        assertEquals(listOf("id", "project_id", "label", "argv", "approved_at"), fields("VerificationCommand"))
        assertEquals(listOf("project_id"), fields("VerificationListParams"))
        assertEquals(listOf("commands"), fields("VerificationListResult"))
        assertEquals(listOf("project_id", "label", "argv"), fields("VerificationApproveParams"))
        assertEquals(listOf("command"), fields("VerificationApproveResult"))
        assertEquals(listOf("command_id"), fields("VerificationRevokeParams"))
        assertEquals(listOf("revoked"), fields("VerificationRevokeResult"))
        assertEquals(
            listOf("task_id", "command_id", "expected_sandbox_name", "expected_workspace_mode", "idempotency_key"),
            fields("VerificationRunParams"),
        )
        assertTrue(rust.contains("pub expected_workspace_mode: WorkspaceMode,"))
        assertEquals(listOf("run_id", "started_sequence", "replayed"), fields("VerificationRunResult"))
        assertEquals(listOf("run_id"), fields("VerificationResultParams"))
        assertEquals(listOf("best_effort", "replacements", "by_kind", "output_withheld"), fields("OutputRedaction"))
        assertEquals(
            listOf(
                "run_id", "task_id", "command_id", "label", "argv", "sandbox", "workspace_mode", "outcome", "exit_code",
                "stdout", "stderr", "stdout_truncated", "stderr_truncated", "redactions", "elapsed_ms", "started_at",
                "finished_at", "output_incomplete", "output_pruned",
            ),
            fields("VerificationResult"),
        )
        assertTrue(rust.contains("pub outcome: String,"), "outcome is no longer an open string")
        assertEquals(listOf("project_id"), fields("ProjectContextParams"))
        assertEquals(listOf("manifest", "suggested_commands", "notes"), fields("DetectedManifest"))
        assertEquals(listOf("repo_path", "detected", "unreadable"), fields("RepositoryContext"))
        assertEquals(listOf("repositories", "approved"), fields("ProjectContextResult"))
        // The Kotlin run params serialize in that order (the A2 fingerprint order), key omitted when null.
        val run = CoreJson.encodeToJsonElement(
            labs.dkv.sandpane.model.VerificationRunParams.serializer(),
            labs.dkv.sandpane.model.VerificationRunParams("t", "c", "atlas-demo", labs.dkv.sandpane.model.WorkspaceMode.DIRECT_MOUNT, "k"),
        ) as kotlinx.serialization.json.JsonObject
        assertEquals(listOf("taskId", "commandId", "expectedSandboxName", "expectedWorkspaceMode", "idempotencyKey"), run.keys.toList())
        // Outcomes: Core's constants are the set this client words.
        val outcomes = Regex("""pub const OUTCOME_[A-Z_]+: &str = "([a-z_]+)";""").findAll(verificationCore).map { it.groupValues[1] }.toList()
        assertEquals(Verifications.KNOWN_OUTCOMES, outcomes)
        // Event kinds, appended through constants.
        assertEquals(rustStringConst(verificationSvc, "EVENT_VERIFICATION_STARTED"), labs.dkv.sandpane.model.CoreEventKinds.VERIFICATION_STARTED)
        assertEquals(rustStringConst(verificationSvc, "EVENT_VERIFICATION_FINISHED"), labs.dkv.sandpane.model.CoreEventKinds.VERIFICATION_FINISHED)
        assertTrue(labs.dkv.sandpane.model.CoreEventKinds.ALL.containsAll(labs.dkv.sandpane.model.CoreEventKinds.VERIFICATION))
        assertTrue(taskEventSchema.contains("verification.started") && taskEventSchema.contains("verification.finished"))
        // Limits the client mirrors for early feedback only (never stricter).
        fun usize(src: String, name: String) = Regex("""pub const $name: usize = ([0-9_ *]+);""").find(src)?.groupValues?.get(1)
            ?.split("*")?.map { it.trim().replace("_", "").toInt() }?.fold(1) { a, b -> a * b } ?: fail("no $name")
        assertEquals(usize(validation, "MAX_VERIFICATION_ARGS"), VerificationGuards.MAX_ARGS)
        assertEquals(usize(validation, "MAX_VERIFICATION_ARG_BYTES"), VerificationGuards.MAX_ARG_BYTES)
        assertEquals(usize(validation, "MAX_VERIFICATION_ARGV_BYTES"), VerificationGuards.MAX_ARGV_BYTES)
        assertTrue(verificationSvc.contains("pub const MAX_COMMANDS_PER_PROJECT: i64 = 50;"))
        // The copy's "64 KiB" and "10 minutes" are Core's RunLimits::VERIFICATION.
        val processRs = read("core/crates/sandpane-core/src/process.rs")
        val limits = Regex("""pub const VERIFICATION: RunLimits = RunLimits \{([\s\S]*?)\};""").find(processRs)?.groupValues?.get(1)
            ?: fail("RunLimits::VERIFICATION not found")
        assertTrue(limits.contains("Duration::from_secs(${Verifications.TIMEOUT_MINUTES * 60})"), limits)
        assertEquals(2, Regex("""${Verifications.MAX_OUTPUT_KIB} \* 1024""").findAll(limits).count(), limits)
        // Deadlines: project.context reads files (the 45 s git deadline). verification.run gates on
        // `sbx version` (RunLimits::PROBE) and the sandbox identity (RunLimits::QUERY) synchronously
        // BEFORE its durable start, so its floor must outlast PROBE + QUERY; the other four use the default.
        assertEquals(45_000, MethodDeadlines.PROJECT_CONTEXT_MS)
        assertEquals(45_000, MethodDeadlines.forMethod(CoreMethods.PROJECT_CONTEXT, 15_000))
        fun limitSecs(name: String): Int =
            Regex("""pub const $name: RunLimits = RunLimits \{\s*timeout: Duration::from_secs\((\d+)\)""").find(processRs)
                ?.groupValues?.get(1)?.toInt() ?: fail("process.rs has no RunLimits::$name with a from_secs timeout")
        val gates = (limitSecs("PROBE") + limitSecs("QUERY")) * 1000
        val start = verificationSvc.indexOf("let run_id = uuid::Uuid::new_v4()")
        assertTrue(start > 0, "verification.run's durable start (run_id) is no longer where this test looks")
        val version = verificationSvc.lastIndexOf("version_gate(inner, &program, &ctx)?;", start)
        val identity = verificationSvc.lastIndexOf("identity_gate(inner, &program, &ctx, &plan)?;", start)
        assertTrue(version in 0 until start && identity in 0 until start, "Core's run gates moved; re-derive the run deadline")
        assertEquals(45_000, MethodDeadlines.VERIFICATION_RUN_MS)
        assertTrue(MethodDeadlines.VERIFICATION_RUN_MS > gates, "the run floor (${MethodDeadlines.VERIFICATION_RUN_MS} ms) no longer outlasts Core's gates ($gates ms)")
        assertEquals(45_000, MethodDeadlines.forMethod(CoreMethods.VERIFICATION_RUN, 15_000))
        assertEquals(120_000, MethodDeadlines.forMethod(CoreMethods.VERIFICATION_RUN, 120_000), "a longer user setting still wins")
        for (m in CoreMethods.ADDITIVE_A7 - CoreMethods.PROJECT_CONTEXT - CoreMethods.VERIFICATION_RUN) {
            assertEquals(15_000, MethodDeadlines.forMethod(m, 15_000), m)
        }
        // Read-only classification: list / result / context; approve / revoke / run are writes.
        assertEquals(setOf("verification.list", "verification.result", "project.context"), CoreMethods.VERIFICATION_READ_ONLY)
        // Never replay-safe in Core's own sense.
        assertFalse(Regex("""replay_safe[\s\S]{0,400}Verification""").containsMatchIn(rust + service), "a verification method became replay-safe")
        // Schemas carry the new shapes.
        assertTrue(verificationSchema.contains("\"outputWithheld\"") && verificationSchema.contains("\"outputIncomplete\""))
        assertTrue(contextSchema.contains("\"suggestedCommands\"") && contextSchema.contains("\"unreadable\""))
        // project.context notes Core always adds; the client shows them in full (capped at Core's 512 bytes).
        assertEquals(512, Regex("""pub const MAX_NOTE_BYTES: usize = (\d+);""").find(contextCore)?.groupValues?.get(1)?.toInt())
        assertTrue(Verifications.MAX_ITEM_CODE_POINTS >= 512, "a note Core sends must never be cut by the client")
    }

    /** A4 (\u00A73.4): the mode values, the normalisation and the exact refusal are Core's. */
    @Test
    fun sendModeValuesAndMessageMatchCore() {
        val msg = Regex("""pub const MSG_SEND_MODE_INVALID: &str = r#"(.*?)"#;""").find(service)?.groupValues?.get(1)
            ?: fail("MSG_SEND_MODE_INVALID not found")
        assertEquals(msg, SendModes.MSG_SEND_MODE_INVALID)
        assertTrue(service.contains("SendMode::Task => \"task\""), "Core's task spelling changed")
        assertTrue(service.contains("SendMode::Discuss => \"discuss\""), "Core's discuss spelling changed")
        assertTrue(service.contains("None | Some(\"task\") => SendMode::Task"), "Core no longer treats absent and \"task\" alike")
        assertTrue(service.contains("Some(\"discuss\") => SendMode::Discuss"))
        assertEquals(listOf("task", "discuss"), SendModes.WIRE_VALUES)
        assertTrue(Regex("""pub struct ConversationSendParams \{[\s\S]*?skip_serializing_if = "Option::is_none"\)\]\s*pub mode: Option<String>,""").containsMatchIn(rust))
        val summary = Regex("""pub struct TaskSummary \{([\s\S]*?)\n\}""").find(rust)?.groupValues?.get(1) ?: fail("TaskSummary not found")
        assertTrue(Regex("""#\[serde\(default, skip_serializing_if = "Option::is_none"\)\]\s*pub mode: Option<String>""").containsMatchIn(summary))
        assertTrue(Regex("""#\[serde\(default, skip_serializing_if = "Option::is_none"\)\]\s*pub chosen_sandbox_name: Option<String>""").containsMatchIn(summary))
        assertTrue(summary.contains("pub sandbox_name: Option<String>"), "sandboxName (the binding) must stay a separate field")
        // The sandbox.remove impact line the dialog test renders (illustrative fixture) is still Core's wording.
        assertTrue(service.contains("unfinished task(s) were sent from chats that chose this sandbox name; \\"))
        assertTrue(service.contains("removing it does not cancel them"))
    }

    /** Joins a Rust string literal that uses `\`-newline continuations, as rustc does. */
    private fun rustStringConst(source: String, name: String): String {
        val m = Regex("""pub const $name: &str =\s*"((?:[^"\\]|\\[\s\S])*)";""").find(source)
            ?: fail("no `pub const $name: &str = \"...\";`")
        return m.groupValues[1].replace(Regex("""\\\n\s*"""), "")
    }

    /** A2: the CONFLICT texts the client matches are exactly the ones Core sends. */
    @Test
    fun keyedConflictMessagesMatchCore() {
        assertEquals(rustStringConst(service, "IDEM_MSG_MISMATCH"), KeyedWrites.CONFLICT_MISMATCH)
        assertEquals(rustStringConst(service, "IDEM_MSG_PENDING"), KeyedWrites.CONFLICT_PENDING)
        val unknown = rustStringConst(service, "IDEM_MSG_UNKNOWN")
        assertTrue(unknown.startsWith(KeyedWrites.CONFLICT_UNKNOWN_PREFIX), unknown)
        assertFalse(unknown.contains("nothing was run"), "Core's unknown-outcome CONFLICT must not claim nothing ran")
        assertTrue(
            service.contains(
                "format!(\"${KeyedWrites.NAME_LOCK_PREFIX}{name:?}${KeyedWrites.NAME_LOCK_SUFFIX}\")",
            ),
            "A1's name-lock CONFLICT text changed",
        )
        assertTrue(KeyedWrites.CONFLICT_MISMATCH.endsWith("nothing was run"))
        assertTrue(KeyedWrites.CONFLICT_PENDING.endsWith("nothing was run"))
    }

    /** A2: the client key validator is exactly Core's (never stricter), and so is the schema pattern. */
    @Test
    fun idempotencyKeyRuleMatchesCore() {
        val fn = Regex("""pub fn idempotency_key\(key: &str\)[\s\S]*?\n    \}""").find(validation)?.value
            ?: fail("Validator::idempotency_key not found")
        assertTrue(fn.contains("Self::reported_token(key, 128,"), "Core's key length bound changed")
        assertTrue(fn.contains("c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'"), "Core's key charset changed")
        assertEquals(128, IdempotencyKeys.MAX_LEN)
        assertTrue(sandboxSpecSchema.contains("\"pattern\": \"^[A-Za-z0-9._-]{1,128}$\""), "schema key pattern changed")
    }

    // ------------------------------------------------------------------
    // enum-block helpers
    // ------------------------------------------------------------------

    /** A Rust `pub enum NAME { … }` body, with its preceding attribute cluster. */
    private fun enumBlock(name: String): String {
        val decl = rust.indexOf("pub enum $name")
        if (decl < 0) fail("sandpane-protocol has no `pub enum $name`")
        val attrs = rust.lastIndexOf("#[", decl)
        val start = if (attrs >= 0 && decl - attrs < 400) attrs else decl
        val end = rust.indexOf("\n}", decl)
        if (end < 0) fail("unterminated enum $name")
        return rust.substring(start, end)
    }

    private fun enumVariants(block: String): List<String> =
        Regex("""^\s{4}([A-Z][A-Za-z0-9]*)(,| \{)""", RegexOption.MULTILINE)
            .findAll(block).map { it.groupValues[1] }.toList()

    private fun String.toSnakeCase(): String =
        replace(Regex("([a-z0-9])([A-Z])"), "$1_$2").lowercase()
}
