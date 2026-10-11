package labs.dkv.sandpane.ui

import labs.dkv.sandpane.model.Conversation
import labs.dkv.sandpane.text.DisplayCap

/**
 * Review bug 3: after a refresh the chat picker silently jumped to the first conversation while
 * the transcript still showed the previous one, so Send posted to a conversation the user was not
 * looking at. These pure rules keep the three things — picker selection, displayed transcript,
 * and Send target — the same conversation.
 */
object ConversationSelection {

    /**
     * Which conversation the picker should select after Core re-enumerated [available]:
     * - a previous selection is kept by id (never by position) when Core still lists it, and when Core
     *   no longer lists it NOTHING is selected (A3b review W1: e.g. it was just archived while "Show
     *   archived" is off) — another conversation is never substituted, so Send cannot silently move;
     * - only with no previous selection (an initial load) is Core's first conversation shown.
     */
    fun choose(previousId: String?, available: List<Conversation>): Conversation? =
        if (previousId != null) available.firstOrNull { it.id == previousId } else available.firstOrNull()

    /** Outcome of applying one `conversation.list` answer to the picker. */
    data class Reconciled(
        /** What the picker must select. */
        val choice: Conversation?,
        /** The id the user had selected IN THIS PROJECT that Core no longer lists, if any. */
        val vanishedId: String?,
    )

    /**
     * Apply a `conversation.list` answer for [answeredProjectId] (review W2).
     *
     * [currentSelectedId] is read when the answer ARRIVES, not when the request left — the user
     * may have picked another chat in between, and that pick wins. [modelProjectId] is the project
     * whose conversations the picker currently holds: when it differs from [answeredProjectId]
     * the old selection belongs to another project, so it is neither kept nor reported as
     * vanished, and Core's first conversation is shown (an initial load of that project).
     *
     * Within the same project nothing is ever auto-selected (A3b review W1): a selection Core no longer
     * lists becomes NONE, and NONE stays NONE on later refreshes until the user picks.
     */
    fun reconcile(
        currentSelectedId: String?,
        modelProjectId: String?,
        answeredProjectId: String,
        listed: List<Conversation>,
    ): Reconciled {
        if (modelProjectId != answeredProjectId) return Reconciled(choose(null, listed), null)
        val keep = currentSelectedId ?: return Reconciled(null, null)
        val choice = choose(keep, listed)
        return Reconciled(choice, if (choice == null) keep else null)
    }

    /**
     * Must the transcript be reloaded (or cleared) so it shows [selectedId]? True whenever what is
     * displayed is not what is selected — including "something displayed, nothing selected".
     */
    fun transcriptOutOfSync(selectedId: String?, displayedId: String?): Boolean = selectedId != displayedId

    /** The Send-target line shown next to the Send button. Plain text; rendered with HTML disabled. */
    fun targetLine(selected: Conversation?): String =
        if (selected == null) {
            "→ no conversation selected"
        } else {
            "→ " + displayName(selected) + " (" + selected.id.take(8) + ")"
        }

    /**
     * Core's title when it has one, else a short id, capped at [DisplayCap.MAX_CODE_POINTS] (Core does
     * not bound titles stored before A3b). Never markup — callers render it literally.
     */
    fun displayName(conversation: Conversation): String =
        DisplayCap.cap(conversation.title.takeIf { it.isNotBlank() } ?: conversation.id.take(8))
}
