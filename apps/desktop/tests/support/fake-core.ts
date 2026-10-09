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
}

export interface FakeConversation extends Conversation {
  /** Rows Core holds in `messages`; `conversation.history` pages over these. */
  messages: { sequence: number; role: string; content: string }[];
  archived?: boolean;
}

export class FakeCore {
  private readonly listeners: ((line: string) => void)[] = [];
  readonly events: TaskEvent[] = [];
  readonly tasks: TaskSummary[] = [];
  readonly conversations: FakeConversation[] = [];
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
      this.send(encodeFrame(this.answer(request)));
    };
    if (this.options.latencyMs) setTimeout(respond, this.options.latencyMs);
    else respond();
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
          capabilities.methods = [
            "system.probe",
            "project.create",
            "project.list",
            "sandbox.list",
            "sandbox.create",
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
        }
        return ok(capabilities);
      }
      case "project.list":
        return ok([]);
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
        return ok(
          this.conversations
            .filter((c) => !c.archived && (projectId === undefined || c.projectId === projectId))
            .map(({ id, projectId: pid, title, agentId, createdAt }) => ({
              id,
              projectId: pid,
              title,
              agentId,
              createdAt,
            }))
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
        if (conversation === undefined || conversation.archived) {
          return err("NOT_FOUND", "conversation not found");
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
      default:
        return err("VALIDATION_FAILED", `unknown method ${request.method}`);
    }
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
