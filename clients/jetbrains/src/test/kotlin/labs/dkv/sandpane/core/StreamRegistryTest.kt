package labs.dkv.sandpane.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Review bug 4: one window releasing a task must not end another window's stream. */
class StreamRegistryTest {

    @Test
    fun holdersShareOneStreamAndOnlyTheLastReleaseRemovesIt() {
        val registry = StreamRegistry { 100 }
        val a = registry.acquire("t")
        val b = registry.acquire("t")
        assertTrue(a.created)
        assertFalse(b.created)
        assertSame(a.stream, b.stream)

        assertFalse(registry.release("t"), "first release leaves the other holder's stream alive")
        assertTrue(registry.isLive(a.stream))
        assertTrue(registry.release("t"), "last release removes it")
        assertFalse(registry.isLive(a.stream))
    }

    @Test
    fun releasingAnUnknownTaskIsANoOpNotAnUnderflow() {
        val registry = StreamRegistry { 100 }
        assertFalse(registry.release("never"))
        val first = registry.acquire("never")
        assertEquals(1, registry.referenceCount("never"))
        assertTrue(first.created)
    }

    @Test
    fun aReacquiredTaskGetsAFreshStreamAndTheOldPollChainIsNotLive() {
        val registry = StreamRegistry { 100 }
        val old = registry.acquire("t").stream
        registry.release("t")
        val fresh = registry.acquire("t").stream
        assertFalse(registry.isLive(old), "a stale poll chain must stop instead of double-polling")
        assertTrue(registry.isLive(fresh))
    }
}
