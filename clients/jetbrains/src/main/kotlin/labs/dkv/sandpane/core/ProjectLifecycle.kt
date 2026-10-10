// Protocol-v1 addition A3a (design 2026-10-09 §3.2): project lifecycle.
//
// Pure seams the actions use, unit-tested as shipped:
//   * [ProjectGuards] mirrors `Validator::project_name` / `project_description` EXACTLY (never
//     stricter, never looser), pinned against the Rust source by ProtocolDriftGuardTest;
//   * [ProjectDeleteCheck] + [IssuedProjectDelete] + [ProjectDeleteFlow]: the A1 two-step pattern —
//     step 2 can only be built from Core's verified step-1 answer, cancel/expiry send nothing, neither
//     step is retried, the token is never shown or printed;
//   * [ProjectOutcomes] words every answer honestly: Core's refusals (exact §3.2 messages) say
//     "nothing was …", INTERNAL/transport/timeout say "outcome UNKNOWN" — never "nothing was deleted";
//   * [ProjectUiState] decides which project actions an ARCHIVED project allows (Core's own rule).
package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.Project
import labs.dkv.sandpane.model.ProjectDeleteResult
import labs.dkv.sandpane.text.VisibleText
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeoutException

/** Client mirror of Core's project name / description rules. Returns the problem, or null when valid. */
object ProjectGuards {

    /** `MAX_PROJECT_NAME_CHARS` (Unicode scalar values, like Rust's `chars().count()`). */
    const val MAX_NAME_CHARS: Int = 120

    /** `MAX_PROJECT_DESCRIPTION_CHARS`. */
    const val MAX_DESCRIPTION_CHARS: Int = 2000

    /**
     * `is_spoofing_format_char`: U+2028, U+2029, U+200E, U+200F, U+061C, U+202A..=U+202E and
     * U+2066..=U+2069. Written as numbers so no invisible character ever sits in this source.
     */
    fun isSpoofingFormatChar(codePoint: Int): Boolean =
        codePoint == 0x2028 || codePoint == 0x2029 || codePoint == 0x200E || codePoint == 0x200F ||
            codePoint == 0x061C || codePoint in 0x202A..0x202E || codePoint in 0x2066..0x2069

    /** Rust `char::is_control` = general category Cc (C0, DEL, C1). */
    private fun isControl(codePoint: Int): Boolean = Character.getType(codePoint) == Character.CONTROL.toInt()

    /** `Validator::project_name`: 1..=120 chars, no Cc at all (incl. `\n`, `\t`), no spoofing char. */
    fun nameProblem(value: String): String? {
        if (value.isEmpty()) return "the name is empty"
        val count = value.codePointCount(0, value.length)
        if (count > MAX_NAME_CHARS) return "the name is $count characters; the limit is $MAX_NAME_CHARS"
        firstBad(value) { isControl(it) || isSpoofingFormatChar(it) }?.let { return "the name contains $it, which Core refuses" }
        return null
    }

    /**
     * `Validator::project_description`: at most 2000 chars (EMPTY is allowed and clears it); `\n` is the
     * only control character allowed; no spoofing char.
     */
    fun descriptionProblem(value: String): String? {
        val count = value.codePointCount(0, value.length)
        if (count > MAX_DESCRIPTION_CHARS) return "the description is $count characters; the limit is $MAX_DESCRIPTION_CHARS"
        firstBad(value) { (isControl(it) && it != '\n'.code) || isSpoofingFormatChar(it) }
            ?.let { return "the description contains $it, which Core refuses" }
        return null
    }

    private fun firstBad(value: String, bad: (Int) -> Boolean): String? {
        var i = 0
        while (i < value.length) {
            val cp = value.codePointAt(i)
            // A lone UTF-16 surrogate is not a Unicode scalar value: it cannot exist in a Rust
            // `String`, so Core can never accept it either (this is not stricter than Core).
            if (bad(cp) || Character.getType(cp) == Character.SURROGATE.toInt()) return "U+%04X".format(cp)
            i += Character.charCount(cp)
        }
        return null
    }
}

/**
 * A verified step-1 project-delete confirmation, the ONLY carrier of a token toward step 2. Its
 * constructor is private; the module-internal factory's only caller is [ProjectDeleteCheck.decide].
 */
class IssuedProjectDelete private constructor(
    val projectId: String,
    /** Core's CURRENT name for the project (a rename between the steps does not void the token). */
    val name: String,
    val expiresAt: String,
    val impact: List<String>,
    internal val token: String,
) {
    val expiresAtInstant: Instant? = parseExpiry(expiresAt)

    /**
     * True when the expiry has passed — or cannot be read: fail CLOSED (like the VS Code and desktop
     * clients). [ProjectDeleteCheck.decide] already refuses an unreadable expiry; this is the second net.
     */
    fun isExpired(now: Instant): Boolean = expiresAtInstant?.let { !now.isBefore(it) } ?: true

    override fun toString(): String =
        "IssuedProjectDelete(projectId=$projectId, expiresAt=$expiresAt, impact=${impact.size} line(s), token=<redacted>)"

    internal companion object {
        fun of(projectId: String, name: String, expiresAt: String, impact: List<String>, token: String) =
            IssuedProjectDelete(projectId, name, expiresAt, impact, token)

        fun parseExpiry(value: String): Instant? = try {
            OffsetDateTime.parse(value).toInstant()
        } catch (_: DateTimeParseException) {
            null
        }
    }
}

/** Judges Core's step-1 `project.delete` answer before anything is shown or sent. */
object ProjectDeleteCheck {

    sealed class Decision {
        data class Ready(val issued: IssuedProjectDelete) : Decision()
        data class Refused(val reason: String) : Decision()
    }

    /**
     * Accept only a `project.delete` confirmation bound to the very project id requested, with a
     * token of Core's shape; a `deleted` flag at step 1 is never trusted. The NAME is not compared:
     * Core binds the token to the id, and the dialog shows Core's current name.
     */
    fun decide(requestedProjectId: String, result: ProjectDeleteResult?): Decision {
        if (result == null) return Decision.Refused("Core returned no step-1 answer")
        if (result.deleted != null) {
            return Decision.Refused("Core's step-1 answer carries `deleted` — step 1 must change nothing, so it is not trusted")
        }
        val c = result.confirmation ?: return Decision.Refused("Core's step-1 answer carries no confirmation")
        if (c.action != CoreMethods.PROJECT_DELETE) {
            return Decision.Refused("the confirmation is for '${VisibleText.reveal(c.action)}', not ${CoreMethods.PROJECT_DELETE}")
        }
        if (c.target.id != requestedProjectId) {
            return Decision.Refused(
                "the confirmation is for project '${VisibleText.reveal(c.target.id)}', not '${VisibleText.reveal(requestedProjectId)}'",
            )
        }
        if (!CoreGuards.isConfirmTokenShape(c.token)) {
            return Decision.Refused("the confirmation token does not have the shape Core issues (64 lowercase hex)")
        }
        if (c.external) {
            // Core never marks a project confirmation external; an answer that does is not understood.
            return Decision.Refused("the confirmation is marked external, which ${CoreMethods.PROJECT_DELETE} never is")
        }
        if (IssuedProjectDelete.parseExpiry(c.expiresAt) == null) {
            // Fail closed: an expiry that cannot be checked at click time is not acted on.
            return Decision.Refused(
                "its expiry '${KeyedWrites.coreText(c.expiresAt)}' cannot be read, so the confirmation cannot be used; " +
                    "run Delete Project again",
            )
        }
        return Decision.Ready(IssuedProjectDelete.of(requestedProjectId, c.target.name, c.expiresAt, c.impact, c.token))
    }
}

/** Honest wording for every A3a answer. */
object ProjectOutcomes {

    // §3.2 item 8 and project_lifecycle.rs — verbatim; pinned by ProtocolDriftGuardTest.
    const val MSG_PROJECT_ARCHIVED = "project is archived; unarchive it first; nothing was changed"
    const val MSG_PROJECT_HAS_TASKS =
        "project has tasks that are not finished; cancel or finish them first; nothing was deleted"
    const val MSG_PROJECT_HAS_SANDBOXES = "project has sandboxes; remove them first; nothing was deleted"
    const val MSG_REPOSITORY_IN_USE = "repository is used by a task or sandbox of this project; nothing was removed"
    const val MSG_PROJECT_CREATE_IN_FLIGHT =
        "a sandbox is being created for this project; try again when it finishes; nothing was deleted"
    const val MSG_REPOSITORY_REMOVE_WHILE_CREATING =
        "a sandbox is being created for this project; try again when it finishes; nothing was removed"
    const val MSG_REPOSITORY_UNREGISTERED_DURING_CREATE =
        "the repository was unregistered from this project while the sandbox was being prepared; nothing was run"
    const val MSG_PROJECT_NOT_FOUND = "project not found"
    const val MSG_REPOSITORY_NOT_REGISTERED = "repository is not registered with this project; nothing was removed"
    const val MSG_UPDATE_NEEDS_A_FIELD = "project.update needs name or description; nothing was changed"

    /**
     * Each exact Core refusal with the code Core raises it under, and plain copy for it (Core's own
     * text is always shown too). Only these — matched EXACTLY, code and text — and Core's step-2
     * token rejection earn a "nothing was …" sentence; any other refusal is shown without a claim.
     */
    private data class Known(val code: String, val plain: String)

    private val KNOWN: Map<String, Known> = mapOf(
        MSG_PROJECT_ARCHIVED to Known(CoreErrorCodes.VALIDATION_FAILED, "This project is archived — unarchive it first."),
        MSG_PROJECT_HAS_TASKS to Known(CoreErrorCodes.CONFLICT, "This project still has unfinished tasks — cancel or finish them first."),
        MSG_PROJECT_HAS_SANDBOXES to Known(
            CoreErrorCodes.CONFLICT,
            "This project still has sandboxes — remove them first (Core never removes a sandbox as a side effect).",
        ),
        MSG_REPOSITORY_IN_USE to Known(CoreErrorCodes.CONFLICT, "A task or sandbox of this project uses that repository."),
        MSG_PROJECT_CREATE_IN_FLIGHT to Known(CoreErrorCodes.CONFLICT, "A sandbox is being created for this project — try again when it finishes."),
        MSG_REPOSITORY_REMOVE_WHILE_CREATING to Known(CoreErrorCodes.CONFLICT, "A sandbox is being created for this project — try again when it finishes."),
        MSG_REPOSITORY_UNREGISTERED_DURING_CREATE to Known(CoreErrorCodes.CONFLICT, "The repository was unregistered while the sandbox was being prepared."),
        MSG_PROJECT_NOT_FOUND to Known(CoreErrorCodes.NOT_FOUND, "Core no longer has this project."),
        MSG_REPOSITORY_NOT_REGISTERED to Known(CoreErrorCodes.NOT_FOUND, "That repository is not registered with this project."),
        MSG_UPDATE_NEEDS_A_FIELD to Known(CoreErrorCodes.VALIDATION_FAILED, "Nothing to change was given."),
    )

    /** Every exact message this client words (for the drift test). */
    val KNOWN_MESSAGES: Set<String> get() = KNOWN.keys

    /** What a Core refusal of [method] means: the verb of "nothing was …". */
    fun nothingWas(method: String): String = when (method) {
        CoreMethods.PROJECT_DELETE -> "nothing was deleted"
        CoreMethods.PROJECT_REMOVE_REPOSITORY -> "nothing was removed"
        CoreMethods.PROJECT_ADD_REPOSITORY -> "nothing was added"
        CoreMethods.SANDBOX_CREATE -> "nothing was run"
        else -> "nothing was changed"
    }

    /** Plain copy when [t] is one of Core's exact refusals (or the delete token rejection); else null. */
    private fun knownRefusal(method: String, t: CoreRpcException): String? {
        if (!t.raisedByCore) return null
        KNOWN[t.message]?.takeIf { it.code == t.code }?.let { return it.plain }
        if (method == CoreMethods.PROJECT_DELETE && t.code == CoreErrorCodes.VALIDATION_FAILED &&
            t.message.startsWith(CoreRemoveRefusals.TOKEN_REJECTED_PREFIX)
        ) {
            return "The confirmation was invalid, expired or already used — run Delete Project again for a fresh one."
        }
        return null
    }

    /** The re-read sentence: only claims archived projects are included when they are. */
    fun rereadSentence(rereadIncludesArchived: Boolean): String =
        if (rereadIncludesArchived) {
            "the project list is re-read from Core, including archived projects"
        } else {
            "the project list is re-read from Core (this Core cannot list archived projects)"
        }

    /**
     * Words a failure of [method]:
     *  * this plugin's refusal → nothing was sent;
     *  * one of Core's EXACT refusals (code + text) → plain copy + "nothing was …" + Core's text;
     *  * any other Core verdict except INTERNAL → Core's code and text, with NO claim about state;
     *  * INTERNAL, an unusable reply, a timeout or a lost connection → outcome UNKNOWN, nothing is
     *    retried, and the list is re-read ([rereadIncludesArchived] says whether archived rows are in it).
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

    /**
     * True when [error] leaves the outcome UNKNOWN (INTERNAL, an unusable reply, a timeout, a lost
     * connection): then the follow-up re-read asks for archived projects too, so the user sees the
     * project wherever it ended up. A local refusal or another Core verdict is known: nothing changed.
     */
    fun isUnknown(error: Throwable?): Boolean {
        val t = ErrorAttribution.unwrap(error)
        if (t is CoreValidationException || t is MethodNotSupportedException) return false
        return !(t is CoreRpcException && t.raisedByCore && t.code != CoreErrorCodes.INTERNAL)
    }

    /**
     * Step 1 of a delete only ASKS Core for a confirmation — it never deletes — so a failure there is
     * never an unknown outcome: the project was not deleted, whatever the cause.
     */
    fun describeStep1Failure(error: Throwable?): OutcomeText {
        val t = ErrorAttribution.unwrap(error)
        val plain = (t as? CoreRpcException)?.let { knownRefusal(CoreMethods.PROJECT_DELETE, it) }
        return OutcomeText(
            "Sandpane: project not deleted",
            listOfNotNull(
                plain,
                "No confirmation was issued. Step 1 only asks Core for a confirmation and never deletes, so the " +
                    "project was not deleted.",
                ErrorAttribution.describe(CoreMethods.PROJECT_DELETE, t),
            ).joinToString(" "),
            if (plain != null || ErrorAttribution.refusedLocally(t)) OutcomeSeverity.WARNING else OutcomeSeverity.ERROR,
        )
    }

    private fun unknownCause(t: Throwable?): String = when (t) {
        is TimeoutException -> "no answer before the deadline"
        is CoreTransportException -> "the connection to Core failed"
        is CoreRpcException -> if (t.raisedByCore) "Core reported ${t.code}: ${KeyedWrites.coreText(t.message)}" else "Core's reply was unusable"
        null -> "no answer"
        else -> "an unexpected ${t.javaClass.simpleName} while handling the answer (details not shown)"
    }

    /** Success copy; Core's names are revealed and capped. */
    fun describeSuccess(method: String, project: Project?): OutcomeText {
        val shown = project?.let { KeyedWrites.coreText(it.name) } ?: "the project"
        val what = when (method) {
            CoreMethods.PROJECT_UPDATE -> "updated"
            CoreMethods.PROJECT_ARCHIVE -> "archived (Core reports archivedAt ${project?.archivedAt?.let(KeyedWrites::coreText) ?: "not given"})"
            CoreMethods.PROJECT_UNARCHIVE -> "unarchived"
            CoreMethods.PROJECT_ADD_REPOSITORY -> "now lists ${project?.repositories?.size ?: 0} repository path(s)"
            CoreMethods.PROJECT_REMOVE_REPOSITORY -> "now lists ${project?.repositories?.size ?: 0} repository path(s)"
            else -> "answered"
        }
        return OutcomeText("Sandpane: project $what", "Core reports '$shown' $what. The project list is re-read from Core.", OutcomeSeverity.INFO)
    }
}

/** Which project actions an archived project allows — Core's own §3.2 item 3 rule, for the UI. */
object ProjectUiState {

    enum class Action { EDIT, ARCHIVE, UNARCHIVE, ADD_REPOSITORY, REMOVE_REPOSITORY, DELETE }

    /** Null when [action] is allowed for [project]; otherwise the reason to show (Core's for archived). */
    fun blockedReason(project: Project, action: Action): String? = when {
        action == Action.DELETE -> null
        action == Action.UNARCHIVE -> if (project.isArchived) null else "the project is not archived"
        project.isArchived && action == Action.ARCHIVE -> "the project is already archived"
        project.isArchived -> ProjectOutcomes.MSG_PROJECT_ARCHIVED
        action == Action.REMOVE_REPOSITORY && project.repositories.isEmpty() -> "Core lists no repository for this project"
        else -> null
    }

    /** Picker label: archived projects are visibly labeled. Core text is revealed by the renderer. */
    fun label(project: Project): String = if (project.isArchived) "${project.name} [archived]" else project.name
}

/** Every way one project delete can end. */
sealed class ProjectDeleteOutcome {
    abstract val projectId: String

    data class Step1Failed(override val projectId: String, val error: Throwable?) : ProjectDeleteOutcome()
    data class Refused(override val projectId: String, val reason: String) : ProjectDeleteOutcome()
    data class Cancelled(override val projectId: String) : ProjectDeleteOutcome()
    data class Expired(override val projectId: String, val expiresAt: String) : ProjectDeleteOutcome()
    data class Deleted(override val projectId: String, val name: String) : ProjectDeleteOutcome()
    data class Step2Unconfirmed(override val projectId: String) : ProjectDeleteOutcome()
    data class Step2Failed(override val projectId: String, val error: Throwable?) : ProjectDeleteOutcome()

    /** Only a confirmed `deleted: true` lets the client forget the project's local state. */
    val confirmedDeleted: Boolean get() = this is Deleted

    /** [rereadIncludesArchived]: whether the follow-up `project.list` includes archived projects. */
    fun describe(rereadIncludesArchived: Boolean): OutcomeText = when (this) {
        is Step1Failed -> ProjectOutcomes.describeStep1Failure(error)
        is Refused -> OutcomeText(
            "Sandpane: project not deleted — confirmation not usable",
            "Core's confirmation was not acted on: ${VisibleText.reveal(reason)}. The confirming request was NOT sent; nothing was deleted.",
            OutcomeSeverity.ERROR,
        )
        is Cancelled -> OutcomeText("Sandpane: project not deleted", "Cancelled. The confirming request was not sent; nothing was deleted.", OutcomeSeverity.INFO)
        is Expired -> OutcomeText(
            "Sandpane: confirmation expired — project not deleted",
            "Core's confirmation expired at ${KeyedWrites.coreText(expiresAt)} before it was confirmed, so it was not sent. Run Delete Project again.",
            OutcomeSeverity.WARNING,
        )
        is Deleted -> OutcomeText(
            "Sandpane: project deleted",
            "Core reports '${KeyedWrites.coreText(name)}' deleted (deleted: true). Host files, branches, worktree " +
                "directories and sandboxes were not touched by Core. The project list is re-read.",
            OutcomeSeverity.INFO,
        )
        is Step2Unconfirmed -> OutcomeText(
            "Sandpane: deletion not confirmed by Core",
            "Core answered the confirming request without `deleted: true`. Whether the project was deleted is UNKNOWN; " +
                "nothing is retried and ${ProjectOutcomes.rereadSentence(rereadIncludesArchived)}.",
            OutcomeSeverity.WARNING,
        )
        is Step2Failed -> ProjectOutcomes.describeFailure(CoreMethods.PROJECT_DELETE, error, rereadIncludesArchived)
    }
}

/** The two-step delete with the UI injected (A1 pattern): step 1 → check → confirm → expiry → step 2. */
class ProjectDeleteFlow(
    private val commands: CoreCommands,
    private val ui: Ui,
    private val clock: () -> Instant = Instant::now,
    /**
     * Where step 2 is sent from once the dialog has returned: never the UI thread. The IDE passes
     * ConnectionManager's io pool; the default is the common pool.
     */
    private val background: (() -> Unit) -> Unit = { task -> CompletableFuture.runAsync(task) },
) {
    interface Ui {
        fun onUiThread(block: () -> Unit)

        /** True ONLY for the explicit "Delete Project" choice. */
        fun confirm(issued: IssuedProjectDelete): Boolean
    }

    fun run(projectId: String): CompletableFuture<ProjectDeleteOutcome> {
        val done = CompletableFuture<ProjectDeleteOutcome>()
        commands.projectDeleteRequest(projectId).whenComplete { result, error ->
            if (error != null) {
                done.complete(ProjectDeleteOutcome.Step1Failed(projectId, error))
                return@whenComplete
            }
            when (val d = ProjectDeleteCheck.decide(projectId, result)) {
                is ProjectDeleteCheck.Decision.Refused -> done.complete(ProjectDeleteOutcome.Refused(projectId, d.reason))
                is ProjectDeleteCheck.Decision.Ready -> confirmThenSend(d.issued, done)
            }
        }
        return done
    }

    private fun confirmThenSend(issued: IssuedProjectDelete, done: CompletableFuture<ProjectDeleteOutcome>) {
        try {
            ui.onUiThread {
                val yes = try {
                    ui.confirm(issued)
                } catch (_: Throwable) {
                    false
                }
                when {
                    !yes -> done.complete(ProjectDeleteOutcome.Cancelled(issued.projectId))
                    // Re-checked at click time: an expired (or unreadable) expiry is never sent.
                    issued.isExpired(clock()) -> done.complete(ProjectDeleteOutcome.Expired(issued.projectId, issued.expiresAt))
                    else -> sendStep2(issued, done)
                }
            }
        } catch (_: Throwable) {
            done.complete(ProjectDeleteOutcome.Cancelled(issued.projectId))
        }
    }

    /** Step 2, handed off the UI thread first: the frame is built and written on [background]. */
    private fun sendStep2(issued: IssuedProjectDelete, done: CompletableFuture<ProjectDeleteOutcome>) {
        try {
            background {
                val sent = try {
                    commands.projectDeleteConfirm(issued)
                } catch (t: Throwable) {
                    CompletableFuture.failedFuture(t)
                }
                sent.whenComplete { result, error ->
                    done.complete(
                        when {
                            error != null -> ProjectDeleteOutcome.Step2Failed(issued.projectId, error)
                            result?.deleted == true -> ProjectDeleteOutcome.Deleted(issued.projectId, issued.name)
                            else -> ProjectDeleteOutcome.Step2Unconfirmed(issued.projectId)
                        },
                    )
                }
            }
        } catch (_: Throwable) {
            // Could not even be scheduled: the confirming request was never written.
            done.complete(ProjectDeleteOutcome.Refused(issued.projectId, "the confirming request could not be scheduled"))
        }
    }
}

/** What to do after a delete ends (item 4 of the A3a review): when may this window forget the project? */
object ProjectDeleteFollowUp {

    enum class Next {
        /** Core confirmed the project is gone (`deleted: true`, or step-2 NOT_FOUND): forget it, re-read. */
        FORGET_AND_REREAD,

        /** Outcome unknown: re-read WITH archived projects; forget only if Core's full list lacks it. */
        REREAD_ALL_THEN_FORGET_IF_GONE,

        /** Nothing changed (cancel, refusal, expiry, a known Core refusal): just re-read. */
        REREAD,
    }

    fun next(outcome: ProjectDeleteOutcome?): Next = when {
        outcome == null -> Next.REREAD_ALL_THEN_FORGET_IF_GONE
        outcome.confirmedDeleted -> Next.FORGET_AND_REREAD
        outcome is ProjectDeleteOutcome.Step2Failed && isNotFound(outcome.error) -> Next.FORGET_AND_REREAD
        outcome is ProjectDeleteOutcome.Step2Unconfirmed -> Next.REREAD_ALL_THEN_FORGET_IF_GONE
        outcome is ProjectDeleteOutcome.Step2Failed && ProjectOutcomes.isUnknown(outcome.error) -> Next.REREAD_ALL_THEN_FORGET_IF_GONE
        else -> Next.REREAD
    }

    /**
     * After an unknown outcome's re-read: true only when that read SUCCEEDED, included archived
     * projects, and does not list [projectId] — Core's complete answer, not a partial or failed list.
     */
    fun goneAfterReread(projectId: String, projects: List<Project>?, archivedIncluded: Boolean): Boolean =
        projects != null && archivedIncluded && projects.none { it.id == projectId }

    private fun isNotFound(error: Throwable?): Boolean {
        val t = ErrorAttribution.unwrap(error)
        return t is CoreRpcException && t.raisedByCore && t.code == CoreErrorCodes.NOT_FOUND
    }
}
