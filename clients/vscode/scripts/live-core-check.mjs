#!/usr/bin/env node
/**
 * Live integration check — NOT part of the shipped extension.
 *
 * It runs the compiled TypeScript client (`out/core-client/*.js`) against a REAL
 * `sandpane-service` process over its Unix domain socket, inside a throwaway
 * temp directory. Nothing is mocked: frames go through node:net and the Rust
 * server answers them.
 *
 * The extension itself never starts Core (ADR 1 — service ownership policy is
 * undecided), so this script spawns the already-built binary for verification
 * only. It builds nothing and writes nothing outside its temp dir.
 *
 * Usage: npm run compile && node scripts/live-core-check.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..');
const repoRoot = resolve(clientRoot, '..', '..');
const CORE_BINARY = join(repoRoot, 'core', 'target', 'debug', 'sandpane-service');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

if (!existsSync(CORE_BINARY)) {
  console.error(
    `sandpane-service binary not found at ${CORE_BINARY}\n` +
      'This harness does not build Core. Build it first (cd core && cargo build -p sandpane-service).',
  );
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'sandpane-vscode-live-'));
const socket = join(work, 'sandpane.sock');
const db = join(work, 'sandpane.sqlite3');
const repoPath = join(work, 'repo');
// Core's project.create accepts only a git repository's TOP-LEVEL folder and
// stores its canonical path (symlinks resolved: /var → /private/var on macOS).
// Argument vector, no shell.
execFileSync('git', ['init', '-q', repoPath]);
mkdirSync(join(repoPath, 'packages', 'sub'), { recursive: true });
const canonicalRepoPath = realpathSync(repoPath);

const child = spawn(CORE_BINARY, [], {
  env: { ...process.env, SANDPANE_SOCKET: socket, SANDPANE_DB: db },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,
});
let coreErr = '';
child.stderr.on('data', (chunk) => {
  coreErr += chunk.toString();
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSocket(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const ok = await new Promise((resolveConnect) => {
        const probe = net.connect(path);
        probe.once('connect', () => {
          probe.destroy();
          resolveConnect(true);
        });
        probe.once('error', () => resolveConnect(false));
      });
      if (ok) return true;
    }
    await sleep(100);
  }
  return false;
}

async function main() {
  if (!(await waitForSocket(socket))) {
    check('core service starts on the temp socket', false, coreErr.slice(0, 400));
    throw new Error('core did not come up');
  }
  check('core service starts on the temp socket', true, socket);

  const { CoreConnection, FrameTooLargeError } = await import(
    pathToFileURL(join(clientRoot, 'out', 'core-client', 'connection.js')).href
  );
  const { MAX_FRAME_BYTES, CORE_METHODS, coreAdvertisesMethod, KNOWN_FEATURES, coreAdvertisesFeature } = await import(
    pathToFileURL(join(clientRoot, 'out', 'core-client', 'protocol.js')).href
  );
  const { createSocketTransport } = await import(
    pathToFileURL(join(clientRoot, 'out', 'core-client', 'transport.js')).href
  );
  const { CoreCommands } = await import(
    pathToFileURL(join(clientRoot, 'out', 'core-client', 'commands.js')).href
  );
  const { isOversizedReplayRefusal } = await import(
    pathToFileURL(join(clientRoot, 'out', 'core-client', 'catchup.js')).href
  );
  const { explainCoreErrorCode } = await import(
    pathToFileURL(join(clientRoot, 'out', 'vscode', 'diagnostics.js')).href
  );

  const conn = new CoreConnection({
    transportFactory: () => createSocketTransport({ path: socket, connectTimeoutMs: 3_000 }),
    requestTimeoutMs: 5_000,
  });
  await conn.connect();
  check('client connects and reports online', conn.connectionState === 'online', conn.connectionState);

  const commands = new CoreCommands(conn);

  // ---- system.probe -----------------------------------------------------
  const caps = await commands.systemProbe();
  check('system.probe protocol version is 1', caps.protocolVersion === 1, JSON.stringify(caps.protocolVersion));
  check('system.probe returns instanceId + coreVersion', Boolean(caps.instanceId && caps.coreVersion), `${caps.instanceId} / ${caps.coreVersion}`);
  // Host-dependent: report what Core probed, and require it to be coherent.
  const sbxInstalled = caps.sbx?.installed === true;
  check(
    `system.probe reports sbx presence coherently (this host: ${sbxInstalled ? 'installed' : 'not installed'})`,
    typeof caps.sbx?.installed === 'boolean' && (!sbxInstalled || typeof caps.sbx?.binaryPath === 'string'),
    JSON.stringify(caps.sbx),
  );
  const codex = caps.agents.find((a) => a.id === 'codex');
  check(
    'codex adapter is honestly unverified (P0 gate not passed)',
    codex !== undefined && codex.verified === false && codex.supportsStreaming === false,
    JSON.stringify(codex),
  );

  // ---- method advertisement (the discovery revision) --------------------
  check(
    'system.probe advertises exactly the 34 methods the client allowlists',
    Array.isArray(caps.methods) && caps.methods.length === 34 && caps.methods.join(',') === CORE_METHODS.join(','),
    (caps.methods ?? []).join(','),
  );
  const schemaMethods = JSON.parse(
    readFileSync(join(repoRoot, 'schemas', 'rpc-request.schema.json'), 'utf8'),
  ).properties.method.enum;
  check(
    'Core\'s advertised list equals schemas/rpc-request.schema.json (no drift)',
    JSON.stringify(caps.methods) === JSON.stringify(schemaMethods),
    `core=${(caps.methods ?? []).length} schema=${schemaMethods.length}`,
  );
  check(
    'the client feature-detects the additive methods from the probe, not a version',
    coreAdvertisesMethod(caps, 'task.list') &&
      coreAdvertisesMethod(caps, 'conversation.list') &&
      coreAdvertisesMethod(caps, 'conversation.history') &&
      coreAdvertisesMethod({ methods: ['system.probe'] }, 'task.list') === false,
    `task.list=${coreAdvertisesMethod(caps, 'task.list')}`,
  );
  // A1: advertisement only. This harness never CALLS sandbox.stop/remove —
  // against a host with sbx installed that would drive the real CLI.
  check(
    'A1: Core advertises sandbox.stop + sandbox.remove and no sandbox.start (sbx v0.47 has none)',
    coreAdvertisesMethod(caps, 'sandbox.stop') &&
      coreAdvertisesMethod(caps, 'sandbox.remove') &&
      !(caps.methods ?? []).includes('sandbox.start'),
    (caps.methods ?? []).filter((m) => m.startsWith('sandbox.')).join(','),
  );
  // A3a: advertisement only here; this harness does not exercise the project
  // lifecycle calls (they would need their own temp-DB scenario).
  check(
    'A3a: Core advertises the six project lifecycle methods',
    ['project.update', 'project.archive', 'project.unarchive', 'project.delete', 'project.add_repository', 'project.remove_repository']
      .every((m) => coreAdvertisesMethod(caps, m)),
    (caps.methods ?? []).filter((m) => m.startsWith('project.')).join(','),
  );
  // A3b: advertisement only; this harness does not exercise the conversation
  // lifecycle calls (they would need their own temp-DB scenario).
  check(
    'A3b: Core advertises the five conversation lifecycle methods, right after conversation.history',
    ['conversation.rename', 'conversation.archive', 'conversation.unarchive', 'conversation.delete', 'conversation.export']
      .every((m) => coreAdvertisesMethod(caps, m)) &&
      (caps.methods ?? []).indexOf('conversation.rename') === (caps.methods ?? []).indexOf('conversation.history') + 1,
    (caps.methods ?? []).filter((m) => m.startsWith('conversation.')).join(','),
  );
  // A5: git.diff is advertised right after git.review (exercised below on a
  // wire-created task, which has no Git context until A4b).
  check(
    'A5: Core advertises git.diff, right after git.review',
    coreAdvertisesMethod(caps, 'git.diff') &&
      (caps.methods ?? []).indexOf('git.diff') === (caps.methods ?? []).indexOf('git.review') + 1,
    (caps.methods ?? []).filter((m) => m.startsWith('git.')).join(','),
  );
  // A2: advertisement only. This harness never sends a keyed sandbox.create
  // (it would drive the real sbx); keyed sends are not exercised here either.
  check(
    'A2/A3b/A4/A6/A7: Core advertises every feature this client knows (idempotency-keys, sandbox-create-agent, conversation-sandbox-id, conversation-send-mode, git-apply, verification)',
    Array.isArray(caps.features) &&
      KNOWN_FEATURES.length === 6 &&
      KNOWN_FEATURES.includes('verification') &&
      KNOWN_FEATURES.every((f) => caps.features.includes(f)) &&
      KNOWN_FEATURES.every((f) => coreAdvertisesFeature(caps, f)),
    JSON.stringify(caps.features ?? null),
  );

  // ---- two clients, one core (specs/03 §6.3) ---------------------------
  const second = new CoreConnection({
    transportFactory: () => createSocketTransport({ path: socket, connectTimeoutMs: 3_000 }),
  });
  await second.connect();
  const caps2 = await new CoreCommands(second).systemProbe();
  check(
    'a second window attaches to the same core instance',
    caps2.instanceId === caps.instanceId && caps2.coreVersion === caps.coreVersion,
    `${caps2.instanceId}`,
  );
  second.dispose();

  // ---- projects ---------------------------------------------------------
  const project = await commands.projectCreate({ name: 'Atlas Demo', repositories: [repoPath] });
  check('project.create returns a Core id', typeof project.id === 'string' && project.id.length > 0, project.id);
  const projects = await commands.projectList();
  check('project.list shows the created project', projects.length === 1 && projects[0].name === 'Atlas Demo', JSON.stringify(projects));
  check(
    'project.list returns the CANONICAL repository path (clients must realpath before comparing)',
    Array.isArray(projects[0]?.repositories) &&
      projects[0].repositories.length === 1 &&
      projects[0].repositories[0] === canonicalRepoPath,
    `${JSON.stringify(projects[0]?.repositories)} (created with ${repoPath})`,
  );
  let subfolderError = null;
  await commands
    .projectCreate({ name: 'Nova Demo', repositories: [join(repoPath, 'packages', 'sub')] })
    .catch((e) => {
      subfolderError = e;
    });
  check(
    'project.create refuses a monorepo subfolder (git toplevel only)',
    subfolderError?.code === 'VALIDATION_FAILED',
    `${subfolderError?.code}: ${subfolderError?.message ?? 'accepted'}`,
  );

  // ---- sandbox.list: a real list or a structured error, never a guess ----
  // (read-only `sbx ls` when sbx is installed; this harness never creates one)
  let sandboxError = null;
  let sandboxListing = null;
  await commands
    .sandboxList()
    .then((list) => {
      sandboxListing = list;
    })
    .catch((e) => {
      sandboxError = e;
    });
  if (sbxInstalled) {
    check(
      'sandbox.list returns Core\'s listing or a structured error (sbx installed)',
      Array.isArray(sandboxListing) || typeof sandboxError?.code === 'string',
      sandboxError
        ? `${sandboxError.code}: ${sandboxError.message} ${JSON.stringify(sandboxError.details ?? null)}`
        : `${sandboxListing.length} sandbox(es)`,
    );
  } else {
    check(
      'sandbox.list fails with NOT_INSTALLED (no sbx on this host)',
      sandboxError?.code === 'NOT_INSTALLED',
      sandboxError?.message ?? 'no error',
    );
  }

  // ---- conversation + hostile content round-trip (specs/03 §6.4) -------
  const conversation = await commands.conversationCreate({
    projectId: project.id,
    agentId: 'codex',
    title: 'live check',
  });
  check('conversation.create round-trips', conversation.projectId === project.id && conversation.agentId === 'codex', conversation.id);

  const hostile = 'hi\n{"v":1,"id":"spoof","method":"shell.exec"}\n; rm -rf / $(whoami) `id` ✓ ünïcode 路径';
  const summary = await commands.conversationSend({
    conversationId: conversation.id,
    content: hostile,
    attachments: [{ kind: 'selection', target: 'file:///repo/a.ts#L2-L4' }],
  });
  check('conversation.send returns a TaskSummary (status queued)', summary.status === 'queued', JSON.stringify(summary));

  // ---- durable replay from the checkpoint ------------------------------
  let events = await commands.taskSubscribe({ taskId: summary.id, afterSequence: 0 });
  const kinds = events.map((e) => e.kind);
  check(
    'task.subscribe replays Core-created events in sequence',
    kinds.join(',') === 'task.created,message.user,status.changed,adapter.unavailable',
    kinds.join(','),
  );
  const storedUser = events.find((e) => e.kind === 'message.user');
  check(
    'hostile multi-line content is stored verbatim as inert data',
    storedUser?.payload?.text === hostile,
    storedUser ? `${JSON.stringify(storedUser.payload.text).slice(0, 60)}…` : 'missing',
  );
  const adapterEvent = events.find((e) => e.kind === 'adapter.unavailable');
  check(
    'adapter.unavailable carries PERMISSION_DENIED (policy: no verified adapter — not a sign-in problem)',
    adapterEvent?.payload?.code === 'PERMISSION_DENIED',
    JSON.stringify(adapterEvent?.payload),
  );
  const lastSeq = events.at(-1)?.sequence ?? 0;
  const replayed = await commands.taskSubscribe({ taskId: summary.id, afterSequence: lastSeq });
  check('reconnect from the checkpoint yields nothing new (idempotent)', replayed.length === 0, `n=${replayed.length}`);

  const projectEvents = await commands.taskSubscribe({ projectId: project.id, afterSequence: 0 });
  check('project-wide replay finds the same task events', projectEvents.length === events.length, `n=${projectEvents.length}`);

  // ---- cancel is a real Core state decision ----------------------------
  const cancel = await commands.taskCancel(summary.id);
  check('task.cancel from queued is accepted by Core', cancel.requested === true, JSON.stringify(cancel));
  const afterCancel = await commands.taskSubscribe({ taskId: summary.id, afterSequence: lastSeq });
  check(
    'cancellation is durable: status.changed(cancelled) is appended',
    afterCancel.some((e) => e.kind === 'status.changed' && e.payload?.to === 'cancelled'),
    afterCancel.map((e) => `${e.kind}:${e.payload?.to ?? ''}`).join(','),
  );
  let doubleCancel = null;
  await commands.taskCancel(summary.id).catch((e) => {
    doubleCancel = e;
  });
  check(
    'cancelling a cancelled task is refused with CONFLICT (Core owns transitions)',
    doubleCancel?.code === 'CONFLICT',
    doubleCancel?.message ?? 'no error',
  );

  // ---- git paths report the real gap -----------------------------------
  let reviewError = null;
  await commands.gitReview(summary.id).catch((e) => {
    reviewError = e;
  });
  check(
    'git.review refuses instead of inventing a diff (no Git context)',
    reviewError?.code === 'VALIDATION_FAILED' || reviewError?.code === 'NOT_FOUND',
    `${reviewError?.code}: ${reviewError?.message}`,
  );

  // A5: a wire-created task has no Git context, so git.diff refuses with
  // Core's exact message (no patch is ever invented).
  let diffError = null;
  await commands.gitDiff({ taskId: summary.id, path: 'README.md', status: 'modified' }).catch((e) => {
    diffError = e;
  });
  check(
    'A5: git.diff on a wire-created task answers "task has no Git context"',
    diffError?.code === 'VALIDATION_FAILED' &&
      String(diffError?.message ?? '').endsWith('task has no Git context (repo binding + base_commit)'),
    `${diffError?.code}: ${diffError?.message}`,
  );

  // A6: git.apply needs reviewId + entries copied from a git.review answer.
  // A wire-created task has no Git context, so Core refuses BEFORE any review
  // lookup with its exact "no Git context …; nothing was written" abort. The
  // made-up review id and entry never reach a repository.
  let applyError = null;
  let applyResult = null;
  await commands
    .gitApply({
      taskId: summary.id,
      expectedBase: 'b71995fc1e0f4a3c8f0d7b1a2e3c4d5e6f708192',
      reviewId: 'live-check-unreviewed',
      entries: [{ path: 'README.md', status: 'deleted' }],
    })
    .then((r) => {
      applyResult = r;
    })
    .catch((e) => {
      applyError = e;
    });
  const abortReason = applyResult?.abortReason ?? applyError?.message ?? '';
  check(
    'A6: git.apply on a wire-created task aborts with "task has no Git context …; nothing was written"',
    applyResult?.applied === false &&
      abortReason === 'task has no Git context (repo binding + base_commit); nothing was written' &&
      applyResult?.partial !== true,
    JSON.stringify(applyResult ?? { code: applyError?.code, message: abortReason.slice(0, 160) }),
  );

  // A7: read-only list of a fresh project, and an approve Core must refuse
  // as secret-shaped (no sbx is involved in either; verification.run is
  // NEVER called here — it would drive the real `sbx exec`).
  check(
    'A7: Core advertises the six verification methods after git.apply, and the feature "verification"',
    ['verification.list', 'verification.approve', 'verification.revoke', 'verification.run', 'verification.result', 'project.context']
      .every((m, i) => (caps.methods ?? []).indexOf(m) === (caps.methods ?? []).indexOf('git.apply') + 1 + i) &&
      coreAdvertisesFeature(caps, 'verification'),
    (caps.methods ?? []).slice((caps.methods ?? []).indexOf('git.apply')).join(','),
  );
  let verificationListResult = null;
  let verificationListError = null;
  await commands
    .verificationList(project.id)
    .then((r) => {
      verificationListResult = r;
    })
    .catch((e) => {
      verificationListError = e;
    });
  check(
    'A7: verification.list of a fresh project answers {commands: []}',
    verificationListResult !== null &&
      Array.isArray(verificationListResult.commands) &&
      verificationListResult.commands.length === 0 &&
      Object.keys(verificationListResult).join(',') === 'commands',
    JSON.stringify(verificationListResult ?? { code: verificationListError?.code, message: verificationListError?.message }),
  );
  // Built at runtime so no token-shaped literal sits in the source. Its value
  // is never printed: only the code and Core's message (which names the kind).
  const secretLike = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  let approveResult = null;
  let approveError = null;
  await commands
    .verificationApprove({ projectId: project.id, label: 'live check', argv: ['gh', secretLike] })
    .then((r) => {
      approveResult = r;
    })
    .catch((e) => {
      approveError = e;
    });
  const approveHint = approveError?.details?.hint;
  check(
    'A7: verification.approve with a secret-like argument answers VALIDATION_FAILED (nothing approved)',
    approveResult === null && approveError?.code === 'VALIDATION_FAILED',
    approveError
      ? `${approveError.code}: ${String(approveError.message).replaceAll(secretLike, '<redacted>')}` +
          (typeof approveHint === 'string' ? ` · hint: ${approveHint}` : ' · no details.hint')
      : 'Core APPROVED it',
  );
  const afterApprove = await commands.verificationList(project.id).catch(() => null);
  check(
    'A7: the refused approve left the list empty',
    Array.isArray(afterApprove?.commands) && afterApprove.commands.length === 0,
    JSON.stringify(afterApprove === null ? null : { commands: afterApprove.commands.length }),
  );

  // ---- unknown method: the client blocks it, and so does Core ----------
  let clientBlocked = null;
  try {
    await conn.request('shell.exec', { cmd: 'id' });
  } catch (e) {
    clientBlocked = e;
  }
  check(
    'the typed client cannot even address a non-allowlisted method',
    clientBlocked?.name === 'UnknownMethodError',
    `${clientBlocked?.name}: ${clientBlocked?.message?.slice(0, 80)}`,
  );

  const serverUnknownMethod = await new Promise((resolveCheck) => {
    const sock = net.connect(socket);
    let data = '';
    sock.on('connect', () => {
      sock.write('{"v":1,"id":"u1","method":"shell.exec","params":{"cmd":"id"}}\n');
    });
    sock.on('data', (chunk) => {
      data += chunk.toString();
    });
    const finish = () => {
      sock.destroy();
      resolveCheck(data.trim());
    };
    sock.once('error', finish);
    setTimeout(finish, 1_500);
  });
  check(
    'Core rejects an off-allowlist method with VALIDATION_FAILED (no free-form exec)',
    /VALIDATION_FAILED/.test(serverUnknownMethod),
    serverUnknownMethod.slice(0, 160) || '(no answer)',
  );

  // ---- oversized frames: client-side and server-side bounds ------------
  // `conversation.send` is capped at 64 KiB by the wrapper first, so the frame
  // ceiling is exercised straight on the connection (bypassing the text limit).
  let tooBigLocally = null;
  await conn
    .request('task.subscribe', { afterSequence: 0, blob: 'x'.repeat(MAX_FRAME_BYTES) })
    .catch((e) => {
      tooBigLocally = e;
    });
  check(
    'the client refuses an over-limit frame before writing (MAX_FRAME_BYTES)',
    tooBigLocally instanceof FrameTooLargeError,
    tooBigLocally?.name ?? String(tooBigLocally),
  );
  check(
    'MAX_FRAME_BYTES is exported and matches Core 4 MiB ceiling',
    MAX_FRAME_BYTES === 4 * 1024 * 1024,
    `MAX=${MAX_FRAME_BYTES}`,
  );

  const serverBound = await new Promise((resolveCheck) => {
    const sock = net.connect(socket);
    let data = '';
    sock.on('connect', () => {
      sock.write(Buffer.from('{"v":1,"id":"big","ok":"' + 'A'.repeat(MAX_FRAME_BYTES + 100) + '"}\n'));
    });
    sock.on('data', (chunk) => {
      data += chunk.toString();
    });
    const finish = () => {
      sock.destroy();
      resolveCheck(data.trim());
    };
    sock.once('error', finish);
    sock.once('close', finish);
    setTimeout(finish, 4_000);
  });
  check(
    'Core rejects an oversized line with VALIDATION_FAILED "frame too large"',
    /frame too large/.test(serverBound) && /VALIDATION_FAILED/.test(serverBound),
    serverBound.slice(0, 160) || '(connection closed with no answer)',
  );

  // ---- frame reassembly under real socket chunking ---------------------
  // The log now has 5 events (the cancel appended one more). `afterSequence: i`
  // replays the events with sequence > i, so it must return exactly final−i.
  // Twenty-five concurrent requests must each land on their own promise.
  const finalEvents = await commands.taskSubscribe({ taskId: summary.id, afterSequence: 0 });
  const finalCount = finalEvents.length;
  const many = await Promise.all(
    Array.from({ length: 25 }, (_unused, i) => commands.taskSubscribe({ taskId: summary.id, afterSequence: i })),
  );
  check(
    '25 concurrent requests each correlate back to their own id',
    finalCount === 5 && many.every((r, i) => Array.isArray(r) && r.length === Math.max(0, finalCount - i)),
    `final=${finalCount} · ${many.map((r) => r.length).join(',')}`,
  );

  // ===== protocol-v1 discovery revision: new reads, per-task cursors, ceiling ===
  // Everything above is the pre-existing surface. From here the checks exercise
  // the added methods against the real service.

  // ---- conversation.history round-trip with truncation disclosure -------
  const history1 = await commands.conversationHistory({ conversationId: conversation.id });
  check(
    'conversation.history returns an object disclosing truncated + nextSequence',
    Array.isArray(history1.messages) && history1.truncated === false && history1.nextSequence === 1,
    JSON.stringify({ n: history1.messages.length, truncated: history1.truncated, next: history1.nextSequence }),
  );
  check(
    'history returns the stored message verbatim (hostile content stays inert data)',
    history1.messages.length === 1 &&
      history1.messages[0].content === hostile &&
      history1.messages[0].role === 'user' &&
      history1.messages[0].conversationId === conversation.id,
    JSON.stringify(String(history1.messages[0]?.content).slice(0, 40)),
  );

  const conversationB = await commands.conversationCreate({
    projectId: project.id,
    agentId: 'codex',
    title: 'live check two',
  });
  const taskB = await commands.conversationSend({
    conversationId: conversationB.id,
    content: 'queued task in chat two',
    attachments: [],
  });
  const historyEmptyPage = await commands.conversationHistory({
    conversationId: conversation.id,
    afterSequence: history1.nextSequence,
  });
  check(
    'paging past the last message returns none and keeps the cursor (never rewinds)',
    historyEmptyPage.messages.length === 0 &&
      historyEmptyPage.nextSequence === history1.nextSequence &&
      historyEmptyPage.truncated === false,
    JSON.stringify(historyEmptyPage),
  );
  const taskC = await commands.conversationSend({
    conversationId: conversation.id,
    content: 'second message in chat one',
    attachments: [],
  });
  const history2 = await commands.conversationHistory({
    conversationId: conversation.id,
    afterSequence: history1.nextSequence,
  });
  check(
    'a new message advances nextSequence and pages forward without losing rows',
    history2.messages.length === 1 &&
      history2.messages[0].sequence === 2 &&
      history2.nextSequence === 2 &&
      history2.truncated === false,
    JSON.stringify({ n: history2.messages.length, next: history2.nextSequence }),
  );

  // ---- conversation.list --------------------------------------------------
  const convList = await commands.conversationList({ projectId: project.id });
  check(
    'conversation.list enumerates both live conversations of the project',
    convList.length === 2 &&
      [conversation.id, conversationB.id].every((id) => convList.some((c) => c.id === id)) &&
      convList.every((c) => c.projectId === project.id && c.agentId === 'codex'),
    convList.map((c) => c.title).join(','),
  );
  const scopedEmpty = await commands.conversationList({ projectId: 'no-such-project' });
  check(
    'conversation.list scoping an unknown project is an empty list, not an error',
    Array.isArray(scopedEmpty) && scopedEmpty.length === 0,
    `n=${scopedEmpty.length}`,
  );
  let blankScope = null;
  await commands.conversationList({ projectId: '' }).catch((e) => {
    blankScope = e;
  });
  check(
    'a blank projectId is refused client-side before the frame is written',
    blankScope?.name === 'CoreValidationError' && blankScope?.field === 'projectId',
    `${blankScope?.name}: ${String(blankScope?.message).slice(0, 80)}`,
  );

  // ---- task.list: project scoping + a real status filter ------------------
  const projectTasks = await commands.taskList({ projectId: project.id });
  const queuedRows = await commands.taskList({ projectId: project.id, statuses: ['queued'] });
  check(
    'task.list scopes to the project and filters by Core status',
    projectTasks.length === 3 &&
      queuedRows.length === 2 &&
      queuedRows.every((t) => t.status === 'queued') &&
      projectTasks.some((t) => t.id === summary.id && t.status === 'cancelled'),
    JSON.stringify(projectTasks.map((t) => `${t.id.slice(0, 8)}:${t.status}`)),
  );
  const unscoped = await commands.taskList({ statuses: ['cancelled'] });
  check(
    'task.list without a project scope still finds the cancelled task by status',
    unscoped.some((t) => t.id === summary.id && t.status === 'cancelled'),
    JSON.stringify(unscoped.map((t) => `${t.id.slice(0, 8)}:${t.status}`)),
  );
  const boundedRows = await commands.taskList({ projectId: project.id, limit: 1 });
  check(
    'task.list honours a bounded limit (limit=1 returns one row)',
    boundedRows.length === 1,
    `n=${boundedRows.length}`,
  );
  let badStatus = null;
  await commands.taskList({ statuses: ['half_finished'] }).catch((e) => {
    badStatus = e;
  });
  check(
    'a status outside Core\'s closed enum is refused before the request is written',
    badStatus?.name === 'CoreValidationError' && badStatus?.field === 'statuses',
    `${badStatus?.name}: ${String(badStatus?.message).slice(0, 90)}`,
  );

  // ---- the recorded cursor defect, proved fixed against real events --------
  // Make the two logs uneven by cancelling only taskB: 5 events vs taskC's 4.
  await commands.taskCancel(taskB.id);
  const bEvents = await commands.taskSubscribe({ taskId: taskB.id, afterSequence: 0 });
  const cEvents = await commands.taskSubscribe({ taskId: taskC.id, afterSequence: 0 });
  check(
    'the two tasks have UNEVEN per-task sequences (5 vs 4) — the shape a shared cursor breaks on',
    bEvents.length === 5 && cEvents.length === 4,
    `b=${bEvents.length} c=${cEvents.length}`,
  );
  const sharedCursor = bEvents[bEvents.length - 1].sequence;
  const legacy = await commands.taskSubscribe({ projectId: project.id, afterSequence: sharedCursor });
  check(
    'LEGACY SHAPE: one shared scalar skips every unseen event of the behind task',
    legacy.length === 0,
    `afterSequence=${sharedCursor} → ${legacy.length} events (taskC still had 3 and 4 unseen)`,
  );
  const mapped = await commands.taskSubscribe({
    projectId: project.id,
    afterSequence: sharedCursor,
    afterSequences: {
      [summary.id]: finalCount,
      [taskB.id]: sharedCursor,
      [taskC.id]: 2,
    },
  });
  check(
    'afterSequences replays EACH task from its own cursor — unseen events arrive',
    mapped.length === 2 &&
      mapped.every((e) => e.taskId === taskC.id && (e.sequence === 3 || e.sequence === 4)),
    mapped.map((e) => `${e.taskId.slice(0, 8)}:${e.sequence}`).join(','),
  );
  const unmapped = await commands.taskSubscribe({
    projectId: project.id,
    afterSequence: sharedCursor,
    afterSequences: { [summary.id]: finalCount, [taskB.id]: sharedCursor },
  });
  check(
    'a task absent from the map replays IN FULL (cursor 0), exactly as documented',
    unmapped.filter((e) => e.taskId === taskC.id).length === 4,
    `n=${unmapped.filter((e) => e.taskId === taskC.id).length}`,
  );
  let badCursorKey = null;
  await commands
    .taskSubscribe({ projectId: project.id, afterSequence: 0, afterSequences: { '': 1 } })
    .catch((e) => {
      badCursorKey = e;
    });
  check(
    'an empty afterSequences key is refused locally, before any frame is written',
    badCursorKey?.name === 'CoreValidationError',
    `${badCursorKey?.name}: ${String(badCursorKey?.message).slice(0, 80)}`,
  );

  // ---- the oversized-replay refusal: structured, mapped, recoverable ------
  // Core must refuse a replay that cannot fit one frame rather than emit a frame
  // the client would drop. Grow the log past the ceiling with the largest legal
  // prompts (Core caps conversation.send content at 64 KiB).
  const bulk = 'x'.repeat(64 * 1024 - 8);
  let bulkSent = 0;
  for (let i = 0; i < 90; i += 1) {
    await commands.conversationSend({
      conversationId: conversationB.id,
      content: `${i} ${bulk}`,
      attachments: [],
    });
    bulkSent += 1;
  }
  check('bulk fill sent 90 maximum-legal prompts', bulkSent === 90, '≈5.9 MB of durable events');

  let replayRefusal = null;
  await commands.taskSubscribe({ projectId: project.id, afterSequence: 0 }).catch((e) => {
    replayRefusal = e;
  });
  check(
    'an over-ceiling replay is refused with structured VALIDATION_FAILED',
    replayRefusal?.code === 'VALIDATION_FAILED' && /ceiling/.test(String(replayRefusal?.message)),
    `${replayRefusal?.code ?? '(no error)'}: ${String(replayRefusal?.message).slice(0, 140)}`,
  );
  check(
    'the client classifies it as a refusal and maps it to recoverable guidance',
    isOversizedReplayRefusal(replayRefusal) === true &&
      /recoverable/.test(explainCoreErrorCode('VALIDATION_FAILED').honestUncertainty ?? ''),
    `isOversizedReplayRefusal=${isOversizedReplayRefusal(replayRefusal)}`,
  );
  const narrowed = await commands.taskSubscribe({ taskId: summary.id, afterSequence: 0 });
  check(
    'narrowing to one taskId still succeeds — the refusal is recoverable, not fatal',
    Array.isArray(narrowed) && narrowed.length === 5,
    `n=${narrowed.length}`,
  );
  const boundedUnderLoad = await commands.conversationHistory({
    conversationId: conversationB.id,
    limit: 2,
  });
  check(
    'a bounded read discloses truncation instead of overflowing the frame',
    boundedUnderLoad.messages.length === 2 &&
      boundedUnderLoad.truncated === true &&
      boundedUnderLoad.nextSequence === 2,
    JSON.stringify({
      n: boundedUnderLoad.messages.length,
      truncated: boundedUnderLoad.truncated,
      next: boundedUnderLoad.nextSequence,
    }),
  );

  conn.dispose();
  check('dispose detaches the client without touching Core state', true);
  const survivor = new CoreConnection({ transportFactory: () => createSocketTransport({ path: socket }) });
  await survivor.connect();
  const stillThere = await new CoreCommands(survivor).projectList();
  check('state survives a client disconnect (Core is authoritative)', stillThere.length === 1, JSON.stringify(stillThere.map((p) => p.name)));
  survivor.dispose();
}

try {
  await main();
} finally {
  child.kill('SIGTERM');
  await sleep(300);
  if (!child.killed) child.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log('\n────────────────────────────────────────────────────────');
console.log(`${results.length - failed.length}/${results.length} checks passed against the live Core service`);
if (coreErr.trim().length > 0) {
  console.log(`\ncore stderr (verbatim):\n${coreErr.trim().split('\n').slice(0, 6).join('\n')}`);
}
if (failed.length > 0) {
  console.log('\nFAILED:');
  for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
}
process.exit(failed.length === 0 ? 0 : 1);
