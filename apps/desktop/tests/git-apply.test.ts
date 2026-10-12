/**
 * A6 `git.apply` for reviewed files on the desktop (design 2026-10-09 §3.6).
 *
 * - drift against the Rust sources read from disk: the `git-apply` feature
 *   (5 features), 28 methods, the 45 s / 43 s deadlines, `MAX_APPLY_ENTRIES`,
 *   every Core message the copy keys on, the event kinds, and the proxy's
 *   read-only / replay-safe classification of `git.apply`;
 * - exact frames: entries copied VERBATIM (tab, quote, newline, non-ASCII
 *   paths), `reviewId` sent, `selectedFiles` never sent;
 * - gating, selectability, the confirmation flags (a)/(b)/(c), the gesture-
 *   only opener, the diff-mismatch refusal (no frame), and the copy for every
 *   outcome (success, partial, abort, both CONFLICT kinds, lost answer).
 *
 * Core's apply is NOT modeled in FakeCore: frames and answers go through a
 * small scripted transport below whose answers are written by hand from the
 * Rust sources (illustrative, never captured from a live Core). No
 * wire-created task has Git context until A4b. Hidden characters are built
 * with `String.fromCodePoint` / `\u` escapes, so no raw invisible character
 * lives in this file.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApplyConfirmDialog } from "../src/components/review/ApplyConfirmDialog";
import { ApplyOutcome } from "../src/components/review/ApplyOutcome";
import {
  CoreClient,
  CoreRequestError,
  METHOD_TIMEOUT_MS,
  REPLAY_SAFE_METHODS,
  timeoutError,
  type CoreTransport,
} from "../src/lib/core-client";
import { decodeApplyResult, decodeChangeSet, decodeGitDiffResult } from "../src/lib/decode";
import {
  APPLY_FRAGMENTS,
  APPLY_STATEMENT,
  APPLY_UNSUPPORTED_NOTE,
  MAX_APPLY_ENTRIES,
  MSG_APPLY_NO_GIT_CONTEXT,
  MSG_CHECK_FAILED,
  MSG_CHECK_UNAVAILABLE,
  MSG_CONTENT_TOO_LARGE,
  MSG_DIRECT_MOUNT,
  MSG_ENTRIES_NOT_REVIEWED,
  MSG_HOST_UNBORN,
  MSG_HOST_WORK_TREE_REDIRECTED,
  MSG_NEEDS_REVIEW,
  MSG_PATCH_TOO_LARGE,
  MSG_PREPARE_TOO_SLOW,
  MSG_SELECTED_FILES,
  MSG_TOO_MANY_ENTRIES,
  MSG_WRITE_NOT_RUN,
  REASON_NO_CONTENT_ID,
  REASON_NO_REVIEW_ID,
  REASON_SYMLINK,
  REASON_TOO_LARGE,
  applyButtonLabel,
  applyFailureCopy,
  applyFlags,
  applyGate,
  applyOutcomeCopy,
  autoRunReason,
  confirmRefusal,
  diffRecordKey,
  diffRecordOf,
  entrySelectability,
  lostAnswerTitle,
  openApplyConfirmation,
  planReviewedApply,
  reviewSelectability,
  type ApplySnapshot,
  type DiffRecord,
} from "../src/lib/git-apply";
import { RENAME_UNCHANGED_DISCLOSURE, diffDisclosures } from "../src/lib/git-diff";
import { buildGitApplyParams } from "../src/lib/guards";
import { encodeFrame } from "../src/lib/framing";
import {
  CORE_EVENT_KINDS,
  FEATURE_GIT_APPLY,
  KNOWN_FEATURES,
  METHODS,
  PROTOCOL_VERSION,
  type ChangeSet,
  type FileChange,
  type TaskEvent,
} from "../src/lib/protocol";
import { emptyProjection, foldTaskEvents, reviewSummary } from "../src/lib/reducers";
import { A5_CORE_METHODS, A6_CORE_FEATURES, A4_CORE_FEATURES, FakeCore } from "./support/fake-core";
import {
  SERVICE_RUST,
  desktopProxyRustSource,
  protocolRustSource,
  repoFile,
  rustFormatTemplate,
  rustMethodAll,
  rustStrConst,
  rustUsizeConst,
} from "./support/rust-source";

const APPLY_RUST = "core/crates/sandpane-core/src/apply.rs";
const GIT_APPLY_RUST = "core/crates/sandpane-service/src/git_apply.rs";
const cp = (n: number): string => String.fromCodePoint(n);

const REPO = "/Users/dev/Atlas Demo";
const BASE = "a".repeat(40);
const BLOB = (c: string) => c.repeat(40);

/** Paths that must travel byte for byte. */
const TAB_PATH = "src/a\tb.ts";
const QUOTE_PATH = 'docs/"quoted".md';
const NEWLINE_PATH = "docs/new\nline.txt";
const NON_ASCII_PATH = `src/${cp(0xfc)}ber-${cp(0x65e5)}.ts`;

/** A `git.review` answer as Core serializes it (illustrative, from protocol lib.rs). */
function wireReview(): Record<string, unknown> & { changes: Record<string, unknown>[] } {
  return {
    taskId: "t1",
    baseCommit: BASE,
    hostDirty: false,
    repoPath: REPO,
    reviewId: "4f9c1a52-2a51-4d6e-9d5f-0b8f0e6f3c11",
    hostHooksPath: ".husky",
    changes: [
      { path: TAB_PATH, status: "modified", taskBlob: BLOB("1"), taskMode: "100644" },
      { path: QUOTE_PATH, status: "added", taskBlob: BLOB("2"), taskMode: "100644" },
      { path: NEWLINE_PATH, status: "untracked", taskBlob: BLOB("3"), taskMode: "100755" },
      { path: NON_ASCII_PATH, status: "renamed", oldPath: "src/old.ts", taskBlob: BLOB("4"), taskMode: "100644" },
      { path: "gone.txt", status: "deleted" },
      { path: "link", status: "added", taskBlob: BLOB("5"), taskMode: "120000" },
      { path: "huge.bin", status: "modified" },
      { path: "half.txt", status: "modified", taskBlob: BLOB("6") },
      { path: "src/next.ts", status: "type_changed", taskBlob: BLOB("7"), taskMode: "100644" },
    ],
  };
}

function review(): ChangeSet {
  return decodeChangeSet(wireReview());
}

/** A transport that records every frame and answers from a script. */
class ScriptedCore implements CoreTransport {
  readonly kind = "memory";
  readonly frames: { id: string; method: string; params: unknown }[] = [];
  private listeners: ((line: string) => void)[] = [];
  /** What Core answers to the next `git.apply`: `ok`, `err`, or silence. */
  answer: { ok: unknown } | { err: { code: string; message: string } } | null = {
    ok: { applied: true, conflictedFiles: [] },
  };

  write(frame: string): void {
    const request = JSON.parse(frame) as { id: string; method: string; params: unknown };
    this.frames.push(request);
    if (this.answer === null) return;
    const line = encodeFrame({ v: PROTOCOL_VERSION, id: request.id, ...this.answer }).trimEnd();
    queueMicrotask(() => this.listeners.forEach((l) => l(line)));
  }
  onLine(handler: (line: string) => void): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== handler);
    };
  }
  onClose(): () => void {
    return () => {};
  }
  close(): void {}
}

async function failure(p: Promise<unknown>): Promise<CoreRequestError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CoreRequestError);
  return e as CoreRequestError;
}

function okPlan(selected: number[], diffs: ReadonlyMap<string, DiffRecord> = new Map()): ApplySnapshot {
  const plan = planReviewedApply({ taskId: "t1", changeSet: review(), selected: new Set(selected), diffs });
  if (!plan.ok) throw new Error(`plan refused: ${plan.reason}`);
  return plan.snapshot;
}

const trusted = { nativeEvent: { isTrusted: true } };

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

describe("A6 drift against the Rust sources", () => {
  it("git-apply is the 5th known feature, in Rust FEATURES order (7 since A9); methods are 36 since A9", () => {
    const rust = /pub const FEATURES: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(protocolRustSource());
    const names = [...((rust?.[2] ?? "").matchAll(/"([^"]+)"/g))].map((m) => m[1]);
    expect(Number(rust?.[1])).toBe(7);
    expect([...KNOWN_FEATURES]).toEqual(names);
    expect(KNOWN_FEATURES).toHaveLength(7);
    expect(KNOWN_FEATURES[4]).toBe(FEATURE_GIT_APPLY);
    expect(FEATURE_GIT_APPLY).toBe("git-apply");
    // The A6 double advertises the A6 prefix (A7 appended verification).
    expect(A6_CORE_FEATURES.filter((f) => names.includes(f))).toEqual(names.slice(0, 5));
    const all = rustMethodAll();
    expect(all.declaredLength).toBe(36);
    expect([...METHODS]).toEqual(all.names);
    expect(METHODS).toHaveLength(36);
  });

  it("git.apply gets the git deadline: webview 45 000 (Core's CLIENT_APPLY_DEADLINE), proxy 43 000", () => {
    expect(METHOD_TIMEOUT_MS["git.apply"]).toBe(45_000);
    expect(repoFile(APPLY_RUST)).toContain("pub const CLIENT_APPLY_DEADLINE: Duration = Duration::from_secs(45);");
    const body =
      /pub fn proxy_deadline_ms\(method: Method\) -> u64 \{([\s\S]*?)\n\}/.exec(desktopProxyRustSource())?.[1] ?? "";
    expect(body).toMatch(/Method::GitApply => 43_000/);
  });

  it("git.apply is neither replay-safe nor read-only, on either side", () => {
    expect(REPLAY_SAFE_METHODS.has("git.apply")).toBe(false);
    const proxy = desktopProxyRustSource();
    const replay = /fn replay_safe\(method: Method\) -> bool \{([\s\S]*?)\n\}/.exec(proxy)?.[1] ?? "";
    expect(replay).not.toContain("GitApply");
    const readOnly = /fn is_read_only\(method: Method\) -> bool \{([\s\S]*?)\n\}/.exec(proxy)?.[1] ?? "";
    const trueArm = readOnly.slice(0, readOnly.indexOf("=> true"));
    expect(trueArm).not.toContain("GitApply");
    const falseArm = readOnly.slice(readOnly.indexOf("=> true"));
    expect(falseArm).toContain("Method::GitApply");
    expect(falseArm).not.toContain("Method::GitApply => true");
    // A9 appended MaintenanceCleanup to the false arm.
    expect(falseArm).toContain("Method::MaintenanceCleanup => false");
    // The webview's own lost-answer copy for git.apply says "may have been applied".
    const lost = timeoutError("git.apply", 45_000);
    expect(lost.mayHaveBeenApplied).toBe(true);
  });

  it("MAX_APPLY_ENTRIES is Core's", () => {
    expect(rustUsizeConst(APPLY_RUST, "MAX_APPLY_ENTRIES")).toBe(MAX_APPLY_ENTRIES);
    expect(MAX_APPLY_ENTRIES).toBe(1000);
  });

  it("every exact message the copy keys on is Core's constant", () => {
    for (const [name, value] of [
      ["MSG_NEEDS_REVIEW", MSG_NEEDS_REVIEW],
      ["MSG_SELECTED_FILES", MSG_SELECTED_FILES],
      ["MSG_TOO_MANY_ENTRIES", MSG_TOO_MANY_ENTRIES],
      ["MSG_ENTRIES_NOT_REVIEWED", MSG_ENTRIES_NOT_REVIEWED],
      ["MSG_DIRECT_MOUNT", MSG_DIRECT_MOUNT],
      ["MSG_CHECK_FAILED", MSG_CHECK_FAILED],
      ["MSG_PATCH_TOO_LARGE", MSG_PATCH_TOO_LARGE],
      ["MSG_PREPARE_TOO_SLOW", MSG_PREPARE_TOO_SLOW],
      ["MSG_CONTENT_TOO_LARGE", MSG_CONTENT_TOO_LARGE],
      ["MSG_WRITE_NOT_RUN", MSG_WRITE_NOT_RUN],
      ["MSG_CHECK_UNAVAILABLE", MSG_CHECK_UNAVAILABLE],
      ["MSG_HOST_UNBORN", MSG_HOST_UNBORN],
      ["MSG_HOST_WORK_TREE_REDIRECTED", MSG_HOST_WORK_TREE_REDIRECTED],
    ] as const) {
      expect(rustStrConst(APPLY_RUST, name), name).toBe(value);
    }
    // msg_context(MSG_NO_GIT_CONTEXT): the only apply outcome reachable over the wire.
    expect(rustFormatTemplate(APPLY_RUST, "msg_context")).toBe("{review_message}; nothing was written");
    expect(MSG_APPLY_NO_GIT_CONTEXT).toBe(`${rustStrConst(SERVICE_RUST, "MSG_NO_GIT_CONTEXT")}; nothing was written`);
  });

  it("every fixed fragment of a format! message is in Core's template", () => {
    const F = APPLY_FRAGMENTS;
    const t = (fn: string, file = APPLY_RUST) => rustFormatTemplate(file, fn);
    const cases: [string, string, string?][] = [
      ["msg_changed", F.changed],
      ["msg_listed_twice", F.listedTwice],
      ["msg_no_content", F.noContent],
      ["msg_symlink", F.symlink],
      ["msg_gitlink", F.gitlink],
      ["msg_base_symlink", F.baseSymlink],
      ["msg_collision", F.collision],
      ["msg_snapshot_differs", F.snapshotDiffers],
      ["msg_leading_path", F.leadingPath],
      ["msg_dirty", F.dirty],
      ["msg_hidden", F.hidden],
      ["msg_filtered", F.filteredInfix],
      ["msg_filtered", F.filteredSuffix],
      ["msg_head_moved", F.headMovedPrefix],
      ["msg_head_moved", F.headMovedInfix],
      ["msg_expected_base", F.expectedBasePrefix],
      ["msg_write_failed", F.writeFailedPrefix],
      ["msg_write_killed", F.indexLockInfix],
      ["msg_verify_unavailable", F.verifyUnavailablePrefix],
      ["msg_verify_failed", F.verifyFailedPrefix],
      ["msg_mounted", F.mountedSuffix],
      ["msg_locked", F.lockedInfix, GIT_APPLY_RUST],
      ["msg_locked", F.lockedSuffix, GIT_APPLY_RUST],
    ];
    for (const [fn, fragment, file] of cases) {
      expect(t(fn, file), `${fn}: ${fragment}`).toContain(fragment);
    }
    // Position matters where the copy matches on it.
    expect(t("msg_changed").endsWith(F.changed)).toBe(true);
    expect(t("msg_write_failed").startsWith(F.writeFailedPrefix)).toBe(true);
    expect(t("msg_verify_unavailable").startsWith(F.verifyUnavailablePrefix)).toBe(true);
    expect(t("msg_mounted").endsWith(F.mountedSuffix)).toBe(true);
    expect(t("msg_locked", GIT_APPLY_RUST).endsWith(F.lockedSuffix)).toBe(true);
  });

  it("the four apply event kinds are Core's, and reconcile outcomes are Core's strings", () => {
    for (const name of ["EVENT_APPLY_STARTED", "EVENT_APPLIED", "EVENT_APPLY_FAILED", "EVENT_APPLY_RECONCILED"]) {
      expect(CORE_EVENT_KINDS as readonly string[]).toContain(rustStrConst(GIT_APPLY_RUST, name));
    }
    const apply = repoFile(APPLY_RUST);
    for (const outcome of ['"applied"', '"partial"', '"not_applied"']) expect(apply).toContain(`=> ${outcome}`);
    expect(repoFile(GIT_APPLY_RUST)).toContain('"startedSequence": started_sequence');
  });
});

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

describe("A6 fields decode as optional open strings", () => {
  it("ChangeSet.reviewId / hostHooksPath and FileChange.taskBlob / taskMode", () => {
    const set = review();
    expect(set.reviewId).toBe(wireReview().reviewId);
    expect(set.hostHooksPath).toBe(".husky");
    expect(set.changes[0]).toEqual({ path: TAB_PATH, status: "modified", taskBlob: BLOB("1"), taskMode: "100644" });
    expect(set.changes[4]).toEqual({ path: "gone.txt", status: "deleted" });
    // Open strings: an unexpected mode or a 64-hex blob is kept, never refused.
    const odd = decodeChangeSet({
      ...wireReview(),
      changes: [{ path: "p", status: "added", taskBlob: "f".repeat(64), taskMode: "100664" }],
    });
    expect(odd.changes[0]).toMatchObject({ taskBlob: "f".repeat(64), taskMode: "100664" });
    // Absent everywhere (a pre-A6 Core): tolerated.
    const old = decodeChangeSet({ taskId: "t", baseCommit: BASE, hostDirty: false, changes: [] });
    expect(old.reviewId).toBeUndefined();
    expect(old.hostHooksPath).toBeUndefined();
  });

  it("GitDiffResult.taskBlob / taskMode", () => {
    const r = decodeGitDiffResult({
      path: "a",
      status: "modified",
      patch: "",
      binary: false,
      truncated: false,
      lossy: false,
      taskBlob: BLOB("9"),
      taskMode: "100755",
    });
    expect(r).toMatchObject({ taskBlob: BLOB("9"), taskMode: "100755" });
    expect(diffRecordOf(r)).toEqual({ taskBlob: BLOB("9"), taskMode: "100755", binary: false, truncated: false });
  });

  it("ApplyResult A6 fields; a garbled partial is a possible partial, never 'nothing written'", () => {
    const ok = decodeApplyResult({
      applied: true,
      conflictedFiles: [],
      appliedFiles: ["a", "b"],
      modeChanges: [{ path: "b", from: "100644", to: "100755" }],
      snapshotTree: BLOB("e"),
    });
    expect(ok).toMatchObject({ appliedFiles: ["a", "b"], snapshotTree: BLOB("e") });
    expect(ok.modeChanges).toEqual([{ path: "b", from: "100644", to: "100755" }]);
    expect(ok.partial).toBeUndefined();
    expect(decodeApplyResult({ applied: false, conflictedFiles: [], partial: true }).partial).toBe(true);
    expect(decodeApplyResult({ applied: false, conflictedFiles: [], partial: "yes" }).partial).toBe(true);
    expect(decodeApplyResult({ applied: false, conflictedFiles: [], partial: false }).partial).toBeUndefined();
  });

  it("a renamed entry with an empty patch reads 'renamed, content unchanged'", () => {
    const lines = diffDisclosures(
      { path: "new.md", oldPath: "old.md", status: "renamed", patch: "", binary: false, truncated: false, lossy: false },
      undefined,
    );
    expect(lines).toContain(RENAME_UNCHANGED_DISCLOSURE);
    expect(lines.join(" ")).not.toMatch(/no changes/i);
  });
});

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

describe("git.apply frames", () => {
  it("sends {taskId, expectedBase, reviewId, entries} with entries VERBATIM from the review", async () => {
    const core = new ScriptedCore();
    const client = new CoreClient(core);
    const snapshot = okPlan([0, 1, 2, 3, 4]);
    await client.applyChanges(snapshot.request);
    expect(core.frames).toHaveLength(1);
    const frame = core.frames[0];
    expect(frame?.method).toBe("git.apply");
    const params = frame?.params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(["entries", "expectedBase", "reviewId", "taskId"]);
    expect(params.reviewId).toBe(wireReview().reviewId);
    expect(params.expectedBase).toBe(BASE);
    // Byte-exact: the entries ARE the wire entries of the review answer.
    expect(params.entries).toEqual(wireReview().changes.slice(0, 5));
    const paths = (params.entries as { path: string }[]).map((e) => e.path);
    expect(paths).toEqual([TAB_PATH, QUOTE_PATH, NEWLINE_PATH, NON_ASCII_PATH, "gone.txt"]);
  });

  it("never sends selectedFiles, unrecognizedStatus, or a client-only status", async () => {
    const core = new ScriptedCore();
    const client = new CoreClient(core);
    const smuggled = { ...okPlan([0]).request, selectedFiles: ["src/x"] } as never;
    await client.applyChanges(smuggled);
    const raw = JSON.stringify(core.frames[0]?.params);
    expect(raw).not.toContain("selectedFiles");
    expect(raw).not.toContain("unrecognizedStatus");
    expect(raw).not.toContain('"unknown"');
  });

  it("no source file in src/ builds a selectedFiles param", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    walk(root);
    for (const file of files) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/selectedFiles\s*[:?]/);
    }
  });

  it("refuses, with NO frame, what Core refuses: no reviewId, no entries, more than 1000", async () => {
    const core = new ScriptedCore();
    const client = new CoreClient(core);
    const request = okPlan([0]).request;
    for (const bad of [
      { ...request, reviewId: "" },
      { ...request, entries: [] },
      { ...request, entries: Array.from({ length: 1001 }, () => request.entries[0]!) },
    ]) {
      const err = await failure(client.applyChanges(bad));
      expect(err.code).toBe("INVALID_PARAMS");
      expect(applyFailureCopy(err, REPO).kind).toBe("not-sent");
    }
    expect(core.frames).toHaveLength(0);
    expect(buildGitApplyParams({ ...request, entries: Array(1000).fill(request.entries[0]) }).entries).toHaveLength(1000);
  });
});

// ---------------------------------------------------------------------------
// Gating and selectability
// ---------------------------------------------------------------------------

describe("Apply is gated on the git-apply feature", () => {
  it("needs BOTH the git.apply method and the git-apply feature", () => {
    const methods = [...A5_CORE_METHODS];
    expect(applyGate(null).state).toBe("unprobed");
    expect(applyGate({ methods, features: [...A4_CORE_FEATURES] })).toEqual({
      state: "unsupported",
      note: APPLY_UNSUPPORTED_NOTE,
    });
    expect(applyGate({ methods, features: undefined }).state).toBe("unsupported");
    expect(applyGate({ methods: methods.filter((m) => m !== "git.apply"), features: ["git-apply"] }).state).toBe(
      "unsupported",
    );
    expect(applyGate({ methods, features: [...A6_CORE_FEATURES] }).state).toBe("supported");
  });

  it("through a probe: an A4/A5 Core keeps Apply off, an A6 Core turns it on", async () => {
    const a5 = await new CoreClient(
      new FakeCore({ advertisedMethods: A5_CORE_METHODS, features: A4_CORE_FEATURES }).transport,
    ).probe();
    const a6 = await new CoreClient(
      new FakeCore({ advertisedMethods: A5_CORE_METHODS, features: A6_CORE_FEATURES }).transport,
    ).probe();
    if (a5.kind !== "attached" || a6.kind !== "attached") throw new Error("probe failed");
    expect(applyGate(a5.capabilities).state).toBe("unsupported");
    expect(applyGate(a6.capabilities).state).toBe("supported");
  });
});

describe("selectability", () => {
  it("deleted, or taskBlob + taskMode, and never 120000; otherwise disabled with the reason", () => {
    const verdicts = reviewSelectability(review());
    expect(verdicts.slice(0, 5).every((v) => v.selectable)).toBe(true);
    expect(verdicts[5]).toEqual({ selectable: false, reason: REASON_SYMLINK });
    expect(verdicts[6]).toEqual({ selectable: false, reason: REASON_TOO_LARGE });
    expect(verdicts[7]).toEqual({ selectable: false, reason: REASON_NO_CONTENT_ID });
    expect(verdicts[8]?.selectable).toBe(false);
    expect(REASON_SYMLINK).toBe("symlinks are never applied");
    expect(REASON_TOO_LARGE).toBe("too large or unreadable to apply (over 32 MiB)");
    expect(REASON_NO_CONTENT_ID).toBe("no reviewed content id");
  });

  it("an answer without reviewId is never applicable", () => {
    const set = { ...review(), reviewId: undefined };
    expect(reviewSelectability(set).every((v) => !v.selectable)).toBe(true);
    const plan = planReviewedApply({ taskId: "t1", changeSet: set, selected: new Set([0]), diffs: new Map() });
    expect(plan).toEqual({ ok: false, reason: REASON_NO_REVIEW_ID, reReview: false });
    const change: FileChange = { path: "x", status: "modified", taskBlob: BLOB("1"), taskMode: "100644" };
    expect(entrySelectability(change, { reviewBound: false, unknownTwin: false }).selectable).toBe(false);
  });

  it("a rename is ONE entry and carries its oldPath; selection is by index, in Core's order", () => {
    const snapshot = okPlan([3, 0]);
    expect(snapshot.request.entries.map((e) => e.path)).toEqual([TAB_PATH, NON_ASCII_PATH]);
    expect(snapshot.request.entries[1]).toEqual({
      path: NON_ASCII_PATH,
      status: "renamed",
      oldPath: "src/old.ts",
      taskBlob: BLOB("4"),
      taskMode: "100644",
    });
  });

  it("an unselectable index or an empty selection plans nothing", () => {
    for (const selected of [[], [5], [6], [7], [8], [42]]) {
      const plan = planReviewedApply({ taskId: "t1", changeSet: review(), selected: new Set(selected), diffs: new Map() });
      expect(plan.ok, String(selected)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Confirmation: flags, gesture, rendering
// ---------------------------------------------------------------------------

describe("confirmation flags", () => {
  it("(a) never opened, binary, truncated, or a diff without the reviewed content id", () => {
    const set = review();
    const shown = (i: number, record: Partial<DiffRecord> = {}): [string, DiffRecord] => {
      const c = set.changes[i]!;
      return [
        diffRecordKey(c.path, c.status),
        { binary: false, truncated: false, ...(c.taskBlob === undefined ? {} : { taskBlob: c.taskBlob }), ...record },
      ];
    };
    const diffs = new Map([
      shown(0),
      shown(1, { binary: true }),
      shown(2, { truncated: true }),
      [diffRecordKey(NON_ASCII_PATH, "renamed"), { binary: false, truncated: false }],
      shown(4),
    ]);
    const flags = okPlan([0, 1, 2, 3, 4], diffs).flags;
    expect(flags.notFullyShown.map((f) => [f.entry.path, f.why])).toEqual([
      [QUOTE_PATH, "binary — no text diff was shown"],
      [NEWLINE_PATH, "the diff was truncated"],
      [NON_ASCII_PATH, "the diff did not name the reviewed content"],
    ]);
    expect(okPlan([0]).flags.notFullyShown[0]?.why).toBe("never opened in the Diff view");
  });

  it("(b) executable additions and exec-bit changes (taskMode 100755)", () => {
    const flags = okPlan([0, 1, 2]).flags;
    expect(flags.executable.map((f) => f.entry.path)).toEqual([NEWLINE_PATH]);
  });

  it("(c) paths that run automatically, by component, any depth, any case, oldPath too", () => {
    for (const path of [
      ".husky/pre-commit",
      ".githooks/post-checkout",
      ".github/workflows/ci.yml",
      "pkg/.GitHub/Workflows/x.yml",
      ".envrc",
      "sub/.envrc",
      ".vscode/settings.json",
      ".idea/workspace.xml",
      ".gitattributes",
      "lib/.gitattributes",
      ".gitmodules",
      ".VSCode/tasks.json",
    ]) {
      expect(autoRunReason(path), path).not.toBeNull();
    }
    for (const path of ["src/husky.ts", ".github/README.md", "docs/vscode.md", "envrc", "a/.husky-notes"]) {
      expect(autoRunReason(path), path).toBeNull();
    }
    // hostHooksPath: by component prefix, `./` and trailing `/` ignored; root = everything.
    expect(autoRunReason("tools/hooks/pre-push", "./tools/hooks/")).not.toBeNull();
    expect(autoRunReason("tools/hooksx/a", "tools/hooks")).toBeNull();
    expect(autoRunReason("anything.txt", ".")).not.toBeNull();
    const flags = applyFlags(
      [{ path: "src/ok.ts", status: "renamed", oldPath: ".husky/old", taskBlob: BLOB("1"), taskMode: "100644" }],
      new Map(),
    );
    expect(flags.autoRun).toHaveLength(1);
  });
});

describe("the confirmation opens only from a trusted gesture on Apply", () => {
  it("openApplyConfirmation needs a trusted click AND an ok plan", () => {
    const plan = planReviewedApply({ taskId: "t1", changeSet: review(), selected: new Set([0]), diffs: new Map() });
    expect(openApplyConfirmation(null, plan)).toBeNull();
    expect(openApplyConfirmation(undefined, plan)).toBeNull();
    expect(openApplyConfirmation({}, plan)).toBeNull();
    expect(openApplyConfirmation({ nativeEvent: { isTrusted: false } }, plan)).toBeNull();
    expect(openApplyConfirmation(trusted, plan)).not.toBeNull();
    const refused = planReviewedApply({ taskId: "t1", changeSet: review(), selected: new Set(), diffs: new Map() });
    expect(openApplyConfirmation(trusted, refused)).toBeNull();
  });

  it("ReviewPanel opens it ONLY inside the Apply button's onClick (source pin)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/components/review/ReviewPanel.tsx", import.meta.url)),
      "utf8",
    );
    // Exactly one non-null setConfirm, fed by openApplyConfirmation(event, …).
    expect([...source.matchAll(/setConfirm\((?!null\))/g)]).toHaveLength(1);
    expect([...source.matchAll(/openApplyConfirmation\(/g)]).toHaveLength(1);
    const opener = /onClick=\{\(event\) => \{([\s\S]*?)\n\s*\}\}/.exec(source)?.[1] ?? "";
    expect(opener).toContain("openApplyConfirmation(event, plan)");
    expect(opener).toContain("setConfirm(snapshot)");
    // No effect, timer or subscription can open it.
    expect(source).not.toMatch(/useEffect\([^)]*setConfirm\((?!null)/s);
    expect(source).not.toMatch(/setTimeout|setInterval/);
  });

  it("no apply surface uses an HTML sink", () => {
    for (const file of ["ApplyConfirmDialog.tsx", "ApplyOutcome.tsx", "ReviewPanel.tsx"]) {
      const source = readFileSync(
        fileURLToPath(new URL(`../src/components/review/${file}`, import.meta.url)),
        "utf8",
      );
      expect(source, file).not.toContain("dangerouslySetInnerHTML");
      expect(source, file).not.toContain("innerHTML");
    }
  });
});

describe("the confirmation dialog renders text, never markup", () => {
  const hostile = `src/<script>alert(1)</script>${cp(0x202e)}gnp.exe`;
  const hostileSet = (): ChangeSet => ({
    taskId: "t1",
    baseCommit: BASE,
    hostDirty: false,
    reviewId: "r1",
    repoPath: `/Users/dev/<img src=x onerror=alert(1)>${cp(0x200b)}`,
    hostHooksPath: "tools/hooks",
    changes: [
      { path: hostile, status: "added", taskBlob: BLOB("1"), taskMode: "100755" },
      { path: ".husky/pre-commit", status: "modified", taskBlob: BLOB("2"), taskMode: "100644" },
      { path: "tools/hooks/post", status: "added", taskBlob: BLOB("3"), taskMode: "100644" },
      { path: "plain.ts", status: "renamed", oldPath: "was.ts", taskBlob: BLOB("4"), taskMode: "100644" },
    ],
  });

  function render(snapshot: ApplySnapshot): string {
    return renderToStaticMarkup(
      createElement(ApplyConfirmDialog, { snapshot, onCancel: () => {}, onConfirm: () => {} }),
    );
  }

  it("alertdialog, Cancel focused by default, explicit 'Apply N files', the statement", () => {
    const plan = planReviewedApply({ taskId: "t1", changeSet: hostileSet(), selected: new Set([0, 1, 2, 3]), diffs: new Map() });
    if (!plan.ok) throw new Error(plan.reason);
    const html = render(plan.snapshot);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/<button[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/);
    expect(html).not.toMatch(/data-autofocus="true"[^>]*>Apply/);
    expect(html).toContain(`>${applyButtonLabel(4)}</button>`);
    expect(applyButtonLabel(4)).toBe("Apply 4 files");
    expect(applyButtonLabel(1)).toBe("Apply 1 file");
    expect(html).toContain(APPLY_STATEMENT.replace(/'/g, "&#x27;"));
    expect(APPLY_STATEMENT).toBe(
      "Writes these files into your working tree and stages them. Nothing is committed. The content is the version Core hashed when you reviewed.",
    );
  });

  it("<script> and bidi / zero-width characters are escaped text, revealed", () => {
    const plan = planReviewedApply({ taskId: "t1", changeSet: hostileSet(), selected: new Set([0, 1, 2, 3]), diffs: new Map() });
    if (!plan.ok) throw new Error(plan.reason);
    const html = render(plan.snapshot);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("\\u202E");
    expect(html).toContain("\\u200B");
    expect(html).not.toContain(cp(0x202e));
    expect(html).not.toContain(cp(0x200b));
    expect(html).toContain("unusual characters");
    // Every file listed, the rename as oldPath → path.
    expect(html).toContain("was.ts</code> → <code");
    expect(html).toContain("Every file (4)");
  });

  it("shows flags (a), (b) and (c) separately", () => {
    const plan = planReviewedApply({ taskId: "t1", changeSet: hostileSet(), selected: new Set([0, 1, 2, 3]), diffs: new Map() });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.snapshot.flags.notFullyShown).toHaveLength(4);
    expect(plan.snapshot.flags.executable.map((f) => f.entry.path)).toEqual([hostile]);
    expect(plan.snapshot.flags.autoRun.map((f) => f.entry.path)).toEqual([".husky/pre-commit", "tools/hooks/post"]);
    const html = render(plan.snapshot);
    expect(html).toContain("(a) Content you have not fully seen (4)");
    expect(html).toContain("(b) Executable files (1)");
    expect(html).toContain("(c) Paths that run automatically (2)");
  });

  it("caps an overlong path visibly", () => {
    const long = `${"d/".repeat(800)}x.ts`;
    const plan = planReviewedApply({
      taskId: "t1",
      changeSet: { ...hostileSet(), changes: [{ path: long, status: "added", taskBlob: BLOB("1"), taskMode: "100644" }] },
      selected: new Set([0]),
      diffs: new Map(),
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(render(plan.snapshot)).toMatch(/… \(\d+ more characters\)/);
    // …while the frame still carries the full path.
    expect(plan.snapshot.request.entries[0]?.path).toBe(long);
  });
});

// ---------------------------------------------------------------------------
// The diff-mismatch rule
// ---------------------------------------------------------------------------

describe("a diff that shows different content blocks the send", () => {
  it("planning refuses with a re-review, and NO frame is written", async () => {
    const core = new ScriptedCore();
    const client = new CoreClient(core);
    const diffs = new Map([[diffRecordKey(TAB_PATH, "modified"), { taskBlob: BLOB("f"), binary: false, truncated: false }]]);
    const plan = planReviewedApply({ taskId: "t1", changeSet: review(), selected: new Set([0, 1]), diffs });
    expect(plan).toEqual({ ok: false, reason: "src/a\\u0009b.ts changed after you reviewed it — review again", reReview: true });
    // The panel's flow: send only an ok, unrefused snapshot.
    if (plan.ok && confirmRefusal(plan.snapshot, diffs) === null) await client.applyChanges(plan.snapshot.request);
    expect(core.frames).toHaveLength(0);
  });

  it("a diff arriving after the modal opened is caught at confirm time", async () => {
    const core = new ScriptedCore();
    const client = new CoreClient(core);
    const snapshot = okPlan([4]);
    // A deleted entry has no taskBlob; a diff that now finds a file is a change.
    const later = new Map([[diffRecordKey("gone.txt", "deleted"), { taskBlob: BLOB("b"), binary: false, truncated: false }]]);
    expect(confirmRefusal(snapshot, later)).toBe("gone.txt changed after you reviewed it — review again");
    if (confirmRefusal(snapshot, later) === null) await client.applyChanges(snapshot.request);
    expect(core.frames).toHaveLength(0);
    // A matching diff never blocks.
    const same = new Map([[diffRecordKey(TAB_PATH, "modified"), { taskBlob: BLOB("1"), binary: false, truncated: false }]]);
    expect(confirmRefusal(okPlan([0], same), same)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outcome copy
// ---------------------------------------------------------------------------

describe("results", () => {
  it("success: 'Applied N files to <repo> (staged, not committed)', plus mode changes", () => {
    const copy = applyOutcomeCopy(
      {
        applied: true,
        conflictedFiles: [],
        appliedFiles: ["a.sh", "b.ts"],
        modeChanges: [{ path: "a.sh", from: "100644", to: "100755" }],
      },
      REPO,
      2,
    );
    expect(copy.kind).toBe("success");
    expect(copy.title).toBe(`Applied 2 files to ${REPO} (staged, not committed)`);
    expect(copy.details).toContain("mode change: a.sh 100644 → 100755");
    expect(copy.tone).toBe("success");
  });

  it("partial: a danger warning naming git status / index.lock, never success or 'nothing written'", () => {
    const killed = `the write failed after git's checks passed; some files may have been written or staged — check \`git status\` in ${REPO}; \`.git/index.lock\` may remain — remove it only after checking that no git process is running`;
    for (const reason of [
      `the write failed after git's checks passed; some files may have been written or staged — check \`git status\` in ${REPO}`,
      killed,
      `files were changed, but the staged content differs from the reviewed content — check \`git status\` in ${REPO}`,
      `could not verify the staged content — check \`git status\` in ${REPO}`,
    ]) {
      const copy = applyOutcomeCopy({ applied: false, conflictedFiles: [], partial: true, abortReason: reason, appliedFiles: ["x"] }, REPO, 1);
      expect(copy.kind).toBe("partial");
      expect(copy.tone).toBe("danger");
      expect(copy.title).not.toMatch(/^Applied|nothing was written/);
      expect(copy.reason).toBe(reason);
      expect(copy.action).toContain(`\`git status\` in ${REPO}`);
      expect(copy.details).toEqual(["may have been written or staged: x"]);
    }
    expect(applyOutcomeCopy({ applied: false, conflictedFiles: [], partial: true, abortReason: killed }, REPO, 1).action).toContain(
      "`.git/index.lock` may remain",
    );
    // Even with applied: true, a partial is never a success.
    expect(applyOutcomeCopy({ applied: true, conflictedFiles: [], partial: true }, REPO, 1).kind).toBe("partial");
    const summary = reviewSummary(review(), { applied: false, conflictedFiles: [], partial: true });
    expect(summary.headline).toBe("Apply incomplete");
    expect(summary.detail).not.toContain("Not applied");
  });

  it("aborts get honest copy keyed on Core's exact text; re-review where it helps", () => {
    const cases: [string, RegExp, boolean][] = [
      [MSG_APPLY_NO_GIT_CONTEXT, /no Git context; nothing was written/, false],
      [MSG_DIRECT_MOUNT, /^Nothing to apply/, false],
      [MSG_ENTRIES_NOT_REVIEWED, /no longer knows this review/, true],
      ['"src/a.ts" changed since it was reviewed; review it again; nothing was written', /changed after you reviewed/, true],
      [MSG_CHECK_FAILED, /does not apply cleanly/, false],
      [MSG_CHECK_UNAVAILABLE, /git could not check the patch/, false],
      [MSG_CONTENT_TOO_LARGE, /too much to apply in one step/, false],
      [MSG_PATCH_TOO_LARGE, /too much to apply in one step/, false],
      [MSG_PREPARE_TOO_SLOW, /too much to apply in one step/, false],
      [MSG_WRITE_NOT_RUN, /git apply was not started/, false],
      ['"a", "b" in your working tree have uncommitted changes or are untracked or ignored files; nothing was written', /not clean/, false],
      ['"a" are flagged assume-unchanged or skip-worktree in your index, which hides changes; nothing was written', /hidden from git status/, false],
      ['"node_modules/x" lies under a symlink or a file in your working tree; nothing was written', /under a symlink/, false],
      ['"l": symlinks are never applied; nothing was written', /symlinks are never applied/, false],
      [`your repository's HEAD is ${BLOB("c")}, not the task's base ${BASE}; nothing was written`, /not at the task's base/, false],
      [`base diverged: the task's recorded base is ${BASE}, the client expected ${BLOB("d")}; nothing was written`, /not at the task's base/, false],
      ['"big.psd" has the filter attribute "lfs" (for example Git LFS) in your repository; Core never runs filters, so it would receive raw content; nothing was written', /git filter/, false],
    ];
    for (const [reason, title, reReview] of cases) {
      const copy = applyOutcomeCopy({ applied: false, conflictedFiles: [], abortReason: reason }, REPO, 1);
      expect(copy.kind, reason).toBe("aborted");
      expect(copy.title, reason).toMatch(title);
      expect(copy.reReview, reason).toBe(reReview);
      expect(copy.reason, reason).toBe(reason);
    }
    // The check-unavailable copy never says "does not apply cleanly".
    expect(applyOutcomeCopy({ applied: false, conflictedFiles: [], abortReason: MSG_CHECK_UNAVAILABLE }, REPO, 1).title).not.toMatch(
      /apply cleanly/,
    );
    // conflictedFiles are listed, revealed.
    const conflict = applyOutcomeCopy(
      { applied: false, conflictedFiles: [`x${cp(0x202e)}y`], abortReason: MSG_CHECK_FAILED },
      REPO,
      1,
    );
    expect(conflict.details).toEqual(["does not apply: x\\u202Ey"]);
  });

  it("an unknown reason is shown verbatim (revealed); 'nothing written' only if Core said so", () => {
    const odd = `some future refusal ${cp(0x202e)}; nothing was written`;
    const copy = applyOutcomeCopy({ applied: false, conflictedFiles: [], abortReason: odd }, REPO, 1);
    expect(copy.reason).toBe("some future refusal \\u202E; nothing was written");
    expect(copy.title).toBe("Not applied — Core refused; nothing was written");
    const bare = applyOutcomeCopy({ applied: false, conflictedFiles: [], abortReason: "future text" }, REPO, 1);
    expect(bare.title).not.toContain("nothing was written");
  });

  it("CONFLICT, writer lock: busy, nothing written, retry later — NOT an idempotency conflict", () => {
    const message = rustFormatTemplate(GIT_APPLY_RUST, "msg_locked")
      .replace("{repo}", REPO)
      .replace("{holder}", "git.apply:t9");
    const copy = applyFailureCopy(new CoreRequestError("core", "CONFLICT", message, undefined, "git.apply"), REPO);
    expect(copy.title).toBe("Not applied — the repository is busy; nothing was written");
    expect(copy.action).toMatch(/after it finishes/);
    expect(copy.action).not.toMatch(/idempotency|key/i);
  });

  it("CONFLICT, direct mount: stop or remove that sandbox first — never 'try again shortly'", () => {
    const message = rustFormatTemplate(APPLY_RUST, "msg_mounted").replace("{what}", 'sandbox "atlas-demo"');
    const copy = applyFailureCopy(new CoreRequestError("core", "CONFLICT", message, undefined, "git.apply"), REPO);
    expect(copy.title).toBe("Not applied — a sandbox mounts this repository directly; nothing was written");
    expect(copy.action).toMatch(/^Stop or remove that sandbox/);
    expect(copy.action).not.toMatch(/shortly|try again/i);
  });

  it("VALIDATION_FAILED and NOT_FOUND refusals", () => {
    const v = (m: string) => applyFailureCopy(new CoreRequestError("core", "VALIDATION_FAILED", m, undefined, "git.apply"), REPO);
    expect(v(MSG_NEEDS_REVIEW).reReview).toBe(true);
    expect(v(MSG_SELECTED_FILES).title).toMatch(/nothing was written/);
    expect(v(MSG_TOO_MANY_ENTRIES).title).toMatch(/too many files/);
    expect(applyFailureCopy(new CoreRequestError("core", "NOT_FOUND", "task not found"), REPO).title).toMatch(
      /does not know this task/,
    );
  });

  it("a timeout: 'the apply may have been applied; check git status in <repo>' — never 'nothing changed'", async () => {
    const core = new ScriptedCore();
    core.answer = null;
    const client = new CoreClient(core, { methodTimeoutsMs: { "git.apply": 20 } });
    const err = await failure(client.applyChanges(okPlan([0]).request));
    expect(core.frames).toHaveLength(1);
    expect(err.code).toBe("TIMEOUT");
    const copy = applyFailureCopy(err, REPO);
    expect(copy.title).toBe(
      `Core did not answer in time — the apply may have been applied; check \`git status\` in ${REPO} before retrying`,
    );
    expect(copy.title).toBe(lostAnswerTitle(REPO));
    expect(`${copy.title} ${copy.action}`).not.toMatch(/nothing (was|is) (changed|written)/);
    expect(copy.kind).toBe("unknown");
  });

  it("a lost answer from the proxy, a garbled answer, or Core's INTERNAL may have applied", async () => {
    const proxyLost = new CoreRequestError(
      "client",
      "TRANSPORT_CLOSED",
      "Core closed the connection — the request had already been delivered to Core, so it may have been applied. Re-read state before retrying.",
      { proxyCode: "CONNECTION_CLOSED", mayHaveBeenApplied: true },
      "git.apply",
    );
    expect(applyFailureCopy(proxyLost, REPO).title).toMatch(/may have been applied; check `git status`/);
    expect(applyFailureCopy(proxyLost, REPO).reason).toBe("Core closed the connection");

    const core = new ScriptedCore();
    core.answer = { ok: { applied: "yes", conflictedFiles: [] } };
    const garbled = await failure(new CoreClient(core).applyChanges(okPlan([0]).request));
    expect(garbled.code).toBe("MALFORMED_FRAME");
    expect(applyFailureCopy(garbled, REPO).kind).toBe("unknown");

    const internal = new CoreRequestError(
      "core",
      "INTERNAL",
      `git ran, but Core could not record the outcome (disk full) — check \`git status\` in ${REPO}`,
      undefined,
      "git.apply",
    );
    const copy = applyFailureCopy(internal, REPO);
    expect(copy.kind).toBe("unknown");
    expect(copy.title).toMatch(/may have been applied/);
    expect(copy.reason).toBe(internal.message);

    const notSent = new CoreRequestError(
      "client",
      "CORE_UNREACHABLE",
      "no Core",
      { proxyCode: "CORE_UNREACHABLE", mayHaveBeenApplied: false },
      "git.apply",
    );
    expect(applyFailureCopy(notSent, REPO).kind).toBe("not-sent");
  });

  it("'not sent' needs positive evidence: an oversized ANSWER or a bare code may have applied", () => {
    // The proxy's response-side cap goes through after_write: maybe applied.
    const oversizedAnswer = new CoreRequestError(
      "client",
      "FRAME_TOO_LARGE",
      "Core answered with a frame over the cap — the request had already been delivered to Core, so it may have been applied. Re-read state before retrying.",
      { proxyCode: "FRAME_TOO_LARGE", mayHaveBeenApplied: true },
      "git.apply",
    );
    expect(applyFailureCopy(oversizedAnswer, REPO).kind).toBe("unknown");
    expect(applyFailureCopy(oversizedAnswer, REPO).title).toMatch(/may have been applied/);
    // The same codes with no evidence of where they came from: unknown, never "not sent".
    for (const code of ["FRAME_TOO_LARGE", "INVALID_PARAMS", "CORE_UNREACHABLE", "TRANSPORT_UNAVAILABLE"] as const) {
      expect(applyFailureCopy(new CoreRequestError("client", code, "x"), REPO).kind, code).toBe("unknown");
    }
    // The webview's own encode-side cap names the request size: not sent.
    const encodeSide = new CoreRequestError("client", "FRAME_TOO_LARGE", "request too big", { byteLength: 5_000_000 });
    expect(applyFailureCopy(encodeSide, REPO).kind).toBe("not-sent");
  });

  it("an abort text arriving as a Core error gets the same copy and Review again", () => {
    for (const message of [MSG_ENTRIES_NOT_REVIEWED, '"a" changed since it was reviewed; review it again; nothing was written']) {
      const copy = applyFailureCopy(
        new CoreRequestError("core", "VALIDATION_FAILED", message, undefined, "git.apply"),
        REPO,
      );
      expect(copy.reReview, message).toBe(true);
      expect(copy.title, message).toMatch(/nothing was written/);
    }
  });

  it("the outcome view renders Core's text as text and offers Review again only when asked", () => {
    const copy = applyOutcomeCopy(
      { applied: false, conflictedFiles: [], abortReason: `<b>x</b>${cp(0x202e)}${MSG_ENTRIES_NOT_REVIEWED}` },
      REPO,
      1,
    );
    const html = renderToStaticMarkup(createElement(ApplyOutcome, { copy, onReReview: () => {} }));
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain(cp(0x202e));
    const reReview = applyOutcomeCopy({ applied: false, conflictedFiles: [], abortReason: MSG_ENTRIES_NOT_REVIEWED }, REPO, 1);
    expect(renderToStaticMarkup(createElement(ApplyOutcome, { copy: reReview, onReReview: () => {} }))).toContain(
      "Review again",
    );
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("apply events are shown honestly and never change the task status", () => {
  const ev = (sequence: number, kind: string, payload: unknown): TaskEvent => ({
    taskId: "t1",
    sequence,
    kind,
    payload,
    timestamp: `2026-10-11T00:00:0${sequence}Z`,
  });

  it("started / applied / failed (partial and not) / reconciled", () => {
    const base = { ...emptyProjection("t1"), status: "awaiting_review" as const };
    const folded = foldTaskEvents(base, [
      ev(1, "git.apply.started", { files: ["a", "b"], entries: [{ path: "SECRET-ENTRY" }], expected: "x", before: "y" }),
      ev(2, "git.applied", { startedSequence: 1, files: ["a", "b"] }),
      ev(3, "git.apply.failed", { startedSequence: 4, files: ["a"], reason: `w${cp(0x202e)}`, partial: true }),
      ev(4, "git.apply.failed", { startedSequence: 5, reason: MSG_CHECK_FAILED, partial: false }),
      ev(5, "git.apply.reconciled", { outcome: "partial", reconciledAfterRestart: true, startedSequence: 6 }),
      ev(6, "git.apply.reconciled", { outcome: "something-new" }),
      ev(7, "git.apply.failed", "not an object"),
    ]);
    expect(folded.status).toBe("awaiting_review");
    expect(folded.unknownKinds).toEqual([]);
    const texts = folded.entries.map((e) => (e.kind === "git-apply" ? e.text : `unexpected ${e.kind}`));
    expect(texts[0]).toBe("Apply started for 2 file(s) (Core recorded the start before writing)");
    expect(texts[1]).toBe("Applied 2 file(s) to the repository (staged, not committed)");
    expect(texts[2]).toContain("some files may have been written or staged; check git status: w\\u202E");
    expect(texts[3]).toBe(`Apply aborted, no partial write reported: ${MSG_CHECK_FAILED}`);
    expect(texts[4]).toContain("it found a PARTIAL apply — check git status");
    expect(texts[5]).toContain("it cannot know what was written (outcome: something-new)");
    // An unreadable payload is a POSSIBLE partial, never "nothing written".
    expect(texts[6]).toContain("some files may have been written or staged");
    expect(JSON.stringify(folded.entries)).not.toContain("SECRET-ENTRY");
  });
});
