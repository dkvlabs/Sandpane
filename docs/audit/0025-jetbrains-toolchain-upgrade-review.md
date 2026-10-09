# 0025 — Auto-review record: JetBrains toolchain upgrade (U4)

- **date:** 2026-10-09
- **implementation commit:** `da20777` — build(jetbrains): upgrade to Gradle 9.8.1, Kotlin 2.4.21, IntelliJ Platform 2026.2.3, Java 25 (U4)
- **review ran:** before the commit (checklist, orchestrator)

## Scope

- `clients/jetbrains/`:
  - build scripts and properties;
  - Gradle wrapper (properties, jar, scripts);
  - `plugin.xml`;
  - two source files changed for API updates;
  - README.
- `.github/workflows/ci.yml`: setup-java version.
- `docs/compatibility.md`.

## Method

The orchestrator ran a dependency-upgrade checklist against the `jetbrains-engineer` report:

- **Registry versions.** Checked against the Gradle Plugin Portal, Maven Central, `services.gradle.org` and the JetBrains releases API. Pre-releases were not taken (Kotlin 2.5.0-Beta1, kotlinx-serialization 1.12.0-RC).
- **ctx7 docs.** `/jetbrains/intellij-sdk-docs`, the Gradle user guide (foojay) and the Kotlin site (`jvmDefault`).
- **Wrapper integrity, checked by the orchestrator.** The jar's sha256 equals `gradle-9.8.1-wrapper.jar.sha256` from services.gradle.org (`3b8a2577…8e98`). `distributionSha256Sum` equals `gradle-9.8.1-bin.zip.sha256` (`dce76f55…dc01f`). CI also validates the wrapper with `gradle/actions/wrapper-validation`.
- **Toolchain decision (Java 25, not the planned 21).** Four independent sources agree on Java 25:
  - `product-info.json` `minRequiredJavaVersion: 25`;
  - the bundled JBR 25.0.4;
  - platform class files at major 69;
  - the IPGP message.

  Accepted.
- **since/until decision.** Kept `262 / 262.*`, which goes against IPGP's suggestion to drop until-build. Dropping it would claim compatibility with unverified builds (AGENTS.md rule 5). Accepted.
- **API changes.** Only public, non-deprecated replacements (checked with `javap`). `jvmDefault = NO_COMPATIBILITY` removed generated stubs that the verifier flagged as 4 deprecated and 6 experimental usages.

## Findings

1. **Warning (fixed in this commit): CI pinned `setup-java` to 17**, which cannot build against platform 262. It is now 25.
2. **Note: support range narrowed.** Since-build moved from 242 to 262, so IDE builds 242–252 are no longer claimed. This is deliberate: only the verified build is advertised.
3. **Note: foojay downloaded a JDK into `~/.gradle/jdks` on the first run.** That is a user cache; no machine path is committed.
4. **Note: the path gate flagged README lines describing `~/.gradle/caches` disk usage.** These are generic `~/` documentation, not machine-specific paths. The gate was narrowed to absolute home paths and hash-specific transform dirs, then re-run clean.
5. **Residual (UNVERIFIED):**
   - `runIde` was not run;
   - the zip was never loaded in a real IDE;
   - no other IDEs or builds were tested;
   - runtime coexistence of the bundled kotlinx-serialization and Kotlin 2.4 classes with the IDE runtime is untested.

## Disposition

Finding 1 is fixed. Findings 2–5 are recorded in the JetBrains README and `docs/compatibility.md`. No Critical findings.

## Verification evidence (orchestrator, fresh)

- `./gradlew test --rerun buildPlugin verifyPluginStructure --offline --no-build-cache --console=plain` → `> Task :test` (executed) and `BUILD SUCCESSFUL in 14s`. The junit XML totals `tests 161 failures 0 errors 0`.
- `./gradlew verifyPlugin --offline` → up to date with unchanged inputs; `verification-verdict.txt` says `Compatible` (against IU-262.10968.63, from the engineer's run).
- Secret/path gate: clean (13 files).

**Checklist: PASS.**
