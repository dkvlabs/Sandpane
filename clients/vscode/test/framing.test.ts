import { describe, expect, it } from 'vitest';
import {
  FrameTooLargeError,
  NdjsonFramer,
  decodeLine,
  encodeFrame,
} from '../src/core-client/connection';
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from '../src/core-client/protocol';

const encoder = new TextEncoder();

function collect(framer: NdjsonFramer, text: string) {
  return framer.push(encoder.encode(text));
}

describe('NDJSON framing codec', () => {
  it('round-trips a request frame with exactly one line break', () => {
    const frame = { v: PROTOCOL_VERSION, id: 'a-1', method: 'system.probe' as const, params: {} };
    const bytes = encodeFrame(frame);
    const text = new TextDecoder().decode(bytes);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(2); // payload + empty tail
    const parsed = decodeLine(text.slice(0, -1));
    expect(parsed.ok).toBe(true);
  });

  it('keeps hostile content inert: newlines, braces and shell text stay data', () => {
    const hostile = 'hi\n{"v":1,"id":"spoof","method":"shell.exec"}\n; rm -rf / $(whoami) `id`';
    const bytes = encodeFrame({
      v: PROTOCOL_VERSION,
      id: 'x',
      method: 'conversation.send' as const,
      params: { conversationId: 'c', content: hostile, attachments: [] },
    });
    const text = new TextDecoder().decode(bytes);
    // One physical line only: the body cannot inject a second frame.
    expect(text.indexOf('\n')).toBe(text.length - 1);

    const framer = new NdjsonFramer();
    const events = framer.push(bytes);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('frame');
    const back = JSON.parse(text.trim()) as { params: { content: string } };
    expect(back.params.content).toBe(hostile);
  });

  it('reassembles frames split across socket chunks, including a split multibyte character', () => {
    const bytes = encodeFrame({
      v: PROTOCOL_VERSION,
      id: 'q',
      method: 'task.subscribe' as const,
      params: { taskId: '路径/файл', afterSequence: 0 },
    });
    const framer = new NdjsonFramer();
    const middle = Math.floor(bytes.byteLength / 2);
    // Cut inside the UTF-8 sequence for "路" by splitting at an arbitrary byte.
    const first = framer.push(bytes.subarray(0, middle));
    const second = framer.push(bytes.subarray(middle));
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
    const event = second[0];
    expect(event?.kind).toBe('frame');
    if (event?.kind === 'frame' && event.frame.kind === 'notification') {
      expect(event.frame.notification).toEqual({
        v: 1,
        method: 'task.subscribe',
        params: { taskId: '路径/файл', afterSequence: 0 },
      });
    }
  });

  it('parses several frames delivered in one chunk and tolerates a trailing blank line', () => {
    const framer = new NdjsonFramer();
    const events = collect(
      framer,
      '{"v":1,"id":"1","ok":[]}\n{"v":1,"id":"2","err":{"code":"NOT_FOUND","message":"nope"}}\n\n',
    );
    expect(events.map((e) => e.kind)).toEqual(['frame', 'frame', 'error']);
    const first = events[0];
    if (first?.kind === 'frame' && first.frame.kind === 'response') {
      expect(first.frame.response.id).toBe('1');
    }
    const second = events[1];
    if (second?.kind === 'frame' && second.frame.kind === 'response') {
      expect(second.frame.response.err?.code).toBe('NOT_FOUND');
    }
    expect(events[2]?.kind === 'error' && events[2].error.reason).toBe('invalid_json');
  });

  it('discards a complete oversized line and keeps serving the next frame', () => {
    const framer = new NdjsonFramer(64);
    const big = `{"v":1,"id":"x","ok":"${'A'.repeat(200)}"}\n`;
    const events = collect(framer, big);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind === 'error' && events[0].error.reason).toBe('frame_too_large');
    const next = collect(framer, '{"v":1,"id":"small","ok":{"n":1}}\n');
    expect(next).toHaveLength(1);
    expect(next[0]?.kind).toBe('frame');
  });

  it('never buffers past the ceiling: a newline-less flood is dropped, then it resynchronizes', () => {
    const framer = new NdjsonFramer(64);
    const first = collect(framer, 'A'.repeat(100));
    expect(first).toHaveLength(1);
    expect(first[0]?.kind === 'error' && first[0].error.reason).toBe('frame_too_large');
    // Still discarding: no growth, no duplicate error.
    const more = collect(framer, 'B'.repeat(500));
    expect(more).toHaveLength(0);
    const tail = `${'C'.repeat(10)}}\n{"v":1,"id":"s","ok":1}\n`;
    const resync = collect(framer, tail);
    expect(resync.map((e) => (e.kind === 'error' ? e.error.reason : 'frame'))).toEqual([
      'resynced',
      'frame',
    ]);
    // 100 (dropped buffer) + 500 (discarded flood) + 11 (bytes before the newline)
    expect(framer.discardedByteCount).toBe(611);
  });

  it('refuses to send more than MAX_FRAME_BYTES and writes nothing', () => {
    const huge = 'x'.repeat(MAX_FRAME_BYTES);
    expect(() =>
      encodeFrame({ v: 1, id: 'h', method: 'conversation.send', params: { content: huge } }),
    ).toThrowError(FrameTooLargeError);
    expect(MAX_FRAME_BYTES).toBe(4 * 1024 * 1024); // mirrors sandpane_service
  });

  it('rejects malformed envelopes instead of guessing', () => {
    expect(decodeLine('not json').ok).toBe(false);
    expect(decodeLine('[1,2,3]').ok).toBe(false);
    expect(decodeLine('{"v":0,"id":"1","ok":1}').ok).toBe(false);
    expect(decodeLine('{"v":1,"ok":1}').ok).toBe(false); // no id
    expect(decodeLine('{"v":1,"id":"1","ok":1,"err":{"code":"INTERNAL","message":"m"}}').ok).toBe(false);
    expect(decodeLine('{"v":1,"id":"1","err":{"code":"NOPE","message":"m"}}').ok).toBe(false);
    expect(decodeLine('{"v":1,"id":"1","err":{"code":"INTERNAL"}}').ok).toBe(false);
  });

  it('accepts a valid ok/err response pair exactly as Core writes them', () => {
    const ok = decodeLine('{"v":1,"id":"r1","ok":{"taskId":"t1"}}');
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.frame.kind === 'response') {
      expect(ok.frame.response).toEqual({ v: 1, id: 'r1', ok: { taskId: 't1' } });
    }
    const err = decodeLine(
      '{"v":1,"id":"r2","err":{"code":"NOT_INSTALLED","message":"sbx executable not found"}}',
    );
    expect(err.ok).toBe(true);
    if (err.ok && err.frame.kind === 'response') {
      expect(err.frame.response.err?.code).toBe('NOT_INSTALLED');
      expect(err.frame.response.ok).toBeUndefined();
    }
  });

  it('classifies a method-bearing frame as a notification (Core sends none today)', () => {
    const parsed = decodeLine('{"v":1,"method":"task.pushed","params":{"taskId":"t"}}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.frame.kind).toBe('notification');
  });
});
