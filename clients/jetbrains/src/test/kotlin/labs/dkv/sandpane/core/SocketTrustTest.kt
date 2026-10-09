package labs.dkv.sandpane.core

import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.ServerSocketChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * W4: the socket file is trusted only when it is a socket, owned by this uid, with no group/other
 * bits. Real files and real bound sockets in a short temp directory — nothing is mocked.
 */
class SocketTrustTest {

    private lateinit var dir: Path
    private val servers = ArrayList<ServerSocketChannel>()

    @BeforeTest
    fun setUp() {
        // Short base path: macOS caps sun_path at 104 bytes.
        dir = Files.createTempDirectory(Path.of("/tmp"), "spt")
    }

    @AfterTest
    fun tearDown() {
        servers.forEach { runCatching { it.close() } }
        dir.toFile().deleteRecursively()
    }

    private fun uid(): Int = assertNotNull(SocketTrust.currentUid, "the test JVM must expose unix:uid")

    private fun boundSocket(name: String, perms: String): Path {
        val path = dir.resolve(name)
        val server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)
        server.bind(UnixDomainSocketAddress.of(path))
        servers += server
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(perms))
        return path
    }

    @Test
    fun ownedSocketWithMode0600IsTrusted() {
        val socket = boundSocket("ok.sock", "rw-------")
        assertEquals(SocketTrust.Verdict.Trusted, SocketTrust.check(socket, uid()))
        assertEquals(SocketTrust.Verdict.Trusted, SocketTrust.checkForCurrentUser(socket))
    }

    @Test
    fun missingPathIsMissingNotRefused() {
        assertEquals(SocketTrust.Verdict.Missing, SocketTrust.check(dir.resolve("absent.sock"), uid()))
    }

    @Test
    fun regularFileIsRefused() {
        val file = dir.resolve("plain.sock")
        Files.writeString(file, "not a socket")
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"))
        val verdict = assertIs<SocketTrust.Verdict.Refused>(SocketTrust.check(file, uid()))
        assertTrue(verdict.reason.contains("not a Unix socket"), verdict.reason)
        assertTrue(verdict.reason.contains("regular file"), verdict.reason)
    }

    @Test
    fun groupWritableSocketIsRefused() {
        val socket = boundSocket("g.sock", "rw-rw----")
        val verdict = assertIs<SocketTrust.Verdict.Refused>(SocketTrust.check(socket, uid()))
        assertTrue(verdict.reason.contains("group/other"), verdict.reason)
        assertTrue(verdict.reason.contains("0660"), verdict.reason)
    }

    @Test
    fun otherReadableSocketIsRefused() {
        val socket = boundSocket("o.sock", "rw----r--")
        val verdict = assertIs<SocketTrust.Verdict.Refused>(SocketTrust.check(socket, uid()))
        assertTrue(verdict.reason.contains("0604"), verdict.reason)
    }

    @Test
    fun symlinkToATrustedSocketIsStillRefused() {
        val target = boundSocket("real.sock", "rw-------")
        val link = Files.createSymbolicLink(dir.resolve("link.sock"), target)
        val verdict = assertIs<SocketTrust.Verdict.Refused>(SocketTrust.check(link, uid()))
        assertTrue(verdict.reason.contains("symbolic link"), verdict.reason)
    }

    @Test
    fun socketOwnedBySomeoneElseIsRefused() {
        val socket = boundSocket("u.sock", "rw-------")
        val verdict = assertIs<SocketTrust.Verdict.Refused>(SocketTrust.check(socket, uid() + 1))
        assertTrue(verdict.reason.contains("owned by uid"), verdict.reason)
    }
}
