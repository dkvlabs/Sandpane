/**
 * A7 desktop review fixes (security review, Info items D-I1..D-I5).
 *
 * - D-I1: every Core string in the verification components is revealed —
 *   `approvedAt`, the run id prefix, `startedAt`, `finishedAt` included.
 * - D-I2: an earlier run whose outcome is unknown does not block a new Run
 *   gesture; that confirmation says the earlier run may have started.
 * - D-I3: Revoke… opens its confirmation only from a trusted click.
 * - D-I4: once a suggestion's argv is edited, Core's "Suggested from …" and
 *   notes are dropped from the draft and the confirmation.
 * - D-I5: "Retry safely" only within 23 h of the key's first send (Core keeps
 *   keys 24 h); after that, "too late to retry safely". Clock injected.
 *
 * Hostile characters are built with `String.fromCodePoint`; no raw invisible
 * character appears in this file.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MutationObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreRequestError } from "../src/lib/core-client";
import type { VerificationCommand } from "../src/lib/protocol";
import { createQueryClient } from "../src/lib/query-client";
import type { VerificationRunRecord } from "../src/lib/reducers";
import {
  EARLIER_RUN_UNKNOWN_WARNING,
  effectiveApproveSource,
  openApproveConfirmation,
  openRevokeConfirmation,
  openRunConfirmation,
  revealTimestamp,
  runBlockedReason,
  shortRunId,
  verificationFailureCopy,
  type ApproveSource,
  type RunBinding,
} from "../src/lib/verification";
import {
  RETRY_SAFELY_WINDOW_MS,
  TOO_LATE_TO_RETRY_SAFELY,
  retrySafelyWindow,
  runFailureCopyAt,
  runMutationOptions,
  runOutcomeView,
  type RunMutationState,
  type RunVariables,
} from "../src/lib/verification-mutations";
import { ApproveConfirmDialog, RunConfirmDialog } from "../src/components/verification/VerificationDialogs";
import { ApprovedCommandRow } from "../src/components/verification/VerificationPanel";
import { ResultMetaLine, RunRecordMeta, RunStartedStatus } from "../src/components/verification/VerificationRunPanel";

const cp = (n: number): string => String.fromCodePoint(n);
const ESC = cp(0x1b);
const BEL = cp(0x07);
const RLO = cp(0x202e);
const CSI_C1 = cp(0x9b);
const ZWSP = cp(0x200b);
/** A "timestamp" or id that tries to reorder text, fake a link and ring the bell. */
const HOSTILE_TS = `2026-10-12T00:00:00Z${RLO}<script>x</script>${ESC}]8;;https://evil.example/${ESC}\\${BEL}${CSI_C1}${ZWSP}`;

function repoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

function assertRevealed(html: string): void {
  for (const raw of [ESC, BEL, RLO, CSI_C1, ZWSP]) expect(html).not.toContain(raw);
  expect(html).not.toContain("<script");
  expect(html).not.toMatch(/<a[\s>]/);
  expect(html).not.toContain("href=");
}

const PROJECT = "p-1";
const COMMAND: VerificationCommand = {
  id: "c-1",
  projectId: PROJECT,
  label: "unit tests",
  argv: ["npm", "run", "test"],
  approvedAt: "2026-10-12T00:00:00Z",
};
const trusted = { nativeEvent: { isTrusted: true } };
const untrusted = [null, undefined, {}, { nativeEvent: {} }, { nativeEvent: { isTrusted: false } }];
const bound: RunBinding = { ok: true, expectedSandboxName: "atlas-demo", expectedWorkspaceMode: "direct_mount" };

const lostKeyed = () =>
  new CoreRequestError("client", "TIMEOUT", "Core did not answer", { mayHaveBeenApplied: true, idempotencyKeyed: true }, "verification.run");
const lostUnkeyed = () =>
  new CoreRequestError("client", "TIMEOUT", "Core did not answer", { mayHaveBeenApplied: true, idempotencyKeyed: false }, "verification.run");

function request(key: string | undefined): RunVariables["request"] {
  return {
    taskId: "t1",
    commandId: "c-1",
    expectedSandboxName: "atlas-demo",
    expectedWorkspaceMode: "direct_mount",
    ...(key === undefined ? {} : { idempotencyKey: key }),
  };
}

function state(partial: {
  status: "error" | "success" | "pending";
  error?: CoreRequestError | null;
  key?: string;
  retry?: boolean;
  submittedAt: number;
}): RunMutationState {
  return {
    context: undefined,
    failureCount: partial.status === "error" ? 1 : 0,
    failureReason: null,
    isPaused: false,
    data: partial.status === "success" ? { runId: "r-1", startedSequence: 3 } : undefined,
    status: partial.status,
    error: partial.error ?? null,
    variables: { request: request(partial.key), retry: partial.retry ?? false },
    submittedAt: partial.submittedAt,
  } as unknown as RunMutationState;
}

// ---------------------------------------------------------------------------
// D-I1
// ---------------------------------------------------------------------------

describe("D-I1: no Core string renders unrevealed in the verification components", () => {
  it("approvedAt in an approved-command row is revealed", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovedCommandRow, {
        command: { ...COMMAND, approvedAt: HOSTILE_TS },
        revokeDisabled: false,
        onRevoke: () => {},
      }),
    );
    assertRevealed(html);
    expect(html).toContain("\\u202E");
    expect(html).toContain("\\u001B");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain(">Revoke…</button>");
  });

  it("the run id prefix, startedAt and finishedAt are revealed", () => {
    const record: VerificationRunRecord = {
      runId: `${RLO}${ESC}abcdefghij`,
      startedSequence: 4,
      startedAt: HOSTILE_TS,
      label: "unit tests",
      argv: ["npm"],
      sandbox: `atlas-${RLO}`,
      workspaceMode: "direct_mount",
      finished: null,
    };
    const meta = renderToStaticMarkup(createElement(RunRecordMeta, { record }));
    assertRevealed(meta);
    expect(meta).toContain("\\u202E\\u001Babcdef");
    expect(meta).not.toContain("ghij");

    const started = renderToStaticMarkup(
      createElement(RunStartedStatus, { data: { runId: `${CSI_C1}${BEL}12345678`, startedSequence: 9 } }),
    );
    assertRevealed(started);
    expect(started).toContain("\\u009B\\u0007123456");

    const line = renderToStaticMarkup(
      createElement(ResultMetaLine, { result: { elapsedMs: 12, workspaceMode: "direct_mount", finishedAt: HOSTILE_TS } }),
    );
    assertRevealed(line);
    expect(line).toContain("finished 2026-10-12T00:00:00Z\\u202E");
  });

  it("the helpers reveal and cap; a plain id or timestamp is unchanged", () => {
    expect(shortRunId("0b9e2c4a-1111-2222-3333-444455556666")).toBe("0b9e2c4a");
    expect(shortRunId(`ab${RLO}cdefghij`)).toBe("ab\\u202Ecdefg");
    expect(revealTimestamp("2026-10-12T08:30:00Z")).toBe("2026-10-12T08:30:00Z");
    expect(revealTimestamp("x".repeat(100))).toMatch(/… \(36 more characters\)$/);
  });

  it("source pin: no raw approvedAt / startedAt / finishedAt / runId.slice in the verification components", () => {
    for (const file of ["VerificationPanel", "VerificationRunPanel", "VerificationDialogs", "VerificationText"]) {
      const src = repoFile(`src/components/verification/${file}.tsx`);
      expect(src, file).not.toMatch(/\{\s*[\w.?]*\.(approvedAt|startedAt|finishedAt)\s*\}/);
      expect(src, file).not.toMatch(/\$\{\s*[\w.?]*\.(approvedAt|startedAt|finishedAt)\s*\}/);
      expect(src, file).not.toMatch(/runId\.slice\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// D-I2
// ---------------------------------------------------------------------------

describe("D-I2: an earlier unknown run never blocks a new gesture, and the dialog says it may have started", () => {
  it("a lost answer (keyed or not) marks the earlier run unknown; a success or a Core refusal does not", () => {
    expect(runOutcomeView([state({ status: "error", error: lostKeyed(), key: "k1", submittedAt: 1 })]).earlierRunUnknown).toBe(true);
    expect(runOutcomeView([state({ status: "error", error: lostUnkeyed(), submittedAt: 1 })]).earlierRunUnknown).toBe(true);
    expect(runOutcomeView([state({ status: "success", key: "k1", submittedAt: 1 })]).earlierRunUnknown).toBe(false);
    const refused = new CoreRequestError("core", "CONFLICT", "a verification is already running for this task");
    expect(runOutcomeView([state({ status: "error", error: refused, key: "k1", submittedAt: 1 })]).earlierRunUnknown).toBe(false);
    // A Retry safely that came back replayed resolves it.
    expect(
      runOutcomeView([
        state({ status: "error", error: lostKeyed(), key: "k1", submittedAt: 1 }),
        state({ status: "success", key: "k1", retry: true, submittedAt: 2 }),
      ]).earlierRunUnknown,
    ).toBe(false);
    expect(runOutcomeView([]).earlierRunUnknown).toBe(false);
  });

  it("only a run in flight blocks Run", () => {
    const base = { projectId: PROJECT, binding: bound, commandCount: 1, command: COMMAND };
    expect(runBlockedReason({ ...base, pending: false })).toBeNull();
    expect(runBlockedReason({ ...base, pending: true })).toBe("a run of this task is being started");
  });

  it("the confirmation carries and shows the warning only when the earlier outcome is unknown", () => {
    const warned = openRunConfirmation(trusted, { taskId: "t1", command: COMMAND, binding: bound, earlierRunUnknown: true });
    expect(warned?.earlierRunMayHaveStarted).toBe(true);
    const plain = openRunConfirmation(trusted, { taskId: "t1", command: COMMAND, binding: bound, earlierRunUnknown: false });
    expect(plain?.earlierRunMayHaveStarted).toBe(false);
    expect(EARLIER_RUN_UNKNOWN_WARNING).toBe("An earlier run of this task may have started; check Results first.");
    const render = (snapshot: NonNullable<typeof warned>) =>
      renderToStaticMarkup(createElement(RunConfirmDialog, { snapshot, onCancel: () => {}, onConfirm: () => {} }));
    expect(render(warned!)).toContain(EARLIER_RUN_UNKNOWN_WARNING);
    expect(render(plain!)).not.toContain("may have started");
  });

  it("source pin: the panel feeds the view's flag into the opener and uses runBlockedReason", () => {
    const src = repoFile("src/components/verification/VerificationRunPanel.tsx");
    expect(src).toContain("earlierRunUnknown: run.view.earlierRunUnknown");
    expect(src).toContain("runBlockedReason({ projectId, binding, commandCount: list.length, command, pending: run.pending })");
  });
});

// ---------------------------------------------------------------------------
// D-I3
// ---------------------------------------------------------------------------

describe("D-I3: Revoke… opens only from a trusted click", () => {
  it("openRevokeConfirmation refuses anything but a trusted event and freezes a copy", () => {
    for (const ev of untrusted) expect(openRevokeConfirmation(ev, COMMAND)).toBeNull();
    const opened = openRevokeConfirmation(trusted, COMMAND);
    expect(opened).toEqual(COMMAND);
    expect(opened?.argv).not.toBe(COMMAND.argv);
  });

  it("source pin: the row's Revoke… goes through openRevokeConfirmation, never straight to the dialog", () => {
    const src = repoFile("src/components/verification/VerificationPanel.tsx");
    expect(src).toContain("const opened = openRevokeConfirmation(event, command);");
    expect(src).not.toMatch(/setRevoking\(command\)/);
  });
});

// ---------------------------------------------------------------------------
// D-I4
// ---------------------------------------------------------------------------

describe("D-I4: an edited suggestion drops Core's 'Suggested from …' and notes", () => {
  const suggestion: ApproveSource = {
    kind: "suggestion",
    repoPath: "/repo/atlas-demo",
    manifest: "package.json",
    notes: ["npm run test runs the test script from package.json"],
    suggestedArgv: ["npm", "run", "test"],
  };

  it("kept while the argv equals the suggestion; dropped on any element edit, addition or removal", () => {
    expect(effectiveApproveSource(["npm", "run", "test"], suggestion)).toEqual(suggestion);
    for (const edited of [["npm", "run", "test:all"], ["npm", "run", "test", "--watch"], ["npm", "run"], ["npm", "run", "test "]]) {
      expect(effectiveApproveSource(edited, suggestion)).toEqual({ kind: "manual" });
    }
    expect(effectiveApproveSource(["npm"], { kind: "manual" })).toEqual({ kind: "manual" });
  });

  it("the confirmation of an edited suggestion shows no 'Suggested from' and none of Core's notes", () => {
    const draft = { projectId: PROJECT, label: "tests", source: suggestion };
    const editedSnap = openApproveConfirmation(trusted, { ...draft, argv: ["npm", "run", "lint"] });
    expect(editedSnap?.source).toEqual({ kind: "manual" });
    const render = (snapshot: NonNullable<typeof editedSnap>) =>
      renderToStaticMarkup(createElement(ApproveConfirmDialog, { snapshot, onCancel: () => {}, onConfirm: () => {} }));
    const edited = render(editedSnap!);
    expect(edited).not.toContain("Suggested from");
    expect(edited).not.toContain("runs the test script");

    const keptSnap = openApproveConfirmation(trusted, { ...draft, argv: ["npm", "run", "test"] });
    const kept = render(keptSnap!);
    expect(kept).toContain("Suggested from");
    expect(kept).toContain("runs the test script");
  });

  it("source pin: the draft editor shows notes only for the effective source", () => {
    const src = repoFile("src/components/verification/VerificationPanel.tsx");
    expect(src).toContain("effectiveApproveSource(draft.argv, draft.source)");
    expect(src).not.toMatch(/draft\.source\.notes/);
    expect(src).toContain("suggestedArgv: [...argv],");
  });
});

// ---------------------------------------------------------------------------
// D-I5
// ---------------------------------------------------------------------------

describe("D-I5: Retry safely only within 23 h of the key's first send", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const T0 = Date.UTC(2026, 9, 12, 8, 0, 0);

  it("the window is 23 h, inside Core's 24 h key retention (drift-pinned)", () => {
    expect(RETRY_SAFELY_WINDOW_MS).toBe(23 * 60 * 60 * 1000);
    const rust = repoFile("../../core/crates/sandpane-core/src/idempotency.rs");
    expect(rust).toContain("pub const RETENTION_SECS: u64 = 24 * 60 * 60;");
    expect(RETRY_SAFELY_WINDOW_MS).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it("measured from the FIRST send of the key, also after a lost Retry safely", () => {
    const first = state({ status: "error", error: lostKeyed(), key: "k1", submittedAt: T0 });
    const view1 = runOutcomeView([first]);
    expect(view1.keyFirstSentAt).toBe(T0);
    expect(retrySafelyWindow(view1, T0 + RETRY_SAFELY_WINDOW_MS - 1)).toBe("open");
    expect(retrySafelyWindow(view1, T0 + RETRY_SAFELY_WINDOW_MS)).toBe("expired");

    const retried = state({ status: "error", error: lostKeyed(), key: "k1", retry: true, submittedAt: T0 + 22 * 3_600_000 });
    const view2 = runOutcomeView([first, retried]);
    expect(view2.current).toBe(retried);
    expect(view2.keyFirstSentAt).toBe(T0);
    expect(retrySafelyWindow(view2, T0 + RETRY_SAFELY_WINDOW_MS + 1)).toBe("expired");

    // A new gesture has a new key and a new window.
    const fresh = state({ status: "error", error: lostKeyed(), key: "k2", submittedAt: T0 + 30 * 3_600_000 });
    const view3 = runOutcomeView([first, retried, fresh]);
    expect(view3.keyFirstSentAt).toBe(T0 + 30 * 3_600_000);
    expect(retrySafelyWindow(view3, T0 + 31 * 3_600_000)).toBe("open");
  });

  it("past the window the copy withdraws Retry safely and says it is too late", () => {
    const view = runOutcomeView([state({ status: "error", error: lostKeyed(), key: "k1", submittedAt: T0 })]);
    const copy = verificationFailureCopy(lostKeyed(), "run");
    expect(copy.retrySafely).toBe(true);
    expect(runFailureCopyAt(copy, view, T0 + 60_000)).toBe(copy);
    const late = runFailureCopyAt(copy, view, T0 + 23 * 3_600_000);
    expect(late.retrySafely).toBe(false);
    expect(late.action).toBe(TOO_LATE_TO_RETRY_SAFELY);
    expect(TOO_LATE_TO_RETRY_SAFELY).toBe(
      "Too late to retry safely — the earlier run may have started; check Results before running again.",
    );
    expect(late.title).toBe(copy.title);
  });

  it("an unkeyed lost answer has no window and is never offered", () => {
    const view = runOutcomeView([state({ status: "error", error: lostUnkeyed(), submittedAt: T0 })]);
    expect(view.keyFirstSentAt).toBeNull();
    expect(retrySafelyWindow(view, T0)).toBe("none");
    const copy = verificationFailureCopy(lostUnkeyed(), "run");
    expect(runFailureCopyAt(copy, view, T0).retrySafely).toBe(false);
  });

  it("TanStack stamps submittedAt from the clock the window is measured with", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const qc = createQueryClient();
    const observer = new MutationObserver(
      qc,
      runMutationOptions(
        {
          runVerification: async () => {
            throw lostKeyed();
          },
        },
        "t1",
      ),
    );
    await observer.mutate({ request: request("k1"), retry: false }).catch(() => undefined);
    const states = qc.getMutationCache().getAll().map((m) => m.state as RunMutationState);
    const view = runOutcomeView(states);
    expect(view.keyFirstSentAt).toBe(T0);
    expect(retrySafelyWindow(view, Date.now())).toBe("open");
    vi.setSystemTime(T0 + RETRY_SAFELY_WINDOW_MS);
    expect(retrySafelyWindow(view, Date.now())).toBe("expired");
  });

  it("source pin: the panel applies the window to the copy and re-checks it before re-sending", () => {
    const src = repoFile("src/components/verification/VerificationRunPanel.tsx");
    expect(src).toContain('runFailureCopyAt(verificationFailureCopy(current.error, "run"), run.view, Date.now())');
    expect(src.match(/retrySafelyWindow\(run\.view, Date\.now\(\)\) !== "open"/g)?.length).toBe(2);
    const sendAt = src.indexOf("run.submit({ request, retry: true })");
    const lastCheck = src.lastIndexOf('retrySafelyWindow(run.view, Date.now()) !== "open"', sendAt);
    const recheck = src.indexOf("await run.recheck()");
    expect(lastCheck).toBeGreaterThan(recheck);
  });
});
