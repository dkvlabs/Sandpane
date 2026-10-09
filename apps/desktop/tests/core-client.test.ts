import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoreClient,
  CoreRequestError,
  TaskSubscription,
  type CoreTransport,
} from "../src/lib/core-client";
import { FakeCore } from "./support/fake-core";
import { encodeFrame } from "../src/lib/framing";
import { PROTOCOL_VERSION, type TaskEvent } from "../src/lib/protocol";

function ev(taskId: string, sequence: number, kind = "task.created"): TaskEvent {
  return {
    taskId,
    sequence,
    kind,
    payload: kind === "status.changed" ? { to: "running" } : { conversationId: "c1" },
    timestamp: "2026-10-09T00:00:00Z",
  };
}

/**
 * Transport whose replies the test releases by hand, so response ordering is a
 * variable rather than an assumption.
 */
class ManualTransport implements CoreTransport {
  readonly kind = "memory";
  readonly requests: { id: string; method: string; params: unknown }[] = [];
  private handlers: ((line: string) => void)[] = [];

  write(frame: string): Promise<void> {
    const parsed = JSON.parse(frame) as { id: string; method: string; params: unknown };
    this.requests.push(parsed);
    return Promise.resolve();
  }
  onLine(handler: (line: string) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
  onClose(_handler: (reason: string) => void): () => void {
    return () => {};
  }
  close(): void {}

  respond(id: string, payload: unknown): void {
    const line = JSON.stringify({ v: PROTOCOL_VERSION, id, ok: payload });
    for (const handler of [...this.handlers]) handler(line);
  }
  respondErr(id: string, code: string, message: string): void {
    const line = JSON.stringify({ v: PROTOCOL_VERSION, id, err: { code, message } });
    for (const handler of [...this.handlers]) handler(line);
  }
  sendRaw(line: string): void {
    for (const handler of [...this.handlers]) handler(line);
  }
  lastId(): string {
    const last = this.requests[this.requests.length - 1];
    if (!last) throw new Error("no request was sent");
    return last.id;
  }
}

let core: FakeCore;
let client: CoreClient;

beforeEach(() => {
  core = new FakeCore();
  client = new CoreClient(core.transport);
});

afterEach(() => {
  client.close();
  vi.useRealTimers();
});

describe("frame envelope", () => {
  it("matches the documented NDJSON shape exactly", () => {
    expect(encodeFrame({ v: PROTOCOL_VERSION, id: "x", method: "system.probe", params: {} })).toBe(
      '{"v":1,"id":"x","method":"system.probe","params":{}}\n',
    );
  });

  it("sends v/id/method/params and camelCase payloads", async () => {
    await client.replayTaskEvents({ taskId: "t1", afterSequence: 7 });
    const sent = core.requests[core.requests.length - 1]!;
    expect(sent).toMatchObject({
      v: 1,
      method: "task.subscribe",
      params: { taskId: "t1", afterSequence: 7 },
    });
    expect(typeof sent.id).toBe("string");
    expect(sent.id.length).toBeGreaterThan(0);
    expect(sent.id.length).toBeLessThanOrEqual(128);
  });
});

describe("request/response correlation", () => {
  it("resolves each caller with its own response when replies arrive out of order", async () => {
    const manual = new ManualTransport();
    const c = new CoreClient(manual, { requestTimeoutMs: 5_000 });
    const first = c.request("project.list", {});
    const second = c.request("system.probe", {});
    expect(manual.requests.map((r) => r.method)).toEqual(["project.list", "system.probe"]);

    // Answer the SECOND request first.
    manual.respond(manual.requests[1]!.id, { projects: "second" });
    manual.respond(manual.requests[0]!.id, []);

    await expect(second).resolves.toEqual({ projects: "second" });
    await expect(first).resolves.toEqual([]);
    expect(c.inFlightCount).toBe(0);
    c.close();
  });

  it("never mixes two concurrent requests even with identical params", async () => {
    const manual = new ManualTransport();
    const c = new CoreClient(manual);
    const a = c.request("project.list", {});
    const b = c.request("project.list", {});
    const ids = manual.requests.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    manual.respond(ids[1]!, ["b"]);
    manual.respond(ids[0]!, ["a"]);
    expect(await a).toEqual(["a"]);
    expect(await b).toEqual(["b"]);
    c.close();
  });

  it("rejects with the structured core error code", async () => {
    await expect(client.request("sandbox.list", {})).rejects.toMatchObject({
      source: "core",
      code: "NOT_INSTALLED",
      isCoreError: true,
    });
  });

  it("refuses a method outside the allowlist without writing anything", async () => {
    const before = core.requestCount;
    await expect(client.request("shell.exec" as never, {})).rejects.toBeInstanceOf(
      CoreRequestError,
    );
    await expect(client.request("shell.exec" as never, {})).rejects.toMatchObject({
      code: "METHOD_NOT_ALLOWED",
      source: "client",
    });
    expect(core.requestCount).toBe(before);
  });

  it("rejects a request whose frame would exceed the cap", async () => {
    await expect(
      client.request("conversation.send", {
        conversationId: "c",
        content: "x".repeat(5 * 1024 * 1024),
      }),
    ).rejects.toMatchObject({ code: "FRAME_TOO_LARGE" });
  });

  it("ignores a stray response and counts it", async () => {
    const manual = new ManualTransport();
    const c = new CoreClient(manual);
    const inflight = c.request("project.list", {});
    manual.sendRaw('{"v":1,"id":"nobody-waits-for-me","ok":1}');
    expect(c.orphanResponseCount).toBe(1);
    manual.respond(manual.lastId(), []);
    await expect(inflight).resolves.toEqual([]);
    c.close();
  });

  it("fails in-flight requests when the transport closes", async () => {
    const hanging = new FakeCore({ dropFirstRequests: 1 });
    const c = new CoreClient(hanging.transport, { requestTimeoutMs: 60_000 });
    const inflight = c.request("project.list", {});
    c.close();
    await expect(inflight).rejects.toMatchObject({ code: "TRANSPORT_CLOSED" });
  });

  it("refuses to send after close", async () => {
    const c = new CoreClient(new FakeCore().transport);
    c.close();
    await expect(c.request("project.list", {})).rejects.toMatchObject({
      code: "TRANSPORT_CLOSED",
    });
  });
});

describe("probe and negotiation", () => {
  it("never throws: an unreachable Core is an outcome", async () => {
    const outcome = await client.probe();
    expect(outcome.kind).toBe("attached");
    if (outcome.kind === "attached") {
      expect(outcome.capabilities.coreVersion).toBe("0.1.0");
      expect(outcome.capabilities.sbx?.installed).toBe(false);
      expect(outcome.capabilities.agents[0]?.verified).toBe(false);
    }
  });

  it("reports a transport failure as an unreachable client-code outcome", async () => {
    const outcome = await new CoreClient({
      kind: "memory",
      write: () => Promise.reject(new Error("socket is closed")),
      onLine: () => () => {},
      onClose: () => () => {},
      close: () => {},
    }).probe();
    expect(outcome.kind).toBe("unreachable");
    if (outcome.kind === "unreachable") {
      expect(outcome.error.source).toBe("client");
      expect(outcome.error.code).toBe("TRANSPORT_UNAVAILABLE");
    }
  });

  it("detects a protocol version mismatch instead of proceeding", async () => {
    const manual = new ManualTransport();
    const c = new CoreClient(manual);
    const inflight = c.probe();
    manual.respond(manual.lastId(), {
      protocolVersion: 2,
      coreVersion: "9.9.9",
      instanceId: "i",
      agents: [],
      platform: "linux",
      sbx: null,
    });
    await expect(inflight).resolves.toEqual({
      kind: "version_mismatch",
      coreProtocolVersion: 2,
    });
    c.close();
  });

  it("treats a response payload that does not match the schema as unreachable", async () => {
    const manual = new ManualTransport();
    const c = new CoreClient(manual);
    const inflight = c.probe();
    manual.respond(manual.lastId(), { coreVersion: "0.1.0" }); // missing fields
    const outcome = await inflight;
    expect(outcome.kind).toBe("unreachable");
    if (outcome.kind === "unreachable") {
      expect(outcome.error.code).toBe("MALFORMED_FRAME");
    }
    c.close();
  });

  it("fails the owning request when its response frame is malformed", async () => {
    const manual = new ManualTransport();
    const c = new CoreClient(manual);
    const inflight = c.request("project.list", {});
    const id = manual.lastId();
    // Structurally parseable and carries the id, but has neither ok nor err.
    manual.sendRaw(`{"v":1,"id":"${id}"}`);
    await expect(inflight).rejects.toMatchObject({
      code: "MALFORMED_FRAME",
      source: "client",
    });
    expect(c.inFlightCount).toBe(0);
    c.close();
  });
});

describe("timeouts", () => {
  it("gives up on a Core that stops answering", async () => {
    vi.useFakeTimers();
    const silent = new FakeCore({ dropFirstRequests: 1 });
    const c = new CoreClient(silent.transport, { requestTimeoutMs: 50 });
    const inflight = c.request("project.list", {});
    let settled: unknown = null;
    inflight.catch((err: unknown) => {
      settled = err;
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(settled).toMatchObject({ code: "TIMEOUT", source: "client" });
    c.close();
  });
});

describe("task.subscribe replay", () => {
  it("asks for everything after the checkpoint", async () => {
    core.appendEvents([ev("t1", 1), ev("t1", 2), ev("t1", 3)]);
    const events = await client.replayTaskEvents({ taskId: "t1", afterSequence: 2 });
    expect(events.map((e) => e.sequence)).toEqual([3]);
  });

  it("replays a whole scope when no task id is given", async () => {
    core.appendEvents([ev("t1", 1), ev("t2", 1)]);
    expect(await client.replayTaskEvents({ afterSequence: 0 })).toHaveLength(2);
  });

  it("rejects a task event that violates the schema minimum", async () => {
    const manual = new ManualTransport();
    const c = new CoreClient(manual);
    const inflight = c.replayTaskEvents({ afterSequence: 0 });
    manual.sendRaw(
      JSON.stringify({
        v: 1,
        id: manual.lastId(),
        ok: [{ taskId: "t", sequence: 0, kind: "x", payload: {}, timestamp: "t" }],
      }),
    );
    await expect(inflight).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    c.close();
  });
});

describe("TaskSubscription", () => {
  it("delivers each event once and advances the checkpoint", async () => {
    core.appendEvents([ev("t1", 1), ev("t1", 2)]);
    const seen: number[] = [];
    const sub = client.subscribeTasks({
      taskId: "t1",
      onEvents: (events) => seen.push(...events.map((e) => e.sequence)),
      pollIntervalMs: 5_000,
    });
    await sub.currentPass();
    expect(seen).toEqual([1, 2]);
    expect(sub.lastSequence("t1")).toBe(2);
    sub.stop();

    // Reconnect from the checkpoint: only the new event arrives.
    core.appendEvents([ev("t1", 3)]);
    const after = sub.lastSequence("t1") ?? 0;
    const resumed = client.subscribeTasks({
      taskId: "t1",
      afterSequence: after,
      onEvents: (events) => seen.push(...events.map((e) => e.sequence)),
      pollIntervalMs: 5_000,
    });
    await resumed.currentPass();
    expect(seen).toEqual([1, 2, 3]);
    resumed.stop();
  });

  it("re-delivers nothing when a pass overlaps the checkpoint", async () => {
    core.appendEvents([ev("t1", 1), ev("t1", 2)]);
    const seen: number[] = [];
    const sub = client.subscribeTasks({
      taskId: "t1",
      onEvents: (events) => seen.push(...events.map((e) => e.sequence)),
      pollIntervalMs: 5_000,
    });
    await sub.currentPass();
    await sub.currentPass();
    expect(seen).toEqual([1, 2]);
    sub.stop();
  });

  it("reports a gap instead of implying continuity", async () => {
    const manual = new ManualTransport();
    const c = new CoreClient(manual);
    const gaps: { from: number; to: number }[] = [];
    const sub = c.subscribeTasks({
      taskId: "t1",
      afterSequence: 1,
      onEvents: () => {},
      onGap: (info) => gaps.push({ from: info.from, to: info.to }),
      pollIntervalMs: 5_000,
    });
    manual.sendRaw(
      JSON.stringify({
        v: 1,
        id: manual.lastId(),
        ok: [
          { taskId: "t1", sequence: 5, kind: "status.changed", payload: { to: "running" }, timestamp: "t" },
        ],
      }),
    );
    await sub.currentPass();
    expect(gaps).toEqual([{ from: 1, to: 5 }]);
    expect(sub.lastSequence("t1")).toBe(5);
    sub.stop();
    c.close();
  });

  it("backs off and reports errors instead of spinning", async () => {
    core.failNextWith(1);
    const errors: CoreRequestError[] = [];
    const sub = client.subscribeTasks({
      taskId: "t1",
      onEvents: () => {},
      onError: (err) => errors.push(err),
      pollIntervalMs: 5_000,
    });
    await sub.currentPass();
    expect(errors[0]).toMatchObject({ code: "DAEMON_DOWN" });
    expect(sub.state.kind).toBe("backoff");
    if (sub.state.kind === "backoff") expect(sub.state.attempt).toBe(1);
    sub.stop();
  });

  it("stops on stop() and resumes from its checkpoint", async () => {
    core.appendEvents([ev("t1", 1)]);
    let delivered = 0;
    const sub = client.subscribeTasks({
      taskId: "t1",
      onEvents: (events) => {
        delivered += events.length;
      },
      pollIntervalMs: 5_000,
    });
    await sub.currentPass();
    expect(delivered).toBe(1);
    sub.stop();
    expect(sub.state).toEqual({ kind: "stopped" });

    core.appendEvents([ev("t1", 2)]);
    sub.resume();
    await sub.currentPass();
    expect(delivered).toBe(2);
    sub.stop();
  });

  it("is a TaskSubscription and holds no checkpoint for an unseen task", () => {
    const sub = client.subscribeTasks({ taskId: "z", onEvents: () => {} });
    expect(sub).toBeInstanceOf(TaskSubscription);
    expect(sub.lastSequence("nope")).toBeUndefined();
    sub.stop();
    expect(sub.state).toEqual({ kind: "stopped" });
  });
});
