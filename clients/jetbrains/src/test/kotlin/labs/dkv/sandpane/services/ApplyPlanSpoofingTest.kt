package labs.dkv.sandpane.services

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Security finding (automated review of af8949b, html-injection / UI spoofing): file paths in the
 * Apply confirmation are agent-controlled. A crafted path must never be able to fake an extra
 * entry line, hide characters, or reorder what the user reads.
 */
class ApplyPlanSpoofingTest {

    /** Entry lines, with the no-break spaces this plugin emits read back as plain spaces. */
    private fun entryLines(described: String) = plain(described).lines().filter { it.isNotBlank() }

    private fun plain(described: String) = described.replace('\u00A0', ' ')

    @Test
    fun aNewlineInAPathCannotFakeAnExtraEntry() {
        val paths = listOf("src/ok.kt", "src/evil.kt\n  [2] src/fake.kt", "src/a\rb.kt", "src/c\u2028d.kt")
        val described = ApplyPlan.describePaths(paths)
        assertEquals(paths.size, entryLines(described).size, described)
        assertFalse(described.contains('\r'), "a carriage return must be shown, not obeyed")
        assertFalse(described.contains('\u2028'), "LINE SEPARATOR must be shown, not obeyed")
        assertTrue(plain(described).contains("""src/evil.kt\n  [2] src/fake.kt"""), described)
    }

    @Test
    fun bidiAndZeroWidthCharactersAreShownVisiblyAndTheLineIsFlagged() {
        val rlo = "src/invoice\u202Etxt.exe"
        val zw = "src/con\u200Bfig.kt"
        val bom = "src/\uFEFFmain.kt"
        val described = ApplyPlan.describePaths(listOf(rlo, zw, bom))
        for (hidden in listOf('\u202E', '\u200B', '\uFEFF')) {
            assertFalse(described.contains(hidden), "U+%04X must not reach the dialog raw".format(hidden.code))
        }
        assertTrue(described.contains("""src/invoice\u202Etxt.exe"""), described)
        assertTrue(described.contains("""src/con\u200Bfig.kt"""), described)
        assertTrue(described.contains("""src/\uFEFFmain.kt"""), described)
        entryLines(described).forEach { line ->
            assertTrue(line.contains(ApplyPlan.HIDDEN_CHARS_FLAG), "an altered path must be flagged: $line")
        }
    }

    @Test
    fun entriesAreNumberedSoAWrappedTailCannotPassForAnotherEntry() {
        val described = ApplyPlan.describePaths(listOf("a.kt", "dir with  two  spaces/b.kt", "c.kt"))
        val lines = entryLines(described)
        assertEquals(3, lines.size)
        lines.forEachIndexed { i, line -> assertTrue(line.trimStart().startsWith("[${i + 1}] "), line) }
        assertTrue(plain(described).contains("dir with  two  spaces/b.kt"), "space runs are kept verbatim")
    }

    /**
     * The dialog word-wraps, so a breakable space inside a path would let it choose where a
     * continuation line starts — and `a.kt   [2] src/fake.kt` would then read as a second entry.
     * Inside an entry, every space is a NO-BREAK space; only the gap before this plugin's own flag
     * text may break.
     */
    @Test
    fun aPathCannotChooseASpaceToWrapAt() {
        val bait = "src/" + "x".repeat(60) + ".kt   [2] src/fake.kt"
        val nbspBait = "src/" + "y".repeat(60) + ".kt\u00A0\u00A0[2]\u00A0src/fake.kt"
        val emSpaceBait = "src/z.kt\u2003[2]\u2003src/fake.kt"
        val described = ApplyPlan.describePaths(listOf(bait, nbspBait, emSpaceBait))
        val lines = described.lines()
        assertEquals(3, lines.size, described)
        lines.forEachIndexed { i, line ->
            val entry = line.removePrefix("  ").substringBefore("   ${ApplyPlan.HIDDEN_CHARS_FLAG}")
            assertTrue(entry.startsWith("[${i + 1}]\u00A0"), "number and path are glued: $line")
            assertFalse(entry.contains(' '), "a breakable space inside entry ${i + 1}: $line")
        }
        assertFalse(lines[0].contains(ApplyPlan.HIDDEN_CHARS_FLAG), "ASCII spaces are legitimate, not flagged")
        assertTrue(lines[1].contains("""\u00A0[2]\u00A0src/fake.kt""") && lines[1].contains(ApplyPlan.HIDDEN_CHARS_FLAG), lines[1])
        assertTrue(lines[2].contains("""\u2003[2]\u2003""") && lines[2].contains(ApplyPlan.HIDDEN_CHARS_FLAG), lines[2])
    }

    @Test
    fun flaggedPathsBeyondTheListedLimitAreCounted() {
        val paths = (1..ApplyPlan.MAX_LISTED_PATHS).map { "ok$it.kt" } + listOf("late.kt", "late\u202E.kt", "late\u200B.kt")
        val tail = ApplyPlan.describePaths(paths).lines().last()
        assertEquals("  … and 3 more (2 of them flagged [!])", tail)
    }

    /**
     * S6: once displayed, a path that literally contains the characters `\n` or `\u202E` reads
     * exactly like one whose hidden character was escaped, so it is flagged the same way.
     */
    @Test
    fun aLiteralEscapeSequenceInAPathIsFlaggedLikeARealOne() {
        val literal = listOf("src/a\\nb.kt", "src/invoice\\u202Etxt.exe", "src/\\UFFFFFFFF.kt", "src/tab\\t.kt")
        entryLines(ApplyPlan.describePaths(literal)).forEach { line ->
            assertTrue(line.contains(ApplyPlan.HIDDEN_CHARS_FLAG), "a literal escape must be flagged: $line")
        }
        val ordinary = entryLines(ApplyPlan.describePaths(listOf("src/windows\\path.kt", "src/a\\b.kt"))).joinToString("\n")
        assertFalse(ordinary.contains(ApplyPlan.HIDDEN_CHARS_FLAG), "other backslashes are not escapes: $ordinary")
    }

    /**
     * Security re-review W2: Unicode "mathematical bold" letters look like the dialog's bold
     * headers, and full-width forms look like ASCII. Flagged; a merely decomposed (NFD) path is not.
     */
    @Test
    fun lookAlikeCompatibilityCharactersAreFlagged() {
        val mathBold = "src/\uD835\uDC0D\uD835\uDC0E\uD835\uDC13 sent.kt"
        val fullWidth = "src/\uFF21\uFF50\uFF50.kt"
        val ligature = "src/\uFB01le.kt"
        entryLines(ApplyPlan.describePaths(listOf(mathBold, fullWidth, ligature))).forEach { line ->
            assertTrue(line.contains(ApplyPlan.HIDDEN_CHARS_FLAG), "a look-alike must be flagged: $line")
        }
        val nfd = entryLines(ApplyPlan.describePaths(listOf("cafe\u0301/resume\u0301.txt"))).single()
        assertFalse(nfd.contains(ApplyPlan.HIDDEN_CHARS_FLAG), "a decomposed accent is not a look-alike: $nfd")
    }

    @Test
    fun legitimateNonAsciiPathsAreUnchangedAndUnflagged() {
        val paths = listOf(
            "src/日本語/ファイル.kt",
            "docs/файл.md",
            "café/précis.txt",
            "café/résumé.txt",
            "assets/🚀/launch 🎉.png",
            "lib/عربي/ملف.kt",
        )
        val described = ApplyPlan.describePaths(paths)
        val lines = entryLines(described)
        assertEquals(paths.size, lines.size, described)
        paths.forEachIndexed { i, path ->
            assertEquals("  [${i + 1}] $path", lines[i], "legitimate path must display exactly")
            assertFalse(lines[i].contains(ApplyPlan.HIDDEN_CHARS_FLAG))
        }
    }

    @Test
    fun anAbsurdlyLongPathIsElidedVisiblyNotSilently() {
        val long = "src/" + "a".repeat(5_000) + "/tail.kt"
        val line = entryLines(ApplyPlan.describePaths(listOf(long))).single()
        assertTrue(line.length < 600, "one entry must stay one readable line, got ${line.length} chars")
        assertTrue(line.contains("chars elided"), line)
        assertTrue(line.contains("/tail.kt"), "the end of the path stays visible: $line")
        assertTrue(line.contains("src/aaa"), "the start of the path stays visible: $line")
    }
}
