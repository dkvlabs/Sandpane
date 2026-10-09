package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreMethods
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Every failure sentence a surface can show, pinned by PROVENANCE (AGENTS.md rule 5).
 *
 * The property this class exists to hold: "this plugin refused, nothing was sent" and "Core
 * answered with a verdict" must never collapse into the same wording — whichever future hop the
 * throwable arrives through (`whenComplete` hands over a [CompletionException] wrapper, a coroutine
 * hands over the exception itself). Pure string checks; no socket, no IDE.
 */
class ErrorAttributionTest {

    private val guard = CoreValidationException("projectId", "identifier is required")
    private val verdict = CoreRpcException(CoreErrorCodes.VALIDATION_FAILED, "projectId: value is empty")

    // ------------------------------------------------------------------
    // nothing-sent refusals
    // ------------------------------------------------------------------

    @Test
    fun guardRefusalSaysThisPluginRefusedAndNamesTheField() {
        val text = ErrorAttribution.describe(CoreMethods.TASK_LIST, guard)
        assertTrue(text.startsWith("${CoreMethods.TASK_LIST} — "), text)
        assertTrue(text.contains("refused by this plugin before anything was sent"), text)
        assertTrue(text.contains("guard on 'projectId'"), text)
        // The field prefix is folded into the sentence, not printed twice.
        assertFalse(text.contains("projectId: projectId"), text)
        assertTrue(ErrorAttribution.refusedLocally(guard))
        assertEquals("Sandpane: ${CoreMethods.TASK_LIST} not sent", ErrorAttribution.headline(CoreMethods.TASK_LIST, guard))
    }

    @Test
    fun noLocalRefusalEverInventsACoreErrorCode() {
        val refusals: List<Throwable> = listOf(
            guard,
            MethodNotSupportedException(CoreMethods.TASK_LIST, "its system.probe does not list it"),
            ReplayPausedException("replay of 3 task(s) passed the ceiling"),
            CoreTransportException("not connected"),
        )
        refusals.forEach { t ->
            val text = ErrorAttribution.describe(CoreMethods.TASK_LIST, t)
            assertFalse(
                Regex("""\b[A-Z][A-Z_0-9]{2,}\b""").containsMatchIn(text.removePrefix("${CoreMethods.TASK_LIST} — ")),
                "a never-sent request must not be described with a Core error code: $text",
            )
            assertTrue(ErrorAttribution.refusedLocally(t), "$t must be recognised as never sent")
        }
    }

    @Test
    fun unadvertisedMethodNamesTheMethodAndSaysNothingWasSent() {
        val text = ErrorAttribution.describe(
            CoreMethods.CONVERSATION_LIST,
            MethodNotSupportedException(CoreMethods.CONVERSATION_LIST, "its system.probe does not list it"),
        )
        assertTrue(text.contains("not sent by this plugin"), text)
        assertTrue(text.contains(CoreMethods.CONVERSATION_LIST), text)
    }

    @Test
    fun replayPauseQuotesCoresEarlierVerdictWithoutClaimingANewOne() {
        val earlier = "replay of 4096 task(s) passed the 4128152-byte ceiling"
        val text = ErrorAttribution.describe(CoreMethods.TASK_SUBSCRIBE, ReplayPausedException(earlier))
        assertTrue(text.contains("not sent by this plugin"), text)
        assertTrue(text.contains(earlier), "Core's earlier words are quoted, not softened: $text")
        assertTrue(
            text.contains("cannot converge"),
            "the reason the retry is withheld is stated: $text",
        )
    }

    // ------------------------------------------------------------------
    // Core's verdict
    // ------------------------------------------------------------------

    @Test
    fun coreVerdictIsAttributedToCoreAndCarriesItsCode() {
        val text = ErrorAttribution.describe(CoreMethods.TASK_LIST, verdict)
        assertTrue(text.contains("Core refused ${CoreErrorCodes.VALIDATION_FAILED}"), text)
        assertTrue(text.contains("projectId: value is empty"), "Core's wording stays verbatim: $text")
        assertFalse(ErrorAttribution.refusedLocally(verdict), "a verdict means Core did answer")
        assertEquals(
            "Sandpane: ${CoreMethods.TASK_LIST} refused by Core",
            ErrorAttribution.headline(CoreMethods.TASK_LIST, verdict),
        )
    }

    @Test
    fun anUnusableReplyIsNotAttributedToCoresJudgment() {
        // Core answered; the frame was unusable, so THIS plugin raised INTERNAL. It is not a verdict.
        val unusable = CoreRpcException("INTERNAL", "empty ok payload for ${CoreMethods.TASK_LIST}", raisedByCore = false)
        val text = ErrorAttribution.describe(CoreMethods.TASK_LIST, unusable)
        assertTrue(text.contains("raised by this plugin, not by Core"), text)
        assertFalse(text.contains("Core refused"), text)
        assertEquals(
            "Sandpane: ${CoreMethods.TASK_LIST} answer unusable",
            ErrorAttribution.headline(CoreMethods.TASK_LIST, unusable),
        )
    }

    // ------------------------------------------------------------------
    // the wrapper a UI handler actually receives
    // ------------------------------------------------------------------

    @Test
    fun completionAndExecutionWrappersAreUnwrapped() {
        listOf(CompletionException(verdict), ExecutionException(verdict)).forEach { wrapper ->
            val text = ErrorAttribution.describe(CoreMethods.TASK_LIST, wrapper)
            assertEquals(ErrorAttribution.describe(CoreMethods.TASK_LIST, verdict), text)
            assertFalse(text.contains("java.util.concurrent"), "no JDK class name in a UI sentence: $text")
            assertFalse(text.contains("CompletionException"), text)
        }
        assertEquals(verdict, ErrorAttribution.unwrap(CompletionException(ExecutionException(verdict))))
    }

    @Test
    fun theGuardSentenceIsNotTheVerdictSentence() {
        // The whole point, stated as one comparison: the two must never render alike.
        val local = ErrorAttribution.describe(CoreMethods.TASK_LIST, guard)
        val core = ErrorAttribution.describe(CoreMethods.TASK_LIST, verdict)
        assertFalse(local == core, "a guard refusal and a Core verdict cannot render the same")
        assertFalse(local.contains(CoreErrorCodes.VALIDATION_FAILED), local)
        assertTrue(core.contains(CoreErrorCodes.VALIDATION_FAILED), core)
    }

    // ------------------------------------------------------------------
    // wire-level and unknown failures
    // ------------------------------------------------------------------

    @Test
    fun transportFailureSaysNothingWasSent() {
        val text = ErrorAttribution.describe(CoreMethods.TASK_LIST, CoreTransportException("not connected"))
        assertTrue(text.contains("nothing was sent"), text)
    }

    @Test
    fun frameCapDescribesTheDropNotATruncation() {
        val text = ErrorAttribution.describe(CoreMethods.TASK_SUBSCRIBE, FrameExceedsCapException(4194304, 5000000))
        assertTrue(text.contains("4194304"), text)
        assertTrue(text.contains("5000000"), text)
        assertTrue(text.contains("dropped rather than truncated"), text)
    }

    @Test
    fun timeoutAssumesNoResult() {
        val text = ErrorAttribution.describe(CoreMethods.TASK_LIST, TimeoutException("waited 30000 ms"))
        assertTrue(text.contains("no result is assumed"), text)
    }

    @Test
    fun unknownFailuresStayNamedRatherThanBeingRelabelled() {
        val text = ErrorAttribution.describe(CoreMethods.TASK_LIST, IllegalStateException("socket went away"))
        assertTrue(text.contains("IllegalStateException"), "an unrecognised failure keeps its own name: $text")
        assertFalse(ErrorAttribution.refusedLocally(IllegalStateException("x")))
    }

    @Test
    fun anAnswerWithNeitherResultNorErrorIsStatedAsSuch() {
        assertTrue(ErrorAttribution.describe(null).contains("neither a result nor an error"))
        assertFalse(ErrorAttribution.refusedLocally(null))
    }
}
