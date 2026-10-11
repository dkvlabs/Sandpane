/**
 * In-memory duplex plus a miniature Core server for unit tests.
 *
 * The server side implements only what the real `sandpane-service` contract
 * specifies for the methods the desktop calls: `{v,id,...}` frames, one response
 * per request, `ok` XOR `err`, `snake_case`/`SCREAMING_SNAKE` payloads, and
 * `task.subscribe` as a one-shot replay (the real service has no push frames).
 * It is a test double for the peer, never a fixture shipped as app data — the app
 * itself has no fake transport path.
 *
 * The ADDITIVE-v1 behaviour below (blank-id refusal, limit clamping, the
 * `afterSequences` cursor rules, the oversized-replay refusal) was COPIED FROM
 * MEASURED RESPONSES of the prebuilt `core/target/debug/sandpane-service` on this
 * host, not from a reading of the spec — see apps/desktop/README.md
 * "Verification" for the probe transcript. A double that quietly disagreed with
 * Core would make the guard tests prove nothing.
 */

import { encodeFrame } from "../../src/lib/framing";
import {
  MSG_CONVERSATION_ARCHIVED,
  MSG_CONVERSATION_HAS_TASKS,
  MSG_CONVERSATION_NOT_FOUND,
  MSG_SEND_MODE_INVALID,
  MSG_TITLE_BLANK,
} from "../../src/lib/conversation-messages";
import { isRustWhitespace, validateConversationTitle } from "../../src/lib/wizard";
import {
  MSG_PROJECT_ARCHIVED,
  MSG_PROJECT_NOT_FOUND,
  MSG_REPOSITORY_IN_USE,
  MSG_REPOSITORY_NOT_REGISTERED,
  MSG_REPOSITORY_REMOVE_WHILE_CREATING,
  MSG_UPDATE_NEEDS_A_FIELD,
} from "../../src/lib/project-messages";

/** The A3a writes a `projectFault` applies to. */
const PROJECT_WRITES = new Set([
  "project.update",
  "project.archive",
  "project.unarchive",
  "project.delete",
  "project.add_repository",
  "project.remove_repository",
]);
import type { CoreTransport } from "../../src/lib/core-client";
import {
  MAX_LIST_LIMIT,
  MAX_SCOPING_ID_LEN,
  PROTOCOL_VERSION,
  type Conversation,
  type TaskEvent,
  type TaskStatus,
  type TaskSummary,
} from "../../src/lib/protocol";

/** Core's own refusal text shape for an undeliverable replay (verbatim pattern). */
export const OVERSIZE_REFUSAL_MESSAGE =
  "replay of 1 task(s) passed the 4160512-byte ceiling this frame shape can carry; " +
  "narrow the request (single taskId, higher afterSequence, per-task afterSequences) " +
  "— task.subscribe has no truncation envelope yet (docs/specs/02 §2)";

export interface FakeCoreOptions {
  /** Fail the first N requests with a transport-level drop instead of answering. */
  dropFirstRequests?: number;
  /** Answer with a delay (ms) to exercise correlation. */
  latencyMs?: number;
  /**
   * Simulate a pre-revision Core: `system.probe` omits `methods` entirely and the
   * three additive reads are refused, so feature detection can be tested against
   * a Core that does not have them.
   */
  legacyCore?: boolean;
  /** Answer `task.subscribe` with the oversized-replay refusal instead of events. */
  refuseReplayAsOversized?: boolean;
  /**
   * Override the `system.probe` `methods` list (e.g. a Core that predates A1 and
   * advertises neither `sandbox.stop` nor `sandbox.remove`). Methods left out are
   * also refused when called, as a Core that does not dispatch them would.
   */
  advertisedMethods?: readonly string[];
  /**
   * `system.probe` `features` (A2). Default: every feature the A2 Core
   * advertises plus one unknown string (clients must ignore it). `null` omits
   * the field entirely, like a pre-A2 Core.
   */
  features?: readonly string[] | null;
}

/** What the A2 Core advertises (Rust `FEATURES`), plus a future unknown one. */
export const A2_CORE_FEATURES: readonly string[] = [
  "idempotency-keys",
  "sandbox-create-agent",
  "some-future-feature",
];

/**
 * What the A4 Core advertises (Rust `FEATURES`, drift-tested in
 * `tests/send-mode.test.ts`), plus a future unknown one clients must ignore.
 */
export const A4_CORE_FEATURES: readonly string[] = [
  "idempotency-keys",
  "sandbox-create-agent",
  "conversation-sandbox-id",
  "conversation-send-mode",
  "some-future-feature",
];

/**
 * A2 CONFLICT messages, verbatim from `sandpane-service` (`IDEM_MSG_*`). The
 * idempotency behaviour of `sandbox.create` / `conversation.send` below is
 * MODELED on the service source (design §3.1), NOT captured from a live Core.
 */
export const FAKE_IDEM_MSG_MISMATCH =
  "idempotency key was already used with different parameters; nothing was run";
export const FAKE_IDEM_MSG_PENDING =
  "an operation with this idempotency key is still in progress; nothing was run";
export const FAKE_IDEM_MSG_UNKNOWN =
  "the outcome of the earlier request with this idempotency key is unknown (Core restarted or sbx failed while it ran); re-read state before retrying with a new key";

/** Every method the A1 Core dispatches, in `Method::ALL` order. */
export const A1_CORE_METHODS: readonly string[] = [
  "system.probe",
  "project.create",
  "project.list",
  "sandbox.list",
  "sandbox.create",
  "sandbox.stop",
  "sandbox.remove",
  "conversation.create",
  "conversation.send",
  "conversation.list",
  "conversation.history",
  "task.cancel",
  "task.list",
  "task.subscribe",
  "git.review",
  "git.apply",
];

/** Every method the A3a Core dispatches (22), in `Method::ALL` order. */
export const A3A_CORE_METHODS: readonly string[] = [
  "system.probe",
  "project.create",
  "project.list",
  "project.update",
  "project.archive",
  "project.unarchive",
  "project.delete",
  "project.add_repository",
  "project.remove_repository",
  ...A1_CORE_METHODS.slice(3),
];

/**
 * Every method the A3b Core dispatches (27), in `Method::ALL` order: the five
 * conversation-lifecycle methods sit right after `conversation.history`.
 */
export const A3B_CORE_METHODS: readonly string[] = (() => {
  const at = A3A_CORE_METHODS.indexOf("conversation.history") + 1;
  return [
    ...A3A_CORE_METHODS.slice(0, at),
    "conversation.rename",
    "conversation.archive",
    "conversation.unarchive",
    "conversation.delete",
    "conversation.export",
    ...A3A_CORE_METHODS.slice(at),
  ];
})();

/** `TaskStateMachine::is_terminal` (sandpane-core); anything else blocks a delete. */
const TERMINAL_TASK_STATUSES = new Set(["completed", "rejected", "failed", "cancelled", "interrupted"]);

/** Redaction the double applies to an export (scripted; the regexes are Core's, not modeled). */
export interface FakeRedaction {
  byKind: Record<string, number>;
}

/**
 * A project the double's Core holds. The A3a project-lifecycle behaviour below
 * is MODELED on `sandpane-service/src/project_lifecycle.rs` as read from the
 * working tree (design §3.2) — NOT captured from a live Core run.
 */
export interface FakeProject {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  repositories: string[];
  archivedAt?: string;
}

/** A fault injected into the NEXT A3a project write, after Core applied it. */
export type ProjectFault = "drop-after-apply" | "internal-after-apply";

/**
 * Core's verbatim token refusal (`confirm::TOKEN_REJECTED_MESSAGE`). The A1
 * stop/remove behaviour below is MODELED on `sandpane-service/src/lib.rs`
 * (`sandbox_stop`, `sandbox_remove`) and `confirm.rs` as read from the working
 * tree — it was NOT captured from a live Core run, unlike the additive-v1
 * reads above.
 */
export const TOKEN_REJECTED_MESSAGE =
  "confirmation token is invalid, expired, already used, or not for this action and target; " +
  "request a new confirmation";

/** A sandbox the double's `sbx` holds (name + sbx id + Sandpane binding). */
export interface FakeSandbox {
  name: string;
  id: string;
  status: "running" | "stopped";
  /** Sandpane binding present → not external. */
  bound: boolean;
  agent?: string;
}

/**
 * A conversation the double's Core holds (`archivedAt` / `sandboxId` as the
 * A3b wire carries them). The A3b behaviour below is MODELED on
 * `sandpane-service/src/conversation_lifecycle.rs` as read from the working
 * tree (design §3.3) — NOT captured from a live Core run.
 */
export interface FakeConversation extends Conversation {
  /** Rows Core holds in `messages`; `conversation.history` pages over these. */
  messages: { sequence: number; role: string; content: string }[];
}

export class FakeCore {
  /**
   * MODELED A4 `sandbox.remove` step-1 impact line (Core's `format!`, drift-
   * tested): unfinished tasks sent from chats that chose this sandbox NAME.
   */
  static chosenNameImpactLine(n: number): string {
    return `${n} unfinished task(s) were sent from chats that chose this sandbox name; removing it does not cancel them`;
  }

  private readonly listeners: ((line: string) => void)[] = [];
  readonly events: TaskEvent[] = [];
  readonly tasks: TaskSummary[] = [];
  readonly conversations: FakeConversation[] = [];
  /** The double's sbx inventory for the A1 lifecycle methods. */
  readonly sandboxes: FakeSandbox[] = [];
  /** Pending confirmation tokens → bound identity (single-use, like Core). */
  private readonly tokens = new Map<string, { name: string; id: string; expiresAtMs: number }>();
  private tokenSeq = 0;
  /** Clock for confirmation expiry; tests may move it. */
  public nowMs = Date.parse("2026-10-10T00:00:00Z");
  /** When true, the post-stop re-query "fails" and `requeried` is omitted. */
  public stopRequeryFails = false;
  /** MODELED A3a project rows (`project.list` answers `[]` while this is empty). */
  readonly projects: FakeProject[] = [];
  private readonly projectTokens = new Map<string, { id: string; expiresAtMs: number }>();
  /** MODELED delete precondition: the CONFLICT message step 1 / step 2 answers, or null. */
  public projectDeleteBlocker: string | null = null;
  /** MODELED: repository paths a task or live sandbox of the project uses. */
  readonly repositoriesInUse = new Set<string>();
  /** MODELED: a `sandbox.create` for the project is in flight. */
  public projectCreateInFlight = false;
  /** MODELED: Core's refusal of the next `project.add_repository` path (git/denylist rules). */
  public addRepositoryRefusal: { code: string; message: string } | null = null;
  /** MODELED fault for the next A3a project write (applied first, then the answer is lost / INTERNAL). */
  public projectFault: ProjectFault | null = null;
  /** Extra impact lines appended to every confirmation (hostile-content tests). */
  public extraImpact: string[] = [];
  /** MODELED A3b conversation-delete tokens → bound conversation id. */
  private readonly conversationTokens = new Map<string, { id: string; expiresAtMs: number }>();
  private conversationSeq = 0;
  /**
   * MODELED `conversation.export` page size (rows). Stands in for Core's byte
   * ceiling cutting a page short; `null` = the clamped `limit` only.
   */
  public exportPageRows: number | null = null;
  /** SCRIPTED title redaction for `conversation.export` (applied on every page, counted on the first). */
  public titleRedaction: { title: string; byKind: Record<string, number> } | null = null;
  /** SCRIPTED per-message redaction for `conversation.export`. */
  public messageRedaction: ((content: string) => { content: string; byKind: Record<string, number> }) | null =
    null;
  /**
   * MODELED A2 key store: `${method}\u0000${key}` → state. `done` holds the
   * FIRST response and the params fingerprint (params minus the key).
   */
  readonly idempotency = new Map<
    string,
    { state: "done"; hash: string; result: unknown } | { state: "pending" | "unknown" }
  >();
  /** Answers for the next N keyed writes are dropped AFTER storing (lost answer). */
  public dropAnswersAfterApply = 0;
  /** How many times each keyed write actually RAN (not replayed). */
  readonly ran: Record<string, number> = {};
  /** Every request frame the client sent, decoded. */
  readonly requests: { v: number; id: string; method: string; params: unknown }[] = [];
  /** Params of every frame per method, for cursor/wire-shape assertions. */
  readonly sent: Record<string, unknown[]> = {};
  public probeCount = 0;
  public requestCount = 0;
  private failNext = 0;

  /** Answer `task.subscribe` with the oversized-replay refusal instead of events. */
  private refuseReplay: boolean;

  constructor(private readonly options: FakeCoreOptions = {}) {
    this.refuseReplay = options.refuseReplayAsOversized === true;
  }

  /**
   * Flip the refusal at runtime: Core's verdict is per-request, so a test of
   * "narrow the request, then resume" needs to stop refusing.
   */
  setReplayRefusal(on: boolean): void {
    this.refuseReplay = on;
  }

  /** Transport the client under test writes into. */
  readonly transport: CoreTransport = {
    kind: "memory",
    write: async (frame: string) => {
      this.receive(frame);
    },
    onLine: (handler) => {
      this.listeners.push(handler);
      return () => {
        const index = this.listeners.indexOf(handler);
        if (index >= 0) this.listeners.splice(index, 1);
      };
    },
    onClose: () => () => {},
    close: () => {},
  };

  /** Push a raw line at the client (to test stray or malformed responses). */
  send(line: string): void {
    for (const listener of [...this.listeners]) listener(line);
  }

  /** The id of the most recent request, for hand-crafted responses. */
  lastRequestId(): string {
    const last = this.requests[this.requests.length - 1];
    if (!last) throw new Error("the client has not sent a request yet");
    return last.id;
  }

  /** Make the next N requests answer with an `err` frame of the given code. */
  failNextWith(count: number): void {
    this.failNext = count;
  }

  appendEvents(events: readonly TaskEvent[]): void {
    this.events.push(...events);
  }

  addTask(task: TaskSummary): void {
    this.tasks.push(task);
  }

  /**
   * Registers a task AND the conversation that scopes it. Core reaches a task
   * through `conversations.project_id`, so a project-scoped `task.list` or
   * `task.subscribe` only answers for tasks wired this way — the double refuses
   * to invent the join.
   */
  addTaskInProject(task: TaskSummary, projectId: string): void {
    this.tasks.push(task);
    if (!this.conversations.some((c) => c.id === task.conversationId)) {
      this.addConversation({
        id: task.conversationId,
        projectId,
        title: "scoped chat",
        agentId: "codex",
        createdAt: "2026-10-09T00:00:00Z",
      });
    }
  }

  addConversation(conversation: Omit<FakeConversation, "messages"> & {
    messages?: FakeConversation["messages"];
  }): void {
    this.conversations.push({ messages: [], ...conversation });
  }

  private receive(frame: string): void {
    const line = frame.endsWith("\n") ? frame.slice(0, -1) : frame;
    let request: { v: number; id: string; method: string; params?: unknown };
    try {
      request = JSON.parse(line);
    } catch {
      this.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          id: "",
          err: { code: "VALIDATION_FAILED", message: "malformed frame" },
        }),
      );
      return;
    }
    this.requests.push({ ...request, params: request.params ?? {} });
    this.sent[request.method] = [...(this.sent[request.method] ?? []), request.params ?? {}];
    this.requestCount += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      this.send(
        encodeFrame({
          v: PROTOCOL_VERSION,
          id: request.id,
          err: { code: "DAEMON_DOWN", message: "daemon is not running (test)" },
        }),
      );
      return;
    }
    if (
      this.options.dropFirstRequests !== undefined &&
      this.requestCount <= this.options.dropFirstRequests
    ) {
      return; // no answer: the client must time out
    }
    const respond = () => {
      const answer = this.answer(request);
      // MODELED lost answer: Core applied (and stored) the write, the reply
      // never arrives — the client must time out with an unknown outcome.
      if (
        this.dropAnswersAfterApply > 0 &&
        (request.method === "sandbox.create" || request.method === "conversation.send")
      ) {
        this.dropAnswersAfterApply -= 1;
        return;
      }
      if (this.projectFault !== null && PROJECT_WRITES.has(request.method)) {
        const fault = this.projectFault;
        this.projectFault = null;
        if (fault === "drop-after-apply") return;
        this.send(
          encodeFrame({
            v: PROTOCOL_VERSION,
            id: request.id,
            err: { code: "INTERNAL", message: "database is locked (test)" },
          }),
        );
        return;
      }
      this.send(encodeFrame(answer));
    };
    if (this.options.latencyMs) setTimeout(respond, this.options.latencyMs);
    else respond();
  }

  /** `Project` as Core serializes it: `archivedAt` only when archived. */
  private projectWire(p: FakeProject): Record<string, unknown> {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      createdAt: p.createdAt,
      repositories: [...p.repositories],
      ...(p.archivedAt === undefined ? {} : { archivedAt: p.archivedAt }),
    };
  }

  /** `require_live_project`: the row, or why not. */
  private liveProject(id: unknown): FakeProject | "missing" | "archived" {
    const project = this.projects.find((p) => p.id === id);
    if (project === undefined) return "missing";
    if (project.archivedAt !== undefined) return "archived";
    return project;
  }

  private liveError(why: "missing" | "archived"): [string, string] {
    return why === "missing"
      ? ["NOT_FOUND", MSG_PROJECT_NOT_FOUND]
      : ["VALIDATION_FAILED", MSG_PROJECT_ARCHIVED];
  }

  addProject(project: Partial<FakeProject> & { id: string; name: string }): FakeProject {
    const row: FakeProject = {
      description: "",
      createdAt: "2026-10-10T00:00:00Z",
      repositories: [],
      ...project,
    };
    this.projects.push(row);
    return row;
  }

  /** The last params object the client sent for `method`, typed for tests. */
  lastParams<T = Record<string, unknown>>(method: string): T {
    const list = this.sent[method];
    if (!list || list.length === 0) throw new Error(`no ${method} request was sent`);
    return list[list.length - 1] as T;
  }

  /** How many frames were written for `method`. */
  callsFor(method: string): number {
    return (this.sent[method] ?? []).length;
  }

  private answer(request: {
    id: string;
    method: string;
    params?: unknown;
  }): Record<string, unknown> {
    const ok = (payload: unknown) => ({
      v: PROTOCOL_VERSION,
      id: request.id,
      ok: payload,
    });
    const err = (code: string, message: string) => ({
      v: PROTOCOL_VERSION,
      id: request.id,
      err: { code, message },
    });
    const params = (request.params ?? {}) as Record<string, unknown>;

    if (
      this.options.advertisedMethods !== undefined &&
      !this.options.advertisedMethods.includes(request.method)
    ) {
      return err("VALIDATION_FAILED", `unknown method ${request.method}`);
    }

    switch (request.method) {
      case "system.probe": {
        this.probeCount += 1;
        const capabilities: Record<string, unknown> = {
          protocolVersion: PROTOCOL_VERSION,
          coreVersion: this.options.legacyCore ? "0.0.9" : "0.1.0",
          instanceId: "instance-test",
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
        // A pre-discovery Core does not send the field at all (additive).
        if (!this.options.legacyCore) {
          capabilities.methods = [...(this.options.advertisedMethods ?? A1_CORE_METHODS)];
        }
        const features =
          this.options.features === undefined ? A2_CORE_FEATURES : this.options.features;
        if (features !== null && !this.options.legacyCore) capabilities.features = [...features];
        return ok(capabilities);
      }
      case "project.list": {
        const includeArchived = params.includeArchived === true;
        return ok(
          this.projects
            .filter((p) => includeArchived || p.archivedAt === undefined)
            .map((p) => this.projectWire(p)),
        );
      }
      case "project.update": {
        if (params.name === undefined && params.description === undefined) {
          return err("VALIDATION_FAILED", MSG_UPDATE_NEEDS_A_FIELD);
        }
        if (params.name === "") return err("VALIDATION_FAILED", "project name: value is empty");
        const live = this.liveProject(params.projectId);
        if (typeof live === "string") return err(...this.liveError(live));
        if (typeof params.name === "string") live.name = params.name;
        if (typeof params.description === "string") live.description = params.description;
        return ok(this.projectWire(live));
      }
      case "project.archive":
      case "project.unarchive": {
        const project = this.projects.find((p) => p.id === params.projectId);
        if (project === undefined) return err("NOT_FOUND", MSG_PROJECT_NOT_FOUND);
        if (request.method === "project.archive" && project.archivedAt === undefined) {
          project.archivedAt = new Date(this.nowMs).toISOString().replace(".000Z", "Z");
        }
        if (request.method === "project.unarchive") delete project.archivedAt;
        return ok(this.projectWire(project));
      }
      case "project.delete": {
        const id = String(params.projectId ?? "");
        const token = params.confirmToken;
        if (token === undefined) {
          const project = this.projects.find((p) => p.id === id);
          if (project === undefined) return err("NOT_FOUND", MSG_PROJECT_NOT_FOUND);
          if (this.projectDeleteBlocker !== null) return err("CONFLICT", this.projectDeleteBlocker);
          this.tokenSeq += 1;
          const minted = (0x1000 + this.tokenSeq).toString(16).padStart(64, "0");
          const expiresAtMs = this.nowMs + 120_000;
          this.projectTokens.set(minted, { id, expiresAtMs });
          const repos = project.repositories.length;
          return ok({
            confirmation: {
              token: minted,
              expiresAt: new Date(Math.floor(expiresAtMs / 1000) * 1000)
                .toISOString()
                .replace(".000Z", "Z"),
              action: "project.delete",
              target: { name: project.name, id },
              impact: [
                `deletes project ${project.name} and all of its Core records; this cannot be undone`,
                "0 conversations, 0 messages and 0 tasks are deleted, with their events, artifacts and verification records",
                `${repos} registered ${repos === 1 ? "repository is" : "repositories are"} unregistered; ${repos === 1 ? "its" : "their"} files are not touched`,
                "0 audit records of removed sandboxes are deleted with the project",
                "0 Core-allocated worktree directories and 0 task branches in host repositories are left in place; Core never touches host files, branches or sandboxes",
                ...this.extraImpact,
              ],
              external: false,
            },
          });
        }
        // Step 2: the token is consumed FIRST, whatever happens next.
        const bound = typeof token === "string" ? this.projectTokens.get(token) : undefined;
        if (typeof token === "string") this.projectTokens.delete(token);
        if (bound === undefined || bound.id !== id || this.nowMs >= bound.expiresAtMs) {
          return err("VALIDATION_FAILED", TOKEN_REJECTED_MESSAGE);
        }
        const index = this.projects.findIndex((p) => p.id === id);
        if (index < 0) return err("NOT_FOUND", MSG_PROJECT_NOT_FOUND);
        if (this.projectDeleteBlocker !== null) return err("CONFLICT", this.projectDeleteBlocker);
        this.projects.splice(index, 1);
        return ok({ deleted: true });
      }
      case "project.add_repository": {
        const live = this.liveProject(params.projectId);
        if (typeof live === "string") return err(...this.liveError(live));
        const path = String(params.path ?? "");
        if (!path.startsWith("/")) {
          return err("VALIDATION_FAILED", `repository path must be absolute: ${path}`);
        }
        if (this.addRepositoryRefusal !== null) {
          const refusal = this.addRepositoryRefusal;
          this.addRepositoryRefusal = null;
          return err(refusal.code, refusal.message);
        }
        if (!live.repositories.includes(path)) live.repositories.push(path);
        return ok(this.projectWire(live));
      }
      case "project.remove_repository": {
        const path = String(params.path ?? "");
        if (!path.startsWith("/")) {
          return err("VALIDATION_FAILED", `repository path must be absolute: ${path}`);
        }
        const live = this.liveProject(params.projectId);
        if (typeof live === "string") return err(...this.liveError(live));
        if (!live.repositories.includes(path)) {
          return err("NOT_FOUND", MSG_REPOSITORY_NOT_REGISTERED);
        }
        if (this.repositoriesInUse.has(path)) return err("CONFLICT", MSG_REPOSITORY_IN_USE);
        if (this.projectCreateInFlight) return err("CONFLICT", MSG_REPOSITORY_REMOVE_WHILE_CREATING);
        live.repositories = live.repositories.filter((r) => r !== path);
        return ok(this.projectWire(live));
      }
      case "sandbox.list":
        return err("NOT_INSTALLED", "sbx executable not found");

      // -- ADDITIVE v1 reads ------------------------------------------------

      case "task.list": {
        if (this.options.legacyCore) {
          return err("VALIDATION_FAILED", "unknown method task.list");
        }
        const refusal = this.scopingRefusal(params.projectId, "projectId");
        if (refusal !== null) return err("VALIDATION_FAILED", refusal);
        const limit = this.clampLimit(params.limit);
        const projectId =
          typeof params.projectId === "string" ? params.projectId : undefined;
        const statuses = Array.isArray(params.statuses) ? params.statuses : undefined;
        const conversationIds = new Set(
          this.conversations
            .filter((c) => projectId === undefined || c.projectId === projectId)
            .map((c) => c.id),
        );
        const rows = this.tasks.filter(
          (task) =>
            (projectId === undefined || conversationIds.has(task.conversationId)) &&
            (statuses === undefined || statuses.includes(task.status)),
        );
        return ok(rows.slice(0, limit));
      }

      case "conversation.list": {
        if (this.options.legacyCore) {
          return err("VALIDATION_FAILED", "unknown method conversation.list");
        }
        const refusal = this.scopingRefusal(params.projectId, "projectId");
        if (refusal !== null) return err("VALIDATION_FAILED", refusal);
        const limit = this.clampLimit(params.limit);
        const projectId =
          typeof params.projectId === "string" ? params.projectId : undefined;
        // A3b (MODELED): archived rows only with `includeArchived: true`.
        const includeArchived = params.includeArchived === true;
        return ok(
          this.conversations
            .filter(
              (c) =>
                (includeArchived || c.archivedAt === undefined) &&
                (projectId === undefined || c.projectId === projectId),
            )
            .map((c) => this.conversationWire(c))
            .slice(0, limit),
        );
      }

      case "conversation.history": {
        if (this.options.legacyCore) {
          return err("VALIDATION_FAILED", "unknown method conversation.history");
        }
        // Measured live: a missing id is a parse-time refusal, a blank one is
        // `conversationId: value is empty`, and an unknown one is NOT_FOUND —
        // never an empty-but-successful answer that reads as "no messages".
        if (params.conversationId === undefined) {
          return err("VALIDATION_FAILED", "invalid params: missing field `conversationId`");
        }
        const refusal = this.scopingRefusal(params.conversationId, "conversationId");
        if (refusal !== null) return err("VALIDATION_FAILED", refusal);
        const conversation = this.conversations.find(
          (c) => c.id === params.conversationId,
        );
        // A3b: history serves archived conversations too.
        if (conversation === undefined) {
          return err("NOT_FOUND", MSG_CONVERSATION_NOT_FOUND);
        }
        const limit = this.clampLimit(params.limit);
        const after = Math.max(0, Number(params.afterSequence ?? 0));
        const rows = conversation.messages.filter((m) => m.sequence > after);
        const page = rows.slice(0, limit);
        return ok({
          messages: page.map((m) => ({
            id: `m-${conversation.id}-${m.sequence}`,
            conversationId: conversation.id,
            role: m.role,
            content: m.content,
            sequence: m.sequence,
          })),
          // Both bounds are disclosed, exactly as Core does: there was a row that
          // did not fit this page.
          truncated: rows.length > page.length,
          nextSequence:
            page.length > 0
              ? page[page.length - 1]?.sequence ?? after
              : after,
        });
      }

      // -- writes and replay --------------------------------------------------

      case "task.subscribe": {
        if (this.refuseReplay) {
          return err("VALIDATION_FAILED", OVERSIZE_REFUSAL_MESSAGE);
        }
        return ok(this.replay(params));
      }
      case "task.cancel":
        return ok({ requested: true });

      // -- A2 keyed writes (MODELED on the service source, see header) ---------

      case "sandbox.create":
        return this.keyed(request.method, params, ok, err, () => {
          const name = String(params.name ?? "");
          this.sandboxes.push({
            name,
            id: `id-${name}`,
            status: "running",
            bound: true,
            ...(typeof params.agent === "string" ? { agent: params.agent } : {}),
          });
          return {
            name,
            probedState: "running",
            boundProjectId: params.projectId ?? null,
            workspaceMode: params.workspaceMode ?? null,
          };
        });
      case "conversation.send": {
        // A4 (MODELED on `normalize_send_params`): only a Core advertising
        // conversation-send-mode reads `mode`. A pre-A4 Core ignores the
        // unknown field (serde), so a discussion is silently a task there.
        const honoursMode = this.advertises("conversation-send-mode");
        const { mode: rawMode, ...withoutMode } = params;
        let sendParams: Record<string, unknown> = withoutMode;
        let mode: "task" | "discuss" = "task";
        if (honoursMode && rawMode !== undefined && rawMode !== null) {
          // Checked BEFORE the key lookup: nothing is stored or run.
          if (rawMode !== "task" && rawMode !== "discuss") {
            return err("VALIDATION_FAILED", MSG_SEND_MODE_INVALID);
          }
          // An explicit "task" is normalized to absent before the fingerprint.
          if (rawMode === "discuss") {
            mode = "discuss";
            sendParams = { ...withoutMode, mode: "discuss" };
          }
        }
        return this.keyed(request.method, sendParams, ok, err, () => {
          // A3b (MODELED): checked AFTER the key lookup, so a keyed replay to
          // a since-archived conversation still returns the stored answer.
          // An unknown conversation stays lenient here (pre-A3b double).
          const conversation = this.conversations.find((c) => c.id === params.conversationId);
          if (conversation !== undefined) {
            const refusal = this.writableRefusal(conversation);
            if (refusal !== null) return { refused: refusal };
          }
          const id = `task-${this.requestCount}`;
          const task: TaskSummary = {
            id,
            conversationId: String(params.conversationId ?? ""),
            status: "queued",
            // A4: the requested mode, and the chat's chosen sandbox NAME
            // (never `sandboxName`, which stays the unfilled binding).
            ...(honoursMode ? { mode } : {}),
            ...(honoursMode && conversation?.sandboxId !== undefined
              ? { chosenSandboxName: conversation.sandboxId }
              : {}),
          };
          this.tasks.push(task);
          return { ...task };
        });
      }

      // -- A1 lifecycle (modeled on the service source, see header) -----------

      case "sandbox.stop": {
        const name = String(params.name ?? "");
        const box = this.sandboxes.find((b) => b.name === name);
        if (box === undefined) return err("NOT_FOUND", `sandbox ${JSON.stringify(name)} is not listed by sbx`);
        box.status = "stopped";
        if (this.stopRequeryFails) return ok({ stopped: true });
        return ok({
          stopped: true,
          requeried: {
            name: box.name,
            probedState: box.status,
            boundProjectId: box.bound ? "p1" : null,
            ...(box.agent === undefined ? {} : { agent: box.agent }),
          },
        });
      }
      case "sandbox.remove": {
        const name = String(params.name ?? "");
        const token = params.confirmToken;
        if (token === undefined) {
          const box = this.sandboxes.find((b) => b.name === name);
          if (box === undefined) {
            return err("NOT_FOUND", `sandbox ${JSON.stringify(name)} is not listed by sbx`);
          }
          this.tokenSeq += 1;
          const minted = this.tokenSeq.toString(16).padStart(64, "0");
          const expiresAtMs = this.nowMs + 120_000;
          this.tokens.set(minted, { name, id: box.id, expiresAtMs });
          return ok({
            confirmation: {
              token: minted,
              expiresAt: new Date(Math.floor(expiresAtMs / 1000) * 1000)
                .toISOString()
                .replace(".000Z", "Z"),
              action: "sandbox.remove",
              target: { name, id: box.id },
              impact: [
                `removes sandbox ${name} (sbx id ${box.id}) and everything inside it; this cannot be undone`,
                ...(box.bound
                  ? []
                  : [
                      "not created by Sandpane: Core has no binding for this sandbox and cannot describe what it holds",
                    ]),
                // A4 (MODELED): describe, never refuse.
                ...this.chosenNameImpact(name),
                ...this.extraImpact,
              ],
              external: !box.bound,
            },
          });
        }
        // Step 2: the token is consumed FIRST, whatever happens next.
        const bound = typeof token === "string" ? this.tokens.get(token) : undefined;
        if (typeof token === "string") this.tokens.delete(token);
        if (bound === undefined || bound.name !== name || this.nowMs >= bound.expiresAtMs) {
          return err("VALIDATION_FAILED", TOKEN_REJECTED_MESSAGE);
        }
        const index = this.sandboxes.findIndex((b) => b.name === name);
        if (index < 0) {
          return err(
            "NOT_FOUND",
            `sandbox ${JSON.stringify(name)} is no longer listed by sbx; nothing was removed`,
          );
        }
        if (this.sandboxes[index]?.id !== bound.id) {
          return err(
            "CONFLICT",
            `sandbox ${JSON.stringify(name)} is not the sandbox that was confirmed (its sbx id changed); nothing was removed — request a new confirmation`,
          );
        }
        this.sandboxes.splice(index, 1);
        return ok({ removed: true });
      }
      // -- A3b conversation lifecycle (MODELED, see FakeConversation) ---------

      case "conversation.create": {
        const projectId = String(params.projectId ?? "");
        const project = this.projects.find((p) => p.id === projectId);
        if (project?.archivedAt !== undefined) return err("VALIDATION_FAILED", MSG_PROJECT_ARCHIVED);
        const rawTitle = typeof params.title === "string" ? params.title : "";
        const blank = Array.from(rawTitle).every((ch) => isRustWhitespace(ch.codePointAt(0) ?? 0));
        if (!blank) {
          const problem = validateConversationTitle(rawTitle, "create");
          if (problem !== null) return err("VALIDATION_FAILED", `title: ${problem}`);
        }
        this.conversationSeq += 1;
        const row: FakeConversation = {
          id: `conv-${this.conversationSeq}`,
          projectId,
          title: blank ? "Untitled conversation" : rawTitle,
          agentId: String(params.agentId ?? ""),
          createdAt: new Date(this.nowMs).toISOString().replace(".000Z", "Z"),
          ...(typeof params.sandboxId === "string" ? { sandboxId: params.sandboxId } : {}),
          messages: [],
        };
        this.conversations.push(row);
        return ok(this.conversationWire(row));
      }
      case "conversation.rename": {
        const title = typeof params.title === "string" ? params.title : "";
        if (Array.from(title).every((ch) => isRustWhitespace(ch.codePointAt(0) ?? 0))) {
          return err("VALIDATION_FAILED", MSG_TITLE_BLANK);
        }
        const problem = validateConversationTitle(title, "rename");
        if (problem !== null) return err("VALIDATION_FAILED", `title: ${problem}`);
        const conversation = this.conversations.find((c) => c.id === params.conversationId);
        if (conversation === undefined) return err("NOT_FOUND", MSG_CONVERSATION_NOT_FOUND);
        const refusal = this.writableRefusal(conversation);
        if (refusal !== null) return err(...refusal);
        conversation.title = title;
        return ok(this.conversationWire(conversation));
      }
      case "conversation.archive":
      case "conversation.unarchive": {
        const conversation = this.conversations.find((c) => c.id === params.conversationId);
        if (conversation === undefined) return err("NOT_FOUND", MSG_CONVERSATION_NOT_FOUND);
        if (request.method === "conversation.unarchive") {
          const project = this.projects.find((p) => p.id === conversation.projectId);
          if (project?.archivedAt !== undefined) return err("VALIDATION_FAILED", MSG_PROJECT_ARCHIVED);
          delete conversation.archivedAt;
        } else if (conversation.archivedAt === undefined) {
          conversation.archivedAt = new Date(this.nowMs).toISOString().replace(".000Z", "Z");
        }
        return ok(this.conversationWire(conversation));
      }
      case "conversation.delete": {
        const id = String(params.conversationId ?? "");
        const token = params.confirmToken;
        if (token === undefined) {
          const conversation = this.conversations.find((c) => c.id === id);
          if (conversation === undefined) return err("NOT_FOUND", MSG_CONVERSATION_NOT_FOUND);
          if (this.hasUnfinishedTasks(id)) return err("CONFLICT", MSG_CONVERSATION_HAS_TASKS);
          this.tokenSeq += 1;
          const minted = (0x2000 + this.tokenSeq).toString(16).padStart(64, "0");
          const expiresAtMs = this.nowMs + 120_000;
          this.conversationTokens.set(minted, { id, expiresAtMs });
          const tasks = this.tasks.filter((t) => t.conversationId === id).length;
          const messages = conversation.messages.length;
          return ok({
            confirmation: {
              token: minted,
              expiresAt: new Date(Math.floor(expiresAtMs / 1000) * 1000)
                .toISOString()
                .replace(".000Z", "Z"),
              action: "conversation.delete",
              target: { name: conversation.title, id },
              impact: [
                `deletes conversation ${conversation.title} and all of its Core records; this cannot be undone`,
                `${messages} ${messages === 1 ? "message" : "messages"} and ${tasks} ${tasks === 1 ? "task" : "tasks"} are deleted, with their task events, artifacts and verification records`,
                "0 Core-allocated worktree directories and 0 task branches in host repositories are left in place; Core never touches host files, worktrees or branches",
                conversation.sandboxId === undefined
                  ? "no sandbox was chosen at creation; no sandbox is touched"
                  : `the sandbox chosen at creation (${conversation.sandboxId}) is not touched`,
                ...this.extraImpact,
              ],
              external: false,
            },
          });
        }
        // Step 2: the token is consumed FIRST, whatever happens next.
        const bound = typeof token === "string" ? this.conversationTokens.get(token) : undefined;
        if (typeof token === "string") this.conversationTokens.delete(token);
        if (bound === undefined || bound.id !== id || this.nowMs >= bound.expiresAtMs) {
          return err("VALIDATION_FAILED", TOKEN_REJECTED_MESSAGE);
        }
        const index = this.conversations.findIndex((c) => c.id === id);
        if (index < 0) return err("NOT_FOUND", MSG_CONVERSATION_NOT_FOUND);
        if (this.hasUnfinishedTasks(id)) return err("CONFLICT", MSG_CONVERSATION_HAS_TASKS);
        const taskIds = new Set(this.tasks.filter((t) => t.conversationId === id).map((t) => t.id));
        for (let i = this.tasks.length - 1; i >= 0; i -= 1) {
          if (taskIds.has(this.tasks[i]?.id ?? "")) this.tasks.splice(i, 1);
        }
        for (let i = this.events.length - 1; i >= 0; i -= 1) {
          if (taskIds.has(this.events[i]?.taskId ?? "")) this.events.splice(i, 1);
        }
        this.conversations.splice(index, 1);
        return ok({ deleted: true });
      }
      case "conversation.export": {
        const refusal = this.scopingRefusal(params.conversationId, "conversationId");
        if (refusal !== null) return err("VALIDATION_FAILED", refusal);
        const conversation = this.conversations.find((c) => c.id === params.conversationId);
        if (conversation === undefined) return err("NOT_FOUND", MSG_CONVERSATION_NOT_FOUND);
        const limit = Math.min(this.clampLimit(params.limit), this.exportPageRows ?? MAX_LIST_LIMIT);
        const after = Math.max(0, Number(params.afterSequence ?? 0));
        const rows = conversation.messages.filter((m) => m.sequence > after);
        const pageRows = rows.slice(0, limit);
        const byKind = new Map<string, number>();
        const add = (counts: Record<string, number>) => {
          for (const [kind, n] of Object.entries(counts)) {
            if (n > 0) byKind.set(kind, (byKind.get(kind) ?? 0) + n);
          }
        };
        // The title is redacted on every page, COUNTED only on the first.
        const title = this.titleRedaction?.title ?? conversation.title;
        if (after === 0 && this.titleRedaction !== null) add(this.titleRedaction.byKind);
        const messages = pageRows.map((m) => {
          const redacted = this.messageRedaction?.(m.content);
          if (redacted !== undefined) add(redacted.byKind);
          return {
            id: `m-${conversation.id}-${m.sequence}`,
            conversationId: conversation.id,
            role: m.role,
            content: redacted?.content ?? m.content,
            sequence: m.sequence,
          };
        });
        const kinds = Object.fromEntries(byKind);
        return ok({
          format: "sandpane.conversation-export.v1",
          exportedAt: new Date(this.nowMs).toISOString().replace(".000Z", "Z"),
          conversation: { ...this.conversationWire(conversation), title },
          messages,
          truncated: rows.length > pageRows.length,
          nextSequence: pageRows.length > 0 ? pageRows[pageRows.length - 1]?.sequence ?? after : after,
          redaction: {
            bestEffort: true,
            replacements: [...byKind.values()].reduce((a, b) => a + b, 0),
            byKind: kinds,
          },
        });
      }
      default:
        return err("VALIDATION_FAILED", `unknown method ${request.method}`);
    }
  }

  /** `Conversation` as Core serializes it: `archivedAt` / `sandboxId` only when set. */
  private conversationWire(c: FakeConversation): Record<string, unknown> {
    return {
      id: c.id,
      projectId: c.projectId,
      title: c.title,
      agentId: c.agentId,
      createdAt: c.createdAt,
      ...(c.archivedAt === undefined ? {} : { archivedAt: c.archivedAt }),
      ...(c.sandboxId === undefined ? {} : { sandboxId: c.sandboxId }),
    };
  }

  /**
   * `require_writable_conversation` (MODELED): the PROJECT refusal first (an
   * unknown project stays lenient), then the archived conversation.
   */
  /** Does this double's `system.probe` advertise `feature`? */
  private advertises(feature: string): boolean {
    const features = this.options.features === undefined ? A2_CORE_FEATURES : this.options.features;
    return features !== null && !this.options.legacyCore && features.includes(feature);
  }

  /** A4 `sandbox.remove` impact: unfinished tasks whose chat chose `name`. */
  private chosenNameImpact(name: string): string[] {
    if (!this.advertises("conversation-send-mode")) return [];
    const n = this.tasks.filter(
      (t) => t.chosenSandboxName === name && !TERMINAL_TASK_STATUSES.has(String(t.status)),
    ).length;
    return n === 0 ? [] : [FakeCore.chosenNameImpactLine(n)];
  }

  private writableRefusal(conversation: FakeConversation): [string, string] | null {
    const project = this.projects.find((p) => p.id === conversation.projectId);
    if (project?.archivedAt !== undefined) return ["VALIDATION_FAILED", MSG_PROJECT_ARCHIVED];
    if (conversation.archivedAt !== undefined) return ["VALIDATION_FAILED", MSG_CONVERSATION_ARCHIVED];
    return null;
  }

  /** §3.3 item 5: any non-terminal (or unreadable) task status blocks a delete. */
  private hasUnfinishedTasks(conversationId: string): boolean {
    return this.tasks.some(
      (t) => t.conversationId === conversationId && !TERMINAL_TASK_STATUSES.has(String(t.status)),
    );
  }

  /**
   * MODELED §3.1 item 5: a stored `done` key with the same fingerprint answers
   * the FIRST response plus `replayed: true` and runs nothing; a different
   * fingerprint, a `pending` or an `unknown` key is the matching CONFLICT.
   * Without a key the write simply runs.
   */
  private keyed(
    method: string,
    params: Record<string, unknown>,
    ok: (payload: unknown) => Record<string, unknown>,
    err: (code: string, message: string) => Record<string, unknown>,
    run: () => Record<string, unknown>,
  ): Record<string, unknown> {
    const key = params.idempotencyKey;
    if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(key))) {
      return err("VALIDATION_FAILED", "idempotencyKey: invalid");
    }
    const { idempotencyKey: _key, ...rest } = params;
    const hash = JSON.stringify(rest);
    const slot = typeof key === "string" ? `${method}\u0000${key}` : null;
    if (slot !== null) {
      const stored = this.idempotency.get(slot);
      if (stored !== undefined) {
        if (stored.state !== "done") {
          return err(
            "CONFLICT",
            stored.state === "pending" ? FAKE_IDEM_MSG_PENDING : FAKE_IDEM_MSG_UNKNOWN,
          );
        }
        if (stored.hash !== hash) return err("CONFLICT", FAKE_IDEM_MSG_MISMATCH);
        return ok({ ...(stored.result as Record<string, unknown>), replayed: true });
      }
    }
    const result = run();
    // A refusal from the run is Core's verdict before any write: nothing is
    // counted as run and nothing is stored under the key.
    if (Array.isArray(result.refused)) {
      const [code, message] = result.refused as [string, string];
      return err(code, message);
    }
    this.ran[method] = (this.ran[method] ?? 0) + 1;
    if (slot !== null) this.idempotency.set(slot, { state: "done", hash, result });
    return ok(result);
  }

  /** Mark a stored key `pending` / `unknown` (models in-flight / restart). */
  setKeyState(method: string, key: string, state: "pending" | "unknown"): void {
    this.idempotency.set(`${method}\u0000${key}`, { state });
  }

  /**
   * `task.subscribe` cursor resolution, mirroring `task_subscribe` in Rust:
   * a `taskId` replays that one task from the SCALAR (a map is ignored), and a
   * scope-wide replay uses each task's own map cursor (missing ⇒ 0) or, with no
   * map, the shared scalar.
   */
  private replay(params: Record<string, unknown>): TaskEvent[] {
    const taskId = typeof params.taskId === "string" ? params.taskId : undefined;
    const scalar = Number(params.afterSequence ?? 0);
    const map = params.afterSequences as Record<string, number> | undefined;
    if (taskId !== undefined) {
      return this.events.filter((e) => e.taskId === taskId && e.sequence > scalar);
    }
    const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
    const ids = new Set(
      this.events
        .filter((e) => projectId === undefined || this.taskBelongsTo(e.taskId, projectId))
        .map((e) => e.taskId),
    );
    const out: TaskEvent[] = [];
    for (const id of ids) {
      const cursor = map === undefined ? scalar : Math.max(0, map[id] ?? 0);
      out.push(...this.events.filter((e) => e.taskId === id && e.sequence > cursor));
    }
    return out.sort((a, b) => a.sequence - b.sequence);
  }

  private taskBelongsTo(taskId: string, projectId: string): boolean {
    const task = this.tasks.find((t) => t.id === taskId);
    if (task === undefined) return false;
    return this.conversations.some(
      (c) => c.id === task.conversationId && c.projectId === projectId,
    );
  }

  /** Core's `validate_scoping_id`: a present id must be non-empty and bounded. */
  private scopingRefusal(value: unknown, kind: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") return `${kind}: value must be a string`;
    if (value.length === 0) return `${kind}: value is empty`;
    // Rust bounds `chars().count()`, so the double must not count UTF-16 units.
    if (Array.from(value).length > MAX_SCOPING_ID_LEN) {
      return `${kind}: value exceeds max length ${MAX_SCOPING_ID_LEN}`;
    }
    return null;
  }

  /** Core's `clamp_limit`: absent → default, out of range → clamped, never 0. */
  private clampLimit(value: unknown): number {
    if (value === undefined || value === null) return 200;
    const n = Number(value);
    return Math.min(Math.max(n, 1), MAX_LIST_LIMIT);
  }
}

/** Convenience for tests: a Core status literal. */
export type FakeTaskStatus = TaskStatus;
