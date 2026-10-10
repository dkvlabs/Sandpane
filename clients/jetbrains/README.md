# Sandpane — JetBrains plugin client (`clients/jetbrains`)

IntelliJ Platform plugin scaffold (Kotlin, native Swing tool window, typed local-Core RPC
client) implementing the JB0/JB1 surface of
[`docs/specs/04_JETBRAINS_PLUGIN.md`](../../docs/specs/04_JETBRAINS_PLUGIN.md).

> ## Verification status: COMPILES, UNIT-TESTS, PACKAGES AND PASSES PLUGIN VERIFIER ON THIS HOST — never launched in an IDE
>
> Re-baselined on 09.10.2026 (task U4, "latest library for each implementation"). Earlier revisions
> of this section described a 2024.2.4 / Gradle 8.10.2 / JDK 17 build with 97 tests; those numbers
> are superseded by the ones below.
>
> Re-run on 10.10.2026 after the anti-spoofing and unknown-enum tolerance change (entry 0029):
> `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` passes with
> **205 tests, 0 failures, 0 errors, 0 skipped**, and `./gradlew verifyPlugin --offline` still
> reports **`Compatible`** against IU-262.10968.63. The 161-test figures below are the U4 baseline.
>
> Re-run on 10.10.2026 after the A1 sandbox-lifecycle client work and its security/phase-review fixes (`sandbox.stop`, two-step
> `sandbox.remove`, `SandboxCreateSpec.agent` / `SandboxSummary.agent`, 16-method pin):
> `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` passes with
> **243 tests, 0 failures, 0 errors, 0 skipped** across 29 test classes, and
> `./gradlew verifyPlugin --offline` reports **`Compatible`** against IU-262.10968.63 with no
> deprecated/experimental/internal usage reports. The new actions were **never launched in an IDE**
> and never exercised against a running Core or a real `sbx`.
>
> Re-run on 10.10.2026 after the A2 client work (idempotency keys + `features`):
> `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` passes with
> **265 tests, 0 failures, 0 errors, 0 skipped** across 30 test classes, and
> `./gradlew verifyPlugin --offline` reports **`Compatible`** against IU-262.10968.63 (no
> deprecated/experimental/internal usage reports). A2 is UNVERIFIED end to end: never run in an IDE,
> never against a running Core, never against a real `sbx`.
>
> **Proven on this host** (exact commands and outputs in "Checks actually run" below):
> `./gradlew test --rerun buildPlugin verifyPluginStructure` passes both online and `--offline`
> (the offline run after `clean`, `--no-build-cache`, so `compileKotlin`/`compileTestKotlin` really
> executed offline) against **IntelliJ IDEA 2026.2.3 (IU-262.10968.63)**: **161 tests, 0 failures,
> 0 errors, 0 skipped** across 20 test classes; `build/distributions/sandpane-jetbrains-0.1.0-scaffold.zip`
> (1 163 019 bytes) is produced and `verifyPluginStructure` accepts it. `./gradlew verifyPlugin`
> (IntelliJ Plugin Verifier 1.410) reports **`Compatible`** against IU-262.10968.63 with **no**
> deprecated, experimental, internal or override-only API usages and no compatibility problems.
> `ProtocolDriftGuardTest` re-reads `core/crates/sandpane-protocol/src/lib.rs`,
> `core/crates/sandpane-service/src/lib.rs` and `schemas/*.json` on every run and fails the build on
> a wire-name, method-order, numeric-bound or enum drift — and was demonstrated to go red when one
> name was renamed on either side (see "Drift gate and its negative control").
>
> **Still NOT verified, and nothing here implies otherwise:** `runIde` has never started an IDE;
> the packaged zip has never been installed or loaded in a real JetBrains product (Plugin Verifier
> is static bytecode analysis, not a load test); only one IDE build (262) has been verified, so the
> declared range is exactly `262`–`262.*`; no socket round trip against a live Core has ever been
> made; and every `sbx`/Codex-dependent behaviour is unexercised — this host has **no `sbx` binary**
> (`command -v sbx` → absent) and the **Docker daemon is unreachable** (`docker info` fails), which
> is the P0 gate docs/compatibility.md records as not passed.

**Host side effect, not a repo artifact:** running the builds populated caches on this dev host:
the Gradle 9.8.1 wrapper distribution under `~/.gradle/wrapper/dists/`, the IntelliJ IDEA 2026.2.3
artifact (~1.4 GB download in `~/.gradle/caches/modules-2`, ~4.2 GB extracted under
`~/.gradle/caches/9.8.1/transforms/`), Temurin JDK 21.0.12.1 downloaded by the foojay resolver into
`~/.gradle/jdks/` during the first run of this upgrade (toolchain then still at 21 — see "Toolchain";
Temurin 25.0.3 was already in `~/.gradle/jdks/` from an earlier auto-provision and was reused), and ~935 MB of bundled-plugin dependency data the Plugin Verifier unpacked into
`~/.pluginVerifier/` on its first run. Nothing of that lives in the repository —
`clients/jetbrains/.gitignore` ignores `build/`, `.gradle/`, `.intellijPlatform/` and `.kotlin/`.

## Versions and toolchain (09.10.2026)

Every version below was read from its publishing registry on 09.10.2026, not assumed.

| Item | Old | New | Source checked |
|---|---|---|---|
| Gradle wrapper | 8.10.2 (no checksum pinned) | **9.8.1**, `distributionSha256Sum=dce76f55…dc01f` | `services.gradle.org/versions/current`; `gradle-wrapper.jar` sha256 `3b8a2577…8e98` matches the published wrapper checksum |
| IntelliJ Platform Gradle Plugin | 2.1.0 | **2.19.0** | Gradle Plugin Portal `maven-metadata.xml` (`<release>2.19.0`) |
| Kotlin (JVM + serialization compiler plugins) | 2.0.21 | **2.4.21** | Maven Central `kotlin-gradle-plugin` metadata — newest *stable*; `2.5.0-Beta1` is listed as `<release>` but is a pre-release and was deliberately not taken |
| kotlinx-serialization-json | 1.7.3 | **1.11.0** | Maven Central metadata — newest *stable*; `1.12.0-RC` is a pre-release and was deliberately not taken |
| Toolchain resolver | none | **foojay-resolver-convention 1.0.0** (settings plugin) | Gradle Plugin Portal metadata; usage per docs.gradle.org toolchains page |
| Target IDE | IntelliJ IDEA Community (`IC`) 2024.2.4 via `create(IC, …)` | **IntelliJ IDEA 2026.2.3** (build 262.10968.63) via the unified `intellijIdea(...)` dependency — there is no separate Community artifact since 2025.3 | `data.services.jetbrains.com/products/releases?code=IIU&latest=true&type=release`; extracted `product-info.json` says `IntelliJ IDEA`, `2026.2.3`, `262.10968.63`, `productCode IU` |
| `sinceBuild` / `untilBuild` | 242 / 252.* | **262 / 262.*** | the only build line compiled and verified here |
| Java toolchain / bytecode | 17 | **25** (class-file major 69 in the plugin jar) | see below |
| Plugin Verifier IDEs | `recommended()` (never run) | **`current()`** = the IDE the build compiles against | IntelliJ SDK docs `pluginVerification.ides` |

**Toolchain: why 25 and not 21.** The upgrade request expected "262 → Java 21". The IDE itself says
otherwise, from four independent sources: `product-info.json` → `"minRequiredJavaVersion": 25`;
the bundled JBR `release` file → `JAVA_VERSION="25.0.4"`; platform classes are class-file major 69
(e.g. `lib/intellij.platform.vcs.impl.jar`: 2 864/2 864 classes at 69); and IPGP's
`verifyPluginProjectConfiguration`, with the toolchain at 21, printed `Java sourceCompatibility is
set to '21', but IntelliJ Platform '2026.2.3' requires Java '25'`. The toolchain is therefore 25.
No JDK 25 is installed system-wide on this host (17 / 23 / 26 / 27 are). Foojay provisioning was
proven here with 21 (Temurin 21.0.12.1 downloaded during the first gate run); Temurin 25.0.3 was
already in `~/.gradle/jdks` from an earlier Gradle auto-provision and was reused, and
`./gradlew javaToolchains` lists it as `Auto-provisioned by Gradle`. On a host without it, the same
resolver downloads it. No machine-specific JDK path is committed. The Gradle launcher itself
runs on whatever `JAVA_HOME` is (here GraalVM CE 23; Gradle 9.8.1 needs ≥ 17).

**until-build is kept on purpose.** `verifyPluginProjectConfiguration` recommends removing
`until-build` for 243+ ("restricts plugin compatibility with future IDE versions"). That advice is
not followed: an open-ended range would advertise compatibility with IDE builds nobody has run the
verifier against (AGENTS.md rule 5). Widen the range only together with matching
`pluginVerification.ides` entries.

---

## JB0 — platform viability (the outstanding list)

| # | Task | Status here | Command / note |
|---|---|---|---|
| 1 | Pin exact IDE baseline, JDK, Kotlin, Gradle, plugin versions from current Plugin SDK docs | **DONE for one IDE line** — versions read from their registries and built/verified together (see "Versions and toolchain") | `gradle.properties`: `platformVersion=2026.2.3`, `javaToolchainVersion=25`, `kotlinxSerializationVersion=1.11.0`; `build.gradle.kts` `plugins {}`: Kotlin 2.4.21, IPGP 2.19.0; `settings.gradle.kts`: foojay 1.0.0; wrapper 9.8.1 |
| 2 | Declare `sinceBuild`/`untilBuild` range | **DECLARED = VERIFIED RANGE** | `pluginSinceBuild=262`, `pluginUntilBuild=262.*`; supplied by `patchPluginXml` (no `<idea-version>` hardcoded in `plugin.xml`). Older builds (≤ 261) are not supported: they were not verified and need Java ≤ 21 bytecode. |
| 3 | Resolve Gradle distribution | **DONE** — wrapper regenerated as 9.8.1 with `--gradle-distribution-sha256-sum`, distribution downloaded and used | `./gradlew --version` → `Gradle 9.8.1`, Launcher JVM 23 (GraalVM CE 23+37) |
| 4 | First real build | **RUN** — `compileKotlin`, `instrumentCode`, `jar`, `instrumentedJar`, `composedJar`, `buildPlugin`, `verifyPluginStructure` succeed online and offline against IntelliJ IDEA 2026.2.3 | `build/distributions/sandpane-jetbrains-0.1.0-scaffold.zip`. NOTE: `./gradlew build` alone does **not** produce the zip in this project — `buildPlugin` is a separate task and is not wired into `assemble`. |
| 5 | Sandbox IDE launch + tool window visible | **NOT RUN** | `./gradlew runIde` — never executed; no IDE has ever rendered this tool window |
| 6 | Plugin Verifier (public API + binary compatibility across the range) | **RUN — `Compatible`, 0 deprecated / experimental / internal usages** against IU-262.10968.63 (the whole declared range) | `./gradlew verifyPlugin` (`pluginVerification.ides { current() }`, verifier-cli 1.410); report in `build/reports/pluginVerifier/IU-262.10968.63/` |
| 7 | `runIde` matrix: IntelliJ IDEA (unified since 2025.3), then PyCharm / WebStorm / PhpStorm | **NOT RUN** | specs/04 §1 — cross-IDE support is never assumed; the Plugin Verifier has only seen IntelliJ IDEA |
| 8 | Product-modules dependency form | **OPEN QUESTION** | the brief's `intellij { modules("intellij.platform.core") }` is the 1.x surface; no 2.x equivalent was proven, so none is declared. See the `JB0 OPEN ITEM` block in `build.gradle.kts`. |
| 9 | `kotlin.stdlib.default.dependency=false` combined with KGP 2.4.21 | **PACKAGING FIXED; RUNTIME UNVERIFIED** | with IPGP 2.19.0 the zip **no longer bundles any `kotlin-stdlib`** (the old zip carried `kotlin-stdlib-2.0.20` against a 2.0.21 compiler); the plugin uses the IDE's Kotlin runtime. Whether that runtime satisfies classes compiled by 2.4.21 is only proven by loading the plugin (item 5). |
| 10 | kotlinx-serialization-json bundled vs platform-provided | **PACKAGED; COLLISION UNVERIFIED** | the zip ships `kotlinx-serialization-json-jvm-1.11.0.jar` + `kotlinx-serialization-core-jvm-1.11.0.jar` alongside the plugin jar. Unit tests pass with them and the Plugin Verifier raises no problem; whether an IDE runtime already carrying serialization classes conflicts at class-load time is untested. |
| 11 | Tool-window descriptor attributes (`<toolWindow>` bean) | **UNVERIFIED** | see "Descriptor mapping notes" |
| 12 | Deprecated / experimental API on the target | **CLEAN on 262** | Plugin Verifier: 0 deprecated, 0 experimental, 0 internal usages. Two source deprecations fixed during the upgrade (`allVcsRoots` → `getAllVcsRoots()`, `ReadAction.compute` → `ReadAction.computeBlocking`); compiler-generated interface stubs removed with `jvmDefault = NO_COMPATIBILITY` (see "Code changes for the 2026.2 platform"). |
| 13 | Real icon assets (`svg` + `@2x`) | **NOT CREATED** | no placeholder image is fabricated; `plugin.xml` declares no icon |
| 14 | Keyboard shortcuts | **DELIBERATELY ABSENT** | specs/04 §6 requires no conflict with common IDE actions; assigned after the JB4 audit |
| 15 | Kotlin/IDE lint clean | **NOT RUN** | no `detekt`/`ktlint` run. `buildSearchableOptions` is **SKIPPED** by configuration, so the "no searchable options" signal from JetBrains during `buildPlugin` is not a pass. |
| 16 | Test run | **RUN — 161 tests, 0 failures, 0 errors, 0 skipped** | `./gradlew test --rerun` (online and `--offline`), fresh `build/test-results` each time |

### Compile-verify list (specific APIs written by inspection)

These are the calls most likely to need a correction on first *runtime*. All of them are
**type-checked** (`:compileKotlin` against IntelliJ IDEA 2026.2.3 with KGP 2.4.21 on the JDK 25
toolchain) and **binary-checked** (Plugin Verifier `Compatible` on IU-262.10968.63). What remains
unproven is *behaviour* — none of these has ever executed inside a running IDE, which is what
items 5–7 exist to establish:

- `SocketChannel.open(UnixDomainSocketAddress)` / `StandardProtocolFamily.UNIX` probe (JDK 16+).
- `CompletableFuture.orTimeout(...)`, `CompletableFuture.failedFuture(...)` (JDK 9+).
- `ReadAction.computeBlocking<V, E> { }` in `SandpaneContextProvider.collect` (was `compute`, deprecated on 262).
- `FileEditorManager.selectedTextEditor`, `ProjectLevelVcsManager.getVcsRootFor`, `getAllVcsRoots()` (the `allVcsRoots` property is deprecated on 262).
- `ContentFactory.getInstance().createContent(...)` + `Content.setDisposer(Disposable)`.
- `ToolWindowFactory.createToolWindowContent(project, toolWindow)` + `shouldBeAvailable(project)`.
- `NotificationGroupManager.getInstance().getNotificationGroup("Sandpane")`.
- `Messages.showDialog(project, message, title, arrayOf(...), 1, null)` (used instead of a
  yes/no overload whose return type differs across versions).
- `Application.invokeLater(Runnable, Disposable)`, `getService(Class)`.
- `AnAction.getUpdateThread()` override (required on 2024.2+).
- `kotlinx.serialization` `decodeFromJsonElement` / `encodeToJsonElement` experimental-API opt-ins.
- `intellijPlatform { intellijIdea(...) }`, `pluginVerifier()`, `testFramework(TestFrameworkType.Platform)`,
  `ideaVersion { sinceBuild/untilBuild }`, `pluginVerification { ides { current() } }` — all
  executed by IPGP 2.19.0 (`instrumentationTools()` was removed from IPGP and is gone from the build).

### Code changes for the 2026.2 platform

Compiling against 2026.2.3 with Kotlin 2.4.21 produced **no `e:` errors**. What changed, all with
public, non-deprecated, non-experimental replacements (checked with `javap -v` against the IDE jars):

1. `ProjectLevelVcsManager.allVcsRoots` (Kotlin property; on 262 it is `@Deprecated` with
   `ReplaceWith("getAllVcsRoots()")` and `@JvmName("getAllVcsRootsDoNotUse")`) → `getAllVcsRoots()`
   in `services/SandpaneContextProvider.kt` and `actions/ReviewChangesAction.kt`.
2. `ReadAction.compute(...)` (`@Deprecated`) → `ReadAction.computeBlocking(...)` (same signature and
   blocking contract, not deprecated, no `@ApiStatus` marker) in `services/SandpaneContextProvider.kt`.
3. `build.gradle.kts`: `jvmDefault = JvmDefaultMode.NO_COMPATIBILITY`. With Kotlin 2.2+'s default
   `-jvm-default=enable`, `SandpaneToolWindowFactory` received compiler-generated stubs for every
   default method of the platform's Kotlin `ToolWindowFactory` interface, and the first verifier run
   reported them as **4 deprecated** (`isApplicable`, `isDoNotActivateOnStart`) and **6 experimental**
   (`getAnchor`, `getIcon`, `manage`) API usages that the sources never make. With no-compatibility
   mode the class contains only its two real overrides and the verifier reports none.

Remaining compiler warnings (none are API deprecations): `java.lang.Object` used as a lock
(`CoreClient.kt:66`, `EventStream.kt:50,57` — "not recommended, use kotlin.Any"), unnecessary safe
calls now that platform types are non-null (`SandpaneContextProvider.kt:91,117,120`),
`ChatPanel.kt:592` "condition is always true", and 3 in tests (`CoreCommandsTest.kt:97,552`,
`ReplayCursorSemanticsTest.kt:97`). 10 `w:` lines in total on a clean compile; left as-is to keep the
upgrade diff to what the platform required.

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
├── settings.gradle.kts                   # plugin repositories + foojay toolchain resolver 1.0.0
├── build.gradle.kts                      # IPGP 2.19.0 + Kotlin 2.4.21 (executes: compile, test, buildPlugin, verifyPlugin)
├── gradle.properties                     # IDE / range / JDK / serialization pins + Kotlin flags
├── gradlew / gradlew.bat / gradle/wrapper/   # Gradle 9.8.1 wrapper, distribution sha256 pinned
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
    │   │   ├── model/Models.kt               # kotlinx mirrors of sandpane-protocol (wire names, 16 methods)
    │   │   ├── model/WorkspaceModeView.kt    # workspaceMode rendering; absence => UNVERIFIED/live-writable
    │   │   ├── ui/ChatPanel.kt               # Swing list/composer/pickers/attachments/status + 50 ms flush
    │   │   ├── actions/{StartTask,ReviewChanges,ApplyTask,RefreshSandboxes}Action.kt
    │   │   ├── actions/SandboxLifecycleActions.kt # Stop / Remove (two-step token) / Start (unsupported)
    │   │   ├── core/SandboxLifecycle.kt      # step-1 check, IssuedRemoval, remove flow, stop report
    │   │   ├── core/Idempotency.kt           # A2: keys, keyed requests, CONFLICT/unknown copy, replay notice
    │   │   ├── core/MethodDeadlines.kt       # per-method read deadlines (stop 360 s, remove 400 s)
    │   │   ├── ui/SandboxDialogs.kt          # remove confirmation content + sandbox chooser
    │   │   ├── services/{SandpaneContextProvider,EditorDiffProvider,SbxService,TaskMonitorService}.kt
    │   │   ├── services/FolderMatching.kt    # folder → Core project, pure and canonicalized on both sides
    │   │   └── settings/{SandpaneSettings,SandpaneConfigurable}.kt
    │   └── resources/META-INF/plugin.xml
    └── test/kotlin/labs/dkv/sandpane/
        ├── core/CoreClientFramingTest.kt     # byte-level framing + wire names        (29 tests)
        ├── core/CoreCommandsTest.kt          # guards, gates, the three cursor shapes  (30 tests)
        ├── core/SandboxLifecycleTest.kt      # A1 frames, token flow, stop report       (25 tests)
        ├── core/IdempotencyTest.kt           # A2 keys, features, CONFLICT copy, replay (19 tests)
        ├── core/ErrorAttributionTest.kt      # failure provenance sentences             (13 tests)
        ├── core/ProtocolDriftGuardTest.kt    # re-reads the Rust sources + schemas      (17 tests)
        ├── core/ReplayCursorSemanticsTest.kt # per-task vs shared-scalar replay         (7 tests)
        ├── services/FolderMatchingTest.kt    # folder matching + workspace-mode views  (12 tests)
        ├── services/SnapshotGapTest.kt       # why the sandbox list is missing          (3 tests)
        └── ui/RemoveConfirmationDialogTest.kt # hostile impact lines, external header    (5 tests)
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

The method surface is **16** (`Method::ALL` in Rust), of which **11** are the original protocol-v1
baseline, **3** are the additive discovery reads (`task.list`, `conversation.list`,
`conversation.history`) and **2** are addition A1 (`sandbox.stop`, `sandbox.remove`). All five
additive methods are gated on `system.probe`'s `methods` (`CoreMethods.REQUIRES_ADVERTISEMENT`):
not advertised ⇒ the action is visibly disabled and nothing is sent. There is deliberately **no**
`sandbox.start` (sbx v0.47 has none); the Start Sandbox action only shows that unsupported state. The additive fields are `CoreCapabilities.methods`,
`Project.repositories`, `SandboxSummary.workspaceMode` and the optional
`TaskSubscribeParams.afterSequences`.

This is checked **mechanically on every test run** by `ProtocolDriftGuardTest` (17 tests), which
reads the Rust sources and the schemas out of the working tree and compares them against the
Kotlin mirror: method names **and their order**, the `Method::parse` arms, the
`rpc-request.schema.json` `method` enum, every `pub const` numeric bound (evaluated, not copied), the
`WorkspaceMode`/`TaskStatus`/`FileChangeStatus` value sets (read from the generated serializers)
against Rust, `sandbox-create-spec.schema.json` and `change-set.schema.json`, the additive field names on
both sides, the three `task.subscribe` cursor rules as they appear in `sandpane-service`, and the
durable event kinds Core appends. Two classes are deliberately renamed on the Kotlin side
(`RpcResponse` → `RpcResponseFrame`, `RpcError` → `RpcErrorPayload`); their **field** names are
unchanged, and class names are not wire-visible.

### Tolerance for enum values a newer Core adds

Where Core **reports** a `TaskStatus` (`TaskSummary.status`, the `status.changed` payload), a
`FileChangeStatus` (`FileChange.status`) or a `WorkspaceMode` (`SandboxSummary.workspaceMode`), the
field is a `Reported<E>` (`model/Reported.kt`): `Known(value)` or `Unknown(raw)`. Before this, one new
value failed the whole `task.list` / `git.review` / `sandbox.list` / `sandbox.create` decode — and a
`conversation.send` reply after Core had already queued the task. Now:

| Value | Shown as | Behaviour |
|---|---|---|
| unknown task status | `Unknown status '<raw>' — this plugin is older than Core` | never terminal, never running; review/apply off; "nothing to review/apply" notices count such tasks |
| unknown `status.changed` | the row takes the unknown status and gets a note | an unreadable payload keeps the last status and leaves a note — neither is dropped silently |
| `conversation.send` reply with an unknown status | `Core accepted task …` | accepted (Core did queue it); no INTERNAL, so no duplicate-retry bait |
| unknown file status | listed with its raw status | **not selectable**: excluded from `selectedFiles`, listed under "NOT sent" in the Apply dialog and in the result notice; a set made only of them is refused |
| unknown workspace mode | `UNKNOWN — TREAT AS LIVE-WRITABLE` | the existing worst-case view; never isolated |

Truly malformed values still fail the frame: non-strings, `null` for a required field, and any
string that is empty, longer than 64 chars or not serde `snake_case` (every mirrored Rust enum is
`rename_all = "snake_case"`; the drift guard pins that). Outgoing fields (`TaskListParams.statuses`,
`SandboxCreateSpec.workspaceMode`) keep the closed enums.

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
- **Idempotency keys + features (A2).** `system.probe`'s `features` is parsed absent-tolerantly
  (older Core ⇒ none; unknown strings ignored). Only when Core advertises `idempotency-keys` does each
  user action (one chat Send; one `SbxService.createSandbox` call) get ONE fresh key — 32 lowercase hex
  from `SecureRandom`, never derived from content; without the feature no key is sent at all. The
  create `agent` field is gated on `sandbox-create-agent` (no longer inferred from `sandbox.remove`)
  and refused locally otherwise. On an UNKNOWN outcome of a keyed write (timeout, transport loss, Core
  `INTERNAL`, unusable reply) the chat shows a notification whose one expiring action is **"Retry
  safely"**: it resends the identical params with the same key, on that click only. Unkeyed: "outcome
  unknown — check before trying again", no retry offered. There is no automatic retry of any write and
  no replay-safe method set in this client. CONFLICT copy: key reused with different params / same key
  still in progress / A1 name lock ⇒ "nothing was run"; earlier outcome unknown ⇒ "outcome unknown —
  re-read state; a retry needs a new request" (never "nothing was run"); Core's own message is always
  shown revealed and capped (300 chars). A `replayed: true` answer shows "Core returned the result of
  your earlier identical request (replayed). It may be out of date; refreshing from Core." and is never
  shown as a fresh success: a replayed send does not seed its stored status and `task.list` is re-read;
  a replayed create re-probes `sandbox.list`. Decode failures on these paths never echo the payload.
  `createSandbox` has no UI caller, so only its service seam (`KeyedRequests`) is tested. Keys live 24 h
  in Core; after that, the same key would run again.
- **Sandbox lifecycle (A1).** Stop / Remove pick a sandbox from Core's last `sandbox.list` (including
  ones with no Sandpane binding). Stop: `{name}`, deadline 360 s; an absent `requeried` is shown as
  state UNKNOWN, never "stopped". Remove: step 1 `{name}` (no token key) off the EDT; Core's answer
  must be a `sandbox.remove` confirmation for that exact name with a 64-hex token, or nothing more
  happens; a native dialog (Core strings revealed + escaped via `DialogHtml`, impact capped at 20,
  bold "NOT CONFIRMED AS CREATED BY SANDPANE" first when `external`, expiry shown, "Remove Sandbox" vs Cancel with
  Cancel default and focused); only on Remove and before `expiresAt`, step 2 `{name, confirmToken}`
  off the EDT, deadline 400 s. The token is never displayed, and is masked in any logged late frame
  (`FrameRedaction`). Core serves one connection serially, so while a stop/remove runs, this IDE's
  other Core requests on the shared socket queue and may hit their own 15 s timeout (reported, not
  retried) — including **`task.cancel`, which can be delayed behind a running stop/remove** (accepted
  head-of-line-blocking follow-up W3: a dedicated connection for long calls, or concurrent dispatch
  in Core). The stop/remove future itself is not cancelled by that. When `external` is true the
  dialog's first line is the bold shared header "NOT CONFIRMED AS CREATED BY SANDPANE" plus "Core
  cannot confirm Sandpane created this sandbox (no Sandpane binding is recorded for this sbx id)." —
  it never claims the sandbox was made outside Sandpane. A step-2 `VALIDATION_FAILED` is worded "Core
  ran nothing" only for Core's token or sandbox-name refusal (prefixes pinned against the Rust
  source); any other is "not known". A malformed remove answer is never echoed (it may hold a token). Neither step is retried; a
  step-2 timeout/transport failure is "outcome unknown". The list is re-probed afterwards. Create has
  no UI in this plugin: `SandboxCreateSpec.agent` is typed and allowlisted (sbx v0.47 built-ins) only.
- **Allowlisted methods.** `CoreClient.request()` refuses anything outside the **16** protocol
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
- **Core/agent text cannot spoof the UI.** On 2026.2.3, `Messages.showDialog` dispatches to
  `AlertDialog`, whose message pane is always `text/html` (checked by disassembling the IDE jars;
  `MessageDialog` and `Messages.InputDialog` switch to HTML only on an `<html>` prefix). Every
  confirmation therefore goes through `DialogText.html` or `DialogHtml` (the Apply and send-context dialogs, whose Core/agent values sit in table cells) — an explicit `<html>` envelope around
  fully escaped text, with whitespace runs kept — which is inert on all three renderers. Before
  escaping, `VisibleText` shows control, line-break, bidi and zero-width characters as `\n` /
  `\u202E`-style escapes (by code point, so emoji and other non-ASCII text are untouched). The Apply
  dialog is built by `DialogHtml` as one table row per entry: the `[n]` marker (bold) in a
  `nowrap` column of its own, the path in the next column, and section headers (bold) outside the
  tables. The dialog word-wraps and force-breaks an over-long path at its width; with the table, a
  wrapped tail always starts inside the path column, to the right of every real marker, so a
  crafted path cannot render a fake entry or a fake "NOT sent" header (an earlier `<br>`-per-line
  layout could; `DialogLayoutTest` lays the real dialog HTML out in a `JEditorPane` with the
  platform's `HTMLEditorKitBuilder().withWordWrapViewFactory()` at fixed widths and a SansSerif 13
  font, searches for such a path, and keeps the old layout as a control that does fail). The
  AlertDialog's own pane — its width, CSS and font — was not built in a test: UNVERIFIED. NOT-sent entries carry their own `[x<n>]` markers. The
  dialog also flags any path that had hidden characters or literally contains an escape-looking
  sequence such as `\n` (also counting them past the 20 listed), elides absurdly long paths
  visibly, and points out selected paths that differ only in case or Unicode normalization (NFC +
  lower case: an approximation of APFS/NTFS folding). `MessageDialog`/`InputDialog` panes were not
  laid out in a test either (UNVERIFIED). Labels, list rows, tooltips, action descriptions, notifications and the chat
  detail pane apply the same treatment (`PlainText`, `notify`).
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
- `<depends>`: `com.intellij.modules.platform` and `com.intellij.modules.vcs` (declared on
  2026.2.3 by `lib/intellij.platform.vcs.impl.jar` → `intellij.platform.vcs.impl.xml`); no optional
  JCEF dependency (native Swing is the default and the fallback).
- Actions are nested inside the `labs.dkv.sandpane.Toolwindow` group (added to
  `EditorPopupMenu` and `ProjectViewPopupMenu`) instead of using `<reference>` to
  not-yet-registered ids, and the tool window toolbar builds them by id via `ActionManager`.
- `<idea-version>` is intentionally absent from `plugin.xml`; `patchPluginXml` supplies the
  pinned range, so no unverified range is committed.
- No icon is declared until a real asset exists (JB0 item 13).

## Checks actually run on this host

All Gradle rows were run on 09.10.2026 after the U4 upgrade; `build/test-results` and
`build/distributions` were deleted before each gate run so counts come from that run only.

| Check | Tool / command | Result |
|---|---|---|
| Gate, online | `./gradlew test --rerun buildPlugin verifyPluginStructure --console=plain` | `BUILD SUCCESSFUL in 15s`, `19 actionable tasks: 12 executed, 7 up-to-date`; first-ever run (IDE download; intermediate config with toolchain 21 and no `jvmDefault` change) was `BUILD SUCCESSFUL in 4m 40s` |
| Gate, offline from clean | `./gradlew clean --offline`, then `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache --console=plain` | `BUILD SUCCESSFUL in 17s`, `19 actionable tasks: 16 executed, 3 up-to-date`; `compileKotlin`, `compileTestKotlin`, `test`, `buildPlugin`, `verifyPluginStructure` executed |
| Unit tests | JUnit XML in `build/test-results/test` | **161 tests, 0 failures, 0 errors, 0 skipped**, 20 result files (both runs) |
| Gate after the anti-spoofing + enum-tolerance hardening, with the table-layout fix (10.10.2026; an intermediate 09.10.2026 run of the same command had 196 tests) | `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache --console=plain`; `./gradlew verifyPlugin --offline` | `BUILD SUCCESSFUL in 17s`; **205 tests, 0 failures, 0 errors, 0 skipped**, 26 result files; verifier `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`; 55 source files (32 main, 23 test) |
| Gate after the A1 sandbox-lifecycle client work (10.10.2026) | `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache`; `./gradlew verifyPlugin --offline` | `BUILD SUCCESSFUL in 16s`; **243 tests, 0 failures, 0 errors, 0 skipped**, 29 result files; verifier `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible` (report dir holds only verdict/telemetry/dependencies — no deprecated/experimental/internal usage files); 62 source files (36 main, 26 test) — re-run after the A1 security/phase-review fixes |
| Gate after the A2 client work (idempotency keys + features, 10.10.2026) | `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache`; `./gradlew verifyPlugin --offline` | `BUILD SUCCESSFUL in 15s`; **265 tests, 0 failures, 0 errors, 0 skipped**, 30 result files; verifier `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible` (no deprecated/experimental/internal usage files); 64 source files (37 main, 27 test) |
| Plugin Verifier | `./gradlew verifyPlugin` (verifier-cli 1.410, `ides { current() }`) | `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`; reused the cached IDE (no second IDE download); `verification-verdict.txt` → `Compatible` |
| Project configuration | `./gradlew verifyPluginProjectConfiguration` | one finding, deliberately not followed: `until-build property should be removed` (see "until-build is kept on purpose"). The Java-25 finding is resolved. |
| Bytecode target | class-file major of every class in `sandpane-jetbrains-0.1.0-scaffold.jar` | 241/241 at **69** (Java 25) |
| Kotlin warning surface | clean offline compile | **0** `e:`, **10** `w:` (listed under "Code changes for the 2026.2 platform") |
| Installable artifact | `unzip -l build/distributions/sandpane-jetbrains-0.1.0-scaffold.zip` | 1 163 019 bytes (plugin jar 551 292 bytes): plugin jar, `-searchableOptions.jar`, `kotlinx-serialization-{core,json}-jvm-1.11.0`; **no** `kotlin-stdlib`. Never installed anywhere. |
| Toolchain actually used | `./gradlew --version`, `./gradlew javaToolchains` | Gradle 9.8.1, Launcher JVM 23 (GraalVM CE); toolchain 25 = `Eclipse Temurin JDK 25 (25.0.3+9-LTS)`, `Detected by: Auto-provisioned by Gradle` |
| Wrapper integrity | `shasum -a 256 gradle/wrapper/gradle-wrapper.jar` | `3b8a2577…8e98` = the published `gradle-9.8.1-wrapper.jar.sha256` |
| Drift gate can fail (negative control) | mutated Kotlin mirror, then a mutated **copy** of the Rust sources via `-PsandpaneRepoRoot` | red in both directions with a message naming the drifted wire string; green after restore — see "Drift gate and its negative control" (recorded before U4; the gate ran green again in the suite above) |
| Protocol parity | `ProtocolDriftGuardTest` (runs with the suite) | 16 method names **in `Method::ALL` order**, service bounds evaluated from `pub const`, enum sets vs Rust **and** schemas, additive field names on both sides, cursor rules matched against the Rust text |
| Subprocess misuse (`ProcessBuilder`, `Runtime.exec`, `sh -c`, `bash -lc`) | grep over `src/main/kotlin` | **none** — no subprocess surface exists in this module |
| Internal/private API references (`com.intellij.internal`, JetBrains AI, `setAccessible`, `Unsafe`, reflection) | grep, plus Plugin Verifier | none |
| TCP / network surface | grep | none — every `TCP` hit is prose stating it is never used |
| Source inventory | `find src -name '*.kt' \| wc -l` | 46 files (28 main, 18 test) |

## NOT verified

- **`runIde` has never been launched.** No IDE has ever shown the tool window, the chat panel, the
  sandbox picker, the diffs, or any of these actions. Every UI behaviour in this module is
  written-against-documentation, not observed.
- **Plugin Verifier has run against one IDE only** (IU-262.10968.63). It is static: it proves the
  bytecode links against that IDE's public API, not that the plugin loads or behaves. Any other
  build, or any other IDE product (PyCharm, WebStorm, …), is unverified.
- **The packaged zip has never been installed or loaded** in any JetBrains product. Packaging is
  not proof of loadability: `<toolWindow>` wiring, `plugin.xml` class resolution, service
  instantiation, the bundled Kotlin runtime, and kotlinx-serialization coexistence with the IDE's
  own classes are all untested at runtime (JB0 items 8–12).
- **Kotlin 2.4.21 compiler vs the IDE's bundled Kotlin runtime** — the zip no longer bundles a
  stdlib, so the plugin runs on whatever Kotlin runtime 2026.2.3 ships. Compatible on paper (the
  verifier found no missing classes), unproven at runtime (item 9).
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
  `WorkspaceModeView`, `NdjsonFramer`, `ErrorAttribution`) are what the 161 tests cover, so wiring
  bugs inside those classes remain possible.
- **Older/newer Core compatibility** (testing this client against an older and a newer Core within
  the compatibility policy) has not been done; advertisement gating is tested against fabricated
  capability lists only.
- `docs/compatibility.md` still records "Gradle / Kotlin — not installed locally" for this client
  and none of the versions above. That file is the orchestrator's to update — recorded here rather
  than changed from inside this module.
