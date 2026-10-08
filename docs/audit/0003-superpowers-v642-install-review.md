# 0003 — Auto-review record: superpowers v6.4.2 install from canonical GitHub source

- **date:** 2026-10-09
- **implementation commit:** `8f9506e` — feat(skills): install superpowers v6.4.2 from canonical GitHub source (project-level) (69 files, +4084/−1472)
- **review ran:** before the commit, on the same working-tree diff (`qwen review capture-local`), per `audit/README.md`

## Scope

User request: install superpowers from https://github.com/obra/superpowers into the **project** (`.qwen/skills/`), not user-global. Replaces the v5.1.0 marketplace-cache copies from entry 0002 with the canonical upstream release.

Capture: 11,135 diff lines / 35 chunks / 85 files — of which the reviewed commit scope is `.qwen/skills/**` (14 updated skill dirs, 1 new skill `diagnosing-superpowers` with 20 support files, refreshed `SUPERPOWERS_LICENSE`, rewritten `SUPERPOWERS_NOTICE.md`). The capture also included untracked `core/**` Rust files (paused-goal work) — explicitly **out of scope** and excluded from the commit via pathspec (finding 2).

## Method

Bundled `/review` skill, **effort: low** (quick pass, unverified findings, no verdict), adapted to vendored-third-party content with mechanical provenance checks instead of line-by-line re-review of upstream text:

- **Provenance/integrity:** fresh `git clone --depth 1 https://github.com/obra/superpowers` → HEAD `8ca22dba9a94f28898bbce59f2537ff4d87c747d` (v6.4.2 per `plugin.json`, released 2026-09-25). `diff -rq` of every installed skill dir + LICENSE against the clone: **15/15 IDENTICAL, LICENSE IDENTICAL**.
- **Completeness (removed behaviour):** all 14 skills present in v5.1.0 exist in v6.4.2 (name-set comparison) — nothing lost; 1 skill added.
- **Security scan:** every script/executable file in installed skills grepped for network/destructive surface (`curl|wget|fetch(|http.request|child_process|exec(|eval(|rm -rf|sudo`), including the five new extension-less bash helpers in `executing-plans/scripts/` and `subagent-driven-development/scripts/` (read and summarized). Result: no network calls; two `child_process` uses, both upstream and explicit-invocation-only (finding 1).
- **Discoverability:** frontmatter check over all 20 project skill dirs → 20/20 OK (`name` + `description` present).
- **Invariant checks:** Sandpane-authored skills, agents, and commands byte-unchanged (`git diff` empty for those paths); NOTICE claims cross-checked against the clone's `plugin.json` and `git log` output.
- Angles walked: A (NOTICE accuracy line-by-line), B (5.1.0→6.4.2 name-set + LICENSE), C (frontmatter), D (n/a), E (no stray repo plumbing copied — only `skills/*` installed, no `hooks/`/`index.js`), F (project files untouched), sweep (new-scripts scan).

Recall floor: 4 required (min(files,4) tier); 4 candidates pooled (3 reported + 1 completeness check resolved clean) → no re-pass.

## Findings (unverified — low tier)

1. **Suggestion (confidence: low)** — `.qwen/skills/brainstorming/scripts/server.cjs:540`: upstream `cp.exec(process.env.BRAINSTORM_OPEN_CMD + ' ' + JSON.stringify(url))` when opening the local brainstorming preview; env-gated, explicit-invocation-only.
2. **Suggestion** — working tree mixes paused-goal `core/**` untracked files with this change; a broad `git add` would sweep unfinished work into the skills commit.
3. **Nice to have** — upstream bodies keep Claude Code harness references (Skill tool names, `superpowers:` prefixes, harness reference files); mapping documented in NOTICE rather than editing verbatim bodies.

## Disposition

| # | Disposition | Reason |
|---|---|---|
| 1 | Accepted (upstream) | User-controlled env var, no network surface, runs only when the brainstorming server is explicitly started; bodies kept verbatim by vendoring policy. Recorded here for future security reviews. |
| 2 | **Mitigated at commit** | `git add .qwen/skills` pathspec used; post-commit `git status` confirms only `?? core/` remains untracked. |
| 3 | Accepted | NOTICE adaptation notes cover the tool-name mapping; editing upstream text would break byte-identity with the canonical source. |

No Critical findings.

## Verification evidence

- `git clone --depth 1 https://github.com/obra/superpowers` → HEAD `8ca22dba…` `Release v6.4.2` (tool output this session).
- `diff -rq` clone vs installed → `IDENTICAL` ×15 + `LICENSE IDENTICAL` (tool output).
- Frontmatter scan → 20/20 OK.
- Script scan → no curl/wget/fetch/http.request; `child_process` only in `server.cjs` (env-gated) and `render-graphs.js` (`execFileSync` → graphviz, dev tool).
- `git diff --cached --stat` → 69 files, +4084/−1472, all under `.qwen/skills/`.
- `git log --oneline` → `8f9506e` on `main`; `git status --short` → `?? core/` only (paused-goal work preserved uncommitted).

**Quick pass (effort: low) — findings are unverified. No verdict emitted (low tier).**
