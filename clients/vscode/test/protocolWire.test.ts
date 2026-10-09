import { describe, expect, it } from 'vitest';
import { isTaskStatus, normalizeAgentEvent, statusFromEvent, TASK_STATUSES, ERROR_CODES } from '../src/core-client/events';
import { WORKSPACE_MODES, CORE_METHODS, MAX_FRAME_BYTES, PROTOCOL_VERSION } from '../src/core-client/protocol';
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

describe('wire names match the Rust protocol crate', () => {
  it('pins the protocol version and the frame ceiling', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(rustProtocol).toContain('pub const PROTOCOL_VERSION: u32 = 1;');
    expect(MAX_FRAME_BYTES).toBe(4 * 1024 * 1024);
    expect(serviceLib).toContain('pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;');
  });

  it('declares exactly the 11 method names Core parses', () => {
    const fromRust = [...rustProtocol.matchAll(/"([a-z]+\.[a-z]+)" =>/g)].map((m) => m[1]);
    expect(fromRust.sort()).toEqual([...CORE_METHODS].sort());
    expect(new Set(fromRust).size).toBe(11);
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
