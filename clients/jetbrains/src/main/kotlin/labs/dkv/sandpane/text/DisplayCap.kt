package labs.dkv.sandpane.text

/**
 * Length cap for one line of Core- or sbx-supplied text in a dialog or chooser row (A3a review item 3):
 * an impact line, a project or sandbox name, a repository path. Core does not bound these lists' line
 * lengths, and a very long line can push this plugin's own text out of view.
 *
 * Counts Unicode code points (never splits a surrogate pair) and marks a cut with "…". Applied to the
 * raw value before [VisibleText.reveal], so the visible text never exceeds the cap by more than the
 * escapes reveal adds.
 */
object DisplayCap {

    const val MAX_CODE_POINTS: Int = 200

    fun cap(text: String, max: Int = MAX_CODE_POINTS): String {
        if (text.codePointCount(0, text.length) <= max) return text
        return text.substring(0, text.offsetByCodePoints(0, max)) + "…"
    }
}
