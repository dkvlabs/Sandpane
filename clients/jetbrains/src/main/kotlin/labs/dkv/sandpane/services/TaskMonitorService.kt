package labs.dkv.sandpane.services

import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.core.CoreRpcException
import labs.dkv.sandpane.core.CoreValidationException
import labs.dkv.sandpane.core.KeyedCall
import labs.dkv.sandpane.core.KeyedRequests
import labs.dkv.sandpane.core.ErrorAttribution
import labs.dkv.sandpane.core.EventStream
import labs.dkv.sandpane.core.RenderedEvent
import labs.dkv.sandpane.core.toRenderedEvent
import labs.dkv.sandpane.model.CancelAccepted
import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.ConversationSendParams
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreEventKinds
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.Reported
import labs.dkv.sandpane.model.ReportedTaskStatusSerializer
import labs.dkv.sandpane.model.describe
import labs.dkv.sandpane.model.TaskAccepted
import labs.dkv.sandpane.model.TaskEvent
import labs.dkv.sandpane.model.TaskStatus
import labs.dkv.sandpane.model.TaskSummary
import labs.dkv.sandpane.model.TaskSubscribeParams
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Project-scoped view of Core task state, built ONLY from data Core reported.
 *
 * What is deliberately absent: any client-side lifecycle logic. A row's `status` is copied
 * from a `status.changed` payload or a `TaskSummary` Core returned; nothing here computes a
 * transition, guesses `running`, or promotes a row after a restart (AGENTS.md rule 3). Where
 * Core says "queued, no verified adapter", the UI says exactly that.
 *
 * PROTOCOL STATUS (re-checked 09.10.2026 against the protocol-v1 discovery revision): the three
 * gaps this class used to report are now CLOSED on the wire, and this client uses the fixes:
 *  1. **CLOSED — `task.list` exists.** Rows come from [hydrateFromTaskList] instead of a full
 *     `task.subscribe(afterSequence = 0)` replay, and a checkpointed refresh can now see a task
 *     whose sequence restarted at 1. Gated on advertisement, because a pre-revision Core does not
 *     dispatch it. The old replay path ([discoverTasks]) stays as the fallback for such a Core and
 *     now sends per-task cursors.
 *  2. **OPEN — `conversation.send` response.** docs/specs/02 §2 promises `{ taskId }` while
 *     `sandpane-service::conversation_send` returns a full `TaskSummary`. This client still
 *     accepts both ([SendResult]); the protocol must pick one.
 *  3. **CLOSED — per-task cursors.** `task.subscribe` accepts `afterSequences`, so a project-wide
 *     replay resumes EACH task from its own checkpoint instead of applying one scalar to all of
 *     them (which could skip a quieter task's newer events). See
 *     [labs.dkv.sandpane.core.ConnectionManager.discoverTasks].
 */
class TaskMonitorService(private val project: Project) : Disposable {

    /** UI-facing row. Every field is Core-reported, or a count this client measured locally. */
    data class TaskView(
        val taskId: String,
        val conversationId: String?,
        /**
         * Core-reported status: null when Core has not reported one yet, [Reported.Unknown] when
         * a newer Core reported a value this build does not define (shown, never interpreted).
         */
        val status: Reported<TaskStatus>?,
        val sandboxName: String?,
        val taskBranch: String?,
        val baseCommit: String?,
        val lastSequence: Long,
        val lastEventAt: String?,
        val notes: List<String>,
        /**
         * Core's refusal of this task's replay (too large for one frame), while outstanding. Polling
         * for the task is stopped and the transcript may be incomplete; null when not refused.
         */
        val replayRefusal: String? = null,
        /** A4: Core's [TaskSummary.mode] (an open string), shown read-only; null when Core did not report it. */
        val mode: String? = null,
        /** A4: Core's [TaskSummary.chosenSandboxName] — display only, never [sandboxName]. */
        val chosenSandboxName: String? = null,
    ) {
        /** Only a KNOWN awaiting_review enables review/apply; an unknown status never does. */
        val awaitingReview: Boolean get() = status == Reported.Known(TaskStatus.AWAITING_REVIEW)

        /** Core reported a status this plugin build cannot interpret; every task action is off. */
        val hasUnknownStatus: Boolean get() = status is Reported.Unknown

        val statusLabel: String
            get() = status?.describe() ?: "unknown — Core has not reported a status"
    }

    /** How a `conversation.send` reply was understood — see protocol gap 2 above. */
    sealed class SendResult {
        /** A2: Core returned its STORED answer to an earlier identical keyed send (not current state). */
        abstract val replayed: Boolean

        data class FromSummary(val summary: TaskSummary) : SendResult() {
            val taskId: String get() = summary.id
            override val replayed: Boolean get() = summary.replayed == true
        }

        data class TaskIdOnly(val taskId: String) : SendResult() {
            override val replayed: Boolean get() = false
        }
    }

    fun interface ViewListener {
        /** Invoked on a background thread; the UI owns its own EDT hop. */
        fun onView(taskId: String, view: TaskView, event: RenderedEvent?)
    }

    private val views = ConcurrentHashMap<String, TaskView>()

    /** One shared stream reference plus THIS service's listener on it, released together. */
    private class Tracking(val stream: EventStream, val removeListener: () -> Unit)

    private val tracked = ConcurrentHashMap<String, Tracking>()

    /**
     * taskId → the LAST `git.review` answer this window received ([ReviewSession]): its base (which
     * apply asserts), its `reviewId`, its exact entry objects and the diffs opened for it. A new
     * review replaces the whole session, so a selection never outlives the review it was made in.
     */
    private val reviews = ConcurrentHashMap<String, ReviewSession>()
    private val listeners = CopyOnWriteArrayList<ViewListener>()
    private val conversationTasks = ConcurrentHashMap<String, CopyOnWriteArrayList<String>>()

    private val connection: ConnectionManager get() = ConnectionManager.instance()

    // -----------------------------------------------------------------------
    // tracking
    // -----------------------------------------------------------------------

    /** @return a remover. */
    fun addViewListener(listener: ViewListener): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    fun trackedTaskIds(): List<String> = views.keys().toList().sorted()

    fun view(taskId: String): TaskView? = views[taskId]

    fun allViews(): List<TaskView> = views.values.sortedByDescending { it.lastSequence }

    /** Read-only lookup of the tasks Core reports as awaiting review (no transition logic). */
    fun awaitingReviewTasks(): List<TaskView> =
        views.values.filter { it.awaitingReview }.sortedByDescending { it.lastSequence }

    /**
     * A sentence for "nothing to review/apply" notices when tracked tasks carry a status this build
     * does not define — so those tasks are not silently invisible. Empty when there are none.
     */
    fun unknownStatusNote(): String = unknownStatusNote(views.values)

    fun tasksForConversation(conversationId: String): List<TaskView> =
        conversationTasks[conversationId].orEmpty().mapNotNull { views[it] }

    /** Start or reuse per-task replay. Idempotent, EDT-safe (no I/O happens here). */
    fun track(taskId: String, conversationId: String? = null, summary: TaskSummary? = null) {
        if (taskId.isBlank()) return
        summary?.let { applySummary(it) }
        conversationId?.let { cid ->
            conversationTasks.getOrPut(cid) { CopyOnWriteArrayList() }.addIfAbsent(taskId)
        }
        if (views[taskId] == null && summary == null) {
            // Nothing is known about the task yet: create a row that says so, inventing no status.
            views.putIfAbsent(
                taskId,
                TaskView(taskId, conversationId, null, null, null, null, 0, null, emptyList()),
            )
        }
        // computeIfAbsent keeps the reference + listener attachment atomic per project: this
        // service holds exactly one stream reference and one listener per task, and keeps the
        // remover so untrack/dispose can detach it (review bug 4: the remover used to be dropped,
        // leaking this Project through the application-scoped stream).
        // The listener is attached before the first poll can run, and a window joining a stream
        // another window already polls is handed the retained events and any outstanding refusal
        // (review suggestion 6) — see ConnectionManager.subscribeTask(taskId, listener).
        tracked.computeIfAbsent(taskId) { id ->
            val subscription = connection.subscribeTask(
                id,
                object : EventStream.Listener {
                    override fun onEvents(events: List<TaskEvent>) = onBatch(id, events)
                    override fun onReplayRefusalChanged(message: String?) = onReplayRefusal(id, message)
                },
            )
            Tracking(subscription.stream, subscription.removeListener)
        }
    }

    /**
     * Detach this window's view. Gives back only THIS window's reference, so another IDE window
     * watching the same task keeps its polling; the task keeps running in Core regardless
     * (docs/specs/04 §5 risk 5). Untracking a task this window never tracked does nothing.
     */
    fun untrack(taskId: String) {
        val tracking = tracked.remove(taskId) ?: return
        tracking.removeListener()
        connection.releaseTask(taskId)
    }

    /**
     * A3a: after Core CONFIRMED a project delete (`deleted: true`), drop this window's in-memory
     * state for that project's conversations — tracked tasks and their rows. Core deleted those
     * rows; nothing here decides a task state, it only stops showing what no longer exists.
     * @return how many tasks were dropped.
     */
    fun forgetConversations(conversationIds: Collection<String>): Int {
        var dropped = 0
        conversationIds.forEach { cid ->
            conversationTasks.remove(cid)?.forEach { taskId ->
                untrack(taskId)
                if (views.remove(taskId) != null) dropped++
            }
        }
        return dropped
    }

    /** Explicit discovery on a user refresh — the pre-advertisement path (see gap 1). */
    fun discoverTasks(projectId: String): CompletableFuture<Int> =
        connection.discoverTasks(projectId) { taskId -> track(taskId) }

    /**
     * Hydrate this window's task rows from `task.list` instead of replaying the event log.
     *
     * The protocol-v1 answer to old gap 1: current rows are readable directly, so a refresh no
     * longer needs a full `task.subscribe(afterSequence = 0)` replay, and a task created since the
     * last poll is visible even when every tracked stream has a checkpoint.
     *
     * Strictly read-only projection: each row carries Core's stored status verbatim, and every
     * task still gets its own [EventStream] for durable replay (AGENTS.md rule 3 — this client
     * computes no transition and promotes nothing).
     *
     * When Core does not advertise the method nothing is sent and the result says so; the caller
     * keeps the replay path rather than showing an invented list.
     */
    fun hydrateFromTaskList(projectId: String): CompletableFuture<Hydration> {
        if (!connection.commands.advertises(CoreMethods.TASK_LIST)) {
            return CompletableFuture.completedFuture(
                Hydration.NotAdvertised(
                    "this Core does not advertise task.list — rows stay at whatever was replayed",
                ),
            )
        }
        return connection.listTasks(projectId)
            .thenApply<Hydration> { summaries ->
                summaries.forEach { summary -> track(summary.id, summary.conversationId, summary) }
                Hydration.Loaded(summaries)
            }
            .exceptionally { err ->
                // Attributed through the shared seam: a guard refusal from this plugin must not
                // read as a `task.list` that ran and failed at Core.
                Hydration.Failed(
                    ErrorAttribution.describe(CoreMethods.TASK_LIST, err) +
                        " — rows stay at whatever was already replayed; nothing is invented",
                )
            }
    }

    /** Outcome of a `task.list` hydration, as a value so "empty" and "unknown" stay distinct. */
    sealed class Hydration {
        /** Core's rows, in Core's order. Display-only — no status is derived from them. */
        data class Loaded(val tasks: List<TaskSummary>) : Hydration()

        /** Nothing was sent: the method is not advertised by this Core. */
        data class NotAdvertised(val reason: String) : Hydration()

        /** Core answered with an error; the reason is Core's, kept verbatim. */
        data class Failed(val reason: String) : Hydration()

        val rows: List<TaskSummary>
            get() = (this as? Loaded)?.tasks ?: emptyList()

        fun describe(): String = when (this) {
            is Loaded -> "task.list returned ${tasks.size} row(s) (statuses as Core stores them)"
            is NotAdvertised -> "task.list unavailable: $reason"
            is Failed -> "task.list failed: $reason"
        }
    }

    // -----------------------------------------------------------------------
    // RPC paths (all dispatched off the EDT by ConnectionManager)
    // -----------------------------------------------------------------------

    /**
     * `conversation.send`. Content is data, never a command; attachments are validated refs
     * (docs/specs/02 §2). The returned task id is Core's, and replay starts from that moment.
     */
    fun send(request: ConversationSendParams): KeyedCall<ConversationSendParams, SendResult> =
        dispatchSend(request, KeyedRequests.newSend(request, connection.capabilities))

    /**
     * A2 "Retry safely": resend the IDENTICAL params with the SAME key, only on an explicit user
     * action after an unknown outcome. Refused (nothing sent) without a key or when the connected
     * Core no longer advertises keys. Never called automatically.
     */
    fun retrySendSafely(previous: ConversationSendParams): KeyedCall<ConversationSendParams, SendResult> =
        dispatchSend(previous, KeyedRequests.retrySend(previous, connection.capabilities))

    private fun dispatchSend(
        original: ConversationSendParams,
        prepared: KeyedRequests.Prepared<ConversationSendParams>,
    ): KeyedCall<ConversationSendParams, SendResult> {
        val params = when (prepared) {
            is KeyedRequests.Prepared.Refused -> return KeyedCall(
                original,
                null,
                CompletableFuture.failedFuture(CoreValidationException(prepared.field, prepared.reason)),
            )
            is KeyedRequests.Prepared.Ready -> prepared.params
        }
        val future = connection.callJson(
            CoreMethods.CONVERSATION_SEND,
            CoreJson.encodeToJsonElement(ConversationSendParams.serializer(), params),
        ).thenApply { element ->
            val result = decodeSendResult(element)
            // A replayed answer's status is what it was THEN: track the id, never seed that status.
            track(result.taskId(), params.conversationId, summaryToSeed(result))
            result
        }
        return KeyedCall(params, params.idempotencyKey, future)
    }

    /** Cancel is a *request*; the resulting status still arrives as durable events. */
    fun cancel(taskId: String): CompletableFuture<CancelAccepted> =
        connection.call(
            CoreMethods.TASK_CANCEL,
            CoreJson.encodeToJsonElement(TaskAccepted.serializer(), TaskAccepted(taskId)),
            CancelAccepted.serializer(),
        )

    /**
     * The real change set versus the recorded base. Never reconstructed client-side. The answer is
     * kept whole ([ReviewSession.fromAnswer]) so A6 apply can send its entries verbatim; the session
     * remembers which Core instance answered, because Core keeps `reviewId` in memory only.
     */
    fun review(taskId: String): CompletableFuture<ChangeSet> {
        track(taskId)
        return connection.callJson(
            CoreMethods.GIT_REVIEW,
            CoreJson.encodeToJsonElement(TaskAccepted.serializer(), TaskAccepted(taskId)),
        ).thenApply { answer ->
            val session = ReviewSession.fromAnswer(answer, connection.capabilities?.instanceId)
            reviews[session.changeSet.taskId] = session
            session.changeSet
        }
    }

    /** The change set this client last reviewed for a task, or null if it never did. */
    fun reviewedChangeSet(taskId: String): ChangeSet? = reviews[taskId]?.changeSet

    /** The whole last review of [taskId] (entries, reviewId, opened diffs), or null. */
    fun reviewSession(taskId: String): ReviewSession? = reviews[taskId]

    /** Forget a review (its selection and diff evidence) — after an apply, or when Core restarted. */
    fun discardReview(taskId: String) {
        reviews.remove(taskId)
    }

    /**
     * Record a `git.diff` answer the user opened for [taskId] into the CURRENT review session. The
     * answer describes Core's current task content, so it is evidence for whichever review is
     * current (a different `taskBlob` is exactly the "changed after you reviewed it" case).
     */
    fun recordDiff(taskId: String, result: labs.dkv.sandpane.model.GitDiffResult) {
        reviews[taskId]?.recordDiff(result)
    }

    fun replay(taskId: String, afterSequence: Long = 0): CompletableFuture<List<TaskEvent>> =
        connection.replay(TaskSubscribeParams(taskId = taskId, afterSequence = afterSequence))

    /** Detach every view of this project. Core keeps running; other windows keep their streams. */
    override fun dispose() {
        tracked.keys().toList().forEach { untrack(it) }
        reviews.clear()
        listeners.clear()
    }

    // -----------------------------------------------------------------------
    // projection
    // -----------------------------------------------------------------------

    private fun onBatch(taskId: String, batch: List<TaskEvent>) {
        for (event in batch) {
            // A7: remember which runs Core reports started / finished (for the stop dialog and the
            // Verification section). Payloads only; the task row's status is never touched by it.
            labs.dkv.sandpane.core.VerificationActivity.observe(taskId, event.kind, event.payload)
            val rendered = event.toRenderedEvent()
            val current = views[taskId]
                ?: TaskView(taskId, null, null, null, null, null, 0, null, emptyList())
            val updated = fold(current, event, rendered)
            views[taskId] = updated
            for (l in listeners) runCatching { l.onView(taskId, updated, rendered) }
        }
    }

    /** Core refused (or a handshake re-armed) this task's replay: show it on the row, verbatim. */
    private fun onReplayRefusal(taskId: String, message: String?) {
        val current = views[taskId]
            ?: TaskView(taskId, null, null, null, null, null, 0, null, emptyList())
        if (current.replayRefusal == message) return
        val updated = current.copy(replayRefusal = message)
        views[taskId] = updated
        for (l in listeners) runCatching { l.onView(taskId, updated, null) }
    }

    private fun applySummary(summary: TaskSummary) {
        views[summary.id] = fromSummary(summary, views[summary.id])
    }


    companion object {
        private const val MAX_NOTES = 12

        /** Pure: the row for a Core [TaskSummary], keeping what [prior] knew that the summary omits. */
        fun fromSummary(summary: TaskSummary, prior: TaskView?): TaskView = TaskView(
            taskId = summary.id,
            conversationId = summary.conversationId,
            status = summary.status,
            sandboxName = summary.sandboxName ?: prior?.sandboxName,
            taskBranch = summary.taskBranch ?: prior?.taskBranch,
            baseCommit = summary.baseCommit ?: prior?.baseCommit,
            lastSequence = prior?.lastSequence ?: 0,
            lastEventAt = prior?.lastEventAt,
            notes = prior?.notes ?: emptyList(),
            replayRefusal = prior?.replayRefusal,
            // A4: display only. Never folded into sandboxName (the binding), scope or impact logic.
            mode = summary.mode ?: prior?.mode,
            chosenSandboxName = summary.chosenSandboxName ?: prior?.chosenSandboxName,
        )

        /** Pure form of [unknownStatusNote] (instance method), over the given rows. */
        internal fun unknownStatusNote(rows: Collection<TaskView>): String {
            val unknown = rows.filter { it.hasUnknownStatus }
            if (unknown.isEmpty()) return ""
            val statuses = unknown.mapNotNull { it.status?.wireName }.distinct().sorted().joinToString(", ")
            return "\n${unknown.size} tracked task(s) have a status this plugin build does not define " +
                "($statuses); review and apply are disabled for them — update the plugin."
        }

        /**
         * Project one durable event onto a task row. Pure.
         *
         * Review W1 (AGENTS.md rule 3): a hole-filling resync delivers OLDER sequences after newer
         * ones. Such an event is history the row has already moved past — it may still fill in a
         * missing conversation id, but it never changes `status`, `lastEventAt` or `notes`, so a
         * late `status.changed → running` can never roll an `awaiting_review` row back.
         */
        internal fun fold(current: TaskView, event: TaskEvent, rendered: RenderedEvent): TaskView {
            val conversationId = current.conversationId ?: conversationHint(event)
            if (event.sequence < current.lastSequence) {
                return current.copy(conversationId = conversationId)
            }
            val change = decodeStatusChange(event)
            var notes = current.notes
            for (note in listOfNotNull(rendered.note, change?.note)) {
                if (notes.lastOrNull() != note) notes = (notes + note).takeLast(MAX_NOTES)
            }
            return current.copy(
                conversationId = conversationId,
                // An unknown value IS applied: the row then says "Unknown status '<raw>'" instead
                // of silently keeping an older, known status that Core has moved past.
                status = change?.status ?: current.status,
                lastSequence = event.sequence,
                lastEventAt = event.timestamp,
                notes = notes,
            )
        }

        /** What one `status.changed` event says; [status] is null when its payload is unreadable. */
        private data class StatusChange(val status: Reported<TaskStatus>?, val note: String?)

        /**
         * `status.changed` payload is `{ "to": <TaskStatus> }` as produced by sandpane-service.
         * Neither an unknown value nor an unreadable payload is dropped silently: both leave a
         * note on the row (an unreadable one keeps the last reported status, and says so).
         */
        @OptIn(ExperimentalSerializationApi::class)
        private fun decodeStatusChange(event: TaskEvent): StatusChange? {
            if (event.kind != CoreEventKinds.STATUS_CHANGED) return null
            val status = runCatching {
                CoreJson.decodeFromJsonElement(StatusChangedPayload.serializer(), event.payload).to
            }.getOrNull()
            return when (status) {
                null -> StatusChange(
                    null,
                    "status.changed #${event.sequence} has an unreadable payload; the status shown is " +
                        "the last one Core reported readably",
                )

                is Reported.Unknown -> StatusChange(
                    status,
                    "Core reported status '${status.wireName}', which this plugin build does not " +
                        "define; review and apply stay off for it — update the plugin",
                )

                is Reported.Known -> StatusChange(status, null)
            }
        }

        private fun conversationHint(event: TaskEvent): String? =
            runCatching { (event.payload as? JsonObject)?.get("conversationId")?.asStringOrNull() }.getOrNull()

        /**
         * Accept both documented shapes until the protocol resolves gap 2 — and nothing else.
         *
         * A reply that is neither a `TaskSummary` with an id nor `{ "taskId": "<non-blank>" }`
         * is NOT a success: it fails with an `INTERNAL` code attributed to this plugin
         * (`raisedByCore = false`), so the UI can never print "Core accepted task " with an empty
         * id (review bug 11).
         */
        @OptIn(ExperimentalSerializationApi::class)
        internal fun decodeSendResult(element: JsonElement): SendResult {
            val summary = runCatching {
                CoreJson.decodeFromJsonElement(TaskSummary.serializer(), element)
            }.getOrNull()
            if (summary != null && summary.id.isNotBlank()) return SendResult.FromSummary(summary)
            val taskId = (element as? JsonObject)?.get("taskId")?.asStringOrNull()
            if (!taskId.isNullOrBlank()) return SendResult.TaskIdOnly(taskId)
            throw CoreRpcException(
                "INTERNAL",
                "conversation.send answered without a task id (neither a TaskSummary nor { taskId }); " +
                    "nothing is shown as accepted",
                raisedByCore = false,
            )
        }

        /**
         * The summary a send may seed its row with: a fresh answer's, never a replayed one's (its
         * status may since have been reconciled — the caller re-reads `task.list` instead).
         */
        internal fun summaryToSeed(result: SendResult): TaskSummary? =
            (result as? SendResult.FromSummary)?.summary?.takeIf { !result.replayed }

        private fun SendResult.taskId(): String = when (this) {
            is SendResult.FromSummary -> taskId
            is SendResult.TaskIdOnly -> taskId
        }

        fun instance(project: Project): TaskMonitorService =
            project.getService(TaskMonitorService::class.java)
    }
}

/** `status.changed` wire payload, mirrored from the producer in `sandpane-service`. */
@Serializable
private data class StatusChangedPayload(
    @Serializable(with = ReportedTaskStatusSerializer::class)
    @SerialName("to") val to: Reported<TaskStatus>,
)

/** A string node as text, or null for JSON null / a non-string node. */
private fun JsonElement.asStringOrNull(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content
