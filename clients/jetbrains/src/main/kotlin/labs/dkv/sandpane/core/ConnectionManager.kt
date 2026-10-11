package labs.dkv.sandpane.core

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.Application
import com.intellij.openapi.application.ApplicationManager
import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.model.ConversationHistoryParams
import labs.dkv.sandpane.model.ConversationHistoryResult
import labs.dkv.sandpane.model.ConversationListParams
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.PROTOCOL_VERSION
import labs.dkv.sandpane.model.TaskEvent
import labs.dkv.sandpane.model.TaskListParams
import labs.dkv.sandpane.model.TaskSubscribeParams
import labs.dkv.sandpane.model.TaskSummary
import labs.dkv.sandpane.settings.SandpaneSettings
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import java.io.File
import java.net.UnixDomainSocketAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.CompletionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

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
 *
 * Connection lifecycle invariants (review bug 2):
 *  - at most one connect attempt runs at a time ([connecting] is single-flight and is released
 *    only by the attempt that took it);
 *  - at most one retry is scheduled at a time ([pendingRetry]);
 *  - only the CURRENT client's unexpected close schedules a reconnect: every client carries the
 *    [generation] it was created under, and a retired client's late EOF is ignored;
 *  - intentionally retired clients do not report their close at all ([CoreClient] contract);
 *  - [State.VersionMismatch] and [State.TransportUnsupported] halt automatic retries; only an
 *    explicit user action (tool-window activation, refresh, settings change) tries again.
 *
 * @param application nullable only for the headless unit tests, which construct this class
 *   directly; the JVM signature is unchanged for the platform's service instantiation.
 */
class ConnectionManager(private val application: Application?) : Disposable {

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
    private val streams = StreamRegistry { settings().retainedEventCap }
    private val connecting = AtomicBoolean(false)
    private val disposed = AtomicBoolean(false)
    private val reconnectAttempt = AtomicInteger(0)

    /** Bumped for every client created; a close callback from an older generation is stale. */
    private val generation = AtomicInteger(0)

    /** The single scheduled retry, if any. Guarded by [retryLock]. */
    private val retryLock = Any()
    private var pendingRetry: ScheduledFuture<*>? = null

    /** Set by VersionMismatch / TransportUnsupported: no timer-driven retry until a user asks. */
    @Volatile
    private var autoRetryHalted: Boolean = false

    /** A forced reconnect (settings change) arrived while an attempt was in flight. */
    private val forceRequested = AtomicBoolean(false)

    /**
     * A scheduled retry fired while an attempt was in flight (review suggestion 1). Replayed when
     * that attempt ends — but only if it neither connected, halted, nor scheduled its own retry.
     */
    private val retryRequested = AtomicBoolean(false)

    /** Socket path of the last Ready connection; a different path is treated as a different Core. */
    @Volatile
    private var lastReadyPath: String? = null

    /** Used only when the settings service is unavailable (headless test path). */
    private val fallbackSettings = SandpaneSettings()

    /** Test seam: settings to use instead of the application service. */
    @Volatile
    internal var settingsOverride: SandpaneSettings? = null

    @Volatile
    var state: State = State.Idle
        private set

    private val clientRef = AtomicReference<CoreClient?>(null)

    /** Last negotiated instance id, so a Core restart is visible instead of implicit. */
    @Volatile
    private var lastInstanceId: String? = null

    /**
     * Non-null while an oversized-replay refusal is outstanding. Set on a background thread, read
     * from the poll scheduler and the EDT; a plain volatile String because the whole message is
     * the state (no structured type is worth it for one flag plus one sentence).
     */
    @Volatile
    private var replayRefusalMessage: String? = null

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
        val active = readyClient()
        if (active == null) {
            future.completeExceptionally(CoreTransportException(notReadyReason()))
            return future
        }
        // Same per-method rule as CoreClient's own layers: the shortest waiting layer is the one
        // that fires, so all of them must agree ([MethodDeadlines]).
        val timeoutMs = MethodDeadlines.forMethod(method, settings().requestTimeoutMs).toLong()
        io.execute {
            try {
                val frame = active.request(method, params).get(timeoutMs, TimeUnit.MILLISECONDS)
                val error = frame.err
                if (error != null) {
                    future.completeExceptionally(CoreRpcException.fromCore(error))
                } else {
                    val ok = frame.ok
                        ?: throw CoreRpcException(
                            "INTERNAL",
                            "Core returned neither ok nor err for $method",
                            raisedByCore = false,
                        )
                    future.complete(CoreJson.decodeFromJsonElement(deserializer, ok))
                }
            } catch (t: Throwable) {
                future.completeExceptionally(unwrap(t))
            }
        }
        return future
    }

    /**
     * The client typed RPCs may use: open AND past the handshake. A socket that is connected but
     * still negotiating is not usable — a poll sent then could reach a new Core before its
     * checkpoint reset (or version check) ran.
     */
    private fun readyClient(): CoreClient? {
        val active = clientRef.get() ?: return null
        if (!active.isOpen) return null
        return if (state is State.Ready) active else null
    }

    /** RPC for responses with no typed shape yet: the raw `ok` element. */
    fun callJson(method: String, params: JsonElement): CompletableFuture<JsonElement> {
        val future = CompletableFuture<JsonElement>()
        val active = readyClient()
        if (active == null) {
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

    /**
     * Replay a batch of durable events for one scope. The result is Core's, not ours.
     *
     * Only a PROJECT-WIDE (no `taskId`) refusal is recorded globally here; a single task's refusal
     * belongs to that task's [EventStream] and is handled by its poll chain (review bug 5), so one
     * oversized task can no longer block project-wide discovery for every other task.
     */
    fun replay(params: TaskSubscribeParams): CompletableFuture<List<TaskEvent>> =
        call(
            CoreMethods.TASK_SUBSCRIBE,
            CoreJson.encodeToJsonElement(TaskSubscribeParams.serializer(), params),
            ListSerializer(TaskEvent.serializer()),
        ).whenComplete { _, error ->
            if (error != null && params.taskId == null) recordReplayRefusal(unwrap(error))
        }

    /**
     * The typed command surface for the read methods (`task.list`, `conversation.list`,
     * `conversation.history`) plus the cursor-correct `task.subscribe`.
     *
     * Built once over this manager, because the feature gate reads [capabilities] live: a
     * reconnect that lands on a different Core build changes the answer without rebuilding this
     * object. Nothing here touches Swing.
     */
    val commands: CoreCommands by lazy {
        CoreCommands(rpc = CoreRpc { method, params -> callJson(method, params) }, capabilities = { capabilities })
    }

    // -----------------------------------------------------------------------
    // oversized-replay refusal (structured, recoverable, never retried blindly)
    // -----------------------------------------------------------------------

    /**
     * Why the last replay was refused, or null when nothing is outstanding.
     *
     * Core refuses a `task.subscribe` replay that cannot fit one 4 MiB frame with
     * `VALIDATION_FAILED` rather than emitting a frame the client must reject. That refusal is
     * permanent for the same request, so a poll loop that retried it could never converge — the
     * loop is paused until a human narrows the request or opts into a full resync.
     */
    fun replayRefusal(): String? = replayRefusalMessage

    /**
     * True while an outstanding refusal blocks a project-wide (cursor-less) catch-up. The poll
     * loop checks this before scheduling another one, so a request that can never converge is
     * sent once, not forever.
     */
    fun replayBlockedForProjectWideCatchUp(): Boolean = replayRefusalMessage != null

    /** Clear the refusal after the request was narrowed or the user chose a full resync. */
    fun clearReplayRefusal() {
        replayRefusalMessage = null
    }

    private fun recordReplayRefusal(error: Throwable) {
        val description = oversizedRefusalOrNull(error) ?: return
        replayRefusalMessage = description
        log("replay refused — automatic catch-up paused: ${truncate(description)}")
    }

    /** Core's oversized-replay refusal as a user sentence, or null for any other failure. */
    private fun oversizedRefusalOrNull(error: Throwable): String? {
        val rpc = error as? CoreRpcException ?: return null
        if (!CoreGuards.isOversizedReplayRefusal(rpc.code, rpc.message)) return null
        return CoreGuards.describeOversizedReplay(rpc.message)
    }

    /**
     * Start (or re-start) the connection. Non-blocking; the handshake runs on [io].
     * Safe to call from the EDT and on repeated tool-window activations: an attempt already in
     * flight, or a connection already Ready, makes this a no-op.
     */
    fun connectAsync(reason: String) = connectAsync(reason, force = false, fromRetry = false)

    /**
     * Retire the current connection and connect again — used when the socket override changes.
     * The old client is closed on [io] (its reader join can take up to 2 s), never on the caller's
     * thread, so this is EDT-safe.
     */
    fun reconnect(reason: String) = connectAsync(reason, force = true, fromRetry = false)

    private fun connectAsync(reason: String, force: Boolean, fromRetry: Boolean) {
        if (disposed.get()) return
        if (!connecting.compareAndSet(false, true)) {
            // One attempt at a time. A forced request or a timer retry is remembered and replayed
            // when the in-flight attempt ends, so neither is silently dropped.
            if (force) forceRequested.set(true)
            if (fromRetry) retryRequested.set(true)
            return
        }
        try {
            io.execute {
                try {
                    openAndHandshake(reason, force)
                } catch (t: Throwable) {
                    scheduleReconnect(unwrap(t))
                } finally {
                    connecting.set(false)
                    afterAttempt(reason)
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            connecting.set(false) // disposed while scheduling
        }
    }

    /** Replay whatever arrived while the attempt that just ended was running. */
    private fun afterAttempt(reason: String) {
        if (disposed.get()) return
        if (forceRequested.compareAndSet(true, false)) {
            retryRequested.set(false)
            connectAsync("$reason (queued)", force = true, fromRetry = false)
            return
        }
        if (retryRequested.compareAndSet(true, false)) {
            val retryAlreadyScheduled = synchronized(retryLock) { pendingRetry != null }
            if (!autoRetryHalted && state !is State.Ready && !retryAlreadyScheduled) {
                connectAsync("$reason (queued retry)", force = false, fromRetry = true)
            }
        }
    }

    /**
     * Track one task's durable event stream. Idempotent per taskId: every holder shares the same
     * [EventStream] (and therefore the same checkpoint and poll chain); each call takes one
     * reference that [releaseTask] gives back.
     */
    fun subscribeTask(taskId: String): EventStream = subscribeTask(taskId, null).stream

    /** One holder's reference to a task stream plus its listener; [removeListener] detaches it. */
    class TaskSubscription(val stream: EventStream, val removeListener: () -> Unit)

    /**
     * [subscribeTask] with [listener] attached BEFORE the first poll is scheduled (review
     * suggestion 6), so the creating window cannot miss the first batch, and with the stream's
     * retained window replayed to it, so a window joining an existing stream sees what the other
     * window already merged.
     */
    fun subscribeTask(taskId: String, listener: EventStream.Listener?): TaskSubscription {
        val acquired = streams.acquire(taskId)
        val remove = listener?.let { acquired.stream.addListenerWithSnapshot(it) } ?: {}
        if (acquired.created) schedulePoll(acquired.stream, 0L)
        return TaskSubscription(acquired.stream, remove)
    }

    /**
     * Give back one reference to a task's stream. The task keeps running in Core — possibly
     * started by another client — so this only stops OUR polling, and only when no other IDE
     * window still holds the task (docs/specs/04 §5 risk 5, review bug 4).
     */
    fun releaseTask(taskId: String) {
        streams.release(taskId)
    }

    /** Holders of [taskId]'s stream in this IDE process (diagnostics and tests). */
    internal fun streamReferenceCount(taskId: String): Int = streams.referenceCount(taskId)

    /**
     * Discover task ids for a project by replaying its durable events.
     *
     * WITH the per-task cursors this plugin holds, the replay resumes EACH task from its own
     * checkpoint (`afterSequences`), which is exactly what the old shared scalar could not do: one
     * scalar applied to tasks at diverging sequences silently skipped the quieter task's newer
     * events — the recorded protocol-v1 gap (docs/compatibility.md).
     *
     * WITHOUT any checkpoint (first call after a fresh connection) it sends the legacy shared
     * scalar, because an empty `afterSequences` map is a different request from no map at all.
     *
     * When a project-wide replay is blocked, the result is a failed future, not an empty 0 —
     * silence would read as "this project has no tasks" (AGENTS.md rule 5).
     *
     * Prefer [listTasks] when Core advertises `task.list`: it enumerates current rows without
     * replaying any events at all. This path stays for a Core that predates method advertisement.
     */
    fun discoverTasks(projectId: String, afterSequence: Long = 0, onTaskId: (String) -> Unit): CompletableFuture<Int> {
        val refusal = replayRefusalMessage
        if (refusal != null) {
            // This plugin is withholding the request; Core is not being asked again and is not
            // answering now, so the pause is typed as a local refusal with Core's earlier words
            // quoted inside it — never as a fresh CoreRpcException verdict.
            return CompletableFuture.failedFuture(ReplayPausedException(refusal))
        }
        // ONE seam decides the cursor shape, so the rules the tests pin are the rules that ship:
        // a checkpoint of 0 stays absent, the map is bounded, and what the bound forced out is
        // disclosed rather than silently dropped (a task left out replays IN FULL).
        val plan = ReplayCursors.plan(streamCheckpoints())
        plan.disclosure()?.let { log("cursor map: ${truncate(it)}") }
        val params = ReplayCursors.request(
            projectId = projectId,
            sharedAfterSequence = afterSequence,
            plan = plan,
        )
        return commands.taskSubscribe(params)
            .whenComplete { _, error ->
                // The project-wide request is the one the global pause exists for.
                if (error != null) recordReplayRefusal(unwrap(error))
            }
            .thenApply { events ->
                events.map { it.taskId }.distinct().forEach(onTaskId)
                events.size
            }
    }

    /**
     * This plugin's checkpoint per TRACKED task, as the raw pairs [ReplayCursors.plan] narrows.
     *
     * Read from the live registry rather than a parallel copy so the cursors sent can never drift
     * from what was actually applied. Untracked tasks are deliberately absent, which under the
     * Core rule means they replay in full — the safe direction (redelivery is dropped by the
     * idempotent merge in [EventStream.merge]); a shared scalar would instead risk skipping.
     */
    private fun streamCheckpoints(): List<Pair<String, Long>> =
        streams.all().map { it.taskId to it.lastSequence }

    /**
     * `task.list` for one project — the read-only hydration path Core advertises, in place of a
     * replay. Feature-detected, so a pre-revision Core is never asked and never blamed.
     */
    fun listTasks(projectId: String): CompletableFuture<List<TaskSummary>> =
        commands.taskList(TaskListParams(projectId = projectId))

    /**
     * `conversation.list` for one project, or a failed future when this Core does not advertise
     * it. Chat enumeration was impossible before the discovery revision; it is Core's data, not a
     * client-side list.
     */
    fun listConversations(
        projectId: String,
        includeArchived: Boolean = false,
        limit: Int? = null,
    ): CompletableFuture<List<Conversation>> =
        commands.conversationList(
            ConversationListParams(projectId = projectId, limit = limit, includeArchived = if (includeArchived) true else null),
        )

    /**
     * The conversation page after [afterSequence], with Core's own truncation disclosure.
     * An unknown conversation comes back as `NOT_FOUND` — never an empty page. Since A3b Core also
     * serves ARCHIVED conversations here (their history stays readable).
     */
    fun conversationHistory(
        conversationId: String,
        afterSequence: Long = 0,
        limit: Int? = null,
    ): CompletableFuture<ConversationHistoryResult> =
        commands.conversationHistory(
            ConversationHistoryParams(
                conversationId = conversationId,
                afterSequence = afterSequence,
                limit = limit,
            ),
        )

    /** Core is not ours to stop: dispose closes OUR socket and detaches OUR polling. */
    override fun dispose() {
        if (!disposed.compareAndSet(false, true)) return
        streams.clear()
        cancelPendingRetry()
        clientRef.getAndSet(null)?.let { runCatching { it.close() } }
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

    private fun openAndHandshake(reason: String, force: Boolean) {
        CoreClient.assertNotEdt("ConnectionManager.openAndHandshake()")
        val current = clientRef.get()
        if (!force && current != null && current.isOpen && state is State.Ready) return
        // Whatever was there is retired ON PURPOSE: it must not schedule a reconnect of its own.
        retire(current)
        // An explicit attempt (user action or retry) lifts a halt; a mismatch below re-applies it.
        autoRetryHalted = false

        val path = socketPath()
        when (val transport = CoreClient.resolveTransport(path)) {
            is CoreTransportState.Unsupported -> {
                // Terminal for this host until Core grows the transport: no retry storm.
                haltAutoRetry()
                publish(State.TransportUnsupported(transport.reason))
            }

            is CoreTransportState.Local -> {
                publish(State.Connecting(path, reconnectAttempt.get()))
                when (val verdict = SocketTrust.checkForCurrentUser(transport.path)) {
                    SocketTrust.Verdict.Trusted -> Unit
                    SocketTrust.Verdict.Missing ->
                        throw CoreTransportException("no Core socket at $path (is the Sandpane Core service running?)")
                    is SocketTrust.Verdict.Refused ->
                        // This plugin's refusal, before a byte was written; the retry loop keeps
                        // checking so a Core restarted with correct permissions is picked up.
                        throw CoreTransportException("refused by this plugin before connecting: ${verdict.reason}")
                }

                val myGeneration = generation.incrementAndGet()
                val next = CoreClient(
                    socketAddress = UnixDomainSocketAddress.of(transport.path),
                    requestTimeoutMs = settings().requestTimeoutMs,
                    onUnsolicited = { line -> log("unsolicited frame: ${truncate(FrameRedaction.redact(line))}") },
                    onClosed = { cause -> onClientClosed(myGeneration, cause) },
                )
                try {
                    next.connect()
                } catch (e: CoreTransportException) {
                    next.close()
                    throw e
                }
                if (disposed.get()) {
                    // dispose() ran while we were connecting: this client would outlive it.
                    next.close()
                    return
                }
                clientRef.set(next)
                publish(State.Handshaking(path))

                val caps = try {
                    next.requestBlocking(
                        CoreMethods.SYSTEM_PROBE,
                        buildJsonObject { },
                        CoreCapabilities.serializer(),
                    )
                } catch (t: Throwable) {
                    retire(next)
                    throw t
                }

                if (!caps.versionCompatible) {
                    // Hard stop: no timer will knock on this Core again (the old code reconnected
                    // forever here, because closing the client reported itself as a drop). The
                    // halt goes first so nothing the close triggers can schedule a retry.
                    haltAutoRetry()
                    retire(next)
                    publish(State.VersionMismatch(path, caps.protocolVersion))
                    return
                }

                if (disposed.get()) {
                    // Review suggestion 2: never publish Ready from a manager disposed mid-handshake.
                    retire(next)
                    return
                }
                cancelPendingRetry()
                reconnectAttempt.set(0)
                val previousPath = lastReadyPath
                lastReadyPath = path
                if (previousPath != null && previousPath != path) {
                    // Review suggestion 7: a different socket path may be a different Core with a
                    // different database, so sequence checkpoints from the old one mean nothing
                    // there. Replay each tracked task from the start; holders' views and
                    // SequencedText absorb re-delivered sequences idempotently.
                    streams.all().forEach { it.forgetCheckpoint() }
                    log("socket path changed ($previousPath -> $path): per-task checkpoints reset")
                }
                val restarted = lastInstanceId != null && lastInstanceId != caps.instanceId
                lastInstanceId = caps.instanceId
                // A refusal belongs to the instance that raised it and to the cursors it was
                // computed against; a fresh handshake invalidates it rather than leaving a stale
                // block on a Core that may answer the same request differently.
                replayRefusalMessage = null
                rearmRefusedStreams()
                if (restarted) {
                    // Core came back under a new instance id. Core reconciles its own task
                    // rows to `interrupted`; this client keeps its checkpoints, replays, and
                    // only says out loud that the instance changed (AGENTS.md rule 3).
                    // `instanceId` changes on EVERY restart of the same database, so it is not a
                    // data identity; CoreCapabilities carries none (protocol gap). The socket path
                    // is the proxy used above to decide when checkpoints are reset.
                    log("Core instance changed (restart detected): checkpoints retained, replay continues")
                }
                publish(State.Ready(path, caps))
                log("ready: core ${caps.coreVersion}, protocol ${caps.protocolVersion} ($reason)")
            }
        }
    }

    /** Detach and close [stale] if it is still the current client. Never schedules a retry. */
    private fun retire(stale: CoreClient?) {
        if (stale == null) return
        clientRef.compareAndSet(stale, null)
        runCatching { stale.close() }
    }

    /**
     * The read side of a client ended without us closing it. Only the CURRENT generation may
     * trigger a reconnect: a retired client's late EOF must never close a healthy successor.
     */
    private fun onClientClosed(clientGeneration: Int, cause: Throwable?) {
        if (disposed.get()) return
        if (generation.get() != clientGeneration) return
        val dead = clientRef.get() ?: run {
            // Dropped mid-handshake (before clientRef was set): the attempt itself fails and
            // reports; a second schedule here is coalesced by scheduleReconnect anyway.
            scheduleReconnect(cause ?: EOF)
            return
        }
        if (clientRef.compareAndSet(dead, null)) runCatching { dead.close() }
        scheduleReconnect(cause ?: EOF)
    }

    private fun haltAutoRetry() {
        autoRetryHalted = true
        cancelPendingRetry()
    }

    private fun cancelPendingRetry() {
        synchronized(retryLock) {
            pendingRetry?.cancel(false)
            pendingRetry = null
        }
    }

    /**
     * Publish Unavailable and schedule ONE retry. Coalesced: while a retry is already pending this
     * is a no-op, so a probe failure and the matching socket close cannot double the schedule.
     */
    private fun scheduleReconnect(cause: Throwable?) {
        if (disposed.get() || autoRetryHalted) return
        synchronized(retryLock) {
            if (pendingRetry != null) return
            val attempt = reconnectAttempt.incrementAndGet()
            val delay = backoffDelayMs(attempt)
            publish(State.Unavailable(socketPath(), describe(cause), attempt, delay))
            pendingRetry = try {
                scheduler.schedule({
                    synchronized(retryLock) { pendingRetry = null }
                    if (!disposed.get() && !autoRetryHalted) {
                        connectAsync("retry after ${delay}ms", force = false, fromRetry = true)
                    }
                }, delay, TimeUnit.MILLISECONDS)
            } catch (_: java.util.concurrent.RejectedExecutionException) {
                null // shutting down
            }
        }
    }

    /** After a fresh handshake, streams paused by a per-task refusal get exactly one new poll. */
    private fun rearmRefusedStreams() {
        for (stream in streams.all()) {
            if (stream.clearReplayRefusal()) schedulePoll(stream, 0L)
        }
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
        if (disposed.get() || !streams.isLive(stream) || stream.replayRefusal != null) return
        // A detected hole replays from just before the EARLIEST missing sequence (never the whole
        // log); the merge accepts only the missing sequences plus anything newer, and the window
        // cap bounds the memory.
        val resync = stream.gapDetected
        val after = if (resync) {
            ((stream.firstMissingSequence() ?: 1L) - 1L).coerceAtLeast(0L)
        } else {
            stream.lastSequence
        }
        replay(TaskSubscribeParams(taskId = stream.taskId, afterSequence = after))
            .whenComplete { events, error ->
                if (error == null && events != null) {
                    stream.merge(events)
                    if (resync) {
                        val unfilled = stream.markResynced()
                        if (unfilled > 0) {
                            log("task ${stream.taskId}: $unfilled sequence(s) absent from Core's log after a full resync")
                        }
                    }
                } else if (error != null) {
                    val refusal = oversizedRefusalOrNull(unwrap(error))
                    if (refusal != null) {
                        // Permanent for this request: stop this stream's polling and say so,
                        // instead of re-sending the same refused request every interval (bug 5).
                        stream.markReplayRefused(refusal)
                        log("poll ${stream.taskId} stopped: ${truncate(refusal)}")
                        return@whenComplete
                    }
                    log("poll ${stream.taskId} deferred: ${describe(unwrap(error))}")
                }
                if (!disposed.get() && streams.isLive(stream)) {
                    schedulePoll(stream, settings().eventPollIntervalMs.toLong())
                }
            }
    }

    private fun schedulePoll(stream: EventStream, delayMs: Long) {
        if (disposed.get()) return
        try {
            scheduler.schedule({ pollAndReschedule(stream) }, delayMs, TimeUnit.MILLISECONDS)
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            // scheduler shut down by dispose()
        }
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
        is State.Ready -> if (clientRef.get()?.isOpen == true) null else "the socket closed a moment ago; reconnecting"
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
        settingsOverride
            ?: runCatching { application?.getService(SandpaneSettings::class.java) }.getOrNull()
            ?: fallbackSettings

    private fun unwrap(t: Throwable): Throwable {
        var current = t
        while ((current is ExecutionException || current is CompletionException) && current.cause != null) {
            current = current.cause!!
        }
        return current
    }

    /**
     * One sentence for a connection-level failure, from the SAME attribution seam the tool window
     * uses, so a paused or locally refused request can never read as Core's verdict in one surface
     * and as this plugin's in another. `null` here is the read loop ending without an error object:
     * Core's side closed, which is neither a refusal nor a result.
     */
    private fun describe(t: Throwable?): String =
        if (t == null) "socket closed by Core" else ErrorAttribution.describe(t)

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

        /**
         * Opt-in and off by default: an IPC log line must never leak prompt content. Toggled from
         * Settings → Tools → Sandpane for the current IDE session only; never persisted.
         */
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
