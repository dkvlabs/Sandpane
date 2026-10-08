# Sandpane implementation changelog

Every **big implementation step** gets one numbered entry here, per the mandatory logging rule in [`/AGENTS.md`](../AGENTS.md). Newest entries first.

## Entry format

```markdown
## NNNN — Short title

- **date:** YYYY-MM-DD
- **phase:** roadmap phase / area (e.g. P1 Core, docs, infra)
- **commit:** <git short hash> (<commit subject>)
- **details:** what was implemented, key decisions, deviations
- **files:** notable paths added/changed
- **verification:** commands run and their actual results (evidence, not claims)
- **review:** docs/audit/NNNN-<slug>-review.md — one-line review outcome
- **model:** model used for the implementation session, or `-`
- **tokens:** input: <n|-> · cached: <n|-> · output: <n|-> (session delta: <n|->)
```

Rules:

1. Any value that cannot be determined is recorded as a dash `-` (e.g. `model: -`). Never guess or fabricate numbers.
2. The `commit` hash points at the implementation commit; the audit/changelog record itself lands in the follow-up `docs(audit)` commit.
3. `verification` must quote commands actually run in that step and their real outcome, including failures and unverified items.
4. Each entry has a matching auto-review record in [`audit/`](audit/README.md) with the same number.

---

<!-- Entries are appended above this line, newest first. -->
