package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.AgentEvent
import labs.dkv.sandpane.model.AgentEventCodec
import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.ContextRef
import labs.dkv.sandpane.model.ContextRefKind
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.MAX_FRAME_BYTES
import labs.dkv.sandpane.model.PROTOCOL_VERSION
import labs.dkv.sandpane.model.RpcRequest
import labs.dkv.sandpane.model.RpcResponseFrame
import labs.dkv.sandpane.model.SandboxCreateSpec
import labs.dkv.sandpane.model.TaskStatus
import labs.dkv.sandpane.model.WorkspaceMode
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * NDJSON framing + wire-name parity tests.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │ STATUS: UNRUN. This host has no Gradle-resolvable IntelliJ Platform artifact │
 * │ and no Kotlin compiler, so nothing here was executed. It is written so JB0   │
 * │ can run `./gradlew test` as the first proof of the transport.                │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * Covered offline (pure functions, no IDE and no socket):
 *   - frame splitting, multi-byte UTF-8 reassembly, and the MAX_FRAME_BYTES refusal;
 *   - request/response field names and the serde `ok`/`err` outcome shape;
 *   - every snake_case / SCREAMING_SNAKE / camelCase wire name mirrored from
 *     core/crates/sandpane-protocol/src/lib.rs.
 *
 * NOT covered here, on purpose: a live socket round trip. `SocketChannel` against
 * `UnixDomainSocketAddress` needs a running Sandpane Core (and AF_UNIX at runtime), so it is
 * an integration test for JB0 against the real service — faking it with an in-JVM mock would
 * be a mocked integration presented as real (AGENTS.md rule 5).
 */
class CoreClientFramingTest {

    private fun nl(): ByteArray = byteArrayOf(CoreClient.NEWLINE)

    private fun frame(body: String): ByteArray = body.encodeToByteArray() + nl()

    @Test
    fun framerEmitsOnlyCompleteLines() {
        val framer = NdjsonFramer()
        val first = """{"v":1,"id":"a","method":"system.probe"}"""
        val second = """{"v":1,"id":"b","method":"project.list"}"""

        val emitted = framer.feed(frame(first) + frame(second))
        assertEquals(listOf(first, second), emitted)
        assertEquals(0, framer.pendingBytes)
    }

    @Test
    fun framerHoldsAPartialFrameUntilItsDelimiter() {
        val framer = NdjsonFramer()
        val full = """{"v":1,"id":"c","method":"sandbox.list"}"""
        val bytes = full.encodeToByteArray()

        val head = framer.feed(bytes, 0, bytes.size / 2)
        assertTrue(head.isEmpty(), "no line may be emitted before the delimiter")
        assertTrue(framer.pendingBytes > 0)

        val tail = bytes.copyOfRange(bytes.size / 2, bytes.size) + nl()
        val rest = framer.feed(tail)
        assertEquals(listOf(full), rest)
        assertEquals(0, framer.pendingBytes)
    }

    @Test
    fun framerReassemblesUtf8SplitAcrossChunks() {
        // Non-ASCII payload (as in the Rust round-trip test) fed one byte at a time. A
        // continuation byte can never equal 0x0A, so the delimiter stays unambiguous.
        val payload = """{"text":"he…llo ünïcode"}"""
        val bytes = frame(payload)
        val framer = NdjsonFramer()
        val collected = ArrayList<String>()
        for (i in bytes.indices) {
            collected += framer.feed(bytes.copyOfRange(i, i + 1))
        }
        assertEquals(listOf(payload), collected)
    }

    @Test
    fun framerRefusesToBufferBeyondTheCap() {
        val cap = 16
        val framer = NdjsonFramer(cap)
        val error = assertFailsWith<FrameExceedsCapException> {
            framer.feed(ByteArray(cap + 1))
        }
        assertTrue(error.message!!.contains(cap.toString()))
    }

    @Test
    fun defaultFramerEnforcesTheServiceCap() {
        val framer = NdjsonFramer()
        assertFailsWith<FrameExceedsCapException> {
            framer.feed(ByteArray(MAX_FRAME_BYTES + 1))
        }
    }

    @Test
    fun requestFrameCarriesExactlyTheRustFieldNames() {
        val hostile = "hi; rm -rf /"
        val params = buildJsonObject {
            put("conversationId", "c1")
            put("content", hostile)
            put("attachments", JsonArray(emptyList()))
        }
        val wire = CoreJson.encodeToString(
            RpcRequest.serializer(),
            RpcRequest(v = PROTOCOL_VERSION, id = "req-1", method = CoreMethods.CONVERSATION_SEND, params = params),
        )
        val parsed = CoreJson.parseToJsonElement(wire) as JsonObject

        assertEquals(setOf("v", "id", "method", "params"), parsed.keys)
        assertEquals(PROTOCOL_VERSION.toString(), parsed["v"]!!.jsonPrimitive.content)
        assertEquals("req-1", parsed["id"]!!.jsonPrimitive.content)
        assertEquals(CoreMethods.CONVERSATION_SEND, parsed["method"]!!.jsonPrimitive.content)
        // Content is inert data, never a command.
        assertEquals(hostile, (parsed["params"] as JsonObject)["content"]!!.jsonPrimitive.content)
    }

    @Test
    fun responseOutcomeIsFlattenedOkOrErr() {
        val ok = CoreJson.decodeFromString(
            RpcResponseFrame.serializer(),
            """{"v":1,"id":"7","ok":{"taskId":"t1"}}""",
        )
        assertEquals("7", ok.id)
        assertFalse(ok.isError)
        assertNotNull(ok.ok)

        val err = CoreJson.decodeFromString(
            RpcResponseFrame.serializer(),
            """{"v":1,"id":"8","err":{"code":"NOT_INSTALLED","message":"sbx not found"}}""",
        )
        assertTrue(err.isError)
        assertEquals(CoreErrorCodes.NOT_INSTALLED, err.err?.code)
        assertEquals(null, err.err?.details)
    }

    @Test
    fun uncorrelatedFrameHasEmptyIdAndIsNotDropped() {
        val frameText = """{"v":1,"id":"","err":{"code":"VALIDATION_FAILED","message":"malformed frame"}}"""
        val decoded = CoreJson.decodeFromString(RpcResponseFrame.serializer(), frameText)
        assertEquals("", decoded.id)
        assertEquals(CoreErrorCodes.VALIDATION_FAILED, decoded.err?.code)
    }

    @Test
    fun allowlistRejectsFreeFormExecution() {
        assertTrue(CoreMethods.isAllowlisted("task.subscribe"))
        assertFalse(CoreMethods.isAllowlisted("shell.exec"))
        assertFalse(CoreMethods.isAllowlisted("system.probe; ls"))
        assertEquals(11, CoreMethods.ALL.size)
    }

    // -----------------------------------------------------------------------
    // wire-name parity with sandpane-protocol
    // -----------------------------------------------------------------------

    @Test
    fun taskStatusNamesAreSnakeCase() {
        for ((value, expected) in mapOf(
            TaskStatus.CREATED to "created",
            TaskStatus.QUEUED to "queued",
            TaskStatus.PREPARING to "preparing",
            TaskStatus.RUNNING to "running",
            TaskStatus.VERIFYING to "verifying",
            TaskStatus.AWAITING_INPUT to "awaiting_input",
            TaskStatus.AWAITING_REVIEW to "awaiting_review",
            TaskStatus.COMPLETED to "completed",
            TaskStatus.REJECTED to "rejected",
            TaskStatus.FAILED to "failed",
            TaskStatus.CANCELLED to "cancelled",
            TaskStatus.INTERRUPTED to "interrupted",
        )) {
            assertEquals("\"$expected\"", CoreJson.encodeToString(TaskStatus.serializer(), value))
        }
    }

    @Test
    fun workspaceModeNamesAreSnakeCase() {
        assertEquals("\"direct_mount\"", CoreJson.encodeToString(WorkspaceMode.serializer(), WorkspaceMode.DIRECT_MOUNT))
        assertEquals("\"sbx_clone\"", CoreJson.encodeToString(WorkspaceMode.serializer(), WorkspaceMode.SBX_CLONE))
        assertEquals("\"host_worktree\"", CoreJson.encodeToString(WorkspaceMode.serializer(), WorkspaceMode.HOST_WORKTREE))
        assertEquals("\"mountless\"", CoreJson.encodeToString(WorkspaceMode.serializer(), WorkspaceMode.MOUNTLESS))
        assertTrue(WorkspaceMode.DIRECT_MOUNT.isLiveWritable)
    }

    @Test
    fun fileChangeAndContextRefNames() {
        for ((value, expected) in mapOf(
            FileChangeStatus.ADDED to "added",
            FileChangeStatus.MODIFIED to "modified",
            FileChangeStatus.DELETED to "deleted",
            FileChangeStatus.RENAMED to "renamed",
            FileChangeStatus.UNTRACKED to "untracked",
        )) {
            assertEquals("\"$expected\"", CoreJson.encodeToString(FileChangeStatus.serializer(), value))
        }
        for ((value, expected) in mapOf(
            ContextRefKind.FILE to "file",
            ContextRefKind.SELECTION to "selection",
            ContextRefKind.DIAGNOSTICS to "diagnostics",
            ContextRefKind.DIFF_RANGE to "diff_range",
        )) {
            assertEquals("\"$expected\"", CoreJson.encodeToString(ContextRefKind.serializer(), value))
        }
    }

    @Test
    fun camelCasePayloadNames() {
        val specWire = CoreJson.encodeToString(
            SandboxCreateSpec.serializer(),
            SandboxCreateSpec(name = "atlas-auth", projectId = "p1", workspaceMode = WorkspaceMode.SBX_CLONE),
        )
        val spec = CoreJson.parseToJsonElement(specWire) as JsonObject
        assertEquals(setOf("name", "projectId", "workspaceMode"), spec.keys)

        val changeSetWire = CoreJson.encodeToString(
            ChangeSet.serializer(),
            ChangeSet(
                taskId = "t1",
                baseCommit = "abc123",
                hostDirty = true,
                changes = listOf(FileChange(path = "src/main.rs", status = FileChangeStatus.MODIFIED)),
            ),
        )
        val changeSet = CoreJson.parseToJsonElement(changeSetWire) as JsonObject
        assertEquals(setOf("taskId", "baseCommit", "hostDirty", "changes"), changeSet.keys)

        val ref = CoreJson.encodeToString(
            ContextRef.serializer(),
            ContextRef(kind = ContextRefKind.FILE, target = "/repo/src/main.rs"),
        )
        assertEquals(setOf("kind", "target"), (CoreJson.parseToJsonElement(ref) as JsonObject).keys)
    }

    @Test
    fun errorCodesAreScreamingSnake() {
        assertEquals(10, CoreErrorCodes.ALL.size)
        assertTrue(CoreErrorCodes.isKnown("UNSUPPORTED_SBX_VERSION"))
        assertTrue(CoreErrorCodes.isKnown("TASK_INTERRUPTED"))
        assertTrue(CoreErrorCodes.isKnown("NOT_FOUND"))
        assertFalse(CoreErrorCodes.isKnown("SHELL_EXITED"))
    }

    // -----------------------------------------------------------------------
    // agent event discriminator
    // -----------------------------------------------------------------------

    @Test
    fun messageDeltaMatchesTheDocumentedWireShape() {
        val event = AgentEventCodec.decode(CoreJson.parseToJsonElement("""{"type":"message.delta","text":"x"}"""))
        assertEquals(AgentEvent.MessageDelta("x"), event)
    }

    @Test
    fun approvalRequiredUsesRequestId() {
        val event = AgentEventCodec.decode(
            CoreJson.parseToJsonElement("""{"type":"approval.required","requestId":"a1","description":"run tests"}"""),
        )
        assertEquals(AgentEvent.ApprovalRequired("a1", "run tests"), event)
    }

    @Test
    fun unsupportedEventAcceptsBothSpellings() {
        // `providerType` is canonical: lib.rs now renames the field explicitly and pins it in a
        // Rust test, matching schemas/agent-event.schema.json. `provider_type` is accepted only
        // as tolerance for an older Core that predates that fix — delete it when the minimum
        // supported Core build is newer than the fix.
        val rustSpelling = AgentEventCodec.decode(
            CoreJson.parseToJsonElement("""{"type":"unsupported.event","provider_type":"codex.weird"}"""),
        )
        val schemaSpelling = AgentEventCodec.decode(
            CoreJson.parseToJsonElement("""{"type":"unsupported.event","providerType":"codex.weird"}"""),
        )
        assertEquals(AgentEvent.UnsupportedEvent("codex.weird"), rustSpelling)
        assertEquals(AgentEvent.UnsupportedEvent("codex.weird"), schemaSpelling)
    }

    @Test
    fun unknownShapesBecomeVisibleMalformedRowsNotExceptions() {
        val unknownDiscriminator = AgentEventCodec.decode(CoreJson.parseToJsonElement("""{"type":"future.event"}"""))
        assertTrue(unknownDiscriminator is AgentEvent.Malformed)

        val missingField = AgentEventCodec.decode(CoreJson.parseToJsonElement("""{"type":"file.changed"}"""))
        assertTrue(missingField is AgentEvent.Malformed)

        val notAnObject = AgentEventCodec.decode(CoreJson.parseToJsonElement("""[]"""))
        assertTrue(notAnObject is AgentEvent.Malformed)

        val unknownCode = AgentEventCodec.decode(
            CoreJson.parseToJsonElement("""{"type":"error","code":"SOMETHING_NEW","message":"m"}"""),
        )
        assertTrue(unknownCode is AgentEvent.Malformed)
    }

    @Test
    fun toolEventsDecodeTheirFields() {
        assertEquals(
            AgentEvent.ToolStarted("read_file", "t1"),
            AgentEventCodec.decode(CoreJson.parseToJsonElement("""{"type":"tool.started","name":"read_file","id":"t1"}""")),
        )
        assertEquals(
            AgentEvent.ToolFinished("t1", true, null),
            AgentEventCodec.decode(CoreJson.parseToJsonElement("""{"type":"tool.finished","id":"t1","ok":true}""")),
        )
        assertEquals(
            AgentEvent.TaskCompleted(false),
            AgentEventCodec.decode(CoreJson.parseToJsonElement("""{"type":"task.completed","ok":false}""")),
        )
    }
}
