package labs.dkv.sandpane.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * Client-side UI settings ONLY (docs/specs/04 §2).
 *
 * Deliberately absent: selected project / selected conversation / task state — and therefore
 * any per-project entry a deleted project could leave behind (A3a). Those are shared multi-client state; they live in Sandpane Core (`client_state`, `projects`,
 * `conversations`, `tasks`) and this plugin re-reads them, so two IDE windows and VS Code
 * cannot drift apart (AGENTS.md rule 2: no authoritative client-side database).
 *
 * Persisted with XStream, so the state class holds primitives only.
 */
@State(name = "SandpaneSettings", storages = [Storage("sandpane.xml")])
class SandpaneSettings : PersistentStateComponent<SandpaneSettings.State> {

    /** Plain mutable holder; must stay public-var-with-default for XStream. */
    class State {
        /**
         * Empty = discover the Core socket at the per-user default location
         * (`SANDPANE_SOCKET`, else the platform app-data directory + `sandpane.sock`),
         * mirroring `sandpane_service::default_socket_path`. Never a TCP address: an
         * override that is not a local socket path is rejected at connect time.
         */
        var socketPathOverride: String = ""

        /** Attach the transport automatically when a tool window is first shown. */
        var autoConnect: Boolean = true

        /** `message.delta` coalescing interval on the EDT (docs/specs/04 §5 risk 2). */
        var streamFlushIntervalMs: Int = DEFAULT_STREAM_FLUSH_MS

        /** Poll cadence for `task.subscribe` catch-up (Core has no server push yet). */
        var eventPollIntervalMs: Int = DEFAULT_EVENT_POLL_MS

        /** Hard ceiling on in-memory task events per subscription. */
        var retainedEventCap: Int = DEFAULT_RETAINED_EVENTS

        /** Per-request deadline; a slow Core must not pin a background thread forever. */
        var requestTimeoutMs: Int = DEFAULT_REQUEST_TIMEOUT_MS

        /**
         * Refuse to send a prompt larger than Core's own `display_text` bound. Despite the
         * (persisted, therefore kept) name, Core counts Unicode code points, not bytes, and so
         * does the clamp that reads this value.
         */
        var maxContentBytes: Int = DEFAULT_MAX_CONTENT_BYTES

        /**
         * A3a view setting: also list ARCHIVED projects (`project.list {includeArchived:true}`), each
         * labeled archived. Only honoured when the connected Core advertises `project.archive`; a
         * pre-A3a Core cannot list archived projects, and the toggle then says so.
         */
        var showArchivedProjects: Boolean = false
    }

    private var state = State()

    override fun getState(): State = state

    override fun loadState(loaded: State) {
        // Guard against a hand-edited config file with out-of-range values.
        state = loaded.sanitized()
    }

    val socketPathOverride: String get() = state.socketPathOverride

    val autoConnect: Boolean get() = state.autoConnect

    fun setSocketPathOverride(value: String) {
        state.socketPathOverride = value.trim()
    }

    fun setAutoConnect(value: Boolean) {
        state.autoConnect = value
    }

    val showArchivedProjects: Boolean get() = state.showArchivedProjects

    fun setShowArchivedProjects(value: Boolean) {
        state.showArchivedProjects = value
    }

    /** Clamped so a bad persisted value can never stall the UI or blow up memory. */
    val streamFlushIntervalMs: Int get() = state.streamFlushIntervalMs.coerceIn(MIN_STREAM_FLUSH_MS, MAX_STREAM_FLUSH_MS)

    val eventPollIntervalMs: Int get() = state.eventPollIntervalMs.coerceIn(MIN_EVENT_POLL_MS, MAX_EVENT_POLL_MS)

    val retainedEventCap: Int get() = state.retainedEventCap.coerceIn(MIN_RETAINED_EVENTS, MAX_RETAINED_EVENTS)

    val requestTimeoutMs: Int get() = state.requestTimeoutMs.coerceIn(MIN_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS)

    val maxContentBytes: Int get() = state.maxContentBytes.coerceIn(MIN_MAX_CONTENT_BYTES, MAX_MAX_CONTENT_BYTES)

    private fun State.sanitized(): State = State().also { clean ->
        clean.socketPathOverride = socketPathOverride.trim()
        clean.autoConnect = autoConnect
        clean.showArchivedProjects = showArchivedProjects
        clean.streamFlushIntervalMs = streamFlushIntervalMs.orDefault(DEFAULT_STREAM_FLUSH_MS).coerceIn(MIN_STREAM_FLUSH_MS, MAX_STREAM_FLUSH_MS)
        clean.eventPollIntervalMs = eventPollIntervalMs.orDefault(DEFAULT_EVENT_POLL_MS).coerceIn(MIN_EVENT_POLL_MS, MAX_EVENT_POLL_MS)
        clean.retainedEventCap = retainedEventCap.orDefault(DEFAULT_RETAINED_EVENTS).coerceIn(MIN_RETAINED_EVENTS, MAX_RETAINED_EVENTS)
        clean.requestTimeoutMs = requestTimeoutMs.orDefault(DEFAULT_REQUEST_TIMEOUT_MS).coerceIn(MIN_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS)
        clean.maxContentBytes = maxContentBytes.orDefault(DEFAULT_MAX_CONTENT_BYTES).coerceIn(MIN_MAX_CONTENT_BYTES, MAX_MAX_CONTENT_BYTES)
    }

    private fun Int.orDefault(fallback: Int): Int = if (this <= 0) fallback else this

    companion object {
        const val DEFAULT_STREAM_FLUSH_MS = 50
        const val MIN_STREAM_FLUSH_MS = 16
        const val MAX_STREAM_FLUSH_MS = 1_000

        const val DEFAULT_EVENT_POLL_MS = 1_000
        const val MIN_EVENT_POLL_MS = 250
        const val MAX_EVENT_POLL_MS = 30_000

        const val DEFAULT_RETAINED_EVENTS = 2_000
        const val MIN_RETAINED_EVENTS = 50
        const val MAX_RETAINED_EVENTS = 20_000

        const val DEFAULT_REQUEST_TIMEOUT_MS = 15_000
        const val MIN_REQUEST_TIMEOUT_MS = 1_000
        const val MAX_REQUEST_TIMEOUT_MS = 120_000

        /**
         * Mirrors the service-side `Validator.display_text(&content, 64 * 1024)` bound, which
         * counts Unicode code points (`chars().count()`), not bytes.
         */
        const val DEFAULT_MAX_CONTENT_BYTES = 64 * 1024
        const val MIN_MAX_CONTENT_BYTES = 1_024
        const val MAX_MAX_CONTENT_BYTES = 64 * 1024

        fun instance(): SandpaneSettings =
            ApplicationManager.getApplication().getService(SandpaneSettings::class.java)
    }
}
