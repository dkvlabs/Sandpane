package labs.dkv.sandpane.ui

import java.util.TreeMap

/**
 * A streaming agent message assembled from `message.delta` events IN SEQUENCE ORDER (review W1).
 *
 * A hole-filling resync delivers older deltas after newer ones; appending them would scramble
 * the text. Each delta is stored under its durable `sequence`, so the text is always the
 * concatenation in sequence order, and re-delivery of a sequence already held is a no-op
 * (idempotent, so a replay can never duplicate text). The common case — a delta newer than every
 * one held — is an O(1) append; only an out-of-order fill rebuilds. Not thread-safe: EDT-only.
 */
class SequencedText {

    private val parts = TreeMap<Long, String>()
    private val text = StringBuilder()

    val length: Int get() = text.length

    /** @return true when [delta] changed the text (false for an already-held sequence). */
    fun put(sequence: Long, delta: String): Boolean {
        if (parts.containsKey(sequence)) return false
        val appendsAtEnd = parts.isEmpty() || sequence > parts.lastKey()
        parts[sequence] = delta
        if (appendsAtEnd) {
            text.append(delta)
        } else {
            text.setLength(0)
            parts.values.forEach { text.append(it) }
        }
        return true
    }

    override fun toString(): String = text.toString()
}
