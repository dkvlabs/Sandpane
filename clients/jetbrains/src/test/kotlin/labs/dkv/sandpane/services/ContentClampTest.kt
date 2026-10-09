package labs.dkv.sandpane.services

import labs.dkv.sandpane.services.SandpaneContextProvider.Companion.clampChars
import labs.dkv.sandpane.services.SandpaneContextProvider.Companion.clampCodePoints
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Review bug 9. Core's `display_text` bound counts Unicode scalar values
 * (`sandpane_core::validation::bounded` → `chars().count()`), so the client clamps in code points
 * and never cuts a surrogate pair in half.
 */
class ContentClampTest {

    private fun codePoints(s: String) = s.codePointCount(0, s.length)

    private fun hasLoneSurrogate(s: String): Boolean {
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= s.length || !Character.isLowSurrogate(s[i + 1])) return true
                i += 2
                continue
            }
            if (Character.isLowSurrogate(c)) return true
            i++
        }
        return false
    }

    @Test
    fun textWithinTheBudgetIsUnchanged() {
        assertEquals("hello", clampCodePoints("hello", 5))
        assertEquals("日本語", clampCodePoints("日本語", 3))
    }

    @Test
    fun asciiIsCutToTheBudgetIncludingTheMarker() {
        val out = clampCodePoints("a".repeat(100), 20, marker = "…[t]")
        assertEquals(20, codePoints(out))
        assertTrue(out.endsWith("…[t]"))
    }

    @Test
    fun astralCharactersCountOnceAndAreNeverSplit() {
        val emoji = "😀" // one code point, two UTF-16 chars
        val body = emoji.repeat(50)
        val out = clampCodePoints(body, 10, marker = "~")
        assertEquals(10, codePoints(out), "Core counts one per code point, not two")
        assertFalse(hasLoneSurrogate(out))
        assertEquals(emoji.repeat(9) + "~", out)
    }

    @Test
    fun theOldUtf16LengthRuleOverTruncatedAstralText() {
        // 40 emoji = 80 UTF-16 chars but only 40 code points: within a 50-point budget for Core.
        val body = "😀".repeat(40)
        assertEquals(body, clampCodePoints(body, 50))
    }

    @Test
    fun aMarkerLargerThanTheBudgetIsDroppedRatherThanOverflowing() {
        val out = clampCodePoints("abcdef", 2, marker = "…[truncated]")
        assertEquals("ab", out)
    }

    @Test
    fun selectionCharClampNeverEndsOnAHighSurrogate() {
        val text = "ab😀cd"
        assertEquals("ab", clampChars(text, 3), "cutting at 3 would split the pair")
        assertEquals("ab😀", clampChars(text, 4))
        assertEquals(text, clampChars(text, 10))
    }
}
