package labs.dkv.sandpane.core

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
        Regex(""""([a-z]+\.[a-z]+)" =>""").findAll(rust).map { it.groupValues[1] }.toList()

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
        assertEquals(16, fromAll.size, "addition A1 advertises 16 methods")

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
        listOf("task.list", "conversation.list", "conversation.history", "sandbox.stop", "sandbox.remove").forEach { added ->
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
            rust.contains("pub const ALL: [Method; 16]"),
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
