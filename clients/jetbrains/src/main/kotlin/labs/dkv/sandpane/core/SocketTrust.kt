package labs.dkv.sandpane.core

import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path

/**
 * Pre-connect trust check for the Core socket file (security review W4).
 *
 * Before this plugin writes a single prompt byte to a Unix socket, it verifies that the path is
 *  1. a socket — not a symlink (checked with [LinkOption.NOFOLLOW_LINKS]), FIFO, or regular file,
 *  2. owned by the uid this IDE process runs as, and
 *  3. carries no group or other permission bits (`mode & 0o077 == 0`).
 *
 * That mirrors what `sandpane-service` itself sets at bind time (socket `0600`, parent directory
 * `0700`), so a socket that fails this check was not created by this user's Core — or was loosened
 * afterwards — and is refused instead of trusted.
 *
 * Read via the JDK's `unix:` attribute view (`unix:mode`, `unix:uid`), which the JDK provides on
 * Linux and macOS. A JVM without that view cannot verify anything and is refused, never trusted.
 *
 * Honest limit: this is a check-then-connect sequence, so it does not close a race against an
 * attacker who can swap the socket between the check and `connect()`. That attacker would need
 * write access to the socket's parent directory, which Core creates `0700`.
 */
object SocketTrust {

    sealed class Verdict {
        /** Socket, owned by us, no group/other bits. */
        data object Trusted : Verdict()

        /** Nothing at the path: Core is not up (yet). Ordinary retry/backoff applies. */
        data object Missing : Verdict()

        /** Something is there and must not be trusted. [reason] is user-facing. */
        data class Refused(val reason: String) : Verdict()
    }

    /** `S_IFMT` / `S_IFSOCK` from `<sys/stat.h>`; identical on Linux and macOS. */
    private const val S_IFMT = 0xF000 // 0o170000
    private const val S_IFSOCK = 0xC000 // 0o140000
    private const val GROUP_OTHER_BITS = 0x3F // 0o077

    /**
     * Pure decision over what the filesystem reports for [path], compared against [expectedUid].
     * Never follows a symlink: a link pointing at a good socket is still refused.
     */
    fun check(path: Path, expectedUid: Int): Verdict {
        val attributes: Map<String, Any?> = try {
            Files.readAttributes(path, "unix:mode,uid", LinkOption.NOFOLLOW_LINKS)
        } catch (_: NoSuchFileException) {
            return Verdict.Missing
        } catch (e: UnsupportedOperationException) {
            return Verdict.Refused(
                "this JVM cannot read unix:mode/uid for $path, so the socket's owner and permissions " +
                    "cannot be verified; refusing to connect",
            )
        } catch (e: IllegalArgumentException) {
            return Verdict.Refused(
                "this JVM has no unix attribute view for $path, so the socket's owner and permissions " +
                    "cannot be verified; refusing to connect",
            )
        } catch (e: Exception) {
            return Verdict.Refused("cannot read the attributes of $path (${e.message}); refusing to connect")
        }
        val mode = attributes["mode"] as? Int
            ?: return Verdict.Refused("no unix:mode reported for $path; refusing to connect")
        val uid = attributes["uid"] as? Int
            ?: return Verdict.Refused("no unix:uid reported for $path; refusing to connect")

        if (mode and S_IFMT != S_IFSOCK) {
            return Verdict.Refused(
                "$path is not a Unix socket (${describeType(mode)}); Sandpane only connects to the socket " +
                    "its own Core creates",
            )
        }
        if (uid != expectedUid) {
            return Verdict.Refused(
                "$path is owned by uid $uid, not by this IDE's user (uid $expectedUid); another account's " +
                    "socket is never trusted",
            )
        }
        if (mode and GROUP_OTHER_BITS != 0) {
            return Verdict.Refused(
                "$path has group/other permission bits (mode ${octal(mode and 0x1FF)}); Core creates it 0600, " +
                    "so a looser socket is refused. Restart the Core service or fix the permissions.",
            )
        }
        return Verdict.Trusted
    }

    /**
     * The uid this JVM runs as, read as `unix:uid` of a file this process just created (a new file
     * is owned by the creating process's effective uid). `null` when it cannot be determined, which
     * callers must treat as "cannot verify" — never as a pass. Only a SUCCESSFUL lookup is cached
     * (review suggestion 3): a transient failure (temp dir full, unwritable) is retried on the next
     * connect instead of disabling the plugin until the IDE restarts.
     */
    val currentUid: Int?
        get() = cachedUid ?: lookupUid()?.also { cachedUid = it }

    @Volatile
    private var cachedUid: Int? = null

    private fun lookupUid(): Int? = runCatching {
        val probe = Files.createTempFile("sandpane-uid", ".probe")
        try {
            Files.getAttribute(probe, "unix:uid", LinkOption.NOFOLLOW_LINKS) as? Int
        } finally {
            Files.deleteIfExists(probe)
        }
    }.getOrNull()

    /** [check] against [currentUid]; refuses when the current uid is unknown. */
    fun checkForCurrentUser(path: Path): Verdict {
        val uid = currentUid
            ?: return Verdict.Refused(
                "cannot determine this IDE process's uid, so the owner of $path cannot be verified; " +
                    "refusing to connect",
            )
        return check(path, uid)
    }

    private fun describeType(mode: Int): String = when (mode and S_IFMT) {
        0x8000 -> "a regular file"
        0x4000 -> "a directory"
        0xA000 -> "a symbolic link"
        0x1000 -> "a FIFO"
        0x2000, 0x6000 -> "a device node"
        else -> "file type ${octal(mode and S_IFMT)}"
    }

    private fun octal(value: Int): String = "0" + Integer.toOctalString(value)
}
