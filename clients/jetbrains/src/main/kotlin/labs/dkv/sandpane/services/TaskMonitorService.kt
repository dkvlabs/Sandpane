package labs.dkv.sandpane.services

import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import labs.dkv.sandpane.core.ConnectionManager
import labs.dkv.sandpane.core.ErrorAttribution
import labs.dkv.sandpane.core.EventStream
import labs.dkv.sandpane.core.RenderedEvent
import labs.dkv.sandpane.core.toRenderedEvent
import labs.dkv.sandpane.model.ApplyResult
import labs.dkv.sandpane.model.CancelAccepted
import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.ConversationSendParams
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.GitApplyParams
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
        val status: TaskStatus?,
        val sandboxName: String?,
        val taskBranch: String?,
        val baseCommit: String?,
        val lastSequence: Long,
        val lastEventAt: String?,
        val notes: List<String>,
    ) {
        val awaitingReview: Boolean get() = status == TaskStatus.AWAITING_REVIEW

        val statusLabel: String
            get() = status?.name?.lowercase() ?: "unknown — Core has not reported a status"
    }

    /** How a `conversation.send` reply was understood — see protocol gap 2 above. */
    sealed class SendResult {
        data class FromSummary(val summary: TaskSummary) : SendResult() {
            val taskId: String get() = summary.id
        }

        data class TaskIdOnly(val taskId: String) : SendResult()
    }

    fun interface ViewListener {
        /** Invoked on a background thread; the UI owns its own EDT hop. */
        fun onView(taskId: String, view: TaskView, event: RenderedEvent?)
    }

    private val views = ConcurrentHashMap<String, TaskView>()
    private val tracked = ConcurrentHashMap<String, EventStream>()

    /** taskId → the change set this client reviewed, so apply can assert the same base. */
    private val reviewedBases = ConcurrentHashMap<String, ChangeSet>()
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
        if (!tracked.containsKey(taskId)) {
            // computeIfAbsent keeps the listener attachment atomic: two windows opening at
            // once must not register the same projector twice.
            tracked.computeIfAbsent(taskId) { id ->
                val stream = connection.subscribeTask(id)
                stream.addListener { batch -> onBatch(id, batch) }
                stream
            }
        }
    }

    /** Detach this window's view. The task keeps running in Core (docs/specs/04 §5 risk 5). */
    fun untrack(taskId: String) {
        tracked.remove(taskId)
        connection.releaseTask(taskId)
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
    fun send(request: ConversationSendParams): CompletableFuture<SendResult> =
        connection.callJson(
            CoreMethods.CONVERSATION_SEND,
            CoreJson.encodeToJsonElement(ConversationSendParams.serializer(), request),
        ).thenApply { element ->
            val result = decodeSendResult(element)
            when (result) {
                is SendResult.FromSummary -> track(result.taskId, request.conversationId, result.summary)
                is SendResult.TaskIdOnly -> track(result.taskId, request.conversationId)
            }
            result
        }

    /** Cancel is a *request*; the resulting status still arrives as durable events. */
    fun cancel(taskId: String): CompletableFuture<CancelAccepted> =
        connection.call(
            CoreMethods.TASK_CANCEL,
            CoreJson.encodeToJsonElement(TaskAccepted.serializer(), TaskAccepted(taskId)),
            CancelAccepted.serializer(),
        )

    /** The real change set versus the recorded base. Never reconstructed client-side. */
    fun review(taskId: String): CompletableFuture<ChangeSet> {
        track(taskId)
        return connection.call(
            CoreMethods.GIT_REVIEW,
            CoreJson.encodeToJsonElement(TaskAccepted.serializer(), TaskAccepted(taskId)),
            ChangeSet.serializer(),
        ).thenApply { recordReview(it) }
    }

    /** Remember the reviewed base so apply can assert it (docs/specs/06 §6). */
    fun recordReview(changeSet: ChangeSet): ChangeSet {
        reviewedBases[changeSet.taskId] = changeSet
        return changeSet
    }

    /** The change set this client last reviewed for a task, or null if it never did. */
    fun reviewedChangeSet(taskId: String): ChangeSet? = reviewedBases[taskId]

    /**
     * Apply is an explicit Git operation performed by Core, gated by the base recorded at
     * review time — a mismatch aborts there (docs/specs/06 §6). Nothing is written here.
     */
    fun apply(taskId: String, selectedFiles: List<String>?, expectedBase: String): CompletableFuture<ApplyResult> {
        require(expectedBase.isNotBlank()) { "expectedBase is required for an apply" }
        return connection.call(
            CoreMethods.GIT_APPLY,
            CoreJson.encodeToJsonElement(
                GitApplyParams.serializer(),
                GitApplyParams(taskId = taskId, selectedFiles = selectedFiles, expectedBase = expectedBase),
            ),
            ApplyResult.serializer(),
        )
    }

    fun replay(taskId: String, afterSequence: Long = 0): CompletableFuture<List<TaskEvent>> =
        connection.replay(TaskSubscribeParams(taskId = taskId, afterSequence = afterSequence))

    /** Detach every view of this project. Core keeps running. */
    override fun dispose() {
        tracked.keys().toList().forEach { connection.releaseTask(it) }
        tracked.clear()
        reviewedBases.clear()
        listeners.clear()
    }

    // -----------------------------------------------------------------------
    // projection
    // -----------------------------------------------------------------------

    private fun onBatch(taskId: String, batch: List<TaskEvent>) {
        for (event in batch) {
            val rendered = event.toRenderedEvent()
            val current = views[taskId]
                ?: TaskView(taskId, null, null, null, null, null, 0, null, emptyList())
            val nextStatus = decodeStatusChange(event) ?: current.status
            val note = rendered.note
            val notes = when {
                note == null -> current.notes
                current.notes.lastOrNull() == note -> current.notes
                else -> (current.notes + note).takeLast(MAX_NOTES)
            }
            val updated = current.copy(
                conversationId = current.conversationId ?: conversationHint(event),
                status = nextStatus,
                lastSequence = event.sequence,
                lastEventAt = event.timestamp,
                notes = notes,
            )
            views[taskId] = updated
            for (l in listeners) runCatching { l.onView(taskId, updated, rendered) }
        }
    }

    private fun applySummary(summary: TaskSummary) {
        val prior = views[summary.id]
        views[summary.id] = TaskView(
            taskId = summary.id,
            conversationId = summary.conversationId,
            status = summary.status,
            sandboxName = summary.sandboxName ?: prior?.sandboxName,
            taskBranch = summary.taskBranch ?: prior?.taskBranch,
            baseCommit = summary.baseCommit ?: prior?.baseCommit,
            lastSequence = prior?.lastSequence ?: 0,
            lastEventAt = prior?.lastEventAt,
            notes = prior?.notes ?: emptyList(),
        )
    }

    /** `status.changed` payload is `{ "to": <TaskStatus> }` as produced by sandpane-service. */
    @OptIn(ExperimentalSerializationApi::class)
    private fun decodeStatusChange(event: TaskEvent): TaskStatus? {
        if (event.kind != "status.changed") return null
        return runCatching {
            CoreJson.decodeFromJsonElement(StatusChangedPayload.serializer(), event.payload).to
        }.getOrNull()
    }

    private fun conversationHint(event: TaskEvent): String? =
        runCatching { (event.payload as? JsonObject)?.get("conversationId")?.asStringOrNull() }.getOrNull()

    /** Accept both documented shapes until the protocol resolves gap 2. */
    @OptIn(ExperimentalSerializationApi::class)
    private fun decodeSendResult(element: JsonElement): SendResult {
        val summary = runCatching {
            CoreJson.decodeFromJsonElement(TaskSummary.serializer(), element)
        }.getOrNull()
        if (summary != null) return SendResult.FromSummary(summary)
        val taskId = (element as? JsonObject)?.get("taskId")?.asStringOrNull()
        return SendResult.TaskIdOnly(taskId ?: "")
    }

    companion object {
        private const val MAX_NOTES = 12

        fun instance(project: Project): TaskMonitorService =
            project.getService(TaskMonitorService::class.java)
    }
}

/** `status.changed` wire payload, mirrored from the producer in `sandpane-service`. */
@Serializable
private data class StatusChangedPayload(@SerialName("to") val to: TaskStatus)

/** A string node as text, or null for JSON null / a non-string node. */
private fun JsonElement.asStringOrNull(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content
