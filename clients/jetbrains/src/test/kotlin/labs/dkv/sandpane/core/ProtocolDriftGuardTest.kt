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
    private val requestSchema by lazy { read("schemas/rpc-request.schema.json") }
    private val capabilitiesSchema by lazy { read("schemas/core-capabilities.schema.json") }
    private val sandboxSpecSchema by lazy { read("schemas/sandbox-create-spec.schema.json") }
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
        assertEquals(14, fromAll.size, "the discovery revision advertises 14 methods")

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
        listOf("task.list", "conversation.list", "conversation.history").forEach { added ->
            assertTrue(fromAll.contains(added), "Rust no longer advertises $added")
            assertTrue(CoreMethods.ALL.contains(added), "the Kotlin mirror dropped $added")
            assertTrue(rust.contains("=> \"$added\""), "as_str has no arm for $added")
        }
        listOf("shell.exec", "sbx.raw", "fs.read", "process.spawn").forEach { forbidden ->
            assertFalse(CoreMethods.isAllowlisted(forbidden), "$forbidden must never be callable")
        }
    }

    @Test
    fun methodAdvertisementIsDerivedNotHandWritten() {
        assertTrue(
            rust.contains("pub const ALL: [Method; 14]"),
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
        val block = enumBlock("WorkspaceMode")
        assertTrue(block.contains("rename_all = \"snake_case\""), "WorkspaceMode casing rule changed")
        val modes = enumVariants(block).map { it.toSnakeCase() }
        assertEquals(
            WorkspaceMode.entries.map { it.wireName },
            modes,
            "WorkspaceMode variants drifted between Rust and Kotlin",
        )
        assertEquals(
            modes,
            schemaStringEnum(sandboxSpecSchema, "workspaceMode"),
            "schemas/sandbox-create-spec.schema.json workspaceMode enum drifted",
        )

        val statuses = enumBlock("TaskStatus")
        assertTrue(statuses.contains("rename_all = \"snake_case\""))
        assertEquals(
            labs.dkv.sandpane.model.TaskStatus.entries.map { it.name.lowercase() },
            enumVariants(statuses).map { it.toSnakeCase() },
            "TaskStatus variants drifted between Rust and Kotlin",
        )
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
