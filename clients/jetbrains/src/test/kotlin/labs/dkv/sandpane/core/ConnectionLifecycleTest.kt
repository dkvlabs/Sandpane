package labs.dkv.sandpane.core

import labs.dkv.sandpane.core.FakeCoreServer.Reply
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.settings.SandpaneSettings
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Review bugs 2, 4 (integration half), 5 and W4 — driven over a REAL Unix-domain socket against
 * [FakeCoreServer], offline. Timing windows are chosen against the client's own constants: the
 * first backoff is 250 ms (+ ≤120 ms jitter) and the poll interval floor is 250 ms, so a
 * regression (a reconnect loop, a double schedule, a poll that never stops) produces several extra
 * connections/requests inside each observation window.
 */
class ConnectionLifecycleTest {

    private val closeables = ArrayList<AutoCloseable>()
    private val managers = ArrayList<ConnectionManager>()

    @AfterTest
    fun tearDown() {
        managers.forEach { runCatching { it.dispose() } }
        closeables.forEach { runCatching { it.close() } }
    }

    private fun server(
        perms: String = "rw-------",
        handler: (Int, String, JsonObject) -> Reply,
    ): FakeCoreServer = FakeCoreServer(perms, handler).also { closeables += it }

    private fun manager(server: FakeCoreServer): ConnectionManager {
        val settings = SandpaneSettings().apply {
            loadState(
                SandpaneSettings.State().apply {
                    socketPathOverride = server.socketPath.toString()
                    eventPollIntervalMs = SandpaneSettings.MIN_EVENT_POLL_MS
                    requestTimeoutMs = 2_000
                },
            )
        }
        return ConnectionManager(null).apply { settingsOverride = settings }.also { managers += it }
    }

    private fun awaitState(manager: ConnectionManager, timeoutMs: Long = 8_000, predicate: (ConnectionManager.State) -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate(manager.state)) return
            Thread.sleep(20)
        }
        fail("state never matched within ${timeoutMs}ms; last state: ${manager.state}")
    }

    /** Positive conditions are awaited (generous for CI); only "nothing more happens" uses a fixed window. */
    private fun awaitTrue(what: String, timeoutMs: Long = 8_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(20)
        }
        fail("never true within ${timeoutMs}ms: $what")
    }

    private fun probeOk(protocolVersion: Int = 1): Reply = Reply.Ok(FakeCoreServer.capabilities(protocolVersion))

    @Test
    fun versionMismatchIsTerminalAndNeverReconnectsOnItsOwn() {
        val core = server { _, method, _ ->
            if (method == CoreMethods.SYSTEM_PROBE) probeOk(protocolVersion = 2) else Reply.Hangup
        }
        val manager = manager(core)
        manager.connectAsync("test")
        awaitState(manager) { it is ConnectionManager.State.VersionMismatch }

        Thread.sleep(1_500) // ≥ 4 backoff periods of the old reconnect loop
        assertEquals(1, core.acceptCount, "a protocol mismatch must not be retried on a timer")
        assertIs<ConnectionManager.State.VersionMismatch>(manager.state)
    }

    @Test
    fun aDroppedHealthyConnectionReconnectsExactlyOnce() {
        val core = server { _, method, _ ->
            if (method == CoreMethods.SYSTEM_PROBE) probeOk() else Reply.Ok(JsonArray(emptyList()))
        }
        val manager = manager(core)
        manager.connectAsync("test")
        awaitState(manager) { it is ConnectionManager.State.Ready }
        assertEquals(1, core.acceptCount)

        core.dropAllConnections()
        awaitState(manager) { it is ConnectionManager.State.Unavailable }
        awaitState(manager) { it is ConnectionManager.State.Ready }

        Thread.sleep(1_200)
        assertEquals(2, core.acceptCount, "one drop → one new connection, no overlapping attempts")
        assertIs<ConnectionManager.State.Ready>(manager.state)
        assertNull(manager.connectionProblem())
    }

    @Test
    fun aProbeFailureSchedulesOneRetryNotTwo() {
        // First connection: hang up on the probe (probe fails AND the socket closes — the old code
        // scheduled a retry for each). Later connections: healthy.
        val core = server { connection, method, _ ->
            when {
                connection == 0 -> Reply.Hangup
                method == CoreMethods.SYSTEM_PROBE -> probeOk()
                else -> Reply.Ok(JsonArray(emptyList()))
            }
        }
        val manager = manager(core)
        manager.connectAsync("test")
        awaitState(manager) { it is ConnectionManager.State.Ready }

        Thread.sleep(1_200)
        assertEquals(2, core.acceptCount, "a failed handshake must produce exactly one retry")
        assertIs<ConnectionManager.State.Ready>(manager.state)
    }

    @Test
    fun repeatedConnectRequestsWhileReadyDoNotOpenASecondSocket() {
        val core = server { _, method, _ ->
            if (method == CoreMethods.SYSTEM_PROBE) probeOk() else Reply.Ok(JsonArray(emptyList()))
        }
        val manager = manager(core)
        manager.connectAsync("first")
        awaitState(manager) { it is ConnectionManager.State.Ready }
        repeat(5) { manager.connectAsync("tool window activated again") }
        Thread.sleep(500)
        assertEquals(1, core.acceptCount)
    }

    @Test
    fun reconnectRetiresTheOldSocketAndOpensExactlyOneNewOne() {
        val core = server { _, method, _ ->
            if (method == CoreMethods.SYSTEM_PROBE) probeOk() else Reply.Ok(JsonArray(emptyList()))
        }
        val manager = manager(core)
        manager.connectAsync("first")
        awaitState(manager) { it is ConnectionManager.State.Ready }
        manager.reconnect("socket override changed")
        Thread.sleep(1_200)
        assertEquals(2, core.acceptCount, "the retired socket's close must not trigger a third connection")
        assertIs<ConnectionManager.State.Ready>(manager.state)
    }

    @Test
    fun aSocketWithGroupOrOtherBitsIsRefusedBeforeConnecting() {
        val core = server(perms = "rw-rw-rw-") { _, _, _ -> probeOk() }
        val manager = manager(core)
        manager.connectAsync("test")
        awaitState(manager) { it is ConnectionManager.State.Unavailable }
        val state = manager.state as ConnectionManager.State.Unavailable
        assertTrue(state.reason.contains("refused by this plugin before connecting"), state.reason)
        assertTrue(state.reason.contains("group/other"), state.reason)
        assertEquals(0, core.acceptCount, "not a single byte may reach an untrusted socket")
    }

    @Test
    fun anOversizedPerTaskReplayStopsThatStreamsPollingAndDoesNotBlockDiscovery() {
        val core = server { _, method, params ->
            when (method) {
                CoreMethods.SYSTEM_PROBE -> probeOk()
                CoreMethods.TASK_SUBSCRIBE ->
                    if ((params["taskId"] as? JsonPrimitive)?.content == "task-big") {
                        Reply.Err("VALIDATION_FAILED", FakeCoreServer.OVERSIZED_REPLAY_MESSAGE)
                    } else {
                        Reply.Ok(JsonArray(emptyList()))
                    }

                else -> Reply.Ok(JsonArray(emptyList()))
            }
        }
        val manager = manager(core)
        manager.connectAsync("test")
        awaitState(manager) { it is ConnectionManager.State.Ready }

        val stream = manager.subscribeTask("task-big")
        awaitTrue("the first replay request") { core.requests(CoreMethods.TASK_SUBSCRIBE) >= 1 }
        awaitTrue("the refusal to be recorded") { stream.replayRefusal != null }
        Thread.sleep(1_500) // ≥ 6 poll intervals at the 250 ms floor
        assertEquals(1, core.requests(CoreMethods.TASK_SUBSCRIBE), "a refused replay is sent once, not every interval")
        val refusal = assertNotNull(stream.replayRefusal)
        assertTrue(refusal.contains("too large"), refusal)
        assertFalse(manager.replayBlockedForProjectWideCatchUp(), "one task's refusal must not block project-wide discovery")
    }

    @Test
    fun releasingOneHolderKeepsTheSharedStreamPolling() {
        val core = server { _, method, _ ->
            if (method == CoreMethods.SYSTEM_PROBE) probeOk() else Reply.Ok(JsonArray(emptyList()))
        }
        val manager = manager(core)
        manager.connectAsync("test")
        awaitState(manager) { it is ConnectionManager.State.Ready }

        val first = manager.subscribeTask("task-shared")
        val second = manager.subscribeTask("task-shared")
        assertTrue(first === second, "both windows share one stream")
        assertEquals(2, manager.streamReferenceCount("task-shared"))

        manager.releaseTask("task-shared") // window A closes
        assertEquals(1, manager.streamReferenceCount("task-shared"))
        val before = core.requests(CoreMethods.TASK_SUBSCRIBE)
        awaitTrue("window B's polling to survive window A's release") {
            core.requests(CoreMethods.TASK_SUBSCRIBE) > before + 1
        }

        manager.releaseTask("task-shared") // window B closes
        assertEquals(0, manager.streamReferenceCount("task-shared"))
        Thread.sleep(1_000) // let an in-flight poll land
        val settled = core.requests(CoreMethods.TASK_SUBSCRIBE)
        Thread.sleep(1_500)
        assertEquals(settled, core.requests(CoreMethods.TASK_SUBSCRIBE), "the last release stops polling")
    }

    private fun events(taskId: String, vararg sequences: Long): Reply = Reply.Ok(
        buildJsonArray {
            for (sequence in sequences) {
                add(
                    buildJsonObject {
                        put("taskId", taskId)
                        put("sequence", sequence)
                        put("kind", "message.delta")
                        put("payload", buildJsonObject { })
                        put("timestamp", "2026-10-09T00:00:00Z")
                    },
                )
            }
        },
    )

    @Test
    fun aGapIsResyncedFromJustBeforeTheEarliestHoleNotFromZero() {
        val core = server { _, method, params ->
            when (method) {
                CoreMethods.SYSTEM_PROBE -> probeOk()
                CoreMethods.TASK_SUBSCRIBE -> when (params["afterSequence"]?.jsonPrimitive?.long ?: 0L) {
                    0L -> events("task-gap", 1, 2, 5, 6) // 3 and 4 missing from this answer
                    2L -> events("task-gap", 3, 4, 5, 6) // the resync
                    else -> Reply.Ok(JsonArray(emptyList()))
                }

                else -> Reply.Ok(JsonArray(emptyList()))
            }
        }
        val manager = manager(core)
        manager.connectAsync("test")
        awaitState(manager) { it is ConnectionManager.State.Ready }

        val stream = manager.subscribeTask("task-gap")
        awaitTrue("a poll after the resync") { core.paramsOf(CoreMethods.TASK_SUBSCRIBE).size >= 3 }
        val cursors = core.paramsOf(CoreMethods.TASK_SUBSCRIBE).map { it["afterSequence"]?.jsonPrimitive?.long ?: 0L }
        assertEquals(listOf(0L, 2L), cursors.take(2), "the resync starts after sequence 2, not at 0")
        assertTrue(cursors.drop(2).all { it == 6L }, "after the resync, normal polling resumes from 6: $cursors")
        assertEquals((1L..6L).toList(), stream.snapshot().map { it.sequence })
        assertFalse(stream.gapDetected)
    }

    @Test
    fun aProjectWideRefusalPausesDiscoveryWithoutResendingIt() {
        val core = server { _, method, params ->
            when {
                method == CoreMethods.SYSTEM_PROBE -> probeOk()
                method == CoreMethods.TASK_SUBSCRIBE && params["taskId"] == null ->
                    Reply.Err("VALIDATION_FAILED", FakeCoreServer.OVERSIZED_REPLAY_MESSAGE)

                else -> Reply.Ok(JsonArray(emptyList()))
            }
        }
        val manager = manager(core)
        manager.connectAsync("test")
        awaitState(manager) { it is ConnectionManager.State.Ready }

        val first = runCatching { manager.discoverTasks("project-1") { }.get(3, TimeUnit.SECONDS) }
        val firstCause = (first.exceptionOrNull() as? ExecutionException)?.cause
        assertIs<CoreRpcException>(firstCause, "the first refusal is Core's own verdict")
        assertTrue(manager.replayBlockedForProjectWideCatchUp())

        val second = runCatching { manager.discoverTasks("project-1") { }.get(3, TimeUnit.SECONDS) }
        val secondCause = (second.exceptionOrNull() as? ExecutionException)?.cause
        assertIs<ReplayPausedException>(secondCause, "the second call is withheld by this plugin")
        assertEquals(1, core.requests(CoreMethods.TASK_SUBSCRIBE), "the refused request is not re-sent")
    }

    @Test
    fun aDifferentSocketPathResetsPerTaskCheckpoints() {
        val first = server { _, method, params ->
            when (method) {
                CoreMethods.SYSTEM_PROBE -> probeOk()
                CoreMethods.TASK_SUBSCRIBE ->
                    if ((params["afterSequence"]?.jsonPrimitive?.long ?: 0L) == 0L) events("task-p", 1, 2, 3)
                    else Reply.Ok(JsonArray(emptyList()))

                else -> Reply.Ok(JsonArray(emptyList()))
            }
        }
        val second = server { _, method, _ ->
            if (method == CoreMethods.SYSTEM_PROBE) probeOk() else Reply.Ok(JsonArray(emptyList()))
        }
        val manager = manager(first)
        manager.connectAsync("test")
        awaitState(manager) { it is ConnectionManager.State.Ready }
        val stream = manager.subscribeTask("task-p")
        awaitTrue("checkpoint 3 from the first Core") { stream.lastSequence == 3L }

        manager.settingsOverride!!.setSocketPathOverride(second.socketPath.toString())
        manager.reconnect("socket override changed")
        awaitState(manager) {
            it is ConnectionManager.State.Ready && it.socketPath == second.socketPath.toString()
        }
        awaitTrue("a poll against the second Core") { second.paramsOf(CoreMethods.TASK_SUBSCRIBE).isNotEmpty() }
        val firstCursor = second.paramsOf(CoreMethods.TASK_SUBSCRIBE).first()["afterSequence"]?.jsonPrimitive?.long ?: 0L
        assertEquals(0L, firstCursor, "checkpoints from another Core's database must not be sent to this one")
    }
}
