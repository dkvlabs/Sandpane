package labs.dkv.sandpane.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Review W1: filled deltas land at their sequence position, not at the end. */
class SequencedTextTest {

    @Test
    fun aFilledDeltaIsInsertedAtItsSequencePosition() {
        val text = SequencedText()
        text.put(1, "The ")
        text.put(2, "quick ")
        text.put(5, "jumps")
        assertEquals("The quick jumps", text.toString())
        text.put(3, "brown ")
        text.put(4, "fox ")
        assertEquals("The quick brown fox jumps", text.toString())
    }

    @Test
    fun redeliveryOfAHeldSequenceNeverDuplicatesText() {
        val text = SequencedText()
        assertTrue(text.put(1, "a"))
        assertFalse(text.put(1, "a"))
        assertEquals("a", text.toString())
    }
}
