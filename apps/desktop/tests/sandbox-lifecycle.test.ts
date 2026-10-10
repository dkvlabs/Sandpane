/**
 * A1 client side: `sandbox.stop`, two-step `sandbox.remove`, the visibly
 * unsupported Start, and the sbx agent choice (design 2026-10-09 §2–§4).
 *
 * Wire expectations are read from the Rust crate / schemas where they exist, so
 * a Core-side change without a client change fails here. The FakeCore stop/remove
 * handlers are MODELED on the service source, not captured from a live run.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CoreClient,
  CoreRequestError,
  REPLAY_SAFE_METHODS,
  requestTimeoutFor,
  timeoutError,
  type CoreTransport,
} from "../src/lib/core-client";
import {
  decodeSandboxRemoveResult,
  decodeSandboxStopResult,
  decodeSandboxSummaries,
} from "../src/lib/decode";
import { MalformedFrameError } from "../src/lib/framing";
import {
  DEFAULT_SBX_AGENT,
  METHODS,
  PROTOCOL_VERSION,
  SBX_AGENTS,
  type ConfirmationRequest,
} from "../src/lib/protocol";
import {
  EXTERNAL_BANNER,
  TASK_SANDBOX_UNRECORDED_COPY,
  MAX_CORE_MESSAGE_CHARS,
  MAX_IMPACT_LINES,
  NON_TERMINAL_STATUSES,
  SandboxStopConfirm,
  countActiveTasksOn,
  stopConfirmationCopy,
  NOT_PROBED_YET,
  NOT_SUPPORTED_BY_CORE,
  SandboxRemovalFlow,
  UNVERIFIED_AGENT_NOTE,
  agentFieldHonoured,
  confirmationView,
  gateBlockLabel,
  lifecycleGates,
  removalFailureCopy,
  sbxAgentOptions,
  startUnsupportedCopy,
  stopOutcomeView,
  type RemovalClient,
} from "../src/lib/sandbox-lifecycle";
import {
  buildSpec,
  emptyDraft,
  fieldErrors,
  stepErrors,
  type SandboxDraft,
  type WizardContext,
} from "../src/lib/wizard";
import {
  RemovalConsequence,
  RemovalDialog,
  StopDialog,
} from "../src/components/sandbox/SandboxLifecycle";
import { MAX_LIST_LIMIT, TASK_STATUSES } from "../src/lib/protocol";
import { MAX_REASON_CHARS, TERMINAL_STATUSES, describeCoreError } from "../src/lib/reducers";
import { A1_CORE_METHODS, FakeCore, TOKEN_REJECTED_MESSAGE } from "./support/fake-core";
import {
  ADDRESSABLE_SANDBOX_NAME_MAX,
  validateAddressableSandboxName,
} from "../src/lib/guards";
import { validateSandboxName } from "../src/lib/wizard";
import {
  REPO_ROOT,
  readSchema,
  rustFieldExists,
  rustMethodAll,
  schemaMethodEnum,
  schemaPropertyNames,
  schemaRequired,
} from "./support/rust-source";

const TOKEN = "a".repeat(64);
const SBX_ID = "b5ebec73-e2ae-471a-811a-e011cfb1948e";

/** Transport that records frames and answers only when the test says so. */
class ManualTransport implements CoreTransport {
  readonly kind = "memory";
  readonly frames: string[] = [];
  private handlers: ((line: string) => void)[] = [];
  write(frame: string): Promise<void> {
    this.frames.push(frame);
    return Promise.resolve();
  }
  onLine(handler: (line: string) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
  onClose(): () => void {
    return () => {};
  }
  close(): void {}
  lastId(): string {
    const last = this.frames[this.frames.length - 1];
    if (last === undefined) throw new Error("nothing was written");
    return (JSON.parse(last) as { id: string }).id;
  }
  respond(payload: unknown): void {
    const line = JSON.stringify({ v: PROTOCOL_VERSION, id: this.lastId(), ok: payload });
    for (const handler of [...this.handlers]) handler(line);
  }
  respondErr(code: string, message: string): void {
    const line = JSON.stringify({ v: PROTOCOL_VERSION, id: this.lastId(), err: { code, message } });
    for (const handler of [...this.handlers]) handler(line);
  }
}

function confirmation(patch: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
  return {
    token: TOKEN,
    expiresAt: "2026-10-10T00:02:00Z",
    action: "sandbox.remove",
    target: { name: "atlas-demo", id: SBX_ID },
    impact: ["removes sandbox atlas-demo (sbx id x) and everything inside it; this cannot be undone"],
    external: false,
    ...patch,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeCore(boxes: FakeCore["sandboxes"]): { core: FakeCore; client: CoreClient } {
  const core = new FakeCore();
  core.sandboxes.push(...boxes);
  return { core, client: new CoreClient(core.transport, { now: () => core.nowMs }) };
}

// ---------------------------------------------------------------------------

describe("A1 pinned lists", () => {
  it("stop and remove sit right after sandbox.create, matching Rust and the schema", () => {
    const index = METHODS.indexOf("sandbox.create");
    expect(METHODS.slice(index, index + 3)).toEqual([
      "sandbox.create",
      "sandbox.stop",
      "sandbox.remove",
    ]);
    expect(rustMethodAll().names).toEqual([...METHODS]);
    expect(schemaMethodEnum()).toEqual([...METHODS]);
    expect(METHODS).toHaveLength(16);
    expect(A1_CORE_METHODS).toEqual([...METHODS]);
  });

  it("there is no sandbox.start anywhere", () => {
    expect(METHODS as readonly string[]).not.toContain("sandbox.start");
    expect(schemaMethodEnum()).not.toContain("sandbox.start");
    expect(rustMethodAll().names).not.toContain("sandbox.start");
  });

  it("neither stop nor remove is replay-safe, and a lost answer says it may have been applied", () => {
    for (const method of ["sandbox.stop", "sandbox.remove"] as const) {
      expect(REPLAY_SAFE_METHODS.has(method)).toBe(false);
      const err = timeoutError(method, requestTimeoutFor(method));
      expect(err.mayHaveBeenApplied).toBe(true);
      expect(err.message).toContain("may have been applied");
    }
  });

  it("deadlines: stop 360 s, remove 400 s on the webview side", () => {
    expect(requestTimeoutFor("sandbox.stop")).toBe(360_000);
    expect(requestTimeoutFor("sandbox.remove")).toBe(400_000);
  });

  it("the new Rust declarations the mirror depends on exist", () => {
    for (const declaration of [
      "pub agent: Option<String>",
      "pub confirm_token: Option<String>",
      "pub requeried: Option<SandboxSummary>",
      "pub struct SandboxStopParams",
      "pub struct SandboxStopResult",
      "pub struct SandboxRemoveParams",
      "pub struct ConfirmationTarget",
      "pub struct ConfirmationRequest",
      "pub struct SandboxRemoveResult",
    ]) {
      expect(rustFieldExists(declaration), declaration).toBe(true);
    }
  });

  it("the sbx agent allowlist is Core's and the schema's, and agent stays optional", () => {
    const validation = readFileSync(
      join(REPO_ROOT, "core/crates/sandpane-core/src/validation.rs"),
      "utf8",
    );
    const block = /pub const SBX_AGENTS_V0_47: &\[&str\] = &\[([\s\S]*?)\];/.exec(validation);
    expect(block).not.toBeNull();
    const rust = [...((block?.[1] ?? "").matchAll(/"([^"]+)"/g))].map((m) => m[1]);
    expect([...SBX_AGENTS]).toEqual(rust);
    const schema = readSchema<{ properties: { agent: { enum: string[] } } }>("sandbox-create-spec");
    expect([...SBX_AGENTS]).toEqual(schema.properties.agent.enum);
    expect(schemaPropertyNames("sandbox-create-spec")).toContain("agent");
    expect(schemaRequired("sandbox-create-spec")).not.toContain("agent");
    expect(DEFAULT_SBX_AGENT).toBe("shell");
  });
});

describe("exact frames", () => {
  it("sandbox.stop sends exactly { name }", async () => {
    const t = new ManualTransport();
    const client = new CoreClient(t, { nextId: () => "desk-1" });
    const pending = client.stopSandbox("atlas-demo");
    await settle();
    expect(t.frames).toEqual([
      `${JSON.stringify({ v: 1, id: "desk-1", method: "sandbox.stop", params: { name: "atlas-demo" } })}\n`,
    ]);
    t.respond({ stopped: true });
    await expect(pending).resolves.toEqual({ stopped: true });
  });

  it("remove step 1 sends { name } with NO confirmToken key; step 2 sends the token", async () => {
    const t = new ManualTransport();
    let n = 0;
    const client = new CoreClient(t, { nextId: () => `desk-${++n}` });
    const step1 = client.requestSandboxRemoval("atlas-demo");
    await settle();
    expect(JSON.parse(t.frames[0] ?? "")).toEqual({
      v: 1,
      id: "desk-1",
      method: "sandbox.remove",
      params: { name: "atlas-demo" },
    });
    expect(t.frames[0]).not.toContain("confirmToken");
    t.respond({ confirmation: confirmation() });
    const issued = await step1;
    expect(issued.token).toBe(TOKEN);

    const step2 = client.confirmSandboxRemoval("atlas-demo", issued.token);
    await settle();
    expect(JSON.parse(t.frames[1] ?? "")).toEqual({
      v: 1,
      id: "desk-2",
      method: "sandbox.remove",
      params: { name: "atlas-demo", confirmToken: TOKEN },
    });
    t.respond({ removed: true });
    await expect(step2).resolves.toEqual({ removed: true });
    expect(t.frames).toHaveLength(2);
  });

  it("an invalid name or a malformed token is refused before any frame is written", async () => {
    const t = new ManualTransport();
    const client = new CoreClient(t);
    for (const name of [
      "",
      "a",
      "a b",
      "x;rm -rf",
      "--force",
      ".hidden",
      "default",
      "DeFault",
      "atlas_demo",
      "atl\u00e9s",
      "a".repeat(129),
    ]) {
      await expect(client.stopSandbox(name)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
      await expect(client.requestSandboxRemoval(name)).rejects.toMatchObject({
        code: "INVALID_PARAMS",
      });
    }
    for (const token of ["", "A".repeat(64), "a".repeat(63), `${"a".repeat(63)}\n`]) {
      const refusal = client.confirmSandboxRemoval("atlas-demo", token);
      await expect(refusal).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    }
    expect(t.frames).toHaveLength(0);
  });

  it("stop/remove address sbx-named sandboxes (uppercase, periods) that create would refuse", async () => {
    const { core, client } = makeCore([
      { name: "Atlas.Demo", id: SBX_ID, status: "running", bound: false },
    ]);
    expect(validateSandboxName("Atlas.Demo")).not.toBeNull(); // create stays strict
    await expect(client.stopSandbox("Atlas.Demo")).resolves.toMatchObject({ stopped: true });
    const issued = await client.requestSandboxRemoval("Atlas.Demo");
    expect(issued.target.name).toBe("Atlas.Demo");
    expect(core.sent["sandbox.stop"]).toEqual([{ name: "Atlas.Demo" }]);
  });

  it("step 1 refuses a confirmation that names a different sandbox", async () => {
    const t = new ManualTransport();
    const client = new CoreClient(t);
    const step1 = client.requestSandboxRemoval("atlas-demo");
    await settle();
    t.respond({ confirmation: confirmation({ target: { name: "nova-demo", id: SBX_ID } }) });
    await expect(step1).rejects.toBeInstanceOf(CoreRequestError);
  });

  it("step 2 never reports a new confirmation as removed", async () => {
    const t = new ManualTransport();
    const client = new CoreClient(t);
    const step2 = client.confirmSandboxRemoval("atlas-demo", TOKEN);
    await settle();
    t.respond({ confirmation: confirmation() });
    await expect(step2).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
  });
});

describe("decoders", () => {
  it("sandbox.stop tolerates an absent requeried and keeps it absent", () => {
    const gone = decodeSandboxStopResult({ stopped: true });
    expect(gone).toEqual({ stopped: true });
    expect("requeried" in gone).toBe(false);
    const view = stopOutcomeView(gone);
    expect(view.stateKnown).toBe(false);
    expect(view.title).toContain("UNKNOWN");
    expect(view.title).not.toMatch(/stopped/i);
  });

  it("sandbox.stop shows the re-queried state, and a null state as unknown", () => {
    const still = decodeSandboxStopResult({
      stopped: true,
      requeried: { name: "atlas-demo", probedState: "stopped", boundProjectId: null, agent: "shell" },
    });
    expect(still.requeried?.agent).toBe("shell");
    expect(stopOutcomeView(still)).toMatchObject({ stateKnown: true, probedState: "stopped" });
    const blank = decodeSandboxStopResult({
      stopped: true,
      requeried: { name: "atlas-demo", probedState: null, boundProjectId: null },
    });
    expect(stopOutcomeView(blank).stateKnown).toBe(false);
  });

  it("SandboxSummary.agent is absent-tolerant and never invented", () => {
    const [legacy, current] = decodeSandboxSummaries([
      { name: "a1", probedState: "running", boundProjectId: null },
      { name: "a2", probedState: "running", boundProjectId: null, agent: "codex" },
    ]);
    expect(legacy !== undefined && "agent" in legacy).toBe(false);
    expect(current?.agent).toBe("codex");
    expect(() =>
      decodeSandboxSummaries([{ name: "a3", probedState: null, boundProjectId: null, agent: 7 }]),
    ).toThrow(MalformedFrameError);
  });

  it("sandbox.remove answers exactly one of confirmation / removed:true", () => {
    expect(decodeSandboxRemoveResult({ removed: true })).toEqual({ kind: "removed" });
    expect(decodeSandboxRemoveResult({ confirmation: confirmation() }).kind).toBe("confirmation");
    for (const bad of [
      {},
      { removed: false },
      { removed: "yes" },
      { removed: true, confirmation: confirmation() },
      { confirmation: confirmation({ token: "NOT-HEX" }) },
      { confirmation: confirmation({ action: "project.delete" }) },
      { confirmation: { ...confirmation(), impact: ["ok", 3] } },
      { confirmation: { ...confirmation(), external: "no" } },
    ]) {
      expect(() => decodeSandboxRemoveResult(bad), JSON.stringify(bad)).toThrow(MalformedFrameError);
    }
  });

  it("a malformed token is never echoed in the error text", () => {
    const secret = "f".repeat(63) + "Z";
    try {
      decodeSandboxRemoveResult({ confirmation: confirmation({ token: secret }) });
      throw new Error("should have thrown");
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
  });
});

describe("two-step removal flow", () => {
  it("cancel sends nothing beyond step 1, and the token is dropped", async () => {
    const { core, client } = makeCore([
      { name: "atlas-demo", id: SBX_ID, status: "running", bound: true },
    ]);
    const flow = new SandboxRemovalFlow(client, { now: () => core.nowMs });
    await flow.begin("atlas-demo");
    expect(flow.getState().kind).toBe("confirming");
    expect(core.callsFor("sandbox.remove")).toBe(1);
    flow.cancel();
    expect(flow.getState()).toEqual({ kind: "idle" });
    await settle();
    expect(core.callsFor("sandbox.remove")).toBe(1);
    expect(core.sandboxes).toHaveLength(1);
    expect(flow.confirm()).toBe(false);
    expect(core.callsFor("sandbox.remove")).toBe(1);
  });

  it("confirm sends the step-1 token exactly once, even on a double click", async () => {
    const { core, client } = makeCore([
      { name: "atlas-demo", id: SBX_ID, status: "stopped", bound: false },
    ]);
    let settled = 0;
    const flow = new SandboxRemovalFlow(client, {
      now: () => core.nowMs,
      onSettled: () => (settled += 1),
    });
    await flow.begin("atlas-demo");
    const state = flow.getState();
    if (state.kind !== "confirming") throw new Error("expected a confirmation");
    expect(state.confirmation.external).toBe(true);

    expect(flow.confirm()).toBe(true);
    expect(flow.getState().kind).toBe("removing");
    expect(flow.confirm()).toBe(false);
    await settle();

    const sent = core.sent["sandbox.remove"] ?? [];
    expect(sent).toEqual([
      { name: "atlas-demo" },
      { name: "atlas-demo", confirmToken: state.confirmation.token },
    ]);
    expect(flow.getState().kind).toBe("removed");
    expect(core.sandboxes).toHaveLength(0);
    expect(settled).toBe(2);
  });

  it("an expired confirmation sends nothing", async () => {
    const { core, client } = makeCore([
      { name: "atlas-demo", id: SBX_ID, status: "running", bound: true },
    ]);
    const flow = new SandboxRemovalFlow(client, { now: () => core.nowMs });
    await flow.begin("atlas-demo");
    core.nowMs += 121_000;
    expect(flow.confirm()).toBe(false);
    const state = flow.getState();
    expect(state).toMatchObject({ kind: "failed", stage: "expired" });
    expect(core.callsFor("sandbox.remove")).toBe(1);
  });

  it("a step-1 answer that arrives after cancel is discarded", async () => {
    const t = new ManualTransport();
    const flow = new SandboxRemovalFlow(new CoreClient(t));
    const started = flow.begin("atlas-demo");
    await settle();
    flow.cancel();
    t.respond({ confirmation: confirmation() });
    await started;
    expect(flow.getState()).toEqual({ kind: "idle" });
  });

  it("Core's step-2 verdicts say nothing was removed; a lost answer says re-read state", async () => {
    const reused = new CoreRequestError("core", "VALIDATION_FAILED", TOKEN_REJECTED_MESSAGE);
    expect(removalFailureCopy(reused).title).toMatch(/nothing was removed/);
    const replaced = new CoreRequestError("core", "CONFLICT", "id changed");
    expect(removalFailureCopy(replaced).title).toMatch(/Conflict — nothing was removed/);
    const gone = new CoreRequestError("core", "NOT_FOUND", "gone");
    expect(removalFailureCopy(gone).title).toMatch(/already gone/);
    const lost = timeoutError("sandbox.remove", 400_000);
    expect(removalFailureCopy(lost).title).toBe("Outcome unknown — this may have been applied");
  });

  it("a same-named replacement between the steps is CONFLICT and nothing is removed", async () => {
    const { core, client } = makeCore([
      { name: "atlas-demo", id: SBX_ID, status: "running", bound: true },
    ]);
    const flow = new SandboxRemovalFlow(client, { now: () => core.nowMs });
    await flow.begin("atlas-demo");
    core.sandboxes.splice(0, 1, { name: "atlas-demo", id: "other-id", status: "running", bound: true });
    flow.confirm();
    await settle();
    expect(flow.getState()).toMatchObject({ kind: "failed", stage: "confirm" });
    expect(core.sandboxes[0]?.id).toBe("other-id");
  });

  it("a failed step 2 is never retried; the next attempt needs a fresh step 1", async () => {
    let confirms = 0;
    const stub: RemovalClient = {
      requestSandboxRemoval: () =>
        Promise.resolve(confirmation({ expiresAt: "2999-01-01T00:00:00Z" })),
      confirmSandboxRemoval: () => {
        confirms += 1;
        return Promise.reject(timeoutError("sandbox.remove", 400_000));
      },
    };
    const flow = new SandboxRemovalFlow(stub);
    await flow.begin("atlas-demo");
    flow.confirm();
    await settle();
    expect(confirms).toBe(1);
    expect(flow.getState()).toMatchObject({ kind: "failed", stage: "confirm" });
    expect(flow.confirm()).toBe(false);
    expect(confirms).toBe(1);
  });
});

describe("gating on system.probe", () => {
  it("unprobed is not unsupported, and absent methods are 'not supported by this Core'", () => {
    const unprobed = lifecycleGates(null);
    expect(gateBlockLabel(unprobed.stop)).toBe(NOT_PROBED_YET);
    const legacy = lifecycleGates({ methods: ["system.probe", "sandbox.list"] });
    expect(gateBlockLabel(legacy.stop)).toBe(NOT_SUPPORTED_BY_CORE);
    expect(gateBlockLabel(legacy.remove)).toBe(NOT_SUPPORTED_BY_CORE);
    const noList = lifecycleGates({});
    expect(noList.remove.state).toBe("unsupported");
    const current = lifecycleGates({ methods: [...A1_CORE_METHODS] });
    expect(gateBlockLabel(current.stop)).toBeNull();
    expect(gateBlockLabel(current.remove)).toBeNull();
  });

  it("a pre-A1 Core probed through the client gates both off and pins the wizard to shell", async () => {
    const preA1 = A1_CORE_METHODS.filter((m) => m !== "sandbox.stop" && m !== "sandbox.remove");
    const core = new FakeCore({ advertisedMethods: preA1, features: null });
    const client = new CoreClient(core.transport);
    const outcome = await client.probe();
    if (outcome.kind !== "attached") throw new Error("expected attach");
    const gates = lifecycleGates(outcome.capabilities);
    expect(gates.stop.state).toBe("unsupported");
    expect(gates.remove.state).toBe("unsupported");
    expect(agentFieldHonoured(outcome.capabilities)).toBe(false);
    const options = sbxAgentOptions(false);
    expect(options.filter((o) => !o.disabled).map((o) => o.id)).toEqual(["shell"]);
    expect(core.callsFor("sandbox.stop")).toBe(0);
    expect(core.callsFor("sandbox.remove")).toBe(0);
  });

  it("Start is visibly unsupported with the sbx v0.47 copy", () => {
    expect(startUnsupportedCopy("atlas-demo")).toBe(
      "Start: not supported by sbx v0.47 (use `sbx run --name atlas-demo` in a terminal)",
    );
  });
});

describe("confirmation dialog markup (SSR, no DOM)", () => {
  const hostile = "evil\u202Egnp.exe\nsecond line <img src=x onerror=alert(1)>";

  it("hostile impact text is rendered inert and revealed", () => {
    const view = confirmationView(
      confirmation({ impact: [hostile], target: { name: "atlas-demo", id: "id\u200Bx" } }),
      Date.parse("2026-10-10T00:00:00Z"),
    );
    const html = renderToStaticMarkup(createElement(RemovalConsequence, { view }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("\u202E");
    expect(html).not.toContain("\u200B");
    expect(html).toContain("\\u202E");
    expect(html).toContain("\\u000A");
    expect(html).toContain("\\u200B");
    // The newline did not split the impact into two list items.
    expect(html.match(/<li>/g)).toHaveLength(1);
    expect(view.revealedHiddenCharacters).toBe(true);
  });

  it("shows target name, sbx id, expiry, and the external banner only when external", () => {
    const now = Date.parse("2026-10-10T00:00:00Z");
    const internal = renderToStaticMarkup(
      createElement(RemovalConsequence, { view: confirmationView(confirmation(), now) }),
    );
    expect(internal).toContain("atlas-demo");
    expect(internal).toContain(SBX_ID);
    expect(internal).toContain("2026-10-10T00:02:00Z");
    expect(internal).toContain("120 s left");
    expect(internal).not.toContain(EXTERNAL_BANNER);
    const external = renderToStaticMarkup(
      createElement(RemovalConsequence, {
        view: confirmationView(confirmation({ external: true }), now),
      }),
    );
    expect(external).toContain("NOT CONFIRMED AS CREATED BY SANDPANE");
    expect(external).toContain(
      "Core cannot confirm Sandpane created this sandbox (no Sandpane binding is recorded for this sbx id).",
    );
    // No overclaim: `external` also covers pre-A1 / stale bindings.
    expect(external).not.toMatch(/created outside Sandpane/i);
    expect(external).not.toContain("NOT CREATED BY SANDPANE");
  });

  it("caps impact at 20 lines with an overflow line", () => {
    const impact = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const view = confirmationView(confirmation({ impact }), Date.parse("2026-10-10T00:00:00Z"));
    expect(view.impactLines).toHaveLength(MAX_IMPACT_LINES);
    expect(view.overflowLine).toContain("5 more impact lines");
    const html = renderToStaticMarkup(createElement(RemovalConsequence, { view }));
    expect(html.match(/<li>/g)).toHaveLength(20);
    expect(html).toContain("5 more impact lines");
  });

  it("an unparseable or past expiry fails closed", () => {
    expect(confirmationView(confirmation({ expiresAt: "soon" }), 0).expired).toBe(true);
    expect(
      confirmationView(confirmation(), Date.parse("2026-10-10T00:02:00Z")).expired,
    ).toBe(true);
  });

  it("the dialog's Remove button is disabled once expired; Cancel has initial focus", () => {
    const stub: RemovalClient = {
      requestSandboxRemoval: () => Promise.reject(new Error("unused")),
      confirmSandboxRemoval: () => Promise.reject(new Error("unused")),
    };
    const flow = new SandboxRemovalFlow(stub);
    const render = (expiresAt: string) =>
      renderToStaticMarkup(
        createElement(RemovalDialog, { confirmation: confirmation({ expiresAt }), flow }),
      );
    const expired = render("2000-01-01T00:00:00Z");
    expect(expired).toMatch(/<button[^>]*disabled=""[^>]*>Remove sandbox<\/button>/);
    expect(expired).toContain('role="dialog"');
    expect(expired).toMatch(/<button[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/);
    const live = render("2999-01-01T00:00:00Z");
    expect(live).not.toMatch(/<button[^>]*disabled=""[^>]*>Remove sandbox<\/button>/);
    expect(live).toMatch(/>Remove sandbox<\/button>/);
  });

  it("the lifecycle component never injects raw HTML", () => {
    const source = readFileSync(
      join(REPO_ROOT, "apps/desktop/src/components/sandbox/SandboxLifecycle.tsx"),
      "utf8",
    );
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("wizard sbx agent", () => {
  const context: WizardContext = {
    existingSandboxNames: [],
    verifiedAgentIds: ["claude"],
    knownAgentIds: ["claude", "codex"],
    advancedAvailable: false,
  };
  const draft = (patch: Partial<SandboxDraft>): SandboxDraft => ({
    ...emptyDraft(),
    name: "atlas-demo",
    projectId: "p1",
    agentId: "claude",
    workspaceMode: "sbx_clone",
    ...patch,
  });

  it("defaults to shell, which is omitted from the payload", () => {
    expect(emptyDraft().sbxAgent).toBe("shell");
    const spec = buildSpec(draft({}));
    expect("agent" in spec).toBe(false);
  });

  it("a non-shell agent is sent only when the Core honours the field", () => {
    expect(fieldErrors(draft({ sbxAgent: "codex" }), context).sbxAgent).toMatch(
      /does not support choosing the sbx agent/,
    );
    const a1 = { ...context, sbxAgentFieldAvailable: true };
    expect(fieldErrors(draft({ sbxAgent: "codex" }), a1).sbxAgent).toBeUndefined();
    expect(buildSpec(draft({ sbxAgent: "codex" })).agent).toBe("codex");
    expect(stepErrors(draft({ step: "agent", agentId: "" }), context)).toHaveProperty("agentId");
    expect(Object.keys(stepErrors(draft({ step: "agent" }), context))).toEqual([]);
  });

  it("never emits a value outside the allowlist", () => {
    for (const agent of SBX_AGENTS) {
      const spec = buildSpec(draft({ sbxAgent: agent }));
      expect(spec.agent === undefined || (SBX_AGENTS as readonly string[]).includes(spec.agent)).toBe(
        true,
      );
    }
    for (const hostile of ["./kit", "oci://evil/kit:1", "git@x:y.git", "codex --cloud", "Shell", ""]) {
      // The type system forbids this; the runtime check is the second wall.
      const bad = draft({ sbxAgent: hostile as SandboxDraft["sbxAgent"] });
      expect(() => buildSpec(bad)).toThrow();
      expect(fieldErrors(bad, { ...context, sbxAgentFieldAvailable: true }).sbxAgent).toBeDefined();
    }
  });

  it("options: shell first and provider-free, every other entry labelled unverified", () => {
    const options = sbxAgentOptions(true);
    expect(options[0]).toEqual({ id: "shell", label: "shell (provider-free)", disabled: false });
    expect(options.map((o) => o.id).sort()).toEqual([...SBX_AGENTS].sort());
    for (const option of options.slice(1)) {
      expect(option.label).toContain(UNVERIFIED_AGENT_NOTE);
      expect(option.disabled).toBe(false);
    }
  });
});

describe("stop confirmation (security review W2)", () => {
  function coreWithTasks(): { core: FakeCore; client: CoreClient } {
    const core = new FakeCore();
    core.addTaskInProject(
      { id: "t1", conversationId: "c1", status: "running", sandboxName: "atlas-demo" },
      "p1",
    );
    core.addTaskInProject(
      { id: "t2", conversationId: "c2", status: "awaiting_review", sandboxName: "atlas-demo" },
      "p2",
    );
    core.addTaskInProject(
      { id: "t3", conversationId: "c3", status: "completed", sandboxName: "atlas-demo" },
      "p1",
    );
    core.addTaskInProject(
      { id: "t4", conversationId: "c4", status: "running", sandboxName: "nova-demo" },
      "p1",
    );
    return { core, client: new CoreClient(core.transport) };
  }

  it("counts non-terminal tasks on this sandbox across ALL projects via task.list", async () => {
    const { core, client } = coreWithTasks();
    expect(await countActiveTasksOn(client, true, "atlas-demo")).toBe(2);
    const params = core.lastParams<{ statuses: string[]; limit: number; projectId?: string }>(
      "task.list",
    );
    expect(params.projectId).toBeUndefined();
    expect(params.limit).toBe(MAX_LIST_LIMIT);
    expect([...params.statuses].sort()).toEqual([...NON_TERMINAL_STATUSES].sort());
    for (const terminal of TERMINAL_STATUSES) expect(params.statuses).not.toContain(terminal);
    expect(NON_TERMINAL_STATUSES.length + TERMINAL_STATUSES.length).toBe(TASK_STATUSES.length);
  });

  it("today's Core shape (no task carries sandboxName) is 'cannot be checked', never 0", async () => {
    const core = new FakeCore();
    core.addTaskInProject({ id: "t1", conversationId: "c1", status: "running" }, "p1");
    core.addTaskInProject(
      { id: "t2", conversationId: "c2", status: "queued", sandboxName: null },
      "p2",
    );
    const client = new CoreClient(core.transport);
    const active = await countActiveTasksOn(client, true, "atlas-demo");
    expect(active).toBe("unrecorded");
    const copy = stopConfirmationCopy("atlas-demo", active);
    expect(copy.taskLine).toBe(
      "Active tasks in this sandbox cannot be checked: Core does not yet record which sandbox a task uses.",
    );
    expect(copy.taskLine).toBe(TASK_SANDBOX_UNRECORDED_COPY);
    expect(copy.taskLine).not.toMatch(/\b0\b|no active task/);
    expect(copy.tasksAtRisk).toBe(false);
  });

  it("a Core that records sandboxName is counted, including 0 for this sandbox", async () => {
    const core = new FakeCore();
    core.addTaskInProject(
      { id: "t1", conversationId: "c1", status: "running", sandboxName: "nova-demo" },
      "p1",
    );
    core.addTaskInProject({ id: "t2", conversationId: "c2", status: "running" }, "p1");
    const client = new CoreClient(core.transport);
    expect(await countActiveTasksOn(client, true, "atlas-demo")).toBe(0);
    expect(await countActiveTasksOn(client, true, "nova-demo")).toBe(1);
    // No non-terminal task anywhere: 0 is established, not assumed.
    expect(await countActiveTasksOn(new CoreClient(new FakeCore().transport), true, "x1")).toBe(0);
  });

  it("not advertised, a failed task.list, or a full page reads as 'could not be fully checked'", async () => {
    const { core, client } = coreWithTasks();
    expect(await countActiveTasksOn(client, false, "atlas-demo")).toBeNull();
    expect(core.callsFor("task.list")).toBe(0);
    core.failNextWith(1);
    expect(await countActiveTasksOn(client, true, "atlas-demo")).toBeNull();
    for (let i = 0; i < MAX_LIST_LIMIT; i += 1) {
      core.addTask({ id: `x${i}`, conversationId: "cx", status: "queued", sandboxName: "other" });
    }
    expect(await countActiveTasksOn(client, true, "atlas-demo")).toBeNull();
    expect(stopConfirmationCopy("atlas-demo", null).taskLine).toMatch(/could not be fully checked/);
  });

  it("cancel sends nothing; confirm yields the name exactly once", async () => {
    const { core, client } = coreWithTasks();
    const dialog = new SandboxStopConfirm((name) => countActiveTasksOn(client, true, name));
    dialog.open("atlas-demo");
    expect(dialog.getState()).toEqual({ kind: "confirming", name: "atlas-demo", active: "checking" });
    await settle();
    expect(dialog.getState()).toEqual({ kind: "confirming", name: "atlas-demo", active: 2 });
    dialog.cancel();
    expect(dialog.getState()).toEqual({ kind: "idle" });
    expect(dialog.confirm()).toBeNull();
    expect(core.callsFor("sandbox.stop")).toBe(0);

    dialog.open("atlas-demo");
    expect(dialog.confirm()).toBe("atlas-demo");
    expect(dialog.confirm()).toBeNull();
    expect(core.callsFor("sandbox.stop")).toBe(0); // the caller sends, once
  });

  it("the count never blocks the stop, and a late count for a closed dialog is dropped", async () => {
    let release: (n: number) => void = () => {};
    const dialog = new SandboxStopConfirm(
      () => new Promise<number>((resolve) => (release = resolve)),
    );
    dialog.open("atlas-demo");
    expect(dialog.confirm()).toBe("atlas-demo");
    release(3);
    await settle();
    expect(dialog.getState()).toEqual({ kind: "idle" });
    // A count that rejects is treated as "could not be checked", not a crash.
    const failing = new SandboxStopConfirm(() => Promise.reject(new Error("boom")));
    failing.open("atlas-demo");
    await settle();
    expect(failing.getState()).toMatchObject({ active: null });
  });

  it("copy states the count, warns when tasks would end, and says when it is still checking", () => {
    expect(stopConfirmationCopy("atlas-demo", 0).taskLine).toBe(
      "Core records no active task in this sandbox.",
    );
    const risky = stopConfirmationCopy("atlas-demo", 2);
    expect(risky.tasksAtRisk).toBe(true);
    expect(risky.taskLine).toMatch(/WARNING: Core records 2 active tasks/);
    expect(stopConfirmationCopy("atlas-demo", "checking").taskLine).toMatch(/do not have to wait/);
  });

  it("StopDialog: explicit enabled 'Stop sandbox' even while checking, Cancel has initial focus", () => {
    const html = renderToStaticMarkup(
      createElement(StopDialog, {
        name: "evil\u202Edemo",
        active: "checking",
        onCancel: () => {},
        onConfirm: () => {},
      }),
    );
    expect(html).toMatch(/>Stop sandbox<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Stop sandbox<\/button>/);
    expect(html).toMatch(/<button[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/);
    expect(html).not.toContain("\u202E");
    expect(html).toContain("\\u202E");
  });
});

describe("error copy is revealed and capped (security review W3, W4)", () => {
  it("CONFLICT names both causes and shows Core's own message so they are distinguishable", () => {
    const busy = removalFailureCopy(
      new CoreRequestError(
        "core",
        "CONFLICT",
        'another operation on sandbox "atlas-demo" is in progress; nothing was run',
      ),
    );
    const replaced = removalFailureCopy(
      new CoreRequestError(
        "core",
        "CONFLICT",
        'sandbox "atlas-demo" is not the sandbox that was confirmed (its sbx id changed); nothing was removed',
      ),
    );
    expect(busy.body).toMatch(/different sbx id/);
    expect(busy.body).toMatch(/another operation on this sandbox is still in progress/);
    expect(busy.coreMessage).toContain("in progress");
    expect(replaced.coreMessage).toContain("its sbx id changed");
    expect(busy.coreMessage).not.toBe(replaced.coreMessage);
  });

  it("VALIDATION_FAILED and NOT_FOUND also carry Core's message, revealed and capped", () => {
    const hostile = `bad\u202Etoken\u2028${"x".repeat(1_000)}`;
    for (const code of ["VALIDATION_FAILED", "NOT_FOUND", "CONFLICT"] as const) {
      const copy = removalFailureCopy(new CoreRequestError("core", code, hostile));
      expect(copy.coreMessage).toBeDefined();
      expect(copy.coreMessage).not.toContain("\u202E");
      expect(copy.coreMessage).not.toContain("\u2028");
      expect(copy.coreMessage).toContain("\\u202E");
      expect(copy.coreMessage).toContain("\\u2028");
      expect(copy.coreMessage).toMatch(/more characters\)$/);
      expect(Array.from(copy.coreMessage ?? "").length).toBeLessThan(MAX_CORE_MESSAGE_CHARS + 80);
    }
  });

  it("describeCoreError reveals U+202E / U+2028 / newlines in Core's message and caps it", () => {
    const err = new CoreRequestError(
      "core",
      "DAEMON_DOWN",
      "sbx: daemon\u202Enwod\u2028line2\nline3",
    );
    const copy = describeCoreError(err);
    expect(copy.reason).toBe("sbx: daemon\\u202Enwod\\u2028line2\\u000Aline3");
    const long = describeCoreError(new CoreRequestError("core", "INTERNAL", "y".repeat(5_000)));
    expect(long.reason).toMatch(/more characters\)$/);
    expect(Array.from(long.reason).length).toBeLessThan(MAX_REASON_CHARS + 80);
    // A client-plane failure (a lost stop) is revealed the same way.
    const lost = describeCoreError(timeoutError("sandbox.stop", 360_000));
    expect(lost.title).toBe("Outcome unknown — this may have been applied");
  });
});

describe("addressable sandbox name (stop/remove) mirrors Validator::sandbox_name", () => {
  const rust = readFileSync(
    join(REPO_ROOT, "core/crates/sandpane-core/src/validation.rs"),
    "utf8",
  );
  const fnBody = /pub fn sandbox_name\(name: &str\)[^{]*\{([\s\S]*?)\n    \}\n/.exec(rust)?.[1] ?? "";

  it("the Rust rule is the one this mirror encodes", () => {
    expect(fnBody).toContain(`Self::bounded(name, ${ADDRESSABLE_SANDBOX_NAME_MAX})?`);
    expect(fnBody).toContain("c.is_ascii_alphanumeric() || c == '-' || c == '.'");
    expect(fnBody).toContain("name.chars().count() < 2");
    expect(fnBody).toContain(".is_some_and(|c| c.is_ascii_alphanumeric())");
    expect(fnBody).toContain('name.eq_ignore_ascii_case("default")');
  });

  it("agrees with Core's own accept/reject corpus", () => {
    const listOf = (test: string): string[] => {
      const body = new RegExp(`fn ${test}\\(\\) \\{([\\s\\S]*?)\\n    \\}`).exec(rust)?.[1] ?? "";
      const arr = /for \w+ in \[([\s\S]*?)\]/.exec(body)?.[1] ?? "";
      return [...arr.matchAll(/"([^"]*)"/g)].map((m) => m[1] as string);
    };
    const ok = listOf("sandbox_name_accepts_valid");
    const bad = listOf("sandbox_name_enforces_sbx_documented_rules");
    expect(ok.length).toBeGreaterThan(3);
    expect(bad.length).toBeGreaterThan(3);
    for (const name of ok) expect(validateAddressableSandboxName(name), name).toBeNull();
    for (const name of bad) expect(validateAddressableSandboxName(name), name).not.toBeNull();
    expect(validateAddressableSandboxName("a".repeat(128))).toBeNull();
    expect(validateAddressableSandboxName("a".repeat(129))).not.toBeNull();
  });
});
