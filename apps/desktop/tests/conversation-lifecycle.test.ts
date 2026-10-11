/**
 * A3b conversation lifecycle on the desktop (design 2026-10-09 §3.3): wire
 * frames for the five methods, `includeArchived`, `archivedAt` / `sandboxId`,
 * gating, the two-step delete, honest copy for every exact Core message, the
 * title validator against Core's rule, the archived UI state, the paged
 * export (no file save on the desktop: a read-only preview plus Copy), and
 * drift against the Rust sources read from disk.
 *
 * The FakeCore A3b behaviour is MODELED on `conversation_lifecycle.rs`
 * (working tree), not captured from a live Core. Hidden characters are built
 * with `String.fromCodePoint` so no raw invisible character lives in this file.
 */

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoreClient,
  CoreRequestError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  REPLAY_SAFE_METHODS,
  requestTimeoutFor,
  type CoreTransport,
} from "../src/lib/core-client";
import {
  decodeConversation,
  decodeConversationDeleteResult,
  decodeConversationExportPage,
} from "../src/lib/decode";
import { MalformedFrameError } from "../src/lib/framing";
import {
  buildConversationExportParams,
  buildConversationListParams,
  buildConversationRenameParams,
} from "../src/lib/guards";
import {
  CONVERSATION_EXPORT_FORMAT,
  CONVERSATION_LIFECYCLE_METHODS,
  FEATURE_CONVERSATION_SANDBOX_ID,
  KNOWN_FEATURES,
  METHODS,
  REDACTION_KINDS,
  type ConfirmationRequest,
  type Conversation,
  type ConversationExportPage,
} from "../src/lib/protocol";
import {
  CONVERSATION_MESSAGE_CONSTS,
  MSG_CONVERSATION_ARCHIVED,
  MSG_CONVERSATION_HAS_TASKS,
  MSG_CONVERSATION_NOT_FOUND,
  MSG_TITLE_BLANK,
} from "../src/lib/conversation-messages";
import { MSG_PROJECT_ARCHIVED } from "../src/lib/project-messages";
import {
  CONVERSATION_DELETE_FOOTNOTE,
  ConversationDeletionFlow,
  ConversationExportController,
  EXPORT_DOCUMENT_NOTE,
  EXPORT_PAGE_CAP,
  EXPORT_REVIEW_NOTICE,
  collectConversationExport,
  conversationCacheTaskIds,
  conversationCreateTitle,
  conversationRecheck,
  conversationDeletionFailureCopy,
  conversationLifecycleGates,
  conversationListParams,
  conversationWriteBlock,
  copyExportText,
  exportFailureCopy,
  exportJsonText,
  exportPreview,
  forgetConversationLocally,
  mergeConversationRows,
  planConversationRename,
  renamePrefill,
  recheckConversationListed,
  sandboxChosenAtCreation,
  type ConversationExportDocument,
} from "../src/lib/conversation-lifecycle";
import { TOKEN_REJECTED_MESSAGE as CLIENT_TOKEN_REJECTED } from "../src/lib/project-lifecycle";
import { describeCoreError, displayRevealed } from "../src/lib/reducers";
import { MAX_IMPACT_LINES, confirmationView } from "../src/lib/sandbox-lifecycle";
import {
  CONVERSATION_TITLE_MAX,
  isRustWhitespace,
  validateConversationTitle,
} from "../src/lib/wizard";
import {
  addConversation,
  clearConversations,
  forgetConversation,
  listConversations,
  replaceConversation,
} from "../src/lib/conversation-store";
import {
  ConversationActions,
  ConversationDeleteConsequence,
  ConversationDeletionNotices,
  ConversationExportPanel,
  SandboxChosenLabel,
} from "../src/components/chat/ConversationLifecycle";
import { CoreProvider, buildDeps } from "../src/app/context";
import { A3A_CORE_METHODS, A3B_CORE_METHODS, FakeCore } from "./support/fake-core";
import {
  CONFIRM_RUST,
  CONVERSATION_LIFECYCLE_RUST,
  REDACT_RUST,
  VALIDATION_RUST,
  desktopProxyRustSource,
  protocolRustSource,
  repoFile,
  rustMethodAll,
  rustStrConst,
  rustUsizeConst,
  schemaMethodEnum,
} from "./support/rust-source";

const cp = (n: number): string => String.fromCodePoint(n);
const TOKEN = "c".repeat(64);

function core(options: ConstructorParameters<typeof FakeCore>[0] = {}) {
  const fake = new FakeCore({ advertisedMethods: A3B_CORE_METHODS, ...options });
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
function scripted(answer: (method: string, params: Record<string, unknown>) => { ok?: unknown; err?: unknown } | null) {
  const writes: { method: string; params: Record<string, unknown> }[] = [];
  let handlers: ((line: string) => void)[] = [];
  const transport: CoreTransport = {
    kind: "memory",
    write(frame: string) {
      const parsed = JSON.parse(frame) as { id: string; method: string; params: Record<string, unknown> };
      writes.push({ method: parsed.method, params: parsed.params });
      const reply = answer(parsed.method, parsed.params);
      if (reply === null) return; // lost answer
      const line = `${JSON.stringify({ v: 1, id: parsed.id, ...reply })}\n`;
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

const CONV: Conversation = {
  id: "c1",
  projectId: "p1",
  title: "Atlas Demo chat",
  agentId: "codex",
  createdAt: "2026-10-10T00:00:00Z",
};

function seed(fake: FakeCore, extra: Partial<Conversation> & { messages?: { sequence: number; role: string; content: string }[] } = {}) {
  fake.addProject({ id: "p1", name: "Atlas Demo" });
  fake.addConversation({ ...CONV, ...extra });
}

afterEach(() => {
  clearConversations();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Drift: every pinned list, messages, validator, export format and kinds
// ---------------------------------------------------------------------------

describe("A3b drift against the Rust sources", () => {
  it("the five methods sit right after conversation.history, in Method::ALL order (27 total)", () => {
    const all = rustMethodAll().names;
    expect(all).toHaveLength(27);
    expect(METHODS).toEqual(all);
    expect(schemaMethodEnum()).toEqual(all);
    const at = METHODS.indexOf("conversation.history");
    expect(METHODS.slice(at + 1, at + 6)).toEqual([...CONVERSATION_LIFECYCLE_METHODS]);
    expect(A3B_CORE_METHODS).toEqual([...METHODS]);
  });

  it("none of the five is replay-safe on either side, and each keeps the default deadline", () => {
    const proxy = desktopProxyRustSource();
    const replayBody = /fn replay_safe\(method: Method\) -> bool \{([\s\S]*?)\n\}/.exec(proxy)?.[1] ?? "";
    const deadlineBody =
      /pub fn proxy_deadline_ms\(method: Method\) -> u64 \{([\s\S]*?)\n\}/.exec(proxy)?.[1] ?? "";
    expect(replayBody).toContain("Method::ConversationHistory");
    for (const method of CONVERSATION_LIFECYCLE_METHODS) {
      expect(REPLAY_SAFE_METHODS.has(method), method).toBe(false);
      expect(requestTimeoutFor(method), method).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    }
    for (const variant of [
      "ConversationRename",
      "ConversationArchive",
      "ConversationUnarchive",
      "ConversationDelete",
      "ConversationExport",
    ]) {
      expect(replayBody).not.toContain(`Method::${variant}`);
      expect(deadlineBody).not.toContain(`Method::${variant}`);
    }
    expect(proxy).toContain("assert_eq!(Method::ALL.len(), 27);");
  });

  it("every exact message equals the Rust const of the same name", () => {
    for (const [name, value] of Object.entries(CONVERSATION_MESSAGE_CONSTS)) {
      expect(rustStrConst(CONVERSATION_LIFECYCLE_RUST, name), name).toBe(value);
    }
    expect(Object.keys(CONVERSATION_MESSAGE_CONSTS).sort()).toEqual([
      "MSG_CONVERSATION_ARCHIVED",
      "MSG_CONVERSATION_HAS_TASKS",
      "MSG_CONVERSATION_NOT_FOUND",
      "MSG_TITLE_BLANK",
    ]);
    expect(rustStrConst(CONFIRM_RUST, "TOKEN_REJECTED_MESSAGE")).toBe(CLIENT_TOKEN_REJECTED);
    expect(rustStrConst(CONVERSATION_LIFECYCLE_RUST, "CONVERSATION_DELETE_ACTION")).toBe(
      "conversation.delete",
    );
  });

  it("the known features include conversation-sandbox-id, in Rust FEATURES order", () => {
    const rust = /pub const FEATURES: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(protocolRustSource());
    const names = [...((rust?.[2] ?? "").matchAll(/"([^"]+)"/g))].map((m) => m[1]);
    expect([...KNOWN_FEATURES]).toEqual(names);
    expect(KNOWN_FEATURES).toContain(FEATURE_CONVERSATION_SANDBOX_ID);
    expect(FEATURE_CONVERSATION_SANDBOX_ID).toBe("conversation-sandbox-id");
  });

  it("the title validator's bound and predicates are Core's (scoped to conversation_title / rename)", () => {
    expect(rustUsizeConst(VALIDATION_RUST, "MAX_CONVERSATION_TITLE_CHARS")).toBe(CONVERSATION_TITLE_MAX);
    const source = repoFile(VALIDATION_RUST);
    const body = /pub fn conversation_title\(value: &str\) -> Result<&str, ValidationError> \{([\s\S]*?)\n {4}\}/.exec(
      source,
    )?.[1];
    expect(body).toBeDefined();
    expect(body).toContain("Self::bounded(value, MAX_CONVERSATION_TITLE_CHARS)?;");
    expect(body).toContain(".find(|c| c.is_control() || is_spoofing_format_char(*c))");
    const service = repoFile(CONVERSATION_LIFECYCLE_RUST);
    const rename = /pub\(crate\) fn conversation_rename\([\s\S]*?\n\}/.exec(service)?.[0] ?? "";
    // Rust `str::trim` (Unicode White_Space), checked BEFORE the validator.
    expect(rename).toContain("if p.title.trim().is_empty() {");
    expect(rename.indexOf("trim().is_empty()")).toBeLessThan(rename.indexOf("Validator::conversation_title"));
    expect(rename).toContain("MSG_TITLE_BLANK");
  });

  it("the export format tag and redaction kinds are Core's", () => {
    expect(rustStrConst("core/crates/sandpane-protocol/src/lib.rs", "CONVERSATION_EXPORT_FORMAT")).toBe(
      CONVERSATION_EXPORT_FORMAT,
    );
    const kinds = /pub const KINDS: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(repoFile(REDACT_RUST));
    expect(kinds).not.toBeNull();
    const names = [...((kinds?.[2] ?? "").matchAll(/"([^"]+)"/g))].map((m) => m[1]);
    expect([...REDACTION_KINDS]).toEqual(names);
    expect(Number(kinds?.[1])).toBe(REDACTION_KINDS.length);
  });

  it("the additive wire fields exist in Rust with the names the mirror uses", () => {
    const source = protocolRustSource();
    expect(source).toContain("pub archived_at: Option<String>,");
    expect(source).toContain("pub sandbox_id: Option<String>,");
    expect(source).toContain("pub include_archived: Option<bool>,");
    expect(source).toContain("pub struct ConversationExportResult");
    expect(source).toContain("pub by_kind: std::collections::BTreeMap<String, u64>,");
  });
});

// ---------------------------------------------------------------------------
// Validator against Core's own corpus (validation.rs tests + rename's trim)
// ---------------------------------------------------------------------------

const SPOOFING = [
  0x2028, 0x2029, 0x200e, 0x200f, 0x061c, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069,
];

describe("validateConversationTitle mirrors Validator::conversation_title (+ rename's blank refusal)", () => {
  it("Core's accept corpus, counted in characters", () => {
    expect(validateConversationTitle("Atlas Demo — ü 漢字 ✓", "rename")).toBeNull();
    expect(validateConversationTitle("é".repeat(200), "rename")).toBeNull();
    expect(validateConversationTitle(cp(0x1d4b5).repeat(200), "rename")).toBeNull();
    expect(validateConversationTitle("x".repeat(201), "rename")).toMatch(/at most 200/);
    expect(CONVERSATION_TITLE_MAX).toBe(200);
  });

  it("Core's refuse corpus: every Cc (incl. newline and tab), C1, separators and bidi", () => {
    const bad = ["\n", "\t", "\r", cp(0), cp(0x7f), cp(0x85), cp(0x9b), ...SPOOFING.map(cp)];
    for (const c of bad) {
      const problem = validateConversationTitle(`a${c}b`, "rename");
      expect(problem, `U+${c.codePointAt(0)?.toString(16)}`).not.toBeNull();
      // The refusal names the code point; it never echoes the character.
      expect(problem).not.toContain(c);
    }
    expect(validateConversationTitle(`a${cp(0xd800)}b`, "rename")).toMatch(/surrogate/);
  });

  it("rename refuses whitespace-only by Rust's White_Space, not JS trim()", () => {
    for (const blank of ["", " ", "   ", cp(0xa0), cp(0x3000), `${cp(0x2000)}${cp(0x200a)}`, cp(0x1680)]) {
      expect(validateConversationTitle(blank, "rename"), JSON.stringify(blank)).toMatch(
        /empty or whitespace-only/,
      );
    }
    // U+FEFF is not White_Space in Rust (JS trim() strips it): Core accepts it.
    expect(isRustWhitespace(0xfeff)).toBe(false);
    expect(validateConversationTitle(cp(0xfeff), "rename")).toBeNull();
    expect(validateConversationTitle(`${cp(0xfeff)}x`, "rename")).toBeNull();
    // U+180E was White_Space in old Unicode; Rust's char::is_whitespace says no.
    expect(isRustWhitespace(0x180e)).toBe(false);
    const rust = [0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
    for (let c = 0x2000; c <= 0x200a; c += 1) rust.push(c);
    for (let c = 0; c <= 0x3100; c += 1) {
      expect(isRustWhitespace(c), `U+${c.toString(16)}`).toBe(rust.includes(c));
    }
  });

  it("create mode leaves a blank title to Core (it becomes 'Untitled conversation')", () => {
    expect(validateConversationTitle("", "create")).toBeNull();
    expect(validateConversationTitle("   ", "create")).toBeNull();
    expect(validateConversationTitle("a\tb", "create")).not.toBeNull();
  });

  // Cross-client finding (VS Code A3b): a create title DERIVED from the first
  // prompt breaks on multi-line prompts and on a UTF-16 slice through a
  // surrogate pair. The desktop never derives one: the title is the user's own
  // one-line field, checked with Core's rule BEFORE "New chat" is enabled.
  it("create title is the user's field, never sliced from a message; multi-line and astral cuts are judged as Core judges them", () => {
    const panel = readFileSync(new URL("../src/components/chat/ChatPanel.tsx", import.meta.url), "utf8");
    const create = /createConversation\.mutate\(\{([\s\S]*?)\}\)/.exec(panel)?.[1] ?? "";
    expect(create).toMatch(/title: createTitle,/);
    expect(panel).toMatch(/const createTitle = conversationCreateTitle\(title\);/);
    expect(create).not.toMatch(/draft|content|message|slice|substring|Untitled/i);
    // A multi-line paste is refused client-side (the button stays disabled),
    // so Core never sees it.
    expect(validateConversationTitle("first line\nsecond line", "create")).not.toBeNull();
    expect(validateConversationTitle(`first${cp(0x2028)}second`, "create")).not.toBeNull();
    // Length is counted in code points, as Rust counts chars: 200 astral
    // characters (400 UTF-16 units) pass, 201 do not, and a lone half refuses.
    expect(validateConversationTitle(cp(0x1f600).repeat(200), "create")).toBeNull();
    expect(validateConversationTitle(cp(0x1f600).repeat(201), "create")).toMatch(/at most 200/);
    expect(validateConversationTitle(`${"x".repeat(199)}${cp(0x1f600)}`.slice(0, 200), "create")).toMatch(
      /surrogate/,
    );
  });

  it("a blank create title is sent as \"\" (Rust's blank, not JS trim) so Core stores 'Untitled conversation'", async () => {
    for (const blank of ["", "   ", "\t\n", cp(0x85), cp(0x3000), `${cp(0xa0)} ${cp(0x2028)}`]) {
      expect(conversationCreateTitle(blank), JSON.stringify(blank)).toBe("");
    }
    // Not blank to Rust (U+FEFF is not White_Space) but blank after JS trim:
    // still "" — Core would store it as typed, the desktop never sends a
    // title that is invisible.
    expect(conversationCreateTitle(cp(0xfeff))).toBe("");
    expect(conversationCreateTitle("  Atlas Demo plan  ")).toBe("Atlas Demo plan");
    const { fake, client } = core();
    seed(fake);
    const created = decodeConversation(
      await client.createConversation({ projectId: "p1", agentId: "codex", title: conversationCreateTitle("   ") }),
    );
    expect(created.title).toBe("Untitled conversation");
    const frame = fake.requests.filter((r) => r.method === "conversation.create").at(-1);
    expect((frame?.params as { title?: unknown }).title).toBe("");
  });

  it("rename params: refusals send nothing and never echo the value", async () => {
    const { fake, client } = core();
    seed(fake);
    for (const title of ["   ", `a${cp(0x202e)}b`, "x".repeat(201)]) {
      const err = await failure(client.renameConversation("c1", title));
      expect(err.source).toBe("client");
      expect(err.code).toBe("INVALID_PARAMS");
      expect(err.message).not.toContain(title);
    }
    expect(fake.callsFor("conversation.rename")).toBe(0);
    expect(() => buildConversationRenameParams("", "x")).toThrow(/conversationId/);
    expect(buildConversationRenameParams("c1", "New")).toEqual({ conversationId: "c1", title: "New" });
  });
});

// ---------------------------------------------------------------------------
// Exact frames for every A3b method
// ---------------------------------------------------------------------------

describe("exact frames for every A3b method", () => {
  it("conversation.list: {} by default; includeArchived only when asked, never false", async () => {
    const { fake, client } = core();
    await client.listConversations();
    expect(fake.lastParams("conversation.list")).toEqual({});
    await client.listConversations({ projectId: "p1" });
    expect(fake.lastParams("conversation.list")).toEqual({ projectId: "p1" });
    await client.listConversations({ projectId: "p1", includeArchived: true });
    expect(fake.lastParams("conversation.list")).toEqual({ projectId: "p1", includeArchived: true });
    await client.listConversations({ projectId: "p1", includeArchived: false });
    expect(fake.lastParams("conversation.list")).toEqual({ projectId: "p1" });
    expect(buildConversationListParams({ includeArchived: true, limit: 900 })).toEqual({
      includeArchived: true,
      limit: 500,
    });
  });

  it("rename / archive / unarchive write exactly their params and return Core's row", async () => {
    const { fake, client } = core();
    seed(fake);
    const renamed = await client.renameConversation("c1", "Renamed");
    expect(fake.lastParams("conversation.rename")).toEqual({ conversationId: "c1", title: "Renamed" });
    expect(renamed.title).toBe("Renamed");
    const archived = await client.archiveConversation("c1");
    expect(fake.lastParams("conversation.archive")).toEqual({ conversationId: "c1" });
    expect(archived.archivedAt).toBe("2026-10-10T00:00:00Z");
    // Idempotent: the original instant is kept.
    fake.nowMs += 60_000;
    expect((await client.archiveConversation("c1")).archivedAt).toBe("2026-10-10T00:00:00Z");
    const live = await client.unarchiveConversation("c1");
    expect(fake.lastParams("conversation.unarchive")).toEqual({ conversationId: "c1" });
    expect(live.archivedAt).toBeUndefined();
  });

  it("conversation.delete: step 1 is exactly {conversationId}; step 2 adds only the token", async () => {
    const { fake, client } = core();
    seed(fake);
    const confirmation = await client.requestConversationDeletion("c1");
    expect(fake.lastParams("conversation.delete")).toEqual({ conversationId: "c1" });
    expect(Object.keys(fake.lastParams("conversation.delete"))).not.toContain("confirmToken");
    expect(confirmation.action).toBe("conversation.delete");
    expect(confirmation.target).toEqual({ name: "Atlas Demo chat", id: "c1" });
    expect(confirmation.external).toBe(false);
    expect(await client.confirmConversationDeletion("c1", confirmation.token)).toEqual({ deleted: true });
    expect(fake.lastParams("conversation.delete")).toEqual({
      conversationId: "c1",
      confirmToken: confirmation.token,
    });
    expect(fake.conversations.some((c) => c.id === "c1")).toBe(false);
  });

  it("a rename between the steps does not invalidate the token (bound to the id)", async () => {
    const { fake, client } = core();
    seed(fake);
    const confirmation = await client.requestConversationDeletion("c1");
    await client.renameConversation("c1", "Other title");
    expect(await client.confirmConversationDeletion("c1", confirmation.token)).toEqual({ deleted: true });
  });

  it("conversation.export: {conversationId, afterSequence} (+ limit only when given)", async () => {
    const { fake, client } = core();
    seed(fake, { messages: [{ sequence: 1, role: "user", content: "hi" }] });
    const page = await client.exportConversationPage({ conversationId: "c1" });
    expect(fake.lastParams("conversation.export")).toEqual({ conversationId: "c1", afterSequence: 0 });
    expect(page.format).toBe(CONVERSATION_EXPORT_FORMAT);
    expect(buildConversationExportParams({ conversationId: "c1", afterSequence: 4, limit: 0 })).toEqual({
      conversationId: "c1",
      afterSequence: 4,
      limit: 1,
    });
  });

  it("archivedAt and sandboxId are absent-tolerant; null reads as absent; a mistyped one is malformed", () => {
    const base = { id: "c1", projectId: "p1", title: "t", agentId: "codex", createdAt: "x" };
    const plain = decodeConversation(base);
    expect("archivedAt" in plain).toBe(false);
    expect("sandboxId" in plain).toBe(false);
    expect(decodeConversation({ ...base, archivedAt: null, sandboxId: null })).toEqual(plain);
    expect(decodeConversation({ ...base, archivedAt: "2026", sandboxId: "atlas-demo-1" })).toMatchObject({
      archivedAt: "2026",
      sandboxId: "atlas-demo-1",
    });
    expect(() => decodeConversation({ ...base, archivedAt: 7 })).toThrow(MalformedFrameError);
    expect(() => decodeConversation({ ...base, sandboxId: true })).toThrow(MalformedFrameError);
  });

  it("step-1 answers that cannot be trusted are refused, and no step 2 follows", async () => {
    const confirmation = (over: Partial<ConfirmationRequest>) => ({
      confirmation: {
        token: TOKEN,
        expiresAt: "2026-10-10T00:02:00Z",
        action: "conversation.delete",
        target: { name: "t", id: "c1" },
        impact: [],
        external: false,
        ...over,
      },
    });
    for (const ok of [
      confirmation({ target: { name: "t", id: "c2" } }),
      confirmation({ external: true }),
      confirmation({ action: "project.delete" }),
      { deleted: true },
    ]) {
      const { transport, writes } = scripted(() => ({ ok }));
      const client = new CoreClient(transport, { requestTimeoutMs: 60 });
      const err = await failure(client.requestConversationDeletion("c1"));
      expect(err.message).not.toContain(TOKEN);
      expect(writes).toHaveLength(1);
    }
    expect(() =>
      decodeConversationDeleteResult({ confirmation: confirmation({}).confirmation, deleted: true }),
    ).toThrow(MalformedFrameError);
  });

  it("step 2 answering anything but deleted: true is an unknown outcome, not a success", async () => {
    for (const ok of [{ deleted: false }, {}, { removed: true }, "yes"]) {
      const { transport } = scripted(() => ({ ok }));
      const client = new CoreClient(transport, { requestTimeoutMs: 60 });
      const err = await failure(client.confirmConversationDeletion("c1", TOKEN));
      expect(err.mayHaveBeenApplied).toBe(true);
      expect(err.message).not.toContain(TOKEN);
    }
  });

  it("a rename/archive answer about another conversation, or one this build cannot read, is unknown and never echoed", async () => {
    for (const ok of [{ ...CONV, id: "c2" }, { secret: "ghp_leak" }]) {
      const { transport } = scripted(() => ({ ok }));
      const client = new CoreClient(transport, { requestTimeoutMs: 60 });
      const err = await failure(client.archiveConversation("c1"));
      expect(err.mayHaveBeenApplied).toBe(true);
      expect(err.message).not.toContain("ghp_leak");
    }
  });

  it("a Core INTERNAL on a write is flagged maybe-applied by the client itself", async () => {
    const { transport } = scripted(() => ({ err: { code: "INTERNAL", message: "database is locked" } }));
    const client = new CoreClient(transport, { requestTimeoutMs: 60 });
    for (const call of [
      () => client.renameConversation("c1", "x"),
      () => client.archiveConversation("c1"),
      () => client.unarchiveConversation("c1"),
      () => client.confirmConversationDeletion("c1", TOKEN),
    ]) {
      expect((await failure(call())).mayHaveBeenApplied).toBe(true);
    }
  });

  it("an export page is decoded strictly and never echoed into the error", () => {
    const page = {
      format: CONVERSATION_EXPORT_FORMAT,
      exportedAt: "2026-10-10T00:00:00Z",
      conversation: CONV,
      messages: [{ id: "m1", conversationId: "c1", role: "user", content: "hi", sequence: 1 }],
      truncated: false,
      nextSequence: 1,
      redaction: { bestEffort: true, replacements: 2, byKind: { token: 2 } },
    };
    expect(decodeConversationExportPage(page, "c1").redaction.byKind).toEqual({ token: 2 });
    // Kinds Core may add later are kept, not refused.
    expect(
      decodeConversationExportPage({ ...page, redaction: { ...page.redaction, byKind: { "future-kind": 1 } } }, "c1")
        .redaction.byKind,
    ).toEqual({ "future-kind": 1 });
    for (const bad of [
      { ...page, format: "other" },
      { ...page, redaction: { ...page.redaction, bestEffort: false } },
      { ...page, redaction: { ...page.redaction, replacements: -1 } },
      { ...page, redaction: { ...page.redaction, byKind: { token: 1.5 } } },
      { ...page, redaction: { ...page.redaction, byKind: [] } },
      { ...page, nextSequence: -1 },
      { ...page, messages: [{ ...page.messages[0], content: 7 }] },
      { ...page, truncated: "no" },
      // Info 3: a page must be about the conversation that was asked for.
      { ...page, messages: [{ ...page.messages[0], conversationId: "c2" }] },
      { ...page, messages: [page.messages[0], { ...page.messages[0], id: "m2", sequence: 2, conversationId: "c2" }] },
      { ...page, conversation: { ...CONV, id: "c2" } },
    ]) {
      let thrown: unknown;
      try {
        decodeConversationExportPage({ ...bad, leak: "ghp_secretvalue" }, "c1");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MalformedFrameError);
      expect(String((thrown as Error).message)).not.toContain("ghp_secretvalue");
      expect(String((thrown as Error).message)).not.toContain("hi");
      expect(String((thrown as Error).message)).not.toContain("c2");
    }
  });

  it("Info 3: the client refuses an export page for another conversation, so no export is assembled", async () => {
    const stray = { id: "m9", conversationId: "c2", role: "user", content: "stray-content-xyz", sequence: 1 };
    const { transport } = scripted(() => ({
      ok: {
        format: CONVERSATION_EXPORT_FORMAT,
        exportedAt: "2026-10-10T00:00:00Z",
        conversation: CONV,
        messages: [stray],
        truncated: false,
        nextSequence: 1,
        redaction: { bestEffort: true, replacements: 0, byKind: {} },
      },
    }));
    const client = new CoreClient(transport, { requestTimeoutMs: 60 });
    const err = await client.exportConversationPage({ conversationId: "c1" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MalformedFrameError);
    expect(String((err as Error).message)).not.toContain("stray-content-xyz");
    const outcome = await collectConversationExport(client, "c1");
    expect(outcome.kind).toBe("failed");
    expect(outcome).not.toHaveProperty("json");
    expect(outcome).not.toHaveProperty("document");
  });
});

// ---------------------------------------------------------------------------
// Gating on system.probe
// ---------------------------------------------------------------------------

describe("every A3b action is gated on system.probe methods", () => {
  it("unprobed, unsupported (an A3a Core) and supported stay distinct", () => {
    const unprobed = conversationLifecycleGates(null);
    expect(unprobed.rename.state).toBe("unprobed");
    expect(unprobed.showArchived.state).toBe("unprobed");
    expect(unprobed.sandboxIdPersisted).toBeNull();
    const old = conversationLifecycleGates({ methods: [...A3A_CORE_METHODS], features: [] });
    for (const gate of [old.rename, old.archive, old.unarchive, old.delete, old.export, old.showArchived]) {
      expect(gate.state).toBe("unsupported");
    }
    expect(old.rename.note).toContain("conversation.rename");
    expect(old.sandboxIdPersisted).toBe(false);
    const now = conversationLifecycleGates({
      methods: [...A3B_CORE_METHODS],
      features: [FEATURE_CONVERSATION_SANDBOX_ID],
    });
    for (const gate of [now.rename, now.archive, now.unarchive, now.delete, now.export, now.showArchived]) {
      expect(gate.state).toBe("supported");
    }
    expect(now.sandboxIdPersisted).toBe(true);
    const partial = conversationLifecycleGates({
      methods: A3B_CORE_METHODS.filter((m) => m !== "conversation.export"),
    });
    expect(partial.export.state).toBe("unsupported");
    expect(partial.rename.state).toBe("supported");
  });

  it("includeArchived is sent only when conversation.archive is advertised", () => {
    const now = conversationLifecycleGates({ methods: [...A3B_CORE_METHODS] });
    const old = conversationLifecycleGates({ methods: [...A3A_CORE_METHODS] });
    expect(conversationListParams("p1", true, now)).toEqual({ projectId: "p1", includeArchived: true });
    expect(conversationListParams("p1", false, now)).toEqual({ projectId: "p1" });
    expect(conversationListParams("p1", true, old)).toEqual({ projectId: "p1" });
    expect(conversationListParams(null, true, conversationLifecycleGates(null))).toEqual({});
  });

  it("a Core that does not dispatch a method answers VALIDATION_FAILED, never a fake success", async () => {
    const fake = new FakeCore({ advertisedMethods: A3A_CORE_METHODS });
    seed(fake);
    const client = new CoreClient(fake.transport, { requestTimeoutMs: 60 });
    const err = await failure(client.archiveConversation("c1"));
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(fake.conversations[0]?.archivedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Exact Core messages → honest copy
// ---------------------------------------------------------------------------

describe("each exact Core message maps to honest copy", () => {
  const copyOf = (code: string, message: string) =>
    describeCoreError(new CoreRequestError("core", code as "CONFLICT", message));

  it("only the exact (code, text) pairs say 'nothing was …'", () => {
    expect(copyOf("VALIDATION_FAILED", MSG_CONVERSATION_ARCHIVED).title).toBe(
      "Nothing was changed — the conversation is archived",
    );
    expect(copyOf("CONFLICT", MSG_CONVERSATION_HAS_TASKS).title).toBe(
      "Nothing was deleted — the conversation has unfinished tasks",
    );
    expect(copyOf("NOT_FOUND", MSG_CONVERSATION_NOT_FOUND).title).toBe(
      "Nothing was changed — Core has no conversation with this id",
    );
    expect(copyOf("VALIDATION_FAILED", MSG_TITLE_BLANK).title).toBe(
      "Nothing was changed — the title is empty or whitespace-only",
    );
    expect(copyOf("VALIDATION_FAILED", MSG_PROJECT_ARCHIVED).title).toBe(
      "Nothing was changed — the project is archived",
    );
    for (const [code, message] of [
      ["CONFLICT", MSG_CONVERSATION_ARCHIVED],
      ["VALIDATION_FAILED", MSG_CONVERSATION_HAS_TASKS],
      ["VALIDATION_FAILED", `${MSG_CONVERSATION_ARCHIVED}.`],
      ["INTERNAL", MSG_CONVERSATION_NOT_FOUND],
    ] as const) {
      expect(copyOf(code, message).title).not.toMatch(/nothing was/i);
    }
  });

  it("the real exchange: archived refusals come back as Core's text; history keeps working", async () => {
    const { fake, client } = core();
    seed(fake, { messages: [{ sequence: 1, role: "user", content: "hi" }] });
    await client.archiveConversation("c1");
    // Behaviour change: a send to an archived conversation is no longer NOT_FOUND.
    const send = await failure(
      client.sendConversationMessage({ conversationId: "c1", content: "x", attachments: [] }),
    );
    expect([send.code, send.message]).toEqual(["VALIDATION_FAILED", MSG_CONVERSATION_ARCHIVED]);
    expect(describeCoreError(send).title).toBe("Nothing was changed — the conversation is archived");
    const rename = await failure(client.renameConversation("c1", "x"));
    expect([rename.code, rename.message]).toEqual(["VALIDATION_FAILED", MSG_CONVERSATION_ARCHIVED]);
    const history = await client.getConversationHistory({ conversationId: "c1" });
    expect(history.messages).toHaveLength(1);
    expect((await client.exportConversationPage({ conversationId: "c1" })).messages).toHaveLength(1);
  });

  it("when the project AND the conversation are archived, the project message comes first", async () => {
    const { fake, client } = core();
    seed(fake);
    await client.archiveConversation("c1");
    fake.projects[0]!.archivedAt = "2026-10-10T00:00:00Z";
    for (const call of [
      () => client.sendConversationMessage({ conversationId: "c1", content: "x", attachments: [] }),
      () => client.renameConversation("c1", "x"),
      () => client.unarchiveConversation("c1"),
    ]) {
      const err = await failure(call());
      expect([err.code, err.message]).toEqual(["VALIDATION_FAILED", MSG_PROJECT_ARCHIVED]);
    }
    // Archive and delete stay allowed in an archived project.
    await client.archiveConversation("c1");
    const confirmation = await client.requestConversationDeletion("c1");
    expect(await client.confirmConversationDeletion("c1", confirmation.token)).toEqual({ deleted: true });
  });
});

// ---------------------------------------------------------------------------
// The two-step delete flow
// ---------------------------------------------------------------------------

describe("ConversationDeletionFlow (A1 two-step pattern)", () => {
  function flowWith(fake: FakeCore, options: ConstructorParameters<typeof ConversationDeletionFlow>[1] = {}) {
    const client = new CoreClient(fake.transport, { requestTimeoutMs: 60 });
    return new ConversationDeletionFlow(client, { now: () => fake.nowMs, ...options });
  }

  it("cancel sends nothing; a late step-1 answer after cancel is discarded unseen", async () => {
    const fake = new FakeCore({ advertisedMethods: A3B_CORE_METHODS, latencyMs: 5 });
    seed(fake);
    const flow = flowWith(fake);
    const pending = flow.begin("c1", "p1");
    flow.cancel();
    await pending;
    expect(flow.getState()).toEqual({ kind: "idle" });
    expect(flow.confirm()).toBe(false);
    expect(fake.callsFor("conversation.delete")).toBe(1);
  });

  it("an expired (or unreadable) expiry sends nothing — re-checked at click time, fail closed", async () => {
    const fake = new FakeCore({ advertisedMethods: A3B_CORE_METHODS });
    seed(fake);
    const flow = flowWith(fake);
    await flow.begin("c1", "p1");
    expect(flow.getState().kind).toBe("confirming");
    fake.nowMs += 121_000;
    expect(flow.confirm()).toBe(false);
    expect(flow.getState()).toMatchObject({ kind: "failed", stage: "expired" });
    expect(fake.callsFor("conversation.delete")).toBe(1);

    const { transport, writes } = scripted(() => ({
      ok: {
        confirmation: {
          token: TOKEN,
          expiresAt: "not a time",
          action: "conversation.delete",
          target: { name: "t", id: "c1" },
          impact: [],
          external: false,
        },
      },
    }));
    const unreadable = new ConversationDeletionFlow(new CoreClient(transport, { requestTimeoutMs: 60 }));
    await unreadable.begin("c1", "p1");
    expect(unreadable.confirm()).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it("a double click sends step 2 once; the token leaves state; deleted reports the id", async () => {
    const fake = new FakeCore({ advertisedMethods: A3B_CORE_METHODS });
    seed(fake);
    const deleted: string[] = [];
    const flow = flowWith(fake, { onDeleted: (id) => deleted.push(id) });
    await flow.begin("c1", "p1");
    expect(flow.confirm()).toBe(true);
    expect(flow.confirm()).toBe(false);
    expect(JSON.stringify(flow.getState())).not.toContain("0".repeat(60));
    await settle();
    await settle();
    expect(flow.getState()).toMatchObject({ kind: "deleted", conversationId: "c1" });
    expect(deleted).toEqual(["c1"]);
    expect(fake.callsFor("conversation.delete")).toBe(2);
  });

  it("CONFLICT (unfinished tasks) at step 1 or step 2 says nothing was deleted; nothing is retried", async () => {
    const fake = new FakeCore({ advertisedMethods: A3B_CORE_METHODS });
    seed(fake);
    fake.addTask({ id: "t1", conversationId: "c1", status: "running" });
    const flow = flowWith(fake);
    await flow.begin("c1", "p1");
    expect(flow.getState()).toMatchObject({ kind: "failed", stage: "request" });
    const state = flow.getState();
    if (state.kind !== "failed") throw new Error("expected failed");
    expect(state.copy.title).toMatch(/Nothing was deleted — the conversation has unfinished tasks/);

    flow.reset();
    fake.tasks[0]!.status = "completed";
    await flow.begin("c1", "p1");
    fake.tasks[0]!.status = "running";
    flow.confirm();
    await settle();
    await settle();
    const after = flow.getState();
    expect(after).toMatchObject({ kind: "failed", stage: "confirm", outcomeUnknown: false });
    if (after.kind !== "failed") throw new Error("expected failed");
    expect(after.copy.title).toMatch(/Nothing was deleted/);
    expect(fake.callsFor("conversation.delete")).toBe(3);
  });

  it("a token Core rejects says 'Confirmation refused — nothing was deleted'", async () => {
    const { transport } = scripted((_m, params) =>
      params.confirmToken === undefined
        ? {
            ok: {
              confirmation: {
                token: TOKEN,
                expiresAt: "2999-01-01T00:00:00Z",
                action: "conversation.delete",
                target: { name: "t", id: "c1" },
                impact: [],
                external: false,
              },
            },
          }
        : { err: { code: "VALIDATION_FAILED", message: CLIENT_TOKEN_REJECTED } },
    );
    const flow = new ConversationDeletionFlow(new CoreClient(transport, { requestTimeoutMs: 60 }));
    await flow.begin("c1", "p1");
    flow.confirm();
    await settle();
    await settle();
    const state = flow.getState();
    if (state.kind !== "failed") throw new Error("expected failed");
    expect(state.copy.title).toBe("Confirmation refused — nothing was deleted");
    expect(state.outcomeUnknown).toBe(false);
  });

  it("INTERNAL or a lost step-2 answer is UNKNOWN — never 'nothing was deleted'", async () => {
    for (const reply of [{ err: { code: "INTERNAL", message: "disk I/O error" } }, null]) {
      const { transport } = scripted((_m, params) =>
        params.confirmToken === undefined
          ? {
              ok: {
                confirmation: {
                  token: TOKEN,
                  expiresAt: "2999-01-01T00:00:00Z",
                  action: "conversation.delete",
                  target: { name: "t", id: "c1" },
                  impact: [],
                  external: false,
                },
              },
            }
          : reply,
      );
      const flow = new ConversationDeletionFlow(new CoreClient(transport, { requestTimeoutMs: 30 }));
      await flow.begin("c1", "p1");
      flow.confirm();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const state = flow.getState();
      if (state.kind !== "failed") throw new Error("expected failed");
      expect(state.outcomeUnknown).toBe(true);
      expect(state.copy.title).toBe("Outcome unknown — the conversation may have been deleted");
      expect(JSON.stringify(state.copy)).not.toMatch(/nothing was deleted/i);
    }
  });

  it("unknown step 2 + a scoped re-read that no longer lists it → gone, forgotten locally", async () => {
    const gone: string[] = [];
    const rechecks: [string, string][] = [];
    const { transport } = scripted((_m, params) =>
      params.confirmToken === undefined
        ? {
            ok: {
              confirmation: {
                token: TOKEN,
                expiresAt: "2999-01-01T00:00:00Z",
                action: "conversation.delete",
                target: { name: "t", id: "c1" },
                impact: [],
                external: false,
              },
            },
          }
        : { err: { code: "INTERNAL", message: "x" } },
    );
    const flow = new ConversationDeletionFlow(new CoreClient(transport, { requestTimeoutMs: 60 }), {
      recheckListed: async (id, projectId) => {
        rechecks.push([id, projectId]);
        return false;
      },
      onGone: (id) => gone.push(id),
    });
    await flow.begin("c1", "p1");
    flow.confirm();
    await settle();
    await settle();
    await settle();
    expect(rechecks).toEqual([["c1", "p1"]]);
    expect(flow.getState()).toMatchObject({ kind: "gone", conversationId: "c1" });
    expect(gone).toEqual(["c1"]);
  });

  it("unknown step 2 + still listed (or the re-read fails) → stays unknown, nothing forgotten", async () => {
    for (const recheck of [async () => true, async () => null, async () => Promise.reject(new Error("x"))]) {
      const gone: string[] = [];
      const { transport } = scripted((_m, params) =>
        params.confirmToken === undefined
          ? {
              ok: {
                confirmation: {
                  token: TOKEN,
                  expiresAt: "2999-01-01T00:00:00Z",
                  action: "conversation.delete",
                  target: { name: "t", id: "c1" },
                  impact: [],
                  external: false,
                },
              },
            }
          : { err: { code: "INTERNAL", message: "x" } },
      );
      const flow = new ConversationDeletionFlow(new CoreClient(transport, { requestTimeoutMs: 60 }), {
        recheckListed: recheck as () => Promise<boolean | null>,
        onGone: (id) => gone.push(id),
      });
      await flow.begin("c1", "p1");
      flow.confirm();
      await settle();
      await settle();
      await settle();
      expect(flow.getState()).toMatchObject({ kind: "failed", outcomeUnknown: true });
      expect(gone).toEqual([]);
    }
  });

  it("a step-2 NOT_FOUND forgets the conversation locally (Core has no such conversation)", async () => {
    const fake = new FakeCore({ advertisedMethods: A3B_CORE_METHODS });
    seed(fake);
    const gone: string[] = [];
    const flow = flowWith(fake, { onGone: (id) => gone.push(id) });
    await flow.begin("c1", "p1");
    fake.conversations.splice(0, 1);
    flow.confirm();
    await settle();
    await settle();
    expect(gone).toEqual(["c1"]);
    expect(flow.getState()).toMatchObject({ kind: "failed", stage: "confirm" });
  });

  it("the scoped re-read: {projectId, includeArchived, limit 500}; a full page is 'unknown', not 'gone'", async () => {
    const { fake, client } = core();
    seed(fake);
    expect(await recheckConversationListed(client, "c1", "p1", true)).toBe(true);
    expect(fake.lastParams("conversation.list")).toEqual({
      projectId: "p1",
      includeArchived: true,
      limit: 500,
    });
    expect(await recheckConversationListed(client, "c9", "p1", true)).toBe(false);
    for (let i = 0; i < 500; i += 1) {
      fake.addConversation({ ...CONV, id: `x${i}`, title: `x${i}` });
    }
    expect(await recheckConversationListed(client, "c9", "p1", true)).toBeNull();
  });

  it("W2: the re-read needs conversation.archive advertised; without it the outcome stays unknown and nothing is read", async () => {
    const { fake, client } = core();
    seed(fake);
    const sent = () => fake.requests.filter((r) => r.method === "conversation.list").length;
    // A live-only list could not tell an archived conversation from a gone
    // one, so it is never read and never used to forget anything.
    expect(await recheckConversationListed(client, "c9", "p1", false)).toBeNull();
    expect(sent()).toBe(0);
    // Wired through the probed capabilities, read at re-check time.
    const noArchive = { methods: A3B_CORE_METHODS.filter((m) => m !== "conversation.archive") };
    let caps: { methods: string[] } | null = noArchive;
    const recheck = conversationRecheck(client, () => caps);
    expect(await recheck("c9", "p1")).toBeNull();
    caps = null;
    expect(await recheck("c9", "p1")).toBeNull();
    expect(sent()).toBe(0);
    caps = { methods: [...A3B_CORE_METHODS] };
    expect(await recheck("c9", "p1")).toBe(false);
    expect(fake.lastParams("conversation.list")).toEqual({ projectId: "p1", includeArchived: true, limit: 500 });
  });

  it("after step 2 fails in any way, neither the state nor its copy holds the token", async () => {
    for (const reply of [
      { err: { code: "VALIDATION_FAILED", message: CLIENT_TOKEN_REJECTED } },
      { err: { code: "INTERNAL", message: "x" } },
      { ok: { deleted: "yes" } },
      { err: { code: "CONFLICT", message: MSG_CONVERSATION_HAS_TASKS } },
    ]) {
      const { transport, writes } = scripted((_m, params) =>
        params.confirmToken === undefined
          ? {
              ok: {
                confirmation: {
                  token: TOKEN,
                  expiresAt: "2999-01-01T00:00:00Z",
                  action: "conversation.delete",
                  target: { name: "t", id: "c1" },
                  impact: [],
                  external: false,
                },
              },
            }
          : reply,
      );
      const flow = new ConversationDeletionFlow(new CoreClient(transport, { requestTimeoutMs: 60 }));
      await flow.begin("c1", "p1");
      flow.confirm();
      await settle();
      await settle();
      expect(flow.getState().kind).toBe("failed");
      expect(JSON.stringify(flow.getState())).not.toContain(TOKEN);
      // The token went on the wire exactly once (step 2), never again.
      expect(writes.filter((w) => w.params.confirmToken === TOKEN)).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Archived UI state, sandbox label and local forgetting
// ---------------------------------------------------------------------------

describe("archived state, sandbox label and local forgetting", () => {
  const archivedConv: Conversation = { ...CONV, archivedAt: "2026-10-10T01:00:00Z" };

  it("send and rename are blocked with Core's reason; the project reason comes first", () => {
    expect(conversationWriteBlock(CONV, false, "send")).toBeNull();
    expect(conversationWriteBlock(archivedConv, false, "send")).toContain(MSG_CONVERSATION_ARCHIVED);
    expect(conversationWriteBlock(archivedConv, false, "rename")).toContain(MSG_CONVERSATION_ARCHIVED);
    expect(conversationWriteBlock(archivedConv, false, "unarchive")).toBeNull();
    expect(conversationWriteBlock(archivedConv, true, "send")).toContain(MSG_PROJECT_ARCHIVED);
    expect(conversationWriteBlock(archivedConv, true, "rename")).toContain(MSG_PROJECT_ARCHIVED);
    expect(conversationWriteBlock(archivedConv, true, "unarchive")).toContain(MSG_PROJECT_ARCHIVED);
    for (const action of ["archive", "delete", "export"] as const) {
      expect(conversationWriteBlock(archivedConv, true, action)).toBeNull();
    }
  });

  it("'sandbox chosen at creation' is a name, checked against sandbox.list, never a binding", () => {
    const named: Conversation = { ...CONV, sandboxId: "atlas-demo-1" };
    expect(sandboxChosenAtCreation(named, null, null)).toBeNull();
    expect(sandboxChosenAtCreation(named, false, null)?.text).toMatch(/not reported by this Core/);
    expect(sandboxChosenAtCreation(CONV, true, ["atlas-demo-1"])?.text).toBe("none chosen at creation");
    const listed = sandboxChosenAtCreation(named, true, ["atlas-demo-1"]);
    expect(listed?.text).toBe("atlas-demo-1");
    expect(listed?.note).toMatch(/not a binding/);
    expect(sandboxChosenAtCreation(named, true, ["nova-demo"])?.note).toMatch(
      /not in the current sandbox list/,
    );
    expect(sandboxChosenAtCreation(named, true, null)?.note).toMatch(/sandbox list is unavailable/);
    expect(sandboxChosenAtCreation(named, true, null)?.note).not.toMatch(/not in the current sandbox list/);
    const hostile = sandboxChosenAtCreation({ ...CONV, sandboxId: `a${cp(0x202e)}b` }, true, []);
    expect(hostile?.text).toBe("a\\u202Eb");
  });

  it("forgetConversationLocally clears only that selection, this window's row and its cached reads", () => {
    let selected: string | null = "c1";
    const dropped: string[] = [];
    addConversation(CONV);
    addConversation({ ...CONV, id: "c2" });
    forgetConversationLocally("c1", {
      selectedConversationId: () => selected,
      clearSelection: () => {
        selected = null;
      },
      forgetSessionConversation: forgetConversation,
      dropCachedReads: (id) => dropped.push(id),
    });
    expect(selected).toBeNull();
    expect(listConversations().map((c) => c.id)).toEqual(["c2"]);
    expect(dropped).toEqual(["c1"]);
    selected = "c2";
    forgetConversationLocally("c3", {
      selectedConversationId: () => selected,
      clearSelection: () => {
        selected = null;
      },
      forgetSessionConversation: forgetConversation,
      dropCachedReads: () => {},
    });
    expect(selected).toBe("c2");
  });

  it("merged chat lists hide archived rows on BOTH sides unless asked, Core's row wins, scope applies", () => {
    const archivedLocal: Conversation = { ...CONV, id: "c2", archivedAt: "t" };
    const otherProject: Conversation = { ...CONV, id: "c3", projectId: "p2" };
    const core = [{ ...CONV, title: "from Core" }];
    const session = [CONV, archivedLocal, otherProject];
    const off = mergeConversationRows(core, session, { projectId: "p1", showArchived: false });
    expect(off.map((r) => [r.conversation.id, r.conversation.title, r.fromCore])).toEqual([
      ["c1", "from Core", true],
    ]);
    const on = mergeConversationRows(core, session, { projectId: "p1", showArchived: true });
    expect(on.map((r) => r.conversation.id)).toEqual(["c1", "c2"]);
    expect(mergeConversationRows([], session, { projectId: null, showArchived: false }).map((r) => r.conversation.id)).toEqual([
      "c1",
      "c3",
    ]);
  });

  it("a deleted conversation's cached task ids come from task lists and projections; junk is ignored", () => {
    const ids = conversationCacheTaskIds(
      "c1",
      [
        [
          { id: "t1", conversationId: "c1" },
          { id: "t2", conversationId: "c2" },
          null,
          "junk",
        ],
        "not a list",
        undefined,
      ],
      [
        { taskId: "t3", conversationId: "c1" },
        { taskId: "t4", conversationId: null },
      ],
    );
    expect([...ids].sort()).toEqual(["t1", "t3"]);
  });

  it("a rename sends only a changed, valid title", () => {
    expect(planConversationRename(CONV, CONV.title)).toEqual({ title: null, error: null });
    expect(planConversationRename(CONV, "New")).toEqual({ title: "New", error: null });
    expect(planConversationRename(CONV, "   ").error).toMatch(/whitespace-only/);
    expect(planConversationRename(CONV, "   ").title).toBeNull();
  });

  it("Info 5: a stored title Core would refuse is never prefilled raw; the field starts empty and the title is shown revealed", () => {
    expect(renamePrefill(CONV.title)).toEqual({ draft: CONV.title, storedRevealed: null });
    for (const stored of [`a${cp(0x202e)}b`, `a${cp(0x200b)}b`, "line1\nline2", `a${cp(0x2066)}b`]) {
      const prefill = renamePrefill(stored);
      expect(prefill.draft, JSON.stringify(stored)).toBe("");
      expect(prefill.storedRevealed).toBe(displayRevealed(stored, 200).text);
      // An untouched empty field sends nothing and shows no error.
      expect(planConversationRename({ title: stored }, "")).toEqual({ title: null, error: null });
      expect(planConversationRename({ title: stored }, "Clean title")).toEqual({ title: "Clean title", error: null });
    }
  });

  it("replaceConversation keeps this window's copy in step with Core's answer", () => {
    addConversation(CONV);
    replaceConversation({ ...CONV, title: "Renamed", archivedAt: "t" });
    expect(listConversations()[0]).toMatchObject({ title: "Renamed", archivedAt: "t" });
    replaceConversation({ ...CONV, id: "unknown" });
    expect(listConversations()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Export: paging, bounds, assembly, preview and Copy
// ---------------------------------------------------------------------------

function page(over: Partial<ConversationExportPage> & { seqs?: number[] } = {}): ConversationExportPage {
  const seqs = over.seqs ?? [1];
  const { seqs: _s, ...rest } = over;
  return {
    format: CONVERSATION_EXPORT_FORMAT,
    exportedAt: "2026-10-10T00:00:00Z",
    conversation: { ...CONV, title: "[REDACTED:token] chat" },
    messages: seqs.map((s) => ({ id: `m${s}`, conversationId: "c1", role: "user", content: `m${s}`, sequence: s })),
    truncated: false,
    nextSequence: seqs[seqs.length - 1] ?? 0,
    redaction: { bestEffort: true, replacements: 0, byKind: {} },
    ...rest,
  };
}

function pagedClient(pages: (ConversationExportPage | Error)[]) {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    client: {
      exportConversationPage: async (params: { conversationId: string; afterSequence?: number }) => {
        calls.push({ ...params });
        const next = pages[Math.min(calls.length - 1, pages.length - 1)];
        if (next instanceof Error) throw next;
        return next as ConversationExportPage;
      },
    },
  };
}

describe("export paging and assembly", () => {
  it("one complete page: the exact document shape, complete: true, the note", async () => {
    const { client, calls } = pagedClient([
      page({ redaction: { bestEffort: true, replacements: 3, byKind: { token: 2, jwt: 1 } } }),
    ]);
    const outcome = await collectConversationExport(client, "c1");
    expect(calls).toEqual([{ conversationId: "c1", afterSequence: 0 }]);
    if (outcome.kind !== "ready") throw new Error("expected ready");
    expect(Object.keys(outcome.document)).toEqual([
      "format",
      "exportedAt",
      "conversation",
      "messages",
      "redaction",
      "complete",
      "note",
    ]);
    expect(outcome.document).toMatchObject({
      format: CONVERSATION_EXPORT_FORMAT,
      complete: true,
      note: EXPORT_DOCUMENT_NOTE,
      redaction: { bestEffort: true, replacements: 3, byKind: { token: 2, jwt: 1 } },
    });
    expect(EXPORT_DOCUMENT_NOTE).toBe(
      "Redaction is best-effort; review before sharing. Task events, artifacts and verification output are not included.",
    );
    expect(EXPORT_REVIEW_NOTICE).toBe("Redaction is best-effort; review the export before sharing it.");
    expect(outcome.complete).toBe(true);
    expect(JSON.parse(outcome.json)).toEqual(outcome.document);
  });

  it("loops until truncated is false from afterSequence 0, concatenating and SUMMING redaction (absent kind = 0)", async () => {
    const { client, calls } = pagedClient([
      page({ seqs: [1, 2], truncated: true, nextSequence: 2, exportedAt: "first",
        redaction: { bestEffort: true, replacements: 3, byKind: { token: 1, "private-key": 2 } } }),
      page({ seqs: [3], truncated: true, nextSequence: 3, exportedAt: "second",
        conversation: { ...CONV, title: "later page" },
        redaction: { bestEffort: true, replacements: 1, byKind: { token: 1 } } }),
      page({ seqs: [4], truncated: false, nextSequence: 4,
        redaction: { bestEffort: true, replacements: 0, byKind: {} } }),
    ]);
    const outcome = await collectConversationExport(client, "c1");
    expect(calls.map((c) => c.afterSequence)).toEqual([0, 2, 3]);
    if (outcome.kind !== "ready") throw new Error("expected ready");
    expect(outcome.document.messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4]);
    expect(outcome.document.exportedAt).toBe("first");
    expect(outcome.document.conversation.title).toBe("[REDACTED:token] chat");
    expect(outcome.document.redaction).toEqual({
      bestEffort: true,
      replacements: 4,
      byKind: { token: 2, "private-key": 2 },
    });
    expect(outcome.document.complete).toBe(true);
    expect(outcome.pages).toBe(3);
  });

  it("the FakeCore counts the title once (first page), so summing pages counts it once", async () => {
    const { fake, client } = core();
    seed(fake, {
      messages: [
        { sequence: 1, role: "user", content: "a" },
        { sequence: 2, role: "user", content: "b" },
      ],
    });
    fake.exportPageRows = 1;
    fake.titleRedaction = { title: "[REDACTED:token]", byKind: { token: 1 } };
    fake.messageRedaction = (content) => ({ content: `${content}*`, byKind: { jwt: 1 } });
    const outcome = await collectConversationExport(client, "c1");
    if (outcome.kind !== "ready") throw new Error("expected ready");
    expect(fake.callsFor("conversation.export")).toBe(2);
    expect(outcome.document.redaction).toEqual({ bestEffort: true, replacements: 3, byKind: { token: 1, jwt: 2 } });
  });

  it("a cursor that does not strictly increase stops the loop: a partial export, disclosed", async () => {
    const { client, calls } = pagedClient([
      page({ seqs: [1, 2], truncated: true, nextSequence: 2 }),
      page({ seqs: [], truncated: true, nextSequence: 2 }),
    ]);
    const outcome = await collectConversationExport(client, "c1");
    expect(calls).toHaveLength(2);
    if (outcome.kind !== "ready") throw new Error("expected ready");
    expect(outcome.complete).toBe(false);
    expect(outcome.document.complete).toBe(false);
    expect(outcome.stopReason).toBe("cursor");
  });

  it("the hard page cap (200) stops a never-ending export as partial", async () => {
    let n = 0;
    const calls: number[] = [];
    const client = {
      exportConversationPage: async (params: { afterSequence?: number }) => {
        calls.push(params.afterSequence ?? 0);
        n += 1;
        return page({ seqs: [n], truncated: true, nextSequence: n });
      },
    };
    const outcome = await collectConversationExport(client, "c1");
    expect(EXPORT_PAGE_CAP).toBe(200);
    expect(calls).toHaveLength(200);
    if (outcome.kind !== "ready") throw new Error("expected ready");
    expect(outcome.complete).toBe(false);
    expect(outcome.stopReason).toBe("page-cap");
  });

  it("any page failure produces NO export (nothing to copy), with an honest error", async () => {
    const { client } = pagedClient([
      page({ seqs: [1], truncated: true, nextSequence: 1 }),
      new CoreRequestError("core", "INTERNAL", "redaction engine unavailable; nothing was exported"),
    ]);
    const outcome = await collectConversationExport(client, "c1");
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect("document" in outcome).toBe(false);
    expect(outcome.copy.title).toBe("Export failed — no export was produced");
    expect(JSON.stringify(outcome.copy)).not.toMatch(/may have been applied/i);
  });

  it("a lost export answer is NOT called 'may have been applied': export only reads", () => {
    const lost = new CoreRequestError(
      "client",
      "TIMEOUT",
      "conversation.export did not answer within 15000 ms. The request was already handed to Core, so it may have been applied — re-read state before retrying.",
      { mayHaveBeenApplied: true },
    );
    const copy = exportFailureCopy(lost);
    expect(JSON.stringify(copy)).not.toMatch(/may have been applied/i);
    expect(copy.body).toContain("did not answer within 15000 ms");
    expect(copy.action).toMatch(/Nothing was copied/);
  });

  it("a page about another conversation fails the export", async () => {
    const { client } = pagedClient([page({ conversation: { ...CONV, id: "c2" } })]);
    expect((await collectConversationExport(client, "c1")).kind).toBe("failed");
  });

  it("the JSON text escapes hidden characters (still valid JSON), never applying them", () => {
    const doc: ConversationExportDocument = {
      format: CONVERSATION_EXPORT_FORMAT,
      exportedAt: "t",
      conversation: { ...CONV, title: `a${cp(0x202e)}b` },
      messages: [
        { id: "m", conversationId: "c1", role: "user", content: `x${cp(0x2028)}y${cp(0xe0041)}z${cp(0x200b)}`, sequence: 1 },
      ],
      redaction: { bestEffort: true, replacements: 0, byKind: {} },
      complete: true,
      note: EXPORT_DOCUMENT_NOTE,
    };
    const text = exportJsonText(doc);
    for (const raw of [0x202e, 0x2028, 0xe0041, 0x200b]) expect(text).not.toContain(cp(raw));
    expect(text).toContain("\\u202e");
    expect(text).toContain("\\udb40\\udc41");
    expect(JSON.parse(text)).toEqual(doc);
  });

  it("the preview is capped by lines and characters, revealed, and says what is hidden", () => {
    const text = Array.from({ length: 900 }, (_, i) => `line ${i} ${"x".repeat(i === 3 ? 1000 : 3)}`).join("\n");
    const preview = exportPreview(text, { maxLines: 400, maxLineChars: 300 });
    expect(preview.lines).toHaveLength(400);
    expect(preview.hiddenLines).toBe(500);
    expect(preview.lines[3]).toMatch(/more characters\)$/);
    expect(exportPreview(`a${cp(0x202e)}b`).lines[0]).toBe("a\\u202Eb");
  });

  it("Copy writes the FULL text through the clipboard; a missing or failing clipboard is reported", async () => {
    const written: string[] = [];
    expect(await copyExportText("full", { writeText: async (t) => void written.push(t) })).toEqual({ kind: "copied" });
    expect(written).toEqual(["full"]);
    expect((await copyExportText("full", undefined)).kind).toBe("copy-failed");
    const rejected = await copyExportText("full", {
      writeText: async () => {
        throw new Error("NotAllowedError: denied");
      },
    });
    expect(rejected.kind).toBe("copy-failed");
    if (rejected.kind === "copy-failed") expect(rejected.reason).toContain("denied");
  });

  it("the controller is single-flight, keeps the text out of state, copies only when ready, logs nothing", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "debug")];
    const { fake, client } = core();
    seed(fake, { messages: [{ sequence: 1, role: "user", content: "secret-ish ghp_body" }] });
    const written: string[] = [];
    const controller = new ConversationExportController(client, {
      clipboard: () => ({ writeText: async (t: string) => void written.push(t) }),
    });
    expect(await controller.copy()).toBe(false);
    const first = controller.start("c1");
    const second = controller.start("c1");
    await Promise.all([first, second]);
    expect(fake.callsFor("conversation.export")).toBe(1);
    const state = controller.getState();
    expect(state.kind).toBe("ready");
    // The full text lives in the controller only; state carries the capped preview.
    expect(Object.keys(state)).not.toContain("json");
    expect(Object.keys(state)).not.toContain("document");
    expect(await controller.copy()).toBe(true);
    expect(JSON.parse(written[0] ?? "{}").messages[0].content).toBe("secret-ish ghp_body");
    expect(controller.getState()).toMatchObject({ kind: "ready", copy: { kind: "copied" } });
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("no file is ever written: no dialog/fs plugin, no capability for one", () => {
    const pkg = JSON.parse(repoFile("apps/desktop/package.json")) as Record<string, Record<string, string>>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of Object.keys(deps)) {
      expect(name).not.toMatch(/plugin-(dialog|fs)/);
    }
    const caps = repoFile("apps/desktop/src-tauri/capabilities/default.json");
    expect(caps).not.toMatch(/dialog|fs:/);
    const lifecycle = repoFile("apps/desktop/src/lib/conversation-lifecycle.ts");
    expect(lifecycle).not.toMatch(/plugin-dialog|plugin-fs|showSaveDialog|writeFile/);
  });
});

// ---------------------------------------------------------------------------
// Markup (SSR)
// ---------------------------------------------------------------------------

describe("markup (SSR)", () => {
  const confirmation = (impact: string[], name = "Atlas Demo chat"): ConfirmationRequest => ({
    token: TOKEN,
    expiresAt: "2026-10-10T00:02:00Z",
    action: "conversation.delete",
    target: { name, id: "c1" },
    impact,
    external: false,
  });

  it("the delete dialog shows name + id, caps impact at 20, reveals hidden text, never the token", () => {
    const impact = Array.from({ length: 23 }, (_, i) => `line ${i + 1}`);
    impact[0] = `deletes conversation Atlas${cp(0x202e)} chat and all of its Core records`;
    const view = confirmationView(confirmation(impact, `Atlas${cp(0x2028)}chat`), Date.parse("2026-10-10T00:00:00Z"));
    const html = renderToStaticMarkup(createElement(ConversationDeleteConsequence, { view }));
    expect(html).toContain("Atlas\\u2028chat");
    expect(html).toContain("c1");
    expect(html).toContain("deletes conversation Atlas\\u202E chat");
    expect(html).toContain(`line ${MAX_IMPACT_LINES}`);
    expect(html).not.toContain(`line ${MAX_IMPACT_LINES + 1}<`);
    expect(html).toContain("…and 3 more impact lines from Core, not shown here.");
    expect(html).not.toContain("NOT CONFIRMED AS CREATED BY SANDPANE");
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain(cp(0x202e));
    expect(html).toContain(CONVERSATION_DELETE_FOOTNOTE);
  });

  it("the 'gone' notice says Core no longer lists it; the unknown notice never says nothing was deleted", () => {
    const flow = new ConversationDeletionFlow(new CoreClient(new FakeCore().transport));
    const gone = renderToStaticMarkup(
      createElement(ConversationDeletionNotices, {
        flow,
        state: { kind: "gone", conversationId: "c1", projectId: "p1", target: { name: "t", id: "c1" } },
      }),
    );
    expect(gone).toContain("Core no longer lists this conversation");
    expect(gone).not.toMatch(/deleted: true/);
    const { copy, outcomeUnknown } = conversationDeletionFailureCopy(
      new CoreRequestError("client", "TIMEOUT", "lost", { mayHaveBeenApplied: true }),
    );
    const unknown = renderToStaticMarkup(
      createElement(ConversationDeletionNotices, {
        flow,
        state: { kind: "failed", conversationId: "c1", projectId: "p1", stage: "confirm", error: null, copy, outcomeUnknown },
      }),
    );
    expect(unknown).toContain("Outcome unknown — the conversation may have been deleted");
    expect(unknown).not.toMatch(/nothing was deleted/i);
  });

  it("the export panel: the review notice before and after, the count, partial disclosed, Copy, never 'secret-free'", () => {
    const idle = renderToStaticMarkup(
      createElement(ConversationExportPanel, {
        gate: { state: "supported", note: "" },
        state: { kind: "idle" },
        onStart: () => {},
        onCopy: () => {},
        onDismiss: () => {},
      }),
    );
    expect(idle).toContain(EXPORT_REVIEW_NOTICE);
    expect(idle).toContain("Save to file is not available in this build");
    const ready = renderToStaticMarkup(
      createElement(ConversationExportPanel, {
        gate: { state: "supported", note: "" },
        state: {
          kind: "ready",
          conversationId: "c1",
          pages: 2,
          complete: false,
          stopReason: "page-cap",
          replacements: 7,
          byKind: { token: 5, "env-secret": 2 },
          messageCount: 12,
          chars: 3456,
          preview: { lines: ['{', `  "title": "a\\u202Eb"`], hiddenLines: 3, revealed: true },
          copy: { kind: "not-copied" },
        },
        onStart: () => {},
        onCopy: () => {},
        onDismiss: () => {},
      }),
    );
    expect(ready).toContain(EXPORT_REVIEW_NOTICE);
    expect(ready).toContain("7 replacements");
    expect(ready).toContain("token: 5");
    expect(ready).toContain("PARTIAL");
    expect(ready).toMatch(/<pre[^>]*>/);
    expect(ready).toMatch(/<button[^>]*>Copy<\/button>/);
    expect(ready).toContain("3 more lines");
    expect(ready).not.toMatch(/secret-free|no secrets|safe to share/i);
    expect(ready).not.toContain(cp(0x202e));
    const unsupported = renderToStaticMarkup(
      createElement(ConversationExportPanel, {
        gate: { state: "unsupported", note: "This Core does not advertise `conversation.export`." },
        state: { kind: "idle" },
        onStart: () => {},
        onCopy: () => {},
        onDismiss: () => {},
      }),
    );
    expect(unsupported).toMatch(/<button[^>]*disabled=""[^>]*>Export…/);
  });

  function renderActions(conversation: Conversation, methods: readonly string[], projectArchived = false) {
    const fake = new FakeCore({ advertisedMethods: methods });
    const deps = buildDeps(fake.transport);
    const flow = new ConversationDeletionFlow(deps.client);
    return renderToStaticMarkup(
      createElement(CoreProvider, {
        deps,
        children: createElement(ConversationActions, {
          conversation,
          projectArchived,
          gates: conversationLifecycleGates({ methods: [...methods] }),
          deletion: { flow, state: flow.getState() },
        }),
      }),
    );
  }

  it("an archived conversation: rename disabled with Core's reason; unarchive and delete enabled; labelled", () => {
    const html = renderActions({ ...CONV, archivedAt: "2026-10-10T01:00:00Z" }, A3B_CORE_METHODS);
    expect(html).toContain("archived 2026-10-10T01:00:00Z");
    expect(html).toContain(MSG_CONVERSATION_ARCHIVED);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Rename<\/button>/);
    expect(html).toMatch(/<button[^>]*>Unarchive<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Unarchive/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Delete…/);
  });

  it("an A3a Core: every A3b control is disabled as not supported, nothing pretends to work", () => {
    const html = renderActions(CONV, A3A_CORE_METHODS);
    expect(html).toContain("not supported by this Core");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Archive<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Delete…/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Rename<\/button>/);
  });

  it("Info 5: the rename field of a title with a bidi control renders empty, the stored title revealed beside it", () => {
    const html = renderActions({ ...CONV, title: `evil${cp(0x202e)}txt.exe` }, A3B_CORE_METHODS);
    expect(html).not.toContain(cp(0x202e));
    expect(html).toMatch(/<input[^>]*value=""/);
    expect(html).toContain("evil\\u202Etxt.exe");
    expect(html).toContain("not copied into the field");
  });

  it("the sandbox label renders the name revealed with its caveat", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxChosenLabel, {
        view: sandboxChosenAtCreation({ ...CONV, sandboxId: "atlas-demo-1" }, true, []),
      }),
    );
    expect(html).toContain("sandbox chosen at creation");
    expect(html).toContain("atlas-demo-1");
    expect(html).toContain("not in the current sandbox list");
  });
});

// The fake's modeled list honours includeArchived and labels archived rows.
describe("FakeCore A3b model sanity", () => {
  it("conversation.list hides archived rows unless includeArchived; create stores sandboxId", async () => {
    const { fake, client } = core();
    fake.addProject({ id: "p1", name: "Atlas Demo" });
    const created = decodeConversation(
      await client.createConversation({ projectId: "p1", agentId: "codex", title: "  ", sandboxId: "atlas-demo-1" }),
    );
    expect(created.title).toBe("Untitled conversation");
    expect(created.sandboxId).toBe("atlas-demo-1");
    await client.archiveConversation(created.id);
    expect(await client.listConversations({ projectId: "p1" })).toEqual([]);
    const all = await client.listConversations({ projectId: "p1", includeArchived: true });
    expect(all[0]?.archivedAt).toBeDefined();
  });
});
