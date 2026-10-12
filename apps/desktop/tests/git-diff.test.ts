/**
 * A5 `git.diff` + ChangeSet fields on the desktop (design 2026-10-09 §3.5):
 * the 28-method surface, the 45 s git deadline for git.review AND git.diff,
 * exact frames (the entry's path byte-for-byte, its status always sent),
 * gating, every flag disclosed, every exact refusal mapped to honest copy, the
 * patch rendered as React TEXT (never an HTML sink), and drift against the
 * Rust sources read from disk.
 *
 * The FakeCore git.review / git.diff behaviour is MODELED on
 * `sandpane-service/src/lib.rs` (working tree), not captured from a live Core,
 * and no wire-created task has Git context until A4b. Hidden characters are
 * built with `String.fromCodePoint` so no raw invisible character lives here.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffView } from "../src/components/review/DiffView";
import {
  CoreClient,
  CoreRequestError,
  METHOD_TIMEOUT_MS,
  PROXY_MAY_HAVE_BEEN_APPLIED_SUFFIX,
  REPLAY_SAFE_METHODS,
} from "../src/lib/core-client";
import { decodeChangeSet, decodeGitDiffResult } from "../src/lib/decode";
import { MalformedFrameError } from "../src/lib/framing";
import {
  BINARY_DISCLOSURE,
  GIT_DIFF_DEFAULT_BYTES,
  GIT_DIFF_MAX_BYTES,
  LOSSY_DISCLOSURE,
  buildGitDiffParams,
  changeSetCompleteness,
  copyDiffText,
  diffCopyNote,
  diffDisclosures,
  diffFailureCopy,
  diffGate,
  patchView,
  symlinkTarget,
} from "../src/lib/git-diff";
import {
  MSG_DIFF_PATH_LISTED_TWICE,
  MSG_DIFF_PATH_NOT_EXACT,
  MSG_DIFF_PATH_NOT_IN_LIST,
  MSG_NO_GIT_CONTEXT,
  MSG_WORKTREE_REMOVED,
  MSG_WORK_TREE_REDIRECTED,
  SUBMODULE_REFUSAL_PREFIX,
  gitMessageCopy,
} from "../src/lib/git-messages";
import { METHODS, type GitDiffResult } from "../src/lib/protocol";
import { describeCoreError } from "../src/lib/reducers";
import { A5_CORE_METHODS, A7_CORE_METHODS, A9_CORE_METHODS, FakeCore, type FakeGitTask } from "./support/fake-core";
import {
  SERVICE_RUST,
  desktopProxyRustSource,
  repoFile,
  rustMethodAll,
  rustStrConst,
  serviceRustSource,
} from "./support/rust-source";

const cp = (n: number): string => String.fromCodePoint(n);
const DIFF_RUST = "core/crates/sandpane-core/src/diff.rs";
const GIT_RUST = "core/crates/sandpane-core/src/git.rs";

/** A path with a tab, a quote and non-ASCII: passed through byte for byte. */
const ODD_PATH = `src/a\tb "q" ${cp(0xfc)}ber.txt`;
const NEWLINE_PATH = "docs/new\nline.txt";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  "-const a = 1;",
  "+const a = 2;",
  " export {};",
  "",
].join("\n");

function gitTask(): FakeGitTask {
  return {
    repoPath: "/Users/dev/Atlas Demo",
    baseCommit: "a".repeat(40),
    hostDirty: false,
    changes: [
      { path: "src/app.ts", status: "modified", patch: PATCH, baseBlob: "b".repeat(40) },
      { path: ODD_PATH, status: "added", patch: `diff --git a/x b/x\n+hi\n` },
      { path: NEWLINE_PATH, status: "untracked", patch: "+x\n" },
      { path: "docs/new.md", oldPath: "docs/old.md", status: "renamed", patch: "" },
      { path: "img/logo.png", status: "modified", patch: "", binary: true },
      { path: "gone.txt", status: "deleted", patch: "-bye\n" },
      { path: "gone.txt", status: "untracked", patch: "+back\n" },
    ],
  };
}

function core(options: ConstructorParameters<typeof FakeCore>[0] = {}) {
  const fake = new FakeCore({ advertisedMethods: A5_CORE_METHODS, ...options });
  fake.gitTasks.set("t1", gitTask());
  fake.addTask({ id: "t1", conversationId: "c1", status: "awaiting_review" });
  const client = new CoreClient(fake.transport, { requestTimeoutMs: 200 });
  return { fake, client };
}

async function failure(p: Promise<unknown>): Promise<CoreRequestError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CoreRequestError);
  return e as CoreRequestError;
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

describe("A5 drift against the Rust sources", () => {
  it("36 methods (since A9), git.diff right after git.review and before git.apply", () => {
    const rust = rustMethodAll();
    expect(rust.declaredLength).toBe(36);
    expect([...METHODS]).toEqual(rust.names);
    expect(METHODS).toHaveLength(36);
    const at = METHODS.indexOf("git.diff");
    expect(METHODS[at - 1]).toBe("git.review");
    expect(METHODS[at + 1]).toBe("git.apply");
    // The A5 Core's 28 are today's up to git.apply; A7 added six after it.
    expect([...A5_CORE_METHODS]).toEqual(METHODS.slice(0, METHODS.indexOf("git.apply") + 1));
    expect([...A9_CORE_METHODS]).toEqual([...METHODS]);
  });

  it("git.diff is not replay-safe on either side", () => {
    expect(REPLAY_SAFE_METHODS.has("git.diff")).toBe(false);
    const replay = /fn replay_safe\(method: Method\) -> bool \{([\s\S]*?)\n\}/.exec(desktopProxyRustSource())?.[1] ?? "";
    expect(replay).toContain("GitReview");
    expect(replay).not.toContain("GitDiff");
  });

  it("git.review and git.diff get the 45 s git deadline: webview 45 000, proxy 43 000", () => {
    expect(METHOD_TIMEOUT_MS["git.diff"]).toBe(45_000);
    expect(METHOD_TIMEOUT_MS["git.review"]).toBe(45_000);
    const body = /pub fn proxy_deadline_ms\(method: Method\) -> u64 \{([\s\S]*?)\n\}/.exec(desktopProxyRustSource())?.[1] ?? "";
    expect(body).toMatch(/Method::GitReview => 43_000/);
    expect(body).toMatch(/Method::GitDiff => 43_000/);
  });

  it("maxBytes bounds are Core's", () => {
    const diff = repoFile(DIFF_RUST);
    expect(/pub const MAX_DIFF_BYTES: usize = 524_288;/.test(diff)).toBe(true);
    expect(/pub const DEFAULT_DIFF_BYTES: usize = 262_144;/.test(diff)).toBe(true);
    expect(GIT_DIFF_MAX_BYTES).toBe(524_288);
    expect(GIT_DIFF_DEFAULT_BYTES).toBe(262_144);
  });

  it("the refusal messages are Core's", () => {
    for (const [name, value] of [
      ["MSG_WORK_TREE_REDIRECTED", MSG_WORK_TREE_REDIRECTED],
      ["MSG_DIFF_PATH_NOT_IN_LIST", MSG_DIFF_PATH_NOT_IN_LIST],
      ["MSG_DIFF_PATH_LISTED_TWICE", MSG_DIFF_PATH_LISTED_TWICE],
      ["MSG_DIFF_PATH_NOT_EXACT", MSG_DIFF_PATH_NOT_EXACT],
    ] as const) {
      expect(rustStrConst(SERVICE_RUST, name), name).toBe(value);
    }
    // A6 made both of these named consts in Core.
    expect(rustStrConst(SERVICE_RUST, "MSG_NO_GIT_CONTEXT")).toBe(MSG_NO_GIT_CONTEXT);
    expect(rustStrConst(SERVICE_RUST, "MSG_WORKTREE_REMOVED")).toBe(MSG_WORKTREE_REMOVED);
    const service = serviceRustSource();
    expect(service).toContain('format!("{m}; nothing was read")');
    const git = repoFile(GIT_RUST);
    expect(git).toContain(`"${SUBMODULE_REFUSAL_PREFIX}{}{extra}`);
    const diff = repoFile(DIFF_RUST);
    for (const reason of [
      "is not a plain path inside the review target",
      "changed while it was being read",
      "is a directory (for example a nested repository)",
      "is not a regular file",
    ]) {
      expect(diff).toContain(reason);
    }
  });
});

// ---------------------------------------------------------------------------
// Frames, decoding, gating
// ---------------------------------------------------------------------------

describe("git.diff frames", () => {
  it("sends the entry's path byte for byte and ALWAYS its status; maxBytes omitted by default", async () => {
    const { fake, client } = core();
    const result = await client.diffFile({ taskId: "t1", path: ODD_PATH, status: "added" });
    expect(fake.lastParams("git.diff")).toEqual({ taskId: "t1", path: ODD_PATH, status: "added" });
    expect(result.path).toBe(ODD_PATH);
    await client.diffFile({ taskId: "t1", path: NEWLINE_PATH, status: "untracked" });
    expect(fake.lastParams<{ path: string }>("git.diff").path).toBe(NEWLINE_PATH);
    // Never trimmed or normalized, even when it looks odd.
    expect(buildGitDiffParams({ taskId: "t1", path: "  lead.txt ", status: "modified" }).path).toBe("  lead.txt ");
  });

  it("maxBytes is clamped to Core's 1..=524288 (never more on the wire)", () => {
    expect(buildGitDiffParams({ taskId: "t1", path: "p", status: "modified", maxBytes: 10_000_000 }).maxBytes).toBe(524_288);
    expect(buildGitDiffParams({ taskId: "t1", path: "p", status: "modified", maxBytes: 0 }).maxBytes).toBe(1);
    expect(buildGitDiffParams({ taskId: "t1", path: "p", status: "modified", maxBytes: 4096 }).maxBytes).toBe(4096);
  });

  it("a path listed twice is told apart by status", async () => {
    const { client } = core();
    const deleted = await client.diffFile({ taskId: "t1", path: "gone.txt", status: "deleted" });
    const untracked = await client.diffFile({ taskId: "t1", path: "gone.txt", status: "untracked" });
    expect(deleted.patch).toBe("-bye\n");
    expect(untracked.patch).toBe("+back\n");
  });

  it("gated on git.diff being advertised", () => {
    expect(diffGate(null).state).toBe("unprobed");
    expect(diffGate({ methods: [...A5_CORE_METHODS] }).state).toBe("supported");
    const old = diffGate({ methods: A5_CORE_METHODS.filter((m) => m !== "git.diff") });
    expect(old.state).toBe("unsupported");
    expect(old.note).toContain("not supported by this Core");
  });

  it("the result decodes strictly and never echoes the payload", () => {
    const ok = { path: "p", status: "modified", patch: "x", binary: false, truncated: false, lossy: false };
    expect(decodeGitDiffResult(ok)).toEqual(ok);
    expect(decodeGitDiffResult({ ...ok, status: "renamed", oldPath: "o", baseBlob: "b" })).toMatchObject({ oldPath: "o", baseBlob: "b" });
    // A status from a newer Core is kept raw, never a decode failure.
    expect(decodeGitDiffResult({ ...ok, status: "copied" })).toMatchObject({ status: "unknown", unrecognizedStatus: "copied" });
    for (const bad of [{ ...ok, patch: 7 }, { ...ok, binary: "no" }, { ...ok, truncated: null }, { ...ok, lossy: 1 }, { ...ok, path: null }]) {
      const call = () => decodeGitDiffResult({ ...bad, leak: "ghp_secretvalue", secretPatch: "ghp_secretvalue" });
      expect(call).toThrow(MalformedFrameError);
      expect(call).not.toThrow(/ghp_secretvalue/);
    }
  });

  it("the change set carries repoPath, uninspected and oldPath (absent-tolerant); paths are exact", async () => {
    const { client } = core();
    const set = await client.reviewChangeSet("t1");
    expect(set.repoPath).toBe("/Users/dev/Atlas Demo");
    expect(set.changes.find((c) => c.status === "renamed")?.oldPath).toBe("docs/old.md");
    expect(set.changes.map((c) => c.path)).toContain(NEWLINE_PATH);
    const bare = decodeChangeSet({ taskId: "t", baseCommit: "b", hostDirty: false, changes: [{ path: "a", status: "added" }] });
    expect(bare).not.toHaveProperty("repoPath");
    expect(bare).not.toHaveProperty("uninspected");
    expect(bare.changes[0]).not.toHaveProperty("oldPath");
  });

  it("uninspected paths: never claimed complete", () => {
    const base = { taskId: "t", baseCommit: "b", hostDirty: false, changes: [] };
    expect(changeSetCompleteness(decodeChangeSet(base))).toBeNull();
    expect(changeSetCompleteness(decodeChangeSet({ ...base, uninspected: [] }))).toBeNull();
    expect(changeSetCompleteness(decodeChangeSet({ ...base, uninspected: ["vendor/lib", "x"] }))).toBe(
      "2 paths were not inspected — this change set is not complete.",
    );
  });
});

// ---------------------------------------------------------------------------
// Disclosures
// ---------------------------------------------------------------------------

const RESULT: GitDiffResult = {
  path: "src/app.ts",
  status: "modified",
  patch: PATCH,
  binary: false,
  truncated: false,
  lossy: false,
};

describe("disclosures", () => {
  it("binary, truncated, lossy, rename and base blob are each disclosed; binary is never 'no changes'", () => {
    expect(BINARY_DISCLOSURE).toBe("treated as binary (possibly by repository attributes) — no text diff shown");
    expect(LOSSY_DISCLOSURE).toBe("contains bytes that are not valid UTF-8; shown with replacement characters");
    expect(diffDisclosures({ ...RESULT, binary: true, patch: "" }, undefined)).toContain(BINARY_DISCLOSURE);
    expect(diffDisclosures({ ...RESULT, truncated: true }, undefined)).toContain("diff truncated at 262144 bytes");
    expect(diffDisclosures({ ...RESULT, truncated: true }, 4096)).toContain("diff truncated at 4096 bytes");
    expect(diffDisclosures({ ...RESULT, lossy: true }, undefined)).toContain(LOSSY_DISCLOSURE);
    expect(diffDisclosures({ ...RESULT, status: "renamed", oldPath: "docs/old.md", path: "docs/new.md" }, undefined)).toContain(
      "docs/old.md → docs/new.md",
    );
    expect(diffDisclosures({ ...RESULT, baseBlob: "0123456789abcdef0123" }, undefined)).toContain("base blob 0123456789ab");
    const all = [
      ...diffDisclosures({ ...RESULT, binary: true, patch: "" }, undefined),
      ...diffDisclosures({ ...RESULT, patch: "" }, undefined),
    ].join(" ");
    expect(all.toLowerCase()).not.toContain("no changes");
  });

  it("rename paths are revealed", () => {
    const lines = diffDisclosures({ ...RESULT, status: "renamed", oldPath: `a${cp(0x202e)}b`, path: "c\nd" }, undefined);
    expect(lines).toContain("a\\u202Eb → c\\u000Ad");
  });

  it("a symlink (new file mode 120000) shows 'symlink → target', the target revealed", () => {
    const patch = [
      "diff --git a/link b/link",
      "new file mode 120000",
      "--- /dev/null",
      "+++ b/link",
      "@@ -0,0 +1 @@",
      `+../tar${cp(0x202e)}get`,
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(symlinkTarget({ ...RESULT, status: "untracked", patch })).toBe(`../tar${cp(0x202e)}get`);
    expect(diffDisclosures({ ...RESULT, status: "untracked", path: "link", patch }, undefined)).toContain(
      "symlink → ../tar\\u202Eget",
    );
    expect(symlinkTarget({ ...RESULT, status: "untracked", patch: PATCH })).toBeNull();
    // A "+new file mode 120000" CONTENT line after the hunk is not a header.
    expect(
      symlinkTarget({
        ...RESULT,
        status: "untracked",
        patch: "diff --git a/x b/x\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+new file mode 120000\n",
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Honest copy
// ---------------------------------------------------------------------------

describe("refusals and failures get honest copy", () => {
  it("each exact refusal says nothing was read", async () => {
    const cases: [string, string, RegExp][] = [
      ["VALIDATION_FAILED", MSG_DIFF_PATH_NOT_IN_LIST, /not in this task's change list/],
      ["VALIDATION_FAILED", MSG_DIFF_PATH_LISTED_TWICE, /listed more than once/],
      ["VALIDATION_FAILED", MSG_DIFF_PATH_NOT_EXACT, /not valid UTF-8/],
      ["VALIDATION_FAILED", MSG_WORK_TREE_REDIRECTED, /work tree/],
      ["VALIDATION_FAILED", MSG_NO_GIT_CONTEXT, /no Git context/],
      ["VALIDATION_FAILED", MSG_WORKTREE_REMOVED, /worktree was removed/],
      ["VALIDATION_FAILED", `${SUBMODULE_REFUSAL_PREFIX}"vendor/lib"; Sandpane cannot verify submodule work trees safely`, /submodule/],
      ["VALIDATION_FAILED", '"docs/x" changed while it was being read; nothing was read', /changed while/],
      ["VALIDATION_FAILED", '"fifo" is not a regular file; nothing was read', /not a regular file/],
    ];
    for (const [code, message, reason] of cases) {
      const copy = gitMessageCopy(code, message, "git.diff");
      expect(copy, message).not.toBeNull();
      expect(copy?.title, message).toMatch(/^Nothing was read/);
      expect(`${copy?.title} ${copy?.action}`, message).toMatch(reason);
      const err = new CoreRequestError("core", code as "VALIDATION_FAILED", message, undefined, "git.diff");
      expect(describeCoreError(err).title).toBe(copy?.title);
    }
    // Not an exact message / another code: no "nothing was read" claim.
    expect(gitMessageCopy("INTERNAL", MSG_DIFF_PATH_NOT_IN_LIST, "git.diff")).toBeNull();
    expect(gitMessageCopy("VALIDATION_FAILED", "something else", "git.diff")).toBeNull();
  });

  it("through FakeCore: unknown path, twice-listed without status, no Git context, unknown task", async () => {
    const { fake, client } = core();
    fake.addTask({ id: "t2", conversationId: "c1", status: "queued" });
    const notListed = await failure(client.diffFile({ taskId: "t1", path: "nope.txt", status: "modified" }));
    expect([notListed.code, notListed.message]).toEqual(["VALIDATION_FAILED", MSG_DIFF_PATH_NOT_IN_LIST]);
    const twice = await failure(client.request("git.diff", { taskId: "t1", path: "gone.txt" }));
    expect(twice.message).toBe(MSG_DIFF_PATH_LISTED_TWICE);
    const noGit = await failure(client.diffFile({ taskId: "t2", path: "a", status: "added" }));
    expect(noGit.message).toBe(MSG_NO_GIT_CONTEXT);
    const unknown = await failure(client.diffFile({ taskId: "t9", path: "a", status: "added" }));
    expect(unknown.code).toBe("NOT_FOUND");
  });

  it("a timeout says Core did not answer and that no file was changed (git.diff is read-only)", async () => {
    const fake = new FakeCore({ advertisedMethods: A5_CORE_METHODS, latencyMs: 80 });
    fake.gitTasks.set("t1", gitTask());
    fake.addTask({ id: "t1", conversationId: "c1", status: "awaiting_review" });
    const client = new CoreClient(fake.transport, { methodTimeoutsMs: { "git.diff": 10 } });
    const err = await failure(client.diffFile({ taskId: "t1", path: "src/app.ts", status: "modified" }));
    expect(err.code).toBe("TIMEOUT");
    const copy = diffFailureCopy(err);
    expect(copy.title).toBe("Core did not answer in time — no file was changed (git.diff is read-only)");
    expect(`${copy.title} ${copy.body} ${copy.action}`).not.toMatch(/may have been applied/i);
  });

  it("a Core refusal through diffFailureCopy keeps Core's honest copy", () => {
    const err = new CoreRequestError("core", "VALIDATION_FAILED", MSG_DIFF_PATH_NOT_IN_LIST);
    expect(diffFailureCopy(err).title).toMatch(/^Nothing was read/);
    const internal = new CoreRequestError("core", "INTERNAL", "git diff failed");
    expect(diffFailureCopy(internal).title).toBe("Core could not produce the diff — no file was changed (git.diff is read-only)");
  });
});

// ---------------------------------------------------------------------------
// Rendering: text only, revealed, capped, never an HTML sink
// ---------------------------------------------------------------------------

describe("the patch is untrusted text", () => {
  it("SSR: <script> stays text, bidi and hidden characters are revealed and the line is marked", () => {
    const hostile = [
      "diff --git a/x b/x",
      "@@ -1 +1 @@",
      "-<script>alert(1)</script>",
      `+safe ${cp(0x202e)}txt.exe`,
      `+zero${cp(0x200b)}width and line${cp(0x2028)}sep`,
      "+\tindented",
      "",
    ].join("\n");
    const html = renderToStaticMarkup(
      createElement(DiffView, { result: { ...RESULT, patch: hostile }, maxBytesSent: undefined, onCopy: () => {} }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain(cp(0x202e));
    expect(html).not.toContain(cp(0x200b));
    expect(html).not.toContain(cp(0x2028));
    expect(html).toContain("\\u202E");
    expect(html).toContain("\\u200B");
    expect(html).toContain("\\u2028");
    expect(html).toMatch(/data-unusual="true"/);
    // Tabs are ordinary patch whitespace and stay as they are.
    expect(html).toContain("+\tindented");
    expect(html).toContain("Copy");
    expect(html).not.toMatch(/dangerouslySetInnerHTML|<iframe|<img/);
  });

  it("the view is capped by lines and characters, with the rest disclosed", () => {
    const many = Array.from({ length: 3000 }, (_, i) => `+line ${i}`).join("\n");
    const view = patchView(many);
    expect(view.lines).toHaveLength(2000);
    expect(view.hiddenLines).toBe(1000);
    const long = patchView(`+${"x".repeat(5000)}`);
    expect(long.lines[0].text).toMatch(/more characters\)$/);
    expect(patchView("").lines).toEqual([]);
  });

  it("binary / truncated / lossy / rename render as disclosures, never as an empty 'no changes' view", () => {
    const html = renderToStaticMarkup(
      createElement(DiffView, {
        result: { ...RESULT, status: "renamed", oldPath: "a.png", path: "b.png", binary: true, patch: "", truncated: false, lossy: true },
        maxBytesSent: undefined,
        onCopy: () => {},
      }),
    );
    expect(html).toContain(BINARY_DISCLOSURE);
    expect(html).toContain(LOSSY_DISCLOSURE);
    expect(html).toContain("a.png → b.png");
    expect(html.toLowerCase()).not.toContain("no changes");
  });

  it("Copy reports success and failure honestly", async () => {
    const written: string[] = [];
    expect(await copyDiffText({ writeText: async (t) => void written.push(t) }, PATCH)).toEqual({ ok: true });
    expect(written).toEqual([PATCH]);
    const failed = await copyDiffText({ writeText: async () => Promise.reject(new Error("denied")) }, PATCH);
    expect(failed).toEqual({ ok: false, message: "Copy failed — the clipboard refused the text. Nothing was copied." });
    expect(await copyDiffText(undefined, PATCH)).toEqual({
      ok: false,
      message: "Copy is not available here — no clipboard access. Nothing was copied.",
    });
  });
});

// ---------------------------------------------------------------------------
// FakeCore model sanity (MODELED, not captured)
// ---------------------------------------------------------------------------

describe("FakeCore A5 model", () => {
  it("binary entries have an empty patch; a small maxBytes truncates at a line boundary", async () => {
    const { client } = core();
    const bin = await client.diffFile({ taskId: "t1", path: "img/logo.png", status: "modified" });
    expect([bin.binary, bin.patch]).toEqual([true, ""]);
    const cut = await client.diffFile({ taskId: "t1", path: "src/app.ts", status: "modified", maxBytes: 60 });
    expect(cut.truncated).toBe(true);
    expect(cut.patch.endsWith("\n")).toBe(true);
    expect(new TextEncoder().encode(cut.patch).length).toBeLessThanOrEqual(60);
    expect(cut.baseBlob).toBe("b".repeat(40));
  });
});

// ---------------------------------------------------------------------------
// A5 combined client review fixes (W1, W4, I2, I4, I5)
// ---------------------------------------------------------------------------

describe("A5 review fixes", () => {
  const SYMLINK = [
    "diff --git a/link b/link",
    "new file mode 120000",
    "--- /dev/null",
    "+++ b/link",
    "@@ -0,0 +1 @@",
    "+../target",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const untracked = (patch: string): GitDiffResult => ({ ...RESULT, status: "untracked", path: "link", patch });

  it("W1: the symlink line needs untracked + line 2 'new file mode 120000' + '@@ -0,0 +1 @@' + exactly one '+' line", () => {
    expect(symlinkTarget(untracked(SYMLINK))).toBe("../target");
    // A target with a newline is two '+' lines: no symlink line at all, never a partial target.
    const twoLines = [
      "diff --git a/p b/p",
      "new file mode 120000",
      "--- /dev/null",
      "+++ b/p",
      "@@ -0,0 +1,2 @@",
      "+safe",
      "+../../x",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(symlinkTarget(untracked(twoLines))).toBeNull();
    expect(diffDisclosures(untracked(twoLines), undefined).join(" ")).not.toContain("symlink");
    // Two '+' lines under an exact '@@ -0,0 +1 @@' header are refused too.
    expect(symlinkTarget(untracked(SYMLINK.replace("+../target", "+a\n+b")))).toBeNull();
    // A typechange: the mode appears mid-patch (after a deletion), not on line 2.
    const typechange = [
      "diff --git a/f b/f",
      "deleted file mode 100644",
      "index ce01362..0000000",
      "--- a/f",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-hello",
      "diff --git a/f b/f",
      "new file mode 120000",
      "index 0000000..2b65e96",
      "--- /dev/null",
      "+++ b/f",
      "@@ -0,0 +1 @@",
      "+/etc/target",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    for (const status of ["modified", "untracked"] as const) {
      expect(symlinkTarget({ ...RESULT, status, patch: typechange })).toBeNull();
      expect(diffDisclosures({ ...RESULT, status, patch: typechange }, undefined).join(" ")).not.toContain("symlink");
    }
    // Only an untracked entry, never a binary or truncated one.
    expect(symlinkTarget({ ...untracked(SYMLINK), status: "added" })).toBeNull();
    expect(symlinkTarget({ ...untracked(SYMLINK), truncated: true })).toBeNull();
    expect(symlinkTarget({ ...untracked(SYMLINK), binary: true })).toBeNull();
  });

  it("W4: the proxy's lost-answer suffix (Rust, read from disk) never reaches the git.diff failure copy", () => {
    const rustSuffix = rustStrConst("apps/desktop/src-tauri/src/ipc_client.rs", "MAY_HAVE_BEEN_APPLIED_SUFFIX");
    expect(rustSuffix).toBe(PROXY_MAY_HAVE_BEEN_APPLIED_SUFFIX);
    for (const [code, proxyCode] of [
      ["TRANSPORT_CLOSED", "CONNECTION_CLOSED"],
      ["MALFORMED_FRAME", "MALFORMED_FRAME"],
      ["TRANSPORT_UNAVAILABLE", "READ_FAILED"],
    ] as const) {
      const err = new CoreRequestError(
        "client",
        code,
        `Core closed the connection before answering${PROXY_MAY_HAVE_BEEN_APPLIED_SUFFIX}`,
        { proxyCode, mayHaveBeenApplied: true },
      );
      const copy = diffFailureCopy(err);
      const all = `${copy.title} ${copy.body} ${copy.action}`;
      expect(all).not.toContain(PROXY_MAY_HAVE_BEEN_APPLIED_SUFFIX.trim());
      expect(all).not.toMatch(/may have been applied|already been delivered/i);
      expect(copy.body).toContain("Core closed the connection before answering");
      expect(copy.title).toMatch(/no file was changed \(git\.diff is read-only\)$/);
    }
  });

  it("W4: the proxy marks the suffix only for methods that may mutate (is_read_only, separate from replay_safe)", () => {
    const proxy = desktopProxyRustSource();
    const body = /fn is_read_only\(method: Method\) -> bool \{([\s\S]*?)\n\}/.exec(proxy)?.[1] ?? "";
    expect(body).toMatch(/Method::GitDiff\s*=>\s*true|Method::GitDiff\s*\|/);
    expect(proxy).toMatch(/fn after_write\(method: Method, mut err: ProxyError\) -> ProxyError \{\s*if !is_read_only\(method\)/);
  });

  it("I2: the per-line cap applies to the whole joined line, not to each tab-separated segment", () => {
    const line = `+${"a".repeat(899)}\t${"b".repeat(900)}`;
    const [shown] = patchView(line).lines;
    expect(shown.text).toBe(`+${"a".repeat(899)}\t${"b".repeat(99)}… (801 more characters)`);
    // Many short segments cannot add up past the cap either.
    const tabs = patchView(Array.from({ length: 600 }, () => "xy").join("\t")).lines[0];
    expect(Array.from(tabs.text.replace(/… \(\d+ more characters\)$/, ""))).toHaveLength(1000);
    // A hidden character past the cut still marks the line.
    expect(patchView(`+${"a".repeat(1200)}${cp(0x202e)}`).lines[0].unusual).toBe(true);
  });

  it("I4: the submodule prefix and the '; nothing was read' suffix are git.review / git.diff copy only", () => {
    const patterned = [
      `${SUBMODULE_REFUSAL_PREFIX}"vendor/lib"; Sandpane cannot verify submodule work trees safely`,
      '"docs/x" changed while it was being read; nothing was read',
    ];
    for (const message of patterned) {
      for (const method of ["git.review", "git.diff"] as const) {
        expect(gitMessageCopy("VALIDATION_FAILED", message, method)?.title).toMatch(/^Nothing was read/);
        const err = new CoreRequestError("core", "VALIDATION_FAILED", message, undefined, method);
        expect(describeCoreError(err).title).toMatch(/^Nothing was read/);
      }
      for (const method of ["conversation.delete", "project.update", "git.apply", undefined] as const) {
        expect(gitMessageCopy("VALIDATION_FAILED", message, method), String(method)).toBeNull();
        const err = new CoreRequestError("core", "VALIDATION_FAILED", message, undefined, method);
        expect(describeCoreError(err).title, String(method)).not.toMatch(/nothing was read/i);
      }
    }
  });

  it("I4: a Core error from the wire carries the method it answered", async () => {
    const { client } = core();
    const err = await failure(client.diffFile({ taskId: "t1", path: "nope.txt", status: "modified" }));
    expect(err.method).toBe("git.diff");
  });

  it("I5: the Copy note counts lines with hidden characters and says never to apply the patch", () => {
    expect(diffCopyNote(PATCH)).toBe(
      "Copied the patch exactly as Core returned it. Never apply this patch — it may create symlinks.",
    );
    // Counted over the WHOLE patch (Copy copies all of it), not just the shown lines; tabs are not hidden.
    const hidden = [
      `+a${cp(0x202e)}b`,
      "+\tplain tab",
      ...Array.from({ length: 2100 }, () => "+x"),
      `+z${cp(0x200b)}`,
      `+cr\r`,
      "",
    ].join("\n");
    expect(diffCopyNote(hidden)).toBe(
      "Copied the patch exactly as Core returned it. It contains 3 lines with hidden characters. Never apply this patch — it may create symlinks.",
    );
    expect(diffCopyNote(`+a${cp(0x2028)}b\n`)).toContain("It contains 1 line with hidden characters.");
  });
});
