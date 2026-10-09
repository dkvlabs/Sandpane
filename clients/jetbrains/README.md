# Sandpane — JetBrains plugin client (`clients/jetbrains`)

IntelliJ Platform plugin scaffold (Kotlin, native Swing tool window, typed local-Core RPC
client) implementing the JB0/JB1 surface of
[`docs/specs/04_JETBRAINS_PLUGIN.md`](../../docs/specs/04_JETBRAINS_PLUGIN.md).

> ## Verification status: COMPILES, PACKAGES AND UNIT-TESTS ON THIS HOST — never launched in an IDE
>
> This section was corrected on 09.10.2026. An earlier revision of this README stated that nothing
> in this module had ever been compiled or run and that no Kotlin compiler existed on this host.
> That is no longer true, and leaving it written would have been a false statement about
> verification (AGENTS.md rule 5).
>
> **Proven on this host** (commands and counts in "Checks actually run" below):
> `./gradlew test --offline` compiles `main` and `test` against the resolved IntelliJ Platform
> **2024.2.4** artifact and runs **97 unit tests, 0 failures, 0 errors**; `./gradlew buildPlugin
> --offline` produces the installable `build/distributions/sandpane-jetbrains-0.1.0-scaffold.zip`
> (2 707 234 bytes, rewritten by the clean run at 17:19 local on 09.10.2026).
> `ProtocolDriftGuardTest` re-reads `core/crates/sandpane-protocol/src/lib.rs`,
> `core/crates/sandpane-service/src/lib.rs` and `schemas/*.json` on every run and fails the build on
> a wire-name, method-order, numeric-bound or enum drift — and was demonstrated to go red when one
> name was renamed on either side (see "Drift gate and its negative control").
>
> **Still NOT verified, and nothing here implies otherwise:** `runIde` has never started an IDE;
> Plugin Verifier has never run; the packaged zip has never been installed or loaded in a real
> JetBrains product; none of the version pins below is confirmed against current Plugin SDK docs;
> no socket round trip against a live Core has ever been made; and every `sbx`/Codex-dependent
> behaviour is unexercised — this host has **no `sbx` binary** (`command -v sbx` → absent) and the
> **Docker daemon is unreachable** (`docker info` fails), which is the P0 gate docs/compatibility.md
> records as not passed.

**Host side effect, not a repo artifact:** running the builds populated Gradle caches under
`~/.gradle` on this dev host (the 8.10.2 wrapper distribution plus ~8.6 GB of dependency/module
caches, including the multi-GB IntelliJ Platform artifact). Nothing of that lives in the repository —
`clients/jetbrains/.gitignore:3` ignores `build/`, so the only tracked outputs are sources.

---

## JB0 — platform viability (the outstanding list)

| # | Task | Status here | Command / note |
|---|---|---|---|
| 1 | Pin exact IDE baseline, JDK, Kotlin, Gradle, plugin versions from current Plugin SDK docs | **UNVERIFIED pins** | `gradle.properties`: `platformType=IC`, `platformVersion=2024.2.4`, `javaToolchainVersion=17`, `kotlinVersion=2.0.21`, `intellijPlatformPluginVersion=2.1.0`, `kotlinxSerializationVersion=1.7.3` |
| 2 | Declare `sinceBuild`/`untilBuild` range | **DECLARED, UNPROVEN** | `pluginSinceBuild=242`, `pluginUntilBuild=252.*`; supplied by `patchPluginXml` (no `<idea-version>` hardcoded in `plugin.xml`) |
| 3 | Resolve Gradle distribution | **DONE** — the wrapper ran and its 8.10.2 distribution is unpacked under `~/.gradle/wrapper/dists/gradle-8.10.2-bin/` (marker `.ok` written 09.10.2026) | `./gradlew --version` → `Gradle 8.10.2`, Launcher JVM 23 (GraalVM CE 23+37), OS `Mac OS X aarch64` |
| 4 | First real build | **RUN** — `compileKotlin`, `jar`, `instrumentedJar`, `composedJar`, `buildPlugin` all succeed offline against the cached platform artifact | `./gradlew buildPlugin --offline` → `build/distributions/sandpane-jetbrains-0.1.0-scaffold.zip`. NOTE: `./gradlew build` alone does **not** produce the zip in this project — `buildPlugin` is a separate task and is not wired into `assemble`. |
| 5 | Sandbox IDE launch + tool window visible | **NOT RUN** | `./gradlew runIde` — never executed; no IDE has ever rendered this tool window |
| 6 | Plugin Verifier (public API + binary compatibility across the range) | **CONFIGURED, NEVER RUN** | `./gradlew runPluginVerifier` (`pluginVerification.ides { recommended() }`) |
| 7 | `runIde` matrix: IDEA Community **and** Ultimate, then PyCharm / WebStorm / PhpStorm | **NOT RUN** | specs/04 §1 — cross-IDE support is never assumed |
| 8 | Product-modules dependency form | **OPEN QUESTION** | the brief's `intellij { modules("intellij.platform.core") }` is the 1.x surface; no 2.x equivalent was proven, so none is declared. See the `JB0 OPEN ITEM` block in `build.gradle.kts`. |
| 9 | `kotlin.stdlib.default.dependency=false` combined with KGP 2.0.x | **COMPILES; RUNTIME UNVERIFIED** | `javaToolchainVersion=17` resolved to the auto-detected Azul Zulu JDK 17.0.20.1 (`./gradlew javaToolchains`), and the build succeeds. The produced zip nevertheless carries `kotlin-stdlib-2.0.20.jar`, i.e. a *different* Kotlin runtime than the pinned compiler 2.0.21 — only loading the plugin in an IDE shows whether that collides. |
| 10 | kotlinx-serialization-json bundled vs platform-provided | **PACKAGED; COLLISION UNVERIFIED** | the zip ships `kotlinx-serialization-json-jvm-1.7.3.jar` + `kotlinx-serialization-core-jvm-1.7.3.jar` alongside the plugin jar. Unit tests pass with them; whether an IDE runtime already carrying serialization classes conflicts is untested. |
| 11 | Tool-window descriptor attributes (`<toolWindow>` bean) | **UNVERIFIED** | see "Descriptor mapping notes" |
| 12 | `CommonDataKeys.EDITOR` / `ContentFactory` deprecations on 252 | **UNVERIFIED** | Plugin Verifier output decides |
| 13 | Real icon assets (`svg` + `@2x`) | **NOT CREATED** | no placeholder image is fabricated; `plugin.xml` declares no icon |
| 14 | Keyboard shortcuts | **DELIBERATELY ABSENT** | specs/04 §6 requires no conflict with common IDE actions; assigned after the JB4 audit |
| 15 | Kotlin/IDE lint clean | **NOT RUN** | no `detekt`/`ktlint` run. `buildSearchableOptions` is **SKIPPED** by configuration, so the "no searchable options" signal from JetBrains during `buildPlugin` is not a pass. |
| 16 | Test run | **RUN — 97 tests, 0 failures, 0 errors** | `./gradlew test --offline`; per-class counts in "Checks actually run" |

### Compile-verify list (specific APIs written by inspection)

These are the calls most likely to need a correction on first *runtime*. All of them are now
**type-checked**: `:compileKotlin` accepts every line below against `platformVersion=2024.2.4` with
KGP 2.0.21 on the JDK 17 toolchain. What remains unproven is *behaviour* — none of these has ever
executed inside a running IDE, which is what items 5–7 exist to establish:

- `SocketChannel.open(UnixDomainSocketAddress)` / `StandardProtocolFamily.UNIX` probe (JDK 16+).
- `CompletableFuture.orTimeout(...)`, `CompletableFuture.failedFuture(...)` (JDK 9+).
- `ReadAction.compute<V, E> { }` in `SandpaneContextProvider.collect`.
- `FileEditorManager.selectedTextEditor`, `ProjectLevelVcsManager.getVcsRootFor`, `allVcsRoots`.
- `ContentFactory.getInstance().createContent(...)` + `Content.setDisposer(Disposable)`.
- `ToolWindowFactory.createToolWindowContent(project, toolWindow)` (242 form) vs the 252 signature.
- `NotificationGroupManager.getInstance().getNotificationGroup("Sandpane")`.
- `Messages.showDialog(project, message, title, arrayOf(...), 1, null)` (used instead of a
  yes/no overload whose return type differs across versions).
- `Application.invokeLater(Runnable, Disposable)`, `getService(Class)`.
- `AnAction.getUpdateThread()` override (required on 2024.2+).
- `kotlinx.serialization` `decodeFromJsonElement` / `encodeToJsonElement` experimental-API opt-ins.
- `intellijPlatform { create(...) }`, `instrumentationTools()`, `pluginVerifier()`,
  `testFramework(TestFrameworkType.Platform)`, `ideaVersion { sinceBuild/untilBuild }`.

---

## JB2 — chat adapter is gated on P0 and is reported as unsupported

JB2 (chat, streaming, cancellation) depends on the **P0 feasibility gate**
(`docs/specs/07_ROADMAP_AND_TASKS.md` §P0: "Prove a real structured Codex conversation inside
SBX"). `docs/compatibility.md` records that gate as **not passed** (`sbx` not installed; Codex
app-server not validated in-SBX). The protocol contract is that Core expresses exactly that in
`system.probe` → `agents[].verified = false` and this client reads it rather than deciding for
itself. Honest limit: **this host has never contacted a running Core**, so the `verified = false`
answer has not been observed here — what has been verified is the client's *behaviour given that
answer*, by unit tests over fabricated capability lists.

Behaviour in this scaffold, therefore:

- Capability is **read from Core**, never inferred: `ConnectionManager.agentGate()` maps
  `CoreCapabilities.agents` to `AgentGate.NotConnected | NoAdapters | P0GateNotPassed |
  NoStreaming | Open`.
- The composer and **Send** stay disabled unless the gate is `Open`; the reason is shown in the
  banner and as the button tooltip (`AgentGate.reasonForUser()`).
- `StartTaskAction` stops before creating a task and states why — the folder→project mapping may
  now resolve (gap 6 is closed), but the editor-side send path is unimplemented JB3 work; see
  "Drift and gaps found while building this".
- The streaming render path (delta queue → 50 ms EDT flush) **is** implemented, because it is
  the piece JB0/JB1 needs to be right for large transcripts, and it is exercised by unit tests
  only at the framing/decoding level. It has never been fed a real agent event.

Unsupported is visibly unsupported — no mocked adapter, no fake success (AGENTS.md rule 5).

---

## Layout

```text
clients/jetbrains/
├── settings.gradle.kts
├── build.gradle.kts                      # org.jetbrains.intellij.platform 2.x (executes: compile, test, buildPlugin)
├── gradle.properties                     # all JB0 pins + Kotlin flags
├── gradlew / gradlew.bat / gradle/wrapper/   # generated by host Gradle 8.10.2; distribution unpacked and run
├── .gitignore                            # line 3 ignores build/
├── README.md
└── src/
    ├── main/
    │   ├── kotlin/labs/dkv/sandpane/
    │   │   ├── SandpaneToolWindowFactory.kt
    │   │   ├── core/CoreClient.kt            # AF_UNIX SocketChannel, NdjsonFramer, correlation, EDT guard
    │   │   ├── core/ConnectionManager.kt     # application service: backoff, probe, resubscribe, AgentGate
    │   │   ├── core/CoreCommands.kt          # typed RPC wrappers: guards, advertisement gate, cursor shapes
    │   │   ├── core/CoreGuards.kt            # mirrors of the sandpane-service request guards
    │   │   ├── core/ReplayCursors.kt         # per-task cursor seam behind task.subscribe's afterSequences
    │   │   ├── core/ErrorAttribution.kt      # provenance of a failure: this plugin refused vs Core answered
    │   │   ├── core/EventStream.kt           # per-task checkpoint, bounded window, fan-out
    │   │   ├── model/Models.kt               # kotlinx mirrors of sandpane-protocol (wire names, 14 methods)
    │   │   ├── model/WorkspaceModeView.kt    # workspaceMode rendering; absence => UNVERIFIED/live-writable
    │   │   ├── ui/ChatPanel.kt               # Swing list/composer/pickers/attachments/status + 50 ms flush
    │   │   ├── actions/{StartTask,ReviewChanges,ApplyTask,RefreshSandboxes}Action.kt
    │   │   ├── services/{SandpaneContextProvider,EditorDiffProvider,SbxService,TaskMonitorService}.kt
    │   │   ├── services/FolderMatching.kt    # folder → Core project, pure and canonicalized on both sides
    │   │   └── settings/{SandpaneSettings,SandpaneConfigurable}.kt
    │   └── resources/META-INF/plugin.xml
    └── test/kotlin/labs/dkv/sandpane/
        ├── core/CoreClientFramingTest.kt     # byte-level framing + wire names        (29 tests)
        ├── core/CoreCommandsTest.kt          # guards, gates, the three cursor shapes  (28 tests)
        ├── core/ErrorAttributionTest.kt      # failure provenance sentences             (13 tests)
        ├── core/ProtocolDriftGuardTest.kt    # re-reads the Rust sources + schemas      (8 tests)
        ├── core/ReplayCursorSemanticsTest.kt # per-task vs shared-scalar replay         (7 tests)
        └── services/FolderMatchingTest.kt    # folder matching + workspace-mode views  (12 tests)
```

Module layout deviates from specs/04 §2's sketch in two deliberate ways: models live in one
`model/Models.kt` (protocol mirror is easier to parity-check as a single surface than split
across `Projects/Chats/Tasks/Sandboxes.kt`), and `ui/` currently holds only `ChatPanel.kt`
(the tool window has one panel until JB2 adds tabs). Both are named here rather than silently.

---

## Threading contract (where streaming batch dispatch lands)

```text
Core socket reader thread (CoreClient.readLoop, daemon)
  -> correlate(frame) -> CompletableFuture completion          [background]
  -> EventStream.merge -> TaskMonitorService.onBatch            [background]
       -> message.delta  : ChatPanel queue offer (no Swing)      [background]
       -> other events   : ChatPanel.onEdt { ... }                [invokeLater]
  -> javax.swing.Timer(streamFlushIntervalMs, default 50 ms)     [fires ON the EDT]
       -> drainDeltas() -> DefaultListModel writes -> repaint    [the only paint path]
```

Enforcement, in three layers:

1. `CoreClient.assertNotEdt(...)` throws if `connect()` / `requestBlocking()` run on the EDT.
2. All RPC goes through `ConnectionManager` (`io` cached pool + `scheduler` single thread),
   which is where backoff, polling and decoding happen — never on the EDT.
3. Every Swing mutation is inside `invokeLater` or the Swing `Timer`; the queue is the
   hand-off. Retention is capped (`MAX_ROWS = 400`, `EventStream` window =
   `retainedEventCap`, default 2 000/task) per specs/04 §5 risk 2.

Disposal: `ChatPanel.dispose()` removes its listeners and stops the timer;
`TaskMonitorService.dispose()` releases per-task polling; `ConnectionManager.dispose()` closes
**our socket** and shuts down our executors. None of them tells Core to stop a task —
another client may own it (specs/04 §5 risk 5).

---

## Protocol parity and drift

`model/Models.kt` mirrors `core/crates/sandpane-protocol/src/lib.rs` (Rust is the source of
truth; `schemas/*.json` is hand-synced with it): camelCase payload fields, snake_case
`TaskStatus`/`WorkspaceMode`/`FileChangeStatus`/`ContextRefKind`, SCREAMING_SNAKE `ErrorCode`,
dotted `AgentEvent` discriminators, `v/id/method/params` frames with flattened `ok`/`err`, and
`MAX_FRAME_BYTES = 4 MiB` from `sandpane-service`.

The method surface is **14** (`Method::ALL` in Rust), of which **11** are the original protocol-v1
baseline and **3** are additive in this revision: `task.list`, `conversation.list`,
`conversation.history`. The additive fields are `CoreCapabilities.methods`,
`Project.repositories`, `SandboxSummary.workspaceMode` and the optional
`TaskSubscribeParams.afterSequences`.

This is checked **mechanically on every test run** by `ProtocolDriftGuardTest` (8 tests), which
reads the Rust sources and the schemas out of the working tree and compares them against the
Kotlin mirror: method names **and their order**, the `Method::parse` arms, the
`rpc-request.schema.json` `method` enum, every `pub const` numeric bound (evaluated, not copied), the
enum value sets against both Rust and `sandbox-create-spec.schema.json`, the additive field names on
both sides, the three `task.subscribe` cursor rules as they appear in `sandpane-service`, and the
durable event kinds Core appends. Two classes are deliberately renamed on the Kotlin side
(`RpcResponse` → `RpcResponseFrame`, `RpcError` → `RpcErrorPayload`); their **field** names are
unchanged, and class names are not wire-visible.

### Drift gate and its negative control

A guard that cannot fail is decoration, so the gate was falsified twice on 09.10.2026, renaming
`task.list`:

1. **Kotlin mirror mutated** — `CoreMethods.TASK_LIST = "task.listx"` in `model/Models.kt`, running
   only that class (`./gradlew test --offline --tests '*ProtocolDriftGuardTest*'`) →
   `kotlinMethodsMatchRustMethodAllExactlyIncludingOrder FAILED`, 8 tests completed, 1 failed:
   `CoreMethods.ALL drifted from Method::ALL (order included) expected:<[…, task.listx, …]> but was:
   <[…, task.list, …]>`. Restored and re-run → `BUILD SUCCESSFUL`.
2. **Rust source-of-truth mutated** — a scratch copy of `core/crates/{sandpane-protocol,
   sandpane-service}/src/lib.rs`, `schemas/*.json` and `Models.kt` under `/tmp`, with the
   `as_str`/`parse` arms renamed to `"task.listed"`, run through the gate's own
   `-PsandpaneRepoRoot=<copy>` hook (the real `core/` was never touched; its mtimes predate this
   session) → the same single failure, `expected:<[…, task.list, …]> but was:<[…, task.listed, …]>`.
   The scratch copy was deleted afterwards.

So a renamed wire string breaks the build here instead of shipping a silent desync (AGENTS.md
rule 8). What the gate does **not** prove: that a *running* Core implements these names — that is
the compatibility matrix (`docs/compatibility.md`), and no live round trip has ever been made.

**Cross-client consistency** (compared against the sources at 04:42, not assumed): socket/data
resolution in `ConnectionManager.socketPath()` matches `sandpane_service::{default_socket_path,
data_dir}` **and** `clients/vscode/src/core-client/paths.ts` — settings override →
`SANDPANE_SOCKET` → per-user dir (`~/Library/Application Support/sandpane` on macOS, else
`$XDG_STATE_HOME`/`~/.local/state` + `/sandpane`, `HOME` fallback `/tmp`), file `sandpane.sock`;
values trimmed the same way; Windows reported as an unsupported transport with **no TCP
fallback** in both clients. `MAX_FRAME_BYTES = 4 MiB` matches `sandpane-service` and
`apps/desktop/src/lib/protocol.ts`. Method/error-code/event/status/mode value sets were also
confirmed by the repo's own gate: `python3 scripts/schema_drift.py` → `exit=0`, "All
schema/protocol value sets in sync" (that gate checks Rust↔schemas, not this module).

### Drift and gaps found while building this (for the orchestrator, not fixed here)

Re-checked against the **current** `sandpane-protocol`/`sandpane-service`/`schemas` sources on
09.10.2026 (the crate changed twice while this module was being written: items 2 and 8 are still
open, item 1 was closed by the first change, and items 3–7 were **closed by the protocol-v1
discovery revision this client is now synced to**):

1. **RESOLVED — `unsupported.event` field name.** An earlier `lib.rs` serialized
   `provider_type` (serde's enum-level `rename_all` does not rename struct-variant fields) while
   `schemas/agent-event.schema.json` and `apps/desktop/src/lib/protocol.ts` required
   `providerType`. `lib.rs` now renames the field explicitly (`#[serde(rename = "providerType")]`)
   and pins the wire shape in a Rust test, so the drift is closed. **The Kotlin client still
   accepts `provider_type` as a fallback for an older Core** — that is compatibility, and the
   fallback should be deleted once the minimum supported Core build post-dates the fix.
   Note: `scripts/schema_drift.py` compares **value sets** only (methods, codes, event types,
   statuses, modes, version), so it could not have caught this field rename — field-level
   checking remains the P1/P7 codegen item.
2. **`conversation.send` response.** specs/02 §2 promises `{ taskId }`;
   `sandpane-service::conversation_send` returns a full `TaskSummary`.
   `TaskMonitorService.SendResult` accepts both.
3. **CLOSED — `task.list` exists.** Method 12 of `Method::ALL`, advertised through
   `CoreCapabilities.methods` and wrapped in `CoreCommands.taskList`. Task-row hydration uses it;
   the project-wide replay path stays only as the fallback for a Core that predates advertisement
   (`ConnectionManager.discoverTasks`). Discovery is still user-triggered, never on a timer.
4. **CLOSED — per-task replay cursors exist.** `TaskSubscribeParams.afterSequences`
   (`Option<HashMap<String, i64>>`) replaces the shared scalar. The rules this client implements
   exactly as Core does, and `ProtocolDriftGuardTest` pins against the Rust text:
   *with `taskId` the scalar wins and the map is ignored — this client does not even put
   `afterSequences` on the wire, because sending a key Core would discard implies an effect it does
   not have; without `taskId`, each task replays from `afterSequences[taskId]`, and a task absent
   from the map replays from 0, i.e. IN FULL; with no map at all the legacy shared scalar applies to
   every task, unchanged.* Negative cursors normalise to 0 like Core's `.max(0)`; keys are bounded
   by UTF-8 **byte** length (1..=100) because Rust measures `str::len()`; the map is bounded to
   4096 entries; an EMPTY map is refused locally rather than silently downgraded to the scalar,
   because `{}` and "no map" are different requests to Core. A replay Core says cannot fit one frame
   comes back as a structured `VALIDATION_FAILED` and is recognised, not retried
   (`CoreGuards.isOversizedReplayRefusal`).
5. **CLOSED — `conversation.list` exists.** `SbxService.enumerateConversations` feeds the chat
   picker, gated on advertisement; an unadvertised method shows as unavailable and no list is
   invented. Archived conversations are excluded by Core, not by this client.
6. **CLOSED — `project.list` carries `repositories`.** `FolderMatching` resolves an IDE folder
   against them, canonicalizing BOTH sides (Core stores what was registered and resolves symlinks
   only at mount time), and distinguishes `Matched` / `Ambiguous` / `Unregistered` /
   `Indeterminate` — an absent field is reported as "cannot tell", never as "not registered".
   `StartTaskAction` now uses that seam. What still blocks task creation from the editor is client
   work (the JB3 send path), not the wire.
7. **CLOSED — `SandboxSummary.workspaceMode` exists.** `WorkspaceModeView` renders the recorded
   mode, labels `direct_mount` LIVE-WRITABLE on every surface, and — the part that matters — when
   the field is ABSENT it renders `UNVERIFIED — TREAT AS LIVE-WRITABLE` with `hostWritable = true`.
   Absence is never defaulted to a benign mode (specs/02 §7, specs/04 §3). The record is what Core
   was asked to bind, not a live SBX verification; `probedState` stays SBX's separate answer.
8. **`ContextRef(kind: selection)` has no identifier contract.** Inventing a
   `path#Lx-Ly` string client-side would likely fail Core's path validator, so the selection
   is quoted into `content` (data, never a command) and only the FILE path is attached.

---

## Security posture in this module

- **No subprocess at all.** `ProcessBuilder`, `Runtime.exec` and shell strings are absent —
  re-verified by grep on 09.10.2026 (see the table below), not asserted. The Core launcher binary
  is deliberately **not** wired: service ownership is ADR-1 and licensing-gated (specs/06).
- **Local IPC only.** `SocketChannel` + `UnixDomainSocketAddress`; a non-local or scheme-like
  path is refused, and Windows resolves to an explicit `TransportUnsupported` state instead of
  falling back to TCP.
- **Allowlisted methods.** `CoreClient.request()` refuses anything outside the **14** protocol
  method names before writing a byte; there is no free-form RPC. The refusal is a
  `CoreValidationException` — this client's own word — and not a `CoreRpcException`, because Core
  never saw the request.
- **Validated before the socket.** Ids, scoping ids, limits and cursor maps pass `CoreGuards`
  *inside* the payload builder, before `rpc.request` is reached; a refused value produces a failed
  future and the recording transport proves `sent` stayed empty (`CoreCommandsTest`). The bounds
  mirror `sandpane-service` and are drift-checked, and cursor-map keys are measured in UTF-8 BYTES
  because Rust measures `str::len()`.
- **Provenance of every failure.** `ErrorAttribution` is the single seam that renders a failure and
  it distinguishes "this plugin refused, nothing was sent" from "Core answered `CODE`, here are its
  words" — including through the `CompletionException` wrapper a `whenComplete` handler receives. A
  verdict's code survives `toString()`/stack traces, and `CoreRpcException.raisedByCore = false`
  marks the frame faults this plugin raised about Core's reply, so an unusable answer is never
  reported as Core's judgment (AGENTS.md rule 5; `ErrorAttributionTest`, 13 tests).
- **Bounded frames.** `NdjsonFramer` refuses to buffer past 4 MiB, mirroring the service cap.
- **No secrets in logs.** The unsolicited-frame log line is truncated to 240 chars, `system.err`
  is used only behind an opt-in `verboseLogging` flag, and no credential surface exists here.
- **No JetBrains AI Assistant or internal APIs**; public extension points only.
- **No `sbx` binary and no credentials are bundled.** The description in `plugin.xml` carries
  the independence notice (not affiliated with or endorsed by Docker, Inc. or JetBrains s.r.o.),
  per `docs/specs/06_SECURITY_AND_LICENSING.md`.
- **Client-side validation mirrors the schema** (`SbxClientValidation`) for fast refusals;
  `sandpane_core::validation` remains the real gate before any CLI vector.

## Descriptor mapping notes

- The brief's `toolWindow factoryId SandpaneToolWindow` is carried as
  `SandpaneToolWindowFactory.FACTORY_ID`, with the visible tool-window `id="Sandpane"`.
  `<toolWindow>` has no documented `factoryId` attribute in the current descriptor bean, and an
  undocumented attribute risks a load error, so it was **not** invented. Confirm at JB0.
- No `<depends>` beyond `com.intellij.modules.platform`; no optional JCEF dependency
  (native Swing is the default and the fallback).
- Actions are nested inside the `labs.dkv.sandpane.Toolwindow` group (added to
  `EditorPopupMenu` and `ProjectViewPopupMenu`) instead of using `<reference>` to
  not-yet-registered ids, and the tool window toolbar builds them by id via `ActionManager`.
- `<idea-version>` is intentionally absent from `plugin.xml`; `patchPluginXml` supplies the
  pinned range, so no unverified range is committed.
- No icon is declared until a real asset exists (JB0 item 13).

## Checks actually run on this host

Gradle/compile/test rows were run on 09.10.2026 in this session; the file-level rows are re-run
counts from the same date.

| Check | Tool / command | Result |
|---|---|---|
| Clean compile + package + tests from scratch | `./gradlew clean buildPlugin test --offline` | **BUILD SUCCESSFUL**, exit 0 — `compileKotlin`, `compileTestKotlin`, `jar`, `instrumentedJar`, `composedJar`, `buildPlugin`, `test` all executed |
| Unit tests | `./gradlew test --offline` | **97 tests, 0 failures, 0 errors** — `CoreClientFramingTest` 29, `CoreCommandsTest` 28, `ErrorAttributionTest` 13, `ProtocolDriftGuardTest` 8, `ReplayCursorSemanticsTest` 7, `FolderMatchingTest` 12 |
| Kotlin warning surface | `./gradlew compileKotlin compileTestKotlin --offline --rerun-tasks` | **0** `w:`/`e:` lines on a forced full recompile (`-Werror` stays off until JB0 records a verified build) |
| Installable artifact | `./gradlew buildPlugin --offline` | `build/distributions/sandpane-jetbrains-0.1.0-scaffold.zip` (2 707 234 bytes); bundles the plugin jar + `kotlinx-serialization-{json,core}-jvm-1.7.3` + `kotlin-stdlib-2.0.20`. Never installed anywhere. |
| Toolchain actually used | `./gradlew --version`, `./gradlew javaToolchains` | Gradle 8.10.2, Launcher JVM 23 (GraalVM CE), `javaToolchainVersion=17` satisfied by auto-detected Azul Zulu JDK 17.0.20.1; platform artifact `IC 2024.2.4` resolved from cache |
| Drift gate can fail (negative control) | mutated Kotlin mirror, then a mutated **copy** of the Rust sources via `-PsandpaneRepoRoot` | red in both directions with a message naming the drifted wire string; green after restore — see "Drift gate and its negative control" |
| Protocol parity | `ProtocolDriftGuardTest` (runs with the suite) | 14 method names **in `Method::ALL` order**, service bounds evaluated from `pub const`, enum sets vs Rust **and** schemas, additive field names on both sides, cursor rules matched against the Rust text |
| `plugin.xml` well-formed + registrations dumped | `python3` `xml.etree` | parsed; id/name/vendor/depends/toolWindow/services/configurable/notificationGroup/4 actions all present |
| Every class `plugin.xml` names exists in the sources | grep over all `labs.dkv.*` strings | 19 distinct strings: **12 name a type and all 12 resolve**, 0 missing; the other 7 are 4 action ids, 1 group id and 2 package prefixes (re-checked 09.10.2026) |
| Subprocess misuse (`ProcessBuilder`, `Runtime.exec`, `sh -c`, `bash -lc`) | grep over `src/main/kotlin` | **none** — no subprocess surface exists in this module |
| Internal/private API references (`com.intellij.internal`, JetBrains AI, `setAccessible`, `Unsafe`, reflection) | grep | none |
| TCP / network surface | grep | none — every `TCP` hit is prose stating it is never used |
| Leftover `TODO()` / `???` / `FIXME` | grep | none |
| Source inventory | `find src -name '*.kt' \| wc -l` | 28 files (22 main, 6 test) |
| Gradle wrapper | `gradle --offline wrapper` | generated for real (8.10.2, jar sha256 `2db75c40…8046`), and its distribution has now been unpacked and used by the runs above |

## NOT verified

- **`runIde` has never been launched.** No IDE has ever shown the tool window, the chat panel, the
  sandbox picker, the diffs, or any of these actions. Every UI behaviour in this module is
  written-against-documentation, not observed.
- **Plugin Verifier has never run** (`runPluginVerifier`), so public-API and binary compatibility
  across `242`–`252.*` is unproven, as is every deprecation question in JB0 items 11–12.
- **The packaged zip has never been installed or loaded** in any JetBrains product. Packaging is
  not proof of loadability: `<toolWindow>` wiring, `plugin.xml` class resolution, service
  instantiation, the bundled Kotlin runtime, and kotlinx-serialization coexistence with the IDE's
  own classes are all untested at runtime (JB0 items 8–12).
- **Version pins are unconfirmed against current Plugin SDK docs** — `platformType=IC`,
  `platformVersion=2024.2.4`, `kotlinVersion=2.0.21`, `intellijPlatformPluginVersion=2.1.0`,
  `kotlinxSerializationVersion=1.7.3`, `pluginSinceBuild=242`/`pluginUntilBuild=252.*`. They
  compile together here; nobody has checked them against the recommended matrix.
- **`verifyPluginProjectConfiguration` reports a real misconfiguration that this host cannot fix.**
  The build prints: `The Java configuration specifies sourceCompatibility='17' but IntelliJ
  Platform '2024.2.4' requires sourceCompatibility='21'` (alongside the note that
  `.intellijPlatform` must be VCS-excluded — it is, at `.gitignore:32`). `gradle.properties` pins
  `javaToolchainVersion=17` and this host has JDK 17 / 23 / 26 / 27 but **no JDK 21**, and the build
  runs `--offline`, so toolchain auto-provisioning is not available. Consequence stated plainly:
  the zip is expected to be **rejected or degraded on 2024.2.4** until the toolchain moves to 21 or
  the baseline drops to a 17-era platform — a decision that needs an IDE to verify against (JB0
  exit criteria), so it is recorded here rather than changed blind. The same run also reports
  `kotlin.stdlib.default.dependency=false` while the packaged zip carries
  `kotlin-stdlib-2.0.20` against a pinned 2.0.21 compiler (JB0 items 9–10).
- **No socket round trip against a live Core** has ever been made — no `system.probe`, no real
  frame, no reconnect/replay. The framing tests are byte-level and in-JVM; the guard refusals and
  cursor shapes are proven against a *recording* transport, not against Core's answers.
- **Everything `sbx`- and Codex-dependent is unexercised on this host**: `command -v sbx` → absent,
  `docker info` → daemon not reachable, so the P0 in-SBX feasibility gate cannot be evaluated here
  and `AgentGate` can only ever report the not-ready states. No adapter, streaming event, or
  sandbox lifecycle path has been fed real data.
- **`ConnectionManager`, `ChatPanel`, `TaskMonitorService`, `SbxService` and the actions have no
  test that instantiates them** — they need an IDE `Project`/application service. The pure seams
  they delegate to (`CoreCommands`, `CoreGuards`, `ReplayCursors`, `FolderMatching`,
  `WorkspaceModeView`, `NdjsonFramer`, `ErrorAttribution`) are what the 97 tests cover, so wiring
  bugs inside those classes remain possible.
- **Older/newer Core compatibility** (testing this client against an older and a newer Core within
  the compatibility policy) has not been done; advertisement gating is tested against fabricated
  capability lists only.
- `docs/compatibility.md` still records "Gradle / Kotlin — not installed locally" for this client.
  That line is now stale on this host: the Gradle wrapper ran, the Kotlin compiler ran (via
  `kotlin-compiler-embeddable` resolved into `~/.gradle`), and tests executed. The standalone
  `kotlinc` CLI is still absent, which is irrelevant to this build. That file is the orchestrator's
  to update — recorded here rather than changed silently.
