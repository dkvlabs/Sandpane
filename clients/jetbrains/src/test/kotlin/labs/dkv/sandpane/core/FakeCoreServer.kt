package labs.dkv.sandpane.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.ByteBuffer
import java.nio.channels.Channels
import java.nio.channels.ClosedChannelException
import java.nio.channels.ServerSocketChannel
import java.nio.channels.SocketChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * An offline stand-in for the Core socket, for lifecycle tests only: a real AF_UNIX server on a
 * temp path that speaks the NDJSON frame shape (`v`/`id`/`ok`|`err`) and answers each request
 * through [handler]. It is a TEST DOUBLE of the transport peer, never presented as Core: it proves
 * how this client behaves for a given answer, not what a real Core answers.
 */
class FakeCoreServer(
    perms: String = "rw-------",
    /** Decide the reply for one request on one connection; see [Reply]. */
    private val handler: (connectionIndex: Int, method: String, params: JsonObject) -> Reply,
) : AutoCloseable {

    sealed class Reply {
        data class Ok(val value: JsonElement) : Reply()
        data class Err(val code: String, val message: String) : Reply()

        /** Close the connection from the server side without answering. */
        data object Hangup : Reply()
    }

    val dir: Path = Files.createTempDirectory(Path.of("/tmp"), "spc")
    val socketPath: Path = dir.resolve("c.sock")

    private val server: ServerSocketChannel = ServerSocketChannel.open(StandardProtocolFamily.UNIX).apply {
        bind(UnixDomainSocketAddress.of(socketPath))
    }
    private val connections = CopyOnWriteArrayList<SocketChannel>()
    private val accepts = AtomicInteger(0)
    private val requestCounts = ConcurrentHashMap<String, AtomicInteger>()
    private val requestLog = CopyOnWriteArrayList<Pair<String, JsonObject>>()

    @Volatile
    private var running = true

    init {
        Files.setPosixFilePermissions(socketPath, PosixFilePermissions.fromString(perms))
        Thread({ acceptLoop() }, "fake-core-accept").apply { isDaemon = true }.start()
    }

    val acceptCount: Int get() = accepts.get()

    fun requests(method: String): Int = requestCounts[method]?.get() ?: 0

    /** Params of every request for [method], in arrival order. */
    fun paramsOf(method: String): List<JsonObject> = requestLog.filter { it.first == method }.map { it.second }

    /** Drop every live connection from the server side (Core going away mid-session). */
    fun dropAllConnections() {
        connections.forEach { runCatching { it.close() } }
        connections.clear()
    }

    private fun acceptLoop() {
        while (running) {
            val channel = try {
                server.accept()
            } catch (_: ClosedChannelException) {
                return
            } catch (_: Exception) {
                if (!running) return else continue
            }
            val index = accepts.getAndIncrement()
            connections += channel
            Thread({ serve(index, channel) }, "fake-core-conn-$index").apply { isDaemon = true }.start()
        }
    }

    private fun serve(index: Int, channel: SocketChannel) {
        try {
            val reader = BufferedReader(InputStreamReader(Channels.newInputStream(channel), Charsets.UTF_8))
            while (running) {
                val line = reader.readLine() ?: return
                val frame = Json.parseToJsonElement(line).jsonObject
                val id = frame["id"]!!.jsonPrimitive.content
                val method = frame["method"]!!.jsonPrimitive.content
                val params = frame["params"] as? JsonObject ?: JsonObject(emptyMap())
                requestCounts.getOrPut(method) { AtomicInteger() }.incrementAndGet()
                requestLog += method to params
                val response = when (val reply = handler(index, method, params)) {
                    is Reply.Ok -> buildJsonObject {
                        put("v", 1)
                        put("id", id)
                        put("ok", reply.value)
                    }

                    is Reply.Err -> buildJsonObject {
                        put("v", 1)
                        put("id", id)
                        put(
                            "err",
                            buildJsonObject {
                                put("code", reply.code)
                                put("message", reply.message)
                            },
                        )
                    }

                    Reply.Hangup -> {
                        channel.close()
                        return
                    }
                }
                val bytes = (response.toString() + "\n").toByteArray(Charsets.UTF_8)
                synchronized(channel) { channel.write(ByteBuffer.wrap(bytes)) }
            }
        } catch (_: Exception) {
            // connection closed by either side
        } finally {
            runCatching { channel.close() }
            connections.remove(channel)
        }
    }

    override fun close() {
        running = false
        runCatching { server.close() }
        dropAllConnections()
        dir.toFile().deleteRecursively()
    }

    companion object {
        /** A `system.probe` answer in the exact `CoreCapabilities` wire shape. */
        fun capabilities(protocolVersion: Int = 1, instanceId: String = "fake-instance-1"): JsonObject =
            buildJsonObject {
                put("protocolVersion", protocolVersion)
                put("coreVersion", "0.0.0-fake")
                put("instanceId", instanceId)
                put("platform", "test")
                put("agents", JsonArray(emptyList()))
                put("methods", buildJsonArray { })
            }

        /**
         * The sentence SHAPE of `sandpane-service::task_subscribe`'s oversized-replay refusal
         * (core/crates/sandpane-service/src/lib.rs). The byte counts are illustrative, not
         * captured from a running Core.
         */
        const val OVERSIZED_REPLAY_MESSAGE: String =
            "replay of 1 task(s) passed the 4000000-byte ceiling this frame shape can carry " +
                "(4100000 bytes so far); narrow the request (single taskId, a higher afterSequence, or " +
                "per-task afterSequences) — task.subscribe has no truncation envelope yet (docs/specs/02 §2)"
    }
}
