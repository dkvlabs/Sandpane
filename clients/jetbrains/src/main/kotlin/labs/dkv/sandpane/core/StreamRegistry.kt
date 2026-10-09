package labs.dkv.sandpane.core

/**
 * Application-wide registry of per-task [EventStream]s, reference-counted per holder.
 *
 * Several IDE windows (each a project-scoped `TaskMonitorService`) can watch the same task. They
 * share ONE stream — one checkpoint, one poll chain — and each holds a reference. Releasing a task
 * from one window drops only that window's reference; the stream (and its polling) ends when the
 * last holder lets go (review bug 4: one window's release used to kill every window's polling).
 *
 * Thread-safe; all mutation is under one monitor. No I/O here.
 */
internal class StreamRegistry(private val capacity: () -> Int) {

    private class Entry(val stream: EventStream, var refs: Int)

    private val lock = Any()
    private val entries = HashMap<String, Entry>()

    /** Result of [acquire]: the shared stream, and whether this call created it. */
    data class Acquired(val stream: EventStream, val created: Boolean)

    /** Take one reference on [taskId]'s stream, creating it on first use. */
    fun acquire(taskId: String): Acquired = synchronized(lock) {
        val existing = entries[taskId]
        if (existing != null) {
            existing.refs += 1
            Acquired(existing.stream, created = false)
        } else {
            val stream = EventStream(taskId, capacity())
            entries[taskId] = Entry(stream, 1)
            Acquired(stream, created = true)
        }
    }

    /**
     * Drop one reference. @return true when that was the last one and the stream was removed.
     * Releasing an unknown task is a no-op (false), never an underflow.
     */
    fun release(taskId: String): Boolean = synchronized(lock) {
        val entry = entries[taskId] ?: return false
        entry.refs -= 1
        if (entry.refs <= 0) {
            entries.remove(taskId)
            true
        } else {
            false
        }
    }

    /** Is [stream] still the registered stream for its task? A poll chain stops when not. */
    fun isLive(stream: EventStream): Boolean = synchronized(lock) {
        entries[stream.taskId]?.stream === stream
    }

    fun referenceCount(taskId: String): Int = synchronized(lock) { entries[taskId]?.refs ?: 0 }

    fun all(): List<EventStream> = synchronized(lock) { entries.values.map { it.stream } }

    fun clear() = synchronized(lock) { entries.clear() }
}
