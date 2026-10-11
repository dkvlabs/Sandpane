package labs.dkv.sandpane.ui

import labs.dkv.sandpane.core.RunTarget
import labs.dkv.sandpane.core.Verifications
import labs.dkv.sandpane.model.OutputRedaction
import labs.dkv.sandpane.model.VerificationResult
import labs.dkv.sandpane.model.WorkspaceMode
import labs.dkv.sandpane.text.VisibleText
import java.io.File
import javax.swing.JTextField
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * A7 rendering and invocation (design 2026-10-09 \u00A73.7 items 6 and 8): untrusted output, labels,
 * argv and notes are shown revealed (ESC, OSC 8, OSC 52, bidi and every other C0/C1 control except
 * LF and TAB escaped, a CR as `\r`), never reach an HTML sink unescaped, a terminal, a console or a
 * link detector; the approve and run dialogs open only from this plugin's own click handlers.
 * Hostile characters are written as `\u` escapes, never raw.
 */
class VerificationUiTest {

    private val esc = "\u001B"
    private val bel = "\u0007"

    /** ANSI colour, an OSC 8 hyperlink, an OSC 52 clipboard write, a bidi override, C1 CSI, CR, CRLF, TAB. */
    private val hostile = "red ${esc}[31mX${esc}[0m link ${esc}]8;;file:///etc/passwd${bel}click${esc}]8;;${bel} " +
        "clip ${esc}]52;c;cm0gLXJmIH4=${bel} bidi \u202Eexe.txt\u202C c1 \u009B2J del \u007F\r\nnext\tcol\rover\nend"

    private val forbiddenRaw = listOf(esc, bel, "\u202E", "\u202C", "\u009B", "\u007F", "\r")

    private fun assertNoRawControls(text: String, where: String) {
        for (c in forbiddenRaw) assertFalse(text.contains(c), "raw U+%04X reached $where".format(c[0].code))
    }

    @Test
    fun outputIsRevealedWithCrShownAndOnlyLfAndTabKept() {
        val shown = Verifications.outputText(hostile)
        assertNoRawControls(shown, "the output text")
        assertTrue(shown.contains("\\u001B[31m"), shown)
        assertTrue(shown.contains("\\u001B]8;;file:///etc/passwd\\u0007"), "an OSC 8 link must be inert text")
        assertTrue(shown.contains("\\u001B]52;c;"), "an OSC 52 clipboard write must be inert text")
        assertTrue(shown.contains("\\u202Eexe.txt\\u202C"))
        assertTrue(shown.contains("\\u009B2J"))
        assertTrue(shown.contains("\\u007F"))
        // CRLF: the CR is visible and the LF stays a real line break; a lone CR is visible too.
        assertTrue(shown.contains("\\u007F\\r\nnext\tcol\\rover\nend"), shown)
        assertEquals(3, shown.split('\n').size)
    }

    @Test
    fun theApproveConfirmationListsEveryElementWithItsCountAndTheStatements() {
        val argv = listOf("npm", " run", "te${esc}]8;;http://x${bel}st", "a\tb", "line\nbreak", "", "\u202Egnp.exe", "<b>x</b>")
        val notes = listOf("npm run test runs: ${esc}]52;c;AAAA$bel jest", "this is the file in your registered repository now")
        val lines = VerificationText.approveConfirmation("Atlas Demo", "unit <script>", argv, notes, editedFromSuggestion = false)
        for (l in lines) {
            assertNoRawControls(l, "the approve confirmation")
            assertFalse(l.contains("\n") || l.contains("\t"), "a raw line break or tab reached a confirmation line")
        }
        val text = lines.joinToString("\n")
        assertTrue(text.contains("Arguments (8)"))
        for (i in 1..8) assertEquals(1, lines.count { it.startsWith("  [$i] ⟨") }, "element $i is not its own row")
        assertTrue(text.contains("⟨ run⟩"), "a leading space must be visible inside the delimiters")
        assertTrue(text.contains("⟨⟩"), "an empty element must be visible")
        assertTrue(text.contains("a\\tb") && text.contains("line\\nbreak"))
        assertTrue(text.contains("\\u202Egnp.exe"))
        // Plain text: markup is shown literally, never interpreted (there is no HTML anywhere).
        assertTrue(text.contains("<b>x</b>") && text.contains("unit <script>"))
        assertTrue(text.contains(Verifications.DO_NOT_PUT_SECRETS))
        assertTrue(text.contains("Approval binds this exact argument list, not what it executes."))
        assertTrue(text.contains("`npm run test`, `make test` or `./gradlew test`"))
        assertTrue(text.contains("Notes Core showed for this suggestion (2)") && text.contains("[n1]") && text.contains("[n2]"))
        assertTrue(text.contains("\\u001B]52;c;AAAA\\u0007"))
        assertFalse(text.contains(VerificationText.EDITED_SUGGESTION))
        // D-I4: an edited suggestion shows no notes and no suggestion heading, and says why.
        val edited = VerificationText.approveConfirmation("Atlas Demo", "unit", argv + "-v", null, editedFromSuggestion = true)
        assertFalse(edited.any { it.contains("Notes Core showed") || it.startsWith("  [n") }, edited.toString())
        assertTrue(edited.contains(VerificationText.EDITED_SUGGESTION))
        // Rendered as a non-editable plain text area with HTML disabled, one row per line.
        val area = VerificationConfirmDialog.textPane(lines)
        assertFalse(area.isEditable)
        assertEquals(true, area.getClientProperty(PlainText.HTML_DISABLE_KEY))
        assertEquals(lines.size, area.text.split('\n').size)
        assertNoRawControls(area.text, "the confirmation text area")
    }

    @Test
    fun theRunConfirmationShowsTheCommandSandboxModeAndItsWarnings() {
        val direct = VerificationText.runConfirmation("task-1", RunTarget.Bound("atlas-demo", WorkspaceMode.DIRECT_MOUNT), "unit${esc}[2J", listOf("make", "test")).joinToString("\n")
        assertNoRawControls(direct, "the run confirmation")
        assertTrue(direct.contains("atlas-demo") && direct.contains("direct_mount") && direct.contains("unit\\u001B[2J"))
        assertTrue(direct.contains("  [1] ⟨make⟩") && direct.contains("  [2] ⟨test⟩"))
        assertTrue(direct.contains(Verifications.DIRECT_MOUNT_WARNING))
        assertTrue(direct.contains(Verifications.RUN_WHERE))
        assertFalse(direct.contains("changed since reviewed"))
        val worktree = VerificationText.runConfirmation("task-1", RunTarget.Bound("nova-demo", WorkspaceMode.HOST_WORKTREE), "unit", listOf("make")).joinToString("\n")
        assertTrue(worktree.contains("\"changed since reviewed\""), "the host_worktree review warning is missing")
        assertFalse(worktree.contains(Verifications.DIRECT_MOUNT_WARNING))
        assertTrue(worktree.contains(Verifications.RUN_WHERE))
        val clone = VerificationText.runConfirmation("task-1", RunTarget.Bound("orbit-demo", WorkspaceMode.SBX_CLONE), "unit", listOf("make")).joinToString("\n")
        assertFalse(clone.contains(Verifications.DIRECT_MOUNT_WARNING) || clone.contains("changed since reviewed"))
    }

    @Test
    fun theResultHeaderRevealsEveryUntrustedValue() {
        val r = VerificationResult(
            runId = "r1",
            label = "unit$esc]8;;x$bel",
            argv = listOf("sh", "-c", "echo \u202Ehi"),
            sandbox = "atlas-demo\u200B",
            workspaceMode = "direct_mount",
            outcome = "exited",
            exitCode = 0,
            stdout = hostile,
            stdoutTruncated = false,
            stderrTruncated = false,
            redactions = OutputRedaction(replacements = 0),
        )
        val lines = VerificationText.resultHeader(r)
        lines.forEach { assertNoRawControls(it, "the result header") }
        assertTrue(lines.any { it == "outcome: exit status 0 (as reported by sbx exec)" }, lines.toString())
        assertTrue(lines.any { it.contains("atlas-demo\\u200B") })
        assertTrue(lines.none { it.contains("passed", ignoreCase = true) })
    }

    @Test
    fun anArgvFieldKeepsEveryCharacterTheUserTypedOrCorePrefilled() {
        // Swing's default JTextField replaces a set LF with a space: an element would be silently altered.
        val plain = JTextField()
        plain.text = "a\nb"
        assertEquals("a b", plain.text, "precondition: Swing filters newlines by default")
        for (value in listOf("np\tm", "a\nb", "say \"hi\"", "caf\u00E9 \u4E2D", " leading", "")) {
            val field = VerificationArgvDialog.keepNewlines(JTextField())
            field.text = value
            assertEquals(value, field.text, "an element was altered by the text field")
        }
    }

    // -----------------------------------------------------------------------
    // invocation: gesture-only, no entry point takes argv or ids (source scans)
    // -----------------------------------------------------------------------

    private val main = File("src/main/kotlin")
    private val all by lazy { main.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList() }
    private val panel by lazy { File("src/main/kotlin/labs/dkv/sandpane/ui/VerificationPanel.kt").readText() }

    /** The body of `private fun NAME(...)` in [src], up to the next member at the same indentation. */
    private fun body(src: String, name: String): String {
        val start = src.indexOf("    private fun $name(")
        assertTrue(start >= 0, "no private fun $name")
        val next = Regex("""\n    (private |override |internal )?fun """).find(src, start + 10)?.range?.first ?: src.length
        return src.substring(start, next)
    }

    @Test
    fun theDialogsAreConstructedOnlyInThePanelsClickHandlers() {
        val expected = mapOf(
            "VerificationArgvDialog(" to listOf("approveWithDialogs"),
            "VerificationConfirmDialog(project" to listOf("approveWithDialogs", "onRevokeClicked"),
            "VerificationRunDialog(" to listOf("onRunClicked"),
            "VerificationOutputDialog(" to listOf("onViewOutputClicked"),
        )
        for ((ctor, owners) in expected) {
            val users = all.filter { it.readText().contains(ctor) && !it.path.endsWith("ui/VerificationDialogs.kt") }
            assertEquals(listOf("VerificationPanel.kt"), users.map { it.name }, "$ctor is constructed elsewhere")
            assertEquals(owners.size, Regex(Regex.escape(ctor)).findAll(panel).count(), "$ctor constructed an unexpected number of times")
            for (owner in owners) {
                val b = body(panel, owner)
                assertTrue(b.contains(ctor), "$ctor is not in $owner")
                assertFalse(b.substring(0, b.indexOf(ctor)).contains("invokeLater") || b.substring(0, b.indexOf(ctor)).contains("onEdt"),
                    "$ctor is deferred to a later event in $owner")
                assertFalse(b.substring(0, b.indexOf(ctor)).contains("whenComplete"), "$ctor waits for a Core answer in $owner")
            }
        }
        // approveWithDialogs is reached only from the two approve click handlers.
        assertEquals(3, Regex("""approveWithDialogs\(""").findAll(panel).count())
        assertTrue(body(panel, "onAddCommandClicked").contains("approveWithDialogs("))
        assertTrue(body(panel, "onApproveSuggestionClicked").contains("approveWithDialogs("))
    }

    @Test
    fun everyEntryPointIsAParameterlessClickHandlerWiredOnlyToItsButton() {
        val handlers = Regex("""private fun (on[A-Za-z]+Clicked)\(([^)]*)\)""").findAll(panel).map { it.groupValues[1] to it.groupValues[2] }.toList()
        assertEquals(
            setOf(
                "onRefreshClicked", "onAddCommandClicked", "onRevokeClicked", "onApproveSuggestionClicked",
                "onRunClicked", "onRefreshResultClicked", "onViewOutputClicked", "onDetectSuggestionsClicked",
            ),
            handlers.map { it.first }.toSet(),
        )
        for ((name, params) in handlers) {
            assertEquals("", params, "$name takes parameters: argv, a command id or a run id must never be passed in")
            val calls = Regex("""(?<!fun )\b$name\(\)""").findAll(panel).map { it.range.first }.toList()
            assertEquals(1, calls.size, "$name is called from more than its button")
            val line = panel.substring(panel.lastIndexOf('\n', calls.single()), panel.indexOf('\n', calls.single()))
            assertTrue(line.contains(".addActionListener {"), "$name is not wired to a button: $line")
        }
        // No AnAction, URI handler, chat path or event listener opens the A7 dialogs or runs a write.
        val writes = listOf("verificationApprove(", "verificationRevoke(", "verificationRun(")
        for (w in writes) {
            val users = all.filter { it.readText().contains(".$w") }.map { it.name }.toSet()
            assertEquals(setOf("VerificationPanel.kt"), users, "$w is called outside the panel")
        }
        // The event listener only reads (verification.result) and never opens anything.
        val listener = panel.substring(panel.indexOf("removeViewListener = tasks.addViewListener"), panel.indexOf("// reads (read-only; io pool)"))
        for (w in writes + listOf("Dialog(", "approveWithDialogs", "Clicked(")) assertFalse(listener.contains(w), "the event listener reaches $w")
    }

    @Test
    fun outputNeverReachesAConsoleTerminalLinkDetectorOrHtml() {
        val dialogs = File("src/main/kotlin/labs/dkv/sandpane/ui/VerificationDialogs.kt").readText()
        val output = dialogs.substring(dialogs.indexOf("class VerificationOutputDialog("))
        assertTrue(output.contains("JTextArea(Verifications.outputText(text))"))
        assertTrue(output.contains("isEditable = false"))
        for (forbidden in listOf("JEditorPane", "htmlPane", "text/html", "ConsoleView", "Filter", "Hyperlink", "Terminal", "BrowserUtil")) {
            assertFalse(output.contains(forbidden), "the output viewer uses $forbidden")
        }
        val sources = listOf("ui/VerificationPanel.kt", "ui/VerificationDialogs.kt", "ui/VerificationText.kt", "core/Verification.kt")
            .map { File("src/main/kotlin/labs/dkv/sandpane/$it").readText() }
        for (src in sources) {
            for (forbidden in listOf("ConsoleView", "HyperlinkInfo", "com.intellij.execution.filters", "TerminalView", "BrowserUtil")) {
                assertFalse(src.contains(forbidden), "an A7 source uses $forbidden")
            }
        }
        // Lists render through the plain-text renderer; notes go to a non-editable plain text area.
        assertEquals(5, Regex("""PlainTextListRenderer \{""").findAll(panel).count())
        assertTrue(panel.contains("PlainText.disableHtml(notesArea)"))
        // Every untrusted value in the panel's rows passes through the reveal helpers.
        assertTrue(VisibleText.reveal("x\u202E") != "x\u202E")
    }

    // -----------------------------------------------------------------------
    // review fixes (J-W1, J-W2, J-I2, J-I3, D-I4)
    // -----------------------------------------------------------------------

    @Test
    fun theRunSuccessPathFollowsTheTaskOnTheEdtWithoutASummary() {
        // J-W1: track(id, conversationId, summary) overwrites the monitor's status with a possibly stale row.
        assertFalse(panel.contains("tasks.track("), "the panel calls track directly (it may pass a stale TaskSummary)")
        val dispatch = body(panel, "dispatchRun")
        val follow = dispatch.indexOf("VerificationRuns.followAfterStart(task, tasks::track)")
        assertTrue(follow >= 0, "the run success path does not follow the task through followAfterStart")
        val edt = dispatch.indexOf("onEdt {")
        assertTrue(edt in 0 until follow, "the task is followed from the io-pool thread, not the EDT")
    }

    @Test
    fun noA7DialogRendersHtml() {
        // J-W2 (§3.7 item 6): confirmations are plain Swing text, never text/html.
        for (f in listOf("ui/VerificationDialogs.kt", "ui/VerificationText.kt", "ui/VerificationPanel.kt")) {
            val src = File("src/main/kotlin/labs/dkv/sandpane/$f").readText()
            for (forbidden in listOf("text/html", "DialogHtml", "JEditorPane", "HTMLEditorKit", "<html", "htmlPane")) {
                assertFalse(src.contains(forbidden), "$f uses $forbidden")
            }
        }
    }

    @Test
    fun projectContextIsReadOnlyOnTheDetectSuggestionsClick() {
        // J-I2: never from reload(), a reconnect or a project switch.
        assertEquals(1, Regex("""\.projectContext\(""").findAll(panel).count(), "project.context is read from more than one place")
        assertTrue(body(panel, "onDetectSuggestionsClicked").contains(".projectContext("))
        assertFalse(body(panel, "reload").contains("projectContext"))
        val users = all.filter { it.readText().contains(".projectContext(") }.map { it.name }.toSet()
        assertEquals(setOf("VerificationPanel.kt"), users)
    }

    @Test
    fun debugPrintsShowSizesAndCountsOnly() {
        // J-I3: argv, notes, labels and paths never reach a log through toString.
        val secret = "SECRET-VALUE"
        val manifest = labs.dkv.sandpane.model.DetectedManifest("$secret.json", listOf(listOf("make", secret)), listOf("note $secret"))
        val repo = labs.dkv.sandpane.model.RepositoryContext("/Users/demo/$secret", listOf(manifest), listOf("$secret.toml"))
        val command = labs.dkv.sandpane.model.VerificationCommand("c1", "p1", "label $secret", listOf(secret))
        val printed = listOf(
            manifest.toString(),
            repo.toString(),
            labs.dkv.sandpane.model.ProjectContextResult(listOf(repo), listOf(command)).toString(),
            VerificationPanel.Suggestion("/Users/demo/$secret", "$secret.json", listOf(secret), listOf(secret), listOf(secret)).toString(),
            labs.dkv.sandpane.core.VerificationActivity.Run("r1", "t1", "sandbox-$secret", "label $secret", 3, finished = false).toString(),
            command.toString(),
            labs.dkv.sandpane.model.VerificationApproveParams("p1", "label $secret", listOf(secret)).toString(),
            VerificationResult(runId = "r1", label = secret, argv = listOf(secret), sandbox = secret, stdout = secret, stderr = secret).toString(),
        )
        for (p in printed) assertFalse(p.contains("SECRET"), "a debug print carries untrusted content: $p")
        assertTrue(printed[0].contains("1 suggestion") && printed[0].contains("1 note"), printed[0])
        assertTrue(printed[1].contains("1 manifest") && printed[1].contains("1 unreadable"), printed[1])
        assertTrue(printed[2].contains("1 repositor") && printed[2].contains("1 approved"), printed[2])
    }

    @Test
    fun notesFollowTheSuggestionOnlyWhileItsArgvIsUnchanged() {
        // D-I4: Core's notes describe the ORIGINAL suggested argv; an edited list drops them.
        val suggested = listOf("make", "test")
        val notes = listOf("Makefile target 'test' runs: go test ./...")
        assertEquals(notes, VerificationText.notesForConfirmation(suggested, notes, listOf("make", "test")))
        for (edited in listOf(listOf("make", "test", "-v"), listOf("make", "test "), listOf("make"), listOf("make", "test ").map { it.trim() } + "x")) {
            assertEquals(null, VerificationText.notesForConfirmation(suggested, notes, edited), "notes shown for an edited list $edited")
        }
        assertEquals(null, VerificationText.notesForConfirmation(null, null, listOf("make")))
    }
}
