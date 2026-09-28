/**
 * Wire codec for the zcode-server channel protocol (ADR-0008).
 *
 * Reimplemented from the open-source ZCode repo (packages/rpc) against the
 * locally deployed `~/.zcode/server/zcode-server.cjs` (v3.14.3, verified by
 * grepping the bundle) — no code is vendored:
 *
 *   transport frame : 13-byte header `type(1) | id(4 BE) | ack(4 BE) | len(4 BE)`
 *                     followed by the payload; only Regular(1) frames carry RPC.
 *   message         : serialize(header) + serialize(body), each value tagged.
 *   serialization   : 1-byte DataType tag, then VQL (7-bit varint) length and
 *                     data; objects fall back to JSON with a base64 marker for
 *                     nested Uint8Arrays.
 *   channel RPC     : request `[100|101|102|103, id, channelName, name]` +
 *                     arg; responses `[200..204, id]` + data. The server sends
 *                     Initialize(200) right after the stdio hello handshake and
 *                     clients must queue requests until then.
 */

export const HEADER_SIZE = 13;

export enum FrameType {
  Regular = 1,
}

export enum RequestType {
  Promise = 100,
  PromiseCancel = 101,
  EventListen = 102,
  EventDispose = 103,
}

export enum ResponseType {
  Initialize = 200,
  PromiseSuccess = 201,
  PromiseError = 202,
  PromiseErrorObj = 203,
  EventFire = 204,
}

// ============================================================================
// Framing
// ============================================================================

export function encodeFrame(payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.byteLength);
  frame.writeUInt8(FrameType.Regular, 0);
  frame.writeUInt32BE(0, 1);
  frame.writeUInt32BE(0, 5);
  frame.writeUInt32BE(payload.byteLength, 9);
  payload.copy(frame, HEADER_SIZE);
  return frame;
}

/**
 * Incremental frame splitter for the byte stream. `push()` accepts arbitrary
 * chunks; complete Regular-frame payloads are emitted via `onMessage`. Frames
 * must not be consumed before their full body has arrived — the upstream
 * ChunkStream fix (peek before consuming the header) guards against that.
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private totalLength = 0;

  constructor(private readonly onMessage: (payload: Buffer) => void) {}

  push(chunk: Buffer): void {
    if (chunk.byteLength === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.totalLength += chunk.byteLength;
    this.drain();
  }

  private peek(byteCount: number): Buffer | null {
    if (this.totalLength < byteCount) {
      return null;
    }
    if (this.chunks[0]!.byteLength >= byteCount) {
      return this.chunks[0]!.subarray(0, byteCount);
    }
    const result = Buffer.allocUnsafe(byteCount);
    let offset = 0;
    for (const chunk of this.chunks) {
      if (offset >= byteCount) {
        break;
      }
      const copyLength = Math.min(chunk.byteLength, byteCount - offset);
      chunk.copy(result, offset, 0, copyLength);
      offset += copyLength;
    }
    return result;
  }

  private read(byteCount: number): Buffer {
    if (this.chunks[0]!.byteLength === byteCount) {
      this.totalLength -= byteCount;
      return this.chunks.shift()!;
    }
    if (this.chunks[0]!.byteLength > byteCount) {
      const result = this.chunks[0]!.subarray(0, byteCount);
      this.chunks[0] = this.chunks[0]!.subarray(byteCount);
      this.totalLength -= byteCount;
      return result;
    }
    const result = Buffer.allocUnsafe(byteCount);
    let offset = 0;
    while (offset < byteCount) {
      const chunk = this.chunks[0]!;
      const needed = byteCount - offset;
      if (chunk.byteLength <= needed) {
        chunk.copy(result, offset);
        offset += chunk.byteLength;
        this.chunks.shift();
      } else {
        chunk.copy(result, offset, 0, needed);
        this.chunks[0] = chunk.subarray(needed);
        offset += needed;
      }
    }
    this.totalLength -= byteCount;
    return result;
  }

  private drain(): void {
    for (;;) {
      const header = this.peek(HEADER_SIZE);
      if (!header) {
        return;
      }
      const length = header.readUInt32BE(9);
      if (this.totalLength < HEADER_SIZE + length) {
        return;
      }
      this.read(HEADER_SIZE);
      if (length === 0) {
        this.onMessage(Buffer.alloc(0));
        continue;
      }
      this.onMessage(this.read(length));
    }
  }
}

// ============================================================================
// Serialization
// ============================================================================

const DataType = {
  Undefined: 0,
  String: 1,
  Buffer: 2,
  VSBuffer: 3,
  Array: 4,
  Object: 5,
  Int: 6,
} as const;

const RPC_NESTED_UINT8_ARRAY_MARKER = "__zcode_rpc_nested_uint8array_v1";

function readIntVQL(buffer: Buffer, state: { pos: number }): number {
  let value = 0;
  for (let n = 0; ; n += 7) {
    const next = buffer[state.pos++]!;
    value |= (next & 0b0111_1111) << n;
    if (!(next & 0b1000_0000)) {
      return value;
    }
  }
}

function encodeRpcJsonValue(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      [RPC_NESTED_UINT8_ARRAY_MARKER]: true,
      base64: Buffer.from(value).toString("base64"),
    };
  }
  return value;
}

function decodeRpcJsonValue(_key: string, value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[RPC_NESTED_UINT8_ARRAY_MARKER] === true
  ) {
    const record = value as Record<string, unknown>;
    return new Uint8Array(Buffer.from(record.base64 as string, "base64"));
  }
  return value;
}

/** Encode one wire value; appends to `parts` so callers can batch cheaply. */
export function encodeValue(parts: Buffer[], data: unknown): void {
  if (data === undefined) {
    parts.push(Buffer.from([DataType.Undefined]));
  } else if (typeof data === "string") {
    const body = Buffer.from(data, "utf8");
    parts.push(Buffer.from([DataType.String, ...numberToVqlBytes(body.byteLength)]), body);
  } else if (data instanceof Uint8Array) {
    const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    parts.push(Buffer.from([DataType.Buffer, ...numberToVqlBytes(body.byteLength)]), body);
  } else if (Array.isArray(data)) {
    parts.push(Buffer.from([DataType.Array, ...numberToVqlBytes(data.length)]));
    for (const element of data) {
      encodeValue(parts, element);
    }
  } else if (typeof data === "number" && (data | 0) === data) {
    parts.push(Buffer.from([DataType.Int, ...numberToVqlBytes(data)]));
  } else {
    const body = Buffer.from(JSON.stringify(data, encodeRpcJsonValue), "utf8");
    parts.push(Buffer.from([DataType.Object, ...numberToVqlBytes(body.byteLength)]), body);
  }
}

function numberToVqlBytes(value: number): number[] {
  if (value === 0) {
    return [0];
  }
  const bytes: number[] = [];
  for (let v = value; v !== 0; v = v >>> 7) {
    bytes.push(v & 0b0111_1111);
  }
  for (let i = 0; i < bytes.length - 1; i++) {
    bytes[i]! |= 0b1000_0000;
  }
  return bytes;
}

export function encodeMessage(header: unknown, body: unknown): Buffer {
  const parts: Buffer[] = [];
  encodeValue(parts, header);
  encodeValue(parts, body);
  return Buffer.concat(parts);
}

export interface DecodedMessage {
  header: unknown;
  body: unknown;
}

export function decodeMessage(payload: Buffer): DecodedMessage {
  const state = { pos: 0 };
  const header = decodeValue(payload, state);
  const body = decodeValue(payload, state);
  return { header, body };
}

function decodeValue(buffer: Buffer, state: { pos: number }): unknown {
  const type = buffer[state.pos++]!;
  switch (type) {
    case DataType.Undefined:
      return undefined;
    case DataType.String: {
      const length = readIntVQL(buffer, state);
      return buffer.subarray(state.pos, (state.pos += length)).toString("utf8");
    }
    case DataType.Buffer: {
      const length = readIntVQL(buffer, state);
      return new Uint8Array(buffer.subarray(state.pos, (state.pos += length)));
    }
    case DataType.VSBuffer: {
      const length = readIntVQL(buffer, state);
      return new Uint8Array(buffer.subarray(state.pos, (state.pos += length)));
    }
    case DataType.Array: {
      const length = readIntVQL(buffer, state);
      const result: unknown[] = [];
      for (let i = 0; i < length; i++) {
        result.push(decodeValue(buffer, state));
      }
      return result;
    }
    case DataType.Object: {
      const length = readIntVQL(buffer, state);
      return JSON.parse(
        buffer.subarray(state.pos, (state.pos += length)).toString("utf8"),
        decodeRpcJsonValue,
      );
    }
    case DataType.Int:
      return readIntVQL(buffer, state);
    default:
      return undefined;
  }
}
