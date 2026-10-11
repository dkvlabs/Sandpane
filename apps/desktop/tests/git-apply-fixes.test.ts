/**
 * A6 combined client review fixes on the desktop (design 2026-10-09 §3.6):
 *
 * - D-C1: a confirmed `git.apply` is sent at click time even when the webview
 *   believes it is offline, and is never sent later on an `online` event
 *   (Core is local IPC: `networkMode: "always"` for every query and mutation).
 * - W1: `msg_mount_being_created` is its own CONFLICT kind.
 * - W2: single flight and the last outcome survive a task switch (keyed
 *   mutation, kept in the client's mutation cache).
 * - I1: `MSG_WRITE_TOO_LATE`; I2: a diff is recorded only for its own entry;
 *   I4: the mismatch rule compares `taskMode` too; I5: the two
 *   `sandbox.create` repository-busy CONFLICTs.
 *
 * Driven through `@tanstack/react-query`'s own `MutationObserver` (the class
 * `useMutation` wraps), so no DOM is needed. Answers are scripted by hand from
 * the Rust sources (illustrative, never captured from a live Core).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, onlineManager } from "@tanstack/react-query";
import { CoreClient, CoreRequestError, type CoreTransport } from "../src/lib/core-client";
import {
  APPLY_FRAGMENTS,
  MSG_WRITE_TOO_LATE,
  applyFailureCopy,
  applyOutcomeCopy,
  diffMismatch,
  diffRecordFor,
  planReviewedApply,
} from "../src/lib/git-apply";
import {
  applyMutationFilters,
  applyMutationKey,
  applyMutationOptions,
  lastApplyState,
  type ApplyMutationState,
  type ApplyVariables,
} from "../src/lib/apply-mutation";
import { createQueryClient } from "../src/lib/query-client";
import { encodeFrame } from "../src/lib/framing";
import {
  CREATE_MOUNT_IN_PROGRESS_SUFFIX,
  CREATE_REPO_BUSY_SUFFIX,
  createRepoBusyKind,
} from "../src/lib/git-messages";
import { PROTOCOL_VERSION, type ChangeSet, type GitDiffResult } from "../src/lib/protocol";
import { describeCoreError } from "../src/lib/reducers";
import { rustFormatTemplate, rustStrConst } from "./support/rust-source";

const APPLY_RUST = "core/crates/sandpane-core/src/apply.rs";
const GIT_APPLY_RUST = "core/crates/sandpane-service/src/git_apply.rs";
const REPO = "/Users/dev/Atlas Demo";
const BASE = "a".repeat(40);

/** Records every frame; answers each `git.apply` after `delayMs` (or never). */
class ScriptedCore implements CoreTransport {
  readonly kind = "memory";
  readonly frames: { id: string; method: string; params: unknown }[] = [];
  private listeners: ((line: string) => void)[] = [];
  answer: unknown = { applied: false, conflictedFiles: [], partial: true, abortReason: "w" };
  delayMs = 0;
  write(frame: string): void {
    const request = JSON.parse(frame) as { id: string; method: string; params: unknown };
    this.frames.push(request);
    const line = encodeFrame({ v: PROTOCOL_VERSION, id: request.id, ok: this.answer }).trimEnd();
    setTimeout(() => this.listeners.forEach((l) => l(line)), this.delayMs);
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

function changeSet(): ChangeSet {
  return {
    taskId: "t1",
    baseCommit: BASE,
    hostDirty: false,
    reviewId: "r1",
    repoPath: REPO,
    changes: [{ path: "src/a.ts", status: "modified", taskBlob: "1".repeat(40), taskMode: "100644" }],
  };
}

function variables(): ApplyVariables {
  const plan = planReviewedApply({ taskId: "t1", changeSet: changeSet(), selected: new Set([0]), diffs: new Map() });
  if (!plan.ok) throw new Error(plan.reason);
  return { request: plan.snapshot.request, repoPath: plan.snapshot.repoPath };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

afterEach(() => {
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// D-C1
// ---------------------------------------------------------------------------

describe("D-C1: a confirmed apply is never deferred to an online event", () => {
  it("the client defaults carry networkMode 'always' for queries AND mutations", () => {
    const defaults = createQueryClient().getDefaultOptions();
    expect(defaults.queries?.networkMode).toBe("always");
    expect(defaults.mutations?.networkMode).toBe("always");
    // The existing query defaults are kept.
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
    expect(defaults.queries?.retry).toBe(1);
  });

  it("offline at confirm: the frame is sent at click time, and nothing more on setOnline(true)", async () => {
    const core = new ScriptedCore();
    const qc = createQueryClient();
    const observer = new MutationObserver(qc, applyMutationOptions(new CoreClient(core), qc, "t1"));
    expect(applyMutationOptions(new CoreClient(core), qc, "t1").networkMode).toBe("always");
    onlineManager.setOnline(false);
    void observer.mutate(variables()).catch(() => {});
    await flush();
    expect(core.frames).toHaveLength(1);
    expect(observer.getCurrentResult().isPaused).toBe(false);
    onlineManager.setOnline(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(core.frames).toHaveLength(1);
  });

  it("every other mutation inherits the default: offline never pauses it", async () => {
    const core = new ScriptedCore();
    const qc = createQueryClient();
    const client = new CoreClient(core);
    // A mutation that sets no networkMode of its own (like the 7 other useMutation sites).
    const observer = new MutationObserver(qc, { mutationFn: () => client.request("task.cancel", { taskId: "t1" }) });
    onlineManager.setOnline(false);
    void observer.mutate(undefined).catch(() => {});
    await flush();
    expect(core.frames).toHaveLength(1);
    expect(observer.getCurrentResult().isPaused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W2
// ---------------------------------------------------------------------------

describe("W2: single flight and the last outcome survive a task switch", () => {
  it("a pending apply still counts after its panel unmounts, and its partial stays visible", async () => {
    vi.useFakeTimers();
    const core = new ScriptedCore();
    core.delayMs = 1_000;
    const qc = createQueryClient();
    const key = applyMutationKey("t1");
    expect(key).toEqual(["core", "git", "apply", "t1"]);
    // Pinned explicitly: in node TanStack's default mutation gcTime is already
    // Infinity (its isServer branch), so the fake-timer wait below cannot catch
    // a missing gcTime; in the webview the default is 5 min.
    expect(applyMutationOptions(new CoreClient(core), qc, "t1").gcTime).toBe(Number.POSITIVE_INFINITY);
    const first = new MutationObserver(qc, applyMutationOptions(new CoreClient(core), qc, "t1"));
    const unsubscribe = first.subscribe(() => {});
    void first.mutate(variables()).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    // The user switches task: the panel (and its observer) goes away.
    unsubscribe();
    expect(qc.isMutating(applyMutationFilters("t1"))).toBe(1);
    expect(qc.isMutating(applyMutationFilters("t2"))).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(qc.isMutating(applyMutationFilters("t1"))).toBe(0);
    // Long after the default 5 min mutation gcTime, coming back still shows it.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    const states = qc.getMutationCache().findAll(applyMutationFilters("t1")).map((m) => m.state as ApplyMutationState);
    const last = lastApplyState(states);
    expect(last?.status).toBe("success");
    expect(last?.data?.partial).toBe(true);
    expect(last?.variables?.repoPath).toBe(REPO);
    expect(applyOutcomeCopy(last!.data!, last!.variables!.repoPath, 1).kind).toBe("partial");
    const other = qc.getMutationCache().findAll(applyMutationFilters("t2"));
    expect(lastApplyState(other.map((m) => m.state as ApplyMutationState))).toBeNull();
  });

  it("the panel reads pending and the last outcome from the keyed cache (source pin)", () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const panel = read("../src/components/review/ReviewPanel.tsx");
    expect(panel).toContain("useApplyChanges(taskId)");
    expect(panel).not.toMatch(/apply\.(isPending|data|error)\b/);
    expect(panel).toMatch(/disabled=\{!applySupported \|\| !plan\.ok \|\| apply\.pending/);
    const hooks = read("../src/lib/hooks.ts");
    expect(hooks).toContain("useIsMutating(filters)");
    expect(hooks).toMatch(/useMutationState<ApplyMutationState>\(\{ filters/);
  });

  it("the newest outcome wins", () => {
    const older = { status: "success", submittedAt: 1 } as never;
    const newer = { status: "error", submittedAt: 2 } as never;
    expect(lastApplyState([older, newer])).toBe(newer);
    expect(lastApplyState([newer, older])).toBe(newer);
    expect(lastApplyState([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// W1, I1, I5: Core's texts
// ---------------------------------------------------------------------------

describe("W1: a direct-mount sandbox being created is its own CONFLICT kind", () => {
  it("drift: the fragment is in Core's msg_mount_being_created template", () => {
    const template = rustFormatTemplate(GIT_APPLY_RUST, "msg_mount_being_created");
    expect(template.endsWith(APPLY_FRAGMENTS.mountBeingCreatedSuffix)).toBe(true);
  });

  it("copy: being created; once it exists every apply is refused until it is stopped or removed", () => {
    const message = rustFormatTemplate(GIT_APPLY_RUST, "msg_mount_being_created")
      .replace("{repo}", REPO)
      .replace("{sandbox:?}", '"atlas-demo"');
    const copy = applyFailureCopy(new CoreRequestError("core", "CONFLICT", message, undefined, "git.apply"), REPO);
    expect(copy.title).toBe(
      "Not applied — a direct-mount sandbox is being created for this repository; nothing was written",
    );
    expect(copy.action).toMatch(/once it exists, every apply to this repository is refused until it is stopped or removed/i);
    expect(copy.reason).toBe(message);
  });
});

describe("I1: MSG_WRITE_TOO_LATE", () => {
  it("is Core's constant and reads as not started, nothing written, not partial", () => {
    expect(rustStrConst(APPLY_RUST, "MSG_WRITE_TOO_LATE")).toBe(MSG_WRITE_TOO_LATE);
    const copy = applyOutcomeCopy({ applied: false, conflictedFiles: [], abortReason: MSG_WRITE_TOO_LATE }, REPO, 1);
    expect(copy.kind).toBe("aborted");
    expect(copy.title).toBe("Not applied — git apply was not started; nothing was written");
  });
});

describe("I5: sandbox.create repository-busy CONFLICTs", () => {
  const busy = rustFormatTemplate(GIT_APPLY_RUST, "msg_create_repo_busy")
    .replace("{repo}", REPO)
    .replace("{holder}", "git.apply:t1");
  const inProgress = rustFormatTemplate(GIT_APPLY_RUST, "msg_create_mount_in_progress")
    .replace("{repo}", REPO)
    .replace("{sandbox:?}", '"nova-demo"');

  it("drift: both suffixes are Core's", () => {
    expect(busy.endsWith(CREATE_REPO_BUSY_SUFFIX)).toBe(true);
    expect(inProgress.endsWith(CREATE_MOUNT_IN_PROGRESS_SUFFIX)).toBe(true);
    expect(createRepoBusyKind(busy)).toBe("writer-lock");
    expect(createRepoBusyKind(inProgress)).toBe("mount-in-progress");
    expect(createRepoBusyKind("something else; nothing was created")).toBeNull();
  });

  it("copy: repository busy — nothing was created; try again when it finishes; Core's text visible", () => {
    for (const message of [busy, inProgress]) {
      const copy = describeCoreError(new CoreRequestError("core", "CONFLICT", message, undefined, "sandbox.create"));
      expect(copy.title).toBe("Repository busy — nothing was created; try again when it finishes");
      expect(copy.reason).toBe(message);
      expect(copy.title).not.toMatch(/idempotency/i);
    }
  });
});

// ---------------------------------------------------------------------------
// I2, I4: what the user saw
// ---------------------------------------------------------------------------

describe("I2 / I4: diff records", () => {
  const result = (over: Partial<GitDiffResult>): GitDiffResult => ({
    path: "src/a.ts",
    status: "modified",
    patch: "",
    binary: false,
    truncated: false,
    lossy: false,
    taskBlob: "1".repeat(40),
    taskMode: "100644",
    ...over,
  });

  it("a diff is recorded only when BOTH path and status match the opened entry", () => {
    const entry = { path: "src/a.ts", status: "modified" as const };
    expect(diffRecordFor(entry, result({}))).not.toBeNull();
    expect(diffRecordFor(entry, result({ status: "untracked" }))).toBeNull();
    expect(diffRecordFor(entry, result({ path: "src/b.ts" }))).toBeNull();
    expect(diffRecordFor(entry, result({ status: "unknown", unrecognizedStatus: "x" }))).toBeNull();
  });

  it("the mismatch rule compares taskMode as well as taskBlob", () => {
    const entry = { taskBlob: "1".repeat(40), taskMode: "100644" };
    const record = (over: Partial<GitDiffResult>) => diffRecordFor({ path: "src/a.ts", status: "modified" }, result(over));
    expect(diffMismatch(entry, record({}) ?? undefined)).toBe(false);
    expect(diffMismatch(entry, record({ taskMode: "100755" }) ?? undefined)).toBe(true);
    expect(diffMismatch(entry, record({ taskBlob: "2".repeat(40) }) ?? undefined)).toBe(true);
    // A diff that reports no mode cannot prove a change (flag (a) covers it).
    expect(diffMismatch(entry, record({ taskMode: undefined }) ?? undefined)).toBe(false);
    const plan = planReviewedApply({
      taskId: "t1",
      changeSet: changeSet(),
      selected: new Set([0]),
      diffs: new Map([["modified\u0000src/a.ts", record({ taskMode: "100755" })!]]),
    });
    expect(plan.ok).toBe(false);
  });
});
