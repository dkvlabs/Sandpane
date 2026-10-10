package labs.dkv.sandpane.services

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Review I5: a missing sandbox list must say WHY — a failed refresh is not "not read yet". */
class SnapshotGapTest {

    @Test
    fun neverReadIsSaidAsSuch() {
        val gap = SbxService.Snapshot(null, null, 0, null).sandboxListGap()
        assertEquals("Core's sandbox list has not been read in this window yet", gap)
    }

    @Test
    fun aFailedRefreshIsNamedWithItsRevealedReason() {
        val gap = SbxService.Snapshot(null, null, 1, "sandbox.list — Core refused DAEMON_DOWN: down\nfake")
            .sandboxListGap()!!
        assertTrue(gap.startsWith("the last refresh failed: "), gap)
        assertTrue(gap.contains("DAEMON_DOWN"), gap)
        assertFalse(gap.contains('\n'), "the reason is revealed single-line")
        assertFalse(gap.contains("has not been read"), gap)
    }

    @Test
    fun aListedSnapshotHasNoGap() {
        assertNull(SbxService.Snapshot(null, emptyList(), 1, null).sandboxListGap())
    }
}
