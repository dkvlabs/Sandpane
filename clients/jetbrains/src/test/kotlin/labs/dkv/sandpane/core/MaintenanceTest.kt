package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreFeatures
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.MAINTENANCE_CONFLICT_TITLE
import labs.dkv.sandpane.model.MAINTENANCE_LOST_STEP2_TITLE
import labs.dkv.sandpane.model.MaintenanceCleanupResult
import labs.dkv.sandpane.model.MaintenanceGuards
import labs.dkv.sandpane.model.MaintenanceItem
import labs.dkv.sandpane.model.maintenanceOutcomeHeadline
import labs.dkv.sandpane.model.maintenanceSizeText
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException

/**
 * A9 maintenance (design 2026-10-09 §3.9) in the JetBrains client: the models round-trip, the
 * selection defaults, the honesty copy, the wrapper guards (nothing invalid reaches the
 * transport; the feature gates everything), the deadline floor, and the drift pins against the
 * Rust protocol crate and the shipped schema.
 */
class MaintenanceTest {

    private fun caps(vararg methods: String, features: List<String> = emptyList()): CoreCapabilities = CoreCapabilities(
        protocolVersion = 1,
        coreVersion = "0.1.0",
        instanceId = "test-instance",
        platform = "macos",
        methods = methods.toList(),
        features = features,
    )

    private val a9Caps: CoreCapabilities =
        caps(*CoreMethods.ALL.toTypedArray(), features = CoreFeatures.KNOWN)

    private fun repoRoot(): File {
        System.getProperty("sandpane.repo.root")?.takeIf { it.isNotBlank() }?.let { override ->
            val given = File(override).canonicalFile
            if (File(given, "core/crates/sandpane-protocol/src/lib.rs").isFile) return given
        }
        var dir: File? = File(System.getProperty("user.dir")).canonicalFile
        while (dir != null) {
            if (File(dir, "core/crates/sandpane-protocol/src/lib.rs").isFile) return dir
            dir = dir.parentFile
        }
        error("cannot find the repository root above ${System.getProperty("user.dir")}")
    }

    /** The cause of a failed future (guards fail the future, they do not throw synchronously). */
    private fun failureOf(future: CompletableFuture<*>): Throwable = try {
        future.get()
        error("the call completed although it should have been refused")
    } catch (e: ExecutionException) {
        e.cause ?: e
    }

    /** Records every frame; answers from a script of (method → payload). */
    private class ScriptedRpc : CoreRpc {
        val sent = ArrayList<Pair<String, JsonElement>>()
        var answers: MutableMap<String, (JsonElement) -> JsonElement> = HashMap()
        var failures: MutableMap<String, CoreRpcException> = HashMap()
        override fun request(method: String, params: JsonElement): CompletableFuture<JsonElement> {
            sent.add(method to params)
            failures[method]?.let { return CompletableFuture.failedFuture(it) }
            val answer = answers[method] ?: return CompletableFuture.completedFuture(JsonObject(emptyMap()))
            return CompletableFuture.completedFuture(answer(params))
        }
    }

    private fun commands(rpc: CoreRpc, caps: CoreCapabilities?): CoreCommands = CoreCommands(rpc) { caps }

    // -----------------------------------------------------------------------
    // Models
    // -----------------------------------------------------------------------

    @Test
    fun inventoryAndCleanupAnswersRoundTrip() {
        val inventory = CoreJson.decodeFromJsonElement(
            labs.dkv.sandpane.model.MaintenanceInventoryResult.serializer(),
            CoreJson.parseToJsonElement(
                """
                {"items":[{"id":"temp:u","kind":"temp","removable":true,"detail":"d"}],
                 "truncated":false}
                """.trimIndent(),
            ),
        )
        assertEquals(1, inventory.items.size)
        assertTrue(inventory.items[0].removable)
        assertNull(inventory.items[0].bytes)
        assertTrue(inventory.unavailable.isEmpty())

        val confirmation = CoreJson.decodeFromJsonElement(
            MaintenanceCleanupResult.serializer(),
            CoreJson.parseToJsonElement(
                """
                {"confirmation":{"token":"${"a".repeat(64)}","expiresAt":"2100-01-01T00:00:00Z",
                 "action":"maintenance.cleanup","target":{"items":["temp:u"]},
                 "impact":["one item"],"external":false}}
                """.trimIndent(),
            ),
        )
        assertEquals(listOf("temp:u"), confirmation.confirmation?.target?.items)

        val outcome = CoreJson.decodeFromJsonElement(
            MaintenanceCleanupResult.serializer(),
            CoreJson.parseToJsonElement(
                """{"removed":["temp:u"],"skipped":[{"id":"x","reason":"no longer present"}],"freedBytes":0}""".trimIndent(),
            ),
        )
        assertNull(outcome.confirmation)
        assertEquals(listOf("temp:u"), outcome.removed)
        assertEquals(1, outcome.skipped?.size)
    }

    @Test
    fun selectionDefaultsCheckRemovableTempAndVerificationOutputOnly() {
        fun item(kind: String, removable: Boolean) =
            MaintenanceItem(id = "i-$kind", kind = kind, removable = removable, detail = "d")
        assertTrue(item("temp", true).checkedByDefault)
        assertTrue(item("verificationOutput", true).checkedByDefault)
        // Backups are the way back to an older Core: unchecked by default.
        assertFalse(item("dbBackup", true).checkedByDefault)
        // Worktrees are report-only in A9, so only the non-removable case occurs (below).
        // Unknown kinds and non-removable items are never checked.
        assertFalse(item("futureKind", true).checkedByDefault)
        assertFalse(item("temp", false).checkedByDefault)
    }

    @Test
    fun headlineNeverSaysAllCleanWhenSomethingWasSkipped() {
        val partial = MaintenanceCleanupResult(
            removed = listOf("a"),
            skipped = listOf(labs.dkv.sandpane.model.MaintenanceSkipped("b", "no longer present")),
        )
        assertEquals("Removed 1 of 2 confirmed items; 1 were not removed.", maintenanceOutcomeHeadline(partial, 2))
        val all = MaintenanceCleanupResult(removed = listOf("a", "b"), skipped = emptyList())
        assertEquals("Removed all 2 confirmed items.", maintenanceOutcomeHeadline(all, 2))
    }

    @Test
    fun sizesAndCopyAreTheCrossClientWording() {
        assertNull(maintenanceSizeText(MaintenanceItem("i", "temp", true, "d")))
        assertEquals("2 KiB", maintenanceSizeText(MaintenanceItem("i", "temp", true, "d", bytes = 2048)))
        assertEquals(
            "Another maintenance scan or cleanup is running; try again shortly",
            MAINTENANCE_CONFLICT_TITLE,
        )
        assertEquals("Some items may have been removed — scan again", MAINTENANCE_LOST_STEP2_TITLE)
    }

    // -----------------------------------------------------------------------
    // Wrappers: guards, gating, wire shapes
    // -----------------------------------------------------------------------

    @Test
    fun featureGateRefusesBothMethodsWithoutTheMaintenanceFeature() {
        val rpc = ScriptedRpc()
        val a7Caps = caps(*CoreMethods.ALL.toTypedArray(), features = CoreFeatures.KNOWN.filter { it != CoreFeatures.MAINTENANCE })
        val commands = commands(rpc, a7Caps)
        val error = failureOf(commands.maintenanceInventory())
        assertTrue(error is MethodNotSupportedException, "got ${error::class.simpleName}")
        assertTrue(rpc.sent.isEmpty(), "nothing reaches the transport without the feature")
    }

    @Test
    fun invalidItemListsAreRefusedLocallyAndNeverSent() {
        val rpc = ScriptedRpc()
        val commands = commands(rpc, a9Caps)
        fun refuses(items: List<String>) {
            val error = failureOf(commands.maintenanceCleanupRequest(items))
            assertTrue(error is CoreValidationException, "expected a client guard, got ${error::class.simpleName}")
        }
        refuses(emptyList())
        refuses(listOf("a", "a"))
        refuses(List(MaintenanceGuards.MAX_CLEANUP_ITEMS + 1) { "temp:$it" })
        assertTrue(rpc.sent.isEmpty(), "an invalid list must never reach the transport")
    }

    @Test
    fun step1SendsItemsWithoutATokenStep2AddsTheToken() {
        val rpc = ScriptedRpc()
        val commands = commands(rpc, a9Caps)
        runCatching { commands.maintenanceCleanupRequest(listOf("temp:a", "temp:b")).get() }
        assertEquals(1, rpc.sent.size)
        val (method, payload) = rpc.sent[0]
        assertEquals(CoreMethods.MAINTENANCE_CLEANUP, method)
        val obj = payload.jsonObject
        assertEquals(listOf("temp:a", "temp:b"), obj["items"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertFalse(obj.containsKey("confirmToken"), "step 1 must not carry a token")

        runCatching {
            commands.maintenanceCleanupConfirm(listOf("temp:a", "temp:b"), "c".repeat(64)).get()
        }
        val step2 = rpc.sent[1].second.jsonObject
        assertEquals("c".repeat(64), step2["confirmToken"]!!.jsonPrimitive.content)

        // A malformed token is refused locally; the token never appears in the refusal.
        val tokenError = failureOf(commands.maintenanceCleanupConfirm(listOf("temp:a"), "nope"))
        assertTrue(tokenError is CoreValidationException)
        assertFalse(tokenError.message!!.contains("nope"), "the token never appears in a refusal")
    }

    @Test
    fun theDeadlineFloorIsAtLeast20SecondsForBothMethods() {
        assertTrue(MethodDeadlines.MAINTENANCE_MS >= 20_000)
        assertEquals(MethodDeadlines.MAINTENANCE_MS, MethodDeadlines.forMethod(CoreMethods.MAINTENANCE_INVENTORY, 15_000))
        assertEquals(50_000, MethodDeadlines.forMethod(CoreMethods.MAINTENANCE_CLEANUP, 50_000), "a larger user setting wins")
    }

    // -----------------------------------------------------------------------
    // Drift pins against the Rust crate, the schema and plugin.xml
    // -----------------------------------------------------------------------

    @Test
    fun maintenanceMethodsSitAtTheEndOfThe36MethodAllowlist() {
        assertEquals(36, CoreMethods.ALL.size)
        assertEquals(listOf("maintenance.inventory", "maintenance.cleanup"), CoreMethods.ALL.takeLast(2))
        val rust = File(repoRoot(), "core/crates/sandpane-protocol/src/lib.rs").readText()
        assertTrue(
            rust.contains("pub const ALL: [Method; 36]"),
            "Method::ALL's declared length changed — update CoreMethods.ALL and this gate",
        )
        assertTrue(rust.contains("\"maintenance.inventory\" =>"), "Method::parse has no arm for maintenance.inventory")
        assertTrue(rust.contains("\"maintenance.cleanup\" =>"), "Method::parse has no arm for maintenance.cleanup")
    }

    @Test
    fun maintenanceIsTheSeventhKnownFeatureMatchingRustAndTheSchema() {
        assertEquals("maintenance", CoreFeatures.KNOWN.last())
        assertEquals(7, CoreFeatures.KNOWN.size)
        val rust = File(repoRoot(), "core/crates/sandpane-protocol/src/lib.rs").readText()
        val decl = Regex("""pub const FEATURES: \[&str; (\d+)\] = \[([^\]]*)\];""").find(rust)
            ?: error("no FEATURES")
        assertEquals(CoreFeatures.KNOWN, Regex(""""([^"]+)"""").findAll(decl.groupValues[2]).map { it.groupValues[1] }.toList())
        val schema = File(repoRoot(), "schemas/core-capabilities.schema.json").readText()
        assertTrue(schema.contains("\"maintenance\""), "the schema examples drifted")
    }

    @Test
    fun theActionIsRegisteredInPluginXml() {
        val pluginXml = File(repoRoot(), "clients/jetbrains/src/main/resources/META-INF/plugin.xml").readText()
        assertTrue(pluginXml.contains("labs.dkv.sandpane.actions.MaintenanceAction"))
    }

    @Test
    fun outputPrunedTakesPrecedenceOverTheTruncationDisclosures() {
        val result = labs.dkv.sandpane.model.VerificationResult(
            runId = "r",
            stdout = "",
            stderr = "",
            stdoutTruncated = true,
            stderrTruncated = true,
            outputIncomplete = true,
            outputPruned = true,
        )
        assertEquals(listOf("output removed by maintenance cleanup"), Verifications.disclosures(result))
    }
}
