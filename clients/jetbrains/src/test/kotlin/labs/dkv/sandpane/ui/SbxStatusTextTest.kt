package labs.dkv.sandpane.ui

import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.SbxStatus
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A8a (design 2026-10-09 §3.8 item 1): the sbx status lines of the refresh notification — exact
 * daemon / verification-runs / captured-fixtures wording, absent fields render no line, no
 * "ready"/"healthy" wording anywhere, and the two new optional fields decode additively.
 */
class SbxStatusTextTest {

    private val tristate = listOf(true, false, null)

    @Test
    fun daemonStringsCoverRunningStoppedAndUnknown() {
        // "(at last check)": the reading is the connect-time probe; `sbx ls` (refresh) can auto-start
        // the daemon afterwards (security review W2).
        assertEquals("SBX daemon running (at last check)", SbxStatusText.daemon(true))
        assertEquals("SBX daemon stopped (at last check)", SbxStatusText.daemon(false))
        assertEquals("SBX daemon state unknown", SbxStatusText.daemon(null))
    }

    @Test
    fun execLineOnlyWhenPresent() {
        assertEquals("Verification runs are enabled for this sbx version", SbxStatusText.exec(true))
        assertEquals("Verification runs are not enabled for this sbx version", SbxStatusText.exec(false))
        assertNull(SbxStatusText.exec(null))
    }

    @Test
    fun capturedLineOnlyWhenPresent() {
        assertEquals(
            "Same sbx version number as Sandpane's captured fixtures (macOS; build not compared): yes",
            SbxStatusText.captured(true),
        )
        assertEquals(
            "Same sbx version number as Sandpane's captured fixtures (macOS; build not compared): no",
            SbxStatusText.captured(false),
        )
        assertNull(SbxStatusText.captured(null))
    }

    @Test
    fun installedShowsHeadlineThenDaemonThenPresentLinesOnly() {
        val today = SbxStatus(
            installed = true,
            binaryPath = "/opt/sbx",
            version = "v0.47.0",
            daemonRunning = true,
            execVerified = false,
            versionCaptured = true,
        )
        assertEquals(
            listOf(
                "SBX: installed (v0.47.0); 2 project(s) in Core",
                "SBX daemon running (at last check)",
                "Verification runs are not enabled for this sbx version",
                "Same sbx version number as Sandpane's captured fixtures (macOS; build not compared): yes",
                "SBX status is from the connection check, not this refresh",
            ),
            SbxStatusText.refreshLines(today, 2),
        )

        // An older Core (or an unknown version): no exec/captured line, daemon state unknown.
        val older = SbxStatus(installed = true, version = null)
        assertEquals(
            listOf(
                "SBX: installed (version not probed); 0 project(s) in Core",
                "SBX daemon state unknown",
                SbxStatusText.FROM_CONNECTION_CHECK,
            ),
            SbxStatusText.refreshLines(older, 0),
        )

        val stopped = SbxStatus(installed = true, version = "v0.47.0", daemonRunning = false)
        assertEquals(
            listOf(
                "SBX: installed (v0.47.0); 1 project(s) in Core",
                "SBX daemon stopped (at last check)",
                SbxStatusText.FROM_CONNECTION_CHECK,
            ),
            SbxStatusText.refreshLines(stopped, 1),
        )
    }

    @Test
    fun notInstalledAndNotReportedHaveNoDaemonLine() {
        assertEquals(listOf(SbxStatusText.NOT_REPORTED), SbxStatusText.refreshLines(null, 3))
        assertEquals(
            listOf(SbxStatusText.NOT_INSTALLED, SbxStatusText.FROM_CONNECTION_CHECK),
            SbxStatusText.refreshLines(SbxStatus(installed = false), 3),
        )
        assertTrue(SbxStatusText.NOT_INSTALLED.contains("Sandpane bundles no sbx binary"))
    }

    @Test
    fun theCoreVersionStringIsShownSingleLineWithHiddenCharactersRevealed() {
        val hostile = SbxStatus(installed = true, version = "v0.47.0\nSBX daemon running\u202E")
        val headline = SbxStatusText.refreshLines(hostile, 0).first()
        assertFalse(headline.contains('\n'), headline)
        assertFalse(headline.contains('\u202E'), headline)
    }

    @Test
    fun noReadyOrHealthyWordingInAnyCombination() {
        val forbidden = listOf("ready", "healthy")
        for (installed in listOf(true, false)) for (daemon in tristate) for (exec in tristate) for (captured in tristate) {
            val status = SbxStatus(
                installed = installed,
                version = "v0.47.0",
                daemonRunning = daemon,
                execVerified = exec,
                versionCaptured = captured,
            )
            val shown = SbxStatusText.refreshLines(status, 1)
            for (line in shown) for (word in forbidden) {
                assertFalse(line.lowercase().contains(word), "\"$word\" in \"$line\" for $status")
            }
            // The captured line is evidence, never a support claim: no "supported"/"verified" wording.
            shown.filter { it.startsWith(SbxStatusText.CAPTURED_PREFIX) }.forEach { line ->
                assertFalse(line.lowercase().contains("support"), line)
                assertFalse(line.lowercase().contains("verified"), line)
            }
            // Absent ⇒ no line, never rendered as "no".
            assertEquals(exec != null, shown.any { it.startsWith("Verification runs") }, "$status")
            assertEquals(captured != null, shown.any { it.startsWith(SbxStatusText.CAPTURED_PREFIX) }, "$status")
            assertEquals(installed, shown.any { it.startsWith("SBX daemon") }, "$status")
            // A known daemon state is always qualified as the connect-time reading, and the sbx block
            // always ends by saying it is not part of this refresh (security review W2).
            shown.filter { it.startsWith("SBX daemon") && daemon != null }
                .forEach { assertTrue(it.endsWith(" (at last check)"), it) }
            assertEquals(SbxStatusText.FROM_CONNECTION_CHECK, shown.last(), "$status")
        }
        for (line in listOf(SbxStatusText.NOT_REPORTED, SbxStatusText.NOT_INSTALLED)) {
            for (word in forbidden) assertFalse(line.lowercase().contains(word), line)
        }
    }

    @Test
    fun theNewOptionalFieldsDecodeAdditively() {
        fun caps(sbx: String): CoreCapabilities = CoreJson.decodeFromString(
            CoreCapabilities.serializer(),
            """{"protocolVersion":1,"coreVersion":"0.1.0","instanceId":"i","sbx":$sbx,"agents":[],"platform":"macos"}""",
        )

        val a8a = assertNotNull(
            caps(
                """{"installed":true,"binaryPath":"/opt/sbx","version":"v0.47.0","daemonRunning":false,""" +
                    """"execVerified":false,"versionCaptured":true}""",
            ).sbx,
        )
        assertEquals(false, a8a.daemonRunning)
        assertEquals(false, a8a.execVerified)
        assertEquals(true, a8a.versionCaptured)

        val flipped = assertNotNull(
            caps("""{"installed":true,"version":"v0.48.0","daemonRunning":true,"execVerified":true,"versionCaptured":false}""").sbx,
        )
        assertEquals(true, flipped.execVerified)
        assertEquals(false, flipped.versionCaptured)

        // A pre-A8a Core: both keys absent ⇒ null (no line), and an unknown extra key is tolerated.
        val older = assertNotNull(caps("""{"installed":true,"version":"v0.47.0","daemonRunning":null,"policyInitialized":true}""").sbx)
        assertNull(older.daemonRunning)
        assertNull(older.execVerified)
        assertNull(older.versionCaptured)

        // sbx not installed: Core omits every optional field.
        val absent = assertNotNull(caps("""{"installed":false}""").sbx)
        assertEquals(
            listOf(SbxStatusText.NOT_INSTALLED, SbxStatusText.FROM_CONNECTION_CHECK),
            SbxStatusText.refreshLines(absent, 0),
        )
    }

    @Test
    fun pluginDeclaresNoDaemonControl() {
        // The daemon is a machine-wide setting the user changes with the sbx CLI; this plugin only
        // reports it. No action, and no main-source call, may start or stop it.
        val pluginXml = File("src/main/resources/META-INF/plugin.xml").readText()
        assertFalse(pluginXml.lowercase().contains("daemon"), "plugin.xml mentions a daemon action")
        val sources = File("src/main/kotlin").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue(sources.isNotEmpty())
        for (file in sources) {
            val text = file.readText()
            // `sbx daemon start|stop` as text or as an argv pair; "SBX daemon stopped" (a status) is fine.
            val control = Regex("""\bdaemon\s+(start|stop)\b|"daemon"\s*,\s*"(start|stop)"""")
            assertFalse(control.containsMatchIn(text), "${file.name} starts or stops the sbx daemon")
        }
    }
}
