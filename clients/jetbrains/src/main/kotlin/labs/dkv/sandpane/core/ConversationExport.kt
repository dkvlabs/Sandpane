// Protocol-v1 addition A3b (design 2026-10-09 §3.3 item 6): conversation export.
//
// `conversation.export` is a READ that Core always redacts (best-effort) and pages exactly like
// `conversation.history`. This file holds the pure parts, unit-tested as shipped:
//   * [ConversationExportPager] loops pages from `afterSequence: 0` until `truncated` is false, requires
//     `nextSequence` to strictly increase while truncated (else it stops: PARTIAL), stops after
//     [ExportCopy.MAX_PAGES] pages (PARTIAL), and fails the whole export on ANY page failure — then no
//     file is written at all;
//   * [ExportAssembler] builds the ONE JSON file (format, exportedAt and conversation from the first
//     page, messages concatenated, redaction counts SUMMED — Core counts the title on the first page
//     only — `complete`, and the scope note);
//   * [ConversationExportSave] asks for a target on the UI thread and writes exactly there, off it.
// Export content is never logged, printed or put in an error message.
package labs.dkv.sandpane.core

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import labs.dkv.sandpane.model.CONVERSATION_EXPORT_FORMAT
import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.model.ConversationExportResult
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.MessageRecord
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.concurrent.CompletableFuture

/** The exact copy every export surface shows, and the bounds of one export. */
object ExportCopy {

    /** Shown before and after an export (the shared client wording). */
    const val BEST_EFFORT: String = "Redaction is best-effort; review the export before sharing it."

    /** Written into the file's `note`. */
    const val FILE_NOTE: String =
        "Redaction is best-effort; review before sharing. Task events, artifacts and verification output are not included."

    const val SCOPE: String = "Task events, artifacts and verification output are not included."

    /** Hard cap on pages per export; reaching it stops the export as PARTIAL. */
    const val MAX_PAGES: Int = 200
}

/** One assembled export, ready to save. [toString] never prints the content. */
class ExportDocument(
    val conversationId: String,
    /** Core's REDACTED title from the first page (used for the default file name). */
    val redactedTitle: String,
    val messageCount: Int,
    val pages: Int,
    val complete: Boolean,
    /** Why a partial export stopped; null when [complete]. */
    val stopReason: String?,
    val replacements: Long,
    val byKind: Map<String, Long>,
    val json: String,
) {
    override fun toString(): String =
        "ExportDocument(conversationId=$conversationId, messages=$messageCount, pages=$pages, complete=$complete, " +
            "replacements=$replacements, bytes=${json.length})"
}

/** What collecting all pages produced. */
sealed class ExportCollection {
    data class Collected(val document: ExportDocument) : ExportCollection()

    /** A page failed or was not understood: nothing may be written. [error] is null for a shape refusal. */
    data class Failed(val reason: String?, val error: Throwable?, val pagesRead: Int) : ExportCollection()
}

/** Builds the single export file from the pages that were read. */
object ExportAssembler {

    private val pretty = Json(from = CoreJson) { prettyPrint = true }

    /** Kinds summed across pages; a kind absent on a page counts 0. Sorted like Core's BTreeMap. */
    fun sumByKind(pages: List<ConversationExportResult>): Map<String, Long> {
        val sums = java.util.TreeMap<String, Long>()
        pages.forEach { page -> page.redaction.byKind.forEach { (kind, n) -> sums[kind] = (sums[kind] ?: 0L) + n } }
        return sums
    }

    fun sumReplacements(pages: List<ConversationExportResult>): Long = pages.sumOf { it.redaction.replacements }

    /**
     * `{format, exportedAt, conversation, messages, redaction, complete, note}` — format, exportedAt and
     * conversation from the FIRST page, messages concatenated in page order, redaction summed.
     */
    fun assemble(pages: List<ConversationExportResult>, complete: Boolean): String {
        require(pages.isNotEmpty()) { "an export needs at least one page" }
        val first = pages.first()
        val messages: List<MessageRecord> = pages.flatMap { it.messages }
        val document: JsonObject = buildJsonObject {
            put("format", CONVERSATION_EXPORT_FORMAT)
            put("exportedAt", first.exportedAt)
            put("conversation", CoreJson.encodeToJsonElement(Conversation.serializer(), first.conversation))
            put("messages", CoreJson.encodeToJsonElement(ListSerializer(MessageRecord.serializer()), messages))
            put(
                "redaction",
                buildJsonObject {
                    // Never a claim of complete redaction, whatever a page says.
                    put("bestEffort", true)
                    put("replacements", sumReplacements(pages))
                    put("byKind", JsonObject(sumByKind(pages).mapValues { JsonPrimitive(it.value) }))
                },
            )
            put("complete", complete)
            put("note", ExportCopy.FILE_NOTE)
        }
        return pretty.encodeToString(JsonObject.serializer(), document) + "\n"
    }
}

/**
 * Collects every page of one export without blocking: each page is requested only after the previous
 * one arrived (`fetch` returns a future; the IDE's goes through the io pool).
 */
class ConversationExportPager(
    private val fetch: (afterSequence: Long) -> CompletableFuture<ConversationExportResult>,
    private val pageCap: Int = ExportCopy.MAX_PAGES,
) {

    fun collect(conversationId: String): CompletableFuture<ExportCollection> {
        val done = CompletableFuture<ExportCollection>()
        step(conversationId, cursor = 0L, pages = ArrayList(), done = done)
        return done
    }

    private fun step(
        conversationId: String,
        cursor: Long,
        pages: MutableList<ConversationExportResult>,
        done: CompletableFuture<ExportCollection>,
    ) {
        val next = try {
            fetch(cursor)
        } catch (t: Throwable) {
            CompletableFuture.failedFuture(t)
        }
        next.whenComplete { page, error ->
            try {
                if (error != null || page == null) {
                    done.complete(ExportCollection.Failed(null, error, pages.size))
                    return@whenComplete
                }
                shapeProblem(conversationId, page, pages.size + 1)?.let {
                    done.complete(ExportCollection.Failed(it, null, pages.size))
                    return@whenComplete
                }
                pages += page
                when {
                    !page.truncated -> done.complete(collected(conversationId, pages, null))
                    // Strictly increasing while truncated, or paging could loop or skip: stop, partial.
                    page.nextSequence <= cursor -> done.complete(
                        collected(
                            conversationId,
                            pages,
                            "Core reported more messages but its cursor did not advance (from $cursor to ${page.nextSequence})",
                        ),
                    )
                    pages.size >= pageCap -> done.complete(
                        collected(conversationId, pages, "the export stopped at the $pageCap-page limit while Core reported more messages"),
                    )
                    else -> step(conversationId, page.nextSequence, pages, done)
                }
            } catch (t: Throwable) {
                done.complete(ExportCollection.Failed(null, t, pages.size))
            }
        }
    }

    private fun shapeProblem(conversationId: String, page: ConversationExportResult, number: Int): String? = when {
        page.format != CONVERSATION_EXPORT_FORMAT ->
            "page $number has format '${KeyedWrites.coreText(page.format)}', not $CONVERSATION_EXPORT_FORMAT"
        page.conversation.id != conversationId ->
            "page $number is for another conversation ('${KeyedWrites.coreText(page.conversation.id)}')"
        // Review Info 3: every message must belong to the conversation asked for (ids only, never content).
        page.messages.any { it.conversationId != conversationId } ->
            "page $number carries a message of another conversation " +
                "('${KeyedWrites.coreText(page.messages.first { it.conversationId != conversationId }.conversationId)}')"
        // Review Info 3: Core always marks redaction best-effort; a page that does not is not understood.
        !page.redaction.bestEffort ->
            "page $number does not mark its redaction best-effort"
        page.redaction.replacements < 0 || page.redaction.byKind.values.any { it < 0 } ->
            "page $number reports a negative redaction count"
        else -> null
    }

    private fun collected(conversationId: String, pages: List<ConversationExportResult>, stopReason: String?): ExportCollection {
        val complete = stopReason == null
        return ExportCollection.Collected(
            ExportDocument(
                conversationId = conversationId,
                redactedTitle = pages.first().conversation.title,
                messageCount = pages.sumOf { it.messages.size },
                pages = pages.size,
                complete = complete,
                stopReason = stopReason,
                replacements = ExportAssembler.sumReplacements(pages),
                byKind = ExportAssembler.sumByKind(pages),
                json = ExportAssembler.assemble(pages, complete),
            ),
        )
    }
}

/** The default file name: `<sanitized-redacted-title>-export.json`. */
object ExportFileName {

    const val MAX_STEM: Int = 80

    fun forTitle(redactedTitle: String): String {
        val stem = redactedTitle
            .map { c -> if (c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c == '.' || c == '_' || c == '-') c else '-' }
            .joinToString("")
            .replace(Regex("-{2,}"), "-")
            .trim('-', '.')
            .take(MAX_STEM)
            .trim('-', '.')
        return (stem.ifEmpty { "conversation" }) + "-export.json"
    }
}

/** Every way saving one export can end. */
sealed class ExportOutcome {
    data class PageFailed(val failure: ExportCollection.Failed) : ExportOutcome()
    data class Cancelled(val document: ExportDocument) : ExportOutcome()
    data class Saved(val target: Path, val document: ExportDocument) : ExportOutcome()
    data class WriteFailed(val target: Path, val document: ExportDocument, val error: Throwable) : ExportOutcome()

    /** The save could not be offered (e.g. the dialog could not be scheduled). Nothing was written. */
    data class NotOffered(val reason: String) : ExportOutcome()

    fun describe(): OutcomeText = when (this) {
        is PageFailed -> failure.reason?.let {
            OutcomeText(
                "Sandpane: conversation not exported",
                "Core's export answer was not understood (${it}). No file was written.",
                OutcomeSeverity.ERROR,
            )
        } ?: ConversationOutcomes.describeExportFailure(failure.error)
        is Cancelled -> OutcomeText(
            "Sandpane: export not saved",
            "Cancelled. No file was written.",
            OutcomeSeverity.INFO,
        )
        is NotOffered -> OutcomeText(
            "Sandpane: export not saved",
            "The save dialog could not be shown (${reason}). No file was written.",
            OutcomeSeverity.ERROR,
        )
        is Saved -> OutcomeText(
            if (document.complete) "Sandpane: conversation exported" else "Sandpane: PARTIAL conversation export saved",
            "Saved ${document.messageCount} message(s) to ${KeyedWrites.coreText(target.toString())}" +
                (if (document.complete) "." else " — PARTIAL (${document.stopReason}); the file says \"complete\": false.") +
                " ${summary(document)} ${ExportCopy.BEST_EFFORT} ${ExportCopy.SCOPE}",
            if (document.complete) OutcomeSeverity.INFO else OutcomeSeverity.WARNING,
        )
        is WriteFailed -> OutcomeText(
            "Sandpane: export not saved",
            "Writing ${KeyedWrites.coreText(target.toString())} failed (${error.javaClass.simpleName}); the file may be " +
                "missing or incomplete. Nothing is retried.",
            OutcomeSeverity.ERROR,
        )
    }

    companion object {
        /** "Core's redaction replaced N value(s): kind n, …" — counts only, never content. */
        fun summary(document: ExportDocument): String {
            val kinds = document.byKind.entries.joinToString(", ") { "${KeyedWrites.coreText(it.key)} ${it.value}" }
            return "Core's best-effort redaction replaced ${document.replacements} value(s)" +
                (if (kinds.isEmpty()) "." else " ($kinds).")
        }
    }
}

/**
 * Collect → ask where (UI thread) → write exactly there (off the UI thread). A page failure never
 * opens the dialog; a cancelled dialog writes nothing.
 */
class ConversationExportSave(
    private val ui: Ui,
    private val write: (Path, String) -> Unit = { target, text -> writeExportFile(target, text) },
    /** Where the file write runs: never the UI thread. The IDE passes ConnectionManager's io pool. */
    private val background: (() -> Unit) -> Unit = { task -> CompletableFuture.runAsync(task) },
) {
    interface Ui {
        fun onUiThread(block: () -> Unit)

        /** The path the user chose for [document] (default name [defaultName]); null when cancelled. */
        fun chooseTarget(defaultName: String, document: ExportDocument): Path?
    }

    fun save(collection: CompletableFuture<ExportCollection>): CompletableFuture<ExportOutcome> {
        val done = CompletableFuture<ExportOutcome>()
        collection.whenComplete { collected, error ->
            when {
                error != null -> done.complete(ExportOutcome.PageFailed(ExportCollection.Failed(null, error, 0)))
                collected is ExportCollection.Failed -> done.complete(ExportOutcome.PageFailed(collected))
                collected is ExportCollection.Collected -> offer(collected.document, done)
                else -> done.complete(ExportOutcome.PageFailed(ExportCollection.Failed(null, null, 0)))
            }
        }
        return done
    }

    private fun offer(document: ExportDocument, done: CompletableFuture<ExportOutcome>) {
        try {
            ui.onUiThread {
                val target = try {
                    ui.chooseTarget(ExportFileName.forTitle(document.redactedTitle), document)
                } catch (_: Throwable) {
                    null
                }
                if (target == null) {
                    done.complete(ExportOutcome.Cancelled(document))
                } else {
                    writeOffUi(target, document, done)
                }
            }
        } catch (t: Throwable) {
            done.complete(ExportOutcome.NotOffered(t.javaClass.simpleName))
        }
    }

    private fun writeOffUi(target: Path, document: ExportDocument, done: CompletableFuture<ExportOutcome>) {
        try {
            background {
                try {
                    write(target, document.json)
                    done.complete(ExportOutcome.Saved(target, document))
                } catch (t: Throwable) {
                    done.complete(ExportOutcome.WriteFailed(target, document, t))
                }
            }
        } catch (t: Throwable) {
            done.complete(ExportOutcome.NotOffered("the file write could not be scheduled: ${t.javaClass.simpleName}"))
        }
    }

    companion object {
        /** Writes exactly [target] (created or truncated), UTF-8. No temporary sibling file is made. */
        fun writeExportFile(target: Path, text: String) {
            Files.writeString(
                target,
                text,
                StandardCharsets.UTF_8,
                StandardOpenOption.CREATE,
                StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.WRITE,
            )
        }
    }
}
