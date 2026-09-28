import { describe, expect, it } from "vitest";

import {
  ChannelClient,
  decodeMessage,
  encodeFrame,
  encodeMessage,
  FrameDecoder,
} from "../src/backend/zserver/index.js";

/**
 * Wire-format fixtures were verified against the deployed
 * ~/.zcode/server/zcode-server.cjs (v3.14.3) bundle: serialization.ts
 * (DataType tags + VQL varint), protocol.ts (13-byte frame header) and
 * channelClient.ts (header [type, id, channelName, name] + body).
 */

describe("zserver serialization", () => {
  it("round-trips tagged values through one message", () => {
    const nested = { list: [1, "two", { deep: true }], n: 300, s: "str" };
    const cases: Array<[unknown, (v: unknown) => boolean]> = [
      [undefined, (v) => v === undefined],
      ["hello", (v) => v === "hello"],
      [0, (v) => v === 0],
      [127, (v) => v === 127],
      [128, (v) => v === 128],
      [300, (v) => v === 300],
      [-1, (v) => v === -1],
      [[1, "a", [2, 3]], (v) => JSON.stringify(v) === JSON.stringify([1, "a", [2, 3]])],
      [nested, (v) => JSON.stringify(v) === JSON.stringify(nested)],
      [null, (v) => v === null],
    ];
    for (const [value, matches] of cases) {
      const decoded = decodeMessage(encodeMessage(value, undefined));
      expect(matches(decoded.header)).toBe(true);
    }
  });

  it("preserves binary payloads as Uint8Array including nested-in-object base64 markers", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const decoded = decodeMessage(encodeMessage(bytes, undefined));
    expect(decoded.header).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.header as Uint8Array)).toEqual([0, 1, 2, 250, 255]);

    const wrapped = { blob: bytes };
    const decodedObject = decodeMessage(encodeMessage(wrapped, undefined));
    expect((decodedObject.header as { blob: Uint8Array }).blob).toBeInstanceOf(Uint8Array);
    expect(Array.from((decodedObject.header as { blob: Uint8Array }).blob)).toEqual([
      0, 1, 2, 250, 255,
    ]);
  });
});

describe("zserver framing", () => {
  it("reassembles frames split across arbitrary byte boundaries", () => {
    const payloads: Buffer[] = [];
    const decoder = new FrameDecoder((payload) => payloads.push(payload));
    const payloadA = encodeMessage([201, 7], "done");
    const payloadB = encodeMessage([204, 8], { tick: 1 });
    const frame = Buffer.concat([encodeFrame(payloadA), encodeFrame(payloadB)]);

    // Feed byte-by-byte: frame A completes exactly with its last byte, so the
    // all-but-last prefix must have yielded exactly one message.
    for (const byte of frame.subarray(0, frame.byteLength - 1)) {
      decoder.push(Buffer.from([byte]));
    }
    expect(payloads).toHaveLength(1);
    expect(decodeMessage(payloads[0]!).header).toEqual([201, 7]);
    decoder.push(Buffer.from([frame.at(-1)!]));
    expect(payloads).toHaveLength(2);
    expect(decodeMessage(payloads[1]!).header).toEqual([204, 8]);
  });
});

/**
 * In-process fake server speaking the same wire protocol: sends Initialize on
 * connect, resolves Promise requests, fires subscribed events.
 */
function makeFakeServer() {
  const clientFrames: Array<{ header: unknown; body: unknown }> = [];
  let send: ((payload: Buffer) => void) | null = null;
  const listeners = new Map<number, (data: unknown) => void>();

  const server = {
    onClientFrame(payload: Buffer): void {
      const { header, body } = decodeMessage(payload);
      const [type, id, , name] = header as [number, number, string, string];
      clientFrames.push({ header, body });
      if (type === 102) {
        listeners.set(id, (data: unknown) => {
          send?.(encodeFrame(encodeMessage([204, id], data)));
        });
        return;
      }
      if (type === 103) {
        listeners.delete(id);
        return;
      }
      if (type === 100) {
        send?.(encodeFrame(encodeMessage([201, id], `echo:${name}:${JSON.stringify(body)}`)));
      }
    },
    attach(sender: (payload: Buffer) => void): void {
      send = sender;
      send(encodeFrame(encodeMessage([200], undefined)));
    },
    fire(eventId: number, data: unknown): void {
      listeners.get(eventId)?.(data);
    },
  };
  return { server, clientFrames };
}

describe("zserver ChannelClient", () => {
  it("queues requests until Initialize, then resolves calls and events", async () => {
    const fake = makeFakeServer();
    // The fake server emits framed bytes; strip frames before feeding the client.
    const decoder = new FrameDecoder((payload) => client.onMessage(decodeMessage(payload)));
    const client = new ChannelClient((payload) => fake.server.onClientFrame(payload));

    // Sent before Initialize arrives — must be queued, not lost.
    const pending = client.call("zcode-agent", "initialize", [{ workspace: "/tmp/w" }]);
    expect(fake.clientFrames).toHaveLength(0);
    fake.server.attach((frameBytes) => decoder.push(frameBytes));
    const result = (await pending) as string;
    expect(result).toBe('echo:initialize:[{"workspace":"/tmp/w"}]');
    const request = fake.clientFrames[0]!;
    expect(request.header).toEqual([100, 0, "zcode-agent", "initialize"]);

    // Events: fire only after subscribe, stop after dispose.
    const seen: unknown[] = [];
    let unsubscribe: (() => void) | null = null;
    const fired = new Promise<void>((resolve) => {
      unsubscribe = client.listen("zcode-agent", "onTaskUpdated", undefined, (data) => {
        seen.push(data);
        resolve();
      });
    });
    const listenFrame = fake.clientFrames.find((f) => f.header[0] === 102);
    expect(listenFrame?.header).toEqual([102, 1, "zcode-agent", "onTaskUpdated"]);
    fake.server.fire(1, { state: "running" });
    await fired;
    expect(seen).toEqual([{ state: "running" }]);

    unsubscribe!();
    expect(fake.clientFrames.some((f) => f.header[0] === 103)).toBe(true);
  });

  it("fails queued requests closed on dispose", async () => {
    const client = new ChannelClient(() => undefined);
    const pending = client.call("zcode-agent", "createTask");
    client.dispose();
    await expect(pending).rejects.toMatchObject({ name: "ConnectionClosed" });
  });
});
