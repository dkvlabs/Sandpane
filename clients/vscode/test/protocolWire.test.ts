import { describe, expect, it } from 'vitest';
import { isTaskStatus, normalizeAgentEvent, statusFromEvent, TASK_STATUSES, ERROR_CODES } from '../src/core-client/events';
import {
  WORKSPACE_MODES,
  CORE_METHODS,
  MAX_FRAME_BYTES,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_HISTORY_BYTES,
  MAX_SUBSCRIBE_CURSORS,
  MAX_CURSOR_KEY_LEN,
  MAX_SCOPING_ID_LEN,
  PROTOCOL_VERSION,
  SBX_AGENTS,
  DEFAULT_SBX_AGENT,
  coreAdvertisesMethod,
} from '../src/core-client/protocol';
import { MAX_ADDRESSABLE_SANDBOX_NAME_LEN } from '../src/core-client/commands';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Drift guard. The Rust crate is the source of truth (schemas/README.md), so the
 * TS unions are compared against the literal names used there AND against the
 * JSON schemas in the repo. If a protocol change lands in Rust without a TS or
 * schema update, this test fails instead of shipping a silent desync
 * (AGENTS.md rule 8).
 */
// `npm test` runs from clients/vscode; the repo root is two levels up.
const repoRoot = resolve(process.cwd(), '..', '..');
const read = (relative: string): string => {
  try {
    return readFileSync(resolve(repoRoot, relative), 'utf8');
  } catch (error) {
    throw new Error(
      `protocol drift guard cannot read ${relative} from ${repoRoot} — run tests from clients/vscode (${String(error)})`,
    );
  }
};
const rustProtocol = read('core/crates/sandpane-protocol/src/lib.rs');
const serviceLib = read('core/crates/sandpane-service/src/lib.rs');

/** All shipped schemas concatenated — the wire side of the drift check. */
const allSchemas = [
  'schemas/rpc-request.schema.json',
  'schemas/rpc-response.schema.json',
  'schemas/core-capabilities.schema.json',
  'schemas/agent-event.schema.json',
  'schemas/task-event.schema.json',
  'schemas/sandbox-create-spec.schema.json',
  'schemas/change-set.schema.json',
]
  .map(read)
  .join('\n');

/** Source of one Rust enum, from its attribute cluster to its closing brace. */
function enumBlock(name: string): string {
  const decl = rustProtocol.indexOf(`pub enum ${name}`);
  if (decl < 0) throw new Error(`sandpane-protocol has no \`pub enum ${name}\``);
  // Include the preceding `#[derive] / #[serde(rename_all = ...)]` lines: the
  // casing rule lives above the declaration, not inside it.
  const attrs = rustProtocol.lastIndexOf('#[', decl);
  const start = attrs >= 0 && decl - attrs < 400 ? attrs : decl;
  const end = rustProtocol.indexOf('\n}', decl);
  if (end < 0) throw new Error(`unterminated enum ${name}`);
  return rustProtocol.slice(start, end);
}

/** Plain `Variant,` lines of an enum block (skip tuple variants' bodies). */
function enumVariants(block: string): string[] {
  return [...block.matchAll(/^\s{4}([A-Z][A-Za-z0-9]*)(,| \{)/gm)].map((m) => m[1] as string);
}

function toSnakeCase(variant: string): string {
  return variant.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * `Self::Variant => "wire.name",` from Rust's `Method::as_str`.
 *
 * Scanned over the whole crate rather than a byte slice: `ErrorCode` has an
 * `as_str` with the identical signature, and its arms return SCREAMING_SNAKE
 * names, so the dotted-lowercase requirement is what selects Method's table.
 */
function methodWireNames(): Record<string, string> {
  const table: Record<string, string> = {};
  for (const m of rustProtocol.matchAll(/Self::([A-Z][A-Za-z0-9]*) => "([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)"/g)) {
    table[m[1] as string] = m[2] as string;
  }
  if (Object.keys(table).length === 0) {
    throw new Error('no `Self::Variant => "a.b"` arms found — Method::as_str changed shape');
  }
  return table;
}

/**
 * The order of `Method::ALL` — the list Rust derives `CoreCapabilities.methods`
 * from. Parsing the block rather than quoting the names means a rename or a
 * reorder in Rust fails this test instead of silently desyncing the client.
 */
function methodAllWireNames(): string[] {
  const decl = /pub const ALL: \[Method; (\d+)\] = \[([\s\S]*?)\];/.exec(rustProtocol);
  if (!decl?.[1] || !decl[2]) throw new Error('sandpane-protocol has no `pub const ALL: [Method; N] = [...]`');
  const declared = Number(decl[1]);
  const variants = [...decl[2].matchAll(/Self::([A-Z][A-Za-z0-9]*),/g)].map((m) => m[1] as string);
  expect(variants.length, 'Method::ALL entries vs its declared array length').toBe(declared);
  const table = methodWireNames();
  return variants.map((v) => {
    const name = table[v];
    if (!name) throw new Error(`Method::ALL names ${v}, which as_str does not map to a wire name`);
    return name;
  });
}

/** `pub const NAME: <type> = <expr>;` from the service crate (RHS, trimmed). */
function serviceConst(name: string): string {
  const found = new RegExp(`pub const ${name}: [A-Za-z0-9_<>]+ = ([^;]+);`).exec(serviceLib);
  const rhs = found?.[1];
  if (!rhs) throw new Error(`sandpane-service has no \`pub const ${name}\``);
  return rhs.trim();
}

/** Evaluate a plain `N`, `N * N` or `N * N * N` constant — nothing else. */
function evalConst(rhs: string): number {
  if (!/^\d+(?:\s*\*\s*\d+)*$/.test(rhs)) {
    throw new Error(`unsupported const expression "${rhs}" — pin it explicitly`);
  }
  return rhs.split('*').reduce((acc, part) => acc * Number(part.trim()), 1);
}

describe('wire names match the Rust protocol crate', () => {
  it('pins the protocol version and the frame ceiling', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(rustProtocol).toContain('pub const PROTOCOL_VERSION: u32 = 1;');
    expect(MAX_FRAME_BYTES).toBe(4 * 1024 * 1024);
    expect(serviceLib).toContain('pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;');
  });

  it('declares exactly the 16 method names Core parses, in Method::ALL order', () => {
    // (1) every `"dotted.name" =>` arm of Rust's `Method::parse`.
    const fromRust = [...rustProtocol.matchAll(/"([a-z]+\.[a-z]+)" =>/g)].map((m) => m[1]);
    expect(fromRust.sort()).toEqual([...CORE_METHODS].sort());
    expect(new Set(fromRust).size).toBe(16);
    expect(CORE_METHODS).toHaveLength(16);
    // (2) the advertisement list itself, including ORDER — `CoreCapabilities.methods`
    // is derived from it, and a name that renames in Rust must break here.
    expect(methodAllWireNames()).toEqual([...CORE_METHODS]);
    // (3) the schema the drift gate (`make schema-drift`) compares against Rust.
    const requestSchema = JSON.parse(read('schemas/rpc-request.schema.json')) as {
      properties: { method: { enum: string[] } };
    };
    expect(requestSchema.properties.method.enum).toEqual([...CORE_METHODS]);
    // (4) every method parses, and none of them is a free-form escape hatch.
    for (const name of CORE_METHODS) {
      expect(rustProtocol, `Method::parse arm for ${name}`).toContain(`"${name}" =>`);
      expect(rustProtocol, `Method::as_str arm for ${name}`).toContain(`=> "${name}"`);
    }
    for (const forbidden of ['shell.exec', 'sbx.raw', 'fs.read', 'process.spawn']) {
      expect(CORE_METHODS).not.toContain(forbidden);
    }
    // The new read surface exists on both sides of the wire.
    for (const added of ['task.list', 'conversation.list', 'conversation.history']) {
      expect(CORE_METHODS).toContain(added);
    }
    // A1: stop/remove sit right after sandbox.create; there is NO sandbox.start
    // (sbx v0.47 has none), on either side of the wire.
    expect(CORE_METHODS.slice(4, 7)).toEqual(['sandbox.create', 'sandbox.stop', 'sandbox.remove']);
    expect(CORE_METHODS).not.toContain('sandbox.start');
    expect(rustProtocol).not.toContain('"sandbox.start" =>');
  });

  it('pins the A1 sandbox lifecycle wire shapes against Rust and the schemas', () => {
    for (const struct of [
      'pub struct SandboxStopParams',
      'pub struct SandboxStopResult',
      'pub struct SandboxRemoveParams',
      'pub struct ConfirmationTarget',
      'pub struct ConfirmationRequest',
      'pub struct SandboxRemoveResult',
    ]) {
      expect(rustProtocol).toContain(struct);
    }
    // Rust snake_case field → the camelCase wire name this client sends/reads.
    const pinned: [string, string][] = [
      ['pub confirm_token: Option<String>', 'confirmToken'],
      ['pub expires_at: String', 'expiresAt'],
      ['pub requeried: Option<SandboxSummary>', 'requeried'],
      ['pub impact: Vec<String>', 'impact'],
      ['pub external: bool', 'external'],
      ['pub removed: Option<bool>', 'removed'],
      ['pub stopped: bool', 'stopped'],
      ['pub agent: Option<String>', 'agent'],
    ];
    const tsClient = read('clients/vscode/src/core-client/protocol.ts');
    for (const [rust, wire] of pinned) {
      expect(rustProtocol, `rust field "${rust}"`).toContain(rust);
      expect(tsClient, `TS wire name "${wire}"`).toContain(wire);
    }
    // `requeried` and `agent` are absent-tolerant on the Rust side.
    expect(rustProtocol).toMatch(/skip_serializing_if = "Option::is_none"\)\]\n\s+pub requeried/);
  });

  it('pins the addressable sandbox-name rule to Validator::sandbox_name (W3)', () => {
    const validation = read('core/crates/sandpane-core/src/validation.rs');
    const fn = /pub fn sandbox_name\(name: &str\)[\s\S]*?\n    \}/.exec(validation)?.[0];
    if (!fn) throw new Error('Validator::sandbox_name not found');
    expect(fn, "Core's length bound").toContain('Self::bounded(name, 128)?;');
    expect(MAX_ADDRESSABLE_SANDBOX_NAME_LEN).toBe(128);
    expect(fn, "Core's charset").toContain("c.is_ascii_alphanumeric() || c == '-' || c == '.'");
    expect(fn, "Core's two-character minimum").toContain('name.chars().count() < 2');
    expect(fn, "Core's leading-character rule").toContain('.is_some_and(|c| c.is_ascii_alphanumeric())');
    expect(fn, "Core's reserved name").toContain('eq_ignore_ascii_case("default")');
  });

  it('pins the sbx agent allowlist to the create-spec schema', () => {
    const specSchema = JSON.parse(read('schemas/sandbox-create-spec.schema.json')) as {
      properties: { agent?: { enum: string[] } };
      required?: string[];
    };
    expect(specSchema.properties.agent?.enum).toEqual([...SBX_AGENTS]);
    // Optional + defaulted to the provider-free shell by Core.
    expect(specSchema.required ?? []).not.toContain('agent');
    expect(DEFAULT_SBX_AGENT).toBe('shell');
    expect(serviceLib).toContain('pub const DEFAULT_SANDBOX_AGENT: &str = "shell";');
  });

  it('pins the method advertisement (`Method::ALL` → `CoreCapabilities.methods`)', () => {
    expect(rustProtocol).toContain('pub const ALL: [Method; 16]');
    // Derived, never hand-written: `wire_names()` maps over ALL…
    expect(rustProtocol).toMatch(/pub fn wire_names\(\) -> Vec<&'static str> \{[\s\S]*Self::ALL\.iter\(\)/);
    // …and the probe answers with it.
    expect(serviceLib).toMatch(/methods:[\s\S]{0,200}Method::wire_names\(\)/);
    expect(rustProtocol).toContain('pub methods: Vec<String>');
    // The client mirrors it as an optional field and feature-detects with it
    // instead of assuming a method from the protocol version.
    expect(read('clients/vscode/src/core-client/protocol.ts')).toContain('methods?: string[]');
    expect(coreAdvertisesMethod({ methods: [...CORE_METHODS] }, 'task.list')).toBe(true);
    expect(coreAdvertisesMethod({ methods: ['system.probe'] }, 'task.list')).toBe(false);
    // A pre-discovery Core omits the field: absence must mean "not advertised".
    expect(coreAdvertisesMethod({}, 'task.list')).toBe(false);
    expect(coreAdvertisesMethod({ methods: undefined }, 'conversation.history')).toBe(false);
    const capsSchema = JSON.parse(read('schemas/core-capabilities.schema.json')) as {
      properties: { methods?: { items: { pattern?: string } }; agents: unknown };
      required: string[];
    };
    expect(capsSchema.properties.methods).toBeDefined();
    // Additive: not required, so a pre-revision response still validates.
    expect(capsSchema.required).not.toContain('methods');
  });

  it('pins the additive v1 field names against the Rust structs', () => {
    // Every field this revision added is `#[serde(default)]` on the Rust side,
    // optional on the TS side, and spelled in camelCase on the wire.
    const added: [string /* rust */, string /* wire */][] = [
      ['pub methods: Vec<String>', 'methods'],
      ['pub repositories: Vec<String>', 'repositories'],
      ['pub workspace_mode: Option<WorkspaceMode>', 'workspaceMode'],
      ['pub after_sequences: Option<HashMap<String, i64>>', 'afterSequences'],
      ['pub next_sequence: i64', 'nextSequence'],
      ['pub truncated: bool', 'truncated'],
      ['pub messages: Vec<MessageRecord>', 'messages'],
      ['pub statuses: Vec<TaskStatus>', 'statuses'],
      ['pub limit: Option<u32>', 'limit'],
    ];
    const tsClient =
      read('clients/vscode/src/core-client/protocol.ts') +
      read('clients/vscode/src/core-client/events.ts');
    for (const [rust, wire] of added) {
      expect(rustProtocol, `rust field "${rust}"`).toContain(rust);
      expect(tsClient, `TS wire name "${wire}"`).toContain(wire);
    }
    // The new payload structs exist in Rust with those exact names.
    for (const struct of [
      'pub struct TaskListParams',
      'pub struct ConversationListParams',
      'pub struct ConversationHistoryParams',
      'pub struct MessageRecord',
      'pub struct ConversationHistoryResult',
    ]) {
      expect(rustProtocol).toContain(struct);
    }
    // `conversation.history` returns an OBJECT, not a bare array.
    expect(serviceLib).toContain('fn conversation_history');
    expect(rustProtocol).toMatch(/pub struct ConversationHistoryResult \{\n\s+pub messages/);
  });

  it('mirrors the bounded-read constants from sandpane-service', () => {
    expect(evalConst(serviceConst('DEFAULT_LIST_LIMIT'))).toBe(DEFAULT_LIST_LIMIT);
    expect(evalConst(serviceConst('MAX_LIST_LIMIT'))).toBe(MAX_LIST_LIMIT);
    expect(evalConst(serviceConst('MAX_HISTORY_BYTES'))).toBe(MAX_HISTORY_BYTES);
    expect(evalConst(serviceConst('MAX_SUBSCRIBE_CURSORS'))).toBe(MAX_SUBSCRIBE_CURSORS);
    expect(evalConst(serviceConst('MAX_CURSOR_KEY_LEN'))).toBe(MAX_CURSOR_KEY_LEN);
    expect(evalConst(serviceConst('MAX_SCOPING_ID_LEN'))).toBe(MAX_SCOPING_ID_LEN);
    // The history ceiling is under the frame cap by Core's own compile-time
    // assertion; the client's copy must keep the same relationship.
    expect(MAX_HISTORY_BYTES).toBeLessThan(MAX_FRAME_BYTES);
    expect(serviceLib).toContain('const _: () = assert!(MAX_HISTORY_BYTES < MAX_FRAME_BYTES);');
  });

  it('mirrors the per-task cursor rules and the oversized-replay refusal', () => {
    // taskId present → scalar wins, map ignored.
    expect(serviceLib).toMatch(/Some\(task_id\) => vec!\[\(task_id\.clone\(\), p\.after_sequence\)\]/);
    // no taskId → own cursor per task, absent from the map ⇒ 0, negative ⇒ 0.
    expect(serviceLib).toContain('map.get(&tid).copied().unwrap_or(0).max(0)');
    // no map at all → the legacy shared scalar.
    expect(serviceLib).toContain('None => p.after_sequence,');
    // Core refuses an undeliverable replay with a structured VALIDATION_FAILED.
    expect(serviceLib).toContain('ErrorCode::ValidationFailed');
    expect(serviceLib).toMatch(/MAX_SUBSCRIBE_BYTES/);
    // The client maps that refusal to a recoverable, non-retrying state.
    const catchup = read('clients/vscode/src/core-client/catchup.ts');
    expect(catchup).toContain('isOversizedReplayRefusal');
    expect(catchup).toContain('clearReplayRefusal');
    expect(catchup).toContain('afterSequences');
    // …and never sends a map alongside taskId, where Core would discard it.
    const commands = read('clients/vscode/src/core-client/commands.ts');
    expect(commands).toContain('Core ignores a map alongside taskId');
  });

  it('uses the snake_case task statuses Rust serializes', () => {
    for (const status of TASK_STATUSES) {
      expect(isTaskStatus(status)).toBe(true);
      // Rust enum variant names map 1:1 (Created → created, AwaitingReview → awaiting_review).
      const camel = status.replace(/_(\w)/g, (_all, letter: string) => letter.toUpperCase());
      const variant = camel.charAt(0).toUpperCase() + camel.slice(1);
      expect(rustProtocol).toMatch(new RegExp(`    ${variant},|    ${variant} \\{`));
    }
    expect(rustProtocol).toContain('rename_all = "snake_case"');
    expect(statusFromEvent('status.changed', { to: 'awaiting_review' })).toBe('awaiting_review');
    expect(statusFromEvent('status.changed', { to: 'awaitingReview' })).toBeUndefined();
    expect(statusFromEvent('task.created', { to: 'queued' })).toBeUndefined();
  });

  it('uses the SCREAMING_SNAKE error codes Rust serializes', () => {
    for (const code of ERROR_CODES) {
      expect(rustProtocol).toContain(`"${code}"`);
    }
    const responseSchema = JSON.parse(read('schemas/rpc-response.schema.json')) as {
      properties: { err: { properties: { code: { enum: string[] } } } };
    };
    expect(responseSchema.properties.err.properties.code.enum.sort()).toEqual(
      [...ERROR_CODES].sort(),
    );
  });

  it('keeps the agent event tags exactly as the schema and Rust define them', () => {
    const eventSchema = JSON.parse(read('schemas/agent-event.schema.json')) as {
      oneOf: { properties: { type: { const: string } } }[];
    };
    const schemaTypes = eventSchema.oneOf.map((branch) => branch.properties.type.const).sort();
    // Scoped to the AgentEvent enum, so the Method renames don't leak in here.
    const rustTypes = [...enumBlock('AgentEvent').matchAll(/rename = "([a-z.]+)"/g)]
      .map((m) => m[1])
      .sort();
    expect(rustTypes.length).toBe(8);
    expect(schemaTypes).toEqual(rustTypes);
    expect(normalizeAgentEvent({ type: 'message.delta', text: 'x' })).toEqual({
      type: 'message.delta',
      text: 'x',
    });
    expect(normalizeAgentEvent({ type: 'unsupported.event', providerType: 'codex.weird' })).toEqual({
      type: 'unsupported.event',
      providerType: 'codex.weird',
    });
  });

  it('derives the workspace modes from the Rust enum, not from a quote search', () => {
    const block = enumBlock('WorkspaceMode');
    expect(block).toContain('rename_all = "snake_case"');
    expect(enumVariants(block).map(toSnakeCase)).toEqual([...WORKSPACE_MODES]);
    const specSchema = JSON.parse(read('schemas/sandbox-create-spec.schema.json')) as {
      properties: { workspaceMode: { enum: string[] } };
    };
    expect(specSchema.properties.workspaceMode.enum).toEqual([...WORKSPACE_MODES]);
  });

  it('derives the task statuses from the Rust enum', () => {
    const block = enumBlock('TaskStatus');
    expect(block).toContain('rename_all = "snake_case"');
    expect(enumVariants(block).map(toSnakeCase)).toEqual([...TASK_STATUSES]);
  });

  it('spells payload fields in camelCase on both sides', () => {
    const taskEventSchema = JSON.parse(read('schemas/task-event.schema.json')) as {
      required: string[];
    };
    expect(taskEventSchema.required).toEqual(['taskId', 'sequence', 'kind', 'payload', 'timestamp']);
    const capsSchema = JSON.parse(read('schemas/core-capabilities.schema.json')) as {
      required: string[];
    };
    expect(capsSchema.required).toEqual([
      'protocolVersion',
      'coreVersion',
      'instanceId',
      'agents',
      'platform',
    ]);
    // Rust fields are snake_case + `rename_all = "camelCase"`; the wire (and our
    // TS interfaces) are camelCase. Check both halves of that mapping.
    expect(rustProtocol).toContain('rename_all = "camelCase"');
    // Rust snake_case field → wire camelCase field. Two halves of the mapping
    // are pinned by the schemas, the rest by this client's own interfaces, so a
    // rename in Rust breaks the build instead of desyncing a shipped client.
    const schemaPinned: [string, string][] = [
      ['protocolVersion', 'protocol_version'],
      ['coreVersion', 'core_version'],
      ['instanceId', 'instance_id'],
      ['supportsStreaming', 'supports_streaming'],
      ['supportsCancel', 'supports_cancel'],
      ['supportsResume', 'supports_resume'],
      ['daemonRunning', 'daemon_running'],
      ['binaryPath', 'binary_path'],
      ['baseCommit', 'base_commit'],
      ['hostDirty', 'host_dirty'],
      ['taskId', 'task_id'],
    ];
    const tsPinned: [string, string][] = [
      ['afterSequence', 'pub after_sequence:'],
      ['expectedBase', 'pub expected_base:'],
      ['abortReason', 'pub abort_reason:'],
      ['conflictedFiles', 'pub conflicted_files:'],
      ['conversationId', 'pub conversation_id:'],
      // Inside an enum variant, so serde fields there are not `pub`.
      ['providerType', 'provider_type: String'],
      ['agentId', 'pub agent_id:'],
      ['createdAt', 'pub created_at:'],
      ['workspaceMode', 'pub workspace_mode:'],
      ['repoPath', 'pub repo_path:'],
      ['projectId', 'pub project_id:'],
      ['selectedFiles', 'pub selected_files:'],
      ['taskBranch', 'pub task_branch:'],
      ['sandboxName', 'pub sandbox_name:'],
    ];
    for (const [, rustNeedle] of [...schemaPinned.map(([w, r]) => [w, `pub ${r}:`] as [string, string]), ...tsPinned]) {
      expect(rustProtocol, `rust source "${rustNeedle}"`).toContain(rustNeedle);
    }
    for (const [wire] of schemaPinned) {
      expect(allSchemas, `wire field ${wire}`).toContain(wire);
    }
    const tsClient =
      read('clients/vscode/src/core-client/protocol.ts') + read('clients/vscode/src/core-client/events.ts');
    for (const [wire] of tsPinned) {
      expect(tsClient, `TS field ${wire}`).toContain(wire);
    }
    for (const key of ['supportsStreaming', 'supportsCancel', 'supportsResume', 'verified']) {
      expect(JSON.stringify(capsSchema)).toContain(key);
    }
  });

  it('documents the event kinds Core actually appends (no invented kinds)', () => {
    const appended = [...serviceLib.matchAll(/log\.append\(\s*&?task_id,\s*"([a-z._]+)"/g)].map((m) => m[1]);
    expect([...new Set(appended)].sort()).toEqual([
      'adapter.unavailable',
      'message.user',
      'scheduler.deferred',
      'status.changed',
      'task.created',
    ]);
  });
});
