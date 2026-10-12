/**
 * A8a (design 2026-10-09 §3.8 item 1): the pure display of `system.probe` →
 * `capabilities.sbx`. Exact strings, absent = no line, non-boolean = absent,
 * and never "ready" / "healthy" wording.
 */

import { describe, expect, it } from 'vitest';
import {
  SBX_CAPTURED_NO,
  SBX_CAPTURED_YES,
  SBX_DAEMON_RUNNING,
  SBX_DAEMON_STOPPED,
  SBX_DAEMON_UNKNOWN,
  SBX_EXEC_ENABLED,
  SBX_EXEC_NOT_ENABLED,
  SBX_NOT_INSTALLED,
  SBX_NOT_REPORTED,
  sbxStatusView,
} from '../src/vscode/sbxStatus';

describe('sbx status display (A8a)', () => {
  it('uses the exact strings from the design', () => {
    expect(SBX_DAEMON_RUNNING).toBe('SBX daemon running (at last check)');
    expect(SBX_DAEMON_STOPPED).toBe('SBX daemon stopped (at last check)');
    expect(SBX_DAEMON_UNKNOWN).toBe('SBX daemon state unknown');
    expect(SBX_NOT_INSTALLED).toBe('Docker SBX not installed');
    expect(SBX_NOT_REPORTED).toBe('SBX status not reported by this Core');
    expect(SBX_EXEC_NOT_ENABLED).toBe('Verification runs are not enabled for this sbx version');
    expect(SBX_EXEC_ENABLED).toBe('Verification runs are enabled for this sbx version');
    expect(SBX_CAPTURED_YES).toBe(
      "Same sbx version number as Sandpane's captured fixtures (macOS; build not compared): yes",
    );
    expect(SBX_CAPTURED_NO).toBe(
      "Same sbx version number as Sandpane's captured fixtures (macOS; build not compared): no",
    );
  });

  it.each([
    [true, 'SBX daemon running (at last check)'],
    [false, 'SBX daemon stopped (at last check)'],
    [null, 'SBX daemon state unknown'],
  ])('daemonRunning %s → %s', (daemonRunning, text) => {
    expect(sbxStatusView({ installed: true, daemonRunning }).daemon).toBe(text);
  });

  it('daemonRunning absent → unknown', () => {
    expect(sbxStatusView({ installed: true }).daemon).toBe(SBX_DAEMON_UNKNOWN);
  });

  it('execVerified true / false / absent', () => {
    expect(sbxStatusView({ installed: true, execVerified: true }).exec).toBe(SBX_EXEC_ENABLED);
    expect(sbxStatusView({ installed: true, execVerified: false }).exec).toBe(SBX_EXEC_NOT_ENABLED);
    expect(sbxStatusView({ installed: true }).exec).toBeNull();
  });

  it('versionCaptured true / false / absent', () => {
    expect(sbxStatusView({ installed: true, versionCaptured: true }).captured).toBe(SBX_CAPTURED_YES);
    expect(sbxStatusView({ installed: true, versionCaptured: false }).captured).toBe(SBX_CAPTURED_NO);
    expect(sbxStatusView({ installed: true }).captured).toBeNull();
  });

  it.each([['true'], [1], [0], [{}], [[]], [null]])('a non-boolean value %j is treated as absent', (bad) => {
    const view = sbxStatusView({ installed: true, daemonRunning: bad, execVerified: bad, versionCaptured: bad });
    expect(view.daemon).toBe(SBX_DAEMON_UNKNOWN);
    expect(view.exec).toBeNull();
    expect(view.captured).toBeNull();
  });

  it.each([[undefined], [null], ['sbx'], [[]]])('no sbx object (%j) → "not reported", no other line', (sbx) => {
    expect(sbxStatusView(sbx)).toEqual({
      installed: null,
      note: SBX_NOT_REPORTED,
      version: null,
      daemon: null,
      exec: null,
      captured: null,
    });
  });

  it('installed: false → "Docker SBX not installed" and no daemon / exec / captured line, whatever else Core sent', () => {
    expect(
      sbxStatusView({ installed: false, version: '0.47.0', daemonRunning: true, execVerified: true, versionCaptured: true }),
    ).toEqual({
      installed: false,
      note: SBX_NOT_INSTALLED,
      version: null,
      daemon: null,
      exec: null,
      captured: null,
    });
  });

  it.each([[{}], [{ installed: 'true' }], [{ installed: 1 }], [{ installed: null, daemonRunning: true }]])(
    'an sbx object without a boolean installed (%j) → "not reported", no daemon line',
    (sbx) => {
      const view = sbxStatusView(sbx);
      expect(view.note).toBe(SBX_NOT_REPORTED);
      expect(view.daemon).toBeNull();
      expect(view.exec).toBeNull();
      expect(view.captured).toBeNull();
    },
  );

  it('installed: true → no note', () => {
    expect(sbxStatusView({ installed: true }).note).toBeNull();
  });

  it('tolerates unknown extra keys and reads the version as plain, capped text', () => {
    const view = sbxStatusView({
      installed: true,
      version: '0.47.0',
      daemonRunning: true,
      execVerified: false,
      versionCaptured: true,
      futureKey: { anything: [1, 2] },
    });
    expect(view).toEqual({
      installed: true,
      note: null,
      version: '0.47.0',
      daemon: SBX_DAEMON_RUNNING,
      exec: SBX_EXEC_NOT_ENABLED,
      captured: SBX_CAPTURED_YES,
    });
    const hostile = sbxStatusView({ installed: true, version: `0.47.0\u202E${'9'.repeat(200)}` });
    expect(hostile.version).not.toContain('\u202E');
    expect(hostile.version).toContain('(truncated)');
    expect(sbxStatusView({ installed: true, version: '' }).version).toBeNull();
    expect(sbxStatusView({ installed: true, version: 47 }).version).toBeNull();
  });

  it('never produces "ready" or "healthy" wording for any combination', () => {
    const values = [true, false, null, undefined];
    expect(JSON.stringify(sbxStatusView({ installed: false }))).not.toMatch(/ready|healthy/i);
    expect(JSON.stringify(sbxStatusView(undefined))).not.toMatch(/ready|healthy/i);
    for (const daemonRunning of values) {
      for (const execVerified of values) {
        for (const versionCaptured of values) {
          const view = sbxStatusView({ installed: true, version: '0.47.0', daemonRunning, execVerified, versionCaptured });
          expect(JSON.stringify(view)).not.toMatch(/ready|healthy/i);
        }
      }
    }
  });
});
