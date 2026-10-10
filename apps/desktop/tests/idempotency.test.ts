/**
 * A2 on the desktop: `features`, idempotency keys, explicit "Retry safely",
 * replay handling and the three CONFLICT messages (design 2026-10-09 §3.1).
 *
 * Feature and CONFLICT strings are read from the Rust sources and the schema,
 * so a Core-side change without a client change fails here. The FakeCore
 * idempotency behaviour is MODELED on the service source, not captured live.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CoreClient,
  CoreRequestError,
  REPLAY_SAFE_METHODS,
  timeoutError,
  type CoreTransport,
} from "../src/lib/core-client";
import { decodeCoreCapabilities, decodeSandboxSummaries, decodeTaskSummary } from "../src/lib/decode";
import {
  KeyedWrite,
  NOT_RETRIED_NO_KEYS,
  NOT_RETRIED_UNCHECKED,
  REPLAY_UNCERTAIN_NOTICE,
  keyRecheckFromProbe,
  IDEM_MSG_MISMATCH,
  IDEM_MSG_PENDING,
  IDEM_MSG_UNKNOWN,
  REPLAY_NOTICE,
  forNewAction,
  idempotencyConflictKind,
  idempotencyKeysAdvertised,
  isUnknownOutcome,
  isValidIdempotencyKey,
  newIdempotencyKey,
  retrySafelyOffered,
} from "../src/lib/idempotency";
import {
  FEATURE_IDEMPOTENCY_KEYS,
  FEATURE_SANDBOX_CREATE_AGENT,
  KNOWN_FEATURES,
  coreAdvertisesFeature,
} from "../src/lib/protocol";
import {
  KEYED_UNKNOWN_ACTION,
  NAME_LOCK_PREFIX,
  NAME_LOCK_SUFFIX,
  UNKEYED_UNKNOWN_ACTION,
  describeCoreError,
  isNameLockConflict,
} from "../src/lib/reducers";
import { agentFieldHonoured } from "../src/lib/sandbox-lifecycle";
import {
  FAKE_IDEM_MSG_MISMATCH,
  FAKE_IDEM_MSG_PENDING,
  FAKE_IDEM_MSG_UNKNOWN,
  FakeCore,
} from "./support/fake-core";
import { REPO_ROOT, protocolRustSource, readSchema, serviceRustSource } from "./support/rust-source";

const BASE_CAPS = {
  protocolVersion: 1,
  coreVersion: "0.1.0",
  instanceId: "i",
  sbx: null,
  agents: [],
  platform: "macos",
};

/** A Rust `&str` literal with `\`-newline continuations folded, as rustc does. */
function rustStrConst(source: string, name: string): string {
  const match = new RegExp(`pub const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)";`).exec(source);
  if (!match) throw new Error(`no parseable ${name}`);
  return (match[1] as string).replace(/\\\n\s*/g, "");
}

function keyedClient(core: FakeCore, timeoutMs = 15_000): CoreClient {
  return new CoreClient(core.transport, {
    methodTimeoutsMs: { "conversation.send": timeoutMs, "sandbox.create": timeoutMs },
  });
}

describe("features (drift-gated)", () => {
  it("the known features are Rust FEATURES and the schema's examples, in order", () => {
    const rust = /pub const FEATURES: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(protocolRustSource());
    expect(rust).not.toBeNull();
    const names = [...((rust?.[2] ?? "").matchAll(/"([^"]+)"/g))].map((m) => m[1]);
    expect([...KNOWN_FEATURES]).toEqual(names);
    expect(Number(rust?.[1])).toBe(KNOWN_FEATURES.length);
    const schema = readSchema<{
      properties: { features: { items: { examples: string[] } } };
      required?: string[];
    }>("core-capabilities");
    expect([...KNOWN_FEATURES]).toEqual(schema.properties.features.items.examples);
    expect(schema.required ?? []).not.toContain("features");
  });

  it("absent features = nothing advertised; unknown strings are ignored, never fatal", () => {
    const old = decodeCoreCapabilities({ ...BASE_CAPS, methods: [] });
    expect(old.features).toBeUndefined();
    expect(coreAdvertisesFeature(old, FEATURE_IDEMPOTENCY_KEYS)).toBe(false);
    const future = decodeCoreCapabilities({
      ...BASE_CAPS,
      features: ["some-future-feature", FEATURE_IDEMPOTENCY_KEYS, 7, null],
    });
    expect(future.features).toEqual(["some-future-feature", FEATURE_IDEMPOTENCY_KEYS]);
    expect(idempotencyKeysAdvertised(future)).toBe(true);
    expect(coreAdvertisesFeature(future, FEATURE_SANDBOX_CREATE_AGENT)).toBe(false);
    const odd = decodeCoreCapabilities({ ...BASE_CAPS, features: "idempotency-keys" });
    expect(idempotencyKeysAdvertised(odd)).toBe(false);
  });

  it("the sbx agent choice is gated on sandbox-create-agent, not on sandbox.remove", () => {
    expect(agentFieldHonoured({ features: [], methods: ["sandbox.remove"] } as never)).toBe(false);
    expect(agentFieldHonoured({ features: [FEATURE_SANDBOX_CREATE_AGENT] })).toBe(true);
    expect(agentFieldHonoured(null)).toBe(false);
  });

  it("a probe through the client carries features; a pre-A2 Core carries none", async () => {
    const a2 = await new CoreClient(new FakeCore().transport).probe();
    if (a2.kind !== "attached") throw new Error("attach");
    expect(idempotencyKeysAdvertised(a2.capabilities)).toBe(true);
    const preA2 = await new CoreClient(new FakeCore({ features: null }).transport).probe();
    if (preA2.kind !== "attached") throw new Error("attach");
    expect(preA2.capabilities.features).toBeUndefined();
    expect(idempotencyKeysAdvertised(preA2.capabilities)).toBe(false);
  });
});

describe("keys", () => {
  it("a key is 32 lowercase hex characters from the CSPRNG", () => {
    const key = newIdempotencyKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(newIdempotencyKey()).not.toBe(key);
    const fixed = newIdempotencyKey((bytes) => bytes.fill(0xab));
    expect(fixed).toBe("ab".repeat(16));
    expect(isValidIdempotencyKey(key)).toBe(true);
  });

  it("the client's key rule is Core's exactly: 1..=128 of [A-Za-z0-9._-]", () => {
    for (const ok of ["a", "A.b_c-1", "k".repeat(128), "AbC"]) {
      expect(isValidIdempotencyKey(ok), ok).toBe(true);
    }
    for (const bad of ["", "k".repeat(129), "a b", "a/b", "a\n", "ä", "a+b", "a=b"]) {
      expect(isValidIdempotencyKey(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("a key is added only when advertised, and every new action gets a fresh one", () => {
    const params = { conversationId: "c1", content: "hi" };
    const without = forNewAction(params, false);
    expect("idempotencyKey" in without).toBe(false);
    const first = forNewAction(params, true);
    const second = forNewAction(params, true);
    expect(first.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(params).toEqual({ conversationId: "c1", content: "hi" }); // never mutated
  });

  it("the frame carries the key when given, none otherwise; a bad key never leaves", async () => {
    const core = new FakeCore();
    const client = keyedClient(core);
    await client.sendConversationMessage({ conversationId: "c1", content: "a", attachments: [] });
    expect(core.lastParams("conversation.send")).toEqual({
      conversationId: "c1",
      content: "a",
      attachments: [],
    });
    await client.sendConversationMessage({
      conversationId: "c1",
      content: "b",
      attachments: [],
      idempotencyKey: "k-1",
    });
    expect(core.lastParams("conversation.send")).toMatchObject({ idempotencyKey: "k-1" });
    const before = core.callsFor("conversation.send");
    await expect(
      client.sendConversationMessage({
        conversationId: "c1",
        content: "c",
        attachments: [],
        idempotencyKey: "bad key",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(
      client.createSandboxSummary({
        name: "atlas-demo",
        projectId: "p1",
        workspaceMode: "mountless",
        idempotencyKey: "",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(core.callsFor("conversation.send")).toBe(before);
    expect(core.callsFor("sandbox.create")).toBe(0);
  });
});

describe("explicit Retry safely after an unknown outcome", () => {
  it("send: a lost answer offers Retry safely; the same key replays instead of running twice", async () => {
    const core = new FakeCore();
    core.dropAnswersAfterApply = 1;
    const client = keyedClient(core, 30);
    const variables = forNewAction(
      { conversationId: "c1", content: "hello", attachments: [] },
      true,
    );
    let lost: unknown;
    try {
      await client.sendConversationMessage(variables);
    } catch (err) {
      lost = err;
    }
    expect(isUnknownOutcome(lost)).toBe(true);
    expect(retrySafelyOffered(lost, variables)).toBe(true);
    expect(core.ran["conversation.send"]).toBe(1);

    // The user clicks Retry safely: IDENTICAL params, SAME key.
    const replay = await client.sendConversationMessage(variables);
    expect(replay.replayed).toBe(true);
    expect(core.ran["conversation.send"]).toBe(1);
    expect(core.tasks).toHaveLength(1);
    const sent = core.sent["conversation.send"] ?? [];
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
  });

  it("create: the same holds for sandbox.create", async () => {
    const core = new FakeCore();
    core.dropAnswersAfterApply = 1;
    const client = keyedClient(core, 30);
    const spec = forNewAction(
      { name: "atlas-demo", projectId: "p1", workspaceMode: "mountless" as const },
      true,
    );
    await expect(client.createSandboxSummary(spec)).rejects.toMatchObject({ code: "TIMEOUT" });
    const replay = await client.createSandboxSummary(spec);
    expect(replay.replayed).toBe(true);
    expect(core.ran["sandbox.create"]).toBe(1);
    expect(core.sandboxes).toHaveLength(1);
  });

  it("no key (pre-A2 Core) → no Retry safely; the honest unknown-outcome copy stays", () => {
    const lost = timeoutError("conversation.send", 15_000);
    expect(retrySafelyOffered(lost, { conversationId: "c1", content: "x" } as never)).toBe(false);
    expect(retrySafelyOffered(lost, undefined)).toBe(false);
    expect(describeCoreError(lost).title).toBe("Outcome unknown — this may have been applied");
  });

  it("only unknown outcomes qualify: Core INTERNAL yes; CONFLICT / VALIDATION_FAILED / reads no", () => {
    const keyed = { idempotencyKey: "k-1" };
    expect(retrySafelyOffered(new CoreRequestError("core", "INTERNAL", "sbx failed"), keyed)).toBe(true);
    expect(
      retrySafelyOffered(new CoreRequestError("core", "CONFLICT", IDEM_MSG_UNKNOWN), keyed),
    ).toBe(false);
    expect(
      retrySafelyOffered(new CoreRequestError("core", "VALIDATION_FAILED", "bad"), keyed),
    ).toBe(false);
    expect(retrySafelyOffered(timeoutError("task.list", 15_000), keyed)).toBe(false);
  });

  it("automatic replay sets are unchanged by A2", () => {
    expect([...REPLAY_SAFE_METHODS].sort()).toEqual(
      [
        "system.probe",
        "project.list",
        "sandbox.list",
        "task.list",
        "conversation.list",
        "conversation.history",
        "task.subscribe",
        "git.review",
      ].sort(),
    );
    const rust = readFileSync(join(REPO_ROOT, "apps/desktop/src-tauri/src/ipc_client.rs"), "utf8");
    expect(rust).not.toContain("Core has no idempotency keys yet");
    expect(rust).toContain("Auto-replay still stays OFF");
  });
});

describe("replay handling", () => {
  it("replayed is kept only as an explicit true; a non-boolean reads as 'maybe replayed'", () => {
    expect(decodeTaskSummary({ id: "t", conversationId: "c", status: "queued", replayed: true }).replayed).toBe(true);
    const fresh = decodeTaskSummary({ id: "t", conversationId: "c", status: "queued" });
    expect("replayed" in fresh).toBe(false);
    const notReplay = decodeTaskSummary({ id: "t", conversationId: "c", status: "queued", replayed: false });
    expect("replayed" in notReplay).toBe(false);
    const odd = decodeTaskSummary({ id: "t", conversationId: "c", status: "queued", replayed: "yes" });
    expect(odd.replayedUncertain).toBe(true);
    expect("replayed" in odd).toBe(false);
    const [sandbox] = decodeSandboxSummaries([
      { name: "a1", probedState: "running", boundProjectId: null, replayed: true },
    ]);
    expect(sandbox?.replayed).toBe(true);
  });

  it("the replay notice is the exact shared wording", () => {
    expect(REPLAY_NOTICE).toBe(
      "Core returned the result of your earlier identical request (replayed). It may be out of date; refreshing from Core.",
    );
  });
});

describe("A2 CONFLICT copy", () => {
  it("the three messages are Core's, verbatim (drift-gated against sandpane-service)", () => {
    const service = serviceRustSource();
    expect(rustStrConst(service, "IDEM_MSG_MISMATCH")).toBe(IDEM_MSG_MISMATCH);
    expect(rustStrConst(service, "IDEM_MSG_PENDING")).toBe(IDEM_MSG_PENDING);
    expect(rustStrConst(service, "IDEM_MSG_UNKNOWN")).toBe(IDEM_MSG_UNKNOWN);
    expect([FAKE_IDEM_MSG_MISMATCH, FAKE_IDEM_MSG_PENDING, FAKE_IDEM_MSG_UNKNOWN]).toEqual([
      IDEM_MSG_MISMATCH,
      IDEM_MSG_PENDING,
      IDEM_MSG_UNKNOWN,
    ]);
  });

  it("mismatch and pending say nothing was run; unknown never does", () => {
    const mismatch = describeCoreError(new CoreRequestError("core", "CONFLICT", IDEM_MSG_MISMATCH));
    const pending = describeCoreError(new CoreRequestError("core", "CONFLICT", IDEM_MSG_PENDING));
    const unknown = describeCoreError(new CoreRequestError("core", "CONFLICT", IDEM_MSG_UNKNOWN));
    expect(mismatch.title).toMatch(/^Nothing was run/);
    expect(pending.title).toMatch(/^Nothing was run/);
    expect(unknown.title).toBe("Outcome unknown — re-read state");
    expect(`${unknown.title} ${unknown.action} ${unknown.reason}`).not.toMatch(/nothing (was|ran)/i);
    expect(unknown.action).toMatch(/new request/);
    expect(mismatch.reason).toBe(IDEM_MSG_MISMATCH); // Core's own words stay visible
  });

  it("Core's message is revealed and capped; A1's name-lock CONFLICT keeps its own copy", () => {
    const hostile = `${IDEM_MSG_PENDING}\u202E\u2028${"z".repeat(900)}`;
    const copy = describeCoreError(new CoreRequestError("core", "CONFLICT", hostile));
    expect(copy.title).toMatch(/^Nothing was run/);
    expect(copy.reason).not.toContain("\u202E");
    expect(copy.reason).toContain("\\u202E");
    expect(copy.reason).toContain("\\u2028");
    expect(copy.reason).toMatch(/more characters\)$/);
    const nameLock = new CoreRequestError(
      "core",
      "CONFLICT",
      'another operation on sandbox "atlas-demo" is in progress; nothing was run',
    );
    expect(idempotencyConflictKind(nameLock)).toBeNull();
    expect(describeCoreError(nameLock).title).toBe(
      "Nothing was run — another operation on this sandbox is in progress",
    );
  });

  it("the modeled Core answers each CONFLICT and never runs the write", async () => {
    const core = new FakeCore();
    const client = keyedClient(core);
    await client.sendConversationMessage({
      conversationId: "c1",
      content: "one",
      attachments: [],
      idempotencyKey: "k-1",
    });
    const differs = client.sendConversationMessage({
      conversationId: "c1",
      content: "two",
      attachments: [],
      idempotencyKey: "k-1",
    });
    await expect(differs).rejects.toMatchObject({ code: "CONFLICT", message: IDEM_MSG_MISMATCH });
    core.setKeyState("conversation.send", "k-2", "pending");
    core.setKeyState("conversation.send", "k-3", "unknown");
    for (const [key, message] of [
      ["k-2", IDEM_MSG_PENDING],
      ["k-3", IDEM_MSG_UNKNOWN],
    ] as const) {
      const err = await client
        .sendConversationMessage({ conversationId: "c1", content: "x", attachments: [], idempotencyKey: key })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "CONFLICT", message });
      expect(retrySafelyOffered(err, { idempotencyKey: key })).toBe(false);
    }
    expect(core.ran["conversation.send"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Combined A2 client review: W1–W4, I4, I5
// ---------------------------------------------------------------------------

/** A transport whose answers the test scripts (raw `ok` payloads or errors). */
class ScriptedTransport implements CoreTransport {
  readonly kind = "memory";
  readonly frames: { method: string; params: Record<string, unknown> }[] = [];
  private handlers: ((line: string) => void)[] = [];
  constructor(private readonly answer: (method: string, params: Record<string, unknown>) => unknown) {}
  write(frame: string): Promise<void> {
    const parsed = JSON.parse(frame) as { id: string; method: string; params: Record<string, unknown> };
    this.frames.push({ method: parsed.method, params: parsed.params });
    const reply = this.answer(parsed.method, parsed.params);
    const line =
      typeof reply === "object" && reply !== null && "err" in reply
        ? JSON.stringify({ v: 1, id: parsed.id, ...(reply as object) })
        : JSON.stringify({ v: 1, id: parsed.id, ok: reply });
    queueMicrotask(() => {
      for (const handler of [...this.handlers]) handler(line);
    });
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
}

type Send = { conversationId: string; content: string; idempotencyKey?: string };

function lostAnswer(): CoreRequestError {
  return timeoutError("conversation.send", 15_000);
}

describe("W1 — Retry safely re-checks the CURRENT Core first", () => {
  it("not advertised any more → nothing is sent, the exact copy is shown, retry withdrawn", async () => {
    let runs = 0;
    const write = new KeyedWrite<Send, string>(
      async () => {
        runs += 1;
        throw lostAnswer();
      },
      // The connected Core (a pre-A2 one now) is probed for real through a client.
      { recheckKeys: async () => keyRecheckFromProbe(await new CoreClient(new FakeCore({ features: null }).transport).probe()) },
    );
    await write.submit({ conversationId: "c1", content: "x", idempotencyKey: "k-1" });
    expect(write.getState()).toMatchObject({ kind: "failed", retryOffered: true });
    expect(await write.retrySafely()).toBe(false);
    expect(runs).toBe(1);
    const state = write.getState();
    expect(state).toMatchObject({ kind: "failed", retryOffered: false, note: NOT_RETRIED_NO_KEYS });
    expect(NOT_RETRIED_NO_KEYS).toBe(
      "Not retried: the connected Core does not advertise idempotency keys, so a retry could run it twice. Nothing was sent — check state first.",
    );
  });

  it("still advertised → the identical params with the same key are resent once", async () => {
    const sent: Send[] = [];
    let first = true;
    const write = new KeyedWrite<Send, string>(
      async (params) => {
        sent.push(params);
        if (first) {
          first = false;
          throw lostAnswer();
        }
        return "ok";
      },
      { recheckKeys: async () => keyRecheckFromProbe(await new CoreClient(new FakeCore().transport).probe()) },
    );
    const params = { conversationId: "c1", content: "x", idempotencyKey: "k-1" };
    await write.submit(params);
    expect(await write.retrySafely()).toBe(true);
    expect(sent).toEqual([params, params]);
    expect(write.getState()).toMatchObject({ kind: "succeeded", result: "ok" });
  });
});

describe("W2 — a retry that never reached Core keeps the unknown outcome and the key", () => {
  it("CORE_UNREACHABLE on the retry keeps the original error, offers Retry safely again", async () => {
    const outcomes: (() => string)[] = [
      () => {
        throw lostAnswer();
      },
      () => {
        throw new CoreRequestError("client", "CORE_UNREACHABLE", "no Core on the socket", {
          mayHaveBeenApplied: false,
        });
      },
      () => "replayed-ok",
    ];
    const sent: Send[] = [];
    const write = new KeyedWrite<Send, string>(
      async (params) => {
        sent.push(params);
        return (outcomes.shift() as () => string)();
      },
      { recheckKeys: async () => ({ kind: "advertised" }) },
    );
    await write.submit({ conversationId: "c1", content: "x", idempotencyKey: "k-1" });
    const original = write.getState();
    if (original.kind !== "failed") throw new Error("expected failure");
    await write.retrySafely();
    const kept = write.getState();
    expect(kept).toMatchObject({ kind: "failed", retryOffered: true });
    if (kept.kind !== "failed") throw new Error("expected failure");
    expect(kept.error).toBe(original.error); // the unknown outcome stands
    expect(kept.noteError?.code).toBe("CORE_UNREACHABLE"); // secondary only
    expect(describeCoreError(kept.error).title).toBe("Outcome unknown — this may have been applied");
    await write.retrySafely();
    expect(write.getState()).toMatchObject({ kind: "succeeded" });
    expect(new Set(sent.map((p) => p.idempotencyKey))).toEqual(new Set(["k-1"]));
  });

  it("an unreachable re-check sends nothing and keeps Retry safely", async () => {
    let runs = 0;
    const write = new KeyedWrite<Send, string>(
      async () => {
        runs += 1;
        throw lostAnswer();
      },
      {
        // The re-probe itself cannot reach Core: we cannot know the features.
        recheckKeys: async () => {
          throw new CoreRequestError("client", "CORE_UNREACHABLE", "no Core on the socket");
        },
      },
    );
    await write.submit({ conversationId: "c1", content: "x", idempotencyKey: "k-1" });
    expect(await write.retrySafely()).toBe(false);
    expect(runs).toBe(1);
    const state = write.getState();
    expect(state).toMatchObject({ kind: "failed", retryOffered: true, note: NOT_RETRIED_UNCHECKED });
    if (state.kind !== "failed") throw new Error("expected failure");
    expect(state.noteError?.code).toBe("CORE_UNREACHABLE");
    expect(describeCoreError(state.error).title).toBe("Outcome unknown — this may have been applied");
  });
});

describe("W3 — an unreadable reply to a keyed write is an unknown outcome", () => {
  it("send/create: a decode failure after Core answered maps to mayHaveBeenApplied, never echoing it", async () => {
    const secret = "PAYLOAD-SHOULD-NOT-APPEAR";
    const t = new ScriptedTransport(() => ({ id: secret, conversationId: 7 }));
    const client = new CoreClient(t);
    const keyedErr = await client
      .sendConversationMessage({ conversationId: "c1", content: "x", attachments: [], idempotencyKey: "k-1" })
      .catch((e: unknown) => e);
    expect(keyedErr).toBeInstanceOf(CoreRequestError);
    const err = keyedErr as CoreRequestError;
    expect(err.mayHaveBeenApplied).toBe(true);
    expect(err.message).not.toContain(secret);
    expect(JSON.stringify(err.details)).not.toContain(secret);
    expect(retrySafelyOffered(err, { idempotencyKey: "k-1" })).toBe(true);
    expect(describeCoreError(err).action).toBe(KEYED_UNKNOWN_ACTION);

    const unkeyed = (await client
      .createSandboxSummary({ name: "atlas-demo", projectId: "p1", workspaceMode: "mountless" })
      .catch((e: unknown) => e)) as CoreRequestError;
    expect(unkeyed.mayHaveBeenApplied).toBe(true);
    expect(retrySafelyOffered(unkeyed, {})).toBe(false);
    expect(describeCoreError(unkeyed).action).toBe(UNKEYED_UNKNOWN_ACTION);
  });

  it("a malformed replayed marker does not fail the reply; it reads as maybe-replayed", async () => {
    const t = new ScriptedTransport(() => ({ id: "t1", conversationId: "c1", status: "queued", replayed: "yes" }));
    const task = await new CoreClient(t).sendConversationMessage({
      conversationId: "c1",
      content: "x",
      attachments: [],
      idempotencyKey: "k-1",
    });
    expect(task.replayedUncertain).toBe(true);
    expect(REPLAY_UNCERTAIN_NOTICE).toMatch(/refreshing from Core/);
  });
});

describe("W4 — INTERNAL on an unkeyed create/send never invites a plain retry", () => {
  it("unkeyed → unknown-outcome copy naming the missing keys; keyed → Retry safely", async () => {
    const t = new ScriptedTransport(() => ({ err: { code: "INTERNAL", message: "sbx failed" } }));
    const client = new CoreClient(t);
    const unkeyed = (await client
      .sendConversationMessage({ conversationId: "c1", content: "x", attachments: [] })
      .catch((e: unknown) => e)) as CoreRequestError;
    expect(unkeyed.isCoreError).toBe(true);
    expect(unkeyed.code).toBe("INTERNAL");
    const copy = describeCoreError(unkeyed);
    expect(copy.title).toBe("Outcome unknown — this may have been applied");
    expect(copy.action).toBe(
      "Check state before trying again (this Core does not advertise idempotency keys, so a retry could run it twice).",
    );
    expect(copy.action).not.toMatch(/^Retry/);
    expect(retrySafelyOffered(unkeyed, {})).toBe(false);

    const keyed = (await client
      .createSandboxSummary({ name: "atlas-demo", projectId: "p1", workspaceMode: "mountless", idempotencyKey: "k-2" })
      .catch((e: unknown) => e)) as CoreRequestError;
    expect(retrySafelyOffered(keyed, { idempotencyKey: "k-2" })).toBe(true);
    expect(describeCoreError(keyed).action).toBe(KEYED_UNKNOWN_ACTION);
    // Other methods keep Core's ordinary INTERNAL copy.
    expect(describeCoreError(new CoreRequestError("core", "INTERNAL", "x")).title).toBe(
      "Core reported an internal error",
    );
  });
});

describe("I4 / I5", () => {
  it("a double click on Retry safely sends once", async () => {
    let runs = 0;
    let release: () => void = () => {};
    const write = new KeyedWrite<Send, string>(
      async () => {
        runs += 1;
        if (runs === 1) throw lostAnswer();
        if (runs === 2) await new Promise<void>((resolve) => (release = resolve));
        return "ok";
      },
      { recheckKeys: async () => ({ kind: "advertised" }) },
    );
    await write.submit({ conversationId: "c1", content: "x", idempotencyKey: "k-1" });
    const a = write.retrySafely();
    const b = write.retrySafely();
    expect(await b).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    expect(await a).toBe(true);
    expect(runs).toBe(2);
    // The latch is released afterwards: a later, new action is accepted.
    expect(await write.submit({ conversationId: "c1", content: "y" })).toBe(true);
    expect(runs).toBe(3);
  });

  it("the A1 name-lock CONFLICT text is Core's (drift-gated)", () => {
    expect(serviceRustSource()).toContain(
      `format!("${NAME_LOCK_PREFIX}{name:?}${NAME_LOCK_SUFFIX}")`,
    );
    expect(isNameLockConflict('another operation on sandbox "x1" is in progress; nothing was run')).toBe(true);
    expect(isNameLockConflict(IDEM_MSG_PENDING)).toBe(false);
  });
});
