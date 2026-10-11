/**
 * The webview ⇄ native-proxy contract (A2–A4).
 *
 * - The proxy's total budget must be SHORTER than the webview's request timeout,
 *   so the webview always hears whether a frame was sent before giving up.
 * - A lost answer to a state-changing method says "may have been applied —
 *   re-read state", never a plain timeout that invites a duplicate.
 * - A Tauri `invoke` rejection is the serialized `ProxyError` object; it must be
 *   decoded, not stringified to "[object Object]".
 *
 * Both ordering and the replay-safe list are read out of the Rust source on
 * disk, so changing either side alone fails here.
 */

import { describe, expect, it, vi } from "vitest";
import {
  CoreClient,
  CoreRequestError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  REPLAY_SAFE_METHODS,
  decodeProxyRejection,
  requestTimeoutFor,
  timeoutError,
  type CoreTransport,
} from "../src/lib/core-client";
import { METHODS } from "../src/lib/protocol";
import { describeCoreError, sanitizeHint } from "../src/lib/reducers";
import { TauriTransport } from "../src/transport/tauri";
import { FakeCore } from "./support/fake-core";
import { desktopProxyRustSource, rustMethodWireName } from "./support/rust-source";

function rustNumber(literal: string): number {
  return Number(literal.replaceAll("_", ""));
}

/** `proxy_deadline_ms(method)` evaluated from the Rust source for every method. */
function rustProxyDeadlines(): Map<string, number> {
  const source = desktopProxyRustSource();
  const constant = /pub const PROXY_DEADLINE_MS: u64 = ([\d_]+);/.exec(source);
  if (!constant) throw new Error("ipc_client.rs has no parseable PROXY_DEADLINE_MS");
  const fn = /pub fn proxy_deadline_ms\(method: Method\) -> u64 \{\s*match method \{([\s\S]*?)\n\s*\}\s*\}/.exec(
    source,
  );
  if (!fn) throw new Error("ipc_client.rs has no parseable proxy_deadline_ms match");
  const arms = [...(fn[1] as string).matchAll(/Method::([A-Z][A-Za-z0-9]*) => ([\d_]+),/g)];
  const fallback = /_ => PROXY_DEADLINE_MS,/.test(fn[1] as string);
  if (arms.length === 0 || !fallback) throw new Error("unexpected proxy_deadline_ms shape");
  const overrides = new Map(
    arms.map((arm) => [rustMethodWireName(arm[1] as string), rustNumber(arm[2] as string)]),
  );
  return new Map(
    METHODS.map((method) => [method, overrides.get(method) ?? rustNumber(constant[1] as string)]),
  );
}

function rustReplaySafeMethods(): string[] {
  const source = desktopProxyRustSource();
  const fn = /fn replay_safe\(method: Method\) -> bool \{\s*matches!\(\s*method,([\s\S]*?)\)\s*\}/.exec(source);
  if (!fn) throw new Error("ipc_client.rs has no parseable replay_safe matches!");
  const variants = [...(fn[1] as string).matchAll(/Method::([A-Z][A-Za-z0-9]*)/g)].map(
    (m) => m[1] as string,
  );
  if (variants.length === 0) throw new Error("replay_safe lists no variants");
  return variants.map(rustMethodWireName);
}

/** A transport whose write rejects exactly like a Tauri invoke of the proxy. */
class RejectingTransport implements CoreTransport {
  readonly kind = "tauri";
  constructor(private readonly rejection: unknown) {}
  write(): Promise<void> {
    return Promise.reject(this.rejection);
  }
  onLine(): () => void {
    return () => {};
  }
  onClose(): () => void {
    return () => {};
  }
  close(): void {}
}

describe("proxy budget vs webview timeout (drift-gated)", () => {
  it("for EVERY method, the Rust proxy gives up before the webview does", () => {
    const proxy = rustProxyDeadlines();
    expect(proxy.size).toBe(METHODS.length);
    for (const method of METHODS) {
      const rust = proxy.get(method) ?? 0;
      const js = requestTimeoutFor(method);
      expect(rust, method).toBeGreaterThan(0);
      // Leave real margin for IPC + scheduling, not a millisecond race.
      expect(js - rust, method).toBeGreaterThanOrEqual(2_000);
    }
  });

  it("long-running Core calls get the documented budgets on both sides", () => {
    const proxy = rustProxyDeadlines();
    expect(proxy.get("sandbox.create")).toBe(320_000);
    expect(requestTimeoutFor("sandbox.create")).toBe(330_000);
    expect(proxy.get("sandbox.list")).toBe(40_000);
    expect(requestTimeoutFor("sandbox.list")).toBe(45_000);
    // A6: git.apply runs inside Core's 41 s apply budget (45 s client deadline).
    expect(proxy.get("git.apply")).toBe(43_000);
    expect(requestTimeoutFor("git.apply")).toBe(45_000);
    // Core's git canonicalization of a repository path may take up to 30 s
    // (project.create and A3a project.add_repository share that path).
    for (const method of ["project.create", "project.add_repository"] as const) {
      expect(proxy.get(method), method).toBe(43_000);
      expect(requestTimeoutFor(method), method).toBe(45_000);
    }
    const c = new CoreClient(new FakeCore().transport);
    expect(c.timeoutFor("sandbox.create")).toBe(330_000);
    expect(c.timeoutFor("project.list")).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    c.close();
  });

  it("the TS replay-safe set is exactly the Rust replay_safe list", () => {
    expect([...REPLAY_SAFE_METHODS].sort()).toEqual(rustReplaySafeMethods().sort());
    for (const method of REPLAY_SAFE_METHODS) expect(METHODS).toContain(method);
  });
});

describe("timeout copy", () => {
  it("a lost answer to a state-changing method says it may have been applied", () => {
    for (const method of ["git.apply", "conversation.send", "sandbox.create", "task.cancel"] as const) {
      const err = timeoutError(method, 15_000);
      expect(err.code).toBe("TIMEOUT");
      expect(err.mayHaveBeenApplied).toBe(true);
      expect(err.message).toContain("may have been applied — re-read state before retrying");
      const copy = describeCoreError(err);
      expect(copy.title).toBe("Outcome unknown — this may have been applied");
      expect(copy.action).toMatch(/^Re-read state first/);
      expect(copy.action).not.toMatch(/^Check that sandpane-service is running, then retry/);
    }
  });

  it("a read-only timeout keeps the plain retry copy", () => {
    const err = timeoutError("task.list", 15_000);
    expect(err.mayHaveBeenApplied).toBe(false);
    expect(err.message).not.toContain("may have been applied");
    expect(describeCoreError(err).title).toBe("Core did not answer in time");
  });

  it("the client's own deadline uses that copy for a mutation", async () => {
    vi.useFakeTimers();
    try {
      const silent = new FakeCore({ dropFirstRequests: 1 });
      // A6 gave git.apply its own 45 s deadline; clear the per-method table so
      // the 50 ms default is the deadline this test exercises.
      const c = new CoreClient(silent.transport, { requestTimeoutMs: 50, methodTimeoutsMs: {} });
      const inflight = c.request("git.apply", { taskId: "t", expectedBase: "b" });
      let settled: unknown = null;
      inflight.catch((err: unknown) => {
        settled = err;
      });
      await vi.advanceTimersByTimeAsync(60);
      expect(settled).toBeInstanceOf(CoreRequestError);
      expect((settled as CoreRequestError).mayHaveBeenApplied).toBe(true);
      expect((settled as CoreRequestError).message).toContain("may have been applied");
      c.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("proxy rejections are decoded, never stringified", () => {
  it("decodes the serialized ProxyError object", () => {
    const decoded = decodeProxyRejection({
      code: "TIMEOUT",
      message: "Core did not answer",
      mayHaveBeenApplied: true,
    });
    expect(decoded.proxyCode).toBe("TIMEOUT");
    expect(decoded.message).toBe("Core did not answer");
    expect(decoded.mayHaveBeenApplied).toBe(true);
    expect(decodeProxyRejection(new Error("boom")).message).toBe("boom");
    expect(decodeProxyRejection("plain").message).toBe("plain");
  });

  it("maps a proxy TIMEOUT after delivery to an outcome-unknown error", async () => {
    const c = new CoreClient(
      new RejectingTransport({
        code: "TIMEOUT",
        message: "Core did not answer git.apply — it may have been applied.",
        mayHaveBeenApplied: true,
      }),
    );
    const err = await c.request("git.apply", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreRequestError);
    const typed = err as CoreRequestError;
    expect(typed.code).toBe("TIMEOUT");
    expect(typed.mayHaveBeenApplied).toBe(true);
    expect(typed.message).not.toContain("[object Object]");
    expect(describeCoreError(typed).title).toBe("Outcome unknown — this may have been applied");
    c.close();
  });

  it("maps CORE_UNREACHABLE and SOCKET_UNTRUSTED to their own copy", async () => {
    const unreachable = new CoreClient(
      new RejectingTransport({ code: "CORE_UNREACHABLE", message: "no Core socket", mayHaveBeenApplied: false }),
    );
    const a = (await unreachable.request("system.probe", {}).catch((e: unknown) => e)) as CoreRequestError;
    expect(a.code).toBe("CORE_UNREACHABLE");
    expect(describeCoreError(a).title).toBe("Core is not running");
    unreachable.close();

    const untrusted = new CoreClient(
      new RejectingTransport({ code: "SOCKET_UNTRUSTED", message: "mode 666", mayHaveBeenApplied: false }),
    );
    const b = (await untrusted.request("system.probe", {}).catch((e: unknown) => e)) as CoreRequestError;
    expect(b.code).toBe("SOCKET_UNTRUSTED");
    expect(describeCoreError(b).title).toBe("Refused an untrusted Core socket");
    untrusted.close();
  });

  it("a lost connection after the write is TRANSPORT_CLOSED, never 'nothing was sent'", async () => {
    const c = new CoreClient(
      new RejectingTransport({ code: "CONNECTION_CLOSED", message: "closed", mayHaveBeenApplied: false }),
    );
    const err = (await c.request("task.list", {}).catch((e: unknown) => e)) as CoreRequestError;
    expect(err.code).toBe("TRANSPORT_CLOSED");
    for (const copy of [describeCoreError(err), describeCoreError(new CoreRequestError("client", "CORE_UNREACHABLE", "x"))]) {
      expect(copy.action).not.toMatch(/nothing was sent/i);
    }
    c.close();
  });

  it("Core's connection-level refusal is reported as not applied", async () => {
    const c = new CoreClient(
      new RejectingTransport({
        code: "CORE_REFUSED_CONNECTION",
        message: "Core refused the connection (PERMISSION_DENIED: peer)",
        mayHaveBeenApplied: false,
      }),
    );
    const err = (await c.request("git.apply", {}).catch((e: unknown) => e)) as CoreRequestError;
    expect(err.code).toBe("CORE_REFUSED_CONNECTION");
    expect(err.mayHaveBeenApplied).toBe(false);
    expect(describeCoreError(err).title).toBe("Core refused this connection");
    c.close();
  });

  it("an unmapped proxy code stays a transport failure that names it", async () => {
    const c = new CoreClient(
      new RejectingTransport({ code: "TRANSPORT_UNSUPPORTED", message: "named pipes are P1", mayHaveBeenApplied: false }),
    );
    const err = (await c.request("system.probe", {}).catch((e: unknown) => e)) as CoreRequestError;
    expect(err.code).toBe("TRANSPORT_UNAVAILABLE");
    expect(err.message).toContain("TRANSPORT_UNSUPPORTED");
    expect(err.message).toContain("named pipes are P1");
    c.close();
  });

  it("TauriTransport surfaces the invoke rejection as a decoded error", async () => {
    const invoke = vi.fn(() =>
      Promise.reject({ code: "RESPONSE_ID_MISMATCH", message: "id differs", mayHaveBeenApplied: true }),
    );
    const transport = new TauriTransport(invoke);
    const c = new CoreClient(transport);
    const err = (await c.request("conversation.send", {}).catch((e: unknown) => e)) as CoreRequestError;
    expect(invoke).toHaveBeenCalledWith("core_request_frame", expect.objectContaining({ line: expect.any(String) }));
    expect(err.code).toBe("MALFORMED_FRAME");
    expect(err.mayHaveBeenApplied).toBe(true);
    c.close();
  });
});

describe("Core's suggested next step (details.hint / details.provider)", () => {
  it("is surfaced as one sanitized line, never executed", () => {
    const err = new CoreRequestError("core", "PROVIDER_AUTH_REQUIRED", "sbx is not logged in", {
      provider: "docker",
      hint: "sbx login",
    });
    const copy = describeCoreError(err);
    expect(copy.hint).toBe("sbx login");
    expect(copy.provider).toBe("docker");
    const policy = describeCoreError(
      new CoreRequestError("core", "PERMISSION_DENIED", "no policy", {
        hint: "sbx policy init <allow-all|balanced|deny-all>",
      }),
    );
    expect(policy.hint).toBe("sbx policy init <allow-all|balanced|deny-all>");
  });

  it("strips control, ANSI and bidi characters, collapses lines and caps length", () => {
    expect(sanitizeHint("sbx login\n; rm -rf ~")).toBe("sbx login ; rm -rf ~");
    expect(sanitizeHint("\u001b[31msbx\u001b[0m login")).toBe("[31msbx [0m login");
    expect(sanitizeHint("sbx \u202elogin")).toBe("sbx login");
    expect(sanitizeHint("   ")).toBeUndefined();
    expect(sanitizeHint(42)).toBeUndefined();
    expect(sanitizeHint("x".repeat(500))?.length).toBe(120);
  });

  it("errors without a hint carry none", () => {
    expect(describeCoreError(new CoreRequestError("core", "CONFLICT", "c")).hint).toBeUndefined();
    expect(
      describeCoreError(new CoreRequestError("core", "CONFLICT", "c", { hint: "\n\t" })).hint,
    ).toBeUndefined();
  });
});
