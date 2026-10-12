/**
 * A7 verification commands + `project.context` on the desktop (design
 * 2026-10-09 §3.7).
 *
 * - drift against the Rust sources read from disk: 34 methods in order, the
 *   `verification` feature (6), the deadlines, the proxy's read-only /
 *   replay-safe classification of the six methods, every Core message the
 *   copy keys on, the caps, the outcome strings and the event kinds;
 * - exact frames for all six methods, with argv elements byte-exact (tab,
 *   newline, quote, non-ASCII, a leading-space element);
 * - the gate, the gesture-only openers (and source pins: no other entry
 *   point), the run's `expected*` values from the BINDING and `sandbox.list`
 *   (never `chosenSandboxName`), single flight, the idempotency key reused
 *   only by Retry safely;
 * - each outcome's copy (exit 0 is never a pass), each disclosure flag, the
 *   frame-refusal / secret-refusal / UNSUPPORTED_SBX_VERSION copy, delete and
 *   stop copy;
 * - SSR rendering with ESC, OSC 8, OSC 52, `<script>` and bidi characters in
 *   output, label, argv and notes: text only, never markup.
 *
 * Core's verification is NOT modeled in FakeCore: frames go through a small
 * scripted transport whose answers are written by hand from the Rust sources
 * (illustrative, never captured from a live Core). Hidden characters are
 * built with `String.fromCodePoint` / `\u` escapes, so no raw invisible
 * character lives in this file.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MutationObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  CoreClient,
  CoreRequestError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  METHOD_TIMEOUT_MS,
  REPLAY_SAFE_METHODS,
  requestTimeoutFor,
  timeoutError,
  type CoreTransport,
  type ProbeOutcome,
} from "../src/lib/core-client";
import {
  decodeProjectContext,
  decodeVerificationList,
  decodeVerificationResult,
  decodeVerificationRunResult,
} from "../src/lib/decode";
import { encodeFrame } from "../src/lib/framing";
import { forNewAction } from "../src/lib/idempotency";
import {
  CORE_EVENT_KINDS,
  FEATURE_VERIFICATION,
  KNOWN_FEATURES,
  MAINTENANCE_METHODS,
  METHODS,
  PROTOCOL_VERSION,
  VERIFICATION_METHODS,
  VERIFICATION_OUTCOMES,
  type CoreCapabilities,
  type VerificationCommand,
  type VerificationResult,
} from "../src/lib/protocol";
import { createQueryClient } from "../src/lib/query-client";
import {
  describeCoreError,
  emptyProjection,
  foldTaskEvents,
  verificationRunsOf,
  verificationsRunningIn,
} from "../src/lib/reducers";
import { STOP_ENDS_VERIFICATION, removalFailureCopy } from "../src/lib/sandbox-lifecycle";
import {
  APPROVE_BINDS_STATEMENT,
  APPROVE_NO_SECRETS,
  DIRECT_MOUNT_RUN_WARNING,
  DISCLOSURE_OUTPUT_INCOMPLETE,
  DISCLOSURE_OUTPUT_WITHHELD,
  HOST_WORKTREE_RUN_WARNING,
  MAX_VERIFICATION_ARGS,
  MAX_VERIFICATION_ARGV_BYTES,
  MAX_VERIFICATION_ARG_BYTES,
  MAX_VERIFICATION_LABEL_CHARS,
  RUN_NOT_BOUND_REASON,
  RUN_STATEMENT,
  RUN_UNVERIFIED_NOTICE,
  argvProblem,
  labelProblem,
  openApproveConfirmation,
  openRunConfirmation,
  outcomeView,
  resultDisclosures,
  revealOutput,
  runBinding,
  runKeyRecheckFromProbe,
  verificationFailureCopy,
  verificationGate,
  type ApproveDraft,
} from "../src/lib/verification";
import {
  ARGV_SHAPE_PREFIX,
  EXEC_UNVERIFIED_PREFIX,
  FRAME_REFUSAL_PREFIX,
  FRAME_REFUSAL_SUFFIX,
  LABEL_REFUSAL_PREFIX,
  MSG_CONVERSATION_VERIFICATION_RUNNING,
  MSG_PROJECT_VERIFICATION_RUNNING,
  MSG_SANDBOX_VERIFICATION_RUNNING,
  MSG_SECRET_CHECK_UNAVAILABLE,
  MSG_VERIFICATION_NOT_BOUND,
  MSG_VERIFICATION_TASK_BUSY,
  MSG_VERSION_UNREADABLE,
  NOTHING_WAS_RUN_SUFFIX,
  NOT_RUNNING_PREFIX,
  NOT_RUNNING_SUFFIX,
  REPO_BUSY_INFIX,
  REPO_BUSY_SUFFIX,
  SECRET_ARGUMENT_INFIX,
  SECRET_ARGUMENT_PREFIX,
  SECRET_COMBINED_PREFIX,
  SECRET_LABEL_PREFIX,
  SECRET_REFUSAL_HINT,
  SECRET_REFUSAL_SUFFIX,
  SHAPE_NO_LONGER_PREFIX,
  SHAPE_NO_LONGER_SUFFIX,
  VERIFICATION_CORE_CONSTS,
  VERIFICATION_SERVICE_CONSTS,
} from "../src/lib/verification-messages";
import {
  runMutationOptions,
  runOutcomeView,
  submitRun,
  type RunMutationState,
  type RunVariables,
} from "../src/lib/verification-mutations";
import { ApproveConfirmDialog, RunConfirmDialog } from "../src/components/verification/VerificationDialogs";
import { OutputBlock } from "../src/components/verification/VerificationText";
import { StopDialog } from "../src/components/sandbox/SandboxLifecycle";
import { A6_CORE_FEATURES, A7_CORE_FEATURES, A7_CORE_METHODS, A9_CORE_METHODS, FakeCore } from "./support/fake-core";
import {
  desktopProxyRustSource,
  protocolRustSource,
  repoFile,
  rustFnFormatTemplates,
  rustFormatTemplate,
  rustMethodAll,
  rustStrConst,
  rustUsizeConst,
  schemaMethodEnum,
  VALIDATION_RUST,
} from "./support/rust-source";

const SERVICE_VERIFICATION_RUST = "core/crates/sandpane-service/src/verification.rs";
const CORE_VERIFICATION_RUST = "core/crates/sandpane-core/src/verification.rs";
const cp = (n: number): string => String.fromCodePoint(n);

const ESC = cp(0x1b);
const BEL = cp(0x07);
const CSI_C1 = cp(0x9b);
const RLO = cp(0x202e);
const LRI = cp(0x2066);
const ZWSP = cp(0x200b);
/** OSC 8 hyperlink and OSC 52 clipboard write, as a terminal would act on them. */
const OSC8 = `${ESC}]8;;https://evil.example/${ESC}\\click me${ESC}]8;;${ESC}\\`;
const OSC52 = `${ESC}]52;c;cm0gLXJmIH4=${BEL}`;
const HOSTILE = `<script>alert(1)</script>${RLO}gnp.exe${LRI}x${ZWSP}${OSC8}${OSC52}${CSI_C1}31m`;

/** argv elements that must travel byte for byte. */
const TAB_EL = "a\tb";
const NEWLINE_EL = "line1\nline2";
const QUOTE_EL = 'say "hi"';
const NON_ASCII_EL = `${cp(0xfc)}ber-${cp(0x65e5)}`;
const LEADING_SPACE_EL = " leading";
const EXACT_ARGV = ["npm", TAB_EL, NEWLINE_EL, QUOTE_EL, NON_ASCII_EL, LEADING_SPACE_EL];

const PROJECT = "p-1";
const COMMAND: VerificationCommand = {
  id: "c-1",
  projectId: PROJECT,
  label: "unit tests",
  argv: ["npm", "run", "test"],
  approvedAt: "2026-10-12T00:00:00Z",
};

type Answer = { ok: unknown } | { err: { code: string; message: string; details?: unknown } } | null;

/** A transport that records every frame and answers from a per-method script. */
class ScriptedCore implements CoreTransport {
  readonly kind = "memory";
  readonly frames: { id: string; method: string; params: Record<string, unknown> }[] = [];
  readonly raw: string[] = [];
  private listeners: ((line: string) => void)[] = [];
  answers: Record<string, Answer> = {};

  write(frame: string): void {
    this.raw.push(frame);
    const request = JSON.parse(frame) as { id: string; method: string; params: Record<string, unknown> };
    this.frames.push(request);
    const answer = this.answers[request.method];
    if (answer === undefined || answer === null) return;
    const line = encodeFrame({ v: PROTOCOL_VERSION, id: request.id, ...answer }).trimEnd();
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

const trusted = { nativeEvent: { isTrusted: true } };
const coreErr = (code: string, message: string, details?: unknown, method?: string) =>
  new CoreRequestError("core", code as never, message, details, method as never);

function wireResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "r-1",
    taskId: "t1",
    commandId: "c-1",
    label: "unit tests",
    argv: ["npm", "run", "test"],
    sandbox: "atlas-demo",
    workspaceMode: "direct_mount",
    outcome: "exited",
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    redactions: { bestEffort: true, replacements: 0, byKind: {} },
    elapsedMs: 120,
    startedAt: "2026-10-12T00:00:00Z",
    finishedAt: "2026-10-12T00:00:01Z",
    ...over,
  };
}

function caps(methods: readonly string[], features: readonly string[]): Pick<CoreCapabilities, "methods" | "features"> {
  return { methods: [...methods], features: [...features] };
}

const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

describe("A7 drift against the Rust sources", () => {
  it("36 methods in Method::ALL order; the six sit right after git.apply", () => {
    const all = rustMethodAll();
    expect(all.declaredLength).toBe(36);
    expect([...METHODS]).toEqual(all.names);
    expect(schemaMethodEnum()).toEqual(all.names);
    const at = METHODS.indexOf("git.apply");
    expect(METHODS.slice(at + 1)).toEqual([...VERIFICATION_METHODS, ...MAINTENANCE_METHODS]);
    expect([...VERIFICATION_METHODS]).toEqual([
      "verification.list",
      "verification.approve",
      "verification.revoke",
      "verification.run",
      "verification.result",
      "project.context",
    ]);
    expect([...A9_CORE_METHODS]).toEqual([...METHODS]);
  });

  it("verification is the 6th known feature, in Rust FEATURES order", () => {
    const rust = /pub const FEATURES: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(protocolRustSource());
    const names = [...((rust?.[2] ?? "").matchAll(/"([^"]+)"/g))].map((m) => m[1]);
    expect(Number(rust?.[1])).toBe(7);
    expect([...KNOWN_FEATURES]).toEqual(names);
    expect(KNOWN_FEATURES[5]).toBe(FEATURE_VERIFICATION);
    expect(FEATURE_VERIFICATION).toBe("verification");
    // A9 added `maintenance` as the 7th; the A7 features are unchanged.
    expect(names.slice(0, 6)).toEqual(A7_CORE_FEATURES.filter((f) => f !== "some-future-feature"));
    expect(names[6]).toBe("maintenance");
  });

  it("deadlines: project.context and verification.run get the git deadline (webview 45 000, proxy 43 000); list, approve, revoke and result the default", () => {
    const body =
      /pub fn proxy_deadline_ms\(method: Method\) -> u64 \{([\s\S]*?)\n\}/.exec(desktopProxyRustSource())?.[1] ?? "";
    for (const [m, v] of [
      ["project.context", "ProjectContext"],
      ["verification.run", "VerificationRun"],
    ] as const) {
      expect(METHOD_TIMEOUT_MS[m], m).toBe(45_000);
      expect(requestTimeoutFor(m), m).toBe(45_000);
      expect(body, v).toMatch(new RegExp(`Method::${v} => 43_000`));
      // The proxy's own pin tests exist beside the code.
      expect(desktopProxyRustSource()).toContain(`assert_eq!(proxy_deadline_ms(Method::${v}), 43_000);`);
    }
    for (const m of ["verification.list", "verification.approve", "verification.revoke", "verification.result"] as const) {
      expect(requestTimeoutFor(m), m).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    }
    for (const v of ["VerificationList", "VerificationApprove", "VerificationRevoke", "VerificationResult"]) {
      expect(body, v).not.toContain(`Method::${v}`);
    }
  });

  it("verification.run's budget covers Core's synchronous gates (PROBE + QUERY, read from process.rs) before the durable start", () => {
    const processRs = repoFile("core/crates/sandpane-core/src/process.rs");
    const limitSecs = (name: string): number => {
      const m = new RegExp(`pub const ${name}: RunLimits = RunLimits \\{\\s*timeout: Duration::from_secs\\((\\d+)\\)`).exec(processRs);
      expect(m, name).not.toBeNull();
      return Number(m?.[1]);
    };
    const gatesMs = (limitSecs("PROBE") + limitSecs("QUERY")) * 1000;
    // The service wires those limits and runs both gates before building the exec.
    const lib = repoFile("core/crates/sandpane-service/src/lib.rs");
    expect(lib).toContain("probe: RunLimits::PROBE,");
    expect(lib).toContain("query: RunLimits::QUERY,");
    const service = repoFile(SERVICE_VERIFICATION_RUST);
    expect(service).toContain(".run_in(ctx, &inner.sbx_limits.probe)");
    expect(service).toContain(".run_in(ctx, &inner.sbx_limits.query)");
    const versionGate = service.indexOf("version_gate(inner, &program, &ctx)?;");
    const identityGate = service.indexOf("identity_gate(inner, &program, &ctx, &plan)?;");
    const exec = service.indexOf("SbxCommandBuilder::exec(&program, &plan.sandbox_name, &plan.argv)");
    expect(versionGate).toBeGreaterThan(-1);
    expect(identityGate).toBeGreaterThan(versionGate);
    expect(exec).toBeGreaterThan(identityGate);

    const body =
      /pub fn proxy_deadline_ms\(method: Method\) -> u64 \{([\s\S]*?)\n\}/.exec(desktopProxyRustSource())?.[1] ?? "";
    const proxyMs = Number(/Method::VerificationRun => (\d+)_(\d+)/.exec(body)?.slice(1).join("") ?? "0");
    const defaultProxyMs = Number(/pub const PROXY_DEADLINE_MS: u64 = (\d+)_(\d+);/.exec(desktopProxyRustSource())?.slice(1).join("") ?? "0");
    expect(defaultProxyMs).toBeLessThan(gatesMs); // why the default was wrong
    expect(proxyMs).toBeGreaterThan(gatesMs);
    expect(requestTimeoutFor("verification.run")).toBeGreaterThan(proxyMs);
    expect(desktopProxyRustSource()).toContain("fn verification_run_budget_covers_cores_synchronous_gates()");
  });

  it("proxy classification: list/result/context read-only, approve/revoke/run writes, none replay-safe — on both sides", () => {
    const proxy = desktopProxyRustSource();
    const replay = /fn replay_safe\(method: Method\) -> bool \{([\s\S]*?)\n\}/.exec(proxy)?.[1] ?? "";
    const readOnly = /fn is_read_only\(method: Method\) -> bool \{([\s\S]*?)\n\}/.exec(proxy)?.[1] ?? "";
    const trueArm = readOnly.slice(0, readOnly.indexOf("=> true"));
    const falseArm = readOnly.slice(readOnly.indexOf("=> true"));
    for (const v of ["VerificationList", "VerificationResult", "ProjectContext"]) {
      expect(trueArm, v).toContain(`Method::${v}`);
      expect(falseArm, v).not.toContain(`Method::${v}`);
    }
    for (const v of ["VerificationApprove", "VerificationRevoke", "VerificationRun"]) {
      expect(falseArm, v).toContain(`Method::${v}`);
      expect(trueArm, v).not.toContain(`Method::${v}`);
    }
    for (const m of VERIFICATION_METHODS) {
      expect(REPLAY_SAFE_METHODS.has(m), m).toBe(false);
    }
    for (const v of ["Verification", "ProjectContext"]) expect(replay, v).not.toContain(v);
    expect(proxy).toContain("fn a7_writes_keep_the_suffix_and_a7_reads_never_get_it()");
    // The webview's own lost-answer copy for a run says "may have been applied".
    expect(timeoutError("verification.run", 15_000).mayHaveBeenApplied).toBe(true);
  });

  it("every whole message the copy keys on is Core's constant", () => {
    for (const [name, value] of Object.entries(VERIFICATION_SERVICE_CONSTS)) {
      expect(rustStrConst(SERVICE_VERIFICATION_RUST, name), name).toBe(value);
    }
    for (const [name, value] of Object.entries(VERIFICATION_CORE_CONSTS)) {
      expect(rustStrConst(CORE_VERIFICATION_RUST, name), name).toBe(value);
    }
    // The lifecycle refusals are re-exported by the service crate root.
    expect(repoFile("core/crates/sandpane-service/src/lib.rs")).toContain("MSG_PROJECT_VERIFICATION_RUNNING");
  });

  it("every fixed fragment of a format! message is in Core's template", () => {
    const t = (fn: string) => rustFormatTemplate(SERVICE_VERIFICATION_RUST, fn);
    expect(t("msg_exec_unverified").startsWith(EXEC_UNVERIFIED_PREFIX)).toBe(true);
    expect(t("msg_exec_unverified").endsWith(NOTHING_WAS_RUN_SUFFIX)).toBe(true);
    expect(t("msg_sandbox_not_running").startsWith(NOT_RUNNING_PREFIX)).toBe(true);
    expect(t("msg_sandbox_not_running").endsWith(NOT_RUNNING_SUFFIX)).toBe(true);
    expect(t("msg_verification_repo_busy")).toContain(REPO_BUSY_INFIX);
    expect(t("msg_verification_repo_busy").endsWith(REPO_BUSY_SUFFIX)).toBe(true);
    expect(t("msg_command_shape_no_longer_passes").startsWith(SHAPE_NO_LONGER_PREFIX)).toBe(true);
    expect(t("msg_command_shape_no_longer_passes").endsWith(SHAPE_NO_LONGER_SUFFIX)).toBe(true);
    const [frame] = rustFnFormatTemplates(SERVICE_VERIFICATION_RUST, "frame_refusal");
    expect(frame?.startsWith(FRAME_REFUSAL_PREFIX)).toBe(true);
    expect(frame?.endsWith(FRAME_REFUSAL_SUFFIX)).toBe(true);
    const secret = rustFnFormatTemplates(CORE_VERIFICATION_RUST, "message");
    expect(secret).toHaveLength(3);
    expect(secret[0]?.startsWith(SECRET_ARGUMENT_PREFIX)).toBe(true);
    expect(secret[0]).toContain(SECRET_ARGUMENT_INFIX);
    expect(secret[1]?.startsWith(SECRET_LABEL_PREFIX)).toBe(true);
    expect(secret[2]?.startsWith(SECRET_COMBINED_PREFIX)).toBe(true);
    for (const s of secret) expect(s.endsWith(SECRET_REFUSAL_SUFFIX)).toBe(true);
    // The approve shape / label prefixes: `invalid(format!("argv: {e}"))` over
    // `#[error("value has an invalid shape: {reason}")]`.
    const service = repoFile(SERVICE_VERIFICATION_RUST);
    expect(service).toContain('format!("argv: {e}")');
    expect(service).toContain('format!("label: {e}")');
    expect(repoFile(VALIDATION_RUST)).toContain('#[error("value has an invalid shape: {reason}")]');
    expect(ARGV_SHAPE_PREFIX).toBe("argv: value has an invalid shape: ");
    expect(LABEL_REFUSAL_PREFIX).toBe("label: ");
  });

  it("the caps the early feedback mirrors are Core's", () => {
    expect(rustUsizeConst(VALIDATION_RUST, "MAX_VERIFICATION_LABEL_CHARS")).toBe(MAX_VERIFICATION_LABEL_CHARS);
    expect(rustUsizeConst(VALIDATION_RUST, "MAX_VERIFICATION_ARGS")).toBe(MAX_VERIFICATION_ARGS);
    expect(rustUsizeConst(VALIDATION_RUST, "MAX_VERIFICATION_ARG_BYTES")).toBe(MAX_VERIFICATION_ARG_BYTES);
    expect(repoFile(VALIDATION_RUST)).toContain("pub const MAX_VERIFICATION_ARGV_BYTES: usize = 16 * 1024;");
    expect(MAX_VERIFICATION_ARGV_BYTES).toBe(16 * 1024);
  });

  it("the outcome strings and the two event kinds are Core's", () => {
    const outcomes = [...repoFile(CORE_VERIFICATION_RUST).matchAll(/pub const OUTCOME_[A-Z_]+: &str = "([a-z_]+)";/g)].map(
      (m) => m[1],
    );
    expect(outcomes).toEqual([...VERIFICATION_OUTCOMES]);
    for (const name of ["EVENT_VERIFICATION_STARTED", "EVENT_VERIFICATION_FINISHED"]) {
      expect(CORE_EVENT_KINDS as readonly string[]).toContain(rustStrConst(SERVICE_VERIFICATION_RUST, name));
    }
  });
});

// ---------------------------------------------------------------------------
// Frames and decoding
// ---------------------------------------------------------------------------

describe("exact frames for the six methods", () => {
  it("verification.list and project.context send exactly {projectId}", async () => {
    const core = new ScriptedCore();
    core.answers["verification.list"] = { ok: { commands: [] } };
    core.answers["project.context"] = { ok: { repositories: [], approved: [] } };
    const client = new CoreClient(core);
    expect(await client.listVerificationCommands(PROJECT)).toEqual([]);
    expect(await client.getProjectContext(PROJECT)).toEqual({ repositories: [], approved: [] });
    expect(core.frames.map((f) => [f.method, f.params])).toEqual([
      ["verification.list", { projectId: PROJECT }],
      ["project.context", { projectId: PROJECT }],
    ]);
  });

  it("verification.approve sends {projectId, label, argv} with every argv element byte-exact", async () => {
    const core = new ScriptedCore();
    core.answers["verification.approve"] = { ok: { command: { ...COMMAND, argv: EXACT_ARGV } } };
    const client = new CoreClient(core);
    const approved = await client.approveVerificationCommand({ projectId: PROJECT, label: "  odd  ", argv: EXACT_ARGV });
    expect(approved.argv).toEqual(EXACT_ARGV);
    const [frame] = core.frames;
    expect(frame?.method).toBe("verification.approve");
    expect(Object.keys(frame?.params ?? {})).toEqual(["projectId", "label", "argv"]);
    // Nothing trimmed, split or joined: the label is Core's to trim.
    expect(frame?.params).toEqual({ projectId: PROJECT, label: "  odd  ", argv: EXACT_ARGV });
    // On the wire: JSON escapes, the leading space and the non-ASCII intact.
    expect(core.raw[0]).toContain('"a\\tb"');
    expect(core.raw[0]).toContain('"line1\\nline2"');
    expect(core.raw[0]).toContain('"say \\"hi\\""');
    expect(core.raw[0]).toContain(`"${NON_ASCII_EL}"`);
    expect(core.raw[0]).toContain('" leading"');
  });

  it("verification.revoke {commandId}, verification.result {runId}", async () => {
    const core = new ScriptedCore();
    core.answers["verification.revoke"] = { ok: { revoked: true } };
    core.answers["verification.result"] = { ok: wireResult() };
    const client = new CoreClient(core);
    expect(await client.revokeVerificationCommand("c-1")).toEqual({ revoked: true });
    expect((await client.getVerificationResult("r-1")).runId).toBe("r-1");
    expect(core.frames.map((f) => [f.method, f.params])).toEqual([
      ["verification.revoke", { commandId: "c-1" }],
      ["verification.result", { runId: "r-1" }],
    ]);
  });

  it("verification.run sends {taskId, commandId, expectedSandboxName, expectedWorkspaceMode, idempotencyKey} in Core's order", async () => {
    const core = new ScriptedCore();
    core.answers["verification.run"] = { ok: { runId: "r-1", startedSequence: 7 } };
    const client = new CoreClient(core);
    const params = forNewAction(
      { taskId: "t1", commandId: "c-1", expectedSandboxName: "atlas-demo", expectedWorkspaceMode: "direct_mount" as const },
      true,
    );
    expect(await client.runVerification(params)).toEqual({ runId: "r-1", startedSequence: 7 });
    const [frame] = core.frames;
    expect(Object.keys(frame?.params ?? {})).toEqual([
      "taskId",
      "commandId",
      "expectedSandboxName",
      "expectedWorkspaceMode",
      "idempotencyKey",
    ]);
    expect(frame?.params.idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
    // Never argv, never a path.
    expect(core.raw[0]).not.toContain("argv");
    // Without advertised keys, no key at all.
    await client.runVerification(
      forNewAction({ taskId: "t1", commandId: "c-1", expectedSandboxName: "atlas-demo", expectedWorkspaceMode: "sbx_clone" as const }, false),
    );
    expect(Object.keys(core.frames[1]?.params ?? {})).not.toContain("idempotencyKey");
  });

  it("a refused build writes NO frame", async () => {
    const core = new ScriptedCore();
    const client = new CoreClient(core);
    for (const p of [
      client.listVerificationCommands(""),
      client.getProjectContext(""),
      client.revokeVerificationCommand(""),
      client.getVerificationResult(""),
      client.runVerification({ taskId: "t1", commandId: "c-1", expectedSandboxName: "", expectedWorkspaceMode: "direct_mount" }),
      client.runVerification({
        taskId: "t1",
        commandId: "c-1",
        expectedSandboxName: "atlas-demo",
        expectedWorkspaceMode: "direct_mount",
        idempotencyKey: "has space",
      }),
    ]) {
      const e = await failure(p);
      expect(e.source).toBe("client");
      expect(e.code).toBe("INVALID_PARAMS");
    }
    expect(core.frames).toHaveLength(0);
  });

  it("decoders tolerate absent optional fields and keep open strings; errors never echo values", () => {
    const minimal = wireResult({ outcome: "running", exitCode: undefined, elapsedMs: undefined, finishedAt: undefined });
    const decoded = decodeVerificationResult(minimal);
    expect(decoded.outcome).toBe("running");
    expect("exitCode" in decoded).toBe(false);
    expect("elapsedMs" in decoded).toBe(false);
    expect("finishedAt" in decoded).toBe(false);
    expect("outputIncomplete" in decoded).toBe(false);
    expect("outputWithheld" in decoded.redactions).toBe(false);
    expect(decodeVerificationResult(wireResult({ outcome: "future_outcome" })).outcome).toBe("future_outcome");
    expect(decodeVerificationResult(wireResult({ workspaceMode: "future_mode" })).workspaceMode).toBe("future_mode");
    const full = decodeVerificationResult(
      wireResult({ outputIncomplete: true, redactions: { bestEffort: true, replacements: 2, byKind: { token: 2 }, outputWithheld: true } }),
    );
    expect(full.outputIncomplete).toBe(true);
    expect(full.redactions).toEqual({ bestEffort: true, replacements: 2, byKind: { token: 2 }, outputWithheld: true });
    expect(decodeVerificationRunResult({ runId: "r", startedSequence: 3, replayed: true })).toEqual({
      runId: "r",
      startedSequence: 3,
      replayed: true,
    });
    expect(decodeVerificationRunResult({ runId: "r", startedSequence: 3, replayed: "yes" }).replayedUncertain).toBe(true);
    expect(decodeVerificationList({ commands: [{ ...COMMAND, argv: EXACT_ARGV }] })[0]?.argv).toEqual(EXACT_ARGV);
    expect(
      decodeProjectContext({
        repositories: [{ repoPath: "/r", detected: [{ manifest: "package.json", suggestedCommands: [["npm", "run", "test"]], notes: ["n"] }], unreadable: ["."] }],
        approved: [COMMAND],
      }).repositories[0]?.detected[0]?.suggestedCommands,
    ).toEqual([["npm", "run", "test"]]);
    const secret = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    for (const bad of [
      wireResult({ stdout: { secret } }),
      wireResult({ argv: [secret, 7] }),
      wireResult({ label: [secret] }),
    ]) {
      let message = "";
      try {
        decodeVerificationResult(bad);
      } catch (err) {
        message = String(err);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
    }
  });

  it("an unreadable approve or run answer may have applied (run: may have started, keyed)", async () => {
    const core = new ScriptedCore();
    core.answers["verification.approve"] = { ok: { command: { id: 1 } } };
    core.answers["verification.run"] = { ok: { started: "?" } };
    const client = new CoreClient(core);
    const a = await failure(client.approveVerificationCommand({ projectId: PROJECT, label: "x", argv: ["make"] }));
    expect(a.mayHaveBeenApplied).toBe(true);
    expect(a.method).toBe("verification.approve");
    const r = await failure(
      client.runVerification({ taskId: "t1", commandId: "c-1", expectedSandboxName: "s", expectedWorkspaceMode: "direct_mount", idempotencyKey: "k1" }),
    );
    expect(r.mayHaveBeenApplied).toBe(true);
    expect(r.method).toBe("verification.run");
    const copy = verificationFailureCopy(r, "run");
    expect(copy.title).toBe("Outcome unknown — the run may have started");
    expect(copy.retrySafely).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe("the verification UI is gated on the feature AND the six methods", () => {
  it("unprobed, unsupported, supported", () => {
    expect(verificationGate(null).state).toBe("unprobed");
    expect(verificationGate(caps(METHODS, [])).state).toBe("unsupported");
    expect(verificationGate(caps(METHODS.filter((m) => m !== "project.context"), [FEATURE_VERIFICATION])).state).toBe(
      "unsupported",
    );
    expect(verificationGate(caps([], [FEATURE_VERIFICATION])).state).toBe("unsupported");
    expect(verificationGate(caps(METHODS, [FEATURE_VERIFICATION])).state).toBe("supported");
  });

  it("through a probe: an A6 Core keeps it off, an A7 Core turns it on", async () => {
    const a6 = await new CoreClient(new FakeCore({ advertisedMethods: A7_CORE_METHODS, features: A6_CORE_FEATURES }).transport).probe();
    const a7 = await new CoreClient(new FakeCore({ advertisedMethods: A7_CORE_METHODS, features: A7_CORE_FEATURES }).transport).probe();
    expect(a6.kind === "attached" && verificationGate(a6.capabilities).state).toBe("unsupported");
    expect(a7.kind === "attached" && verificationGate(a7.capabilities).state).toBe("supported");
  });
});

// ---------------------------------------------------------------------------
// Gesture-only openers, no other entry point
// ---------------------------------------------------------------------------

describe("approve and run dialogs open only from a trusted gesture, filled from Core state", () => {
  const draft: ApproveDraft = { projectId: PROJECT, label: "unit tests", argv: EXACT_ARGV, source: { kind: "manual" } };
  const bound = runBinding({ sandboxName: "atlas-demo" }, [{ name: "atlas-demo", workspaceMode: "direct_mount" }], true);

  it("openApproveConfirmation needs a trusted click and a draft Core would accept; argv is copied", () => {
    for (const ev of [null, undefined, {}, { nativeEvent: {} }, { nativeEvent: { isTrusted: false } }]) {
      expect(openApproveConfirmation(ev, draft)).toBeNull();
    }
    const argv = [...EXACT_ARGV];
    const snapshot = openApproveConfirmation(trusted, { ...draft, argv });
    expect(snapshot?.request).toEqual({ projectId: PROJECT, label: "unit tests", argv: EXACT_ARGV });
    argv[0] = "changed-after-click";
    expect(snapshot?.request.argv[0]).toBe("npm");
    expect(openApproveConfirmation(trusted, { ...draft, argv: ["-rf"] })).toBeNull();
    expect(openApproveConfirmation(trusted, { ...draft, label: "   " })).toBeNull();
  });

  it("openRunConfirmation needs a trusted click, a listed command and a bound task", () => {
    for (const ev of [null, undefined, {}, { nativeEvent: { isTrusted: false } }]) {
      expect(openRunConfirmation(ev, { taskId: "t1", command: COMMAND, binding: bound, earlierRunUnknown: false })).toBeNull();
    }
    expect(openRunConfirmation(trusted, { taskId: "t1", command: null, binding: bound, earlierRunUnknown: false })).toBeNull();
    expect(
      openRunConfirmation(trusted, {
        taskId: "t1",
        command: COMMAND,
        binding: { ok: false, reason: RUN_NOT_BOUND_REASON },
        earlierRunUnknown: false,
      }),
    ).toBeNull();
    expect(openRunConfirmation(trusted, { taskId: "t1", command: COMMAND, binding: bound, earlierRunUnknown: false })).toEqual({
      taskId: "t1",
      command: COMMAND,
      expectedSandboxName: "atlas-demo",
      expectedWorkspaceMode: "direct_mount",
      earlierRunMayHaveStarted: false,
    });
  });

  it("source pins: each panel sets its snapshot ONLY inside the button's onClick, via the opener", () => {
    for (const [file, opener] of [
      ["../src/components/verification/VerificationPanel.tsx", "openApproveConfirmation(event, draftValue)"],
      ["../src/components/verification/VerificationRunPanel.tsx", "openRunConfirmation(event, {\n              taskId,\n              command,\n              binding,"],
    ] as const) {
      const text = source(file);
      expect([...text.matchAll(/setSnapshot\((?!null\))/g)], file).toHaveLength(1);
      expect(text).toContain(opener);
      const handler = /onClick=\{\(event\) => \{([\s\S]*?)\n\s*\}\}/.exec(text)?.[1] ?? "";
      expect(handler, file).toContain(opener);
      expect(handler, file).toContain("setSnapshot(opened)");
      expect(text, file).not.toMatch(/useEffect\([^)]*setSnapshot\((?!null)/s);
      expect(text, file).not.toMatch(/setTimeout|setInterval/);
    }
  });

  it("no entry point takes argv, a commandId or a runId: no route, no props beyond ids from Core state", () => {
    const router = source("../src/app/router.ts");
    for (const word of ["verification", "argv", "commandId", "runId"]) expect(router).not.toContain(word);
    const panel = source("../src/components/verification/VerificationPanel.tsx");
    expect(panel).toMatch(/export function VerificationPanel\(\{ projectId, archived \}: \{ projectId: string; archived: boolean \}\)/);
    const runPanel = source("../src/components/verification/VerificationRunPanel.tsx");
    expect(runPanel).toMatch(/export function VerificationRunPanel\(\{\s*taskId,\s*task,\s*projectId,\s*\}/);
    // The command is chosen from Core's list by id, never passed in.
    expect(runPanel).toContain("list.find((c) => c.id === selected)");
  });

  it("no verification surface uses an HTML sink, a terminal or link detection", () => {
    const dir = fileURLToPath(new URL("../src/components/verification/", import.meta.url));
    for (const name of readdirSync(dir)) {
      const text = readFileSync(`${dir}${name}`, "utf8");
      expect(text, name).not.toContain("dangerouslySetInnerHTML");
      expect(text, name).not.toContain("innerHTML");
      expect(text, name).not.toMatch(/xterm|linkify|<a\s/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Run binding, single flight, idempotency
// ---------------------------------------------------------------------------

describe("the run's expected values come from the binding and sandbox.list", () => {
  const sandboxes = [
    { name: "chosen-one", workspaceMode: "sbx_clone" as const },
    { name: "atlas-demo", workspaceMode: "host_worktree" as const },
    { name: "no-mode", workspaceMode: null },
  ];

  it("sandboxName, never chosenSandboxName", () => {
    const row = { sandboxName: "atlas-demo", chosenSandboxName: "chosen-one" };
    expect(runBinding(row, sandboxes, true)).toEqual({
      ok: true,
      expectedSandboxName: "atlas-demo",
      expectedWorkspaceMode: "host_worktree",
    });
    // A row with only chosenSandboxName is NOT bound.
    expect(runBinding({ sandboxName: null, chosenSandboxName: "chosen-one" } as { sandboxName: string | null }, sandboxes, true)).toEqual({
      ok: false,
      reason: RUN_NOT_BOUND_REASON,
    });
  });

  it("no row, no entry, no mode or an unrecognised mode: not bound; a list still loading says so", () => {
    expect(runBinding(null, sandboxes, true)).toEqual({ ok: false, reason: RUN_NOT_BOUND_REASON });
    expect(runBinding({ sandboxName: "gone" }, sandboxes, true)).toEqual({ ok: false, reason: RUN_NOT_BOUND_REASON });
    expect(runBinding({ sandboxName: "no-mode" }, sandboxes, true)).toEqual({ ok: false, reason: RUN_NOT_BOUND_REASON });
    expect(RUN_NOT_BOUND_REASON).toBe("this task is not bound to a sandbox");
    const loading = runBinding({ sandboxName: "gone" }, [], false);
    expect(loading.ok).toBe(false);
    expect(!loading.ok && loading.reason).toContain("unavailable right now");
  });
});

describe("single flight per task and the idempotency key", () => {
  const request = (key?: string) => ({
    taskId: "t1",
    commandId: "c-1",
    expectedSandboxName: "atlas-demo",
    expectedWorkspaceMode: "direct_mount" as const,
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });

  it("a double confirm sends ONE frame; a new gesture gets a fresh key", async () => {
    const core = new ScriptedCore();
    core.answers["verification.run"] = { ok: { runId: "r-1", startedSequence: 3 } };
    const client = new CoreClient(core);
    const qc = createQueryClient();
    const observer = new MutationObserver(qc, runMutationOptions(client, "t1"));
    const mutate = (v: RunVariables) => void observer.mutate(v).catch(() => {});
    const first = forNewAction(request(), true);
    expect(submitRun(qc, "t1", mutate, { request: first, retry: false })).toBe(true);
    expect(submitRun(qc, "t1", mutate, { request: first, retry: false })).toBe(false);
    // A different task is not blocked by t1's run, but a request for another task is refused here.
    expect(submitRun(qc, "t1", mutate, { request: { ...first, taskId: "t2" }, retry: false })).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    await qc.getMutationCache().getAll()[0]?.state.status;
    expect(core.frames).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 5));
    const second = forNewAction(request(), true);
    expect(submitRun(qc, "t1", mutate, { request: second, retry: false })).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(core.frames).toHaveLength(2);
    expect(core.frames[0]?.params.idempotencyKey).not.toBe(core.frames[1]?.params.idempotencyKey);
  });

  it("a lost answer offers Retry safely, which resends the SAME key; Core's answer then counts", async () => {
    const core = new ScriptedCore();
    core.answers["verification.run"] = null; // silence: the answer is lost
    const client = new CoreClient(core, { methodTimeoutsMs: { "verification.run": 10 } });
    const qc = createQueryClient();
    const observer = new MutationObserver(qc, runMutationOptions(client, "t1"));
    const mutate = (v: RunVariables) => void observer.mutate(v).catch(() => {});
    const params = forNewAction(request(), true);
    submitRun(qc, "t1", mutate, { request: params, retry: false });
    await new Promise((r) => setTimeout(r, 40));
    const states = qc.getMutationCache().getAll().map((m) => m.state as RunMutationState);
    const view = runOutcomeView(states);
    expect(view.current?.status).toBe("error");
    const copy = verificationFailureCopy(view.current?.error, "run");
    expect(copy.title).toBe("Outcome unknown — the run may have started");
    expect(copy.title).not.toContain("nothing was run");
    expect(copy.retrySafely).toBe(true);
    core.answers["verification.run"] = { ok: { runId: "r-1", startedSequence: 3, replayed: true } };
    expect(submitRun(qc, "t1", mutate, { request: view.current!.variables!.request, retry: true })).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(core.frames).toHaveLength(2);
    expect(core.frames[1]?.params.idempotencyKey).toBe(core.frames[0]?.params.idempotencyKey);
    const after = runOutcomeView(qc.getMutationCache().getAll().map((m) => m.state as RunMutationState));
    expect(after.current?.status).toBe("success");
    expect(after.current?.data?.replayed).toBe(true);
  });

  it("an unkeyed lost answer never offers Retry safely", () => {
    const err = new CoreRequestError("client", "TIMEOUT", "x", { mayHaveBeenApplied: true, idempotencyKeyed: false }, "verification.run");
    expect(verificationFailureCopy(err, "run").retrySafely).toBe(false);
  });

  it("a Retry safely that provably never reached Core keeps the earlier unknown outcome", () => {
    const lost = new CoreRequestError("client", "TIMEOUT", "lost", { mayHaveBeenApplied: true, idempotencyKeyed: true });
    const unsent = new CoreRequestError("client", "CORE_UNREACHABLE", "down", { mayHaveBeenApplied: false });
    const base = { context: undefined, failureCount: 1, failureReason: null, isPaused: false, data: undefined };
    const states = [
      { ...base, status: "error", error: lost, variables: { request: request("k1"), retry: false }, submittedAt: 1 },
      { ...base, status: "error", error: unsent, variables: { request: request("k1"), retry: true }, submittedAt: 2 },
    ] as unknown as RunMutationState[];
    const view = runOutcomeView(states);
    expect(view.current?.error).toBe(lost);
    expect(view.note).toContain("did not reach Core");
  });

  it("Retry safely re-checks keys, the verification feature and verification.run", () => {
    const attached = (methods: readonly string[], features: readonly string[]): ProbeOutcome => ({
      kind: "attached",
      capabilities: {
        protocolVersion: 1,
        coreVersion: "x",
        instanceId: "i",
        sbx: null,
        agents: [],
        platform: "macos",
        methods: [...methods],
        features: [...features],
      },
    });
    expect(runKeyRecheckFromProbe(attached(METHODS, ["idempotency-keys", "verification"])).kind).toBe("advertised");
    expect(runKeyRecheckFromProbe(attached(METHODS, ["verification"])).kind).toBe("not-advertised");
    expect(runKeyRecheckFromProbe(attached(METHODS, ["idempotency-keys"])).kind).toBe("not-retried");
    expect(runKeyRecheckFromProbe(attached(METHODS.filter((m) => m !== "verification.run"), ["idempotency-keys", "verification"])).kind).toBe(
      "not-retried",
    );
  });
});

// ---------------------------------------------------------------------------
// Early feedback is never stricter than Core
// ---------------------------------------------------------------------------

describe("early feedback mirrors Core's argv and label rules, never stricter", () => {
  it("accepts what Core accepts", () => {
    expect(argvProblem(EXACT_ARGV)).toBeNull();
    expect(argvProblem(["make", ""])).toBeNull();
    expect(argvProblem(["./gradlew", "a".repeat(MAX_VERIFICATION_ARG_BYTES)])).toBeNull();
    expect(argvProblem(Array.from({ length: MAX_VERIFICATION_ARGS }, () => "x"))).toBeNull();
    expect(labelProblem(`  ${"x".repeat(MAX_VERIFICATION_LABEL_CHARS)}  `)).toBeNull();
    expect(labelProblem(`unit ${cp(0x2705)} tests`)).toBeNull();
    // Rust's `str::trim` (Unicode White_Space) removes U+0085 and keeps U+FEFF;
    // JS `.trim()` does the opposite. Core accepts "<U+0085>tests<U+0085>" as
    // "tests", so the client must too (a JS trim would leave a Cc and refuse it).
    expect(labelProblem(`${cp(0x85)}tests${cp(0x85)}`)).toBeNull();
    expect(labelProblem(`${cp(0x3000)}tests${cp(0x2029)}`)).toBeNull();
    // U+FEFF is not whitespace to Rust: the label is NOT empty (Core then
    // refuses it as an invisible character; the client leaves that to Core).
    expect(labelProblem(cp(0xfeff))).not.toBe("The label is empty.");
  });

  it("refuses what Core refuses", () => {
    expect(argvProblem([])).not.toBeNull();
    expect(argvProblem(Array.from({ length: MAX_VERIFICATION_ARGS + 1 }, () => "x"))).not.toBeNull();
    expect(argvProblem([""])).not.toBeNull();
    expect(argvProblem(["-rf"])).not.toBeNull();
    expect(argvProblem(["make", `a${ESC}b`])).toContain("Argument 2 contains a control character");
    expect(argvProblem(["make", `a${CSI_C1}`])).not.toBeNull();
    expect(argvProblem(["make", "a".repeat(MAX_VERIFICATION_ARG_BYTES + 1)])).not.toBeNull();
    expect(argvProblem(["make", ...Array.from({ length: 5 }, () => "a".repeat(4000))])).not.toBeNull();
    expect(labelProblem(` ${cp(0x3000)} `)).not.toBeNull();
    expect(labelProblem("x".repeat(MAX_VERIFICATION_LABEL_CHARS + 1))).not.toBeNull();
    expect(labelProblem("a\tb")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outcomes and disclosures
// ---------------------------------------------------------------------------

describe("each outcome is honest; exit 0 is never a pass", () => {
  it("copy per outcome, and no outcome is ever the success tone", () => {
    expect(outcomeView("exited", 0)).toEqual({ label: "exit status 0 (as reported by sbx exec)", tone: "neutral" });
    expect(outcomeView("exited", 1)).toEqual({ label: "exit status 1 (as reported by sbx exec)", tone: "neutral" });
    expect(outcomeView("signaled", undefined).label).toBe("ended by a signal (no exit status)");
    expect(outcomeView("timed_out", undefined).label).toBe(
      "stopped after 10 minutes; the command may still be running inside the sandbox",
    );
    expect(outcomeView("interrupted", undefined).label).toBe(
      "Core restarted (or stopped) while this ran; the result is unknown; the command may still be running inside the sandbox",
    );
    expect(outcomeView("possibly_sbx_error", 1).label).toBe(
      "possibly sbx's own error, or the command's own output — exit status 1 (as reported by sbx exec)",
    );
    expect(outcomeView("spawn_failed", undefined).label).toBe("Core could not start sbx exec (spawn_failed)");
    expect(outcomeView("read_failed", undefined).label).toBe(
      "Core could not read the command's output (read_failed); the exit status is unknown",
    );
    expect(outcomeView("running", undefined).label).toContain("running");
    expect(outcomeView(`new${RLO}`, undefined).label).toContain("\\u202E");
    for (const outcome of [...VERIFICATION_OUTCOMES, "future"]) {
      for (const code of [0, 1, undefined]) {
        const view = outcomeView(outcome, code);
        expect(view.tone, outcome).not.toBe("success");
        expect(view.label, outcome).not.toMatch(/\bpass(ed)?\b|\bfail(ed)?\b|succe/i);
      }
    }
  });

  it("each disclosure flag", () => {
    const base = decodeVerificationResult(wireResult());
    expect(resultDisclosures(base)).toEqual([]);
    expect(
      resultDisclosures({
        ...base,
        stdoutTruncated: true,
        stderrTruncated: true,
        outputIncomplete: true,
        redactions: { bestEffort: true, replacements: 3, byKind: { token: 3 }, outputWithheld: true },
      } satisfies VerificationResult),
    ).toEqual([
      "stdout was cut at Core's 64 KiB cap",
      "stderr was cut at Core's 64 KiB cap",
      DISCLOSURE_OUTPUT_INCOMPLETE,
      DISCLOSURE_OUTPUT_WITHHELD,
      "3 values were redacted (best effort)",
    ]);
    expect(DISCLOSURE_OUTPUT_INCOMPLETE).toBe(
      "output may be incomplete: a process kept the output open after the command exited",
    );
    expect(DISCLOSURE_OUTPUT_WITHHELD).toBe("output was not stored because the secret check was unavailable");
  });

  it("events: never change the task status, never carry output, never coloured as a pass", () => {
    let p = foldTaskEvents(emptyProjection("t1"), [
      { taskId: "t1", sequence: 1, kind: "status.changed", payload: { to: "awaiting_review" }, timestamp: "a" },
      {
        taskId: "t1",
        sequence: 2,
        kind: "verification.started",
        payload: { runId: "r-1", commandId: "c-1", label: HOSTILE, argv: ["npm", HOSTILE], sandbox: "atlas-demo", workspaceMode: "direct_mount" },
        timestamp: "b",
      },
    ]);
    expect(p.status).toBe("awaiting_review");
    expect(verificationsRunningIn([p], "atlas-demo")).toBe(1);
    p = foldTaskEvents(p, [
      {
        taskId: "t1",
        sequence: 3,
        kind: "verification.finished",
        payload: {
          runId: "r-1",
          startedSequence: 2,
          outcome: "exited",
          exitCode: 0,
          stdoutBytes: 3,
          stderrBytes: 0,
          stdoutTruncated: true,
          stderrTruncated: false,
          redactions: { bestEffort: true, replacements: 1, byKind: {} },
          elapsedMs: 5,
          outputIncomplete: true,
          reconciledAfterRestart: true,
        },
        timestamp: "c",
      },
    ]);
    expect(p.status).toBe("awaiting_review");
    expect(verificationsRunningIn([p], "atlas-demo")).toBe(0);
    const entries = p.entries.filter((e) => e.kind === "verification");
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(e.kind === "verification" && e.tone).not.toBe("success");
    expect(entries[0]?.kind === "verification" && entries[0].text).toContain("\\u202E");
    expect(entries[0]?.kind === "verification" && entries[0].text).not.toContain(RLO);
    expect(entries[1]?.kind === "verification" && entries[1].text).toBe(
      "Verification finished: exit status 0 (as reported by sbx exec)",
    );
    const [run] = verificationRunsOf(p);
    expect(run?.finished?.disclosures).toEqual([
      "stdout was cut at Core's 64 KiB cap",
      DISCLOSURE_OUTPUT_INCOMPLETE,
      "1 value was redacted (best effort)",
      "Core found this run unfinished after a restart; its result is unknown",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Failure copy
// ---------------------------------------------------------------------------

describe("refusal copy", () => {
  it("UNSUPPORTED_SBX_VERSION (both variants) is the version gate, never a command failure", () => {
    for (const message of [`${EXEC_UNVERIFIED_PREFIX}0.47.0${NOTHING_WAS_RUN_SUFFIX}`, MSG_VERSION_UNREADABLE]) {
      const copy = verificationFailureCopy(coreErr("UNSUPPORTED_SBX_VERSION", message, undefined, "verification.run"), "run");
      expect(copy.title).toBe("Nothing was run — running is disabled for this sbx version");
      expect(copy.action).toBe(RUN_UNVERIFIED_NOTICE);
      expect(`${copy.title} ${copy.action}`).not.toMatch(/fail/i);
    }
    expect(RUN_UNVERIFIED_NOTICE).toBe(
      "Running is disabled until this sbx version's `sbx exec` behaviour has been captured and verified; your approved commands are kept.",
    );
  });

  it("a secret refusal shows Core's hint IN FULL as advice, never as a command to run", () => {
    const message = `argument 2 looks like a secret (github_token)${SECRET_REFUSAL_SUFFIX}`;
    const copy = verificationFailureCopy(
      coreErr("VALIDATION_FAILED", message, { hint: SECRET_REFUSAL_HINT }, "verification.approve"),
      "approve",
    );
    expect(copy.title).toBe("Nothing was approved — Core's secret check refused it");
    expect(copy.advice).toBe(SECRET_REFUSAL_HINT);
    expect(SECRET_REFUSAL_HINT.length).toBeGreaterThan(120);
    expect(copy.reason).toBe(message);
    for (const m of [`the label looks like a secret (x)${SECRET_REFUSAL_SUFFIX}`, `the arguments together look like a secret (x)${SECRET_REFUSAL_SUFFIX}`]) {
      expect(verificationFailureCopy(coreErr("VALIDATION_FAILED", m, { hint: SECRET_REFUSAL_HINT }), "approve").advice).toBe(
        SECRET_REFUSAL_HINT,
      );
    }
    const unavailable = verificationFailureCopy(coreErr("VALIDATION_FAILED", MSG_SECRET_CHECK_UNAVAILABLE), "approve");
    expect(unavailable.title).toBe("Nothing was approved — Core's secret check is unavailable");
    expect(unavailable.advice).toBeUndefined();
  });

  it("frame refusals: Core's text revealed, the listed ids shown, never retried", () => {
    const text = `${FRAME_REFUSAL_PREFIX}4000000 bytes, the limit is 4128768); revoke the largest${FRAME_REFUSAL_SUFFIX}`;
    const list = verificationFailureCopy(coreErr("VALIDATION_FAILED", text, { commandIds: ["c-9", `c-${RLO}`] }), "list");
    expect(list.title).toContain("would not fit one frame");
    expect(list.listed).toEqual(["c-9", "c-\\u202E"]);
    expect(list.action).toContain("never retries");
    const ctx = verificationFailureCopy(coreErr("VALIDATION_FAILED", text, { repositories: [{ repoPath: "/big", bytes: 9 }] }), "context");
    expect(ctx.listed).toEqual(["/big"]);
    const result = verificationFailureCopy(coreErr("VALIDATION_FAILED", text, { runId: "r-1" }), "result");
    expect(result.listed).toEqual(["r-1"]);
  });

  it("a read's timeout or lost answer never says 'may have been applied'", () => {
    for (const op of ["list", "context", "result"] as const) {
      const method = op === "list" ? "verification.list" : op === "context" ? "project.context" : "verification.result";
      const copy = verificationFailureCopy(timeoutError(method, 15_000), op);
      expect(copy.title).toContain("Core did not answer");
      expect(`${copy.title} ${copy.reason} ${copy.action}`).not.toContain("may have been applied");
      expect(copy.action).toContain("nothing was changed");
    }
  });

  it("run gate refusals say nothing was run; a busy task is a CONFLICT, not an idempotency conflict", () => {
    expect(verificationFailureCopy(coreErr("VALIDATION_FAILED", MSG_VERIFICATION_NOT_BOUND), "run").title).toBe(
      "Nothing was run — this task is not bound to a sandbox",
    );
    expect(verificationFailureCopy(coreErr("CONFLICT", MSG_VERIFICATION_TASK_BUSY), "run").title).toBe(
      "Nothing was run — a verification is already running for this task",
    );
    expect(
      verificationFailureCopy(coreErr("VALIDATION_FAILED", `${NOT_RUNNING_PREFIX}atlas${NOT_RUNNING_SUFFIX}`), "run").title,
    ).toBe("Nothing was run — the sandbox is not running");
    expect(
      verificationFailureCopy(coreErr("CONFLICT", `/repo${REPO_BUSY_INFIX}verification.run:x${REPO_BUSY_SUFFIX}`), "run").title,
    ).toBe("Nothing was run — the repository is busy");
  });

  it("deletes refused while a run is in flight say nothing was deleted (project, conversation, sandbox)", () => {
    expect(describeCoreError(coreErr("CONFLICT", MSG_PROJECT_VERIFICATION_RUNNING)).title).toBe(
      "Nothing was deleted — a verification is running for a task of this project",
    );
    expect(describeCoreError(coreErr("CONFLICT", MSG_CONVERSATION_VERIFICATION_RUNNING)).title).toBe(
      "Nothing was deleted — a verification is running for a task of this conversation",
    );
    expect(removalFailureCopy(coreErr("CONFLICT", MSG_SANDBOX_VERIFICATION_RUNNING)).title).toBe(
      "Nothing was removed — a verification is running in this sandbox",
    );
    // Only on CONFLICT with Core's exact text.
    expect(describeCoreError(coreErr("VALIDATION_FAILED", MSG_PROJECT_VERIFICATION_RUNNING)).title).not.toContain(
      "Nothing was deleted",
    );
  });
});

// ---------------------------------------------------------------------------
// Rendering: text, never markup or terminal sequences
// ---------------------------------------------------------------------------

function assertInert(html: string): void {
  for (const raw of [ESC, BEL, CSI_C1, RLO, LRI, ZWSP]) expect(html).not.toContain(raw);
  expect(html).not.toContain("<script");
  expect(html).not.toMatch(/<a[\s>]/);
  expect(html).not.toContain("href=");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("\\u001B");
  expect(html).toContain("\\u202E");
  expect(html).toContain("\\u009B");
  expect(html).toContain("\\u0007");
}

describe("SSR rendering with ESC, OSC 8, OSC 52, <script> and bidi characters", () => {
  it("approve dialog: alertdialog, Cancel focused, every element revealed with the count, the statements, the notes", () => {
    const snapshot = openApproveConfirmation(trusted, {
      projectId: PROJECT,
      label: `tests ${RLO}x`,
      argv: ["npm", `run ${HOSTILE}`, TAB_EL],
      source: {
        kind: "suggestion",
        repoPath: `/repo/${RLO}`,
        manifest: "package.json",
        notes: [`npm run test runs: ${HOSTILE}`],
        suggestedArgv: ["npm", `run ${HOSTILE}`, TAB_EL],
      },
    });
    // The label above has no control character, so Core would accept it; argv holds controls → refused early.
    expect(snapshot).toBeNull();
    const html = renderToStaticMarkup(
      createElement(ApproveConfirmDialog, {
        snapshot: {
          request: { projectId: PROJECT, label: HOSTILE, argv: ["npm", HOSTILE, TAB_EL, NEWLINE_EL] },
          source: {
            kind: "suggestion",
            repoPath: `/repo/${HOSTILE}`,
            manifest: "package.json",
            notes: [`npm run test runs: ${HOSTILE}`],
            suggestedArgv: ["npm", HOSTILE, TAB_EL, NEWLINE_EL],
          },
        },
        onCancel: () => {},
        onConfirm: () => {},
      }),
    );
    assertInert(html);
    expect(html).toContain('role="alertdialog"');
    expect(html).toMatch(/<button[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/);
    expect(html).toContain(">Approve</button>");
    expect(html).toContain("4 arguments, exactly as they will be stored");
    expect(html).toContain("a\\u0009b");
    expect(html).toContain("line1\\u000Aline2");
    expect(html).toContain(APPROVE_NO_SECRETS);
    expect(html).toContain(APPROVE_BINDS_STATEMENT.replace(/'/g, "&#x27;"));
    expect(html).toContain("npm run test runs: ");
  });

  it("run dialog: command, sandbox, mode, the direct_mount warning and the statement", () => {
    const html = renderToStaticMarkup(
      createElement(RunConfirmDialog, {
        snapshot: {
          taskId: "t1",
          command: { ...COMMAND, label: HOSTILE, argv: ["npm", HOSTILE] },
          expectedSandboxName: `atlas-${RLO}demo`,
          expectedWorkspaceMode: "direct_mount",
          earlierRunMayHaveStarted: false,
        },
        onCancel: () => {},
        onConfirm: () => {},
      }),
    );
    assertInert(html);
    expect(html).toContain('role="alertdialog"');
    expect(html).toMatch(/<button[^>]*data-autofocus="true"[^>]*>Cancel<\/button>/);
    expect(html).toContain(">Run</button>");
    expect(html).toContain(DIRECT_MOUNT_RUN_WARNING.replace(/'/g, "&#x27;"));
    expect(html).toContain(RUN_STATEMENT.replace(/'/g, "&#x27;"));
    expect(DIRECT_MOUNT_RUN_WARNING).toBe(
      "this sandbox mounts your repository directly; the command can change your working tree, including `.git/hooks` that later run on your machine",
    );
    const worktree = renderToStaticMarkup(
      createElement(RunConfirmDialog, {
        snapshot: {
          taskId: "t1",
          command: COMMAND,
          expectedSandboxName: "a",
          expectedWorkspaceMode: "host_worktree",
          earlierRunMayHaveStarted: false,
        },
        onCancel: () => {},
        onConfirm: () => {},
      }),
    );
    expect(worktree).toContain("changed since reviewed");
    expect(HOST_WORKTREE_RUN_WARNING).toContain("review");
  });

  it("output: one <pre> text child, LF and TAB kept, CR as \\r, every other control escaped, capped", () => {
    const out = `ok\tdone\r\nred: ${ESC}[31mX${ESC}[0m\n${OSC8}\n${OSC52}\n${HOSTILE}\n`;
    const html = renderToStaticMarkup(createElement(OutputBlock, { label: "stdout", output: out }));
    assertInert(html);
    expect(html).toContain("<pre");
    expect(html).toContain("ok\tdone\\r\nred: \\u001B[31mX");
    expect(html).toContain("unusual characters");
    const long = revealOutput(Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n"));
    expect(long.hiddenLines).toBe(100);
    expect(revealOutput("x".repeat(2500)).text).toMatch(/… \(500 more characters\)$/);
  });

  it("stop confirmation names a run in flight; stop stays allowed", () => {
    const html = renderToStaticMarkup(
      createElement(StopDialog, { name: "atlas-demo", active: 0, verificationsRunning: 1, onCancel: () => {}, onConfirm: () => {} }),
    );
    expect(STOP_ENDS_VERIFICATION).toBe("a verification is running in this sandbox; stopping it ends the run");
    expect(html).toContain(STOP_ENDS_VERIFICATION);
    expect(html).toContain(">Stop sandbox</button>");
    const none = renderToStaticMarkup(
      createElement(StopDialog, { name: "atlas-demo", active: 0, onCancel: () => {}, onConfirm: () => {} }),
    );
    expect(none).not.toContain(STOP_ENDS_VERIFICATION);
  });
});
