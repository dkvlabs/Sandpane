package labs.dkv.sandpane.ui

import labs.dkv.sandpane.services.SandpaneContextProvider

/** The two dialogs of "Send context to Core" (StartTaskAction), separate so their layout is testable. */
object SendContextMessages {

    /**
     * Structured ([DialogHtml]) so a file name the agent chose (direct_mount) wraps only inside its
     * own value column and can never start a fake line at the left margin (security re-review W3).
     */
    fun preview(snapshot: SandpaneContextProvider.Snapshot): DialogHtml {
        val rows = buildList {
            snapshot.activeFile?.let { add("active file" to it) }
            add(
                "selection" to if (snapshot.hasSelection) {
                    "lines ${snapshot.selectionStartLine}–${snapshot.selectionEndLine} " +
                        "(${snapshot.selectionText?.length ?: 0} chars)"
                } else {
                    "none"
                },
            )
            snapshot.vcsRoot?.let { add("VCS root" to it) }
        }
        val html = DialogHtml().line("What Sandpane will send:").fields(*rows.toTypedArray())
        if (snapshot.truncated) html.line("(the selection is truncated to the context budget)")
        return html.line("Type the instruction for the agent:")
    }

    fun confirmation(
        snapshot: SandpaneContextProvider.Snapshot,
        instruction: String,
    ): DialogHtml {
        val rows = buildList {
            add("instruction" to instruction)
            snapshot.activeFile?.let { add("file" to it) }
            if (snapshot.hasSelection) {
                add("selection" to "${snapshot.selectionText?.length ?: 0} chars of ${snapshot.activeFile ?: "the file"}")
            }
        }
        return DialogHtml()
            .line("Send this to Sandpane Core?")
            .blank()
            .fields(*rows.toTypedArray())
            .blank()
            .line("Nothing is written to your repository: the agent works in its own sandbox, and any")
            .line("change comes back as a review you apply explicitly.")
    }
}
