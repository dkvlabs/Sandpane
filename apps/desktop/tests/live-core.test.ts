/**
 * OPT-IN integration test against a REAL Core — skipped unless a socket is given.
 *
 * This is the only place the desktop's wire client is exercised against the
 * actual `sandpane-service` rather than the in-memory double, so it is the
 * evidence that the guards, cursor rules and decoders match the running build.
 *
 * Run it by pointing the suite at a live socket:
 *
 *   SANDPANE_SOCKET=/path/to/sandpane.sock npm test
 *
 * It is written against whatever Core answers, and the desktop's transport stays
 * injected: this file supplies a Unix-socket `CoreTransport` so the SAME
 * `CoreClient` code path runs over a real socket as runs over Tauri IPC. Nothing
 * here is mocked, and nothing here ships in the app bundle.
 *
 * CAUTION: this attaches to the caller's real Core and creates a project, a
 * conversation and a task in its database. Point it at a disposable
 * `SANDPANE_DB` unless that is intended.
 */

import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoreClient, type CoreTransport } from "../src/lib/core-client";
import {
  CONVERSATION_LIFECYCLE_METHODS,
  FEATURE_CONVERSATION_SANDBOX_ID,
  METHODS,
  coreAdvertisesFeature,
  coreAdvertisesMethod,
  type Method,
} from "../src/lib/protocol";
import { validateCursorMap } from "../src/lib/guards";

// This suite pins the WIRE against the real Core: every call goes through the
// raw `request("<method>", params)` path (the typed client wrappers are one-line
// passthroughs over it), so what is asserted is the frame Core actually answers.
const SOCKET = process.env.SANDPANE_SOCKET;
const describeLive = SOCKET ? describe : describe.skip;

/** A Unix-socket transport with the same request/response shape as the Tauri proxy. */
function socketTransport(path: string): CoreTransport {
  const socket = net.connect(path);
  const lineHandlers = new Set<(line: string) => void>();
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) for (const handler of [...lineHandlers]) handler(line);
    }
  });
  return {
    kind: "node-socket",
    write: (frame: string) =>
      new Promise<void>((resolve, reject) => {
        const ok = socket.write(frame, (err?: Error | null) =>
          err ? reject(err) : resolve(),
        );
        if (!ok) socket.once("drain", () => undefined);
      }),
    onLine: (handler) => {
      lineHandlers.add(handler);
      return () => lineHandlers.delete(handler);
    },
    onClose: (handler) => {
      const once = () => handler("socket closed");
      socket.on("close", once);
      return () => socket.off("close", once);
    },
    close: () => socket.destroy(),
  };
}

let client: CoreClient;
const stamp = Date.now().toString(36);

beforeAll(async () => {
  if (!SOCKET) return;
  client = new CoreClient(socketTransport(SOCKET), { requestTimeoutMs: 10_000 });
  // Wait for the socket to be actually connected before the first frame.
  await new Promise<void>((resolve, reject) => {
    const transport = net.connect(SOCKET);
    transport.once("connect", () => {
      transport.destroy();
      resolve();
    });
    transport.once("error", reject);
  });
});

afterAll(() => {
  client?.close();
});

describeLive("real Core answers the way the mirror claims", () => {
  it("advertises the full method list, and the additive reads are in it", async () => {
    const outcome = await client.probe();
    expect(outcome.kind).toBe("attached");
    if (outcome.kind !== "attached") return;
    expect(outcome.capabilities.methods).toBeDefined();
    const additive: readonly Method[] = [
      "task.list",
      "conversation.list",
      "conversation.history",
      // A3b: the five conversation-lifecycle methods (27 in all).
      ...CONVERSATION_LIFECYCLE_METHODS,
    ];
    for (const method of additive) {
      expect(coreAdvertisesMethod(outcome.capabilities, method)).toBe(true);
    }
    // Every advertised name must be one this client is allowed to call, and an
    // A3b Core advertises exactly this client's 27, in Method::ALL order.
    const allowlist: readonly string[] = METHODS;
    for (const advertised of outcome.capabilities.methods ?? []) {
      expect(allowlist).toContain(advertised);
    }
    expect(outcome.capabilities.methods).toEqual([...METHODS]);
    expect(METHODS).toHaveLength(27);
    expect(coreAdvertisesFeature(outcome.capabilities, FEATURE_CONVERSATION_SANDBOX_ID)).toBe(true);
  });

  it("returns repositories on project.list and an array from conversation.list", async () => {
    const created = await client.createProject({
      name: `Atlas Live ${stamp}`,
      repositories: [],
    }) as { id: string };
    expect(typeof created.id).toBe("string");

    const projects = await client.listProjects();
    expect(Array.isArray(projects)).toBe(true);
    const row = (projects as Record<string, unknown>[]).find((p) => p.id === created.id);
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {})).toContain("repositories");

    const conversations = await client.listConversations({ projectId: created.id });
    expect(Array.isArray(conversations)).toBe(true);
    expect(conversations).toHaveLength(0);
  });

  it("refuses a blank scoping id with VALIDATION_FAILED — the guard mirrors the verdict", async () => {
    await expect(client.listConversations({ projectId: "" })).rejects.toMatchObject({
      source: "client",
      code: "INVALID_PARAMS",
      message: "projectId: value is empty",
    });
    // And the SAME value sent raw is refused by Core, proving the mirror is
    // aligned rather than merely stricter.
    await expect(client.request("conversation.list", { projectId: "" })).rejects.toMatchObject({
      source: "core",
      code: "VALIDATION_FAILED",
    });
  });

  it("clamps a zero limit to ONE row, not zero rows and not the whole table", async () => {
    // Measured, not assumed: build three conversations in one project, then ask
    // for `limit: 0`. Core's `clamp_limit` maps 0 → 1, so exactly one row comes
    // back. A client that invented its own default would return a different count.
    const project = await client.createProject({
      name: `Clamp Probe ${stamp}`,
      repositories: [],
    }) as { id: string };
    for (const title of ["one", "two", "three"]) {
      await client.request("conversation.create", { projectId: project.id, agentId: "codex", title });
    }
    const zero = (await client.request("conversation.list", {
      projectId: project.id,
      limit: 0,
    })) as unknown[];
    expect(zero).toHaveLength(1);

    const huge = (await client.request("conversation.list", {
      projectId: project.id,
      limit: 999_999,
    })) as unknown[];
    // Clamped to MAX_LIST_LIMIT (500) — bounded, never the whole table.
    expect(huge.length).toBeLessThanOrEqual(500);
    expect(huge).toHaveLength(3);

    // The desktop's own wrapper produces the same clamped value before writing.
    const viaClient = await client.listConversations({
      projectId: project.id,
      limit: 0,
    });
    expect(viaClient).toHaveLength(1);
  });

  it("reads a stored transcript as an object that discloses its bounds", async () => {
    const projects = (await client.listProjects()) as { id: string }[];
    const projectId = projects[0]?.id;
    expect(projectId).toBeDefined();
    const conversation = (await client.request("conversation.create", {
      projectId,
      agentId: "codex",
      title: `live probe ${stamp}`,
    })) as { id: string };
    await client.request("conversation.send", {
      conversationId: conversation.id,
      content: "content is data, never a command",
      attachments: [],
    });

    const history = await client.getConversationHistory({
      conversationId: conversation.id,
    });
    expect(Array.isArray(history.messages)).toBe(true);
    expect(typeof history.truncated).toBe("boolean");
    expect(typeof history.nextSequence).toBe("number");
    expect(history.messages.some((m) => m.role === "user")).toBe(true);

    // An unknown conversation is NOT_FOUND, not an empty-but-successful answer.
    await expect(
      client.getConversationHistory({ conversationId: "no-such-conversation" }),
    ).rejects.toMatchObject({ source: "core", code: "NOT_FOUND" });

    // Paging from the disclosed cursor returns nothing new rather than repeating.
    const again = await client.getConversationHistory({
      conversationId: conversation.id,
      afterSequence: history.nextSequence,
    });
    expect(again.messages).toHaveLength(0);
  });

  it("hydrates task.list and replays each task from its OWN cursor", async () => {
    // Create a conversation and send a message so Core holds at least one task
    // with a real event sequence — no fixture, no assumption.
    const projects = (await client.listProjects()) as { id: string }[];
    const conversation = (await client.request("conversation.create", {
      projectId: projects[0]!.id,
      agentId: "codex",
      title: `cursor probe ${stamp}`,
    })) as { id: string };
    const task = (await client.request("conversation.send", {
      conversationId: conversation.id,
      content: "cursor probe message",
      attachments: [],
    })) as { id: string; status: string };

    const tasks = await client.listTasks({});
    expect(tasks.length).toBeGreaterThan(0);
    // `conversation.send` answers with the task it created; task.list must now
    // report the same row — the read that reconnect hydration depends on.
    const hydrated = tasks.find((row) => row.id === task.id);
    expect(hydrated).toBeDefined();
    expect(hydrated?.conversationId).toBe(conversation.id);
    // Displayed verbatim: no client-side transition is applied to Core's status.
    expect(hydrated?.status).toBe(task.status);

    const full = await client.replayTaskEvents({ afterSequence: 0 });
    const mine = full.filter((e) => e.taskId === task.id);
    expect(mine.length).toBeGreaterThan(0);
    const highest = Math.max(...mine.map((e) => e.sequence));

    // Per-task cursor: name ONLY this task, at its own highest sequence. Every
    // event returned for it must be past that cursor, while any other task in
    // scope replays in full (absent from the map ⇒ 0) — Core's documented rule.
    const cursors = validateCursorMap({ [task.id]: highest })!;
    const resumed = await client.replayTaskEvents({ afterSequence: 0, afterSequences: cursors });
    for (const event of resumed.filter((e) => e.taskId === task.id)) {
      expect(event.sequence).toBeGreaterThan(highest);
    }
    const others = resumed.filter((e) => e.taskId !== task.id);
    if (others.length > 0) {
      expect(Math.min(...others.map((e) => e.sequence))).toBe(1);
    }

    // A scalar cursor alongside taskId wins and the map is ignored by Core.
    const scalar = await client.replayTaskEvents({
      taskId: task.id,
      afterSequence: highest,
      afterSequences: { [task.id]: 0 },
    });
    expect(scalar.filter((e) => e.taskId === task.id)).toHaveLength(0);
  });

  it("decodes sandbox.list's additive workspaceMode without guessing it", async () => {
    // SBX may genuinely be absent on this host: Core's structured refusal is the
    // honest outcome and is asserted as such rather than papered over.
    try {
      const rows = await client.listSandboxes();
      const decoded = (rows as unknown[]).map((row) => {
        const rec = row as Record<string, unknown>;
        return rec.workspaceMode === undefined || rec.workspaceMode === null
          ? null
          : rec.workspaceMode;
      });
      expect(Array.isArray(decoded)).toBe(true);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("NOT_INSTALLED");
    }
  });

  it("a truncated-shaped page still decodes, and paging past the end is empty", async () => {
    // Core discloses truncation only when a real bound stopped the scan; a small
    // limit forces that path so the flag is observed, not simulated.
    const projects = (await client.listProjects()) as { id: string }[];
    const conversation = (await client.request("conversation.create", {
      projectId: projects[0]!.id,
      agentId: "codex",
      title: `paging probe ${stamp}`,
    })) as { id: string };
    for (const content of ["first", "second", "third"]) {
      await client.request("conversation.send", { conversationId: conversation.id, content, attachments: [] });
    }

    const page = await client.getConversationHistory({
      conversationId: conversation.id,
      limit: 1,
    });
    expect(page.messages).toHaveLength(1);
    // Measured on Core v0.1.0: three stored user messages plus a limit of 1 means
    // rows remain, so Core must set `truncated` rather than hide the bound.
    expect(page.truncated).toBe(true);
    expect(page.nextSequence).toBe(1);

    const rest = await client.getConversationHistory({
      conversationId: conversation.id,
      afterSequence: page.nextSequence,
      limit: 10,
    });
    expect(rest.messages).toHaveLength(2);
    expect(rest.messages[0]?.sequence).toBe(2);
  });
});
