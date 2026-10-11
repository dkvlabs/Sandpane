package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.ConversationSendParams
import labs.dkv.sandpane.model.ContextRef
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreFeatures
import labs.dkv.sandpane.model.TaskSummary
import labs.dkv.sandpane.text.DisplayCap
import labs.dkv.sandpane.text.VisibleText

/**
 * A4 \u2014 the `conversation.send` mode (design 2026-10-09 \u00A73.4). Core records the requested mode on
 * the task; in this build NEITHER mode runs an agent (no verified adapter), so both stay queued. The
 * composer's choice is UI-only and not remembered: it resets to Task whenever the selected
 * conversation changes, so a Discuss choice never carries over to another chat.
 */
object SendModes {
    /** Core's spellings (`SendMode::as_str`); drift-checked. */
    const val TASK: String = "task"
    const val DISCUSS: String = "discuss"
    val WIRE_VALUES: List<String> = listOf(TASK, DISCUSS)

    /** Core's exact VALIDATION_FAILED text for any other value (`MSG_SEND_MODE_INVALID`); drift-checked. */
    const val MSG_SEND_MODE_INVALID: String = "mode must be \"task\" or \"discuss\""

    const val MODE_LABEL: String = "Send mode"
    const val CHOSEN_SANDBOX_LABEL: String = "sandbox chosen by its chat \u2014 not where it runs"

    /** Composer tooltip. Says only what Core does: it records the requested mode. */
    const val COMPOSER_COPY: String =
        "Send mode: Core records whether this message was sent as a Task or a Discussion. " +
            "Neither Task nor Discuss runs an agent in this build (no verified agent adapter): the task " +
            "stays queued either way."

    const val NOT_SUPPORTED: String =
        "Send mode: not supported by this Core (it does not advertise '${CoreFeatures.CONVERSATION_SEND_MODE}'); " +
            "every message is sent as a task."

    enum class Choice(val label: String, val wire: String?) {
        /** The default. Omitted on the wire, so the frame is byte-identical to a pre-A4 frame. */
        TASK("Task", null),
        DISCUSS("Discuss", SendModes.DISCUSS),
        ;

        override fun toString(): String = label
    }

    sealed class ChoiceState {
        data object Enabled : ChoiceState()
        data class Disabled(val reason: String) : ChoiceState()
    }

    fun advertised(caps: CoreCapabilities?): Boolean = caps?.hasFeature(CoreFeatures.CONVERSATION_SEND_MODE) == true

    /** Enabled only when Core advertises the feature; otherwise disabled, saying so. */
    fun choiceState(caps: CoreCapabilities?): ChoiceState =
        if (advertised(caps)) ChoiceState.Enabled else ChoiceState.Disabled(NOT_SUPPORTED)

    /** What the composer may use: Task unless the feature is advertised. */
    fun effectiveChoice(selected: Choice?, caps: CoreCapabilities?): Choice =
        if (advertised(caps)) selected ?: Choice.TASK else Choice.TASK

    /** The params the chat panel sends (before [KeyedRequests.newSend] adds a key). */
    fun sendParams(
        conversationId: String,
        content: String,
        attachments: List<ContextRef>,
        choice: Choice,
    ): ConversationSendParams = ConversationSendParams(
        conversationId = conversationId,
        content = content,
        attachments = attachments,
        mode = choice.wire,
    )

    sealed class ComposerSend {
        data class Ready(val params: ConversationSendParams) : ComposerSend()
        data class Refused(val reason: String) : ComposerSend()
    }

    /**
     * What the composer sends for the user's SELECTED choice, passed as-is (review W3). A Discuss
     * choice meeting a Core that does not advertise the feature (e.g. a reconnect raced the combo
     * reset) is REFUSED visibly, nothing is sent \u2014 it is never silently sent as a Task.
     * [effectiveChoice] is for the combo's display state only.
     */
    fun composerSend(
        conversationId: String,
        content: String,
        attachments: List<ContextRef>,
        selected: Choice?,
        caps: CoreCapabilities?,
    ): ComposerSend {
        val params = sendParams(conversationId, content, attachments, selected ?: Choice.TASK)
        return refusal(params, caps)?.let { ComposerSend.Refused(it) } ?: ComposerSend.Ready(params)
    }

    /** Why [params] must not be sent to a Core with [caps], or null. Checked before any key is minted. */
    fun refusal(params: ConversationSendParams, caps: CoreCapabilities?): String? =
        if (params.mode != null && !advertised(caps)) {
            "this Core does not advertise '${CoreFeatures.CONVERSATION_SEND_MODE}', so it would drop the send mode " +
                "and record this as a task; nothing was sent"
        } else {
            null
        }

    /** Read-only display lines for Core's reported values, revealed and capped; empty when absent. */
    fun details(mode: String?, chosenSandboxName: String?): List<String> = listOfNotNull(
        mode?.let { "$MODE_LABEL: ${VisibleText.reveal(DisplayCap.cap(it))}" },
        chosenSandboxName?.let { "$CHOSEN_SANDBOX_LABEL: ${VisibleText.reveal(DisplayCap.cap(it))}" },
    )

    fun detailsOf(summary: TaskSummary): List<String> = details(summary.mode, summary.chosenSandboxName)
}
