package labs.dkv.sandpane.text

/**
 * Makes characters that change how text LOOKS without being visible themselves show up as
 * escapes, so Core- or agent-supplied text (file paths, titles, ids, error messages) cannot fake
 * an extra line, hide part of itself, or reorder what the user reads (security review of af8949b:
 * UI spoofing through crafted paths).
 *
 * Escaped, by Unicode general category of each CODE POINT (never per UTF-16 `Char`, so emoji and
 * other supplementary characters are untouched):
 *  - Cc controls — `\n`, `\r`, `\t` by name, every other one as `\uXXXX` (C0, DEL and C1);
 *  - Cf format characters — bidi embeddings/overrides/isolates (U+202A–U+202E, U+2066–U+2069),
 *    marks (U+200E/U+200F/U+061C), zero-width space/joiners (U+200B–U+200D), word joiner, BOM
 *    U+FEFF, soft hyphen, tag characters, …;
 *  - Zl/Zp — U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR;
 *  - unpaired surrogates;
 *  - a short list of letters that render as nothing (Hangul fillers, U+034F).
 *
 * Deliberately NOT escaped: ordinary non-ASCII letters (CJK, Cyrillic, Arabic, …), combining
 * marks such as U+0301, variation selectors and emoji. Known cost: an emoji ZWJ sequence shows its
 * U+200D joiner as `\u200D`, because a zero-width character is exactly what must be visible.
 *
 * The backslash itself is not escaped, which keeps [reveal] idempotent (revealed text contains no
 * hidden character, so revealing it again changes nothing). The consequence: a name that
 * literally contains the six characters `\u202E` reads the same as one containing the real
 * override. Surfaces where that difference matters (the Apply confirmation) use [inspect] and flag
 * the line whenever something was escaped.
 */
object VisibleText {

    /** [text] with every hidden character escaped; [altered] is true when anything was. */
    data class Revealed(val text: String, val altered: Boolean)

    /** Single-line form: line breaks are escaped too, so the result is always one line. */
    fun reveal(text: String): String = inspect(text, keepLineBreaks = false).text

    /**
     * Multi-line form for message bodies: `\n` (and `\r\n`, normalized to `\n`) and `\t` stay real;
     * every other hidden character — including a lone `\r` and U+2028/U+2029 — is escaped.
     */
    fun revealMultiline(text: String): String = inspect(text, keepLineBreaks = true).text

    fun inspect(text: String, keepLineBreaks: Boolean = false): Revealed {
        var altered = false
        val out = StringBuilder(text.length + 8)
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            val width = Character.charCount(cp)
            when {
                keepLineBreaks && cp == '\r'.code && i + 1 < text.length && text[i + 1] == '\n' -> {
                    out.append('\n')
                    i += 2
                    continue
                }

                keepLineBreaks && (cp == '\n'.code || cp == '\t'.code) -> out.appendCodePoint(cp)
                isHidden(cp) -> {
                    altered = true
                    out.append(escape(cp))
                }

                else -> out.appendCodePoint(cp)
            }
            i += width
        }
        return Revealed(out.toString(), altered)
    }

    /** Whether [codePoint] is one this object escapes. */
    fun isHidden(codePoint: Int): Boolean {
        if (codePoint in INVISIBLE_LETTERS) return true
        return when (Character.getType(codePoint)) {
            Character.CONTROL.toInt(),
            Character.FORMAT.toInt(),
            Character.LINE_SEPARATOR.toInt(),
            Character.PARAGRAPH_SEPARATOR.toInt(),
            Character.SURROGATE.toInt(),
            -> true

            else -> false
        }
    }

    private fun escape(cp: Int): String = when (cp) {
        '\n'.code -> "\\n"
        '\r'.code -> "\\r"
        '\t'.code -> "\\t"
        else -> if (cp <= 0xFFFF) "\\u%04X".format(cp) else "\\U%08X".format(cp)
    }

    /** Letters (category Lo/Mn) that typically render as blank space or nothing at all. */
    private val INVISIBLE_LETTERS = setOf(0x034F, 0x115F, 0x1160, 0x3164, 0xFFA0)
}
