package labs.dkv.sandpane.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.GitDiffResult
import labs.dkv.sandpane.model.Reported
import labs.dkv.sandpane.model.reported
import labs.dkv.sandpane.services.EditorDiffProvider
import labs.dkv.sandpane.ui.GitDiffText
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A5 (`git.diff` + ChangeSet fields, design 2026-10-09 §3.5), client side. The units under test are
 * the REAL [CoreCommands.gitDiff] (only the socket is replaced, so [DiffRpc.sent] is what would go on
 * the wire), [GitDiffs], [GitDiffText] and [EditorDiffProvider]'s pure path and summary helpers.
 * Every patch and answer below is an illustrative fixture shaped like Core's output, not a capture.
 */
private class DiffRpc(private val reply: () -> CompletableFuture<JsonElement>) : CoreRpc {
    val sent = ArrayList<Pair<String, JsonObject>>()
    override fun request(method: String, params: JsonElement): CompletableFuture<JsonElement> {
        sent += method to (params as JsonObject)
        return reply()
    }
}

class GitDiffTest {

    private val taskId = "5b0c7a1e-0000-4000-8000-00000000d1ff"

    private fun caps(methods: List<String> = CoreMethods.ALL) = CoreCapabilities(
        protocolVersion = 1,
        coreVersion = "0.1.0",
        instanceId = "i",
        platform = "macos",
        methods = methods,
    )

    private fun ok(json: String): () -> CompletableFuture<JsonElement> = { CompletableFuture.completedFuture(CoreJson.parseToJsonElement(json)) }

    private val okDiff = ok("""{"path":"p","status":"modified","patch":"","binary":false,"truncated":false,"lossy":false}""")

    private fun result(
        path: String = "src/app.kt",
        status: Reported<FileChangeStatus> = FileChangeStatus.MODIFIED.reported(),
        patch: String = "diff --git a/src/app.kt b/src/app.kt\n@@ -1 +1 @@\n-a\n+b\n",
        binary: Boolean = false,
        truncated: Boolean = false,
        lossy: Boolean = false,
        oldPath: String? = null,
        baseBlob: String? = null,
    ) = GitDiffResult(path, oldPath, status, patch, binary, truncated, lossy, baseBlob)

    // -----------------------------------------------------------------------
    // frames
    // -----------------------------------------------------------------------

    @Test
    fun theFrameCarriesTheExactPathAndTheEntrysStatus() {
        // A tab, a newline, a quote, a backslash, a leading space and non-ASCII: passed through untouched.
        val exact = " dir/a\tb\"c\\d\u00E9\nz.txt "
        val rpc = DiffRpc(okDiff)
        CoreCommands(rpc) { caps() }.gitDiff(taskId, FileChange(exact, FileChangeStatus.UNTRACKED.reported())).get()
        val (method, params) = rpc.sent.single()
        assertEquals(CoreMethods.GIT_DIFF, method)
        assertEquals(exact, params["path"]!!.jsonPrimitive.content, "the path is byte-exact")
        assertEquals("untracked", params["status"]!!.jsonPrimitive.content, "the entry's status is always sent")
        assertEquals(taskId, params["taskId"]!!.jsonPrimitive.content)
        assertFalse(params.containsKey("maxBytes"), "Core's default applies when maxBytes is omitted")
        assertEquals(setOf("taskId", "path", "status"), params.keys)
    }

    @Test
    fun anUnknownStatusIsSentExactlyAsCoreListedIt() {
        val rpc = DiffRpc(okDiff)
        CoreCommands(rpc) { caps() }.gitDiff(taskId, FileChange("p", Reported.Unknown("copied_later"))).get()
        assertEquals("copied_later", rpc.sent.single().second["status"]!!.jsonPrimitive.content)
    }

    @Test
    fun maxBytesIsNeverAboveCoresCeiling() {
        for ((asked, sent) in listOf(10_000_000 to 524_288, 524_288 to 524_288, 1000 to 1000, 0 to 1, -5 to 1)) {
            val rpc = DiffRpc(okDiff)
            CoreCommands(rpc) { caps() }.gitDiff(taskId, FileChange("p", FileChangeStatus.MODIFIED.reported()), asked).get()
            assertEquals(sent, rpc.sent.single().second["maxBytes"]!!.jsonPrimitive.content.toInt(), "asked $asked")
        }
        assertEquals(524_288, GitDiffs.MAX_BYTES)
        assertEquals(262_144, GitDiffs.DEFAULT_BYTES)
    }

    @Test
    fun gitDiffIsRefusedLocallyWhenNotAdvertisedAndTheUiSaysSo() {
        val rpc = DiffRpc(okDiff)
        val pre = caps(CoreMethods.ALL - CoreMethods.GIT_DIFF)
        val failed = CoreCommands(rpc) { pre }.gitDiff(taskId, FileChange("p", FileChangeStatus.MODIFIED.reported()))
        val error = runCatching { failed.get() }.exceptionOrNull()
        assertIs<MethodNotSupportedException>(ErrorAttribution.unwrap(error))
        assertTrue(rpc.sent.isEmpty(), "nothing was sent")
        assertTrue(GitDiffText.UNSUPPORTED.contains("not supported by this Core"), GitDiffText.UNSUPPORTED)
        // An invalid task id is refused before the socket too; the path is never validated by the client.
        val bad = CoreCommands(rpc) { caps() }.gitDiff("", FileChange("p", FileChangeStatus.MODIFIED.reported()))
        assertIs<CoreValidationException>(ErrorAttribution.unwrap(runCatching { bad.get() }.exceptionOrNull()))
        assertTrue(rpc.sent.isEmpty())
    }

    @Test
    fun theAnswerDecodesAndThePatchIsNeverPrintedOrEchoed() {
        val json = """{"path":"a.txt","oldPath":"b.txt","status":"renamed","patch":"SECRET-PATCH-LINE","binary":false,"truncated":true,"lossy":true,"baseBlob":"0123456789abcdef0123456789abcdef01234567"}"""
        val r = CoreCommands(DiffRpc(ok(json))) { caps() }.gitDiff(taskId, FileChange("a.txt", FileChangeStatus.RENAMED.reported(), "b.txt")).get()
        assertEquals("b.txt", r.oldPath)
        assertEquals("0123456789abcdef0123456789abcdef01234567", r.baseBlob)
        assertFalse(r.toString().contains("SECRET-PATCH-LINE"))
        // A pre-A5 shape (no oldPath/baseBlob) decodes; a malformed one is fixed text, never echoed.
        CoreCommands(DiffRpc(ok("""{"path":"p","status":"modified","patch":"x","binary":false,"truncated":false,"lossy":false}"""))) { caps() }
            .gitDiff(taskId, FileChange("p", FileChangeStatus.MODIFIED.reported())).get()
        val broken = CoreCommands(DiffRpc(ok("""{"path":"p","status":"modified","patch":"SECRET-PATCH-LINE","binary":"no"}"""))) { caps() }
            .gitDiff(taskId, FileChange("p", FileChangeStatus.MODIFIED.reported()))
        val text = GitDiffs.describeFailure(runCatching { broken.get() }.exceptionOrNull())
        assertFalse(text.contains("SECRET-PATCH-LINE"), text)
    }

    // -----------------------------------------------------------------------
    // disclosures and display
    // -----------------------------------------------------------------------

    @Test
    fun everyFlagIsDisclosedAndNothingEverClaimsNoChanges() {
        assertEquals("treated as binary (possibly by repository attributes) \u2014 no text diff shown", GitDiffText.BINARY_COPY)
        assertEquals("contains bytes that are not valid UTF-8; shown with replacement characters", GitDiffText.LOSSY_COPY)
        val binary = GitDiffText.disclosures(result(patch = "", binary = true), null)
        assertTrue(binary.contains(GitDiffText.BINARY_COPY), binary.toString())
        assertTrue(GitDiffText.disclosures(result(truncated = true), null).contains("diff truncated at 262144 bytes"))
        assertTrue(GitDiffText.disclosures(result(truncated = true), 1000).contains("diff truncated at 1000 bytes"))
        assertTrue(GitDiffText.disclosures(result(truncated = true), 10_000_000).contains("diff truncated at 524288 bytes"))
        assertTrue(GitDiffText.disclosures(result(lossy = true), null).contains(GitDiffText.LOSSY_COPY))
        val renamed = GitDiffText.disclosures(result(path = "new.kt", oldPath = "old.kt", status = FileChangeStatus.RENAMED.reported()), null)
        assertTrue(renamed.any { it.contains("old.kt \u2192 new.kt") }, renamed.toString())
        val blob = GitDiffText.disclosures(result(baseBlob = "0123456789abcdef0123456789abcdef01234567"), null)
        assertTrue(blob.any { it.contains("0123456789ab") && !it.contains("0123456789abcdef0123") }, blob.toString())
        val empty = GitDiffText.disclosures(result(patch = ""), null)
        assertTrue(empty.contains(GitDiffText.EMPTY_COPY), empty.toString())
        for (combo in listOf(result(patch = "", binary = true), result(patch = "", truncated = true), result(patch = ""), result())) {
            val all = (GitDiffText.disclosures(combo, null) + GitDiffText.body(combo)).joinToString("\n").lowercase()
            assertFalse(all.contains("no changes"), all)
        }
    }

    /** Core's untracked symlink patch (mode 120000): its one `+` line is the link text, never content. */
    private fun symlinkPatch(path: String, target: String) =
        "diff --git a/$path b/$path\nnew file mode 120000\n--- /dev/null\n+++ b/$path\n@@ -0,0 +1 @@\n+$target\n\\ No newline at end of file\n"

    @Test
    fun anUntrackedSymlinkIsShownAsItsTargetOnly() {
        val link = result(path = "link", status = FileChangeStatus.UNTRACKED.reported(), patch = symlinkPatch("link", "../etc/\u202Eevil"))
        val target = assertNotNull(GitDiffText.symlinkTarget(link))
        assertTrue(target.startsWith("symlink \u2192 ../etc/"), target)
        assertFalse(target.contains("\u202E"), "revealed")
        assertTrue(GitDiffText.disclosures(link, null).contains(target))
        // A regular new file is not a symlink; neither is a tracked entry, a binary or a truncated one.
        val file = result(status = FileChangeStatus.UNTRACKED.reported(), patch = symlinkPatch("link", "x").replace("120000", "100644"))
        assertNull(GitDiffText.symlinkTarget(file))
        assertNull(GitDiffText.symlinkTarget(link.copy(status = FileChangeStatus.MODIFIED.reported())))
        assertNull(GitDiffText.symlinkTarget(link.copy(truncated = true)))
        assertNull(GitDiffText.symlinkTarget(link.copy(binary = true, patch = "")))
        // A name cannot forge the mode line: Core C-quotes a newline in the header, so line 2 stays the real mode.
        val quoted = "diff --git \"a/x\\nnew file mode 120000\" \"b/x\\nnew file mode 120000\"\nnew file mode 100644\n--- /dev/null\n+++ \"b/x\\nnew file mode 120000\"\n@@ -0,0 +1 @@\n+hi\n"
        assertNull(GitDiffText.symlinkTarget(result(path = "x\nnew file mode 120000", status = FileChangeStatus.UNTRACKED.reported(), patch = quoted)))
    }

    @Test
    fun theSymlinkLineNeedsTheExactHunkHeaderAndExactlyOneAddedLine() {
        val ok = result(path = "link", status = FileChangeStatus.UNTRACKED.reported(), patch = symlinkPatch("link", "t"))
        assertEquals("symlink \u2192 t", GitDiffText.symlinkTarget(ok))
        // Any other hunk header (a two-line add, a context hunk) is not Core's symlink shape.
        assertNull(GitDiffText.symlinkTarget(ok.copy(patch = ok.patch.replace("@@ -0,0 +1 @@", "@@ -0,0 +1,2 @@"))))
        assertNull(GitDiffText.symlinkTarget(ok.copy(patch = ok.patch.replace("@@ -0,0 +1 @@", "@@ -0,0 +1 @@ x"))))
        // Two `+` lines: no longer a single link target.
        assertNull(GitDiffText.symlinkTarget(ok.copy(patch = ok.patch.replace("+t\n", "+t\n+u\n"))))
        // Zero `+` lines.
        assertNull(GitDiffText.symlinkTarget(ok.copy(patch = ok.patch.replace("+t\n", ""))))
        // The mode must be on line 2 exactly (not merely somewhere in the patch).
        assertNull(GitDiffText.symlinkTarget(ok.copy(patch = ok.patch.replace("new file mode 120000\n", "new file mode 100644\nnew file mode 120000\n"))))
    }

    @Test
    fun aCrlfPatchShowsEveryCarriageReturnAndDisclosesHowMany() {
        val patch = "diff --git a/w.txt b/w.txt\n@@ -1,2 +1,2 @@\n-old\r\n-two\r\n+new\r\n+two\n"
        val r = result(path = "w.txt", patch = patch)
        val body = GitDiffText.body(r)
        assertFalse(body.contains('\r'), "no raw carriage return reaches the text area")
        assertEquals(3, body.split("\n").count { it.endsWith(GitDiffText.CR_MARKER) }, body)
        val m = GitDiffText.CR_MARKER
        assertEquals("diff --git a/w.txt b/w.txt\n@@ -1,2 +1,2 @@\n-old$m\n-two$m\n+new$m\n+two\n", body, "an LF-only line gets no marker")
        assertEquals(patch.count { it == '\n' }, body.count { it == '\n' }, "line breaks are kept, one per patch line")
        val disclosures = GitDiffText.disclosures(r, null)
        assertTrue(
            disclosures.contains("contains 3 lines with carriage returns (CRLF) \u2014 shown as ${GitDiffText.CR_MARKER}"),
            disclosures.toString(),
        )
        assertEquals("contains 1 line with carriage returns (CRLF) \u2014 shown as ${GitDiffText.CR_MARKER}", GitDiffText.crlfCopy(1))
        // No CRLF, no CRLF disclosure; a binary answer has no body to describe.
        assertTrue(GitDiffText.disclosures(result(), null).none { it.contains("CRLF") })
        assertTrue(GitDiffText.disclosures(r.copy(binary = true), null).none { it.contains("CRLF") })
    }

    @Test
    fun aLoneCarriageReturnIsShownAndCannotOverwriteVisibleText() {
        val patch = "diff --git a/p b/p\n@@ -1 +1 @@\n-a\n+harmless\rEVIL\n"
        val body = GitDiffText.body(result(path = "p", patch = patch))
        assertFalse(body.contains('\r'), "a lone CR is never obeyed")
        assertTrue(body.contains("+harmless${GitDiffText.CR_MARKER}EVIL"), body)
        assertTrue(GitDiffText.disclosures(result(path = "p", patch = patch), null).none { it.contains("CRLF") })
    }

    @Test
    fun theViewerIsNamedFromTheJsonPathNeverThePatchHeader() {
        val r = result(path = "real\tname\n.kt", patch = "diff --git a/evil b/evil\n@@ -1 +1 @@\n-a\n+b\n")
        val title = GitDiffText.title(r)
        assertTrue(title.contains("real\\tname\\n.kt"), title)
        assertFalse(title.contains("evil"), title)
        assertFalse(title.contains("\t") || title.contains("\n"), "one revealed line")
        assertTrue(GitDiffText.title(result(path = "x".repeat(5000))).length < 1000, "capped")
        val renamed = GitDiffText.title(result(path = "new.kt", oldPath = "old.kt", status = FileChangeStatus.RENAMED.reported()))
        assertTrue(renamed.contains("old.kt \u2192 new.kt"), renamed)
        assertEquals("renamed  old.kt \u2192 new.kt", GitDiffText.entryLabel(FileChange("new.kt", FileChangeStatus.RENAMED.reported(), "old.kt")))
        assertTrue(GitDiffText.entryLabel(FileChange("a\tb", FileChangeStatus.UNTRACKED.reported())).contains("a\\tb"))
    }

    @Test
    fun thePatchBodyRevealsHiddenAndBidiCharactersAndStaysPlainText() {
        val patch = "diff --git a/p b/p\n@@ -1 +1 @@\n-x\u202Ey\n+a\u2028b\u2029c\u200Bd\n+<script>alert(1)</script>\n"
        val body = GitDiffText.body(result(path = "p", patch = patch))
        for (raw in listOf("\u202E", "\u2028", "\u2029", "\u200B")) assertFalse(body.contains(raw), "raw U+%04X".format(raw[0].code))
        assertTrue(body.contains("\\u202E") && body.contains("\\u2028") && body.contains("\\u2029"), body)
        assertTrue(body.lines().size >= 5, "real line breaks are kept")
        assertTrue(body.contains("<script>alert(1)</script>"), "plain text in a JTextArea, never interpreted")
        assertEquals("", GitDiffText.body(result(patch = "", binary = true)))
    }

    // -----------------------------------------------------------------------
    // errors
    // -----------------------------------------------------------------------

    @Test
    fun everyExactCoreRefusalGetsHonestCopy() {
        val cases = listOf(
            CoreErrorCodes.NOT_FOUND to GitDiffs.MSG_TASK_NOT_FOUND,
            CoreErrorCodes.VALIDATION_FAILED to GitDiffs.MSG_NO_GIT_CONTEXT,
            CoreErrorCodes.VALIDATION_FAILED to GitDiffs.MSG_WORKTREE_REMOVED,
            CoreErrorCodes.VALIDATION_FAILED to GitDiffs.MSG_WORK_TREE_REDIRECTED,
            CoreErrorCodes.VALIDATION_FAILED to GitDiffs.MSG_PATH_NOT_IN_LIST,
            CoreErrorCodes.VALIDATION_FAILED to GitDiffs.MSG_PATH_LISTED_TWICE,
            CoreErrorCodes.VALIDATION_FAILED to GitDiffs.MSG_PATH_NOT_EXACT,
            CoreErrorCodes.VALIDATION_FAILED to "\"a/b\" changed while it was being read; nothing was read",
            CoreErrorCodes.VALIDATION_FAILED to "\"dir\" is not a regular file; nothing was read",
            CoreErrorCodes.VALIDATION_FAILED to GitDiffs.SUBMODULE_PREFIX + "\"vendor/lib\"; Sandpane cannot verify submodule work trees",
        )
        for ((code, message) in cases) {
            assertTrue(message.isNotEmpty())
            val text = GitDiffs.describeFailure(CoreRpcException(code, message))
            assertTrue(text.contains("Nothing was read"), "$message -> $text")
            assertFalse(text.contains("unknown", ignoreCase = true), text)
        }
        val git = GitDiffs.describeFailure(CoreRpcException(CoreErrorCodes.INTERNAL, "git diff failed: exit 128"))
        assertTrue(git.contains("git failed in Core") && git.contains("nothing was changed"), git)
        assertEquals(GitDiffs.TIMEOUT_COPY, GitDiffs.describeFailure(java.util.concurrent.CompletionException(TimeoutException())))
        assertEquals("Core did not answer in time \u2014 no file was changed (git.diff is read-only)", GitDiffs.TIMEOUT_COPY)
        // A reply this plugin found unusable is never worded as Core's verdict.
        val local = GitDiffs.describeFailure(CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, GitDiffs.MSG_PATH_NOT_IN_LIST, raisedByCore = false))
        assertFalse(local.startsWith("Core refused"), local)
        assertTrue(local.contains("not by Core"), local)
    }

    // -----------------------------------------------------------------------
    // the exact-path consumer and the review summary
    // -----------------------------------------------------------------------

    @Test
    fun exactReviewPathsResolveInsideTheRootWithoutTrimmingOrRefusingControlCharacters() {
        val root = Files.createTempDirectory("sandpane-a5").toFile()
        try {
            val tabbed = EditorDiffProvider.containPath(root, "dir/a\tb\nc.txt")
            assertNotNull(tabbed, "a tab or newline in a name is a real file name, not an escape")
            assertEquals(File(root.canonicalFile, "dir/a\tb\nc.txt").path, tabbed.path)
            assertEquals(" a.txt", EditorDiffProvider.containPath(root, " a.txt")!!.name, "a leading space is kept")
            assertNull(EditorDiffProvider.containPath(root, "../x"))
            assertNull(EditorDiffProvider.containPath(root, "dir/../../x"))
            assertNull(EditorDiffProvider.containPath(root, ""))
            assertNull(EditorDiffProvider.containPath(root, "a" + 0.toChar() + "b"))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun theReviewSummaryShowsTheRepoRenamesAndNeverClaimsAnIncompleteListIsComplete() {
        val cs = ChangeSet(
            taskId = taskId,
            baseCommit = "0123456789abcdef",
            hostDirty = false,
            changes = listOf(FileChange("new\n.kt", FileChangeStatus.RENAMED.reported(), "old.kt")),
            repoPath = "/repos/atlas\u202E",
            uninspected = listOf("vendor/lib", "vendor/other"),
        )
        val target = EditorDiffProvider.ReviewTarget(cs, emptyList(), listOf(EditorDiffProvider.Unresolved(cs.changes[0], "not visible")))
        val text = EditorDiffProvider.summarizeTarget(target, null)
        assertTrue(text.contains("repository: /repos/atlas\\u202E"), text)
        assertTrue(text.contains("old.kt \u2192 new\\n.kt"), text)
        assertTrue(text.contains("2 paths were not inspected"), text)
        assertTrue(text.contains("NOT complete"), text)
        val complete = EditorDiffProvider.summarizeTarget(EditorDiffProvider.ReviewTarget(cs.copy(uninspected = null), emptyList(), emptyList()), null)
        assertFalse(complete.contains("not inspected"))
        assertFalse(EditorDiffProvider.summarizeTarget(EditorDiffProvider.ReviewTarget(cs.copy(uninspected = emptyList()), emptyList(), emptyList()), null).contains("not inspected"))
    }
}
