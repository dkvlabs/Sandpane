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
    fun aVanishedSelectionFallsBackToCoresFirstAndNoneWhenEmpty() {
        val a = conv("conv-a")
        assertEquals(a, ConversationSelection.choose("gone", listOf(a)))
        assertNull(ConversationSelection.choose("gone", emptyList()))
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
        assertEquals(a, outcome.choice)
        assertEquals("conv-gone", outcome.vanishedId)
    }
}
