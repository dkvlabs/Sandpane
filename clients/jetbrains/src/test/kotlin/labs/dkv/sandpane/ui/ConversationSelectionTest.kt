package labs.dkv.sandpane.ui

import labs.dkv.sandpane.model.Conversation
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Review bug 3: picker selection, transcript and Send target stay the same conversation. */
class ConversationSelectionTest {

    private fun conv(id: String, title: String = "") =
        Conversation(id = id, projectId = "p", title = title, agentId = "codex", createdAt = "2026-10-09T00:00:00Z")

    @Test
    fun aRefreshKeepsTheSelectionByIdEvenWhenItIsNotFirst() {
        val a = conv("conv-a")
        val b = conv("conv-b")
        assertEquals(b, ConversationSelection.choose("conv-b", listOf(a, b)))
    }

    @Test
    fun aVanishedSelectionSelectsNothingNeverAnotherConversation() {
        val a = conv("conv-a")
        // A3b review W1: the Send target never silently moves to a conversation the user did not pick.
        assertNull(ConversationSelection.choose("gone", listOf(a)))
        assertNull(ConversationSelection.choose("gone", emptyList()))
        // Only the initial load (no previous selection) may pick Core's first conversation.
        assertEquals(a, ConversationSelection.choose(null, listOf(a)))
        assertNull(ConversationSelection.choose(null, emptyList()))
    }

    @Test
    fun theTranscriptIsReloadedWheneverItShowsSomethingElse() {
        assertTrue(ConversationSelection.transcriptOutOfSync("conv-a", "conv-b"))
        assertTrue(ConversationSelection.transcriptOutOfSync(null, "conv-b"), "nothing selected must clear it")
        assertTrue(ConversationSelection.transcriptOutOfSync("conv-a", null))
        assertFalse(ConversationSelection.transcriptOutOfSync("conv-a", "conv-a"))
        assertFalse(ConversationSelection.transcriptOutOfSync(null, null))
    }

    @Test
    fun theSendTargetLineNamesTheSelectedConversation() {
        assertEquals("→ Auth (conv-abc)", ConversationSelection.targetLine(conv("conv-abcdef", "Auth")))
        assertEquals("→ conv-abc (conv-abc)", ConversationSelection.targetLine(conv("conv-abcdef")))
        assertEquals("→ no conversation selected", ConversationSelection.targetLine(null))
    }
}

/** Review W2: the answer is applied against the selection and project as they are on arrival. */
class ConversationReconcileTest {

    private fun conv(id: String) =
        Conversation(id = id, projectId = "p", title = "", agentId = "codex", createdAt = "2026-10-09T00:00:00Z")

    @Test
    fun aPickMadeWhileTheRequestWasInFlightWins() {
        val a = conv("conv-a")
        val b = conv("conv-b")
        // Request left with A selected; the user picked B before the answer arrived.
        val outcome = ConversationSelection.reconcile("conv-b", "p1", "p1", listOf(a, b))
        assertEquals(b, outcome.choice)
        assertNull(outcome.vanishedId)
    }

    @Test
    fun aProjectSwitchNeitherKeepsNorReportsTheOldProjectsSelection() {
        val x = conv("conv-x")
        val outcome = ConversationSelection.reconcile("conv-from-p1", "p1", "p2", listOf(x))
        assertEquals(x, outcome.choice)
        assertNull(outcome.vanishedId, "another project's chat did not 'vanish' from this one")
    }

    @Test
    fun aChatCoreStoppedListingInTheSameProjectIsReported() {
        val a = conv("conv-a")
        val outcome = ConversationSelection.reconcile("conv-gone", "p1", "p1", listOf(a))
        assertNull(outcome.choice, "nothing is selected; another conversation is never substituted")
        assertEquals("conv-gone", outcome.vanishedId)
    }

    /**
     * A3b review W1: archive the open conversation with "Show archived" off. The re-read omits it;
     * the picker must select NOTHING (and stay so on later refreshes) and the composer must say to
     * select a conversation — the next message can never go to a conversation the user did not pick.
     */
    @Test
    fun theSendTargetNeverMovesToAConversationTheUserDidNotPick() {
        val archivedOne = conv("conv-a")
        val other = conv("conv-b")
        // Initial load of p1: Core's first conversation is shown (no previous selection).
        assertEquals(archivedOne, ConversationSelection.reconcile(null, null, "p1", listOf(archivedOne, other)).choice)
        // The user archived conv-a; the re-read (archived hidden) lists only conv-b.
        val afterArchive = ConversationSelection.reconcile("conv-a", "p1", "p1", listOf(other))
        assertNull(afterArchive.choice)
        assertEquals("conv-a", afterArchive.vanishedId)
        // Any later refresh of the same project keeps nothing selected until the user picks.
        val later = ConversationSelection.reconcile(null, "p1", "p1", listOf(other))
        assertNull(later.choice)
        assertNull(later.vanishedId)
        // With nothing selected the composer is blocked, saying what to do.
        val blocker = labs.dkv.sandpane.core.ConversationUiState.composerBlocker(null)
        assertTrue(blocker != null && blocker.contains("select a conversation to continue"), blocker.toString())
        assertEquals("→ no conversation selected", ConversationSelection.targetLine(later.choice))
        // The user's own pick is kept on refresh.
        assertEquals(other, ConversationSelection.reconcile("conv-b", "p1", "p1", listOf(other)).choice)
        // A different project is a new initial load.
        assertEquals(other, ConversationSelection.reconcile(null, "p1", "p2", listOf(other)).choice)
    }
}
