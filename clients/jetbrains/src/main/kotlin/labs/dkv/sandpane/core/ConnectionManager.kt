package labs.dkv.sandpane.core

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.Application
import com.intellij.openapi.application.ApplicationManager
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.PROTOCOL_VERSION
import labs.dkv.sandpane.model.TaskEvent
import labs.dkv.sandpane.model.TaskSubscribeParams
import labs.dkv.sandpane.settings.SandpaneSettings
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import java.io.File
import java.net.UnixDomainSocketAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Application-scoped owner of the single Core connection shared by every IDE window.
 *
 * Deliberately coroutine-free: this scaffold uses a `ScheduledExecutorService` backoff
 * loop plus `CompletableFuture` deadlines instead of `kotlinx.coroutines`, so the plugin
 * carries no extra runtime dependency and cannot accidentally await on the UI thread.
 * JB1 may switch to coroutines (`Dispatchers.IO`) once a build is proven; this class is
 * the only seam that changes.
 *
 * Ownership boundary (docs/specs/04 §2, §5 risk 5): disposing this service, closing a
 * project, or hiding the tool window detaches UI subscriptions only. It never tells Core
 * to stop, and it never infers that a task ended because a window closed.
 */
class ConnectionManager(private val application: Application) : Disposable {

    /** Connection surface as the UI sees it. Every state names a reason; no fake green. */
    sealed class State {
        data object Idle : State()
        data class Connecting(val socketPath: String, val attempt: Int) : State()
        data class Handshaking(val socketPath: String) : State()
        data class Ready(val socketPath: String, val capabilities: CoreCapabilities) : State()

        /** Core speaks a protocol version this client cannot follow. Hard stop, no guessing. */
        data class VersionMismatch(val socketPath: String, val coreProtocolVersion: Int) : State()

        /** The transport cannot exist on this host (Windows pipes are unimplemented upstream). */
        data class TransportUnsupported(val reason: String) : State()

        /** Core is down/absent. The reason carries the recover/install path. */
        data class Unavailable(
            val socketPath: String,
            val reason: String,
            val attempt: Int,
            val retryInMs: Long,
        ) : State()
    }

    private val io: ExecutorService = Executors.newCachedThreadPool(threadFactory("sandpane-core-io"))
    private val scheduler: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor(threadFactory("sandpane-core-scheduler"))

    private val stateListeners = CopyOnWriteArrayList<(State) -> Unit>()
    private val streams = ConcurrentHashMap<String, EventStream>()
    private val connecting = AtomicBoolean(false)
    private val disposed = AtomicBoolean(false)
    private val reconnectAttempt = AtomicInteger(0)

    /** Used only when the settings service is unavailable (headless test path). */
    private val fallbackSettings = SandpaneSettings()

    @Volatile
    var state: State = State.Idle
        private set

    @Volatile
    private var client: CoreClient? = null

    /** Last negotiated instance id, so a Core restart is visible instead of implicit. */
    @Volatile
    private var lastInstanceId: String? = null

    val isReady: Boolean get() = state is State.Ready

    val capabilities: CoreCapabilities? get() = (state as? State.Ready)?.capabilities

    // -----------------------------------------------------------------------
    // public API
    // -----------------------------------------------------------------------

    /** Observe connection state; listeners run on the EDT. @return a remover. */
    fun addStateListener(listener: (State) -> Unit): () -> Unit {
        stateListeners.add(listener)
        runOnEdt { listener(state) }
        return { stateListeners.remove(listener) }
    }

    /**
     * Run a blocking Core call off the EDT. Everything in `actions/` and `services/` goes
     * through here; [CoreClient.assertNotEdt] is the second net, at the transport itself.
     */
    fun <T> background(label: String, block: () -> T): CompletableFuture<T> {
        val future = CompletableFuture<T>()
        io.execute {
            try {
                future.complete(block())
            } catch (t: Throwable) {
                future.completeExceptionally(t)
            }
        }
        if (verboseLogging) log("queued background task '$label'")
        return future
    }

    /** Typed RPC. Fails fast when the connection is not Ready rather than queueing blind. */
    @OptIn(ExperimentalSerializationApi::class)
    fun <T> call(method: String, params: JsonElement, deserializer: KSerializer<T>): CompletableFuture<T> {
        val future = CompletableFuture<T>()
        val active = client
        if (active == null || !active.isOpen) {
            future.completeExceptionally(CoreTransportException(notReadyReason()))
            return future
        }
        val timeoutMs = settings().requestTimeoutMs.toLong()
        io.execute {
            try {
                val frame = active.request(method, params).get(timeoutMs, TimeUnit.MILLISECONDS)
                val error = frame.err
                if (error != null) {
                    future.completeExceptionally(CoreRpcException(error.code, error.message))
                } else {
                    val ok = frame.ok
                        ?: throw CoreRpcException("INTERNAL", "Core returned neither ok nor err for $method")
                    future.complete(CoreJson.decodeFromJsonElement(deserializer, ok))
                }
            } catch (t: Throwable) {
                future.completeExceptionally(unwrap(t))
            }
        }
        return future
    }

    /** RPC for responses with no typed shape yet: the raw `ok` element. */
    fun callJson(method: String, params: JsonElement): CompletableFuture<JsonElement> {
        val future = CompletableFuture<JsonElement>()
        val active = client
        if (active == null || !active.isOpen) {
            future.completeExceptionally(CoreTransportException(notReadyReason()))
            return future
        }
        io.execute {
            try {
                future.complete(active.requestOkBlocking(method, params))
            } catch (t: Throwable) {
                future.completeExceptionally(unwrap(t))
            }
        }
        return future
    }

    /** Replay a batch of durable events for one scope. The result is Core's, not ours. */
    fun replay(params: TaskSubscribeParams): CompletableFuture<List<TaskEvent>> =
        call(
            CoreMethods.TASK_SUBSCRIBE,
            CoreJson.encodeToJsonElement(TaskSubscribeParams.serializer(), params),
            ListSerializer(TaskEvent.serializer()),
        )

    /**
     * Start (or re-start) the connection. Non-blocking; the handshake runs on [io].
     * Safe to call from the EDT and on repeated tool-window activations.
     */
    fun connectAsync(reason: String) {
        if (disposed.get()) return
        if (!connecting.compareAndSet(false, true)) return
        io.execute {
            try {
                openAndHandshake(reason)
            } catch (t: Throwable) {
                scheduleReconnect(unwrap(t))
            } finally {
                connecting.set(false)
            }
        }
    }

    /**
     * Track one task's durable event stream. Idempotent per taskId: the same [EventStream]
     * (and therefore the same checkpoint) is returned, so re-subscribing after a reconnect
     * replays exactly once.
     */
    fun subscribeTask(taskId: String): EventStream {
        streams[taskId]?.let { return it }
        val created = EventStream(taskId, settings().retainedEventCap)
        val prior = streams.putIfAbsent(taskId, created)
        val stream = prior ?: created
        if (prior == null) schedulePoll(stream, 0L)
        return stream
    }

    /**
     * Detach a view from a task's stream. The task keeps running in Core — possibly started
     * by another client — so this only stops OUR polling (docs/specs/04 §5 risk 5).
     */
    fun releaseTask(taskId: String) {
        streams.remove(taskId)
    }

    /**
     * Discover task ids for a project. Per-task streams stay the authoritative replay path:
     * a project-wide `afterSequence` is one checkpoint applied to every task by Core, which
     * can skip a quieter task's events (see the note on [EventStream]).
     */
    fun discoverTasks(projectId: String, afterSequence: Long = 0, onTaskId: (String) -> Unit): CompletableFuture<Int> =
        replay(TaskSubscribeParams(projectId = projectId, afterSequence = afterSequence))
            .thenApply { events ->
                events.map { it.taskId }.distinct().forEach(onTaskId)
                events.size
            }

    /** Core is not ours to stop: dispose closes OUR socket and detaches OUR polling. */
    override fun dispose() {
        if (!disposed.compareAndSet(false, true)) return
        streams.clear()
        client?.close()
        client = null
        scheduler.shutdownNow()
        io.shutdownNow()
        state = State.Idle
    }

    /**
     * The honest JB2 gate: chat/agent features are offered only when Core reports a
     * verified adapter. Capability is read from `system.probe`, never inferred (rule 5).
     */
    fun agentGate(): AgentGate {
        val caps = capabilities ?: return AgentGate.NotConnected
        if (caps.agents.isEmpty()) return AgentGate.NoAdapters
        val verified = caps.verifiedAgentIds
        if (verified.isEmpty()) return AgentGate.P0GateNotPassed(caps.agents.map { it.id })
        val streaming = caps.agents.filter { it.verified && it.supportsStreaming }.map { it.id }
        if (streaming.isEmpty()) return AgentGate.NoStreaming(verified)
        return AgentGate.Open(streaming)
    }

    // -----------------------------------------------------------------------
    // connection lifecycle
    // -----------------------------------------------------------------------

    private fun openAndHandshake(reason: String) {
        CoreClient.assertNotEdt("ConnectionManager.openAndHandshake()")
        val path = socketPath()
        when (val transport = CoreClient.resolveTransport(path)) {
            is CoreTransportState.Unsupported -> {
                // Terminal for this host until Core grows the transport: no retry storm.
                publish(State.TransportUnsupported(transport.reason))
            }

            is CoreTransportState.Local -> {
                publish(State.Connecting(path, reconnectAttempt.get()))
                val next = CoreClient(
                    socketAddress = UnixDomainSocketAddress.of(transport.path),
                    requestTimeoutMs = settings().requestTimeoutMs,
                    onUnsolicited = { line -> log("unsolicited frame: ${truncate(line)}") },
                    onClosed = { cause -> if (!disposed.get()) scheduleReconnect(cause ?: EOF) },
                )
                try {
                    next.connect()
                } catch (e: CoreTransportException) {
                    next.close()
                    scheduleReconnect(e)
                    return
                }
                client = next
                publish(State.Handshaking(path))

                val caps = try {
                    next.requestBlocking(
                        CoreMethods.SYSTEM_PROBE,
                        buildJsonObject { },
                        CoreCapabilities.serializer(),
                    )
                } catch (t: Throwable) {
                    next.close()
                    client = null
                    scheduleReconnect(unwrap(t))
                    return
                }

                if (!caps.versionCompatible) {
                    next.close()
                    client = null
                    publish(State.VersionMismatch(path, caps.protocolVersion))
                    return
                }

                reconnectAttempt.set(0)
                val restarted = lastInstanceId != null && lastInstanceId != caps.instanceId
                lastInstanceId = caps.instanceId
                if (restarted) {
                    // Core came back under a new instance id. Core reconciles its own task
                    // rows to `interrupted`; this client keeps its checkpoints, replays, and
                    // only says out loud that the instance changed (AGENTS.md rule 3).
                    log("Core instance changed (restart detected): checkpoints retained, replay continues")
                }
                publish(State.Ready(path, caps))
                log("ready: core ${caps.coreVersion}, protocol ${caps.protocolVersion} ($reason)")
            }
        }
    }

    private fun scheduleReconnect(cause: Throwable?) {
        if (disposed.get()) return
        client?.let { stale ->
            client = null
            runCatching { stale.close() }
        }
        val attempt = reconnectAttempt.incrementAndGet()
        val delay = backoffDelayMs(attempt)
        publish(State.Unavailable(socketPath(), describe(cause), attempt, delay))
        scheduler.schedule({
            if (disposed.get()) return@schedule
            connecting.set(false)
            connectAsync("retry after ${delay}ms")
        }, delay, TimeUnit.MILLISECONDS)
    }

    /** Exponential backoff with jitter, capped so a dead Core is polled, not hammered. */
    private fun backoffDelayMs(attempt: Int): Long {
        val exponent = (attempt - 1).coerceAtMost(MAX_BACKOFF_EXPONENT)
        val base = minOf(BASE_BACKOFF_MS * (1L shl exponent), MAX_BACKOFF_MS)
        return base + ThreadLocalRandom.current().nextLong(0, JITTER_MS + 1)
    }

    /**
     * One poll, then reschedule — chained instead of `scheduleAtFixedRate` so a slow Core
     * can never stack overlapping identical requests.
     */
    private fun pollAndReschedule(stream: EventStream) {
        if (disposed.get() || !streams.containsKey(stream.taskId)) return
        // A detected hole asks for the task's whole log; the window cap bounds the memory.
        val after = if (stream.gapDetected) 0L else stream.lastSequence
        replay(TaskSubscribeParams(taskId = stream.taskId, afterSequence = after))
            .whenComplete { events, error ->
                if (error == null && events != null) {
                    stream.merge(events)
                    if (after == 0L) stream.markResynced()
                } else if (error != null && verboseLogging) {
                    log("poll ${stream.taskId} deferred: ${describe(unwrap(error))}")
                }
                if (!disposed.get() && streams.containsKey(stream.taskId)) {
                    schedulePoll(stream, settings().eventPollIntervalMs.toLong())
                }
            }
    }

    private fun schedulePoll(stream: EventStream, delayMs: Long) {
        if (disposed.get()) return
        scheduler.schedule({ pollAndReschedule(stream) }, delayMs, TimeUnit.MILLISECONDS)
    }

    // -----------------------------------------------------------------------
    // socket discovery — mirrors sandpane_service::default_socket_path / data_dir
    // -----------------------------------------------------------------------

    /** Settings override → `SANDPANE_SOCKET` → the per-user data directory. Never TCP. */
    fun socketPath(): String {
        // Values are trimmed exactly like clients/vscode/src/core-client/paths.ts, so the three
        // clients resolve the same Core socket from the same environment.
        settings().socketPathOverride.trim().takeIf { it.isNotEmpty() }?.let { return it }
        System.getenv(ENV_SOCKET)?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        return File(dataDir(), SOCKET_FILE_NAME).absolutePath
    }

    /** Why a call cannot proceed right now, in the user's terms. */
    fun connectionProblem(): String? = when (val current = state) {
        is State.Ready -> if (client?.isOpen == true) null else "the socket closed a moment ago; reconnecting"
        is State.TransportUnsupported -> current.reason
        is State.Unavailable ->
            "Sandpane Core is not reachable at ${current.socketPath} (${current.reason}); " +
                "retry #${current.attempt} in ${current.retryInMs}ms. Start the Core service, or set " +
                "\$SANDPANE_SOCKET / Settings → Tools → Sandpane."
        is State.VersionMismatch ->
            "Core speaks protocol v${current.coreProtocolVersion}; this plugin speaks v$PROTOCOL_VERSION. " +
                "Update either side — the plugin will not guess a dialect."
        else -> "not connected to Sandpane Core yet"
    }

    private fun notReadyReason(): String = connectionProblem() ?: "not connected"

    private fun dataDir(): File {
        if (isMacOs) return File(homeDir(), "Library/Application Support/sandpane")
        val xdg = System.getenv("XDG_STATE_HOME")?.takeIf { it.isNotBlank() }
        return if (xdg != null) File(xdg, "sandpane") else File(homeDir(), ".local/state/sandpane")
    }

    private fun homeDir(): File =
        System.getenv("HOME")?.takeIf { it.isNotBlank() }?.let(::File) ?: File("/tmp")

    private val isMacOs: Boolean get() = System.getProperty("os.name", "").lowercase().contains("mac")

    private fun publish(next: State) {
        state = next
        runOnEdt { stateListeners.forEach { it(next) } }
    }

    /**
     * THE EDT HOP. Background threads never touch Swing; this is the single place where
     * Core-derived information crosses onto the UI thread. Streaming deltas take a second,
     * coalesced hop in ui/ChatPanel (flush every streamFlushIntervalMs).
     */
    private fun runOnEdt(action: () -> Unit) {
        val app = ApplicationManager.getApplication()
        if (app == null) action() else app.invokeLater(action)
    }

    private fun settings(): SandpaneSettings =
        runCatching { application.getService(SandpaneSettings::class.java) }.getOrNull() ?: fallbackSettings

    private fun unwrap(t: Throwable): Throwable =
        if (t is ExecutionException && t.cause != null) t.cause!! else t

    private fun describe(t: Throwable?): String = when (t) {
        null -> "socket closed by Core"
        is CoreTransportException -> t.message ?: "transport failure"
        is CoreRpcException -> "${t.code}: ${t.message}"
        else -> "${t.javaClass.simpleName}: ${t.message}"
    }

    /** Bounded, redacted-by-omission log line: never dump a whole frame (rule 7). */
    private fun truncate(line: String): String =
        if (line.length <= LOG_LINE_LIMIT) line else line.take(LOG_LINE_LIMIT) + "… (${line.length} chars)"

    private fun log(message: String) {
        if (verboseLogging) System.err.println("[sandpane] $message")
    }

    companion object {
        const val ENV_SOCKET = "SANDPANE_SOCKET"
        const val SOCKET_FILE_NAME = "sandpane.sock"

        private const val BASE_BACKOFF_MS = 250L
        private const val MAX_BACKOFF_MS = 15_000L
        private const val MAX_BACKOFF_EXPONENT = 6
        private const val JITTER_MS = 120L
        private const val LOG_LINE_LIMIT = 240

        private val EOF = RuntimeException("socket reached EOF")

        /** Opt-in and off by default: an IPC log line must never leak prompt content. */
        @Volatile
        var verboseLogging: Boolean = false

        fun instance(): ConnectionManager =
            ApplicationManager.getApplication().getService(ConnectionManager::class.java)

        private fun threadFactory(prefix: String): ThreadFactory = ThreadFactory { runnable ->
            Thread(runnable, prefix).apply { isDaemon = true }
        }
    }
}

/** JB2 capability gate, answered by Core rather than assumed by the plugin. */
sealed class AgentGate {
    data object NotConnected : AgentGate()
    data object NoAdapters : AgentGate()

    /** Adapters exist but none passed the in-SBX feasibility gate: chat is unsupported. */
    data class P0GateNotPassed(val adapterIds: List<String>) : AgentGate()

    data class NoStreaming(val verifiedAdapterIds: List<String>) : AgentGate()

    /** Only this state may enable the streaming composer. */
    data class Open(val streamingAdapterIds: List<String>) : AgentGate()

    val chatEnabled: Boolean get() = this is Open

    fun reasonForUser(): String = when (this) {
        is NotConnected -> "Not connected to Sandpane Core."
        is NoAdapters -> "Core reports no agent adapters compiled in."
        is P0GateNotPassed ->
            "Chat is unsupported: adapter(s) ${adapterIds.joinToString()} have not passed the P0 " +
                "in-sandbox feasibility gate, so Core reports them unverified."
        is NoStreaming ->
            "Streaming chat is unsupported: verified adapter(s) ${verifiedAdapterIds.joinToString()} " +
                "do not advertise streaming."
        is Open -> "Streaming available via ${streamingAdapterIds.joinToString()}."
    }
}
