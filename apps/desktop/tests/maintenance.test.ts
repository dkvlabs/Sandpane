/**
 * A9 maintenance (design 2026-10-09 §3.9): selection defaults, confirmation
 * view, the two-step flow (token-safe, single-flight, always re-scanned), the
 * honesty copy for a lost step-2 answer and CONFLICT, the decoders, the
 * request guards, and the drift pins against the Rust sources.
 */

import { describe, expect, it } from "vitest";
import {
  CONFLICT_COPY,
  LOST_STEP2_TITLE,
  MaintenanceFlow,
  cleanupOutcomeView,
  defaultChecked,
  defaultSelection,
  formatBytes,
  groupMaintenanceItems,
  itemSizeText,
  maintenanceConfirmationView,
  maintenanceGate,
  scanFailureCopy,
  step1FailureCopy,
  step2FailureCopy,
  type MaintenanceRpc,
} from "../src/lib/maintenance";
import {
  decodeMaintenanceCleanup,
  decodeMaintenanceInventory,
  decodeVerificationResult,
} from "../src/lib/decode";
import {
  buildMaintenanceCleanupConfirmParams,
  buildMaintenanceCleanupRequestParams,
  CoreValidationError,
  MAX_CLEANUP_ITEMS,
} from "../src/lib/guards";
import {
  CoreClient,
  CoreRequestError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  METHOD_TIMEOUT_MS,
  REPLAY_SAFE_METHODS,
  requestTimeoutFor,
  timeoutError,
} from "../src/lib/core-client";
import { resultDisclosures } from "../src/lib/verification";
import {
  FEATURE_MAINTENANCE,
  KNOWN_FEATURES,
  MAINTENANCE_METHODS,
  METHODS,
  type MaintenanceConfirmation,
  type MaintenanceItem,
} from "../src/lib/protocol";
import {
  A9_CORE_FEATURES,
  A9_CORE_METHODS,
  A7_CORE_FEATURES,
  A7_CORE_METHODS,
  FakeCore,
} from "./support/fake-core";
import { desktopProxyRustSource, protocolRustSource, rustMethodAll } from "./support/rust-source";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tempItem: MaintenanceItem = {
  id: "temp:0b2a2c56-1111-4222-8333-444455556666",
  kind: "temp",
  removable: true,
  detail: "Core temporary directory 0b2a2c56-…",
};
const backupItem: MaintenanceItem = {
  id: "dbBackup:core.sqlite3.pre-v8.bak",
  kind: "dbBackup",
  removable: true,
  bytes: 2048,
  detail: "migration backup taken before schema v8 (a copy of the database at schema v7)",
};
const outputItem: MaintenanceItem = {
  id: "verificationOutput:2026-09-01T00:00:00Z",
  kind: "verificationOutput",
  removable: true,
  bytes: 512,
  detail: "stored output of 3 verification runs that finished before 2026-09-01T00:00:00Z",
};
const worktreeItem: MaintenanceItem = {
  id: "worktree:task-1",
  kind: "worktree",
  removable: false,
  detail: "worktree of a finished task; stop the task's sandbox first, then run `git worktree remove` from that repository",
  reason: "removal waits for W-D: Sandpane cannot remove worktrees yet",
  path: "/x/worktrees/task-1",
  repositoryPath: "/repos/demo",
};
const foreignItem: MaintenanceItem = {
  id: "foreign:0",
  kind: "temp",
  removable: false,
  detail: "tmp/notes.txt",
  reason: "not created by Sandpane",
};
const unknownItem: MaintenanceItem = {
  id: "future:x",
  kind: "futureKind",
  removable: true,
  detail: "a kind this build does not know",
};

const items = [tempItem, backupItem, outputItem, worktreeItem, foreignItem, unknownItem];

function confirmation(overrides: Partial<MaintenanceConfirmation> = {}): MaintenanceConfirmation {
  return {
    token: "a".repeat(64),
    expiresAt: "2100-01-01T00:00:00Z",
    action: "maintenance.cleanup",
    target: { items: [tempItem.id] },
    impact: ["1 Core temporary directory and its lock file are deleted from Sandpane's data directory (sizes are not measured)"],
    external: false,
    ...overrides,
  };
}

/** A controllable RPC double; every call is recorded. */
class Rpc implements MaintenanceRpc {
  readonly calls: { op: string; items?: string[]; token?: string }[] = [];
  inventoryAnswer: () => Record<string, unknown> = () => ({
    items,
    truncated: false,
  });
  // Like CoreClient.requestMaintenanceCleanup, the double returns the
  // confirmation itself (decoded), not the wire wrapper.
  step1Answer: (items: string[]) => MaintenanceConfirmation = (its) =>
    confirmation({ target: { items: its } });
  step2Answer: (items: string[]) => Record<string, unknown> = (its) => ({
    removed: its,
    skipped: [],
    notes: [],
  });
  inventoryError: unknown = null;
  step1Error: unknown = null;
  step2Error: unknown = null;

  async maintenanceInventory(): Promise<never> {
    this.calls.push({ op: "inventory" });
    if (this.inventoryError) throw this.inventoryError;
    return this.inventoryAnswer() as never;
  }
  async requestMaintenanceCleanup(items: readonly string[]): Promise<never> {
    this.calls.push({ op: "step1", items: [...items] });
    if (this.step1Error) throw this.step1Error;
    return this.step1Answer([...items]) as never;
  }
  async confirmMaintenanceCleanup(
    items: readonly string[],
    confirmToken: string,
  ): Promise<never> {
    this.calls.push({ op: "step2", items: [...items], token: confirmToken });
    if (this.step2Error) throw this.step2Error;
    return this.step2Answer([...items]) as never;
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Gating and selection
// ---------------------------------------------------------------------------

describe("maintenance gating", () => {
  it("is unprobed while the probe has not answered, never 'unsupported'", () => {
    expect(maintenanceGate(null).state).toBe("unprobed");
  });

  it("needs the feature AND both methods", () => {
    const base = { methods: [...A9_CORE_METHODS], features: [...A9_CORE_FEATURES] };
    expect(maintenanceGate(base).state).toBe("supported");
    expect(
      maintenanceGate({
        methods: [...A9_CORE_METHODS],
        features: [...A7_CORE_FEATURES.filter((f) => f !== "some-future-feature")],
      }).state,
    ).toBe("unsupported");
    expect(
      maintenanceGate({
        methods: [...A7_CORE_METHODS],
        features: [...A9_CORE_FEATURES.filter((f) => f !== "some-future-feature")],
      }).state,
    ).toBe("unsupported");
  });
});

describe("selection defaults (§3.9 item 7.3)", () => {
  it("checks removable temp and verificationOutput items only", () => {
    expect(defaultChecked(tempItem)).toBe(true);
    expect(defaultChecked(outputItem)).toBe(true);
    // Backups are the way back to an older Core: unchecked by default.
    expect(defaultChecked(backupItem)).toBe(false);
    // Report-only and unknown kinds are never checked.
    expect(defaultChecked(worktreeItem)).toBe(false);
    expect(defaultChecked(foreignItem)).toBe(false);
    expect(defaultChecked(unknownItem)).toBe(false);
    expect([...defaultSelection(items)].sort()).toEqual([outputItem.id, tempItem.id].sort());
  });
});

describe("grouping and display text", () => {
  it("groups by kind, known kinds first in Core's order", () => {
    const groups = groupMaintenanceItems([unknownItem, worktreeItem, backupItem, tempItem, outputItem, foreignItem]);
    expect(groups.map((g) => g.kind)).toEqual([
      "temp",
      "dbBackup",
      "verificationOutput",
      "worktree",
      "futureKind",
    ]);
    expect(groups[0].items).toHaveLength(2); // the temp foreign entry shares the kind
    expect(groups[4].label).toContain("futureKind");
    expect(groups[3].label).toContain("report-only");
  });

  it("formats bytes and size lines", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2048)).toBe("2 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MiB");
    expect(itemSizeText(tempItem)).toBeNull(); // not measured
    expect(itemSizeText(backupItem)).toBe("2 KiB");
    expect(itemSizeText({ ...backupItem, sizeIncomplete: true })).toBe("2 KiB (incomplete measurement)");
  });
});

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

describe("decoders", () => {
  it("decodes an inventory, keeping optional fields absent", () => {
    const inv = decodeMaintenanceInventory({
      items: [
        {
          id: tempItem.id,
          kind: "temp",
          removable: true,
          detail: "d",
        },
        {
          id: "worktree:task-1",
          kind: "worktree",
          removable: false,
          detail: "d",
          reason: "r",
          path: "/p",
          repositoryPath: "/r",
          bytes: 10,
          sizeIncomplete: true,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      truncated: true,
      unavailable: [{ kind: "worktree", reason: "no data directory" }],
    });
    expect(inv.items[0]).toEqual({ id: tempItem.id, kind: "temp", removable: true, detail: "d" });
    expect(inv.items[1]).toEqual({
      id: "worktree:task-1",
      kind: "worktree",
      removable: false,
      detail: "d",
      reason: "r",
      path: "/p",
      repositoryPath: "/r",
      bytes: 10,
      sizeIncomplete: true,
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(inv.truncated).toBe(true);
    expect(inv.unavailable).toEqual([{ kind: "worktree", reason: "no data directory" }]);
    // Absent `unavailable` stays absent.
    expect(decodeMaintenanceInventory({ items: [], truncated: false }).unavailable).toBeUndefined();
  });

  it("decodes step 1 and step 2 answers and refuses mixes", () => {
    const step1 = confirmation();
    expect(decodeMaintenanceCleanup({ confirmation: step1 })).toEqual({ confirmation: step1 });
    const step2 = {
      removed: [tempItem.id],
      skipped: [{ id: backupItem.id, reason: "changed since you confirmed" }],
      freedBytes: 0,
      notes: ["temporary directory sizes are not measured"],
    };
    expect(decodeMaintenanceCleanup(step2)).toEqual(step2);
    expect(() => decodeMaintenanceCleanup({ ...step2, confirmation: step1 })).toThrow();
    expect(() => decodeMaintenanceCleanup({ removed: [tempItem.id] })).toThrow();
    expect(() => decodeMaintenanceCleanup({ skipped: [] })).toThrow();
  });

  it("decodes outputPruned and it takes precedence in the disclosures", () => {
    const result = decodeVerificationResult({
      runId: "r",
      taskId: "t",
      commandId: "c",
      label: "l",
      argv: ["make", "test"],
      sandbox: "s",
      workspaceMode: "sbx_clone",
      outcome: "exited",
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: true,
      stderrTruncated: true,
      redactions: { bestEffort: true, replacements: 0, byKind: {} },
      outputIncomplete: true,
      outputPruned: true,
      startedAt: "2026-01-01T00:00:00Z",
    });
    expect(result.outputPruned).toBe(true);
    expect(resultDisclosures(result)).toEqual(["output removed by maintenance cleanup"]);
    delete (result as { outputPruned?: boolean }).outputPruned;
    expect(resultDisclosures(result)).toContain("stdout was cut at Core's 64 KiB cap");
  });
});

// ---------------------------------------------------------------------------
// Request guards
// ---------------------------------------------------------------------------

describe("request guards", () => {
  it("refuses empty, duplicate and oversized item lists before anything is sent", () => {
    expect(() => buildMaintenanceCleanupRequestParams([])).toThrow(CoreValidationError);
    expect(() => buildMaintenanceCleanupRequestParams(["a", "a"])).toThrow(CoreValidationError);
    const many = Array.from({ length: MAX_CLEANUP_ITEMS + 1 }, (_, i) => `temp:${i}`);
    expect(() => buildMaintenanceCleanupRequestParams(many)).toThrow(CoreValidationError);
    expect(buildMaintenanceCleanupRequestParams(["a", "b"])).toEqual({ items: ["a", "b"] });
  });

  it("step 2 params require the 64-hex token Core issues", () => {
    expect(buildMaintenanceCleanupConfirmParams(["a"], "b".repeat(64))).toEqual({
      items: ["a"],
      confirmToken: "b".repeat(64),
    });
    expect(() => buildMaintenanceCleanupConfirmParams(["a"], "nope")).toThrow(CoreValidationError);
  });
});

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

describe("MaintenanceFlow", () => {
  it("scan → ready; the UI derives the default selection from the fresh inventory", async () => {
    const rpc = new Rpc();
    const flow = new MaintenanceFlow(rpc);
    await flow.scan();
    expect(flow.getState().kind).toBe("ready");
    expect(defaultSelection(items)).toHaveLength(2);
  });

  it("a failed scan keeps no inventory and reports Core's CONFLICT copy", async () => {
    const rpc = new Rpc();
    rpc.inventoryError = new CoreRequestError("core", "CONFLICT", "a maintenance scan is already running");
    const flow = new MaintenanceFlow(rpc);
    await flow.scan();
    expect(flow.getState().kind).toBe("idle");
    expect(flow.scanError?.title).toBe(CONFLICT_COPY.title);
  });

  it("step 1 sends exactly the selected ids; cancel drops the token and sends nothing", async () => {
    const rpc = new Rpc();
    const flow = new MaintenanceFlow(rpc);
    await flow.scan();
    await flow.beginCleanup([tempItem.id, backupItem.id]);
    const state = flow.getState();
    expect(state.kind).toBe("confirming");
    expect(rpc.calls.at(-1)).toEqual({ op: "step1", items: [tempItem.id, backupItem.id] });
    flow.cancel();
    expect(flow.getState().kind).toBe("idle");
    expect(rpc.calls.filter((c) => c.op === "step2")).toHaveLength(0);
  });

  it("a late step-1 answer after a cancel is discarded, never shown", async () => {
    const rpc = new Rpc();
    let release: (() => void) | null = null;
    rpc.step1Answer = (its) => {
      const saved = confirmation({ target: { items: its } });
      // Hold the answer until the test cancels.
      return saved;
    };
    const slow = new (class extends Rpc {
      override async requestMaintenanceCleanup(items: readonly string[]) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return super.requestMaintenanceCleanup(items);
      }
    })();
    const flow = new MaintenanceFlow(slow);
    await flow.scan();
    const pending = flow.beginCleanup([tempItem.id]);
    flow.cancel();
    const releaseNow = release as (() => void) | null;
    releaseNow?.();
    await pending;
    expect(flow.getState().kind).toBe("idle");
  });

  it("confirm spends the token once and re-scans automatically after step 2", async () => {
    const rpc = new Rpc();
    const flow = new MaintenanceFlow(rpc);
    await flow.scan();
    await flow.beginCleanup([tempItem.id]);
    expect(flow.confirm()).toBe(true);
    expect(flow.confirm()).toBe(false); // no second send
    await settle();
    expect(rpc.calls.filter((c) => c.op === "step2")).toHaveLength(1);
    // §3.9 item 7.5: the flow re-scanned after step 2.
    expect(rpc.calls.filter((c) => c.op === "inventory")).toHaveLength(2);
    const settled = flow.getSettled();
    expect(settled?.kind).toBe("done");
    if (settled?.kind === "done") {
      const view = cleanupOutcomeView(settled.outcome, settled.confirmedCount);
      expect(view.headline).toContain("Removed all 1 confirmed item");
    }
  });

  it("an expired confirmation sends nothing", async () => {
    const rpc = new Rpc();
    rpc.step1Answer = (its) => confirmation({ target: { items: its }, expiresAt: "2000-01-01T00:00:00Z" });
    const flow = new MaintenanceFlow(rpc, { now: () => Date.parse("2026-10-12T00:00:00Z") });
    await flow.scan();
    await flow.beginCleanup([tempItem.id]);
    expect(flow.confirm()).toBe(false);
    expect(rpc.calls.filter((c) => c.op === "step2")).toHaveLength(0);
    const view = flow.getSettled();
    expect(view?.kind === "failed" && view.copy.title).toContain("Confirmation expired");
  });

  it("a lost step-2 answer reads 'some items may have been removed', never 'nothing was removed'", async () => {
    const rpc = new Rpc();
    rpc.step2Error = timeoutError("maintenance.cleanup", 35_000);
    const flow = new MaintenanceFlow(rpc);
    await flow.scan();
    await flow.beginCleanup([tempItem.id]);
    flow.confirm();
    await settle();
    const settled = flow.getSettled();
    expect(settled?.kind).toBe("failed");
    if (settled?.kind === "failed") {
      expect(settled.copy.title).toBe(LOST_STEP2_TITLE);
      expect(settled.copy.body).not.toMatch(/nothing was removed/i);
    }
    // The flow still re-scanned.
    expect(rpc.calls.filter((c) => c.op === "inventory")).toHaveLength(2);
  });

  it("a step-2 token refusal reads the same lost-answer copy", async () => {
    const rpc = new Rpc();
    rpc.step2Error = new CoreRequestError("core", "VALIDATION_FAILED", "the confirmation was refused");
    const flow = new MaintenanceFlow(rpc);
    await flow.scan();
    await flow.beginCleanup([tempItem.id]);
    flow.confirm();
    await settle();
    const settled = flow.getSettled();
    expect(settled?.kind === "failed" && settled.copy.title).toBe(LOST_STEP2_TITLE);
  });

  it("CONFLICT at either step gets the busy copy; step 1 says nothing was changed", async () => {
    const conflict = new CoreRequestError("core", "CONFLICT", "a maintenance cleanup is already running");
    expect(step1FailureCopy(conflict).title).toBe(CONFLICT_COPY.title);
    expect(step2FailureCopy(conflict).title).toBe(CONFLICT_COPY.title);
    expect(scanFailureCopy(conflict).title).toBe(CONFLICT_COPY.title);
    const refused = new CoreRequestError("core", "VALIDATION_FAILED", "item x is not in Core's inventory");
    expect(step1FailureCopy(refused).title).toContain("nothing was changed");
  });

  it("scan is single-flight: ignored while one is running", async () => {
    const rpc = new (class extends Rpc {
      override async maintenanceInventory(): Promise<never> {
        await new Promise((r) => setTimeout(r, 5));
        return super.maintenanceInventory();
      }
    })();
    const flow = new MaintenanceFlow(rpc);
    const first = flow.scan();
    const second = flow.scan();
    await Promise.all([first, second]);
    expect(rpc.calls.filter((c) => c.op === "inventory")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Outcome honesty
// ---------------------------------------------------------------------------

describe("cleanupOutcomeView", () => {
  it("never says all-clean when something was skipped", () => {
    const view = cleanupOutcomeView(
      { removed: ["a"], skipped: [{ id: "b", reason: "no longer present" }], notes: [] },
      2,
    );
    expect(view.headline).toBe("Removed 1 of 2 confirmed items; 1 were not removed.");
    expect(view.skippedLines).toEqual(["b: no longer present"]);
  });

  it("reports freed bytes only when Core measured them", () => {
    expect(cleanupOutcomeView({ removed: ["a"], skipped: [], freedBytes: 4096, notes: [] }, 1).freedText).toContain("4 KiB");
    expect(cleanupOutcomeView({ removed: ["a"], skipped: [], notes: [] }, 1).freedText).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Client wrappers (against the FakeCore double)
// ---------------------------------------------------------------------------

describe("CoreClient maintenance wrappers", () => {
  it("step 1 decodes the confirmation and refuses a mismatched item set", async () => {
    const fake = new FakeCore({
      advertisedMethods: A9_CORE_METHODS,
      features: A9_CORE_FEATURES,
      maintenance: {
        cleanup: () => ({ confirmation: confirmation({ target: { items: ["temp:other" ] } }) }),
      },
    });
    const c = new CoreClient(fake.transport);
    const err = await c.requestMaintenanceCleanup([tempItem.id]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreRequestError);
    expect((err as CoreRequestError).code).toBe("MALFORMED_FRAME");
    c.close();
  });

  it("step 2 refuses a step-1 answer", async () => {
    const fake = new FakeCore({
      advertisedMethods: A9_CORE_METHODS,
      features: A9_CORE_FEATURES,
      maintenance: {
        cleanup: () => ({ confirmation: confirmation() }),
      },
    });
    const c = new CoreClient(fake.transport);
    const err = await c
      .confirmMaintenanceCleanup([tempItem.id], "c".repeat(64))
      .catch((e: unknown) => e);
    expect((err as CoreRequestError).code).toBe("MALFORMED_FRAME");
    expect((err as CoreRequestError).mayHaveBeenApplied).toBe(true);
    c.close();
  });

  it("the inventory is decoded through the double", async () => {
    const fake = new FakeCore({
      advertisedMethods: A9_CORE_METHODS,
      features: A9_CORE_FEATURES,
      maintenance: {
        inventory: () => ({
          items: [{ id: tempItem.id, kind: "temp", removable: true, detail: "d" }],
          truncated: false,
        }),
      },
    });
    const c = new CoreClient(fake.transport);
    const inv = await c.maintenanceInventory();
    expect(inv.items).toHaveLength(1);
    expect(inv.truncated).toBe(false);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// Drift pins
// ---------------------------------------------------------------------------

describe("A9 drift against the Rust sources", () => {
  it("36 methods; the two maintenance methods sit at the end; 7 features", () => {
    const all = rustMethodAll();
    expect(all.declaredLength).toBe(36);
    expect([...METHODS]).toEqual(all.names);
    expect(METHODS.slice(-2)).toEqual([...MAINTENANCE_METHODS]);
    const rust = /pub const FEATURES: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(protocolRustSource());
    expect(Number(rust?.[1])).toBe(7);
    expect(KNOWN_FEATURES[6]).toBe(FEATURE_MAINTENANCE);
    expect(A9_CORE_METHODS).toEqual([...METHODS]);
    expect(desktopProxyRustSource()).toContain("assert_eq!(Method::ALL.len(), 36);");
  });

  it("maintenance gets ≥ 20 s deadlines on both sides, neither replay-safe, cleanup a write", () => {
    for (const m of MAINTENANCE_METHODS) {
      expect(requestTimeoutFor(m), m).toBe(35_000);
      expect(METHOD_TIMEOUT_MS[m], m).toBeGreaterThanOrEqual(20_000);
      expect(REPLAY_SAFE_METHODS.has(m), m).toBe(false);
    }
    expect(requestTimeoutFor("maintenance.inventory")).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
    const proxy = desktopProxyRustSource();
    expect(proxy).toContain("Method::MaintenanceInventory => 30_000");
    expect(proxy).toContain("Method::MaintenanceCleanup => 30_000");
    expect(proxy).toMatch(/Method::MaintenanceInventory => true/);
    expect(proxy).toMatch(/Method::MaintenanceCleanup => false/);
  });

  it("a lost maintenance.cleanup answer says it may have been applied", () => {
    const lost = timeoutError("maintenance.cleanup", 35_000);
    expect(lost.mayHaveBeenApplied).toBe(true);
    expect(lost.message).toContain("may have been applied");
  });
});
