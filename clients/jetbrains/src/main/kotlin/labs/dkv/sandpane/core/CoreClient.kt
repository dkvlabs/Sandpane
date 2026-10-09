package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.MAX_FRAME_BYTES
import labs.dkv.sandpane.model.PROTOCOL_VERSION
import labs.dkv.sandpane.model.RpcRequest
import labs.dkv.sandpane.model.RpcResponseFrame
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.util.SystemInfo
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import java.io.ByteArrayOutputStream
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.ByteBuffer
import java.nio.channels.SocketChannel
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.io.path.Path

/**
 * Typed NDJSON RPC client for the local Sandpane Core service.
 *
 * Transport: `java.nio.channels.SocketChannel` bound to the platform's UNIX protocol
 * family via [UnixDomainSocketAddress] — `SocketChannel.open(UnixSocketAddress)` on JDK
 * 16+, which the pinned baseline runtime (JBR 17 for sinceBuild 242) provides. Never TCP
 * (docs/specs/02 §2). Windows named pipes are NOT implemented by Core yet
 * (`sandpane-service` says so explicitly), so Windows resolves to [CoreTransportState.Unsupported]
 * instead of silently falling back to a socket the user cannot secure.
 *
 * Threading contract (AGENTS.md / system rule: never block the EDT):
 *   * [connect] and [requestBlocking] hard-fail when called on the EDT via [assertNotEdt].
 *   * One dedicated daemon thread owns the blocking read; responses are completed on it.
 *   * Callers that want UI updates must re-dispatch with invokeLater — this class never
 *     touches Swing.
 *
 * This client is stateless about projects/tasks/sandboxes: it correlates frames and hands
 * payloads over. Core stays the only source of truth (AGENTS.md rule 2).
 */
class CoreClient(
    private val socketAddress: UnixDomainSocketAddress,
    private val requestTimeoutMs: Int = DEFAULT_REQUEST_TIMEOUT_MS,
    /** Unsolicited frames (reserved for a future Core push mode) and uncorrelated replies. */
    private val onUnsolicited: (String) -> Unit = { },
    /** Fires exactly once when the read side ends: EOF, IOException, or [close]. */
    private val onClosed: (Throwable?) -> Unit = { },
) : AutoCloseable {

    private val writeLock = Object()
    private val pending = ConcurrentHashMap<String, CompletableFuture<RpcResponseFrame>>()
    private val sequence = AtomicInteger()
    private val timeouts = AtomicLong()
    private val closed = AtomicBoolean(false)
    private val connected = AtomicBoolean(false)

    @Volatile
    private var channel: SocketChannel? = null

    @Volatile
    private var reader: Thread? = null

    /** Correlation-id prefix, unique per plugin process so ids never collide across windows. */
    private val nonce: String = System.currentTimeMillis().toString(16)

    val isOpen: Boolean get() = connected.get() && !closed.get()

    /** Observability only: repeated timeouts make ConnectionManager recycle the socket. */
    val timeoutCount: Long get() = timeouts.get()

    /**
     * Open the socket. Blocking; call from a background thread only.
     * @throws CoreTransportException when the platform has no usable local transport.
     */
    fun connect(): CoreClient {
        assertNotEdt("CoreClient.connect()")
        if (closed.get()) throw CoreTransportException("client already closed")
        val ch = try {
            SocketChannel.open(socketAddress)
        } catch (e: UnsupportedOperationException) {
            throw CoreTransportException(
                "this JVM/platform has no UNIX-domain socket support " +
                    "(Windows named pipes are a P1 Core deliverable and are not implemented)", e,
            )
        } catch (e: Exception) {
            throw CoreTransportException("cannot connect to ${socketAddress.path}: ${e.message}", e)
        }
        channel = ch
        connected.set(true)
        val t = Thread({ readLoop(ch) }, "sandpane-core-reader").apply {
            isDaemon = true
            start()
        }
        reader = t
        return this
    }

    // -----------------------------------------------------------------------
    // request / response
    // -----------------------------------------------------------------------

    /**
     * Send one allowlisted method. The returned future completes on the reader thread with
     * the correlated frame, or fails with [TimeoutException] / [CoreTransportException].
     *
     * The method name is checked against [CoreMethods] before anything is written: there is
     * no free-form execution RPC, and a client must never invent one. An un-allowlisted method is
     * refused with [CoreValidationException] — THIS CLIENT's word, because no byte reached Core —
     * never with a [CoreRpcException], which would render a request Core never saw as Core's own
     * verdict (AGENTS.md rule 5).
     */
    fun request(method: String, params: JsonElement = buildJsonObject { }): CompletableFuture<RpcResponseFrame> {
        if (!CoreMethods.isAllowlisted(method)) {
            return CompletableFuture.failedFuture(
                CoreValidationException(
                    "method",
                    "'$method' is not an allowlisted Core method; there is no free-form RPC, " +
                        "and nothing was sent",
                ),
            )
        }
        if (channel == null || closed.get()) {
            return CompletableFuture.failedFuture(CoreTransportException("not connected"))
        }

        val id = "jb-$nonce-${sequence.incrementAndGet()}"
        val future = CompletableFuture<RpcResponseFrame>()
        pending[id] = future

        val wire = CoreJson.encodeToString(
            RpcRequest.serializer(),
            RpcRequest(v = PROTOCOL_VERSION, id = id, method = method, params = params),
        )
        try {
            writeFrame(wire)
        } catch (t: Throwable) {
            pending.remove(id)
            return CompletableFuture.failedFuture(t)
        }

        // Deadlines without a coroutines dependency: CompletableFuture.orTimeout (JDK 9+)
        // owns its own delayer thread, so nothing here needs a scheduler of its own.
        return future
            .orTimeout(requestTimeoutMs.toLong(), TimeUnit.MILLISECONDS)
            .whenComplete { _, error ->
                if (error != null) {
                    pending.remove(id)
                    if (error is TimeoutException || error.cause is TimeoutException) {
                        timeouts.incrementAndGet()
                    }
                }
            }
    }

    /**
     * Background-thread convenience: send, wait with a deadline, unwrap `ok`, and turn an
     * `err` frame into [CoreRpcException]. Never call from the EDT.
     */
    @OptIn(ExperimentalSerializationApi::class)
    fun <T> requestBlocking(
        method: String,
        params: JsonElement,
        deserializer: KSerializer<T>,
    ): T {
        assertNotEdt("CoreClient.requestBlocking($method)")
        val frame = request(method, params).get(requestTimeoutMs.toLong(), TimeUnit.MILLISECONDS)
        val error = frame.err
        if (error != null) throw CoreRpcException(error.code, error.message)
        val ok = frame.ok
            ?: throw CoreRpcException("INTERNAL", "empty ok payload for $method", raisedByCore = false)
        return CoreJson.decodeFromJsonElement(deserializer, ok)
    }

    /** Send and wait for the raw `ok` element (for responses with no typed shape yet). */
    fun requestOkBlocking(method: String, params: JsonElement): JsonElement {
        assertNotEdt("CoreClient.requestBlocking($method)")
        val frame = request(method, params).get(requestTimeoutMs.toLong(), TimeUnit.MILLISECONDS)
        val error = frame.err
        if (error != null) throw CoreRpcException(error.code, error.message)
        return frame.ok
            ?: throw CoreRpcException("INTERNAL", "empty ok payload for $method", raisedByCore = false)
    }

    private fun writeFrame(line: String) {
        val bytes = line.toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_FRAME_BYTES) {
            // This plugin refused its OWN outgoing frame; Core never saw it, so this is a client
            // guard, not a Core verdict.
            throw CoreValidationException(
                "frame",
                "outgoing frame is ${bytes.size} bytes, over the $MAX_FRAME_BYTES NDJSON cap — " +
                    "nothing was written",
            )
        }
        val ch = channel ?: throw CoreTransportException("not connected")
        val payload = ByteBuffer.wrap(bytes + NEWLINE)
        synchronized(writeLock) {
            while (payload.hasRemaining()) {
                val written = ch.write(payload)
                if (written <= 0) throw CoreTransportException("socket write stalled")
            }
        }
    }

    private fun readLoop(ch: SocketChannel) {
        val framer = NdjsonFramer(MAX_FRAME_BYTES)
        val buffer = ByteBuffer.allocate(READ_CHUNK_BYTES)
        var cause: Throwable? = null
        try {
            while (!closed.get()) {
                buffer.clear()
                val read = ch.read(buffer)
                if (read < 0) {
                    // EOF: Core detached or exited. A client going away must never be
                    // mistaken for a task ending.
                    break
                }
                if (read == 0) continue
                buffer.flip()
                val chunk = ByteArray(buffer.remaining())
                buffer.get(chunk)
                val lines = framer.feed(chunk, 0, chunk.size)
                for (line in lines) correlate(line)
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            cause = e
        } catch (e: java.io.IOException) {
            cause = if (closed.get()) null else e
        } catch (e: FrameExceedsCapException) {
            // Bounded-frame policy: refuse the stream rather than buffer it (AGENTS.md rule 9).
            cause = e
        } catch (e: RuntimeException) {
            cause = e
        } finally {
            connected.set(false)
            failAllPending(CoreTransportException("connection closed: ${cause?.message ?: "EOF"}", cause))
            try {
                ch.close()
            } catch (_: Exception) {
                // closing a dead socket is not an error worth reporting twice
            }
            channel = null
            notifyClosed(cause)
        }
    }

    /** Route one decoded frame: correlate to a waiter, else hand it to the unsolicited sink. */
    private fun correlate(line: String) {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) return
        val frame = try {
            CoreJson.decodeFromString(RpcResponseFrame.serializer(), trimmed)
        } catch (e: Exception) {
            onUnsolicited(trimmed)
            return
        }
        val waiter = frame.id.takeIf { it.isNotEmpty() }?.let { pending.remove(it) }
        if (waiter != null) {
            waiter.complete(frame)
        } else {
            // `id == ""` is Core's reply to a frame IT could not parse; anything else is a
            // push we do not have yet. Both belong to the sink, never dropped silently.
            onUnsolicited(trimmed)
        }
    }

    private fun failAllPending(error: Throwable) {
        val snapshot = HashMap(pending)
        pending.clear()
        snapshot.values.forEach { it.completeExceptionally(error) }
    }

    private fun notifyClosed(cause: Throwable?) {
        try {
            onClosed(cause)
        } catch (_: Exception) {
            // a broken listener must not kill the transport's cleanup path
        }
    }

    /**
     * Close OUR side only. The Core service and any task it supervises keep running; other
     * clients are unaffected (docs/specs/04 §2 lifecycle step 4).
     */
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        connected.set(false)
        failAllPending(CoreTransportException("client closed"))
        try {
            channel?.close()
        } catch (_: Exception) {
            // already gone
        }
        channel = null
        reader?.let { t ->
            if (t !== Thread.currentThread()) {
                t.interrupt()
                runCatching { t.join(JOIN_TIMEOUT_MS) }
            }
        }
        reader = null
    }

    companion object {
        const val DEFAULT_REQUEST_TIMEOUT_MS = 15_000
        private const val READ_CHUNK_BYTES = 64 * 1024
        private const val JOIN_TIMEOUT_MS = 2_000L
        const val NEWLINE: Byte = 0x0A

        /** Does this JVM actually offer the UNIX protocol family? Checked once, cheaply. */
        fun unixSocketsAvailable(): Boolean = try {
            SocketChannel.open(StandardProtocolFamily.UNIX).close()
            true
        } catch (e: UnsupportedOperationException) {
            false
        } catch (e: Exception) {
            false
        }

        /**
         * Transport decision for the current host. Windows is reported as unsupported
         * rather than attempted: java.nio's UNIX family does not speak named pipes, and
         * Core has not implemented that transport yet.
         */
        fun resolveTransport(socketPath: String): CoreTransportState {
            if (SystemInfo.isWindows) {
                return CoreTransportState.Unsupported(
                    "Windows named-pipe transport is not implemented by Sandpane Core yet (P1). " +
                        "The plugin will not fall back to TCP.",
                )
            }
            if (!unixSocketsAvailable()) {
                return CoreTransportState.Unsupported(
                    "this IDE runtime's JVM has no UNIX-domain socket support",
                )
            }
            // Never accept a network address: the protocol is local-IPC only and has no
            // transport authentication to offer a remote endpoint (docs/specs/02 §2).
            val looksRemote = socketPath.contains("://") || socketPath.contains(":") && !socketPath.startsWith("/")
            if (socketPath.isBlank() || looksRemote) {
                return CoreTransportState.Unsupported(
                    "'$socketPath' is not a local socket path; Sandpane never falls back to TCP",
                )
            }
            return try {
                val path = Path(socketPath)
                if (!path.isAbsolute) {
                    CoreTransportState.Unsupported("socket path '$socketPath' must be absolute")
                } else {
                    CoreTransportState.Local(path)
                }
            } catch (e: Exception) {
                CoreTransportState.Unsupported("invalid socket path '$socketPath': ${e.message}")
            }
        }

        /**
         * Fail-fast guard so the "never block the EDT" rule is enforced by the code, not
         * only by review. Unit tests run without an Application instance, so they pass.
         */
        internal fun assertNotEdt(operation: String) {
            val application = ApplicationManager.getApplication()
            if (application != null && application.isDispatchThread) {
                throw IllegalStateException(
                    "$operation ran on the Event Dispatch Thread. IPC must go through " +
                        "ConnectionManager's background executor (docs/specs/04 §2).",
                )
            }
        }
    }
}

/** Resolved local transport for the current host; never an implicit TCP fallback. */
sealed class CoreTransportState {
    data class Local(val path: Path) : CoreTransportState()
    data class Unsupported(val reason: String) : CoreTransportState()
}

class CoreTransportException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * A structured `err` frame from Core. `code` is SCREAMING_SNAKE_CASE; `message` is Core's own
 * wording, kept VERBATIM and deliberately WITHOUT a prefix.
 *
 * The split is load-bearing in both directions:
 *
 *  * `.message` must stay unprefixed because
 *    [ConnectionManager.recordReplayRefusal] hands `code to message` to
 *    [CoreGuards.isOversizedReplayRefusal], which recognises Core's refusal by the FIRST WORDS of
 *    its sentence (`"replay of …"`). Prefixing `.message` would silently unmake that recognition.
 *  * The code is part of the verdict, so it must survive every rendering that does not read
 *    `.message`: `getLocalizedMessage()` composes `CODE: message`, and `Throwable.toString()` is
 *    specified as `ClassName: getLocalizedMessage()` — which is what a stack trace, a log line,
 *    and the message of the [java.util.concurrent.CompletionException] a
 *    `whenComplete { _, error -> }` handler receives are built from. A verdict rendered WITHOUT
 *    its code reads exactly like this client's own `field: message` refusal, which AGENTS.md rule 5
 *    forbids.
 *
 * @param raisedByCore false when this plugin raised the code itself because Core's reply was
 *   unusable (a frame with neither `ok` nor `err`, an empty `ok`). Core never answered those
 *   requests with this code, so they are attributed to the wire, not to Core's judgment.
 */
class CoreRpcException(
    val code: String,
    override val message: String,
    val raisedByCore: Boolean = true,
) : Exception(message) {
    override fun getLocalizedMessage(): String = "$code: $message"
}

/** Raised when a single NDJSON frame would exceed [MAX_FRAME_BYTES]; the stream is dropped. */
class FrameExceedsCapException(val limitBytes: Int, val sawBytes: Int) :
    RuntimeException("frame exceeds the $limitBytes byte NDJSON cap (saw $sawBytes bytes)")

/**
 * Incremental newline-delimited JSON framing, byte-exact with the Rust service reader.
 *
 * Only whole lines are ever decoded, so a multi-byte UTF-8 sequence split across socket
 * reads is safe: no continuation byte can equal 0x0A, so the delimiter is unambiguous.
 * The cap makes a hostile or broken peer unable to grow this buffer without bound.
 */
class NdjsonFramer(private val maxFrameBytes: Int = MAX_FRAME_BYTES) {

    private val current = ByteArrayOutputStream(8 * 1024)

    /** Bytes currently buffered for the unfinished frame. */
    val pendingBytes: Int get() = current.size()

    /**
     * Feed one socket chunk; returns every complete line, without its delimiter.
     * @throws FrameExceedsCapException when the in-progress frame passes the cap.
     */
    fun feed(chunk: ByteArray, offset: Int = 0, length: Int = chunk.size - offset): List<String> {
        val lines = ArrayList<String>()
        var i = offset
        val end = offset + length
        while (i < end) {
            val nl = indexOfDelimiter(chunk, i, end)
            if (nl < 0) {
                append(chunk, i, end - i)
                i = end
            } else {
                append(chunk, i, nl - i)
                lines += takeLine()
                i = nl + 1
            }
        }
        return lines
    }

    /** Discard the partial frame (called when the connection is recycled). */
    fun reset() = current.reset()

    private fun indexOfDelimiter(chunk: ByteArray, from: Int, end: Int): Int {
        var i = from
        while (i < end) {
            if (chunk[i] == CoreClient.NEWLINE) return i
            i++
        }
        return -1
    }

    private fun append(chunk: ByteArray, from: Int, run: Int) {
        if (run <= 0) return
        if (current.size() + run > maxFrameBytes) {
            throw FrameExceedsCapException(maxFrameBytes, current.size() + run)
        }
        current.write(chunk, from, run)
    }

    private fun takeLine(): String {
        val bytes = current.toByteArray()
        current.reset()
        return String(bytes, Charsets.UTF_8)
    }
}
