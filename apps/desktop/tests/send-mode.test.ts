/**
 * A4 `conversation.send` mode on the desktop (design 2026-10-09 §3.4): the
 * `conversation-send-mode` feature, exact send frames (Task omits `mode`,
 * Discuss sends `"discuss"`, nothing when not advertised), the keyed retry
 * resending identical params, `TaskSummary.mode` as an OPEN string,
 * `TaskSummary.chosenSandboxName` shown but NEVER feeding the isolation label
 * or the stop count, the new `sandbox.remove` impact line, honest copy for the
 * mode refusal, and drift against the Rust sources read from disk.
 *
 * The FakeCore A4 behaviour is MODELED on `sandpane-service/src/lib.rs`
 * (working tree), not captured from a live Core. Hidden characters are built
 * with `String.fromCodePoint` so no raw invisible character lives here.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SendModeChoice, TaskSendFacts } from "../src/components/chat/SendMode";
import { CoreClient, CoreRequestError } from "../src/lib/core-client";
import { decodeTaskSummary } from "../src/lib/decode";
import { MalformedFrameError } from "../src/lib/framing";
import { KeyedWrite } from "../src/lib/idempotency";
import {
  FEATURE_CONVERSATION_SEND_MODE,
  KNOWN_FEATURES,
  type SandboxSummary,
  type TaskSummary,
} from "../src/lib/protocol";
import { describeCoreError, foldTaskIndex, taskIsolationView } from "../src/lib/reducers";
import {
  TASK_SANDBOX_UNRECORDED_COPY,
  confirmationView,
  countActiveTasksOn,
} from "../src/lib/sandbox-lifecycle";
import {
  MSG_SEND_MODE_INVALID,
  NOT_RETRIED_NO_SEND_MODE,
  NOT_SENT_NO_SEND_MODE,
  NOT_SENT_UNCHECKED,
  discussModeNotRecorded,
  submitWithDiscussPrecheck,
  SEND_MODES,
  SEND_MODE_COMPOSER_COPY,
  buildSendVariables,
  sendKeyRecheck,
  sendModeGate,
  sendParamsFor,
  taskSendFacts,
  type SendVariables,
} from "../src/lib/send-mode";
import { A3B_CORE_METHODS, A4_CORE_FEATURES, A6_CORE_FEATURES, FakeCore } from "./support/fake-core";
import { SERVICE_RUST, protocolRustSource, rustStrConst, serviceRustSource } from "./support/rust-source";

const cp = (n: number): string => String.fromCodePoint(n);
const KEY = "send-key-0001";

function core(options: ConstructorParameters<typeof FakeCore>[0] = {}) {
  const fake = new FakeCore({ advertisedMethods: A3B_CORE_METHODS, features: A4_CORE_FEATURES, ...options });
  const client = new CoreClient(fake.transport, { requestTimeoutMs: 60, now: () => fake.nowMs });
  return { fake, client };
}

function seed(fake: FakeCore, sandboxId?: string) {
  fake.addProject({ id: "p1", name: "Atlas Demo" });
  fake.addConversation({
    id: "c1",
    projectId: "p1",
    title: "Atlas Demo chat",
    agentId: "codex",
    createdAt: "2026-10-10T00:00:00Z",
    ...(sandboxId === undefined ? {} : { sandboxId }),
  });
}

const base = { conversationId: "c1", content: "Summarise the Atlas Demo plan" };

// ---------------------------------------------------------------------------
// Drift against the Rust sources
// ---------------------------------------------------------------------------

describe("A4 drift against the Rust sources", () => {
  it("conversation-send-mode is a known feature, in Rust FEATURES order", () => {
    const rust = /pub const FEATURES: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(protocolRustSource());
    const names = [...((rust?.[2] ?? "").matchAll(/"([^"]+)"/g))].map((m) => m[1]);
    expect([...KNOWN_FEATURES]).toEqual(names);
    expect(FEATURE_CONVERSATION_SEND_MODE).toBe("conversation-send-mode");
    expect(names).toContain(FEATURE_CONVERSATION_SEND_MODE);
    // The A4 double advertises the A4 prefix of Core's list (A6 appended
    // git-apply); the A6 double advertises all of it (plus one unknown string
    // clients ignore).
    expect(A4_CORE_FEATURES.filter((f) => names.includes(f))).toEqual(names.slice(0, 4));
    expect(A6_CORE_FEATURES.filter((f) => names.includes(f))).toEqual(names);
  });

  it("the mode values and the refusal message are Core's", () => {
    const service = serviceRustSource();
    const values = [...service.matchAll(/SendMode::(?:Task|Discuss) => "([a-z]+)"/g)].map((m) => m[1]);
    expect([...new Set(values)]).toEqual([...SEND_MODES]);
    expect(rustStrConst(SERVICE_RUST, "MSG_SEND_MODE_INVALID")).toBe(MSG_SEND_MODE_INVALID);
  });

  it("the sandbox.remove impact line the double emits is Core's format", () => {
    const service = serviceRustSource();
    const literal = /impact\.push\(format!\(\s*"(\{n\} unfinished task\(s\) were sent from chats[^"]*)"/.exec(service)?.[1];
    expect(literal).toBeDefined();
    // A Rust string continuation (`\` + newline) drops the newline and the
    // next line's leading whitespace.
    const rust = (literal ?? "").replace(/\\\n\s*/g, "");
    expect(FakeCore.chosenNameImpactLine(2)).toBe(rust.replace("{n}", "2"));
  });

  it("TaskSummary carries mode and chosenSandboxName as separate optional fields", () => {
    const protocol = protocolRustSource();
    expect(protocol).toMatch(/pub mode: Option<String>,/);
    expect(protocol).toMatch(/pub chosen_sandbox_name: Option<String>,/);
  });
});

// ---------------------------------------------------------------------------
// Exact send frames
// ---------------------------------------------------------------------------

describe("conversation.send frames", () => {
  it("Task with the feature advertised: no mode key (byte-identical to an A2/A3b frame)", async () => {
    const { fake, client } = core();
    seed(fake);
    const variables = buildSendVariables({ ...base, idempotencyKey: KEY }, "task", true);
    expect(variables).not.toHaveProperty("mode");
    await client.sendConversationMessage(sendParamsFor(variables));
    const frame = fake.lastParams("conversation.send");
    expect(frame).toEqual({ ...base, attachments: [], idempotencyKey: KEY });
    expect(Object.keys(frame)).not.toContain("mode");
  });

  it("Discuss with the feature advertised: mode \"discuss\"", async () => {
    const { fake, client } = core();
    seed(fake);
    const variables = buildSendVariables({ ...base, idempotencyKey: KEY }, "discuss", true);
    const task = await client.sendConversationMessage(sendParamsFor(variables));
    expect(fake.lastParams("conversation.send")).toEqual({
      ...base,
      attachments: [],
      idempotencyKey: KEY,
      mode: "discuss",
    });
    expect(task.mode).toBe("discuss");
  });

  it("not advertised (or not probed yet): mode is never sent, whatever was chosen", async () => {
    for (const advertised of [false, null] as const) {
      const { fake, client } = core({ features: ["idempotency-keys", "conversation-sandbox-id"] });
      seed(fake);
      const variables = buildSendVariables(base, "discuss", advertised);
      expect(variables).not.toHaveProperty("mode");
      await client.sendConversationMessage(sendParamsFor(variables));
      expect(Object.keys(fake.lastParams("conversation.send"))).not.toContain("mode");
    }
  });

  it("the choice is shown only when advertised; otherwise disabled with the reason", () => {
    expect(sendModeGate({ features: [FEATURE_CONVERSATION_SEND_MODE] }).state).toBe("supported");
    expect(sendModeGate(null).state).toBe("unprobed");
    const unsupported = sendModeGate({ features: ["idempotency-keys"] });
    expect(unsupported.state).toBe("unsupported");
    expect(unsupported.note).toContain("not supported by this Core");
    const html = renderToStaticMarkup(
      createElement(SendModeChoice, { gate: unsupported, value: "discuss", onChange: () => {} }),
    );
    expect(html).toContain("not supported by this Core");
    expect(html).not.toMatch(/<input(?![^>]*disabled="")[^>]*type="radio"/);
    const live = renderToStaticMarkup(
      createElement(SendModeChoice, { gate: sendModeGate({ features: [FEATURE_CONVERSATION_SEND_MODE] }), value: "task", onChange: () => {} }),
    );
    // React SSR orders `checked` / `value` after the other attributes.
    expect(live).toMatch(/<input(?=[^>]*type="radio")(?=[^>]*value="task")(?=[^>]*checked="")[^>]*>/);
    expect(live).not.toMatch(/<input(?=[^>]*value="discuss")(?=[^>]*checked="")[^>]*>/);
    expect(live).not.toMatch(/disabled=""/);
    expect(live).toContain("Task");
    expect(live).toContain("Discuss");
  });

  it("the composer copy says neither choice runs an agent, and never calls Discuss safe", () => {
    expect(SEND_MODE_COMPOSER_COPY).toMatch(/Neither Task nor Discuss runs an agent in this build/);
    expect(SEND_MODE_COMPOSER_COPY.toLowerCase()).not.toMatch(/\bsafe\b|read-only run|sandboxed run/);
    const html = renderToStaticMarkup(
      createElement(SendModeChoice, { gate: sendModeGate({ features: [FEATURE_CONVERSATION_SEND_MODE] }), value: "task", onChange: () => {} }),
    );
    expect(html).toContain("Neither Task nor Discuss runs an agent in this build");
  });
});

// ---------------------------------------------------------------------------
// Keyed retry
// ---------------------------------------------------------------------------

describe("keyed retry resends identical params", () => {
  function controller(client: CoreClient, recheck: (p: SendVariables) => Promise<ReturnType<typeof sendKeyRecheck>>) {
    return new KeyedWrite<SendVariables, TaskSummary>(
      (variables) => client.sendConversationMessage(sendParamsFor(variables)),
      { recheckKeys: recheck },
    );
  }

  it("a Discuss send whose answer was lost is retried with the same key AND the same mode", async () => {
    const { fake, client } = core({ dropFirstRequests: 1 });
    seed(fake);
    const write = controller(client, async (p) =>
      sendKeyRecheck({ features: [...A4_CORE_FEATURES] }, p),
    );
    await write.submit(buildSendVariables({ ...base, idempotencyKey: KEY }, "discuss", true));
    const failed = write.getState();
    expect(failed.kind).toBe("failed");
    expect(failed.kind === "failed" && failed.retryOffered).toBe(true);
    expect(await write.retrySafely()).toBe(true);
    const sends = fake.requests.filter((r) => r.method === "conversation.send");
    expect(sends).toHaveLength(2);
    expect(sends[1].params).toEqual(sends[0].params);
    expect(sends[1].params).toMatchObject({ idempotencyKey: KEY, mode: "discuss" });
    expect(write.getState().kind).toBe("succeeded");
  });

  it("a Discuss retry is NOT sent to a Core that no longer advertises send mode (it would drop mode)", async () => {
    const { fake, client } = core({ dropFirstRequests: 1 });
    seed(fake);
    const write = controller(client, async (p) =>
      sendKeyRecheck({ features: ["idempotency-keys"] }, p),
    );
    await write.submit(buildSendVariables({ ...base, idempotencyKey: KEY }, "discuss", true));
    expect(await write.retrySafely()).toBe(false);
    expect(fake.requests.filter((r) => r.method === "conversation.send")).toHaveLength(1);
    const state = write.getState();
    expect(state.kind === "failed" && state.note).toBe(NOT_RETRIED_NO_SEND_MODE);
    expect(state.kind === "failed" && state.retryOffered).toBe(false);
  });

  it("the recheck: a Task retry needs only keys; a Discuss retry needs keys and send mode", () => {
    const task = buildSendVariables({ ...base, idempotencyKey: KEY }, "task", true);
    const discuss = buildSendVariables({ ...base, idempotencyKey: KEY }, "discuss", true);
    expect(sendKeyRecheck({ features: ["idempotency-keys"] }, task)).toEqual({ kind: "advertised" });
    expect(sendKeyRecheck({ features: [] }, task)).toEqual({ kind: "not-advertised" });
    expect(sendKeyRecheck({ features: ["idempotency-keys"] }, discuss)).toEqual({
      kind: "not-retried",
      note: NOT_RETRIED_NO_SEND_MODE,
    });
    expect(sendKeyRecheck({ features: ["idempotency-keys", FEATURE_CONVERSATION_SEND_MODE] }, discuss)).toEqual({
      kind: "advertised",
    });
  });
});

// ---------------------------------------------------------------------------
// TaskSummary.mode (open string) and chosenSandboxName (never a binding)
// ---------------------------------------------------------------------------

const ROW = { id: "t1", conversationId: "c1", status: "queued" };

describe("TaskSummary.mode and chosenSandboxName", () => {
  it("an unknown mode decodes and is displayed as-is; absent stays absent", () => {
    const task = decodeTaskSummary({ ...ROW, mode: "plan" });
    expect(task.mode).toBe("plan");
    expect(taskSendFacts(task)).toEqual([{ label: "Send mode", value: "plan", note: null }]);
    expect(decodeTaskSummary(ROW)).not.toHaveProperty("mode");
    expect(decodeTaskSummary({ ...ROW, mode: null })).not.toHaveProperty("mode");
    expect(taskSendFacts(decodeTaskSummary(ROW))).toEqual([]);
  });

  it("mode and chosenSandboxName are revealed and capped", () => {
    const task = decodeTaskSummary({
      ...ROW,
      mode: `dis${cp(0x202e)}cuss`,
      chosenSandboxName: `atlas${cp(0x200b)}-demo${"x".repeat(300)}`,
    });
    const facts = taskSendFacts(task);
    expect(facts[0].value).toBe("dis\\u202Ecuss");
    expect(facts[1].label).toBe("Sandbox chosen by its chat — not where it runs");
    expect(facts[1].value).toContain("atlas\\u200B-demo");
    expect(facts[1].value).toMatch(/more characters\)$/);
    const html = renderToStaticMarkup(createElement(TaskSendFacts, { task }));
    expect(html).not.toContain(cp(0x202e));
    expect(html).not.toContain(cp(0x200b));
    expect(html).toContain("Send mode");
    expect(html).toContain("not where it runs");
  });

  it("a non-string mode is a malformed row that is never echoed", () => {
    expect(() => decodeTaskSummary({ ...ROW, mode: 7, leak: "ghp_secretvalue" })).toThrow(/mode/);
    const call = () => decodeTaskSummary({ ...ROW, mode: { x: "ghp_secretvalue" } });
    expect(call).toThrow(MalformedFrameError);
    expect(call).not.toThrow(/ghp_secretvalue/);
  });

  it("chosenSandboxName never feeds the isolation label: such a task stays UNVERIFIED", () => {
    const sandboxes: Pick<SandboxSummary, "name" | "workspaceMode" | "unrecognizedWorkspaceMode">[] = [
      { name: "atlas-demo", workspaceMode: "sbx_clone" },
    ];
    const task = decodeTaskSummary({ ...ROW, chosenSandboxName: "atlas-demo" });
    const [entry] = foldTaskIndex(new Map(), [task]);
    expect(entry.sandboxName).toBeNull();
    expect(entry.chosenSandboxName).toBe("atlas-demo");
    const view = taskIsolationView(entry, sandboxes);
    expect(view.verified).toBe(false);
    expect(view.liveWritable).toBe(true);
    // Control: the SAME sandbox as a binding (sandboxName) does verify.
    expect(taskIsolationView({ ...entry, sandboxName: "atlas-demo" }, sandboxes).verified).toBe(true);
  });

  it("chosenSandboxName never feeds the stop count: Core still does not record a task's sandbox", async () => {
    const { fake, client } = core();
    seed(fake, "atlas-demo");
    const task = await client.sendConversationMessage(sendParamsFor(buildSendVariables(base, "discuss", true)));
    expect(task.chosenSandboxName).toBe("atlas-demo");
    expect(task.sandboxName ?? null).toBeNull();
    expect(await countActiveTasksOn(client, true, "atlas-demo")).toBe("unrecorded");
    expect(TASK_SANDBOX_UNRECORDED_COPY).toMatch(/cannot be checked/);
    // Two such tasks, still not a count.
    await client.sendConversationMessage(sendParamsFor(buildSendVariables(base, "task", true)));
    expect(await countActiveTasksOn(client, true, "atlas-demo")).toBe("unrecorded");
  });
});

// ---------------------------------------------------------------------------
// sandbox.remove impact line and the mode refusal copy
// ---------------------------------------------------------------------------

describe("sandbox.remove impact and honest copy", () => {
  it("the 'sent from chats that chose this sandbox name' impact line is displayed, revealed", async () => {
    const { fake, client } = core();
    seed(fake, "atlas-demo");
    fake.sandboxes.push({ name: "atlas-demo", id: "sbx-1", status: "running", bound: true });
    await client.sendConversationMessage(sendParamsFor(buildSendVariables(base, "discuss", true)));
    const confirmation = await client.requestSandboxRemoval("atlas-demo");
    const view = confirmationView(confirmation, fake.nowMs);
    expect(view.impactLines).toContain(
      "1 unfinished task(s) were sent from chats that chose this sandbox name; removing it does not cancel them",
    );
  });

  it("the 'could not be read' impact variant is Core's text and is displayed, revealed", async () => {
    const literal = /impact\.push\(\s*"(the number of unfinished tasks sent from chats[^"]*)"/.exec(serviceRustSource())?.[1];
    expect(literal).toBeDefined();
    const line = (literal ?? "").replace(/\\\n\s*/g, "");
    expect(line).toBe(
      "the number of unfinished tasks sent from chats that chose this sandbox name could not be read; removing it does not cancel them",
    );
    const { fake, client } = core();
    seed(fake);
    fake.sandboxes.push({ name: "atlas-demo", id: "sbx-1", status: "running", bound: true });
    fake.extraImpact = [line];
    const view = confirmationView(await client.requestSandboxRemoval("atlas-demo"), fake.nowMs);
    expect(view.impactLines).toContain(line);
  });

  it("Core's mode refusal gets honest copy (the frame was sent); the raw value is refused case-sensitively", async () => {
    const { fake, client } = core();
    seed(fake);
    for (const bad of ["Task", "DISCUSS", "", " task", "plan"]) {
      const err = await client
        .sendConversationMessage({ ...base, attachments: [], mode: bad as "discuss" })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(CoreRequestError);
      const e = err as CoreRequestError;
      expect([e.code, e.message]).toEqual(["VALIDATION_FAILED", MSG_SEND_MODE_INVALID]);
      const copy = describeCoreError(e);
      // The frame WAS sent; Core refused it before creating anything.
      expect(copy.title).toBe("Core did not accept the message — it refused the send mode");
      expect(copy.title).not.toMatch(/nothing was sent/i);
    }
    expect(fake.ran["conversation.send"] ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// W1: a NEW Discuss send re-probes first; the answer is checked for the mode
// ---------------------------------------------------------------------------

describe("a new Discuss send never trusts a cached probe", () => {
  it("Core no longer advertises send mode: refused visibly, no frame, never downgraded to Task", async () => {
    // The cache said "advertised" (the variables carry mode), but Core now does not.
    const { fake, client } = core({ features: ["idempotency-keys", "conversation-sandbox-id"] });
    seed(fake);
    const submitted: SendVariables[] = [];
    const variables = buildSendVariables({ ...base, idempotencyKey: KEY }, "discuss", true);
    const outcome = await submitWithDiscussPrecheck(variables, {
      probe: () => client.probe(),
      submit: async (v) => {
        submitted.push(v);
        return true;
      },
    });
    expect(outcome).toEqual({ kind: "not-sent", note: NOT_SENT_NO_SEND_MODE });
    expect(NOT_SENT_NO_SEND_MODE).toBe(
      "Not sent: this Core does not advertise send modes, so it would record the discussion as a task. Nothing was sent.",
    );
    expect(submitted).toEqual([]);
    expect(fake.requests.filter((r) => r.method === "conversation.send")).toHaveLength(0);
  });

  it("Core cannot be re-checked: not sent either", async () => {
    const variables = buildSendVariables(base, "discuss", true);
    const unreachable = new CoreRequestError("client", "CORE_UNREACHABLE", "no Core is listening");
    let sent = false;
    const outcome = await submitWithDiscussPrecheck(variables, {
      probe: async () => ({ kind: "unreachable", error: unreachable }),
      submit: async () => {
        sent = true;
        return true;
      },
    });
    expect(outcome).toEqual({ kind: "not-sent", note: NOT_SENT_UNCHECKED });
    expect(sent).toBe(false);
  });

  it("still advertised: the IDENTICAL Discuss variables are submitted (and a Task send is not re-probed)", async () => {
    const { fake, client } = core();
    seed(fake);
    let probes = 0;
    const deps = {
      probe: () => {
        probes += 1;
        return client.probe();
      },
      submit: async (v: SendVariables) => {
        await client.sendConversationMessage(sendParamsFor(v));
        return true;
      },
    };
    const discuss = buildSendVariables({ ...base, idempotencyKey: KEY }, "discuss", true);
    expect(await submitWithDiscussPrecheck(discuss, deps)).toEqual({ kind: "submitted" });
    expect(fake.lastParams("conversation.send")).toMatchObject({ mode: "discuss", idempotencyKey: KEY });
    expect(probes).toBe(1);
    await submitWithDiscussPrecheck(buildSendVariables(base, "task", true), deps);
    expect(probes).toBe(1);
  });

  it("a Discuss send whose task does not report mode \"discuss\" gets a warning", async () => {
    const discuss = buildSendVariables(base, "discuss", true);
    // A Core that silently dropped `mode` (pre-A4 behaviour): no mode on the task.
    const { fake, client } = core({ features: ["idempotency-keys"] });
    seed(fake);
    const dropped = await client.sendConversationMessage(sendParamsFor(discuss));
    expect(discussModeNotRecorded(discuss, dropped)).toMatch(/did not record the requested mode/);
    expect(discussModeNotRecorded(discuss, { ...dropped, mode: "task" })).toMatch(/"task"/);
    expect(discussModeNotRecorded(discuss, { ...dropped, mode: `x${cp(0x202e)}` })).toContain("\\u202E");
    // Recorded as asked, or a Task send: no warning.
    expect(discussModeNotRecorded(discuss, { ...dropped, mode: "discuss" })).toBeNull();
    expect(discussModeNotRecorded(buildSendVariables(base, "task", true), dropped)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FakeCore model sanity (MODELED, not captured)
// ---------------------------------------------------------------------------

describe("FakeCore A4 model", () => {
  it("an explicit \"task\" is normalized before the key fingerprint: it replays an absent-mode send", async () => {
    const { fake, client } = core();
    seed(fake);
    const first = await client.sendConversationMessage({ ...base, attachments: [], idempotencyKey: KEY });
    expect(first.mode).toBe("task");
    const again = await client.sendConversationMessage({ ...base, attachments: [], idempotencyKey: KEY, mode: "task" });
    expect(again.replayed).toBe(true);
    expect(again.id).toBe(first.id);
    const conflict = await client
      .sendConversationMessage({ ...base, attachments: [], idempotencyKey: KEY, mode: "discuss" })
      .then(
        () => null,
        (e: unknown) => e as CoreRequestError,
      );
    expect(conflict?.code).toBe("CONFLICT");
  });

  it("a pre-A4 Core silently drops mode (why the client sends it only when advertised)", async () => {
    const { fake, client } = core({ features: ["idempotency-keys"] });
    seed(fake, "atlas-demo");
    const task = await client.sendConversationMessage({ ...base, attachments: [], mode: "discuss" });
    expect(task).not.toHaveProperty("mode");
    expect(task).not.toHaveProperty("chosenSandboxName");
  });
});
