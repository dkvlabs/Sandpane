/**
 * NDJSON framing codec for the Sandpane Core IPC transport
 * (newline-delimited JSON over a Unix domain socket / Windows named pipe).
 *
 * Transport-agnostic on purpose: the byte source is injected (Tauri IPC proxy
 * in production, an in-memory duplex in tests), so the exact same framing and
 * correlation code runs in both.
 *
 * Bounded-input rule (AGENTS.md §Code Review rule 9): a frame larger than
 * `MAX_FRAME_BYTES` aborts the stream instead of being buffered, so a hostile
 * or wedged peer cannot make the UI grow without limit.
 */

import { MAX_FRAME_BYTES } from "./protocol";

const LF = 0x0a;

export class FrameTooLargeError extends Error {
  readonly code = "FRAME_TOO_LARGE" as const;
  constructor(readonly byteLength: number) {
    super(
      `frame exceeds the ${MAX_FRAME_BYTES} byte NDJSON cap (saw ${byteLength} bytes)`,
    );
    this.name = "FrameTooLargeError";
  }
}

export class MalformedFrameError extends Error {
  readonly code = "MALFORMED_FRAME" as const;
  constructor(message: string) {
    super(message);
    this.name = "MalformedFrameError";
  }
}

const textEncoder = /* @__PURE__ */ new TextEncoder();
const textDecoder = /* @__PURE__ */ new TextDecoder("utf-8");

/** Serialize one request frame; Core reads exactly one frame per `\n`. */
export function encodeFrame(value: unknown): string {
  const line = JSON.stringify(value);
  const bytes = textEncoder.encode(line).byteLength;
  if (bytes > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(bytes);
  }
  return `${line}\n`;
}

function indexOfLF(bytes: Uint8Array, from: number): number {
  for (let i = from; i < bytes.length; i += 1) {
    if (bytes[i] === LF) return i;
  }
  return -1;
}

/**
 * Splits an incoming byte stream into complete NDJSON frames.
 *
 * Feed it arbitrary chunk boundaries (a frame may arrive one byte at a time, a
 * multi-byte UTF-8 sequence may straddle two chunks — 0x0A is never a UTF-8
 * continuation byte, so boundaries stay intact). After the first
 * `FrameTooLargeError` the decoder is dead and every further `push` rethrows:
 * the transport must reconnect rather than resynchronise on a corrupt stream.
 */
export class FrameDecoder {
  /** Bytes after the last consumed newline (an incomplete frame). */
  private tail: Uint8Array = new Uint8Array(0);
  private dead = false;
  private framesDecoded = 0;

  get pendingBytes(): number {
    return this.tail.byteLength;
  }

  get decodedFrameCount(): number {
    return this.framesDecoded;
  }

  get isDead(): boolean {
    return this.dead;
  }

  push(chunk: Uint8Array): string[] {
    if (this.dead) {
      throw new FrameTooLargeError(this.tail.byteLength);
    }
    const merged = concat(this.tail, chunk);
    const frames: string[] = [];
    let start = 0;
    for (;;) {
      const nl = indexOfLF(merged, start);
      if (nl === -1) break;
      const lineBytes = merged.subarray(start, nl);
      if (lineBytes.byteLength > MAX_FRAME_BYTES) {
        this.fail(lineBytes.byteLength);
      }
      // Core writes exactly one frame per line; skip blank separators only.
      if (lineBytes.byteLength > 0) {
        const line = textDecoder.decode(lineBytes);
        frames.push(stripCR(line));
      }
      start = nl + 1;
    }
    const rest = merged.subarray(start);
    if (rest.byteLength > MAX_FRAME_BYTES) {
      this.fail(rest.byteLength);
    }
    // Copy so the (possibly large) merged buffer is not retained by the tail.
    this.tail = rest.byteLength === 0 ? new Uint8Array(0) : new Uint8Array(rest);
    this.framesDecoded += frames.length;
    return frames;
  }

  /** Drop buffered partial data (called on reconnect before resubscribing). */
  reset(): void {
    this.tail = new Uint8Array(0);
    this.dead = false;
  }

  private fail(byteLength: number): never {
    this.dead = true;
    this.tail = new Uint8Array(0);
    throw new FrameTooLargeError(byteLength);
  }
}

function stripCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
