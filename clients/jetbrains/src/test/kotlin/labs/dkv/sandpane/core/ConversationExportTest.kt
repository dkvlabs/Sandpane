package labs.dkv.sandpane.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import labs.dkv.sandpane.model.CONVERSATION_EXPORT_FORMAT
import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.model.ConversationExportResult
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.ExportRedaction
import labs.dkv.sandpane.model.MessageRecord
import labs.dkv.sandpane.ui.ConversationExportCopy
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A3b export (design §3.3 item 6): the REAL [ConversationExportPager] / [ExportAssembler] /
 * [ConversationExportSave] over a scripted page source; only Core and the file system are replaced.
 */
class ConversationExportTest {

    private val id = "7c2e9a10-0000-4000-8000-00000000c0de"
    private val conversation = Conversation(id, "p-1", "Atlas Demo chat [REDACTED:token]", "codex", "2026-10-01T00:00:00Z")

    private fun page(
        afterCursor: Long,
        count: Int,
        truncated: Boolean,
        next: Long = afterCursor + count,
        replacements: Long = 0,
        byKind: Map<String, Long> = emptyMap(),
        exportedAt: String = "2026-10-11T00:00:00Z",
        format: String = CONVERSATION_EXPORT_FORMAT,
        conversationId: String = id,
        messageConversationId: String = conversationId,
        bestEffort: Boolean = true,
    ) = ConversationExportResult(
        format = format,
        exportedAt = exportedAt,
        conversation = conversation.copy(id = conversationId),
        messages = (1..count).map { n ->
            val seq = afterCursor + n
            MessageRecord("m-$seq", messageConversationId, "user", "message $seq", seq)
        },
        truncated = truncated,
        nextSequence = next,
        redaction = ExportRedaction(bestEffort = bestEffort, replacements = replacements, byKind = byKind),
    )

    /** A scripted Core: answers in order and records every cursor asked for. */
    private class Pages(vararg answers: () -> CompletableFuture<ConversationExportResult>) {
        val cursors = ArrayList<Long>()
        private val script = ArrayDeque(answers.toList())
        val fetch: (Long) -> CompletableFuture<ConversationExportResult> = { after ->
            cursors += after
            (script.removeFirstOrNull() ?: error("unexpected extra page request after $after"))()
        }
    }

    private fun ok(p: ConversationExportResult): () -> CompletableFuture<ConversationExportResult> = { CompletableFuture.completedFuture(p) }

    /** Inline UI that records whether the dialog was shown and answers [target]. */
    private class SaveUi(private val target: Path?) : ConversationExportSave.Ui {
        var asked: String? = null
        var document: ExportDocument? = null
        var inUi = false
        override fun onUiThread(block: () -> Unit) {
            inUi = true
            try { block() } finally { inUi = false }
        }
        override fun chooseTarget(defaultName: String, document: ExportDocument): Path? {
            asked = defaultName
            this.document = document
            return target
        }
    }

    private fun collected(pages: Pages): ExportDocument {
        val result = ConversationExportPager(pages.fetch).collect(id).get()
        return assertIs<ExportCollection.Collected>(result).document
    }

    // -----------------------------------------------------------------------
    // paging
    // -----------------------------------------------------------------------

    @Test
    fun loopsFromCursorZeroUntilNotTruncatedAndConcatenatesInOrder() {
        val pages = Pages(
            ok(page(0, 3, truncated = true, replacements = 2, byKind = mapOf("token" to 1L, "jwt" to 1L))),
            ok(page(3, 2, truncated = true, replacements = 1, byKind = mapOf("token" to 1L), exportedAt = "2026-10-11T00:00:05Z")),
            ok(page(5, 1, truncated = false, byKind = emptyMap())),
        )
        val doc = collected(pages)
        assertEquals(listOf(0L, 3L, 5L), pages.cursors)
        assertTrue(doc.complete)
        assertNull(doc.stopReason)
        assertEquals(6, doc.messageCount)
        assertEquals(3, doc.pages)
        // Summed across pages: Core counts the title on page 1 only, so a plain sum is right; absent = 0.
        assertEquals(3L, doc.replacements)
        assertEquals(mapOf("jwt" to 1L, "token" to 2L), doc.byKind)

        val json = CoreJson.parseToJsonElement(doc.json).jsonObject
        assertEquals(
            listOf("format", "exportedAt", "conversation", "messages", "redaction", "complete", "note"),
            json.keys.toList(),
            "exactly the shared file shape",
        )
        assertEquals(CONVERSATION_EXPORT_FORMAT, json["format"]!!.jsonPrimitive.content)
        assertEquals("2026-10-11T00:00:00Z", json["exportedAt"]!!.jsonPrimitive.content, "exportedAt comes from the first page")
        assertEquals(id, json["conversation"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals((1..6).map { "message $it" }, json["messages"]!!.jsonArray.map { it.jsonObject["content"]!!.jsonPrimitive.content })
        val redaction = json["redaction"]!!.jsonObject
        assertEquals("true", redaction["bestEffort"]!!.jsonPrimitive.content)
        assertEquals("3", redaction["replacements"]!!.jsonPrimitive.content)
        assertEquals(JsonObject::class, redaction["byKind"]!!::class)
        assertEquals("2", redaction["byKind"]!!.jsonObject["token"]!!.jsonPrimitive.content)
        assertEquals("true", json["complete"]!!.jsonPrimitive.content)
        assertEquals(
            "Redaction is best-effort; review before sharing. Task events, artifacts and verification output are not included.",
            json["note"]!!.jsonPrimitive.content,
        )
    }

    @Test
    fun anEmptyConversationIsOnePageAndComplete() {
        val pages = Pages(ok(page(0, 0, truncated = false, next = 0)))
        val doc = collected(pages)
        assertTrue(doc.complete, "nextSequence 0 on a last page is not a stuck cursor")
        assertEquals(0, doc.messageCount)
        assertEquals(listOf(0L), pages.cursors)
    }

    @Test
    fun aCursorThatDoesNotStrictlyIncreaseStopsAsPartial() {
        for (stuck in listOf(3L, 2L)) {
            val pages = Pages(
                ok(page(0, 3, truncated = true)),
                ok(page(3, 0, truncated = true, next = stuck)),
            )
            val doc = collected(pages)
            assertEquals(listOf(0L, 3L), pages.cursors, "no third request")
            assertFalse(doc.complete)
            assertTrue(doc.stopReason!!.contains("did not advance"), doc.stopReason)
            assertEquals("false", CoreJson.parseToJsonElement(doc.json).jsonObject["complete"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun thePageCapStopsAsPartialAfterExactlyTwoHundredPages() {
        var served = 0
        val fetch: (Long) -> CompletableFuture<ConversationExportResult> = { after ->
            served++
            CompletableFuture.completedFuture(page(after, 1, truncated = true))
        }
        val result = ConversationExportPager(fetch).collect(id).get()
        val doc = assertIs<ExportCollection.Collected>(result).document
        assertEquals(200, ExportCopy.MAX_PAGES)
        assertEquals(200, served)
        assertFalse(doc.complete)
        assertTrue(doc.stopReason!!.contains("200-page limit"), doc.stopReason)
        assertEquals(200, doc.messageCount)
    }

    @Test
    fun anyPageFailureFailsTheWholeExportAndNothingIsOfferedOrWritten() {
        val failures = listOf<() -> CompletableFuture<ConversationExportResult>>(
            { CompletableFuture.failedFuture(CoreRpcException(CoreErrorCodes.INTERNAL, "redactor unavailable; nothing was exported")) },
            { CompletableFuture.failedFuture(CoreTransportException("socket closed")) },
            { CompletableFuture.failedFuture(CoreRpcException(CoreErrorCodes.NOT_FOUND, ConversationOutcomes.MSG_CONVERSATION_NOT_FOUND)) },
            ok(page(3, 1, truncated = false, format = "something.else.v2")),
            ok(page(3, 1, truncated = false, conversationId = "another")),
            ok(page(3, 1, truncated = false, replacements = -1)),
        )
        for (second in failures) {
            val pages = Pages(ok(page(0, 3, truncated = true)), second)
            val ui = SaveUi(Path.of("/never/used.json"))
            val writes = ArrayList<Path>()
            val outcome = ConversationExportSave(ui, write = { p, _ -> writes.add(p) }, background = { it() })
                .save(ConversationExportPager(pages.fetch).collect(id)).get()
            assertIs<ExportOutcome.PageFailed>(outcome)
            assertNull(ui.asked, "the save dialog is never shown after a page failure")
            assertTrue(writes.isEmpty(), "no file is written after a page failure")
            val text = outcome.describe()
            assertTrue(text.body.contains("No file was written"), text.body)
            assertFalse(text.body.contains("message 1"), "export content never appears in the error")
        }
    }

    @Test
    fun aPageCarryingAnotherConversationsMessageFailsTheWholeExport() {
        val pages = Pages(ok(page(0, 3, truncated = true)), ok(page(3, 2, truncated = false, messageConversationId = "another")))
        val failed = assertIs<ExportCollection.Failed>(ConversationExportPager(pages.fetch).collect(id).get())
        assertTrue(failed.reason!!.contains("page 2") && failed.reason!!.contains("another conversation"), failed.reason)
        assertFalse(failed.reason!!.contains("message 4"), "content never appears in the reason")
        assertNull(failed.error)
        assertEquals(listOf(0L, 3L), pages.cursors)
    }

    @Test
    fun everyPageMustSayRedactionIsBestEffort() {
        for (badPage in listOf(1, 2)) {
            val first = page(0, 3, truncated = true, bestEffort = badPage != 1)
            val second = page(3, 1, truncated = false, bestEffort = badPage != 2)
            val pages = Pages(ok(first), ok(second))
            val ui = SaveUi(Path.of("/never/used.json"))
            val writes = ArrayList<Path>()
            val outcome = ConversationExportSave(ui, write = { p, _ -> writes.add(p) }, background = { it() })
                .save(ConversationExportPager(pages.fetch).collect(id)).get()
            assertIs<ExportOutcome.PageFailed>(outcome)
            assertTrue(outcome.describe().body.contains("best-effort"), outcome.describe().body)
            assertNull(ui.asked, "no save dialog")
            assertTrue(writes.isEmpty(), "no file")
        }
    }

    @Test
    fun aFetchThatThrowsIsAFailureNotACrash() {
        val result = ConversationExportPager({ error("boom") }).collect(id).get()
        assertIs<ExportCollection.Failed>(result)
    }

    // -----------------------------------------------------------------------
    // saving
    // -----------------------------------------------------------------------

    @Test
    fun cancellingTheSaveDialogWritesNothing() {
        val ui = SaveUi(null)
        val writes = ArrayList<Path>()
        val outcome = ConversationExportSave(ui, write = { p, _ -> writes.add(p) }, background = { it() })
            .save(ConversationExportPager(Pages(ok(page(0, 2, truncated = false))).fetch).collect(id)).get()
        assertIs<ExportOutcome.Cancelled>(outcome)
        assertEquals("Atlas-Demo-chat-REDACTED-token-export.json", ui.asked, "named from the REDACTED title")
        assertTrue(writes.isEmpty())
        assertTrue(outcome.describe().body.contains("No file was written"))
    }

    @Test
    fun theFileIsWrittenExactlyWhereChosenAndOffTheUiThread() {
        val target = Path.of("/chosen/by/user.json")
        val ui = SaveUi(target)
        val written = ArrayList<Pair<Path, String>>()
        val queued = ArrayList<() -> Unit>()
        val done = ConversationExportSave(
            ui,
            write = { p, text ->
                assertFalse(ui.inUi, "the write never runs on the UI thread")
                written += p to text
            },
            background = { queued += it },
        ).save(
            ConversationExportPager(Pages(ok(page(0, 2, truncated = false, replacements = 4, byKind = mapOf("env-secret" to 4L)))).fetch).collect(id),
        )
        assertFalse(done.isDone, "nothing is written until the background runs")
        assertTrue(written.isEmpty())
        queued.forEach { it() }
        val outcome = assertIs<ExportOutcome.Saved>(done.get())
        assertEquals(listOf(target), written.map { it.first }, "exactly the chosen path, nothing else")
        assertEquals(outcome.document.json, written.single().second)
        val body = outcome.describe().body
        assertTrue(body.contains(ExportCopy.BEST_EFFORT), body)
        assertTrue(body.contains("replaced 4 value(s)") && body.contains("env-secret 4"), body)
        assertTrue(body.contains("not included"), body)
        assertFalse(body.contains("message 1"), "content is never shown")
        assertFalse(body.contains("secret-free"))
        // The save dialog shows the count and the best-effort copy BEFORE the file is written.
        val description = ConversationExportCopy.saveDescription(ui.document!!)
        assertTrue(description.contains("replaced 4 value(s)") && description.contains(ExportCopy.BEST_EFFORT), description)
    }

    @Test
    fun aPartialExportIsSavedAndSaysSo() {
        val pages = Pages(ok(page(0, 1, truncated = true)), ok(page(1, 0, truncated = true, next = 1)))
        val outcome = ConversationExportSave(SaveUi(Path.of("/x.json")), write = { _, _ -> }, background = { it() })
            .save(ConversationExportPager(pages.fetch).collect(id)).get()
        val saved = assertIs<ExportOutcome.Saved>(outcome)
        assertFalse(saved.document.complete)
        val text = saved.describe()
        assertTrue(text.title.contains("PARTIAL"), text.title)
        assertTrue(text.body.contains("\"complete\": false"), text.body)
    }

    @Test
    fun aFailedWriteIsReportedHonestly() {
        val outcome = ConversationExportSave(
            SaveUi(Path.of("/read-only/x.json")),
            write = { _, _ -> throw java.io.IOException("Permission denied: secret-path-detail") },
            background = { it() },
        ).save(ConversationExportPager(Pages(ok(page(0, 1, truncated = false))).fetch).collect(id)).get()
        assertIs<ExportOutcome.WriteFailed>(outcome)
        val body = outcome.describe().body
        assertTrue(body.contains("may be missing or incomplete"), body)
        assertFalse(body.contains("Export saved"))
    }

    @Test
    fun theRealWriterWritesExactlyTheChosenFile() {
        val dir = Files.createTempDirectory("sandpane-export-test")
        try {
            val target = dir.resolve("atlas-export.json")
            Files.writeString(target, "old content that is longer than the new one ".repeat(10))
            ConversationExportSave.writeExportFile(target, "{\"a\":1}\n")
            assertEquals("{\"a\":1}\n", Files.readString(target), "created or truncated, never appended")
            assertEquals(listOf("atlas-export.json"), Files.list(dir).use { s -> s.map { it.fileName.toString() }.toList() }, "no temporary sibling")
        } finally {
            Files.list(dir).use { s -> s.forEach { Files.deleteIfExists(it) } }
            Files.deleteIfExists(dir)
        }
    }

    @Test
    fun defaultFileNamesAreSanitized() {
        assertEquals("Atlas-Demo-export.json", ExportFileName.forTitle("Atlas Demo"))
        assertEquals("conversation-export.json", ExportFileName.forTitle(""))
        assertEquals("conversation-export.json", ExportFileName.forTitle("../../.."))
        assertEquals("etc-passwd-export.json", ExportFileName.forTitle("/etc/passwd"))
        assertEquals("a-b-export.json", ExportFileName.forTitle("a\u202E\u0000b"))
        val long = ExportFileName.forTitle("x".repeat(500))
        assertEquals("x".repeat(ExportFileName.MAX_STEM) + "-export.json", long)
        assertFalse(ExportFileName.forTitle(".hidden").startsWith("."))
    }

    @Test
    fun exportContentIsNeverPrinted() {
        val p = page(0, 2, truncated = false)
        assertFalse(p.toString().contains("message 1"), p.toString())
        val doc = collected(Pages(ok(p)))
        assertFalse(doc.toString().contains("message 1"), doc.toString())
    }
}
