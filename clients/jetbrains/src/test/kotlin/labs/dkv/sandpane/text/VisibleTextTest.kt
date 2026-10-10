package labs.dkv.sandpane.text

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class VisibleTextTest {

    @Test
    fun controlsLineBreaksBidiAndZeroWidthAreEscapedByCodePoint() {
        val cases = mapOf(
            "a\nb" to """a\nb""",
            "a\r\nb" to """a\r\nb""",
            "a\tb" to """a\tb""",
            "a\u0000b" to """a\u0000b""",
            "a\u001Bb" to """a\u001Bb""",
            "a\u007Fb" to """a\u007Fb""",
            "a\u0085b" to """a\u0085b""",
            "a\u202Eb" to """a\u202Eb""",
            "a\u2066b\u2069" to """a\u2066b\u2069""",
            "a\u200Eb\u200F" to """a\u200Eb\u200F""",
            "a\u061Cb" to """a\u061Cb""",
            "a\u200Bb\u200Cc\u200Dd" to """a\u200Bb\u200Cc\u200Dd""",
            "a\u2060b\uFEFF" to """a\u2060b\uFEFF""",
            "a\u00ADb" to """a\u00ADb""",
            "a\u2028b\u2029" to """a\u2028b\u2029""",
            "a\u3164b" to """a\u3164b""",
            "tag\uDB40\uDC41" to """tag\U000E0041""",
            "lone\uD800x" to """lone\uD800x""",
        )
        for ((raw, expected) in cases) {
            val revealed = VisibleText.inspect(raw)
            assertEquals(expected, revealed.text, "for ${raw.map { "U+%04X".format(it.code) }}")
            assertTrue(revealed.altered)
        }
    }

    @Test
    fun ordinaryTextIncludingNonAsciiAndEmojiIsUntouched() {
        val samples = listOf(
            "src/main/App.kt",
            "日本語/ファイル.kt",
            "файл.md",
            "café and cafe\u0301",
            "عربي/ملف.kt",
            "🚀 launch 🎉",
            "❤\uFE0F variation selector",
            "C:\\path\\with\\backslashes",
        )
        for (s in samples) {
            val revealed = VisibleText.inspect(s)
            assertEquals(s, revealed.text)
            assertFalse(revealed.altered, s)
        }
    }

    @Test
    fun revealIsIdempotent() {
        val once = VisibleText.reveal("x\u202E\ny\u200Bz")
        assertEquals(once, VisibleText.reveal(once))
        assertEquals(once, VisibleText.revealMultiline(once))
    }

    @Test
    fun multilineKeepsRealLineBreaksAndTabsOnly() {
        assertEquals("a\nb\n\tc", VisibleText.revealMultiline("a\r\nb\n\tc"))
        assertEquals("""a\rb\u2028c\u202Ed""", VisibleText.revealMultiline("a\rb\u2028c\u202Ed"))
    }
}
