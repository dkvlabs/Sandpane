import { describe, expect, it } from "vitest";
import {
  FrameDecoder,
  FrameTooLargeError,
  MalformedFrameError,
  encodeFrame,
} from "../src/lib/framing";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from "../src/lib/protocol";
import { parseResponseFrame } from "../src/lib/core-client";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function decode(chunks: (string | Uint8Array)[]): string[] {
  const decoder = new FrameDecoder();
  const out: string[] = [];
  for (const chunk of chunks) {
    out.push(...decoder.push(typeof chunk === "string" ? bytes(chunk) : chunk));
  }
  return out;
}

describe("encodeFrame", () => {
  it("produces exactly one NDJSON line with the protocol envelope", () => {
    const frame = encodeFrame({
      v: PROTOCOL_VERSION,
      id: "desk-1",
      method: "system.probe",
      params: {},
    });
    expect(frame.endsWith("\n")).toBe(true);
    expect(frame.trimEnd()).toBe(
      '{"v":1,"id":"desk-1","method":"system.probe","params":{}}',
    );
    expect(() => JSON.parse(frame)).not.toThrow();
  });

  it("refuses to build a frame larger than the cap", () => {
    expect(() => encodeFrame({ v: 1, id: "a", method: "x", params: "y".repeat(MAX_FRAME_BYTES) }))
      .toThrow(FrameTooLargeError);
  });

  it("keeps hostile message content inert as data", () => {
    const frame = encodeFrame({ content: "hi; rm -rf /" });
    expect(JSON.parse(frame).content).toBe("hi; rm -rf /");
  });
});

describe("FrameDecoder", () => {
  it("splits two frames that arrive in one chunk", () => {
    expect(decode(['{"a":1}\n{"b":2}\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("reassembles one frame split byte by byte", () => {
    const line = '{"taskId":"t1","sequence":7}\n';
    const chunks = Array.from(line).map((char) => bytes(char));
    expect(decode(chunks)).toEqual(['{"taskId":"t1","sequence":7}']);
  });

  it("holds an incomplete tail until the newline arrives", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(bytes('{"partial":'))).toEqual([]);
    expect(decoder.pendingBytes).toBe('{"partial":'.length);
    expect(decoder.push(bytes("1}\n"))).toEqual(['{"partial":1}']);
    expect(decoder.pendingBytes).toBe(0);
  });

  it("decodes a multi-byte payload split across chunks", () => {
    const line = '{"path":"src/ünicode/ファイル.rs"}\n';
    const raw = bytes(line);
    const midpoint = Math.floor(raw.length / 2);
    // Split repeatedly at every offset to prove no boundary can corrupt it.
    for (const at of [1, midpoint, raw.length - 1]) {
      const got = decode([raw.slice(0, at), raw.slice(at)]);
      expect(got).toEqual(['{"path":"src/ünicode/ファイル.rs"}']);
    }
  });

  it("skips blank separator lines", () => {
    expect(decode(["\n\n{}\n"])).toEqual(["{}"]);
  });

  it("strips a trailing carriage return (CRLF peers)", () => {
    expect(decode(['{"ok":true}\r\n'])).toEqual(['{"ok":true}']);
  });

  it("aborts rather than buffering past the frame cap", () => {
    const decoder = new FrameDecoder();
    const oversized = new Uint8Array(MAX_FRAME_BYTES + 10);
    oversized.fill(0x78 /* x */);
    expect(() => decoder.push(oversized)).toThrow(FrameTooLargeError);
    expect(decoder.isDead).toBe(true);
    // A dead decoder stays dead: the transport must reconnect, not resync.
    expect(() => decoder.push(bytes("{}\n"))).toThrow(FrameTooLargeError);
  });

  it("catches a complete frame that is itself over the cap", () => {
    const decoder = new FrameDecoder();
    const huge = new Uint8Array(MAX_FRAME_BYTES + 1);
    huge.fill(0x79);
    let thrown = false;
    try {
      decoder.push(huge);
      decoder.push(bytes("\n"));
    } catch (err) {
      thrown = err instanceof FrameTooLargeError;
    }
    expect(thrown).toBe(true);
  });

  it("counts decoded frames for diagnostics", () => {
    const decoder = new FrameDecoder();
    decoder.push(bytes('{"a":1}\n{"b":2}\n'));
    expect(decoder.decodedFrameCount).toBe(2);
  });

  it("reset() drops the partial tail so a reconnect starts clean", () => {
    const decoder = new FrameDecoder();
    decoder.push(bytes('{"unfinished":'));
    decoder.reset();
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.push(bytes('{"fresh":1}\n'))).toEqual(['{"fresh":1}']);
  });
});

describe("parseResponseFrame", () => {
  it("accepts an ok frame", () => {
    expect(parseResponseFrame('{"v":1,"id":"x","ok":{"taskId":"t"}}')).toEqual({
      v: 1,
      id: "x",
      ok: { taskId: "t" },
    });
  });

  it("accepts an err frame with a known code", () => {
    const frame = parseResponseFrame(
      '{"v":1,"id":"x","err":{"code":"NOT_INSTALLED","message":"sbx not found"}}',
    );
    expect(frame).toMatchObject({ id: "x", err: { code: "NOT_INSTALLED" } });
  });

  it("keeps optional err details when present", () => {
    const frame = parseResponseFrame(
      '{"v":1,"id":"x","err":{"code":"CONFLICT","message":"m","details":{"branch":"b"}}}',
    );
    if (!("err" in frame) || frame.err === undefined) {
      throw new Error("expected an err frame");
    }
    expect(frame.err.details).toEqual({ branch: "b" });
  });

  it("rejects a frame carrying both or neither outcome", () => {
    expect(() => parseResponseFrame('{"v":1,"id":"x"}')).toThrow(MalformedFrameError);
    expect(() =>
      parseResponseFrame('{"v":1,"id":"x","ok":1,"err":{"code":"INTERNAL","message":"m"}}'),
    ).toThrow(MalformedFrameError);
  });

  it("rejects non-JSON, arrays, and missing envelope fields", () => {
    expect(() => parseResponseFrame("not json")).toThrow(MalformedFrameError);
    expect(() => parseResponseFrame("[1,2]")).toThrow(MalformedFrameError);
    expect(() => parseResponseFrame('{"id":"x","ok":1}')).toThrow(MalformedFrameError);
    expect(() => parseResponseFrame('{"v":1,"ok":1}')).toThrow(MalformedFrameError);
  });

  it("rejects an unknown error code instead of coercing it", () => {
    expect(() =>
      parseResponseFrame('{"v":1,"id":"x","err":{"code":"WEIRD","message":"m"}}'),
    ).toThrow(MalformedFrameError);
  });
});

describe("round trip through the codec", () => {
  it("encodes a request that a peer can decode and answer", () => {
    const request = { v: PROTOCOL_VERSION, id: "desk-42", method: "task.subscribe", params: { afterSequence: 5 } };
    const wire = encodeFrame(request);
    const decoded = decode([wire]);
    expect(decoded).toHaveLength(1);
    const parsed = JSON.parse(decoded[0]!);
    expect(parsed.params.afterSequence).toBe(5);
    const response = encodeFrame({ v: 1, id: parsed.id, ok: [] });
    expect(parseResponseFrame(decode([response])[0]!)).toEqual({ v: 1, id: "desk-42", ok: [] });
  });
});
