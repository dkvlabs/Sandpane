package labs.dkv.sandpane.ui

import labs.dkv.sandpane.core.RunTarget
import labs.dkv.sandpane.core.Verifications
import labs.dkv.sandpane.model.VerificationResult
import labs.dkv.sandpane.model.WorkspaceMode
import labs.dkv.sandpane.text.DisplayCap

/**
 * The A7 confirmation and result texts (design 2026-10-09 §3.7 items 6 and 8), separate from the
 * dialogs so they are unit-tested as shipped. Every Core / user / agent value (labels, argv elements,
 * notes, sandbox names, task ids, output) is untrusted, so every text here is PLAIN: a list of
 * single-line strings, each untrusted value revealed (hidden characters escaped) and, in a list,
 * one row per element with the count. The dialogs show the lines in a non-editable plain
 * `JTextArea` with `html.disable` set — never an HTML view, Markdown, a terminal, a console or a link.
 */
object VerificationText {

    const val APPROVE_TITLE: String = "Sandpane: Approve Verification Command"
    const val RUN_TITLE: String = "Sandpane: Run Verification"
    const val REVOKE_TITLE: String = "Sandpane: Revoke Verification Command"
    const val APPROVE_LABEL: String = "Approve"
    const val RUN_LABEL: String = "Run"
    const val REVOKE_LABEL: String = "Revoke"
    const val CANCEL_LABEL: String = "Cancel"

    /** Shown instead of Core's notes once the user changed a suggestion's argv (D-I4). */
    const val EDITED_SUGGESTION: String =
        "You edited the suggested arguments. Core's notes described the original suggestion only, so they are not shown."

    /**
     * An argv element in a CONFIRMATION: the whole element, revealed, delimited (never capped: Core
     * caps it at 4096 bytes), with non-U+0020 spaces and the delimiters escaped inside it.
     */
    fun fullElement(text: String): String =
        "" + Verifications.ELEMENT_OPEN + Verifications.elementBody(text, capped = false) + Verifications.ELEMENT_CLOSE

    /** One line per element: `  [n] ⟨…⟩`. */
    fun argvRows(argv: List<String>): List<String> = argv.mapIndexed { i, a -> "  [${i + 1}] " + fullElement(a) }

    /**
     * The notes a confirmation shows for a suggestion (D-I4): Core's notes describe the ORIGINAL
     * suggested argv only, so they are shown only while [editedArgv] is byte-for-byte that list;
     * otherwise null (no notes, and no "suggestion" heading).
     */
    fun notesForConfirmation(suggestedArgv: List<String>?, notes: List<String>?, editedArgv: List<String>): List<String>? =
        if (suggestedArgv != null && notes != null && editedArgv == suggestedArgv) notes else null

    /**
     * The approve confirmation (§3.7 item 8): the label, every element with the count, the two
     * statements, and either the suggestion's notes ([notes], unedited suggestion) or
     * [EDITED_SUGGESTION] ([editedFromSuggestion]).
     */
    fun approveConfirmation(
        projectName: String,
        label: String,
        argv: List<String>,
        notes: List<String>?,
        editedFromSuggestion: Boolean,
    ): List<String> = buildList {
        add("Approve this exact argument list as a verification command?")
        add("")
        add("project: " + Verifications.item(DisplayCap.cap(projectName)))
        add("label: " + Verifications.item(label))
        add("")
        add("Arguments (${argv.size}) — exactly these are stored; a run passes them to sbx exec as a list, with no shell:")
        addAll(argvRows(argv))
        add("")
        add(Verifications.DO_NOT_PUT_SECRETS)
        add(Verifications.APPROVAL_BINDS)
        if (notes != null) {
            add("")
            add("Notes Core showed for this suggestion (${notes.size}):")
            if (notes.isEmpty()) add("  (none)") else notes.forEachIndexed { i, n -> add("  [n${i + 1}] " + Verifications.item(n)) }
        } else if (editedFromSuggestion) {
            add("")
            add(EDITED_SUGGESTION)
        }
        add("")
        add("Core checks the label and every argument for secret-shaped text and refuses the approval if it finds any.")
    }

    /** The run confirmation (§3.7 item 8): the command, the sandbox, the mode and its warnings. */
    fun runConfirmation(taskId: String, target: RunTarget.Bound, label: String, argv: List<String>): List<String> = buildList {
        add("Run this approved command in the task's sandbox?")
        add("")
        add("task: " + Verifications.item(taskId))
        add("sandbox: " + Verifications.item(target.sandboxName))
        add("workspace mode: " + target.mode.wireName)
        add("command: " + Verifications.item(label))
        add("")
        add("Arguments (${argv.size}):")
        addAll(argvRows(argv))
        add("")
        when (target.mode) {
            WorkspaceMode.DIRECT_MOUNT -> { add("Direct mount: " + Verifications.DIRECT_MOUNT_WARNING); add("") }
            WorkspaceMode.HOST_WORKTREE -> { add("Task worktree: " + Verifications.HOST_WORKTREE_WARNING); add("") }
            else -> {}
        }
        add(Verifications.RUN_WHERE)
        add(Verifications.UNVERIFIED_NOTE)
        add(
            "Core re-checks the binding, the sandbox's identity and that it is running, and that the command is " +
                "still approved; if anything changed, nothing is run.",
        )
        add("Output is not shown here: read it with Refresh result once Core reports the run finished.")
    }

    /** The revoke confirmation: plain, not destructive (the row is tombstoned in Core, never deleted). */
    fun revokeConfirmation(label: String, argv: List<String>): List<String> = buildList {
        add("Revoke this verification command? It can no longer be run; a run already in progress is not stopped.")
        add("")
        add("label: " + Verifications.item(label))
        add("Arguments (${argv.size}):")
        addAll(argvRows(argv))
    }

    /** The header lines of the output dialog: command, sandbox, outcome and every disclosure. */
    fun resultHeader(result: VerificationResult): List<String> = buildList {
        add("command: " + Verifications.item(result.label.ifEmpty { "(no label reported)" }))
        add("arguments (${result.argv.size}): " + result.argv.joinToString(" ") { Verifications.element(it) })
        add(
            "sandbox: " + (result.sandbox?.let(Verifications::item) ?: "not reported") +
                " · workspace mode: " + (result.workspaceMode?.let(Verifications::item) ?: "not reported"),
        )
        add("outcome: " + Verifications.outcomeLine(result))
        Verifications.disclosures(result).forEach { add(it) }
        add(
            "Output is shown as plain text: control characters are escaped (a carriage return reads \\r), " +
                "nothing in it is run, opened or followed.",
        )
    }
}
