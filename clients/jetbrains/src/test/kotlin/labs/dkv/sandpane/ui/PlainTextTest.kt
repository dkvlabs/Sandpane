package labs.dkv.sandpane.ui

import javax.swing.JComponent
import javax.swing.JList
import javax.swing.plaf.basic.BasicHTML
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Security review S1: Core/user text that starts with `<html>` must be drawn literally. The
 * observable is Swing's own: `BasicHTML` stores an HTML view under [BasicHTML.propertyKey] when it
 * decides to render markup, and stores nothing when `html.disable` is set.
 */
class PlainTextTest {

    private val hostile = "<html><b>Pwned</b><img src='http://example.invalid/x.png'>"

    @Test
    fun aPlainLabelDoesNotBuildAnHtmlView() {
        val label = PlainText.label(hostile)
        assertEquals(hostile, label.text)
        assertNull(label.getClientProperty(BasicHTML.propertyKey), "html.disable must stop BasicHTML")
    }

    @Test
    fun controlCaseAnOrdinaryLabelWouldRenderTheMarkup() {
        // Negative control: proves the assertion above can fail on this JVM/LaF.
        val label = javax.swing.JLabel(hostile)
        assertNotNull(label.getClientProperty(BasicHTML.propertyKey))
    }

    @Test
    fun theListRendererShowsCoreTextLiterally() {
        val renderer = PlainTextListRenderer { value -> value.toString() to "tip for $value" }
        val component = renderer.getListCellRendererComponent(JList<String>(), hostile, 0, false, false) as JComponent
        assertNull(component.getClientProperty(BasicHTML.propertyKey))
        val tip = assertNotNull(component.toolTipText)
        assertTrue(tip.startsWith("<html>") && tip.contains("&lt;b&gt;Pwned&lt;/b&gt;"), tip)
    }

    @Test
    fun notificationTextIsEscapedAndKeepsLineBreaks() {
        assertEquals("a &lt;b&gt; &amp; &quot;c&quot;<br>d", NotificationText.escapeMultiline("a <b> & \"c\"\nd"))
    }
}

/** Review suggestion 4: action descriptions carry no formable tag. */
class PlainTextInertTest {
    @Test
    fun angleBracketsBecomeLookAlikesSoNoTagCanForm() {
        val inert = PlainText.inert("<html><b>x</b> at /tmp/<a>.sock")
        kotlin.test.assertFalse(inert.contains('<') || inert.contains('>'))
        kotlin.test.assertEquals("‹html›‹b›x‹/b› at /tmp/‹a›.sock", inert)
    }
}
