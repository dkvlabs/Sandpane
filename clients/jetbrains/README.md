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
> Re-run on 11.10.2026 after the A3a client work (project lifecycle: 22-method pin, `project.update` /
> `archive` / `unarchive` / two-step `delete` / `add_repository` / `remove_repository`,
> `includeArchived`, `archivedAt`): `./gradlew test --rerun buildPlugin verifyPluginStructure --offline
> --no-build-cache` passes with **303 tests, 0 failures, 0 errors, 0 skipped** across 32 test classes,
> and `./gradlew verifyPlugin --offline --rerun` (the plain command was up-to-date after the rebuild and
> printed no verdict) reports **`Compatible`** against IU-262.10968.63 (report dir holds
> only verdict/telemetry/dependencies — no deprecated/experimental/internal usage files). A3a is
> UNVERIFIED end to end: the seven new actions and dialogs were never shown in an IDE and never run
> against a running Core.
>
> Re-run on 11.10.2026 after the A3a combined-review fixes (both two-step flows fail CLOSED on an
> unreadable `expiresAt`; step 2 is built and written on the io pool, not the EDT; Core lines in the
> confirmation dialogs and chooser rows capped at 200 code points with "…"; the post-delete cleanup also
> runs on a step-2 NOT_FOUND or when an unknown outcome's re-read no longer lists the project):
> the same gate passes with **311 tests, 0 failures, 0 errors, 0 skipped** across 32 test classes
> (stable over five consecutive test runs; one earlier run during the fixes ended `:test FAILED` with no
> result files and was not reproduced), and `./gradlew verifyPlugin --offline --rerun` reports
> **`Compatible`** with no deprecated/experimental/internal usage files.
>
> Re-run on 11.10.2026 after the A3b client work (conversation lifecycle: 27-method pin, plus the review fixes — no silent Send-target move, single-flight Delete/Export, stricter export page checks —
> `conversation.rename` / `archive` / `unarchive` / two-step `delete` / paged redacted `export`,
> `includeArchived`, `archivedAt`, `sandboxId`, feature `conversation-sandbox-id`):
> `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline
> --no-build-cache` passes with **376 tests, 0 failures, 0 errors, 0 skipped** across 34 test classes
> (JUnit XML), and `./gradlew verifyPlugin --offline --rerun-tasks` reports **`Compatible`** against
> IU-262.10968.63 (report dir holds only verdict/telemetry/dependencies — no deprecated/experimental/
> internal usage files). A3b is UNVERIFIED end to end: the chat-panel controls, the rename/delete/export
> dialogs and the native save dialog were never shown in an IDE and no A3b request reached a running Core.
>
> Re-run on 11.10.2026 after the A4 client work (`conversation.send` mode: feature
> `conversation-send-mode`, composer Task / Discuss choice, `TaskSummary.mode` / `chosenSandboxName`;
> method pin unchanged at 27): `rm -rf build/test-results && ./gradlew test --rerun buildPlugin
> verifyPluginStructure --offline --no-build-cache` passes with **389 tests, 0 failures, 0 errors,
> 0 skipped** across 35 test classes (JUnit XML), and `./gradlew verifyPlugin --offline --rerun-tasks`
> reports **`Compatible`** against IU-262.10968.63. A4 is UNVERIFIED end to end: the Task / Discuss
> combo was never shown in an IDE and no A4 request reached a running Core.
>
> Re-run on 11.10.2026 after the A5 client work (`git.diff` + ChangeSet fields: 28-method pin with
> `git.diff` after `git.review`, 45 s git deadline for both, per-file read-only diff viewer, exact review
> paths): `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline
> --no-build-cache` passes with **402 tests, 0 failures, 0 errors, 0 skipped** across 36 test
> classes (JUnit XML); after the A5 review fixes (CR reveal in the patch view, VCS root chosen by
> `repoPath`) the same gate passes with **410 tests** across 37 classes, and `./gradlew verifyPlugin --offline --rerun-tasks` reports **`Compatible`**
> against IU-262.10968.63. A5 is UNVERIFIED end to end: no task created over the wire has Git context
> until A4b, so the Diff action has never reached a real `git.diff` answer; the chooser and viewer were
> never shown in an IDE.
>
> Re-run on 11.10.2026 after the A6 client work (`git.apply` for reviewed files: feature `git-apply`
> (5 known features), method pin unchanged at 28, 45 s apply deadline, per-file chooser + modal
> confirmation, verbatim review entries, honest result/lost-answer copy): `rm -rf build/test-results &&
> ./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` passes with
> **445 tests, 0 failures, 0 errors, 0 skipped** across 39 test classes (JUnit XML; 443 before the
> combined-review items J-I1/J-I4), and `./gradlew
> verifyPlugin --offline --rerun-tasks` reports **`Compatible`** against IU-262.10968.63. A6 is
> UNVERIFIED end to end: no task created over the wire has Git context until A4b, the chooser and the
> confirmation were never shown in an IDE, and no apply request reached a running Core.
>
> A7 client work (12.10.2026: verification commands + `project.context`, design 2026-10-09 §3.7;
> method pin **28 → 34**, feature `verification` = **6** known features, 45 s `project.context`
> and `verification.run` deadlines, a "Verification" tool-window tab). Gate counts are in "Checks actually run" below. A7 is
> UNVERIFIED end to end: running is disabled for every real sbx version until captures C-1, C-2, C-5
> and C-7 exist (Core answers `UNSUPPORTED_SBX_VERSION`), no task created over the wire is bound to a
> sandbox until A4b, and nothing of A7 was ever run in a real editor, app or IDE.
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
    │   │   ├── model/Models.kt               # kotlinx mirrors of sandpane-protocol (wire names, 34 methods)
    │   │   ├── model/WorkspaceModeView.kt    # workspaceMode rendering; absence => UNVERIFIED/live-writable
    │   │   ├── ui/ChatPanel.kt               # Swing list/composer/pickers/attachments/status + 50 ms flush
    │   │   ├── actions/{StartTask,ReviewChanges,ApplyTask,RefreshSandboxes}Action.kt
    │   │   ├── actions/SandboxLifecycleActions.kt # Stop / Remove (two-step token) / Start (unsupported)
    │   │   ├── core/SandboxLifecycle.kt      # step-1 check, IssuedRemoval, remove flow, stop report
    │   │   ├── core/Idempotency.kt           # A2: keys, keyed requests, CONFLICT/unknown copy, replay notice
    │   │   ├── core/MethodDeadlines.kt       # per-method read deadlines (stop 360 s, remove 400 s, add_repository 45 s)
    │   │   ├── core/ProjectLifecycle.kt      # A3a: validators, delete check/flow, honest copy, archived rules
    │   │   ├── actions/ProjectLifecycleActions.kt # A3a: edit, (un)archive, show archived, repositories, delete
    │   │   ├── ui/SandboxDialogs.kt          # remove confirmation content + sandbox chooser
    │   │   ├── ui/ProjectDialogs.kt          # A3a: delete confirmation, project/repository choosers, edit dialog
    │   │   ├── core/ConversationLifecycle.kt # A3b: title guard, delete check/flow/follow-up, honest copy, archived rules
    │   │   ├── core/ConversationExport.kt    # A3b: export pager (cursor/page-cap rules), file assembler, save flow
    │   │   ├── ui/ConversationControls.kt    # A3b: chat-panel buttons (rename/(un)archive/delete/export, show archived)
    │   │   ├── ui/ConversationDialogs.kt     # A3b: delete confirmation, export copy, rename dialog
    │   │   ├── core/SendMode.kt              # A4: Task / Discuss choice, send params, mode gate, display lines
    │   │   ├── ui/TaskRowText.kt             # A4: task row meta (status + Send mode + chosen sandbox name)
    │   │   ├── core/GitDiff.kt               # A5: git.diff bounds and honest refusal copy
    │   │   ├── ui/GitDiffText.kt             # A5: viewer title, disclosures, symlink line, revealed body
    │   │   ├── ui/GitDiffDialogs.kt          # A5: file chooser + read-only diff viewer (DialogWrapper)
    │   │   ├── core/GitApply.kt              # A6: git.apply constants, result/failure/event copy, single flight
    │   │   ├── services/ReviewSession.kt     # A6: one git.review answer (verbatim entries, reviewId, opened diffs)
    │   │   ├── services/ApplyPlan.kt         # A6: selectability, flags (a)/(b)/(c), mismatch refusal, submit
    │   │   ├── ui/ApplyConfirmation.kt       # A6: confirmation text (repository, every file, flags, statement)
    │   │   ├── ui/ApplyDialogs.kt            # A6: per-file checkbox chooser + modal confirmation (DialogWrapper)
    │   │   ├── model/Verification.kt         # A7: verification + project.context wire types (tolerant, open strings)
    │   │   ├── core/Verification.kt          # A7: Core messages, argv guard mirror, run target, single flight, copy, activity
    │   │   ├── ui/VerificationText.kt        # A7: approve/run/revoke confirmations (DialogHtml), result header
    │   │   ├── ui/VerificationDialogs.kt     # A7: argv list editor, confirmations, run picker, plain-text output viewer
    │   │   ├── ui/VerificationPanel.kt       # A7: the "Verification" tool-window tab (commands, suggestions, tasks, runs)
    │   │   ├── services/{SandpaneContextProvider,EditorDiffProvider,SbxService,TaskMonitorService}.kt
    │   │   ├── services/FolderMatching.kt    # folder → Core project, pure and canonicalized on both sides
    │   │   └── settings/{SandpaneSettings,SandpaneConfigurable}.kt
    │   └── resources/META-INF/plugin.xml
    └── test/kotlin/labs/dkv/sandpane/
        ├── core/CoreClientFramingTest.kt     # byte-level framing + wire names        (29 tests)
        ├── core/ProjectLifecycleTest.kt      # A3a frames, gating, delete flow, copy, validators (39 tests)
        ├── core/ConversationLifecycleTest.kt # A3b frames, gating, delete flow, copy, validator, UI state, single-flight (46 tests)
        ├── core/ConversationExportTest.kt    # A3b export paging, partial/failed, file shape, save/cancel (15 tests)
        ├── core/GitDiffTest.kt               # A5 frames (exact path + status), gating, flags, copy, exact paths (16 tests)
        ├── core/GitApplyTest.kt              # A6 frames (verbatim entries, reviewId, no selectedFiles), gate, copy, CONFLICT kinds, lost answers, events (22 tests)
        ├── services/ApplyPlanTest.kt         # A6 session, selectability, verbatim entries, mismatch refusal, flags (14 tests)
        ├── ui/ApplyConfirmationTest.kt       # A6 every file listed, flags, buttons, opens only from actionPerformed (5 tests)
        ├── core/VerificationTest.kt          # A7 frames (byte-exact argv), gating, guards, run target, keys/retry, copy, events, retry window, claim copy, row spaces (23 tests)
        ├── ui/VerificationUiTest.kt          # A7 output reveal, confirmations, argv fields keep LF, dialogs only from click handlers, no HTML, context on click, toString, edited notes (13 tests)
        ├── core/SendModeTest.kt              # A4 send frames, mode gate, keyed retry, open-string mode, copy, no echo (11 tests)
        ├── core/CoreCommandsTest.kt          # guards, gates, the three cursor shapes  (30 tests)
        ├── core/SandboxLifecycleTest.kt      # A1 frames, token flow, stop report       (27 tests)
        ├── core/IdempotencyTest.kt           # A2 keys, features, CONFLICT copy, replay, A6 create-busy CONFLICT (20 tests)
        ├── core/ErrorAttributionTest.kt      # failure provenance sentences             (13 tests)
        ├── core/ProtocolDriftGuardTest.kt    # re-reads the Rust sources + schemas      (29 tests)
        ├── core/ReplayCursorSemanticsTest.kt # per-task vs shared-scalar replay         (7 tests)
        ├── services/FolderMatchingTest.kt    # folder matching + workspace-mode views  (12 tests)
        ├── services/SnapshotGapTest.kt       # why the sandbox list is missing          (3 tests)
        ├── ui/RemoveConfirmationDialogTest.kt # hostile impact lines, external header    (6 tests)
        └── actions/ActionRegistrationTest.kt # every toolbar action id ↔ plugin.xml class (1 test)
```

Module layout deviates from specs/04 §2's sketch in two deliberate ways: models live in one
`model/Models.kt` (protocol mirror is easier to parity-check as a single surface than split
across `Projects/Chats/Tasks/Sandboxes.kt`; the A7 wire types are the one exception, in
`model/Verification.kt`), and the tool window has two contents: the chat panel and, since A7, the
"Verification" tab (`ui/VerificationPanel.kt`). Both are named here rather than silently.

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

The method surface is **34** (`Method::ALL` in Rust), of which **11** are the original protocol-v1
baseline, **3** are the additive discovery reads (`task.list`, `conversation.list`,
`conversation.history`), **2** are addition A1 (`sandbox.stop`, `sandbox.remove`), **6** are
addition A3a (`project.update`, `project.archive`, `project.unarchive`, `project.delete`,
`project.add_repository`, `project.remove_repository`) and **5** are addition A3b
(`conversation.rename`, `conversation.archive`, `conversation.unarchive`, `conversation.delete`,
`conversation.export` — in `Method::ALL` right after `conversation.history`, not at the end), **1** is
addition A5 (`git.diff`, right after `git.review`) and **6** are addition A7 (`verification.list`,
`verification.approve`, `verification.revoke`, `verification.run`, `verification.result`,
`project.context`, after `git.apply`). All twenty-three
additive methods are gated on `system.probe`'s `methods` (`CoreMethods.REQUIRES_ADVERTISEMENT`):
not advertised ⇒ the action is visibly disabled and nothing is sent. A6 adds **no** method: `git.apply` is
baseline, and its reviewed-file form is gated on the `git-apply` feature (the fifth entry of
`CoreFeatures.KNOWN`, drift-tested against Rust `FEATURES` and the schema examples). The A7 methods
additionally need the `verification` feature (the sixth entry of `CoreFeatures.KNOWN`). There is deliberately **no**
`sandbox.start` (sbx v0.47 has none); the Start Sandbox action only shows that unsupported state. The additive fields are `CoreCapabilities.methods`,
`Project.repositories`, `SandboxSummary.workspaceMode` and the optional
`TaskSubscribeParams.afterSequences`.

This is checked **mechanically on every test run** by `ProtocolDriftGuardTest` (29 tests), which
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
| unknown file status | listed with its raw status | **not selectable** (A6): its Apply checkbox is disabled with "status unknown to this plugin build", so it can never be among the sent entries |
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
- **Project lifecycle (A3a).** Seven actions in the Sandpane group, each gated on its method being
  advertised (visible but disabled, saying why, when not): **Edit Project** (`DialogWrapper` with a
  one-line name and a multi-line description; `doValidate` mirrors `Validator::project_name` /
  `project_description` exactly — 1..=120 / ≤ 2000 code points, every Cc refused in a name, `\n` the only
  control allowed in a description, the 14 spoofing format characters refused, no trimming, empty
  description clears it; only changed fields are sent), **Archive** / **Unarchive** (Unarchive reads
  `project.list {includeArchived:true}` itself), **Show Archived Projects** (a `ToggleAction` stored as a
  UI setting; honoured only when Core advertises `project.archive`, because a pre-A3a Core ignores
  `includeArchived` — the flag is never sent there), **Add Repository** (native
  `FileChooserDescriptorFactory.createSingleFolderDescriptor()`; refused with an explicit state when
  the project folder or the chosen folder is not visible to this process — cross-host mapping is
  unsupported; Core validates the folder), **Remove Repository** (picked from Core's own
  `repositories`), **Delete Project** (the A1 two-step pattern: step 1 `{projectId}` with no token key;
  the answer must be a `project.delete` confirmation for the same project id with a 64-hex token, not
  `external`, with no `deleted` flag — the name may differ after a rename and Core's current name is
  shown; native `Messages.showDialog` with name, id, expiry and up to 20 revealed impact lines, "Delete
  Project" vs Cancel with Cancel default and focused; the expiry is re-checked at click time; step 2
  `{projectId, confirmToken}` only on "Delete Project", built and written on the io pool after the
  dialog returns (never on the EDT); an `expiresAt` that does not parse fails CLOSED — no dialog, no
  step 2, "the confirmation cannot be used; run Delete Project again" (A1 Remove Sandbox now does the
  same); neither step is retried; the token is never shown, logged or persisted). Every Core line in
  the delete/remove dialogs and every project/sandbox/repository chooser row is capped at 200 code
  points with "…" (`text/DisplayCap`). The chooser lists archived projects labeled `[archived]` and keeps OK
  disabled with Core's reason ("project is archived; unarchive it first; nothing was changed") for
  edit / repository changes; unarchive and delete stay allowed. The chat composer is disabled for an
  archived project (Core refuses conversation.send there). Copy: only Core's **exact** refusals (code
  and text, pinned against `project_lifecycle.rs`) and the step-2 token rejection say "nothing was
  deleted / removed / added / changed"; any other refusal shows Core's code and text with no claim;
  INTERNAL, an unusable reply, a timeout or a lost connection is "outcome UNKNOWN", and the follow-up
  re-read asks for archived projects too (the copy says so only when Core can list them). "Deleted" is
  said only on `deleted: true`; a step-1 failure always says the project was not deleted. Every
  mutation re-reads `project.list`. When Core says the project is gone — `deleted: true`, a step-2
  `NOT_FOUND` raised by Core, or an unknown outcome whose re-read (successful, archived included) no
  longer lists it (`ProjectDeleteFollowUp`) — each window drops its in-memory state for the project
  (conversation list, tracked task rows); `SandpaneSettings` holds no per-project entry by
  design, so nothing on disk needed clearing.
- **Conversation lifecycle (A3b).** Native Swing controls under the chat picker
  (`ui/ConversationControls`), each gated on its method being advertised (visible but disabled with the
  reason when not) and on Core's `archivedAt` only: **Show archived** (a UI view setting,
  `SandpaneSettings.showArchivedConversations`; `includeArchived:true` is sent only when Core advertises
  `conversation.archive`, otherwise refused locally — a pre-A3b Core would ignore it), **Rename…**
  (`DialogWrapper`; `ConversationGuards` mirrors `Validator::conversation_title` exactly — 1..=200 code
  points, every Cc and the 14 spoofing format characters refused, no trimming — plus rename's
  whitespace-only refusal using Rust's `trim` set, the Unicode White_Space property, not Kotlin's
  `isWhitespace`), **Archive** / **Unarchive**, **Delete…** (the A1 two-step pattern exactly as for
  projects: step 1 `{conversationId}` with no token key; a `conversation.delete` confirmation for the
  same id with a 64-hex token, not `external`, with a readable `expiresAt` or it FAILS CLOSED; native
  `Messages.showDialog` with title, id, expiry and up to 20 impact lines, each capped at 200 code points
  and revealed, Cancel default and focused; expiry re-checked at click time; step 2 built and written on
  the io pool; neither step retried; the token never shown, logged or persisted;
  `ConversationDeleteParams.toString` redacts it) and **Export…** (below). An archived conversation is
  labeled `[archived]`; its history stays readable; the composer and Rename are disabled with Core's
  reason; in an archived project the PROJECT reason comes first (Core's order) and only Archive, Delete
  and Export stay enabled. Delete is never pre-judged from local task views — Core's CONFLICT is the
  only answer (rule 3). "Sandbox chosen at creation: NAME (a stored name, not a live binding)" is shown
  only when Core advertises `conversation-sandbox-id`; "not in the current sandbox list" only when that
  list was actually read. Copy: Core's exact §3.3 messages (`conversation is archived; …`, `conversation
  has tasks …`, `conversation not found`, rename's blank-title message and A3a's project message, all
  pinned against `conversation_lifecycle.rs`) say "nothing was …"; INTERNAL / unusable reply / timeout /
  transport loss on a mutation is "outcome UNKNOWN"; a send refused because the conversation (or its
  project) is archived is now worded as such (it used to be NOT_FOUND). Every mutation re-reads
  `conversation.list`; after `deleted: true`, a Core NOT_FOUND at step 2, or an unknown outcome whose
  re-read (`{projectId, includeArchived:true, limit:500}`, successful, FEWER than 500 rows — the list has
  no truncation flag) no longer lists it, the window drops its selection, transcript and tracked task
  rows for the conversation. Nothing per conversation is persisted.
  **The Send target never moves on its own** (review W1): when a refresh no longer lists the selected
  conversation (e.g. it was just archived while Show archived is off), the picker selects NOTHING —
  never another conversation — and stays so on later refreshes of that project until the user picks;
  with nothing selected the composer is disabled — "select a conversation to continue" only when the
  picker has rows; otherwise it says why there is nothing to pick (no project, Core lists none,
  `conversation.list` unadvertised or failed), so an unsupported state reads as such. Core's first
  conversation is auto-shown only on the initial load of a project. Archive's success copy adds
  "Archived conversations are hidden; turn on Show archived to see or unarchive it." when it is hidden.
  **Single flight** (review Info 2): while a Delete (step 1, dialog, step 2) or an Export (pages, save
  dialog, write) runs, its button is disabled and a second click sends nothing and says so
  (`SingleFlight`).
  `conversation.create` (A3b now validates its title): `SbxService.createConversation` normalises the
  title first (`ConversationGuards.titleForCreate`, the shared cross-client rule — every character Core
  refuses becomes a space, whitespace collapses, cut by code point to 80, blank sends "" so Core stores
  "Untitled conversation"). No caller in this plugin currently derives a title from a prompt.
- **Export (A3b).** Before: a confirm dialog with "Redaction is best-effort; review the export before
  sharing it." and the scope note. `ConversationExportPager` loops `conversation.export` from
  `afterSequence: 0` until `truncated` is false, requires `nextSequence` to strictly increase while
  truncated (else stops: PARTIAL), stops after 200 pages (PARTIAL), and rejects a page whose `format` is
  not `sandpane.conversation-export.v1`, that is for another conversation, that carries a message of
  another conversation, or that does not mark its redaction `bestEffort: true`; ANY page failure means no
  dialog and no file. Then the native `FileChooserFactory.createSaveFileDialog` (non-deprecated
  `FileSaverDescriptor(title, description, "json")`; the description carries the replacement count and
  partial status; default name `<sanitized-redacted-title>-export.json`); Cancel writes nothing. The
  file — `{format, exportedAt, conversation, messages, redaction{bestEffort:true, replacements, byKind},
  complete, note}` with counts SUMMED across pages (absent kinds = 0) — is written with `java.nio` to
  exactly the chosen path (no temporary sibling) on the io pool. After: a notification with the message
  count, the replacement count by kind, PARTIAL when so, and the best-effort copy. Export content is
  never logged; a page that does not decode becomes fixed text (`ConversationExportResult.toString`
  prints counts only). Export is a read, so its failures say "No file was written", never "unknown".
- **Send mode (A4).** A **Task / Discuss** combo beside the Send button (`ChatPanel`, native Swing).
  It defaults to Task and is NOT remembered: it resets to Task whenever the selected conversation
  changes. It is enabled only when Core advertises `conversation-send-mode`; otherwise it is shown
  disabled at Task with "not supported by this Core". Task omits `mode` (the frame is byte-identical
  to an A2/A3b frame); Discuss sends `"mode":"discuss"`. `KeyedRequests.newSend` and `retrySend`
  refuse a `mode` for a Core that does not advertise the feature (nothing is sent, no key is minted):
  a pre-A4 Core silently drops it and would record a discussion as a task. The composer passes the
  user's SELECTED choice as-is (review W3): a Discuss that meets a Core without the feature (a reconnect
  raced the combo reset) is refused visibly with nothing sent and the text kept in the composer — it is
  never silently sent as a Task. "Retry safely" resends the
  prepared params unchanged, `mode` included. The tooltip says only what Core does: it records the
  requested mode, and **neither Task nor Discuss runs an agent in this build** (both stay queued). Core's
  `mode must be "task" or "discuss"` refusal is worded as Core's ("Core did not accept the message").
  Task rows and the "Core accepted task" line show Core's `TaskSummary.mode` as "Send mode: …" (an open
  string: an unknown value is shown as-is) and `chosenSandboxName` as "sandbox chosen by its chat — not
  where it runs: …", both revealed and capped, never from the local combo. `chosenSandboxName` is
  display-only: it never fills `TaskView.sandboxName` (the binding), and this plugin has no isolation
  label, stop/remove task count or scope logic for it to feed (a source-scan test fails if any other
  file starts reading it). `sandbox.remove`'s new A4 impact line ("N unfinished task(s) were sent from
  chats that chose this sandbox name; removing it does not cancel them") goes through the existing
  revealed, escaped, capped impact rendering.
- **Undecodable replies are never echoed** (A4 review I3). kotlinx puts a snippet of the JSON input in
  its decode messages, so `ErrorAttribution` maps `SerializationException` (and any other
  `IllegalArgumentException`) to fixed text ("…its content is not shown"), and `task.list` rows decode
  through the fixed-text `decodeOrFixed` path. A row with a non-string `mode` is never quoted back.
- **Per-file diff (A5).** After "Review changes", the notification offers **Show file diff…** only when
  Core advertises `git.diff` (otherwise it says "Per-file diff: not supported by this Core" and offers
  nothing). A native chooser lists Core's change entries as plain text; the selection IS Core's
  `FileChange`, so `git.diff` sends its `path` byte-for-byte (no trim, normalization or validation —
  a tab, newline, quote or non-ASCII name goes through unchanged) and ALWAYS its wire `status` (a path
  can be listed twice). `maxBytes` is omitted (Core's 262 144 default) and could never exceed 524 288.
  The call runs on ConnectionManager's io pool with the 45 s git deadline (also now `git.review`'s); the
  read-only viewer (`DialogWrapper` + non-editable monospace `JTextArea`, which never renders markup)
  opens on the EDT. The patch is untrusted: shown revealed (hidden, bidi, U+2028/U+2029 characters
  become visible escapes), never applied, copied into the project, written to a temp file or run.
  The viewer is named from the JSON `path` / `oldPath` (revealed, capped), never from the patch header.
  Disclosures: `binary` → "treated as binary (possibly by repository attributes) — no text diff
  shown"; `truncated` → "diff truncated at N bytes"; `lossy` → "contains bytes that are not valid
  UTF-8; shown with replacement characters"; renames as `oldPath → path`; an untracked mode-120000
  patch as "symlink → target" (read from fixed line positions — Core C-quotes a newline in a header
  name, so a file name cannot forge the mode line); an empty patch as "Core returned an empty
  patch". Nothing ever says "no changes". Core's exact refusals (no Git context, worktree removed,
  work tree redirected, path not in / listed twice in the change list, non-UTF-8 path, the untracked
  read refusals, submodules) each say nothing was read; INTERNAL says git failed and nothing was
  changed; a timeout says "Core did not answer in time — no file was changed (git.diff is
  read-only)". The review summary shows `repoPath` (revealed, capped), renames as `old → new`, and —
  if Core ever reports `uninspected` paths — "N paths were not inspected by Core — this change list
  is NOT complete". Exact review paths: `EditorDiffProvider.containPath` no longer trims or refuses
  control characters (a tab or newline is a real file-name character); it refuses only an empty
  path, a NUL, or an escape from the repository root.
  A5 review fixes: a carriage return in the patch is never obeyed or hidden — a CRLF ending and a lone
  CR both show as `\r` (the patch is split on `\n` only), and a CRLF patch adds "contains N lines with
  carriage returns (CRLF) — shown as \r". Review navigation now resolves paths against the IDE VCS
  root whose canonical path equals Core's `repoPath` (`ReviewRoots.choose`, symlinks resolved), never
  simply the first root; with no match it warns "Core's repository (…) is not a VCS root of this
  project" and resolves nothing (no fallback to another root or `basePath`); a Core that sends no
  `repoPath` likewise resolves nothing and says so. The Diff action is unaffected (Core reads by task
  and path, never an IDE root).
- **Apply reviewed files (A6, design 2026-10-09 §3.6).** Enabled only when Core advertises the
  `git-apply` feature (`git.apply` itself is a baseline method, so the method list proves nothing);
  otherwise the action is disabled with "Apply is not implemented by this Core (it does not advertise
  the git-apply feature); nothing is sent", and `CoreCommands.gitApply` refuses locally as well.
  Flow, all on one user gesture: **Sandpane: Apply Reviewed Files…** (`ApplyTaskAction.actionPerformed`,
  EDT) → a modal per-file chooser over the entries of ONE `git.review` answer (checkboxes, "Select
  all", nothing pre-ticked, a "Diff…" button per row when `git.diff` is advertised) → the mandatory
  modal confirmation → `git.apply` on ConnectionManager's io pool with the 45 s git deadline. The
  review notification only says how to apply; nothing opens from chat, agent or tool text, a timer or
  a reconnect (a source-scan test pins that both dialogs are constructed only inside
  `actionPerformed`).
  - **What is sent:** `{taskId, expectedBase, reviewId, entries}` where `entries` are the review
    answer's OWN JSON objects for the ticked rows (kept by `ReviewSession`, never rebuilt from the
    typed view, so key order and fields this build does not model survive) and `expectedBase` is the
    review's full base. `selectedFiles` no longer exists in `GitApplyParams`, so it cannot be sent.
  - **Selectable rows:** a known status and either `taskBlob` + `taskMode` or `deleted`, never mode
    `120000`. Disabled rows say why: "symlinks are never applied"; "too large or unreadable to apply
    (over 32 MiB)" (a reviewed entry with neither field); "no reviewed content id" (only one of the
    two fields, or a review without `reviewId` — not a `host_worktree` task); "status unknown to this
    plugin build". A rename is one row (`oldPath → path`). The only count limit is Core's 1000.
  - **Confirmation** (`ApplyConfirmationDialog`, a `DialogWrapper` laid out by the platform's
    word-wrapping HTML kit in a scroll pane): names the repository (`repoPath`, revealed and capped),
    lists EVERY selected file with its status (no "… and N more"; a CR shows as `\r`), and separately
    flags (a) content never fully shown — binary, truncated, or never opened in a Diff view in this
    review; (b) executable entries (`taskMode` 100755); (c) paths that run automatically —
    `.husky/`, `.githooks/`, `.vscode/`, `.idea/` (any depth), `.github/workflows/` (root), `.envrc`
    and `.gitattributes` (any depth), `.gitmodules` (root) and anything under Core's repo-relative
    `hostHooksPath`, matched on path components, case-folded, on `path` and a rename's `oldPath`.
    It states "Writes these files into your working tree and stages them. Nothing is committed. The
    content is the version Core hashed when you reviewed." A dirty host is disclosed, not refused
    (Core's gate covers the touched paths only). The OK button reads "Apply N files"; **Cancel is the
    default button and has the initial focus**.
  - **Mismatch rule:** if a `git.diff` opened in this review (from the review notification or the
    chooser) returned a `taskBlob` different from that entry's — or none for an entry that has one —
    nothing is sent: "<path> changed after you reviewed it — review again", with a **Review again**
    action. A review from another Core instance (Core restarted; reviews live in Core memory) is
    discarded with the same offer.
  - **Results:** success "Applied N files to <repoPath> (staged, not committed)" plus mode changes;
    `partial` is a WARNING ("Not a success: some files may have been written or staged") quoting
    Core's reason uncut (it names `git status` / `.git/index.lock`); aborts keyed on Core's exact
    constants — entries not matching a review and "changed since it was reviewed" offer Review again,
    "does not apply cleanly" lists git's paths, "git could not check the patch" is never worded as a
    conflict, both "git apply was not started" texts (`MSG_WRITE_NOT_RUN`, `MSG_WRITE_TOO_LATE`) say
    git apply was never started and nothing was written, anything else is shown verbatim (revealed, capped at 2 000 code points). CONFLICT is
    keyed on Core's texts: the writer lock ("busy … apply again after that operation finishes"), a
    direct mount ("stop or remove that sandbox or task first" — never "try again") and, since Core's
    W-N1 change, a direct-mount sandbox being created ("once it exists, Core refuses every apply
    until you stop or remove it"). The matching `sandbox.create` CONFLICTs for a direct_mount create
    (`msg_create_repo_busy`, `msg_create_mount_in_progress`, ending "; nothing was created") read
    "repository busy — nothing was created; try again when it finishes", with Core's text shown and
    no "Retry safely". A timeout reads "Core
    did not answer in time — the apply may have been applied; check `git status` in <repoPath>
    before retrying"; a dropped connection or an unreadable answer is the same lost answer, never
    "nothing was sent". Only this plugin's own pre-socket refusals say nothing was sent.
  - **Afterwards:** single-flight per task (`ApplyInFlight`), never retried (no "Retry safely" for
    git.apply). When files may have changed it marks the VCS view dirty
    (`VcsDirtyScopeManager.markEverythingDirty`) and asks the VFS to re-read the repository root —
    both read-only; this plugin writes no project file. Any answer that reached Core discards the
    used review (selection and diff evidence) and runs a fresh `git.review`.
  - **Events:** `git.apply.started`, `git.applied`, `git.apply.failed` and `git.apply.reconciled`
    are Core lifecycle kinds with honest notes (files count; "may have been written" for a partial;
    "Core restarted during an apply and cannot know for sure what was written … check `git status`"
    for reconciled). Payloads are read as optional/open and never echoed when unreadable.
  - **Display:** a host_worktree pure rename's empty patch reads "renamed, content unchanged".
- **Verification commands and project context (A7, design 2026-10-09 §3.7).** A "Verification"
  tab in the tool window (`ui/VerificationPanel.kt`) lists the chosen project's approved commands
  (`verification.list`, read automatically), Core's detected suggestions (`project.context`, 45 s
  deadline, read ONLY when the user clicks **Detect suggestions** — never on reload, reconnect or a
  project switch), the project's tasks and the runs this IDE has seen. Everything is gated on the method being advertised
  **and** the `verification` feature; otherwise the controls are disabled and nothing is sent.
  - **Approve** (Add…, or Approve on a suggestion): a list editor with ONE text field per argv
    element (no one-line field, no shell-like splitting; `filterNewlines` is off so a pre-filled LF
    survives), then a modal confirmation listing every element revealed on its own row, with the
    count, "do not put secrets in commands", that approval binds this exact list to this project,
    and the suggestion's notes — only while the argv is byte-for-byte the suggestion's; an edited
    list drops the notes and says so. Every confirmation (approve, run, revoke) is PLAIN text: a
    non-editable `JTextArea` with `html.disable`, one revealed line per row — no HTML view anywhere
    in A7. In list rows and dialog lines, spaces other than U+0020 (U+00A0, U+2000–U+200A, U+202F,
    U+205F, U+3000, …) and the `⟨ ⟩` delimiters inside an element are shown as `\uXXXX`, so one
    element never looks like two. Client checks mirror Core's `verification_argv` exactly (64 elements, 4096 bytes each,
    16 KiB total, NUL, control characters except TAB/LF, empty or `-`-leading program); the label
    check is blank-only. Nothing is ever approved or run automatically from a suggestion.
  - **Run** (per task): the target is the task's BINDING (`TaskSummary.sandboxName`, never the A4
    chosen sandbox name) and the mode of the single `sandbox.list` entry with exactly that name; no
    binding, no list, not exactly one match or an unknown mode means "this task is not bound to a
    sandbox" and nothing is sent. The modal run dialog picks from Core's approved list only and shows
    the sandbox, the mode and its warning (direct mount is live-writable; a host worktree is the
    task's worktree). Each gesture mints a fresh idempotency key; "Retry safely" (same key, same
    params) is offered only after a LOST answer (the run request waits 45 s, longer than Core's
    synchronous version + identity gates, `RunLimits::PROBE` + `QUERY`, before it starts the run), which reads "may have started", and only within
    23 h of the ORIGINAL send (Core keeps keys 24 h); after that the claim is released and the copy
    says it is too late to retry safely. Single flight per task; while a lost answer holds the claim,
    the disabled Run says to choose Retry safely or Do not retry in the Notifications tool window. A
    started run follows the task's events on the EDT without passing the list's (possibly stale)
    `TaskSummary`, so starting a verification never changes a task's displayed status. `toString` of
    every A7 type shows ids, sizes and counts only. Run needs Core's idempotency-keys feature. A Stop Sandbox on a sandbox with a run this IDE
    saw start (and not finish) asks first.
  - **Output** (`verification.result`): a non-modal dialog with read-only monospaced plain
    `JTextArea`s (stdout / stderr tabs). CR shows as `\r`, every C0/C1 control except LF and TAB is
    escaped; never a console, a hyperlink filter or HTML. The header shows the outcome as an open
    string — exit status N "as reported by sbx exec", never "passed" or green — and every
    disclosure (truncated, redaction best-effort counts, output withheld, output incomplete).
  - **Copy:** `UNSUPPORTED_SBX_VERSION` is shown as the version gate (not a command failure);
    frame and secret refusals show Core's message plus its `details` / hint (`CoreRpcException`
    now carries `details`); `verification.started` / `.finished` events are notes that never carry
    output and never change the task status. Output, argv and notes are never logged.
- **Allowlisted methods.** `CoreClient.request()` refuses anything outside the **34** protocol
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
  crafted path cannot render a fake entry or a fake flag header (an earlier `<br>`-per-line
  layout could; `DialogLayoutTest` lays the real dialog HTML out in a `JEditorPane` with the
  platform's `HTMLEditorKitBuilder().withWordWrapViewFactory()` at fixed widths and a SansSerif 13
  font, searches for such a path, and keeps the old layout as a control that does fail). The
  AlertDialog's own pane — its width, CSS and font — was not built in a test: UNVERIFIED. A6 flag rows carry their own `[a<n>]` / `[b<n>]` / `[c<n>]` markers. The
  dialog also flags any path that had hidden characters or literally contains an escape-looking
  sequence such as `\n`, and elides absurdly long paths visibly. (The A6 confirmation is a
  `DialogWrapper` with a `JEditorPane` built by the same `HTMLEditorKitBuilder().withWordWrapViewFactory()`
  the layout test uses, so the tested layout is the shown one — still never shown in an IDE.) `MessageDialog`/`InputDialog` panes were not
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
| Gate after the A3a client work (project lifecycle, 11.10.2026) | `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache` (after deleting `build/test-results` and `build/distributions`); `./gradlew verifyPlugin --offline --rerun` | `BUILD SUCCESSFUL`; **303 tests, 0 failures, 0 errors, 0 skipped**, 32 result files; verifier `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible` (no deprecated/experimental/internal usage files); 69 source files (40 main, 29 test) |
| Gate after the A3a combined-review fixes (11.10.2026) | same two commands (`verifyPlugin --offline --rerun`) | `BUILD SUCCESSFUL in 15s`; **311 tests, 0 failures, 0 errors, 0 skipped**, 32 result files (two fresh gate runs and three further `test --rerun` runs all green); verifier `Compatible` (no deprecated/experimental/internal usage files); 70 source files (41 main, 29 test) |
| Gate after the A3b client work (conversation lifecycle, 11.10.2026) | `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache`; `./gradlew verifyPlugin --offline --rerun-tasks` | `BUILD SUCCESSFUL in 18s`; **376 tests, 0 failures, 0 errors, 0 skipped**, 34 result files (ConversationLifecycleTest 46, ConversationExportTest 15, ConversationSelectionTest 4, ConversationReconcileTest 4, ProtocolDriftGuardTest 23, CoreClientFramingTest 29); verifier `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible` (no deprecated/experimental/internal usage files); 76 source files (45 main, 31 test); zip 1 628 803 bytes; 7 Kotlin `w:` on the full recompile (`verifyPlugin --rerun-tasks`), all in pre-existing code (none in A3b files) |
| Gate after the A4 client work (send mode, 11.10.2026) | `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache`; `./gradlew verifyPlugin --offline --rerun-tasks` | `BUILD SUCCESSFUL in 15s`; **389 tests, 0 failures, 0 errors, 0 skipped**, 35 result files (SendModeTest 11, ProtocolDriftGuardTest 24, RemoveConfirmationDialogTest 7, IdempotencyTest 19, CoreClientFramingTest 29); verifier `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible` (no deprecated/experimental/internal usage files); 79 source files (47 main, 32 test); zip 1 644 556 bytes; the same 7 Kotlin `w:` on the full recompile, all in pre-existing code (none in A4 files) |
| Gate after the A5 client work (git.diff, 11.10.2026) | `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache`; `./gradlew verifyPlugin --offline --rerun-tasks` | `BUILD SUCCESSFUL in 15s`; **402 tests, 0 failures, 0 errors, 0 skipped**, 36 result files (GitDiffTest 12, ProtocolDriftGuardTest 25, CoreClientFramingTest 29); verifier `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible` (no deprecated/experimental/internal usage files); 83 source files (50 main, 33 test); zip 1 676 534 bytes; the same 7 Kotlin `w:` on the full recompile, all in pre-existing code (none in A5 files) |
| Gate after the A5 review fixes (W3 CR reveal, I3 VCS root, 11.10.2026) | same two commands | `BUILD SUCCESSFUL`; **410 tests, 0 failures, 0 errors, 0 skipped**, 37 result files (GitDiffTest 15, ReviewRootTest 5); verifier `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible` |
| Gate after the A6 client work (git.apply for reviewed files, 11.10.2026) | `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache`; `./gradlew verifyPlugin --offline --rerun-tasks` | `BUILD SUCCESSFUL`; **445 tests, 0 failures, 0 errors, 0 skipped**, 39 result files after the combined-review items J-I1/J-I4 (443 before; GitApplyTest 22, IdempotencyTest 20, ApplyPlanTest 14, ApplyConfirmationTest 5, GitDiffTest 16, ProtocolDriftGuardTest 27); verifier `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible` (no deprecated/experimental/internal usage files); 90 source files (54 main, 36 test); the same 7 Kotlin `w:` on the full recompile, all in pre-existing code (none in A6 files). RED evidence: 18 deliberate mutations of the A6 code (gate, mismatch check, timeout/partial/CONFLICT copy, symlink rule, flag (a)/(c), default button, rename copy, event notes, full listing, deadline, Core-message drift, dialog outside `actionPerformed`, lost connection, typed re-encoding of entries) each turned the named test red, and were reverted |
| Gate after the A7 client work (verification + project.context, 12.10.2026) | `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache`; `./gradlew verifyPlugin --offline --rerun-tasks` | `BUILD SUCCESSFUL`; **474 tests, 0 failures, 0 errors, 0 skipped**, 41 result files (VerificationTest 19, VerificationUiTest 8, ProtocolDriftGuardTest 29, CoreClientFramingTest 29, GitApplyTest 22, ProjectLifecycleTest 39, ConversationLifecycleTest 46); verifier `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`; 97 source files (59 main, 38 test); zip 1 920 514 bytes; invisible-character scan of the 25 changed files: 0. RED evidence: before the change the drift gate failed 3 tests (methods/order, advertisement, features) against Core's A7; 12 deliberate mutations of the A7 code (feature gate, CRLF folding, argv newline filter, Retry always offered, exit 0 as passed, constant key, run target fallback, deferred dialog, dropped hint/details, dropped outputIncomplete, unsupported version worded as failure, missing binding statement) each turned the named test red, and were reverted |
| Gate after the A7 review fixes (J-W1, J-W2, J-I1, J-I2, J-I3, J-I5, D-I4, D-I5, run deadline; 12.10.2026) | `rm -rf build/test-results && ./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache`; `./gradlew verifyPlugin --offline --rerun-tasks` | `BUILD SUCCESSFUL`; **483 tests, 0 failures, 0 errors, 0 skipped**, 41 result files (VerificationTest 23, VerificationUiTest 13, ProtocolDriftGuardTest 29); verifier `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`; 97 source files; zip 1 930 649 bytes. RED evidence: 10 new tests failed against the pre-fix behaviour (kept behind minimal seams), the run-deadline drift assertion failed with the constant unwired (`expected:<45000> but was:<15000>`), and 11 mutations of the fixes (track on the io pool, generic claim copy, raw NBSP, raw delimiters, inclusive 23 h window, key-blind send time, expiring pending sends, notes kept for an edited list, label in `Run.toString`, context read on reload, an HTML content type) each turned the named test red and were reverted |
| Plugin Verifier | `./gradlew verifyPlugin` (verifier-cli 1.410, `ides { current() }`) | `Plugin labs.dkv.sandpane:0.1.0-scaffold against IU-262.10968.63: Compatible`; reused the cached IDE (no second IDE download); `verification-verdict.txt` → `Compatible` |
| Project configuration | `./gradlew verifyPluginProjectConfiguration` | one finding, deliberately not followed: `until-build property should be removed` (see "until-build is kept on purpose"). The Java-25 finding is resolved. |
| Bytecode target | class-file major of every class in `sandpane-jetbrains-0.1.0-scaffold.jar` | 241/241 at **69** (Java 25) |
| Kotlin warning surface | clean offline compile | **0** `e:`, **10** `w:` (listed under "Code changes for the 2026.2 platform") |
| Installable artifact | `unzip -l build/distributions/sandpane-jetbrains-0.1.0-scaffold.zip` | 1 163 019 bytes (plugin jar 551 292 bytes): plugin jar, `-searchableOptions.jar`, `kotlinx-serialization-{core,json}-jvm-1.11.0`; **no** `kotlin-stdlib`. Never installed anywhere. |
| Toolchain actually used | `./gradlew --version`, `./gradlew javaToolchains` | Gradle 9.8.1, Launcher JVM 23 (GraalVM CE); toolchain 25 = `Eclipse Temurin JDK 25 (25.0.3+9-LTS)`, `Detected by: Auto-provisioned by Gradle` |
| Wrapper integrity | `shasum -a 256 gradle/wrapper/gradle-wrapper.jar` | `3b8a2577…8e98` = the published `gradle-9.8.1-wrapper.jar.sha256` |
| Drift gate can fail (negative control) | mutated Kotlin mirror, then a mutated **copy** of the Rust sources via `-PsandpaneRepoRoot` | red in both directions with a message naming the drifted wire string; green after restore — see "Drift gate and its negative control" (recorded before U4; the gate ran green again in the suite above) |
| Protocol parity | `ProtocolDriftGuardTest` (runs with the suite) | 34 method names **in `Method::ALL` order**, service bounds evaluated from `pub const`, enum sets vs Rust **and** schemas, additive field names on both sides, cursor rules matched against the Rust text |
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
- **A3a project lifecycle** (11.10.2026): the seven actions, the edit/chooser/delete dialogs, the
  archived label in the chat picker, the composer's archived gate and the post-delete cleanup were
  never shown or run in an IDE; no A3a request has reached a running Core. The Add Repository
  cross-host refusal is the existing "visible to this process" heuristic (`hostMapping`), not a
  verified remote-development API — with a split-mode/remote backend it is UNVERIFIED which host's
  folders the chooser shows. `ProjectChooserDialog`'s live `initValidation()` and `ToggleAction`
  state on a BGT update are written against the documentation only.
- **A3b conversation lifecycle** (11.10.2026): the chat-panel controls (Show archived, Rename…, Archive,
  Unarchive, Delete…, Export…), the "sandbox chosen at creation" line, the rename/delete/export dialogs
  and the native save dialog were never shown in an IDE; no A3b request has reached a running Core; no
  export file has been written by the plugin outside the unit test's temporary directory. With a
  split-mode/remote backend it is UNVERIFIED which host's file system the save dialog shows (the file is
  written by this plugin's process to the path the dialog returns). `FileSaverDialog.save(Path?, String)`,
  `VirtualFileWrapper.getFile()` and the `BoxLayout` header row are written against the documentation and
  the 262 bytecode only. The export holds every page in memory (worst case 200 pages × Core's 2 MiB page
  ceiling) before the file is written.
- **A4 send mode** (11.10.2026): the Task / Discuss combo, its disabled state and the task-row meta were
  never shown in an IDE; no A4 request reached a running Core. Gating is tested against fabricated
  capability lists only.
- **A5 git.diff** (11.10.2026): no task created over the wire has Git context until A4b, so the per-file
  Diff action has never received a real `git.diff` answer; the chooser, the viewer and the review
  notification action were never shown in an IDE. Frames, gating, disclosures and copy are tested
  against fabricated answers shaped like Core's output.
- **A6 git.apply** (11.10.2026): UNVERIFIED end to end. No task created over the wire has Git
  context until A4b, so over the wire Apply can only receive Core's "task has no Git context (repo
  binding + base_commit); nothing was written" abort; a real apply is reachable only for tasks Core
  seeds internally, and no apply request from this plugin has reached a running Core. The chooser,
  the confirmation (its focus and default-button behaviour included), the VCS refresh and the
  "Review again" action were never shown or run in an IDE. Frames, gating, selectability, flags,
  the mismatch refusal and every result kind are tested against fabricated answers shaped like
  Core's output. With a split-mode/remote backend, the VFS refresh looks up Core's `repoPath` on
  the backend's file system (skipped when it is not found) — UNVERIFIED there.
- **A7 verification + project.context** (12.10.2026): UNVERIFIED end to end. Running is disabled
  for every real sbx version until captures C-1, C-2, C-5 and C-7 exist, so over the wire Run can
  only receive Core's `UNSUPPORTED_SBX_VERSION` refusal; no task created over the wire is bound to a
  sandbox until A4b; no A7 request from this plugin has reached a running Core. The tab, the argv
  editor, the confirmations (focus and default button included), the run picker and the output
  viewer were never shown in a real editor, app or IDE; `JEditorPane` and dialog layout are untested
  headless. Frames, gating, guards, copy and the output reveal are tested against fabricated answers
  shaped like Core's output.
- **Older/newer Core compatibility** (testing this client against an older and a newer Core within
  the compatibility policy) has not been done; advertisement gating is tested against fabricated
  capability lists only.
- `docs/compatibility.md` still records "Gradle / Kotlin — not installed locally" for this client
  and none of the versions above. That file is the orchestrator's to update — recorded here rather
  than changed from inside this module.
