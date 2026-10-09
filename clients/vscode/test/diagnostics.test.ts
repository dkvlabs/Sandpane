import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  type ErrorCode,
} from '../src/core-client/events';
import {
  CoreRpcError,
  CoreTransportError,
  FrameTooLargeError,
  UnknownMethodError,
} from '../src/core-client/connection';
import { CoreValidationError } from '../src/core-client/commands';
import {
  explainClientFailure,
  explainCoreErrorCode,
  explainFailure,
  formatGuidance,
  toFailure,
  type ClientFailureReason,
} from '../src/vscode/diagnostics';

describe('error code → human guidance', () => {
  it('maps every structured code with an explanation and no invented success', () => {
    for (const code of ERROR_CODES) {
      const guidance = explainCoreErrorCode(code);
      expect(guidance.headline.length).toBeGreaterThan(0);
      expect(guidance.explanation.length).toBeGreaterThan(30);
      expect(guidance.headline).not.toMatch(/success|completed/i);
    }
  });

  it('NOT_INSTALLED gives install instructions, not a shrug', () => {
    const g = explainCoreErrorCode('NOT_INSTALLED');
    expect(g.headline).toMatch(/not installed/i);
    expect(g.explanation).toMatch(/sbx/i);
    expect(g.actions.some((a) => a.url?.includes('docs.docker.com'))).toBe(true);
    expect(g.actions.some((a) => a.command === 'sandpane.refreshSandboxes')).toBe(true);
    // Sandpane never bundles or downloads SBX itself (specs/06 §1/§2): the only
    // offered actions are documentation, an override pointer and a refresh.
    expect(g.actions.map((a) => a.command ?? a.url ?? a.label)).toEqual([
      'https://docs.docker.com/ai/sandboxes/',
      'sandpane.openCoreLogs',
      'sandpane.refreshSandboxes',
    ]);
  });

  it('DAEMON_DOWN tells the user to start the daemon', () => {
    const g = explainCoreErrorCode('DAEMON_DOWN');
    expect(g.headline).toMatch(/daemon/i);
    expect(g.actions.length).toBeGreaterThan(0);
  });

  it('UNSUPPORTED_SBX_VERSION points at the tested matrix', () => {
    expect(explainCoreErrorCode('UNSUPPORTED_SBX_VERSION').explanation).toMatch(/compatibility/i);
  });

  it('PROVIDER_AUTH_REQUIRED never offers to scrape credentials', () => {
    const g = explainCoreErrorCode('PROVIDER_AUTH_REQUIRED');
    expect(g.explanation).toMatch(/does not scrape/i);
    expect(JSON.stringify(g)).not.toMatch(/copy.*(key|token)|read.*(\.env|secrets)/i);
  });

  it('TASK_INTERRUPTED explains reconciliation, not auto-resume', () => {
    const g = explainCoreErrorCode('TASK_INTERRUPTED');
    expect(g.explanation).toMatch(/never resumes|reconcil/i);
  });

  it.each([
    'not_connected',
    'timeout',
    'closed',
    'frame_too_large',
    'invalid_frame',
    'unknown_method',
    'validation',
    'unsupported_platform',
    'remote_host',
    'adapter_unverified',
    'service_policy',
  ] as ClientFailureReason[])('maps the client failure %s', (reason) => {
    const g = explainClientFailure(reason);
    expect(g.headline.length).toBeGreaterThan(0);
    expect(g.explanation.length).toBeGreaterThan(20);
  });

  it('the unverified-adapter copy states the VS2/P0 gate instead of a fake chat', () => {
    const g = explainClientFailure('adapter_unverified');
    expect(g.explanation).toMatch(/P0|feasibility/i);
    expect(g.honestUncertainty).toMatch(/VS2/);
  });

  it('classifies the real error classes from the client stack', () => {
    expect(toFailure(new CoreRpcError({ code: 'CONFLICT', message: 'bad state' }, 'r1'))).toMatchObject({
      source: 'core',
      code: 'CONFLICT',
    });
    expect(toFailure(new CoreTransportError('timeout', 'slow'))).toMatchObject({
      source: 'client',
      reason: 'timeout',
    });
    expect(toFailure(new FrameTooLargeError(5_000, 4_000))).toMatchObject({ reason: 'frame_too_large' });
    expect(toFailure(new UnknownMethodError('shell.exec'))).toMatchObject({ reason: 'unknown_method' });
    expect(toFailure(new CoreValidationError('name', 'empty'))).toMatchObject({ reason: 'validation' });
    expect(toFailure('just a string')).toMatchObject({ source: 'unknown', message: 'just a string' });
    expect(toFailure(undefined)).toMatchObject({ source: 'unknown' });
  });

  it('routes an unclassified error to an honest fallback', () => {
    const g = explainFailure({ message: 'weird' });
    expect(g.headline).toBe('Unexpected client error');
    expect(g.honestUncertainty).toMatch(/not interpreted/);
  });

  it('preserves the verbatim Core message in the rendered text', () => {
    const err = new CoreRpcError(
      { code: 'VALIDATION_FAILED', message: 'invalid params: path is not absolute: ./repo' },
      'r9',
    );
    const text = formatGuidance(explainFailure(err), err.message);
    expect(text).toContain('invalid params: path is not absolute: ./repo');
    expect(text).toContain('Input was rejected by validation');
  });

  /**
   * `task.subscribe` now answers an undeliverable replay with VALIDATION_FAILED
   * instead of emitting an oversized frame. That must read as recoverable, and
   * the rendered text keeps Core's own guidance verbatim alongside it.
   */
  it('treats the oversized-replay refusal as recoverable, not fatal', () => {
    const refusal = new CoreRpcError(
      {
        code: 'VALIDATION_FAILED',
        message:
          'replay of 2 task(s) passed the 4161536-byte ceiling this frame shape can carry; ' +
          'narrow the request (single taskId, a higher afterSequence, or per-task ' +
          'afterSequences) — task.subscribe has no truncation envelope yet',
      },
      'r11',
    );
    const guidance = explainFailure(refusal);
    expect(guidance.headline).toBe('Input was rejected by validation');
    expect(guidance.honestUncertainty).toMatch(/recoverable/);
    expect(guidance.honestUncertainty).toMatch(/afterSequences/);
    expect(guidance.honestUncertainty).toMatch(/stops retrying/);
    const text = formatGuidance(guidance, refusal.message);
    expect(text).toContain('4161536-byte ceiling');
  });

  it('covers the full wire enum so a new Rust code cannot slip through silently', () => {
    const codes: ErrorCode[] = [
      'NOT_INSTALLED',
      'DAEMON_DOWN',
      'UNSUPPORTED_SBX_VERSION',
      'PROVIDER_AUTH_REQUIRED',
      'CONFLICT',
      'TASK_INTERRUPTED',
      'PERMISSION_DENIED',
      'VALIDATION_FAILED',
      'NOT_FOUND',
      'INTERNAL',
    ];
    expect([...ERROR_CODES].sort()).toEqual([...codes].sort());
  });
});
