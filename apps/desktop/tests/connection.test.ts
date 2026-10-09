import { describe, expect, it } from "vitest";
import {
  describeCoreError,
  foldAgentView,
  foldCoreLink,
  foldSbxView,
  type CoreLinkState,
} from "../src/lib/reducers";
import { CoreRequestError, type ProbeOutcome } from "../src/lib/core-client";
import type { AgentCapability, CoreCapabilities } from "../src/lib/protocol";

const capabilities: CoreCapabilities = {
  protocolVersion: 1,
  coreVersion: "0.1.0",
  instanceId: "instance-1",
  sbx: { installed: false, binaryPath: null, version: null, daemonRunning: null },
  agents: [
    {
      id: "codex",
      verified: false,
      supportsStreaming: true,
      supportsCancel: true,
      supportsResume: false,
    },
  ],
  platform: "macos",
};

const attached: ProbeOutcome = { kind: "attached", capabilities };

function link(outcome: ProbeOutcome | null, options: Partial<Parameters<typeof foldCoreLink>[1]> = {}): CoreLinkState {
  return foldCoreLink(outcome, {
    now: 1_000,
    transportAvailable: true,
    ...options,
  });
}

describe("foldCoreLink", () => {
  it("reports attached only from a successful probe", () => {
    const state = link(attached);
    expect(state.kind).toBe("attached");
    if (state.kind === "attached") {
      expect(state.stale).toBe(false);
      expect(state.capabilities.instanceId).toBe("instance-1");
    }
  });

  it("marks an unreachable Core as stale and keeps the last good data labelled", () => {
    const error = new CoreRequestError("client", "TRANSPORT_CLOSED", "socket closed");
    const state = link(
      { kind: "unreachable", error },
      {
        previous: { kind: "attached", capabilities, asOf: 900, stale: false },
      },
    );
    expect(state.kind).toBe("unreachable");
    if (state.kind === "unreachable") {
      expect(state.stale).toBe(true);
      expect(state.cached?.coreVersion).toBe("0.1.0");
      expect(state.cachedAsOf).toBe(900);
    }
  });

  it("never turns an absent transport into an attached state", () => {
    const state = link(attached, { transportAvailable: false });
    expect(state.kind).toBe("unreachable");
    if (state.kind === "unreachable") {
      expect(state.code).toBe("TRANSPORT_UNAVAILABLE");
      expect(state.cached).toBeNull();
    }
  });

  it("keeps a protocol mismatch distinct from an offline Core", () => {
    const state = link({ kind: "version_mismatch", coreProtocolVersion: 2 });
    expect(state).toMatchObject({ kind: "version_mismatch", coreProtocolVersion: 2 });
  });

  it("shows an in-flight probe as attaching, not as connected", () => {
    expect(link(null).kind).toBe("attaching");
  });

  it("carries a client-side error code through when Core answers with err", () => {
    const err = new CoreRequestError("core", "NOT_INSTALLED", "sbx executable not found");
    const state = link({ kind: "unreachable", error: err });
    expect(state.kind === "unreachable" && state.code).toBe("NOT_INSTALLED");
  });
});

describe("foldSbxView", () => {
  it("distinguishes not-installed from unprobed", () => {
    expect(foldSbxView(null).kind).toBe("unprobed");
    expect(foldSbxView({ ...capabilities, sbx: null }).kind).toBe("unprobed");
    expect(foldSbxView(capabilities).kind).toBe("not_installed");
  });

  it("does not call a located-but-unprobed binary ready", () => {
    const view = foldSbxView({
      ...capabilities,
      sbx: { installed: true, binaryPath: "/usr/local/bin/sbx", version: null, daemonRunning: null },
    });
    expect(view.kind).toBe("installed_daemon_unknown");
    expect(view.tone).toBe("attention");
    expect(view.label).toContain("daemon not probed");
  });

  it("reports daemon_down separately from not_installed", () => {
    const view = foldSbxView({
      ...capabilities,
      sbx: { installed: true, binaryPath: "/x", version: "0.9", daemonRunning: false },
    });
    expect(view.kind).toBe("daemon_down");
    expect(view.tone).toBe("danger");
  });

  it("only says ready when Core actually probed a running daemon", () => {
    const view = foldSbxView({
      ...capabilities,
      sbx: { installed: true, binaryPath: "/x", version: "0.9", daemonRunning: true },
    });
    expect(view.kind).toBe("ready");
  });
});

describe("foldAgentView", () => {
  const cap: AgentCapability = {
    id: "codex",
    verified: false,
    supportsStreaming: true,
    supportsCancel: false,
    supportsResume: false,
  };

  it("keeps an unverified adapter unusable", () => {
    const view = foldAgentView(cap);
    expect(view.usable).toBe(false);
    expect(view.resumeLabel).toBe("Resume not verified");
    expect(view.cancelLabel).toBe("Cancel unsupported");
  });

  it("only reports resume when Core advertises it", () => {
    expect(foldAgentView({ ...cap, supportsResume: true }).resumeLabel).toBe(
      "Native session resume verified",
    );
  });
});

describe("describeCoreError", () => {
  it("explains what failed, why, and the next action for a core code", () => {
    const copy = describeCoreError(
      new CoreRequestError("core", "DAEMON_DOWN", "sbx exited 1: cannot connect to daemon"),
    );
    expect(copy.title).toBe("The SBX daemon is not running");
    expect(copy.reason).toContain("cannot connect to daemon");
    expect(copy.action).toMatch(/daemon/i);
    expect(copy.tone).toBe("danger");
  });

  it("separates 'no Core transport' from 'SBX missing'", () => {
    const transport = describeCoreError(
      new CoreRequestError("client", "TRANSPORT_UNAVAILABLE", "not in a Tauri window"),
    );
    const sbx = describeCoreError(new CoreRequestError("core", "NOT_INSTALLED", "sbx not found"));
    expect(transport.title).toBe("No Core transport");
    expect(sbx.title).toBe("Docker SBX is not installed");
    expect(transport.action).toContain("tauri dev");
  });

  it("names an interrupted task as not auto-resumed", () => {
    expect(describeCoreError(new CoreRequestError("core", "TASK_INTERRUPTED", "x")).action).toContain(
      "does not auto-resume",
    );
  });

  it("maps every structured error code", () => {
    const codes = [
      "NOT_INSTALLED",
      "DAEMON_DOWN",
      "UNSUPPORTED_SBX_VERSION",
      "PROVIDER_AUTH_REQUIRED",
      "CONFLICT",
      "TASK_INTERRUPTED",
      "PERMISSION_DENIED",
      "VALIDATION_FAILED",
      "NOT_FOUND",
      "INTERNAL",
    ] as const;
    for (const code of codes) {
      const copy = describeCoreError(new CoreRequestError("core", code, "m"));
      expect(copy.title.length).toBeGreaterThan(3);
      expect(copy.action.length).toBeGreaterThan(3);
    }
  });
});
