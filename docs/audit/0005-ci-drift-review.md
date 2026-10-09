# 0005 — Auto-review record: PR CI workflow + schema/protocol drift gate

- **date:** 2026-10-09
- **implementation commit:** `acbdc35` — ci: PR workflow per specs/08 §6 + schema/protocol value-set drift gate (5 files, +398/−10)
- **review ran:** before the commit, on the same working-tree diff, via the read-only `phase-reviewer` project agent (same lighter path as entry 0004; the 23-agent `/review` fan-out remains user-cancelled — do not retry)

## Scope

`.github/workflows/ci.yml` (new), `scripts/schema_drift.py` (new), `Makefile` (`check` now aggregates schema-lint + new `schema-drift`), `AGENTS.md` (one Commands-table row), `schemas/README.md` (Sync-status rewritten). Closes audit-0004 disposition #7 ("drift check lands with CI entry") for its value-set half. Client phase dirs (`clients/`, `apps/`) were built concurrently by other agents and are NOT in this scope or this commit.

## Method

`phase-reviewer` agent (plan-mode, read-only) loaded docs/specs/08 §6, specs/02 §2, AGENTS.md Code Review rules + honesty rules, and audit 0004. It ran fresh: `make schema-lint schema-drift`, `make check` (72 tests green), `cargo test --all-targets` (CI's exact variant), a 7-case mutation battery for the drift checker in a disposable sandbox, Ruby psych YAML parse of ci.yml, GitHub docs fetch for `hashFiles`/context-availability, `git ls-remote` reachability probe, and referenced-file existence checks. The orchestrator transcribed its report (4 Critical, 6 Suggestion, 1 multi-part Nice-to-have) and dispositioned it.

## Findings (as delivered; condensed)

### Critical
1. **ci.yml header asserted "no remote is configured" — factually false.** `origin git@github.com:dkvlabs/Sandpane.git` is configured and reachable (`git ls-remote --heads origin` exits 0 with zero heads; upstream `origin/main` "gone"). The framing also obscured that the FIRST push of main executes this never-run workflow.
2. **Job-level `if: ${{ hashFiles(...) != '' }}` contradicts GitHub's documented expression availability** (job-level `if` documents only `needs`/`always/success/failure/cancelled`; `hashFiles` is documented at step level). Worst case: guard permanently false against an empty pre-checkout workspace → client jobs never light up even after their phases land — the exact behavior the header claimed to guarantee.
3. **Drift checker violated its own exit-code contract**: docstring promised exit 2 for harness problems, but `enum_body` `ValueError` and unwrapped schema dict `KeyError`s escaped as tracebacks with exit 1 = "drift found" (sandbox T4/T5) — a legitimate schema restructure or crate module split would be misreported as protocol drift.
4. **Proven drift evasion**: `Self::X => "value"` strings matching neither the dotted nor SCREAMING shape were silently dropped from both sets — adding method `"ping"` in Rust with no schema update reported "in sync", exit 0 (sandbox T1).

### Suggestion
5. Data-carrying enum variants in the unit-only extraction would be silently dropped and the failure message would steer the fix the wrong way (schema deletion) — sandbox T3.
6. Agent-event rename extraction excluded `requestId`/`providerType` only by the coincidence that they contain uppercase letters.
7. ci.yml comment claimed "TS lint/typecheck/Vitest" though no lint step exists — an unacknowledged specs/08 §6 gap.
8. "Generated schema/codegen drift check" wording in Makefile/ci.yml overstated: the gate compares hand-synced value SETS; codegen remains P1/P7 (schemas/README.md was already worded exactly right).
9. Header did not acknowledge three remaining §6 bullets: SBX fixture contract tests, optional real-SBX CI integration, the destructive-adapter review requirement (branch protection, not workflow-expressible).
10. ci.yml + schemas/README forward-reference entry 0005 (not yet written) — commit set must include them together.
11. Nice-to-have cluster: skipped-but-scheduled job cost note; ubuntu Core leg genuinely unproven; ad-hoc `--repo-root` argv undocumented; single-file-of-truth assumption unstated.

## Disposition

| # | Disposition | Evidence |
|---|---|---|
| 1 | **Fixed pre-commit** | Header rewritten: remote configured/reachable with zero branches; "the first push of `main` will run it untested" stated plainly. Re-verified live this turn: `git remote -v` lists origin, `git ls-remote --heads origin` exit 0, no heads. |
| 2 | **Fixed pre-commit** | New `detect` job (checkout + `[ -f … ]` step writing `GITHUB_OUTPUT` booleans); client jobs gate on `needs.detect.outputs.*` — `needs` IS documented for job-level `if`. Comment in-file records why hashFiles moved to a step. YAML re-parsed: 7 jobs incl. detect. |
| 3 | **Fixed** | `HarnessError` type; entire parse/extract block wrapped → "checker cannot classify input (not drift)" + exit 2. Proven: T4 (schema `method.enum` removed) now exit 2 (was traceback/1). |
| 4 | **Fixed** | Unclassifiable wire strings (neither dotted nor SCREAMING) raise HarnessError → exit 2. Proven: T1 (`Self::Ping => "ping"`) now exit 2 (was silent "in sync"/0). |
| 5 | **Fixed** | `unit_variants()` raises HarnessError on any data-carrying variant in the snake_case-extracted enums. Proven: T3 (`Renamed { from, to }`) now exit 2 with "update the checker extraction" message. |
| 6 | **Fixed** | Extraction anchored to variant depth (`^    #\[serde\(rename = …)\]`, MULTILINE); field-level renames excluded by construction, with the reason in a code comment. |
| 7 | **Fixed** | Comments now say typecheck + Vitest; "Lint step pending the client phase's lint config" in-file and in the header's not-covered list. |
| 8 | **Fixed** | Makefile and ci.yml schemas-job comments rewritten to "value-set drift gate… generated TS/Kotlin bindings remain P1/P7", mirroring schemas/README.md. |
| 9 | **Fixed** | Header "NOT covered" list now enumerates every remaining §6 bullet incl. SBX fixture/real-SBX items and the branch-protection note; repeated in CHANGELOG 0005. |
| 10 | **Satisfied by commit structure** | Implementation commit `acbdc35` carries code+shared-file changes; this record + CHANGELOG entry land in the follow-up `docs(audit)` commit (same two-commit pattern as entries 0001–0004). |
| 11 | **Accepted/recorded** | Cost note omitted (minor); ubuntu leg disclosed in the core job comment ("first push will be its first proof"); `--repo-root` documented in the docstring Usage line; single-file assumption commented above `RUST_SRC`. |

## Verification evidence (fresh, post-fix)

- Mutation battery after fixes (disposable `--repo-root` copy; repo files untouched): baseline exit 0; T1 exit 2 "unclassifiable Rust wire strings: ['ping']"; T2 dotted-new-method → DRIFT line reported; T3 exit 2 data-variant; T4 exit 2 schema-extract KeyError wrapped. The original positive run + tamper test (remove `git.apply`, bump schema version) → exit 1 with both diffs listed.
- `make check` → `cargo fmt --check` OK; clippy `-D warnings` clean; **72 passed / 0 failed** (46+3+7+5+11, incl. `--all-targets` match with CI's variant); `schemas: JSON syntax OK`; drift gate 7×OK in sync; aggregate echo OK. EXIT 0.
- ci.yml YAML valid (Ruby psych; PyYAML absent on host). All in-file path references exist (`scripts/schema_drift.py`, `core/Cargo.lock`, docs files); client paths are detection strings only.
- Every value set the gate claims was independently cross-checked by the reviewer's direct parse of lib.rs + JSON: 11 methods / 10 codes (×2 surfaces) / 8 event types / 5 statuses / 4 modes / version 1.

**Not verified (honest boundary):** the workflow has never run on GitHub Actions — origin is reachable but has no branches; first push executes it untested (header says so). The `hashFiles`-in-step + `needs.outputs` guard pattern follows GitHub's documented availability tables but its runtime behavior only a real run can prove. `cargo audit` advisories unknown (job is non-blocking until triaged, per in-file note). specs/08 §6 items outside this entry remain open (CSP/static analysis P3, Plugin Verifier/SDK tests P6, native Tauri builds, real-SBX CI P0-gated).

## Incident note (concurrent-agent hygiene)

While this phase was under review, an in-flight client-scaffold agent accidentally modified `docs/CHANGELOG.md` outside its scope (one line of entry 0004 corrupted: indent + `feat(co re)`). The change was unintended, single-hunk, and already committed-correct in HEAD; it was reverted with `git checkout -- docs/CHANGELOG.md` before entry 0005 was written, and all three running agents received a scope fence (write only inside their assigned directory; no git commands; orchestrator owns logging). Entries 0006+ must re-check `git status` before changelog writes.

**Independent review by the read-only `phase-reviewer` project agent; this record is its dispositioned output. Not the full `/review` fan-out (user-cancelled) — disclosed.**
