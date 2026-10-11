/**
 * A3a project lifecycle on the desktop (design 2026-10-09 §3.2): wire frames,
 * gating, the two-step delete, honest copy for every exact Core message,
 * validators against Core's rule, the archived UI state, and drift against the
 * Rust sources read from disk.
 *
 * The FakeCore A3a behaviour is MODELED on `project_lifecycle.rs` (working
 * tree), not captured from a live Core. Hidden characters are built with
 * `String.fromCodePoint` so no raw invisible character lives in this file.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CoreClient,
  CoreRequestError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  REPLAY_SAFE_METHODS,
  requestTimeoutFor,
  type CoreTransport,
} from "../src/lib/core-client";
import { decodeProjectDeleteResult, decodeProjects } from "../src/lib/decode";
import { MalformedFrameError } from "../src/lib/framing";
import { buildProjectRepositoryParams, buildProjectUpdateParams } from "../src/lib/guards";
import {
  CONVERSATION_LIFECYCLE_METHODS,
  METHODS,
  PROJECT_LIFECYCLE_METHODS,
  type ConfirmationRequest,
  type Project,
} from "../src/lib/protocol";
import {
  PROJECT_MESSAGE_CONSTS,
  MSG_PROJECT_ARCHIVED,
  MSG_PROJECT_CREATE_IN_FLIGHT,
  MSG_PROJECT_HAS_SANDBOXES,
  MSG_PROJECT_HAS_TASKS,
  MSG_PROJECT_NOT_FOUND,
  MSG_REPOSITORY_IN_USE,
  MSG_REPOSITORY_NOT_REGISTERED,
  MSG_REPOSITORY_REMOVE_WHILE_CREATING,
  MSG_REPOSITORY_UNREGISTERED_DURING_CREATE,
  MSG_UPDATE_NEEDS_A_FIELD,
} from "../src/lib/project-messages";
import {
  ProjectDeletionFlow,
  TOKEN_REJECTED_MESSAGE as CLIENT_TOKEN_REJECTED,
  archivedBlock,
  archivedLabel,
  deletionFailureCopy,
  forgetProjectLocally,
  planProjectUpdate,
  projectCacheIds,
  projectLifecycleGates,
} from "../src/lib/project-lifecycle";
import { describeCoreError } from "../src/lib/reducers";
import { MAX_IMPACT_LINES, confirmationView } from "../src/lib/sandbox-lifecycle";
import {
  PROJECT_DESCRIPTION_MAX,
  PROJECT_NAME_MAX,
  isSpoofingFormatChar,
  validateProjectDescription,
  validateProjectName,
} from "../src/lib/wizard";
import {
  addConversation,
  clearConversations,
  forgetProjectConversations,
  listConversations,
} from "../src/lib/conversation-store";
import {
  ProjectDeleteConsequence,
  ProjectDeletionNotices,
  ProjectSettingsPanel,
} from "../src/features/projects/ProjectSettings";
import { CoreProvider, buildDeps } from "../src/app/context";
import { TaskEventStore } from "../src/lib/event-store";
import { A1_CORE_METHODS, A3A_CORE_METHODS, FakeCore } from "./support/fake-core";
import {
  CONFIRM_RUST,
  PROJECT_LIFECYCLE_RUST,
  VALIDATION_RUST,
  desktopProxyRustSource,
  repoFile,
  rustMethodAll,
  rustStrConst,
  rustUsizeConst,
} from "./support/rust-source";

const cp = (n: number): string => String.fromCodePoint(n);

function core(options: ConstructorParameters<typeof FakeCore>[0] = {}) {
  const fake = new FakeCore({ advertisedMethods: A3A_CORE_METHODS, ...options });
  const client = new CoreClient(fake.transport, { requestTimeoutMs: 60 });
  return { fake, client };
}

async function failure(p: Promise<unknown>): Promise<CoreRequestError> {
  const err = await p.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CoreRequestError);
  return err as CoreRequestError;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A transport whose every answer the test scripts; records written frames. */
function scripted(answer: (method: string) => { ok?: unknown; err?: unknown }) {
  const writes: string[] = [];
  let handlers: ((line: string) => void)[] = [];
  const transport: CoreTransport = {
    kind: "memory",
    write(frame: string) {
      writes.push(frame);
      const parsed = JSON.parse(frame) as { id: string; method: string };
      const line = `${JSON.stringify({ v: 1, id: parsed.id, ...answer(parsed.method) })}\n`;
      queueMicrotask(() => {
        for (const h of [...handlers]) h(line);
      });
    },
    onLine(handler) {
      handlers.push(handler);
      return () => {
        handlers = handlers.filter((h) => h !== handler);
      };
    },
    onClose: () => () => {},
    close: () => {},
  };
  return { transport, writes };
}

// ---------------------------------------------------------------------------
// Drift: every pinned list, messages, validators
// ---------------------------------------------------------------------------

describe("A3a drift against the Rust sources", () => {
  it("the six methods sit right after project.list, in Method::ALL order (27 total since A3b)", () => {
    const all = rustMethodAll().names;
    expect(all).toHaveLength(27);
    expect(METHODS).toEqual(all);
    const at = METHODS.indexOf("project.list");
    expect(METHODS.slice(at + 1, at + 7)).toEqual([...PROJECT_LIFECYCLE_METHODS]);
    // The A3a Core's set is today's minus the five A3b conversation methods.
    expect(A3A_CORE_METHODS).toEqual(
      METHODS.filter((m) => !(CONVERSATION_LIFECYCLE_METHODS as readonly string[]).includes(m)),
    );
  });

  it("none of the six is replay-safe on either side, and each has the default deadline", () => {
    const proxy = desktopProxyRustSource();
    const replayBody = /fn replay_safe\(method: Method\) -> bool \{([\s\S]*?)\n\}/.exec(proxy)?.[1] ?? "";
    const deadlineBody =
      /pub fn proxy_deadline_ms\(method: Method\) -> u64 \{([\s\S]*?)\n\}/.exec(proxy)?.[1] ?? "";
    expect(replayBody).toContain("Method::ProjectList");
    for (const method of PROJECT_LIFECYCLE_METHODS) {
      expect(REPLAY_SAFE_METHODS.has(method)).toBe(false);
      // add_repository runs Core's git canonicalization (up to 30 s), like project.create.
      expect(requestTimeoutFor(method)).toBe(
        method === "project.add_repository" ? 45_000 : DEFAULT_REQUEST_TIMEOUT_MS,
      );
    }
    for (const variant of [
      "ProjectUpdate",
      "ProjectArchive",
      "ProjectUnarchive",
      "ProjectDelete",
      "ProjectAddRepository",
      "ProjectRemoveRepository",
    ]) {
      expect(replayBody).not.toContain(`Method::${variant}`);
    }
    for (const variant of ["ProjectUpdate", "ProjectArchive", "ProjectUnarchive", "ProjectDelete", "ProjectRemoveRepository"]) {
      expect(deadlineBody).not.toContain(`Method::${variant}`);
    }
    expect(deadlineBody).toContain("Method::ProjectCreate => 43_000,");
    expect(deadlineBody).toContain("Method::ProjectAddRepository => 43_000,");
    expect(proxy).toContain("assert_eq!(Method::ALL.len(), 27);");
  });

  it("every exact message equals the Rust const of the same name", () => {
    for (const [name, value] of Object.entries(PROJECT_MESSAGE_CONSTS)) {
      expect(rustStrConst(PROJECT_LIFECYCLE_RUST, name), name).toBe(value);
    }
    expect(rustStrConst(CONFIRM_RUST, "TOKEN_REJECTED_MESSAGE")).toBe(CLIENT_TOKEN_REJECTED);
    expect(rustStrConst(PROJECT_LIFECYCLE_RUST, "PROJECT_DELETE_ACTION")).toBe("project.delete");
  });

  it("the validators' bounds and character rules are Core's", () => {
    expect(rustUsizeConst(VALIDATION_RUST, "MAX_PROJECT_NAME_CHARS")).toBe(PROJECT_NAME_MAX);
    expect(rustUsizeConst(VALIDATION_RUST, "MAX_PROJECT_DESCRIPTION_CHARS")).toBe(
      PROJECT_DESCRIPTION_MAX,
    );
    const source = repoFile(VALIDATION_RUST);
    // The exact predicates the client mirrors (a change here must fail the suite).
    expect(source).toContain(".find(|c| c.is_control() || is_spoofing_format_char(*c))");
    expect(source).toContain(
      ".find(|c| (c.is_control() && *c != '\\n') || is_spoofing_format_char(*c))",
    );
    // The spoofing set, parsed out of `is_spoofing_format_char`.
    const body = /fn is_spoofing_format_char\(c: char\) -> bool \{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body).toBeDefined();
    const rust = new Set<number>();
    const item = /'\\u\{([0-9A-Fa-f]+)\}'\s*(?:\.\.=\s*'\\u\{([0-9A-Fa-f]+)\}')?/g;
    for (const m of (body ?? "").matchAll(item)) {
      const lo = parseInt(m[1] ?? "", 16);
      const hi = m[2] === undefined ? lo : parseInt(m[2], 16);
      for (let c = lo; c <= hi; c += 1) rust.add(c);
    }
    expect(rust.size).toBe(14);
    for (let c = 0; c <= 0x3000; c += 1) {
      expect(isSpoofingFormatChar(c), `U+${c.toString(16)}`).toBe(rust.has(c));
    }
  });
});

// ---------------------------------------------------------------------------
// Validators against Core's own corpus (validation.rs tests)
// ---------------------------------------------------------------------------

const SPOOFING = [
  0x2028, 0x2029, 0x200e, 0x200f, 0x061c, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069,
];

describe("validators mirror Validator::project_name / project_description exactly", () => {
  it("names: Core's accept and refuse corpus, counted in characters", () => {
    expect(validateProjectName("Atlas Demo — ü 漢字")).toBeNull();
    expect(validateProjectName("é".repeat(120))).toBeNull();
    // Astral characters count once (Rust chars), so 120 of them is accepted.
    expect(validateProjectName(cp(0x1d535).repeat(120))).toBeNull();
    expect(validateProjectName("é".repeat(121))).toMatch(/120/);
    expect(validateProjectName("")).toMatch(/required/);
    for (const c of [0x0a, 0x09, 0x0d, 0x00, 0x7f, 0x85, 0x9b, ...SPOOFING]) {
      const problem = validateProjectName(`a${cp(c)}b`);
      expect(problem, `U+${c.toString(16)}`).not.toBeNull();
      // The refusal names the code point and never echoes the character.
      expect(problem).not.toContain(cp(c));
    }
    // Not stricter: other format/Unicode text Core accepts stays accepted.
    expect(validateProjectName(`a${cp(0x200b)}b`)).toBeNull();
    expect(validateProjectName("Nova Demo · Orbit")).toBeNull();
  });

  it("descriptions: newline allowed, every other control refused, empty clears", () => {
    expect(validateProjectDescription("")).toBeNull();
    expect(validateProjectDescription("line one\nline two — ü 漢字")).toBeNull();
    expect(validateProjectDescription("é".repeat(2000))).toBeNull();
    expect(validateProjectDescription("é".repeat(2001))).toMatch(/2000/);
    for (const bad of ["a\tb", "a\rb", `a${cp(0)}b`, `a${cp(0x7f)}b`, `a${cp(0x85)}b`, `a${cp(0x9b)}b`, `a${cp(0x1b)}[31m`]) {
      expect(validateProjectDescription(bad)).not.toBeNull();
    }
    for (const c of SPOOFING) {
      expect(validateProjectDescription(`a${cp(c)}b`), `U+${c.toString(16)}`).not.toBeNull();
    }
  });

  it("a lone surrogate is refused locally (it cannot be sent as UTF-8; Core refuses the frame)", () => {
    for (const unit of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
      const lone = `a${String.fromCharCode(unit)}b`;
      expect(validateProjectName(lone), unit.toString(16)).toMatch(/unpaired surrogate/);
      expect(validateProjectDescription(lone), unit.toString(16)).toMatch(/unpaired surrogate/);
    }
    // A high surrogate at the very end, and a reversed pair, are lone too.
    expect(validateProjectName(`a${String.fromCharCode(0xd83d)}`)).toMatch(/unpaired surrogate/);
    expect(validateProjectName(String.fromCharCode(0xde00, 0xd83d))).toMatch(/unpaired surrogate/);
    // A proper pair is one character Core accepts.
    expect(validateProjectName(`a${cp(0x1f600)}b`)).toBeNull();
    expect(validateProjectDescription(`a${cp(0x1f600)}b`)).toBeNull();
  });

  it("update params: only changed fields, at least one, refusals never echo the value", () => {
    expect(buildProjectUpdateParams("p1", { description: "" })).toEqual({
      projectId: "p1",
      description: "",
    });
    expect(() => buildProjectUpdateParams("p1", {})).toThrow(/name or the description/);
    let message = "";
    try {
      buildProjectUpdateParams("p1", { name: `x${cp(0x202e)}y` });
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toMatch(/U\+202E/);
    expect(message).not.toContain(cp(0x202e));
    expect(() => buildProjectRepositoryParams("p1", "relative/repo")).toThrow(/absolute/);
    expect(() => buildProjectRepositoryParams("p1", "")).toThrow(/required/);
    // Sent exactly as typed — never trimmed.
    expect(buildProjectRepositoryParams("p1", "/srv/atlas ")).toEqual({
      projectId: "p1",
      path: "/srv/atlas ",
    });
  });

  it("planProjectUpdate sends only what changed and leaves a legacy name alone", () => {
    const stored = { name: `old${cp(0x0a)}name`, description: "d" };
    expect(planProjectUpdate(stored, { name: stored.name, description: "d" }).changes).toBeNull();
    const descOnly = planProjectUpdate(stored, { name: stored.name, description: "new" });
    expect(descOnly).toEqual({ changes: { description: "new" }, nameError: null, descriptionError: null });
    const renamed = planProjectUpdate(stored, { name: "Atlas Demo", description: "d" });
    expect(renamed.changes).toEqual({ name: "Atlas Demo" });
    expect(planProjectUpdate(stored, { name: "", description: "d" }).nameError).toMatch(/required/);
  });
});

// ---------------------------------------------------------------------------
// Exact frames
// ---------------------------------------------------------------------------

describe("exact frames for every A3a method", () => {
  it("project.list: {} by default, {includeArchived:true} only when asked", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo", repositories: ["/srv/atlas"] });
    fake.addProject({ id: "p2", name: "Nova Demo", archivedAt: "2026-10-10T01:00:00Z" });
    const live = await client.listProjectRows();
    expect(fake.lastParams("project.list")).toEqual({});
    expect(live.map((p) => p.id)).toEqual(["p1"]);
    expect("archivedAt" in (live[0] as Project)).toBe(false);
    const all = await client.listProjectRows(true);
    expect(fake.lastParams("project.list")).toEqual({ includeArchived: true });
    expect(all.find((p) => p.id === "p2")?.archivedAt).toBe("2026-10-10T01:00:00Z");
  });

  it("archivedAt is absent-tolerant; a mistyped one is malformed", () => {
    expect(decodeProjects([{ id: "p", name: "n", createdAt: "t" }])[0]).not.toHaveProperty("archivedAt");
    expect(decodeProjects([{ id: "p", name: "n", createdAt: "t", archivedAt: null }])[0]).not.toHaveProperty(
      "archivedAt",
    );
    expect(() => decodeProjects([{ id: "p", name: "n", createdAt: "t", archivedAt: 7 }])).toThrow(
      MalformedFrameError,
    );
  });

  it("update / archive / unarchive / add / remove write exactly their params", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo", repositories: ["/srv/atlas"] });
    await client.updateProject("p1", { name: "Orbit Demo" });
    expect(fake.lastParams("project.update")).toEqual({ projectId: "p1", name: "Orbit Demo" });
    await client.updateProject("p1", { description: "" });
    expect(fake.lastParams("project.update")).toEqual({ projectId: "p1", description: "" });
    const archived = await client.archiveProject("p1");
    expect(fake.lastParams("project.archive")).toEqual({ projectId: "p1" });
    const again = await client.archiveProject("p1");
    expect(again.archivedAt).toBe(archived.archivedAt); // idempotent, never re-stamped
    const live = await client.unarchiveProject("p1");
    expect(fake.lastParams("project.unarchive")).toEqual({ projectId: "p1" });
    expect(live).not.toHaveProperty("archivedAt");
    const added = await client.addProjectRepository("p1", "/srv/nova");
    expect(fake.lastParams("project.add_repository")).toEqual({ projectId: "p1", path: "/srv/nova" });
    expect(added.repositories).toEqual(["/srv/atlas", "/srv/nova"]);
    const removed = await client.removeProjectRepository("p1", "/srv/atlas");
    expect(fake.lastParams("project.remove_repository")).toEqual({ projectId: "p1", path: "/srv/atlas" });
    expect(removed.repositories).toEqual(["/srv/nova"]);
  });

  it("client-side refusals send nothing", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo" });
    await failure(client.updateProject("p1", {}));
    await failure(client.updateProject("p1", { name: "a\nb" }));
    await failure(client.addProjectRepository("p1", "relative"));
    await failure(client.removeProjectRepository("p1", ""));
    expect(fake.callsFor("project.update")).toBe(0);
    expect(fake.callsFor("project.add_repository")).toBe(0);
    expect(fake.callsFor("project.remove_repository")).toBe(0);
  });

  it("project.delete: step 1 is exactly {projectId}; step 2 adds only the token", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo" });
    const confirmation = await client.requestProjectDeletion("p1");
    expect(fake.lastParams("project.delete")).toEqual({ projectId: "p1" });
    expect(confirmation.action).toBe("project.delete");
    expect(confirmation.target).toEqual({ name: "Atlas Demo", id: "p1" });
    expect(confirmation.external).toBe(false);
    await client.confirmProjectDeletion("p1", confirmation.token);
    expect(fake.lastParams("project.delete")).toEqual({
      projectId: "p1",
      confirmToken: confirmation.token,
    });
    expect(fake.projects).toHaveLength(0);
  });

  it("a rename between the steps is fine (the token is bound to the id)", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo" });
    const confirmation = await client.requestProjectDeletion("p1");
    await client.updateProject("p1", { name: "Orbit Demo" });
    await expect(client.confirmProjectDeletion("p1", confirmation.token)).resolves.toEqual({ deleted: true });
  });

  it("step-1 answers that cannot be trusted are refused", async () => {
    expect(() => decodeProjectDeleteResult({ deleted: "yes" })).toThrow(MalformedFrameError);
    expect(() => decodeProjectDeleteResult({})).toThrow(MalformedFrameError);
    const confirmation = {
      token: "a".repeat(64),
      expiresAt: "2026-10-10T00:02:00Z",
      action: "project.delete",
      target: { name: "Atlas Demo", id: "p1" },
      impact: [],
      external: true,
    };
    expect(() => decodeProjectDeleteResult({ confirmation })).toThrow(/external: false/);
    expect(() =>
      decodeProjectDeleteResult({ confirmation: { ...confirmation, external: false, action: "sandbox.remove" } }),
    ).toThrow(MalformedFrameError);
  });
});

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

describe("every A3a action is gated on system.probe methods", () => {
  it("unprobed, unsupported (an A1 Core) and supported stay distinct", () => {
    const unprobed = projectLifecycleGates(null);
    expect(unprobed.update.state).toBe("unprobed");
    expect(unprobed.showArchived.state).toBe("unprobed");
    const old = projectLifecycleGates({ methods: [...A1_CORE_METHODS] });
    for (const gate of Object.values(old)) expect(gate.state).toBe("unsupported");
    expect(old.delete.note).toMatch(/does not advertise `project\.delete`/);
    const now = projectLifecycleGates({ methods: [...A3A_CORE_METHODS] });
    for (const gate of Object.values(now)) expect(gate.state).toBe("supported");
    // Advertisement is per method: a Core without delete keeps delete unsupported.
    const partial = projectLifecycleGates({
      methods: A3A_CORE_METHODS.filter((m) => m !== "project.delete"),
    });
    expect(partial.delete.state).toBe("unsupported");
    expect(partial.update.state).toBe("supported");
  });

  it("a Core that does not dispatch a method answers VALIDATION_FAILED, not a fake success", async () => {
    const fake = new FakeCore({ advertisedMethods: A1_CORE_METHODS });
    fake.addProject({ id: "p1", name: "Atlas Demo" });
    const err = await failure(new CoreClient(fake.transport).archiveProject("p1"));
    expect(err.code).toBe("VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// Honest copy for every exact message
// ---------------------------------------------------------------------------

describe("each exact Core message maps to honest copy", () => {
  const cases: [string, string, RegExp][] = [
    ["VALIDATION_FAILED", MSG_PROJECT_ARCHIVED, /^Nothing was changed — the project is archived/],
    ["VALIDATION_FAILED", MSG_UPDATE_NEEDS_A_FIELD, /^Nothing was changed/],
    ["CONFLICT", MSG_PROJECT_HAS_TASKS, /^Nothing was deleted — the project has unfinished tasks/],
    ["CONFLICT", MSG_PROJECT_HAS_SANDBOXES, /^Nothing was deleted — the project still has sandboxes/],
    ["CONFLICT", MSG_PROJECT_CREATE_IN_FLIGHT, /^Nothing was deleted — a sandbox is being created/],
    ["CONFLICT", MSG_REPOSITORY_IN_USE, /^Nothing was removed — the repository is in use/],
    ["CONFLICT", MSG_REPOSITORY_REMOVE_WHILE_CREATING, /^Nothing was removed — a sandbox is being created/],
    ["CONFLICT", MSG_REPOSITORY_UNREGISTERED_DURING_CREATE, /^Nothing was run — the repository was unregistered/],
    ["NOT_FOUND", MSG_PROJECT_NOT_FOUND, /^Nothing was changed — Core has no project/],
    ["NOT_FOUND", MSG_REPOSITORY_NOT_REGISTERED, /^Nothing was removed — the repository is not registered/],
  ];

  it.each(cases)("%s %s", (code, message, title) => {
    const copy = describeCoreError(new CoreRequestError("core", code as "CONFLICT", message));
    expect(copy.title).toMatch(title);
    expect(copy.reason).toBe(message); // Core's own text is always shown
  });

  it("the same text under another code, or other text under the code, never says 'nothing was'", () => {
    const wrongCode = describeCoreError(new CoreRequestError("core", "INTERNAL", MSG_PROJECT_HAS_TASKS));
    expect(wrongCode.title).not.toMatch(/^Nothing was/);
    const otherText = describeCoreError(
      new CoreRequestError("core", "CONFLICT", "project has tasks; nothing was deleted (reworded)"),
    );
    expect(otherText.title).not.toMatch(/^Nothing was/);
  });

  it("the real exchange: archived refusals and in-use repositories come back as Core's text", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo", repositories: ["/srv/atlas"] });
    fake.repositoriesInUse.add("/srv/atlas");
    const inUse = await failure(client.removeProjectRepository("p1", "/srv/atlas"));
    expect(describeCoreError(inUse).title).toMatch(/^Nothing was removed — the repository is in use/);
    await client.archiveProject("p1");
    for (const attempt of [
      client.updateProject("p1", { name: "Orbit Demo" }),
      client.addProjectRepository("p1", "/srv/nova"),
      client.removeProjectRepository("p1", "/srv/atlas"),
    ]) {
      const err = await failure(attempt);
      expect(err.message).toBe(MSG_PROJECT_ARCHIVED);
      expect(describeCoreError(err).title).toMatch(/archived/);
    }
    expect(fake.projects[0]?.name).toBe("Atlas Demo");
  });

  it("INTERNAL or a lost answer on a project write is an unknown outcome, never 'nothing was'", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo" });
    fake.projectFault = "internal-after-apply";
    const internal = await failure(client.archiveProject("p1"));
    expect(internal.mayHaveBeenApplied).toBe(true);
    const copy = describeCoreError(internal);
    expect(copy.title).toBe("Outcome unknown — this may have been applied");
    expect(copy.action).not.toMatch(/idempotency/);
    expect(fake.projects[0]?.archivedAt).toBeDefined(); // it WAS applied
    fake.addProject({ id: "p2", name: "Nova Demo" });
    fake.projectFault = "drop-after-apply";
    const lost = await failure(client.updateProject("p2", { name: "Orbit Demo" }));
    expect(lost.mayHaveBeenApplied).toBe(true);
    expect(describeCoreError(lost).title).toBe("Outcome unknown — this may have been applied");
    expect(fake.projects[1]?.name).toBe("Orbit Demo"); // applied: the copy was right not to deny it
  });

  it("an unreadable or wrong-project answer is unknown and never echoes the payload", async () => {
    for (const ok of [
      { id: "p2", name: "SECRET-PAYLOAD", createdAt: "t" },
      { id: "p1", name: 42, note: "SECRET-PAYLOAD" },
    ]) {
      const { transport, writes } = scripted(() => ({ ok }));
      const err = await failure(new CoreClient(transport).archiveProject("p1"));
      expect(err.mayHaveBeenApplied).toBe(true);
      expect(err.message).not.toContain("SECRET-PAYLOAD");
      expect(JSON.stringify(err.details)).not.toContain("SECRET-PAYLOAD");
      expect(writes).toHaveLength(1); // never re-sent
    }
  });
});

// ---------------------------------------------------------------------------
// Two-step delete flow
// ---------------------------------------------------------------------------

describe("ProjectDeletionFlow (A1 two-step pattern)", () => {
  function flowFor(fake: FakeCore, client: CoreClient, now?: () => number) {
    const deleted: string[] = [];
    let settled = 0;
    const flow = new ProjectDeletionFlow(client, {
      onDeleted: (id) => deleted.push(id),
      onSettled: () => (settled += 1),
      now: now ?? (() => fake.nowMs),
    });
    return { flow, deleted, settled: () => settled };
  }

  it("cancel sends nothing; a late step-1 answer after cancel is discarded unseen", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo" });
    const { flow } = flowFor(fake, client);
    const begun = flow.begin("p1");
    flow.cancel();
    await begun;
    expect(flow.getState()).toEqual({ kind: "idle" });
    await flow.begin("p1");
    expect(flow.getState().kind).toBe("confirming");
    flow.cancel();
    expect(fake.callsFor("project.delete")).toBe(2); // two step-1 frames, no step 2
    expect(fake.projects).toHaveLength(1);
  });

  it("an expired confirmation sends nothing (re-checked at click time)", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo" });
    let clock = fake.nowMs;
    const { flow } = flowFor(fake, client, () => clock);
    await flow.begin("p1");
    clock += 121_000;
    expect(flow.confirm()).toBe(false);
    const state = flow.getState();
    expect(state.kind === "failed" && state.stage).toBe("expired");
    expect(state.kind === "failed" && state.copy.title).toBe("Confirmation expired — nothing was sent");
    expect(fake.callsFor("project.delete")).toBe(1);
  });

  it("a double click sends step 2 once; the token leaves state; deleted clears local state", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo" });
    const { flow, deleted } = flowFor(fake, client);
    await flow.begin("p1");
    const confirming = flow.getState();
    const token = confirming.kind === "confirming" ? confirming.confirmation.token : "";
    expect(flow.confirm()).toBe(true);
    expect(flow.confirm()).toBe(false);
    expect(JSON.stringify(flow.getState())).not.toContain(token);
    await settle();
    expect(flow.getState().kind).toBe("deleted");
    expect(deleted).toEqual(["p1"]);
    expect(fake.callsFor("project.delete")).toBe(2);
  });

  it("step-1 and step-2 CONFLICTs say nothing was deleted; nothing is retried", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo" });
    const { flow, deleted } = flowFor(fake, client);
    fake.projectDeleteBlocker = MSG_PROJECT_HAS_SANDBOXES;
    await flow.begin("p1");
    let state = flow.getState();
    expect(state.kind === "failed" && state.stage).toBe("request");
    expect(state.kind === "failed" && state.copy.title).toMatch(/Nothing was deleted — the project still has sandboxes/);
    flow.reset();
    fake.projectDeleteBlocker = null;
    await flow.begin("p1");
    fake.projectDeleteBlocker = MSG_PROJECT_HAS_TASKS; // appeared between the steps
    flow.confirm();
    await settle();
    state = flow.getState();
    expect(state.kind === "failed" && state.outcomeUnknown).toBe(false);
    expect(state.kind === "failed" && state.copy.title).toMatch(/^Nothing was deleted — the project has unfinished tasks/);
    expect(deleted).toEqual([]);
    expect(fake.callsFor("project.delete")).toBe(3);
  });

  it("a token Core rejects says 'Confirmation refused — nothing was deleted'", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo" });
    const start = fake.nowMs;
    const { flow } = flowFor(fake, client, () => start); // client clock still in time
    await flow.begin("p1");
    fake.nowMs += 200_000; // Core's clock: expired
    flow.confirm();
    await settle();
    const state = flow.getState();
    expect(state.kind === "failed" && state.copy.title).toBe("Confirmation refused — nothing was deleted");
    expect(fake.projects).toHaveLength(1);
  });

  it("INTERNAL or a lost step-2 answer is UNKNOWN — never 'nothing was deleted'", async () => {
    for (const fault of ["internal-after-apply", "drop-after-apply"] as const) {
      const { fake, client } = core();
      fake.addProject({ id: "p1", name: "Atlas Demo" });
      const { flow, deleted } = flowFor(fake, client);
      await flow.begin("p1");
      fake.projectFault = fault;
      flow.confirm();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const state = flow.getState();
      expect(state.kind, fault).toBe("failed");
      if (state.kind !== "failed") continue;
      expect(state.outcomeUnknown).toBe(true);
      expect(state.copy.title).toBe("Outcome unknown — the project may have been deleted");
      expect(`${state.copy.title} ${state.copy.body} ${state.copy.action}`).not.toMatch(/nothing was deleted/i);
      expect(deleted).toEqual([]); // local state is only forgotten on deleted: true
      expect(fake.projects).toHaveLength(0); // Core did delete it
    }
  });

  it("unknown step 2 + a re-read that no longer lists the project → forgotten locally, said plainly", async () => {
    for (const fault of ["internal-after-apply", "drop-after-apply"] as const) {
      const { fake, client } = core();
      fake.addProject({ id: "p1", name: "Atlas Demo" });
      const gone: string[] = [];
      const flow = new ProjectDeletionFlow(client, {
        now: () => fake.nowMs,
        recheckListed: async (id) => (await client.listProjectRows(true)).some((p) => p.id === id),
        onGone: (id) => gone.push(id),
      });
      await flow.begin("p1");
      fake.projectFault = fault;
      flow.confirm();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fake.lastParams("project.list"), fault).toEqual({ includeArchived: true });
      expect(gone, fault).toEqual(["p1"]);
      const state = flow.getState();
      expect(state.kind, fault).toBe("gone");
      if (state.kind !== "gone") continue;
      expect(state.target).toEqual({ name: "Atlas Demo", id: "p1" });
    }
  });

  it("unknown step 2 + the project still listed (or the re-read fails) → stays unknown, nothing forgotten", async () => {
    for (const recheck of [async () => true, async () => null, async () => Promise.reject(new Error("x"))]) {
      const { fake, client } = core();
      fake.addProject({ id: "p1", name: "Atlas Demo" });
      const gone: string[] = [];
      const flow = new ProjectDeletionFlow(client, {
        now: () => fake.nowMs,
        recheckListed: recheck,
        onGone: (id) => gone.push(id),
      });
      await flow.begin("p1");
      // Core fails INTERNAL WITHOUT deleting: model it as a step-2 that answers INTERNAL.
      fake.projectFault = "internal-after-apply";
      fake.projectDeleteBlocker = null;
      flow.confirm();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const state = flow.getState();
      expect(state.kind).toBe("failed");
      expect(state.kind === "failed" && state.outcomeUnknown).toBe(true);
      expect(gone).toEqual([]);
    }
  });

  it("a step-2 NOT_FOUND forgets the project locally (Core has no such project)", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo" });
    const gone: string[] = [];
    const deleted: string[] = [];
    const flow = new ProjectDeletionFlow(client, {
      now: () => fake.nowMs,
      onGone: (id) => gone.push(id),
      onDeleted: (id) => deleted.push(id),
    });
    await flow.begin("p1");
    fake.projects.splice(0, 1); // deleted elsewhere between the steps
    flow.confirm();
    await settle();
    const state = flow.getState();
    expect(state.kind === "failed" && state.copy.title).toMatch(/^Nothing was changed — Core has no project/);
    expect(gone).toEqual(["p1"]);
    expect(deleted).toEqual([]); // never reported as deleted by THIS request
  });

  it("deletionFailureCopy never puts a token into copy", () => {
    const token = "b".repeat(64);
    const { copy } = deletionFailureCopy(new CoreRequestError("core", "VALIDATION_FAILED", CLIENT_TOKEN_REJECTED));
    expect(JSON.stringify(copy)).not.toContain(token);
  });

  it("step 1 answering a confirmation for another project is refused, and no step 2 follows", async () => {
    const { transport, writes } = scripted(() => ({
      ok: {
        confirmation: {
          token: "d".repeat(64),
          expiresAt: "2099-01-01T00:00:00Z",
          action: "project.delete",
          target: { name: "Atlas Demo", id: "p2" },
          impact: [],
          external: false,
        },
      },
    }));
    const flow = new ProjectDeletionFlow(new CoreClient(transport));
    await flow.begin("p1");
    const state = flow.getState();
    expect(state.kind).toBe("failed");
    expect(flow.confirm()).toBe(false);
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain("d".repeat(64));
  });

  it("step 2 answering anything but deleted: true is unknown, not a success", async () => {
    const { transport } = scripted(() => ({ ok: { deleted: false } }));
    const err = await failure(new CoreClient(transport).confirmProjectDeletion("p1", "e".repeat(64)));
    expect(err.mayHaveBeenApplied).toBe(true);
    expect(err.message).not.toContain("e".repeat(64));
  });

  it("the client itself flags a Core INTERNAL on step 2 as maybe-applied (not only the copy)", async () => {
    const { transport } = scripted(() => ({ err: { code: "INTERNAL", message: "disk I/O error" } }));
    const err = await failure(new CoreClient(transport).confirmProjectDeletion("p1", "e".repeat(64)));
    expect(err.isCoreError).toBe(true);
    expect(err.mayHaveBeenApplied).toBe(true);
    // Step 1 changes nothing in Core, so its INTERNAL is NOT flagged.
    const step1 = await failure(new CoreClient(transport).requestProjectDeletion("p1"));
    expect(step1.mayHaveBeenApplied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Archived UI state, local forgetting, markup
// ---------------------------------------------------------------------------

describe("archived state and local forgetting", () => {
  it("archived blocks update and repository changes with Core's reason; unarchive/delete stay", () => {
    const archived = { archivedAt: "2026-10-10T01:00:00Z" };
    for (const action of ["update", "addRepository", "removeRepository"] as const) {
      expect(archivedBlock(archived, action)).toContain(MSG_PROJECT_ARCHIVED);
      expect(archivedBlock({}, action)).toBeNull();
    }
    // Core also refuses new chats, messages and sandboxes on an archived project.
    expect(archivedBlock(archived, "chat")).toContain(MSG_PROJECT_ARCHIVED);
    expect(archivedBlock(archived, "sandbox")).toContain(MSG_PROJECT_ARCHIVED);
    expect(archivedBlock(archived, "unarchive")).toBeNull();
    expect(archivedBlock(archived, "delete")).toBeNull();
    expect(archivedLabel(archived)).toBe("archived 2026-10-10T01:00:00Z");
    expect(archivedLabel({ archivedAt: `t${cp(0x202e)}` })).toBe("archived t\\u202E");
    expect(archivedLabel({})).toBeNull();
  });

  it("forgetProjectLocally clears only that project's selection, chats and cached reads", () => {
    clearConversations();
    addConversation({ id: "c1", projectId: "p1", title: "a", agentId: "codex", createdAt: "t" });
    addConversation({ id: "c2", projectId: "p2", title: "b", agentId: "codex", createdAt: "t" });
    let last: string | null = "p1";
    const dropped: string[] = [];
    forgetProjectLocally("p1", {
      lastProjectId: () => last,
      clearLastProjectId: () => (last = null),
      forgetConversations: forgetProjectConversations,
      dropCachedReads: (id) => dropped.push(id),
    });
    expect(last).toBeNull();
    expect(listConversations().map((c) => c.id)).toEqual(["c2"]);
    expect(dropped).toEqual(["p1"]);
    last = "p2";
    forgetProjectLocally("p1", {
      lastProjectId: () => last,
      clearLastProjectId: () => (last = null),
      forgetConversations: forgetProjectConversations,
      dropCachedReads: () => {},
    });
    expect(last).toBe("p2");
    clearConversations();
  });

  it("cached reads are dropped BEFORE this window's chats, so their ids are still known", () => {
    clearConversations();
    addConversation({ id: "c1", projectId: "p1", title: "a", agentId: "codex", createdAt: "t" });
    const seen: string[][] = [];
    forgetProjectLocally("p1", {
      lastProjectId: () => null,
      clearLastProjectId: () => {},
      forgetConversations: forgetProjectConversations,
      dropCachedReads: () => seen.push(listConversations().map((c) => c.id)),
    });
    expect(seen).toEqual([["c1"]]);
    expect(listConversations()).toEqual([]);
  });

  it("projectCacheIds finds the project's chats and tasks, and ignores junk caches", () => {
    const ids = projectCacheIds("p1", {
      conversations: [
        { id: "c1", projectId: "p1" },
        { id: "cx", projectId: "p2" },
      ],
      sessionConversations: [{ id: "c2", projectId: "p1" }],
      projectTasks: [{ id: "t1", conversationId: "c1" }],
      allTasks: [
        { id: "t2", conversationId: "c2" },
        { id: "t9", conversationId: "cx" },
        null,
      ],
    });
    expect([...ids.conversationIds].sort()).toEqual(["c1", "c2"]);
    expect([...ids.taskIds].sort()).toEqual(["t1", "t2"]);
    const junk = projectCacheIds("p1", {
      conversations: "nope",
      sessionConversations: [],
      projectTasks: { id: "t1" },
      allTasks: undefined,
    });
    expect(junk.taskIds.size).toBe(0);
  });

  it("TaskEventStore.forgetTasks drops only those projections", () => {
    const fake = new FakeCore();
    const store = new TaskEventStore(new CoreClient(fake.transport));
    const event = (taskId: string, sequence: number) =>
      ({
        taskId,
        sequence,
        timestamp: "2026-10-10T00:00:00Z",
        kind: "status",
        status: "queued",
      }) as unknown as Parameters<TaskEventStore["applyEvents"]>[0][number];
    store.applyEvents([event("t1", 1), event("t2", 1)]);
    expect(store.peek("t1")).toBeDefined();
    store.forgetTasks(["t1", "t-unknown"]);
    expect(store.peek("t1")).toBeUndefined();
    expect(store.peek("t2")).toBeDefined();
    expect(store.getSnapshot().map((p) => p.taskId)).toEqual(["t2"]);
  });
});

describe("markup (SSR)", () => {
  const confirmation = (impact: string[], name = "Atlas Demo"): ConfirmationRequest => ({
    token: "c".repeat(64),
    expiresAt: "2026-10-10T00:02:00Z",
    action: "project.delete",
    target: { name, id: "p1" },
    impact,
    external: false,
  });

  it("the delete dialog shows name + id, caps impact at 20, reveals hidden text, never the token", () => {
    const impact = Array.from({ length: 23 }, (_, i) => `line ${i + 1}`);
    impact[0] = `deletes project Atlas${cp(0x202e)} Demo`;
    const view = confirmationView(confirmation(impact, `Atlas${cp(0x2028)}Demo`), Date.parse("2026-10-10T00:00:00Z"));
    const html = renderToStaticMarkup(createElement(ProjectDeleteConsequence, { view }));
    expect(html).toContain("Atlas\\u2028Demo");
    expect(html).toContain("p1");
    expect(html).toContain("deletes project Atlas\\u202E Demo");
    expect(html).toContain(`line ${MAX_IMPACT_LINES}`);
    expect(html).not.toContain(`line ${MAX_IMPACT_LINES + 1}<`);
    expect(html).toContain("…and 3 more impact lines from Core, not shown here.");
    expect(html).not.toContain("NOT CONFIRMED AS CREATED BY SANDPANE");
    expect(html).not.toContain("c".repeat(64));
    expect(html).not.toContain(cp(0x202e));
    expect(html).toContain("never touches host files");
  });

  it("the 'gone' notice says Core no longer lists it — not that this request deleted it", () => {
    const fake = new FakeCore({ advertisedMethods: A3A_CORE_METHODS });
    const flow = new ProjectDeletionFlow(new CoreClient(fake.transport));
    const html = renderToStaticMarkup(
      createElement(ProjectDeletionNotices, {
        flow,
        state: { kind: "gone", projectId: "p1", target: { name: "Atlas Demo", id: "p1" } },
      }),
    );
    expect(html).toContain("Core no longer lists this project");
    expect(html).not.toMatch(/deleted: true/);
  });

  it("an unknown-outcome notice never says nothing was deleted", () => {
    const fake = new FakeCore({ advertisedMethods: A3A_CORE_METHODS });
    const flow = new ProjectDeletionFlow(new CoreClient(fake.transport));
    const { copy, outcomeUnknown } = deletionFailureCopy(
      new CoreRequestError("client", "TIMEOUT", "lost", { mayHaveBeenApplied: true }),
    );
    const html = renderToStaticMarkup(
      createElement(ProjectDeletionNotices, {
        flow,
        state: { kind: "failed", projectId: "p1", stage: "confirm", error: null, copy, outcomeUnknown },
      }),
    );
    expect(html).toContain("Outcome unknown — the project may have been deleted");
    expect(html).not.toMatch(/nothing was deleted/i);
  });

  function renderPanel(project: Project, methods: readonly string[]) {
    const fake = new FakeCore({ advertisedMethods: A3A_CORE_METHODS });
    const deps = buildDeps(fake.transport);
    const flow = new ProjectDeletionFlow(deps.client);
    return renderToStaticMarkup(
      createElement(CoreProvider, {
        deps,
        children: createElement(ProjectSettingsPanel, {
          project,
          gates: projectLifecycleGates({ methods: [...methods] }),
          deletion: { flow, state: flow.getState() },
          onClose: () => {},
        }),
      }),
    );
  }

  it("an archived project: edits and repository changes disabled with Core's reason; unarchive and delete enabled", () => {
    const html = renderPanel(
      {
        id: "p1",
        name: "Atlas Demo",
        description: "",
        createdAt: "t",
        repositories: ["/srv/atlas"],
        archivedAt: "2026-10-10T01:00:00Z",
      },
      A3A_CORE_METHODS,
    );
    expect(html).toContain("archived 2026-10-10T01:00:00Z");
    expect(html).toContain(MSG_PROJECT_ARCHIVED);
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="Atlas Demo"|<input[^>]*value="Atlas Demo"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*>Unarchive project<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Unarchive project/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Delete project…/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Remove…/);
  });

  it("an A1 Core: every A3a control is disabled as not supported, nothing pretends to work", () => {
    const html = renderPanel(
      { id: "p1", name: "Atlas Demo", description: "", createdAt: "t", repositories: [] },
      A1_CORE_METHODS,
    );
    expect(html).toContain("not supported by this Core");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Archive project/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Delete project…/);
    expect(html).toContain("no native folder picker");
  });
});
