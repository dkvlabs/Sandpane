package labs.dkv.sandpane.core

import labs.dkv.sandpane.model.AgentEvent
import labs.dkv.sandpane.model.AgentEventCodec
import labs.dkv.sandpane.model.ChangeSet
import labs.dkv.sandpane.model.ContextRef
import labs.dkv.sandpane.model.ContextRefKind
import labs.dkv.sandpane.model.ConversationHistoryParams
import labs.dkv.sandpane.model.ConversationHistoryResult
import labs.dkv.sandpane.model.CoreCapabilities
import labs.dkv.sandpane.model.CoreErrorCodes
import labs.dkv.sandpane.model.CoreJson
import labs.dkv.sandpane.model.CoreMethods
import labs.dkv.sandpane.model.DEFAULT_LIST_LIMIT
import labs.dkv.sandpane.model.FileChange
import labs.dkv.sandpane.model.FileChangeStatus
import labs.dkv.sandpane.model.MAX_CURSOR_KEY_LEN
import labs.dkv.sandpane.model.MAX_FRAME_BYTES
import labs.dkv.sandpane.model.MAX_HISTORY_BYTES
import labs.dkv.sandpane.model.MAX_LIST_LIMIT
import labs.dkv.sandpane.model.MAX_SCOPING_ID_LEN
import labs.dkv.sandpane.model.MAX_SUBSCRIBE_BYTES
import labs.dkv.sandpane.model.MAX_SUBSCRIBE_CURSORS
import labs.dkv.sandpane.model.PROTOCOL_VERSION
import labs.dkv.sandpane.model.Project
import labs.dkv.sandpane.model.RpcRequest
import labs.dkv.sandpane.model.RpcResponseFrame
import labs.dkv.sandpane.model.SandboxCreateSpec
import labs.dkv.sandpane.model.SandboxSummary
import labs.dkv.sandpane.model.TaskListParams
import labs.dkv.sandpane.model.TaskStatus
import labs.dkv.sandpane.model.TaskSubscribeParams
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
 * │ STATUS: RUN on 09.10.2026 by `./gradlew test` — Gradle wrapper 8.10.2, the   │
 * │ IntelliJ Community 2024.2.4 platform artifact, Kotlin 2.0.21, JDK toolchain 17.│
 * │ These are pure-function tests: no IDE instance and no socket is started, and │
 * │ `runIde` / Plugin Verifier have STILL never run (see README's JB0 table).     │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * Covered here (pure functions, no IDE and no socket):
 *   - frame splitting, multi-byte UTF-8 reassembly, and the MAX_FRAME_BYTES refusal;
 *   - request/response field names and the serde `ok`/`err` outcome shape;
 *   - every snake_case / SCREAMING_SNAKE / camelCase wire name mirrored from
 *     core/crates/sandpane-protocol/src/lib.rs;
 *   - the protocol-v1 additive fields: an OLD frame parses, and an absent value stays absent on
 *     the way out instead of becoming `null`, `{}`, or a benign workspace mode;
 *   - the 14-method allowlist in `Method::ALL` order (the Rust source itself is re-read and
 *     compared by [ProtocolDriftGuardTest]).
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
        // The three additive protocol-v1 methods are allowlisted now; they were refused before.
        assertTrue(CoreMethods.isAllowlisted("task.list"))
        assertTrue(CoreMethods.isAllowlisted("conversation.list"))
        assertTrue(CoreMethods.isAllowlisted("conversation.history"))
        assertFalse(CoreMethods.isAllowlisted("shell.exec"))
        assertFalse(CoreMethods.isAllowlisted("system.probe; ls"))
        assertFalse(CoreMethods.isAllowlisted("task.subscribe "))
        assertEquals(14, CoreMethods.ALL.size)
    }

    @Test
    fun methodListIsInRustMethodAllOrder() {
        // `CoreCapabilities.methods` is derived from `Method::ALL` in Rust, in that order; this
        // list is the client mirror of it. [ProtocolDriftGuardTest] re-reads the Rust source and
        // fails if this order or any name stops matching, so a rename cannot drift silently.
        assertEquals(
            listOf(
                "system.probe", "project.create", "project.list", "sandbox.list", "sandbox.create",
                "conversation.create", "conversation.send", "conversation.list", "conversation.history",
                "task.cancel", "task.list", "task.subscribe", "git.review", "git.apply",
            ),
            CoreMethods.ALL,
        )
        assertEquals(3, CoreMethods.ADDITIVE_IN_V1.size)
        assertTrue(CoreMethods.ADDITIVE_IN_V1.containsAll(setOf("task.list", "conversation.list", "conversation.history")))
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

    // -----------------------------------------------------------------------
    // protocol-v1 additive fields — a response from an OLDER Core must still parse
    // -----------------------------------------------------------------------

    @Test
    fun preRevisionFramesStillDeserialize() {
        // Mirrors the Rust test `additive_fields_deserialize_from_pre_revision_wire`: every field
        // this revision added carries a serde default, so absence — not a crash, not a guess — is
        // what an old Core produces on this side too.
        val oldProject = CoreJson.decodeFromString(
            Project.serializer(),
            """{"id":"p1","name":"Atlas Demo","description":"","createdAt":"t"}""",
        )
        assertEquals(emptyList<String>(), oldProject.repositories)

        val oldSandbox = CoreJson.decodeFromString(
            SandboxSummary.serializer(),
            """{"name":"atlas-auth","probedState":"running","boundProjectId":null}""",
        )
        // Absent, NOT defaulted to a benign mode: an unverified mount is host-writable until Core
        // says otherwise (docs/specs/02 §7).
        assertEquals(null, oldSandbox.workspaceMode)

        val oldCaps = CoreJson.decodeFromString(
            CoreCapabilities.serializer(),
            """{"protocolVersion":1,"coreVersion":"0.1.0","instanceId":"i","sbx":null,"agents":[],"platform":"macos"}""",
        )
        assertEquals(emptyList<String>(), oldCaps.methods)
        assertFalse(oldCaps.advertises("task.list"))

        val oldSubscribe = CoreJson.decodeFromString(
            TaskSubscribeParams.serializer(),
            """{"projectId":"p1","afterSequence":3}""",
        )
        assertEquals(null, oldSubscribe.afterSequences)
        assertEquals(3L, oldSubscribe.afterSequence)
    }

    @Test
    fun additiveFieldsAreOmittedWhenAbsent() {
        // serde uses `skip_serializing_if` on `workspaceMode`; the Kotlin side keeps the same
        // shape through CoreJson's explicitNulls=false, so an absent mode never becomes `null` on
        // the wire either.
        val summary = CoreJson.encodeToString(
            SandboxSummary.serializer(),
            SandboxSummary(name = "atlas-auth", probedState = "running", boundProjectId = null),
        )
        assertFalse(summary.contains("workspaceMode"), "absent mode must stay absent: $summary")

        val subscribe = CoreJson.encodeToString(
            TaskSubscribeParams.serializer(),
            TaskSubscribeParams(projectId = "p1", afterSequence = 4),
        )
        assertFalse(subscribe.contains("afterSequences"), "absent map must stay absent: $subscribe")
    }

    @Test
    fun projectRepositoriesAndSandboxWorkspaceModeWireNames() {
        val project = CoreJson.encodeToString(
            Project.serializer(),
            Project(
                id = "p1",
                name = "Atlas Demo",
                description = "",
                createdAt = "t",
                repositories = listOf("/repos/atlas"),
            ),
        )
        val projectJson = CoreJson.parseToJsonElement(project) as JsonObject
        assertEquals("p1", projectJson["id"]!!.jsonPrimitive.content)
        assertEquals("t", projectJson["createdAt"]!!.jsonPrimitive.content)
        assertEquals("/repos/atlas", (projectJson["repositories"] as JsonArray)[0].jsonPrimitive.content)

        val summary = CoreJson.encodeToString(
            SandboxSummary.serializer(),
            SandboxSummary(
                name = "atlas-auth",
                probedState = "running",
                boundProjectId = "p1",
                workspaceMode = WorkspaceMode.DIRECT_MOUNT,
            ),
        )
        // The mode reuses the established snake_case enum names, under a camelCase KEY.
        assertEquals("direct_mount", (CoreJson.parseToJsonElement(summary) as JsonObject)["workspaceMode"]!!.jsonPrimitive.content)
    }

    @Test
    fun perTaskCursorMapWireShape() {
        val params = TaskSubscribeParams(
            projectId = "p1",
            taskId = null,
            afterSequence = 0,
            afterSequences = linkedMapOf("task-a" to 5L, "task-b" to 2L),
        )
        val json = CoreJson.parseToJsonElement(CoreJson.encodeToString(TaskSubscribeParams.serializer(), params)) as JsonObject
        assertEquals(5L, (json["afterSequences"] as JsonObject)["task-a"]!!.jsonPrimitive.content.toLong())
        assertEquals(2L, (json["afterSequences"] as JsonObject)["task-b"]!!.jsonPrimitive.content.toLong())

        val back = CoreJson.decodeFromString(TaskSubscribeParams.serializer(), json.toString())
        assertEquals(5L, back.afterSequences?.get("task-a"))
    }

    @Test
    fun taskListParamsEncodeStatusesAsCoreStoresThem() {
        val wire = CoreJson.encodeToString(
            TaskListParams.serializer(),
            TaskListParams(projectId = "p1", statuses = listOf(TaskStatus.AWAITING_REVIEW), limit = 50),
        )
        val json = CoreJson.parseToJsonElement(wire) as JsonObject
        assertEquals("p1", json["projectId"]!!.jsonPrimitive.content)
        assertEquals("awaiting_review", (json["statuses"] as JsonArray)[0].jsonPrimitive.content)
        assertEquals("50", json["limit"]!!.jsonPrimitive.content)

        // `{}` deserializes: every field is optional on the Rust side.
        val empty = CoreJson.decodeFromString(TaskListParams.serializer(), "{}")
        assertEquals(null, empty.projectId)
        assertEquals(null, empty.limit)
        assertEquals(emptyList<TaskStatus>(), empty.statuses)
    }

    @Test
    fun conversationHistoryResultIsAnObjectWithBothDisclosures() {
        val wire = """
            {"messages":[{"id":"m1","conversationId":"c1","role":"user","content":"hi","sequence":1}],
             "truncated":true,"nextSequence":1}
        """.trimIndent()
        val result = CoreJson.decodeFromString(ConversationHistoryResult.serializer(), wire)
        assertTrue(result.truncated)
        assertEquals(1L, result.nextSequence)
        assertEquals("c1", result.messages.single().conversationId)

        // The result re-encodes under the camelCase field names Rust pins in its own test.
        val json = CoreJson.parseToJsonElement(CoreJson.encodeToString(ConversationHistoryResult.serializer(), result)) as JsonObject
        assertEquals("c1", (json["messages"] as JsonArray)[0].let { (it as JsonObject)["conversationId"]!!.jsonPrimitive.content })
        assertEquals(1L, json["nextSequence"]!!.jsonPrimitive.content.toLong())
        assertNotNull(json["truncated"])
    }

    /**
     * A `conversation.history` object with NO `messages` key is a broken answer, not an empty
     * transcript. With a Kotlin default on the field this decoded into `messages = []` and the UI
     * would have said "Core reports no messages" about a frame that never said that.
     */
    @Test
    fun historyFrameWithoutMessagesFailsToDecodeRatherThanLookingEmpty() {
        val withoutMessages = """{"truncated":false,"nextSequence":0}"""
        // kotlinx raises JsonDecodingException/JsonDataException for a missing required property;
        // both are IllegalArgumentException, so that is the type asserted rather than a message.
        val error = assertFailsWith<IllegalArgumentException> {
            CoreJson.decodeFromString(ConversationHistoryResult.serializer(), withoutMessages)
        }
        assertTrue(
            error.message?.contains("messages") == true,
            "the refusal should name the missing field, and it must not decode: ${error.message}",
        )

        // A malformed row inside the list fails the same way instead of vanishing.
        assertFailsWith<IllegalArgumentException> {
            CoreJson.decodeFromString(
                ConversationHistoryResult.serializer(),
                """{"messages":[{"id":"m1"}],"truncated":false,"nextSequence":0}""",
            )
        }
    }

    @Test
    fun conversationHistoryParamsAcceptDefaults() {
        val minimal = CoreJson.decodeFromString(
            ConversationHistoryParams.serializer(),
            """{"conversationId":"c1"}""",
        )
        assertEquals(0L, minimal.afterSequence)
        assertEquals(null, minimal.limit)
        // `limit: Int?` defaults to null → omitted, so Core's own DEFAULT_LIST_LIMIT applies.
        assertFalse(
            CoreJson.encodeToString(ConversationHistoryParams.serializer(), minimal).contains("limit"),
        )
    }

    @Test
    fun listLimitConstantsMatchCore() {
        // Pinned against sandpane-service by ProtocolDriftGuardTest; asserted here so a Kotlin-side
        // edit that changes the number is caught too.
        assertEquals(200, DEFAULT_LIST_LIMIT)
        assertEquals(500, MAX_LIST_LIMIT)
        assertEquals(2 * 1024 * 1024, MAX_HISTORY_BYTES)
        assertEquals(4096, MAX_SUBSCRIBE_CURSORS)
        assertEquals(100, MAX_CURSOR_KEY_LEN)
        assertEquals(200, MAX_SCOPING_ID_LEN)
        assertTrue(MAX_HISTORY_BYTES < MAX_FRAME_BYTES, "Core asserts this relationship")
        assertTrue(MAX_SUBSCRIBE_BYTES < MAX_FRAME_BYTES)
    }
}
