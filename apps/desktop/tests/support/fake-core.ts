/**
 * In-memory duplex plus a miniature Core server for unit tests.
 *
 * The server side implements only what the real `sandpane-service` contract
 * specifies for the methods the desktop calls: `{v,id,...}` frames, one response
 * per request, `ok` XOR `err`, `snake_case`/`SCREAMING_SNAKE` payloads, and
 * `task.subscribe` as a one-shot replay from `afterSequence` (the real service has
 * no push frames). It is a test double for the peer, never a fixture shipped as
 * app data — the app itself has no fake transport path.
 */

import { encodeFrame } from "../../src/lib/framing";
import type { CoreTransport } from "../../src/lib/core-client";
import { PROTOCOL_VERSION, type TaskEvent } from "../../src/lib/protocol";

export interface FakeCoreOptions {
  /** Fail the first N probe requests with a transport-level drop instead of answering. */
  dropFirstRequests?: number;
  /** Answer with a delay (ms) to exercise correlation. */
  latencyMs?: number;
}

export class FakeCore {
  private readonly listeners: ((line: string) => void)[] = [];
  readonly events: TaskEvent[] = [];
  /** Every request frame the client sent, decoded. */
  readonly requests: { v: number; id: string; method: string; params: unknown }[] = [];
  public probeCount = 0;
  public requestCount = 0;
  private failNext = 0;

  constructor(private readonly options: FakeCoreOptions = {}) {}

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

    switch (request.method) {
      case "system.probe":
        this.probeCount += 1;
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          coreVersion: "0.1.0",
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
        });
      case "project.list":
        return ok([]);
      case "sandbox.list":
        return err("NOT_INSTALLED", "sbx executable not found");
      case "task.subscribe": {
        const params = (request.params ?? {}) as {
          taskId?: string;
          projectId?: string;
          afterSequence?: number;
        };
        const after = params.afterSequence ?? 0;
        const replay = this.events.filter(
          (event) =>
            event.sequence > after &&
            (params.taskId === undefined || event.taskId === params.taskId),
        );
        return ok(replay);
      }
      case "task.cancel":
        return ok({ requested: true });
      default:
        return err("VALIDATION_FAILED", `unknown method ${request.method}`);
    }
  }

}
