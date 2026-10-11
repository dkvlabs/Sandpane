// Protocol-v1 addition A3b (design 2026-10-09 §3.3): conversation lifecycle.
//
// Pure seams the chat panel uses, unit-tested as shipped (the A3a pattern of ProjectLifecycle.kt):
//   * [ConversationGuards] mirrors `Validator::conversation_title` EXACTLY (never stricter, never
//     looser) plus `conversation.rename`'s whitespace-only refusal (Rust `str::trim`, i.e. the Unicode
//     White_Space property), pinned against the Rust source by ProtocolDriftGuardTest;
//   * [ConversationDeleteCheck] + [IssuedConversationDelete] + [ConversationDeleteFlow]: the A1 two-step
//     pattern — step 2 can only be built from Core's verified step-1 answer, cancel/expiry send nothing,
//     neither step is retried, the token is never shown or printed;
//   * [ConversationOutcomes] words every answer honestly: Core's exact §3.3 refusals say "nothing was …",
//     INTERNAL/transport/timeout on a mutation say "outcome UNKNOWN" — never "nothing was deleted";
//   * [ConversationUiState] decides which actions an archived conversation (or one in an archived
//     project) allows — Core's own rule, read only from `archivedAt`; nothing about task state.
package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.model.ConversationDeleteResult
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.MAX_LIST_LIMIT
import labs.dkv.sandpane.model.Project
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/** Client mirror of Core's conversation title rules. Returns the problem, or null when valid. */
object ConversationGuards {

    /** `MAX_CONVERSATION_TITLE_CHARS` (Unicode scalar values, like Rust's `chars().count()`). */
    const val MAX_TITLE_CHARS: Int = 200

    /**
     * Rust `char::is_whitespace` (the Unicode White_Space property), which `str::trim` strips:
     * U+0009..U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F,
     * U+3000. Written as numbers so no invisible character ever sits in this source. Deliberately NOT
     * Kotlin's `isWhitespace` (which adds U+001C..U+001F and misses U+0085).
     */
    fun isCoreWhitespace(codePoint: Int): Boolean =
        codePoint in 0x09..0x0D || codePoint == 0x20 || codePoint == 0x85 || codePoint == 0xA0 ||
            codePoint == 0x1680 || codePoint in 0x2000..0x200A || codePoint == 0x2028 || codePoint == 0x2029 ||
            codePoint == 0x202F || codePoint == 0x205F || codePoint == 0x3000

    /** `title.trim().is_empty()` in Rust: empty, or nothing but White_Space. */
    fun isBlankForCore(value: String): Boolean {
        var i = 0
        while (i < value.length) {
            val cp = value.codePointAt(i)
            if (!isCoreWhitespace(cp)) return false
            i += Character.charCount(cp)
        }
        return true
    }

    /** Rust `char::is_control` = general category Cc (C0, DEL, C1). */
    private fun isControl(codePoint: Int): Boolean = Character.getType(codePoint) == Character.CONTROL.toInt()

    /**
     * `Validator::conversation_title`: 1..=200 chars, no Cc at all (incl. `\n`, `\t`), no spoofing char
     * (the same set as `project_name`, [ProjectGuards.isSpoofingFormatChar]). It does NOT trim.
     */
    fun titleProblem(value: String): String? {
        if (value.isEmpty()) return "the title is empty"
        val count = value.codePointCount(0, value.length)
        if (count > MAX_TITLE_CHARS) return "the title is $count characters; the limit is $MAX_TITLE_CHARS"
        var i = 0
        while (i < value.length) {
            val cp = value.codePointAt(i)
            // A lone UTF-16 surrogate cannot exist in a Rust `String`, so Core can never accept it.
            if (isControl(cp) || ProjectGuards.isSpoofingFormatChar(cp) || Character.getType(cp) == Character.SURROGATE.toInt()) {
                return "the title contains ${"U+%04X".format(cp)}, which Core refuses"
            }
            i += Character.charCount(cp)
        }
        return null
    }

    /** Code points a derived create title is cut to (the shared cross-client rule). */
    const val CREATE_TITLE_CODE_POINTS: Int = 80

    /**
     * A title for `conversation.create` that Core's A3b rule always accepts (shared with the VS Code
     * client): every code point Core refuses (Cc incl. newline/tab, C1, the spoofing set, a lone
     * surrogate) becomes a space, runs of White_Space collapse to one space, the ends are trimmed, and
     * the result is cut by CODE POINT (never splitting a surrogate pair) to [CREATE_TITLE_CODE_POINTS].
     * Blank becomes "" so Core stores "Untitled conversation".
     */
    fun titleForCreate(raw: String): String {
        val mapped = StringBuilder(raw.length)
        var i = 0
        while (i < raw.length) {
            val cp = raw.codePointAt(i)
            val refused = isControl(cp) || ProjectGuards.isSpoofingFormatChar(cp) || Character.getType(cp) == Character.SURROGATE.toInt()
            if (refused || isCoreWhitespace(cp)) {
                if (mapped.isNotEmpty() && mapped[mapped.length - 1] != ' ') mapped.append(' ')
            } else {
                mapped.appendCodePoint(cp)
            }
            i += Character.charCount(cp)
        }
        var text = mapped.toString().trim(' ')
        if (text.codePointCount(0, text.length) > CREATE_TITLE_CODE_POINTS) {
            text = text.substring(0, text.offsetByCodePoints(0, CREATE_TITLE_CODE_POINTS)).trimEnd(' ')
        }
        return text
    }

    /** `conversation.rename`: whitespace-only is refused first (`MSG_TITLE_BLANK`), then [titleProblem]. */
    fun renameTitleProblem(value: String): String? =
        if (isBlankForCore(value)) "the title is empty or whitespace-only" else titleProblem(value)
}

/**
 * A verified step-1 conversation-delete confirmation, the ONLY carrier of a token toward step 2. Its
 * constructor is private; the module-internal factory's only caller is [ConversationDeleteCheck.decide].
 */
class IssuedConversationDelete private constructor(
    val conversationId: String,
    /** Core's stored title at step 1 (a rename between the steps does not void the token). */
    val name: String,
    val expiresAt: String,
    val impact: List<String>,
    internal val token: String,
) {
    val expiresAtInstant: Instant? = parseExpiry(expiresAt)

    /** True when the expiry has passed — or cannot be read: fail CLOSED. */
    fun isExpired(now: Instant): Boolean = expiresAtInstant?.let { !now.isBefore(it) } ?: true

    override fun toString(): String =
        "IssuedConversationDelete(conversationId=$conversationId, expiresAt=$expiresAt, impact=${impact.size} line(s), token=<redacted>)"

    internal companion object {
        fun of(conversationId: String, name: String, expiresAt: String, impact: List<String>, token: String) =
            IssuedConversationDelete(conversationId, name, expiresAt, impact, token)

        fun parseExpiry(value: String): Instant? = try {
            OffsetDateTime.parse(value).toInstant()
        } catch (_: DateTimeParseException) {
            null
        }
    }
}

/** Judges Core's step-1 `conversation.delete` answer before anything is shown or sent. */
object ConversationDeleteCheck {

    sealed class Decision {
        data class Ready(val issued: IssuedConversationDelete) : Decision()
        data class Refused(val reason: String) : Decision()
    }

    /**
     * Accept only a `conversation.delete` confirmation bound to the very conversation id requested, with
     * a token of Core's shape and a readable expiry; a `deleted` flag at step 1 is never trusted.
     */
    fun decide(requestedConversationId: String, result: ConversationDeleteResult?): Decision {
        if (result == null) return Decision.Refused("Core returned no step-1 answer")
        if (result.deleted != null) {
            return Decision.Refused("Core's step-1 answer carries `deleted` — step 1 must change nothing, so it is not trusted")
        }
        val c = result.confirmation ?: return Decision.Refused("Core's step-1 answer carries no confirmation")
        if (c.action != CoreMethods.CONVERSATION_DELETE) {
            return Decision.Refused(
                "the confirmation is for '${KeyedWrites.coreText(c.action)}', not ${CoreMethods.CONVERSATION_DELETE}",
            )
        }
        if (c.target.id != requestedConversationId) {
            return Decision.Refused(
                "the confirmation is for conversation '${KeyedWrites.coreText(c.target.id)}', not " +
                    "'${KeyedWrites.coreText(requestedConversationId)}'",
            )
        }
        if (!CoreGuards.isConfirmTokenShape(c.token)) {
            return Decision.Refused("the confirmation token does not have the shape Core issues (64 lowercase hex)")
        }
        if (c.external) {
            return Decision.Refused("the confirmation is marked external, which ${CoreMethods.CONVERSATION_DELETE} never is")
        }
        if (IssuedConversationDelete.parseExpiry(c.expiresAt) == null) {
            // Fail closed: an expiry that cannot be checked at click time is not acted on.
            return Decision.Refused(
                "its expiry '${KeyedWrites.coreText(c.expiresAt)}' cannot be read, so the confirmation cannot be used; " +
                    "run Delete again",
            )
        }
        return Decision.Ready(IssuedConversationDelete.of(requestedConversationId, c.target.name, c.expiresAt, c.impact, c.token))
    }
}

/** Honest wording for every A3b answer. */
object ConversationOutcomes {

    // §3.3 item 8 and conversation_lifecycle.rs — verbatim; pinned by ProtocolDriftGuardTest.
    const val MSG_CONVERSATION_ARCHIVED = "conversation is archived; unarchive it first; nothing was changed"
    const val MSG_CONVERSATION_HAS_TASKS =
        "conversation has tasks that are not finished; cancel or finish them first; nothing was deleted"
    const val MSG_CONVERSATION_NOT_FOUND = "conversation not found"
    const val MSG_TITLE_BLANK = "conversation title must not be empty or whitespace-only; nothing was changed"

    /** A3a's project message, which Core raises FIRST for a conversation in an archived project. */
    const val MSG_PROJECT_ARCHIVED = ProjectOutcomes.MSG_PROJECT_ARCHIVED

    private data class Known(val code: String, val plain: String)

    private val KNOWN: Map<String, Known> = mapOf(
        MSG_CONVERSATION_ARCHIVED to Known(CoreErrorCodes.VALIDATION_FAILED, "This conversation is archived — unarchive it first."),
        MSG_CONVERSATION_HAS_TASKS to Known(
            CoreErrorCodes.CONFLICT,
            "This conversation still has unfinished tasks — cancel or finish them first.",
        ),
        MSG_CONVERSATION_NOT_FOUND to Known(CoreErrorCodes.NOT_FOUND, "Core no longer has this conversation."),
        MSG_TITLE_BLANK to Known(CoreErrorCodes.VALIDATION_FAILED, "The title is empty or whitespace-only."),
        MSG_PROJECT_ARCHIVED to Known(
            CoreErrorCodes.VALIDATION_FAILED,
            "This conversation's project is archived — unarchive the project first.",
        ),
    )

    /** Every exact message this client words (for the drift test). */
    val KNOWN_MESSAGES: Set<String> get() = KNOWN.keys

    /** What a Core refusal of [method] means: the verb of "nothing was …". */
    fun nothingWas(method: String): String = when (method) {
        CoreMethods.CONVERSATION_DELETE -> "nothing was deleted"
        CoreMethods.CONVERSATION_EXPORT -> "nothing was exported"
        CoreMethods.CONVERSATION_SEND -> "nothing was sent"
        else -> "nothing was changed"
    }

    /** Plain copy when [t] is one of Core's exact refusals (or the delete token rejection); else null. */
    fun knownRefusal(method: String, t: Throwable?): String? {
        val e = ErrorAttribution.unwrap(t) as? CoreRpcException ?: return null
        if (!e.raisedByCore) return null
        KNOWN[e.message]?.takeIf { it.code == e.code }?.let { return it.plain }
        if (method == CoreMethods.CONVERSATION_DELETE && e.code == CoreErrorCodes.VALIDATION_FAILED &&
            e.message.startsWith(CoreRemoveRefusals.TOKEN_REJECTED_PREFIX)
        ) {
            return "The confirmation was invalid, expired or already used — run Delete again for a fresh one."
        }
        return null
    }

    /** The re-read sentence: only claims archived conversations are included when they are. */
    fun rereadSentence(rereadIncludesArchived: Boolean): String =
        if (rereadIncludesArchived) {
            "the conversation list is re-read from Core, including archived conversations"
        } else {
            "the conversation list is re-read from Core (this Core cannot list archived conversations)"
        }

    /**
     * Words a failure of a MUTATING [method] (rename, archive, unarchive, delete step 2):
     *  * this plugin's refusal → nothing was sent;
     *  * one of Core's EXACT refusals (code + text) → plain copy + "nothing was …" + Core's text;
     *  * any other Core verdict except INTERNAL → Core's code and text, with NO claim about state;
     *  * INTERNAL, an unusable reply, a timeout or a lost connection → outcome UNKNOWN, nothing is retried.
     */
    fun describeFailure(method: String, error: Throwable?, rereadIncludesArchived: Boolean): OutcomeText {
        val t = ErrorAttribution.unwrap(error)
        if (t is CoreValidationException || t is MethodNotSupportedException) {
            return OutcomeText(ErrorAttribution.headline(method, t), ErrorAttribution.describe(method, t), OutcomeSeverity.WARNING)
        }
        if (t is CoreRpcException && t.raisedByCore && t.code != CoreErrorCodes.INTERNAL) {
            val plain = knownRefusal(method, t)
            return if (plain != null) {
                OutcomeText(
                    "Sandpane: $method refused by Core",
                    "$plain Core refused ${t.code}; ${nothingWas(method)}. Core said: ${KeyedWrites.coreText(t.message)}",
                    OutcomeSeverity.WARNING,
                )
            } else {
                OutcomeText(
                    "Sandpane: $method refused by Core",
                    "Core refused ${t.code}: ${KeyedWrites.coreText(t.message)}",
                    OutcomeSeverity.ERROR,
                )
            }
        }
        return OutcomeText(
            "Sandpane: $method outcome unknown",
            "The outcome is UNKNOWN (${unknownCause(t)}): it may or may not have happened in Core. Nothing is " +
                "retried; ${rereadSentence(rereadIncludesArchived)}.",
            OutcomeSeverity.ERROR,
        )
    }

    /** As [ProjectOutcomes.isUnknown]: INTERNAL, an unusable reply, a timeout or a lost connection. */
    fun isUnknown(error: Throwable?): Boolean {
        val t = ErrorAttribution.unwrap(error)
        if (t is CoreValidationException || t is MethodNotSupportedException) return false
        return !(t is CoreRpcException && t.raisedByCore && t.code != CoreErrorCodes.INTERNAL)
    }

    /** Step 1 only ASKS for a confirmation and never deletes: its failure is never an unknown outcome. */
    fun describeStep1Failure(error: Throwable?): OutcomeText {
        val t = ErrorAttribution.unwrap(error)
        val plain = knownRefusal(CoreMethods.CONVERSATION_DELETE, t)
        return OutcomeText(
            "Sandpane: conversation not deleted",
            listOfNotNull(
                plain,
                "No confirmation was issued. Step 1 only asks Core for a confirmation and never deletes, so the " +
                    "conversation was not deleted.",
                ErrorAttribution.describe(CoreMethods.CONVERSATION_DELETE, t),
            ).joinToString(" "),
            if (plain != null || ErrorAttribution.refusedLocally(t)) OutcomeSeverity.WARNING else OutcomeSeverity.ERROR,
        )
    }

    /**
     * Export is a READ: a failure never leaves an unknown state behind, and no file is written. Core's
     * exact refusals get plain copy; anything else shows Core's own text or the kind of failure only.
     */
    fun describeExportFailure(error: Throwable?): OutcomeText {
        val t = ErrorAttribution.unwrap(error)
        if (t is CoreValidationException || t is MethodNotSupportedException) {
            return OutcomeText(
                ErrorAttribution.headline(CoreMethods.CONVERSATION_EXPORT, t),
                ErrorAttribution.describe(CoreMethods.CONVERSATION_EXPORT, t) + " No file was written.",
                OutcomeSeverity.WARNING,
            )
        }
        val plain = knownRefusal(CoreMethods.CONVERSATION_EXPORT, t)
        val what = when {
            t is CoreRpcException && t.raisedByCore -> "Core refused ${t.code}: ${KeyedWrites.coreText(t.message)}"
            else -> "The export could not be read (${unknownCause(t)})"
        }
        return OutcomeText(
            "Sandpane: conversation not exported",
            listOfNotNull(plain, "$what. No file was written.").joinToString(" "),
            if (plain != null) OutcomeSeverity.WARNING else OutcomeSeverity.ERROR,
        )
    }

    private fun unknownCause(t: Throwable?): String = when (t) {
        is TimeoutException -> "no answer before the deadline"
        is CoreTransportException -> "the connection to Core failed"
        is CoreRpcException -> if (t.raisedByCore) "Core reported ${t.code}: ${KeyedWrites.coreText(t.message)}" else "Core's reply was unusable"
        null -> "no answer"
        else -> "an unexpected ${t.javaClass.simpleName} while handling the answer (details not shown)"
    }

    /** Success copy; Core's title is revealed and capped. */
    const val ARCHIVED_HIDDEN_HINT: String = "Archived conversations are hidden; turn on Show archived to see or unarchive it."

    fun describeSuccess(method: String, conversation: Conversation?, archivedListed: Boolean = false): OutcomeText {
        val shown = conversation?.let { KeyedWrites.coreText(DisplayCap.cap(it.title)) } ?: "the conversation"
        val what = when (method) {
            CoreMethods.CONVERSATION_RENAME -> "renamed"
            CoreMethods.CONVERSATION_ARCHIVE ->
                "archived (Core reports archivedAt ${conversation?.archivedAt?.let(KeyedWrites::coreText) ?: "not given"})"
            CoreMethods.CONVERSATION_UNARCHIVE -> "unarchived"
            else -> "answered"
        }
        // Review W1: with "Show archived" off the re-read hides it, so say where it went.
        val hidden = if (method == CoreMethods.CONVERSATION_ARCHIVE && !archivedListed) " $ARCHIVED_HIDDEN_HINT" else ""
        return OutcomeText(
            "Sandpane: conversation $what",
            "Core reports '$shown' $what. The conversation list is re-read from Core.$hidden",
            OutcomeSeverity.INFO,
        )
    }

    /**
     * Plain copy for a `conversation.send` refusal that is one of Core's exact archived messages (A3b:
     * an archived conversation used to answer NOT_FOUND; it is now VALIDATION_FAILED), else null.
     */
    fun sendRefusalHint(error: Throwable?): String? {
        val e = ErrorAttribution.unwrap(error) as? CoreRpcException ?: return null
        if (!e.raisedByCore || e.code != CoreErrorCodes.VALIDATION_FAILED) return null
        return when (e.message) {
            MSG_CONVERSATION_ARCHIVED -> "This conversation is archived — unarchive it first. Core did not accept the message."
            MSG_PROJECT_ARCHIVED -> "This conversation's project is archived — unarchive the project first. Core did not accept the message."
            else -> null
        }
    }
}

/** Which conversation actions are allowed — Core's own §3.3 item 4 rule, read only from `archivedAt`. */
object ConversationUiState {

    enum class Action(val method: String) {
        RENAME(CoreMethods.CONVERSATION_RENAME),
        ARCHIVE(CoreMethods.CONVERSATION_ARCHIVE),
        UNARCHIVE(CoreMethods.CONVERSATION_UNARCHIVE),
        DELETE(CoreMethods.CONVERSATION_DELETE),
        EXPORT(CoreMethods.CONVERSATION_EXPORT),
        SEND(CoreMethods.CONVERSATION_SEND),
    }

    /**
     * Null when [action] is allowed for [conversation] (in [project]); otherwise the reason to show —
     * Core's own message where Core would refuse. The PROJECT check comes first, as in Core. Delete is
     * never pre-judged from local task views: Core's CONFLICT is the only source of that answer.
     */
    fun blockedReason(conversation: Conversation, project: Project?, action: Action): String? {
        val projectArchived = project?.isArchived == true
        return when (action) {
            Action.DELETE, Action.EXPORT -> null
            Action.ARCHIVE -> if (conversation.isArchived) "the conversation is already archived" else null
            Action.UNARCHIVE -> when {
                projectArchived -> ConversationOutcomes.MSG_PROJECT_ARCHIVED
                !conversation.isArchived -> "the conversation is not archived"
                else -> null
            }
            Action.RENAME, Action.SEND -> when {
                projectArchived -> ConversationOutcomes.MSG_PROJECT_ARCHIVED
                conversation.isArchived -> ConversationOutcomes.MSG_CONVERSATION_ARCHIVED
                else -> null
            }
        }
    }

    /**
     * The whole gate for one button: connection, advertisement, selection, then [blockedReason]. Null =
     * enabled. Only the connection state, `system.probe`'s methods and Core's `archivedAt` are read.
     */
    fun gate(
        action: Action,
        conversation: Conversation?,
        project: Project?,
        connectionProblem: String?,
        advertisementGap: MethodNotSupportedException?,
    ): String? = when {
        connectionProblem != null -> connectionProblem
        advertisementGap != null -> "${action.method} is not supported by this Core: its system.probe does not advertise it. Nothing is sent."
        conversation == null -> "no conversation is selected"
        else -> blockedReason(conversation, project, action)
    }

    /**
     * Why the composer is disabled for the selected conversation, or null. This plugin's decision from
     * Core's `archivedAt` (nothing was sent), quoting Core's own rule. The archived-PROJECT case is
     * checked first by the panel, as Core checks it first.
     */
    fun composerBlocker(conversation: Conversation?): String? {
        if (conversation == null) return NO_SELECTION
        val archivedAt = conversation.archivedAt ?: return null
        return "This conversation is archived (Core reports archivedAt ${VisibleText.reveal(DisplayCap.cap(archivedAt))}); " +
            "Core refuses new messages and renames until it is unarchived (Core's rule: " +
            "\"${ConversationOutcomes.MSG_CONVERSATION_ARCHIVED}\"). Its history stays readable. Nothing was sent."
    }

    /**
     * With nothing selected the composer is disabled (A3b review W1): Send never picks a target the
     * user did not choose, and never invents a conversation.
     */
    const val NO_SELECTION: String =
        "No conversation is selected \u2014 select a conversation to continue. Nothing is sent until you pick one."

    /**
     * Why the composer is disabled with nothing selected. Asks the user to pick only when the picker has
     * rows; otherwise says why there is nothing to pick (no project, Core lists none, `conversation.list`
     * unadvertised or failed — [listState], revealed and capped), so an unsupported state reads as such.
     */
    fun noSelectionBlocker(rowCount: Int, listState: String, projectSelected: Boolean): String = when {
        !projectSelected -> "No project is selected, so there is no conversation to send to. Nothing is sent."
        rowCount > 0 -> NO_SELECTION
        else -> "No conversation can be selected: ${VisibleText.reveal(DisplayCap.cap(listState))}. " +
            "Nothing is sent, and no conversation is invented."
    }

    /** The visible refusal of a second Delete/Export click while one is still running (review Info 2). */
    fun inFlightNotice(action: Action): String {
        val what = when (action) {
            Action.DELETE -> "A conversation delete"
            Action.EXPORT -> "A conversation export"
            else -> "This action"
        }
        return "$what is already in progress in this window; wait for its outcome. Nothing was sent for this click."
    }

    /** Picker label: archived conversations are visibly labeled. The renderer reveals and caps it. */
    fun label(conversation: Conversation): String {
        val name = conversation.title.takeIf { it.isNotBlank() } ?: conversation.id.take(8)
        return if (conversation.isArchived) "$name [archived]" else name
    }

    /**
     * "Sandbox chosen at creation" (§3.3 item 3): a stored NAME, never a live binding. Only claimed as
     * persisted when Core advertises `conversation-sandbox-id`; "not in the current sandbox list" only
     * when that list was actually read ([listedSandboxNames] non-null).
     */
    fun sandboxLine(conversation: Conversation, featureAdvertised: Boolean, listedSandboxNames: Collection<String>?): String {
        if (!featureAdvertised) {
            return "sandbox chosen at creation: not reported by this Core (it does not advertise conversation-sandbox-id)"
        }
        val name = conversation.sandboxId ?: return "sandbox chosen at creation: none"
        val shown = VisibleText.reveal(DisplayCap.cap(name))
        return when {
            listedSandboxNames == null -> "sandbox chosen at creation: $shown (a stored name, not a live binding; the sandbox list is unavailable)"
            listedSandboxNames.contains(name) -> "sandbox chosen at creation: $shown (a stored name, not a live binding)"
            else -> "sandbox chosen at creation: $shown — not in the current sandbox list (a stored name, not a live binding)"
        }
    }
}

/** Every way one conversation delete can end. */
sealed class ConversationDeleteOutcome {
    abstract val conversationId: String

    data class Step1Failed(override val conversationId: String, val error: Throwable?) : ConversationDeleteOutcome()
    data class Refused(override val conversationId: String, val reason: String) : ConversationDeleteOutcome()
    data class Cancelled(override val conversationId: String) : ConversationDeleteOutcome()
    data class Expired(override val conversationId: String, val expiresAt: String) : ConversationDeleteOutcome()
    data class Deleted(override val conversationId: String, val name: String) : ConversationDeleteOutcome()
    data class Step2Unconfirmed(override val conversationId: String) : ConversationDeleteOutcome()
    data class Step2Failed(override val conversationId: String, val error: Throwable?) : ConversationDeleteOutcome()

    /** Only a confirmed `deleted: true` lets the client forget the conversation's local state. */
    val confirmedDeleted: Boolean get() = this is Deleted

    fun describe(rereadIncludesArchived: Boolean): OutcomeText = when (this) {
        is Step1Failed -> ConversationOutcomes.describeStep1Failure(error)
        is Refused -> OutcomeText(
            "Sandpane: conversation not deleted — confirmation not usable",
            "Core's confirmation was not acted on: ${VisibleText.reveal(reason)}. The confirming request was NOT sent; nothing was deleted.",
            OutcomeSeverity.ERROR,
        )
        is Cancelled -> OutcomeText(
            "Sandpane: conversation not deleted",
            "Cancelled. The confirming request was not sent; nothing was deleted.",
            OutcomeSeverity.INFO,
        )
        is Expired -> OutcomeText(
            "Sandpane: confirmation expired — conversation not deleted",
            "Core's confirmation expired at ${KeyedWrites.coreText(expiresAt)} before it was confirmed, so it was not sent. Run Delete again.",
            OutcomeSeverity.WARNING,
        )
        is Deleted -> OutcomeText(
            "Sandpane: conversation deleted",
            "Core reports '${KeyedWrites.coreText(DisplayCap.cap(name))}' deleted (deleted: true), with its messages and tasks. " +
                "Host files, worktrees, branches and sandboxes were not touched by Core. The conversation list is re-read.",
            OutcomeSeverity.INFO,
        )
        is Step2Unconfirmed -> OutcomeText(
            "Sandpane: deletion not confirmed by Core",
            "Core answered the confirming request without `deleted: true`. Whether the conversation was deleted is " +
                "UNKNOWN; nothing is retried and ${ConversationOutcomes.rereadSentence(rereadIncludesArchived)}.",
            OutcomeSeverity.WARNING,
        )
        is Step2Failed -> ConversationOutcomes.describeFailure(CoreMethods.CONVERSATION_DELETE, error, rereadIncludesArchived)
    }
}

/** The two-step delete with the UI injected (A1 pattern): step 1 → check → confirm → expiry → step 2. */
class ConversationDeleteFlow(
    private val commands: CoreCommands,
    private val ui: Ui,
    private val clock: () -> Instant = Instant::now,
    /** Where step 2 is sent from once the dialog has returned: never the UI thread (the IDE passes its io pool). */
    private val background: (() -> Unit) -> Unit = { task -> CompletableFuture.runAsync(task) },
) {
    interface Ui {
        fun onUiThread(block: () -> Unit)

        /** True ONLY for the explicit "Delete Conversation" choice. */
        fun confirm(issued: IssuedConversationDelete): Boolean
    }

    fun run(conversationId: String): CompletableFuture<ConversationDeleteOutcome> {
        val done = CompletableFuture<ConversationDeleteOutcome>()
        commands.conversationDeleteRequest(conversationId).whenComplete { result, error ->
            if (error != null) {
                done.complete(ConversationDeleteOutcome.Step1Failed(conversationId, error))
                return@whenComplete
            }
            when (val d = ConversationDeleteCheck.decide(conversationId, result)) {
                is ConversationDeleteCheck.Decision.Refused -> done.complete(ConversationDeleteOutcome.Refused(conversationId, d.reason))
                is ConversationDeleteCheck.Decision.Ready -> confirmThenSend(d.issued, done)
            }
        }
        return done
    }

    private fun confirmThenSend(issued: IssuedConversationDelete, done: CompletableFuture<ConversationDeleteOutcome>) {
        try {
            ui.onUiThread {
                val yes = try {
                    ui.confirm(issued)
                } catch (_: Throwable) {
                    false
                }
                when {
                    !yes -> done.complete(ConversationDeleteOutcome.Cancelled(issued.conversationId))
                    // Re-checked at click time: an expired (or unreadable) expiry is never sent.
                    issued.isExpired(clock()) -> done.complete(ConversationDeleteOutcome.Expired(issued.conversationId, issued.expiresAt))
                    else -> sendStep2(issued, done)
                }
            }
        } catch (_: Throwable) {
            done.complete(ConversationDeleteOutcome.Cancelled(issued.conversationId))
        }
    }

    /** Step 2, handed off the UI thread first: the frame is built and written on [background]. */
    private fun sendStep2(issued: IssuedConversationDelete, done: CompletableFuture<ConversationDeleteOutcome>) {
        try {
            background {
                val sent = try {
                    commands.conversationDeleteConfirm(issued)
                } catch (t: Throwable) {
                    CompletableFuture.failedFuture(t)
                }
                sent.whenComplete { result, error ->
                    done.complete(
                        when {
                            error != null -> ConversationDeleteOutcome.Step2Failed(issued.conversationId, error)
                            result?.deleted == true -> ConversationDeleteOutcome.Deleted(issued.conversationId, issued.name)
                            else -> ConversationDeleteOutcome.Step2Unconfirmed(issued.conversationId)
                        },
                    )
                }
            }
        } catch (_: Throwable) {
            done.complete(ConversationDeleteOutcome.Refused(issued.conversationId, "the confirming request could not be scheduled"))
        }
    }
}

/** What to do after a delete ends: when may this window forget the conversation? */
object ConversationDeleteFollowUp {

    /** The row limit the unknown-outcome re-read asks for (Core's maximum). */
    const val REREAD_LIMIT: Int = MAX_LIST_LIMIT

    enum class Next {
        /** Core confirmed the conversation is gone (`deleted: true`, or step-2 NOT_FOUND): forget it, re-read. */
        FORGET_AND_REREAD,

        /** Outcome unknown: re-read WITH archived conversations; forget only if Core's full list lacks it. */
        REREAD_ALL_THEN_FORGET_IF_GONE,

        /** Nothing changed (cancel, refusal, expiry, a known Core refusal): just re-read. */
        REREAD,
    }

    fun next(outcome: ConversationDeleteOutcome?): Next = when {
        outcome == null -> Next.REREAD_ALL_THEN_FORGET_IF_GONE
        outcome.confirmedDeleted -> Next.FORGET_AND_REREAD
        outcome is ConversationDeleteOutcome.Step2Failed && isNotFound(outcome.error) -> Next.FORGET_AND_REREAD
        outcome is ConversationDeleteOutcome.Step2Unconfirmed -> Next.REREAD_ALL_THEN_FORGET_IF_GONE
        outcome is ConversationDeleteOutcome.Step2Failed && ConversationOutcomes.isUnknown(outcome.error) ->
            Next.REREAD_ALL_THEN_FORGET_IF_GONE
        else -> Next.REREAD
    }

    /**
     * After an unknown outcome's re-read: true only when that read SUCCEEDED, included archived
     * conversations, came back with FEWER rows than [requestedLimit] (`conversation.list` has no
     * truncation flag, so a full page proves nothing) and does not list [conversationId].
     */
    fun goneAfterReread(
        conversationId: String,
        conversations: List<Conversation>?,
        archivedIncluded: Boolean,
        requestedLimit: Int = REREAD_LIMIT,
    ): Boolean =
        conversations != null && archivedIncluded && conversations.size < requestedLimit &&
            conversations.none { it.id == conversationId }

    private fun isNotFound(error: Throwable?): Boolean {
        val t = ErrorAttribution.unwrap(error)
        return t is CoreRpcException && t.raisedByCore && t.code == CoreErrorCodes.NOT_FOUND
    }
}

/**
 * A single-flight guard for one panel action (A3b review Info 2): while a Delete (step 1, the dialog,
 * step 2) or an Export (pages, save dialog, write) is running, a second click starts nothing and the
 * caller says so visibly. Thread-safe: launched on the EDT, released from whichever thread completes
 * the run. Released BEFORE [Launch.Started.done] completes, with the original value or failure.
 */
class SingleFlight {
    sealed class Launch<T> {
        /** Started; [done] completes after the guard is released. */
        class Started<T>(val done: CompletableFuture<T>) : Launch<T>()

        /** Another run is in flight: nothing was started. */
        class Busy<T> : Launch<T>()

        /** The starter declined (e.g. the user cancelled first): nothing is running. */
        class Declined<T> : Launch<T>()
    }

    private val busy = AtomicBoolean(false)

    val isBusy: Boolean get() = busy.get()

    fun <T> launch(start: () -> CompletableFuture<T>?): Launch<T> {
        if (!busy.compareAndSet(false, true)) return Launch.Busy()
        val running = try {
            start()
        } catch (t: Throwable) {
            busy.set(false)
            throw t
        }
        if (running == null) {
            busy.set(false)
            return Launch.Declined()
        }
        val done = CompletableFuture<T>()
        running.whenComplete { value, error ->
            busy.set(false)
            if (error != null) done.completeExceptionally(error) else done.complete(value)
        }
        return Launch.Started(done)
    }
}
