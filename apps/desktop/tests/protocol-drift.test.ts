/**
 * Drift gate for the protocol-v1 ADDITIVE revision.
 *
 * Nothing here compares the TS mirror to a literal written in this file. Every
 * expectation is read out of the authoritative sources — the Rust protocol crate,
 * the Rust service crate, and `schemas/*.json` — so a change that lands in Core
 * without a matching client update FAILS this suite instead of shipping a silent
 * desync (AGENTS.md §Conventions rule 8, and the `make schema-drift` gate's TS
 * counterpart).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIST_LIMIT,
  MAX_CURSOR_KEY_LEN,
  MAX_FRAME_BYTES,
  MAX_HISTORY_BYTES,
  MAX_LIST_LIMIT,
  MAX_SCOPING_ID_LEN,
  MAX_SUBSCRIBE_CURSORS,
  METHODS,
  PROTOCOL_VERSION,
  coreAdvertisesMethod,
} from "../src/lib/protocol";
import {
  REPO_ROOT,
  protocolRustSource,
  rustFieldExists,
  rustMethodAll,
  rustMethodRenames,
  rustProtocolVersionConst,
  rustServiceConst,
  schemaMethodEnum,
  schemaPropertyNames,
  schemaRequired,
  serviceRustSource,
} from "./support/rust-source";

describe("method surface is derived from the Rust crate, not copied", () => {
  it("the TS allowlist is exactly Method::ALL, in the same order", () => {
    const all = rustMethodAll();
    expect(METHODS).toEqual(all.names);
    expect(all.names.length).toBe(28);
    // The array's own declared length must agree with its contents — a stale
    // `[Method; N]` would be a compile error in Rust, and is caught here too.
    expect(all.declaredLength).toBe(all.names.length);
    expect(METHODS.length).toBe(all.declaredLength);
  });

  it("the shipped schema enumerates the same set", () => {
    expect(schemaMethodEnum()).toEqual([...METHODS]);
    expect(schemaMethodEnum().length).toBe(28);
  });

  it("the enum's serde renames and ALL agree as sets", () => {
    expect([...rustMethodRenames()].sort()).toEqual([...METHODS].sort());
  });

  it("the three additive reads exist on all three sides", () => {
    for (const method of ["task.list", "conversation.list", "conversation.history"]) {
      expect(METHODS).toContain(method);
      expect(schemaMethodEnum()).toContain(method);
      expect(rustMethodAll().names).toContain(method);
    }
  });

  it("no free-form execution method ever appears on any side", () => {
    for (const forbidden of ["shell.exec", "sbx.raw", "fs.read", "process.spawn"]) {
      expect(METHODS).not.toContain(forbidden);
      expect(schemaMethodEnum()).not.toContain(forbidden);
    }
    // Core's own parser table is the authority; the enum body is what we read.
    expect(rustMethodRenames()).not.toContain("shell.exec");
  });

  it("the revision is additive: PROTOCOL_VERSION is unchanged at 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(rustProtocolVersionConst()).toBe(1);
  });
});

describe("additive fields exist in Rust with the names the mirror uses", () => {
  // Each field was added with `#[serde(default)]`, so a pre-revision Core still
  // deserializes. Asserting the exact declaration text means a rename or a
  // semantic change (e.g. `Option` → required) breaks this test.
  const declarations = [
    "pub methods: Vec<String>",
    "pub repositories: Vec<String>",
    "pub workspace_mode: Option<WorkspaceMode>",
    "pub after_sequences: Option<HashMap<String, i64>>",
    "pub statuses: Vec<TaskStatus>",
    "pub limit: Option<u32>",
    "pub truncated: bool",
    "pub next_sequence: i64",
    "pub messages: Vec<MessageRecord>",
  ];

  for (const declaration of declarations) {
    it(`sandpane-protocol declares ${declaration}`, () => {
      expect(rustFieldExists(declaration)).toBe(true);
    });
  }

  it("the new payload structs are the ones the client mirrors", () => {
    for (const struct of [
      "pub struct TaskListParams",
      "pub struct ConversationListParams",
      "pub struct ConversationHistoryParams",
      "pub struct MessageRecord",
      "pub struct ConversationHistoryResult",
    ]) {
      expect(rustFieldExists(struct)).toBe(true);
    }
  });

  it("payload fields are camelCase on the wire", () => {
    // The attribute lives on the PROTOCOL structs (the service only serializes them).
    expect(protocolRustSource()).toContain('rename_all = "camelCase"');
  });

  it("core-capabilities.schema.json advertises methods and does not require them", () => {
    expect(schemaPropertyNames("core-capabilities")).toContain("methods");
    // Additive: a pre-discovery Core omits the field and still validates.
    expect(schemaRequired("core-capabilities")).not.toContain("methods");
  });
});

describe("the bounded-read constants are Core's, not the client's", () => {
  it("every limit mirrors sandpane-service", () => {
    expect(rustServiceConst("DEFAULT_LIST_LIMIT")).toBe(DEFAULT_LIST_LIMIT);
    expect(rustServiceConst("MAX_LIST_LIMIT")).toBe(MAX_LIST_LIMIT);
    expect(rustServiceConst("MAX_HISTORY_BYTES")).toBe(MAX_HISTORY_BYTES);
    expect(rustServiceConst("MAX_SUBSCRIBE_CURSORS")).toBe(MAX_SUBSCRIBE_CURSORS);
    expect(rustServiceConst("MAX_CURSOR_KEY_LEN")).toBe(MAX_CURSOR_KEY_LEN);
    expect(rustServiceConst("MAX_SCOPING_ID_LEN")).toBe(MAX_SCOPING_ID_LEN);
    expect(rustServiceConst("MAX_FRAME_BYTES")).toBe(MAX_FRAME_BYTES);
    // Core's own compile-time invariant, restated so a bad edit is visible here.
    expect(MAX_HISTORY_BYTES).toBeLessThan(MAX_FRAME_BYTES);
  });

  it("the client mirrors the cursor rules verbatim from the service", () => {
    const service = serviceRustSource();
    // taskId present → scalar wins, the map is not consulted at all.
    expect(service).toContain("Some(task_id) => vec![(task_id.clone(), p.after_sequence)]");
    // no taskId → each task's own cursor, absent from the map ⇒ 0, negative ⇒ 0.
    expect(service).toContain("map.get(&tid).copied().unwrap_or(0).max(0)");
    // no map at all → the legacy shared scalar.
    expect(service).toContain("None => p.after_sequence,");
    // and an undeliverable replay is refused structurally, not truncated silently.
    expect(service).toContain("pub const MAX_SUBSCRIBE_BYTES");
    expect(service).toContain("ErrorCode::ValidationFailed");
  });

  it("reads the real crates, not a stale copy", () => {
    // A parse helper that silently found a vendored/old checkout would make this
    // whole gate meaningless, so anchor it to the repository this app lives in.
    expect(REPO_ROOT).toContain("Sandpane");
    expect(serviceRustSource()).toContain("fn task_subscribe(");
  });
});

describe("feature detection never assumes a method exists", () => {
  it("reads the advertised list, in the order Core sends it", () => {
    expect(coreAdvertisesMethod({ methods: [...METHODS] }, "task.list")).toBe(true);
    expect(coreAdvertisesMethod({ methods: ["system.probe"] }, "task.list")).toBe(false);
  });

  it("treats an absent list as NOT advertised — never as a free pass", () => {
    expect(coreAdvertisesMethod({}, "conversation.list")).toBe(false);
    expect(coreAdvertisesMethod({ methods: undefined }, "conversation.history")).toBe(false);
    expect(coreAdvertisesMethod(null, "task.list")).toBe(false);
    expect(coreAdvertisesMethod(undefined, "task.list")).toBe(false);
    expect(coreAdvertisesMethod({ methods: [] }, "system.probe")).toBe(false);
  });
});
