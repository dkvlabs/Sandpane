package labs.dkv.sandpane.services

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.GitDiffResult
import java.util.concurrent.ConcurrentHashMap

/**
 * ONE `git.review` answer, as A6 apply needs it (design 2026-10-09 §3.6):
 *  - [changeSet], the typed view the UI reads;
 *  - [rawChanges], the answer's own `changes[]` JSON objects, index-aligned with
 *    `changeSet.changes`, which become `git.apply`'s `entries` verbatim (never rebuilt);
 *  - [coreInstanceId], the Core instance that answered: Core keeps `reviewId` in memory only, so a
 *    different instance means the review is gone and must be done again;
 *  - the `git.diff` answers the user opened for entries of this review, which decide flag (a) and
 *    the diff/entry mismatch refusal. A new review starts with none (the selection and its evidence
 *    are per review).
 *
 * Holds Core's data only; it decides nothing about task state (AGENTS.md rule 3).
 */
class ReviewSession(
    val changeSet: ChangeSet,
    val rawChanges: List<JsonObject>,
    val coreInstanceId: String?,
) {
    /** What one opened `git.diff` showed: the content id it was rendered from and whether it was complete text. */
    data class DiffSeen(val taskBlob: String?, val binary: Boolean, val truncated: Boolean)

    private val diffs = ConcurrentHashMap<Pair<String, String>, DiffSeen>()

    /** Remember a `git.diff` answer the user opened (keyed by its exact path and wire status). */
    fun recordDiff(result: GitDiffResult) {
        diffs[result.path to result.status.wireName] = DiffSeen(result.taskBlob, result.binary, result.truncated)
    }

    fun diffFor(change: FileChange): DiffSeen? = diffs[change.path to change.status.wireName]

    companion object {
        /**
         * Decode a `git.review` `ok` element. Throws (with a fixed message; the answer is never
         * echoed) when its `changes` array does not line up with the typed decode.
         */
        fun fromAnswer(answer: JsonElement, coreInstanceId: String?): ReviewSession {
            val changeSet = CoreJson.decodeFromJsonElement(ChangeSet.serializer(), answer)
            val raw = ((answer as? JsonObject)?.get("changes") as? JsonArray ?: JsonArray(emptyList()))
                .map { it as? JsonObject ?: throw IllegalArgumentException("git.review: a change entry is not an object") }
            require(raw.size == changeSet.changes.size) { "git.review: the change list did not decode one-to-one" }
            return ReviewSession(changeSet, raw, coreInstanceId)
        }
    }
}
