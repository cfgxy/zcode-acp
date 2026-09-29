import fs from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZServerBroker } from "../src/backend/zserver/broker.js";
import { ZServerConnection } from "../src/backend/zserver/index.js";

const tempDirs: string[] = [];
const sockets: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
  for (const s of sockets.splice(0)) {
    try {
      fs.unlinkSync(s);
    } catch {
      /* already gone */
    }
  }
});

/** Stage a fake zcode-server root (hand-rolled protocol fixture). */
function makeServerRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-broker-"));
  tempDirs.push(root);
  fs.copyFileSync(
    new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
    path.join(root, "zcode-server.cjs"),
  );
  return root;
}

describe("ZServerBroker", () => {
  it("multiplexes two clients onto one shared server with independent ids", async () => {
    const socketPath = path.join(os.tmpdir(), `zserver-broker-test-${Date.now()}.sock`);
    sockets.push(socketPath);
    const broker = new ZServerBroker(socketPath, makeServerRoot());
    await broker.start();

    // Both clients attach concurrently; the broker spawns the server once.
    const [a, b] = await Promise.all([
      ZServerConnection.attach({ socketPath, clientId: "client-a" }),
      ZServerConnection.attach({ socketPath, clientId: "client-b" }),
    ]);

    try {
      // Interleaved calls with colliding client-side ids (both use id 0 first).
      const a1 = a.call("initialize", { who: "a" });
      const b1 = b.call("initialize", { who: "b" });
      const a2 = a.call("listTasks");
      expect(await a1).toBe('echo:initialize:[{"who":"a"}]');
      expect(await b1).toBe('echo:initialize:[{"who":"b"}]');
      expect(await a2).toBe("echo:listTasks:[]");
      // Server stays singular: two attaches, one child process.
      expect(a.child).toBeNull();
      expect(b.child).toBeNull();
    } finally {
      a.dispose();
      b.dispose();
      await broker.stop();
    }
  });

  it("survives a client detach and serves late attachers", async () => {
    const socketPath = path.join(os.tmpdir(), `zserver-broker-test2-${Date.now()}.sock`);
    sockets.push(socketPath);
    const broker = new ZServerBroker(socketPath, makeServerRoot());
    await broker.start();

    const first = await ZServerConnection.attach({ socketPath, clientId: "first" });
    first.dispose();
    await new Promise((r) => setTimeout(r, 50));

    const second = await ZServerConnection.attach({ socketPath, clientId: "second" });
    try {
      await expect(second.call("listTasks")).resolves.toBe("echo:listTasks:[]");
    } finally {
      second.dispose();
      await broker.stop();
    }
  });
});

describe("ZServerBroker event multiplexing", () => {
  it("delivers repeated EventFire frames and honors unsubscribe end-to-end", async () => {
    const socketPath = path.join(os.tmpdir(), `zserver-broker-test3-${Date.now()}.sock`);
    sockets.push(socketPath);
    const broker = new ZServerBroker(socketPath, makeServerRoot());
    await broker.start();

    const client = await ZServerConnection.attach({ socketPath, clientId: "evt-client" });
    try {
      // decode/encode helpers from the public module to craft raw listen ids
      const seen: unknown[] = [];
      const unsubscribe = client.listen("onTick", undefined, (data) => seen.push(data));
      await new Promise((r) => setTimeout(r, 300));
      expect(seen.length).toBeGreaterThanOrEqual(3); // repeated fires, same id
      unsubscribe();
      const at = seen.length;
      await new Promise((r) => setTimeout(r, 300));
      expect(seen.length).toBe(at); // unsubscribe actually reached the server
    } finally {
      client.dispose();
      await broker.stop();
    }
  });

  it("detaches clients when the shared server dies (no silent event stall)", async () => {
    const socketPath = path.join(os.tmpdir(), `zserver-broker-test4-${Date.now()}.sock`);
    sockets.push(socketPath);
    process.env.ZSERVER_FAKE_DIE_AFTER_MS = "400";
    try {
      const broker = new ZServerBroker(socketPath, makeServerRoot());
      await broker.start();
      const client = await ZServerConnection.attach({ socketPath, clientId: "victim" });
      const closed = new Promise<void>((resolve) => {
        client.onExit(() => resolve());
      });
      // The fixture kills itself; the broker must detach the client socket so
      // the client's heal path notices (no silent event stall).
      const detached = await Promise.race([
        closed.then(() => "closed"),
        new Promise((r) => setTimeout(() => r("stall"), 3000)),
      ]);
      expect(detached).toBe("closed");
      client.dispose();
      await broker.stop();
    } finally {
      delete process.env.ZSERVER_FAKE_DIE_AFTER_MS;
    }
  });
});

describe("ZServerBroker cross-client isolation", () => {
  it("keeps two simultaneous subscriptions independent (no id-space collision)", async () => {
    const socketPath = path.join(os.tmpdir(), `zserver-broker-test5-${Date.now()}.sock`);
    sockets.push(socketPath);
    const broker = new ZServerBroker(socketPath, makeServerRoot());
    await broker.start();

    const a = await ZServerConnection.attach({ socketPath, clientId: "sub-a" });
    const b = await ZServerConnection.attach({ socketPath, clientId: "sub-b" });
    try {
      const seenA: unknown[] = [];
      const seenB: unknown[] = [];
      const unsubA = a.listen("onTick", undefined, (d) => seenA.push(d));
      const unsubB = b.listen("onTick", undefined, (d) => seenB.push(d));
      await new Promise((r) => setTimeout(r, 350));
      unsubA();
      unsubB();
      // With per-client server-id counters both subscriptions rewrote to the
      // same server id — the server collapsed them into one and only the
      // first-match client ever saw events.
      expect(seenA.length).toBeGreaterThanOrEqual(3);
      expect(seenB.length).toBeGreaterThanOrEqual(3);
    } finally {
      a.dispose();
      b.dispose();
      await broker.stop();
    }
  });

  it("disconnects a client whose buffered frames exceed the cap", async () => {
    const socketPath = path.join(os.tmpdir(), `zserver-broker-test6-${Date.now()}.sock`);
    sockets.push(socketPath);
    process.env.ZCODE_ACP_ZSERVER_MAX_CLIENT_BUFFER = "1024";
    try {
      const broker = new ZServerBroker(socketPath, makeServerRoot());
      await broker.start();
      // Prime the shared server with one proper attach so the socket is warm.
      const primer = await ZServerConnection.attach({ socketPath, clientId: "primer" });
      primer.dispose();
      // Raw socket: a Regular frame header claiming a 1MB body plus 2KB of it.
      // The decoder buffers the partial frame past the 1KB cap → disconnect.
      const raw = connect(socketPath);
      await new Promise<void>((resolve, reject) => {
        raw.once("connect", resolve);
        raw.once("error", reject);
      });
      const rawEvents: string[] = [];
      for (const ev of ["end", "error", "close"]) {
        raw.on(ev, (e?: Error) => rawEvents.push(`${ev}:${(e as { code?: string })?.code ?? ""}`));
      }
      const header = Buffer.alloc(13);
      header.writeUInt8(1, 0);
      header.writeUInt32BE(1024 * 1024, 9);
      raw.write(header);
      raw.write(Buffer.alloc(2048));
      // Broker-side observable: the cap-exceeded client's entry must be dropped
      // (its socket destroyed). Note: the client-side socket events are not
      // reliably observable inside the vitest worker (same code delivers them
      // under plain node), so assert on the broker's own bookkeeping.
      const clientsOf = () => (broker as unknown as { clients: Map<number, unknown> }).clients.size;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && clientsOf() > 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      raw.destroy();
      expect(clientsOf()).toBe(0);
    } finally {
      delete process.env.ZCODE_ACP_ZSERVER_MAX_CLIENT_BUFFER;
    }
  });
});

describe("ZServerBroker detach hygiene", () => {
  it("synthesizes unsubscribe for subscriptions left by a detached client", async () => {
    const socketPath = path.join(os.tmpdir(), `zserver-broker-test7-${Date.now()}.sock`);
    sockets.push(socketPath);
    const broker = new ZServerBroker(socketPath, makeServerRoot());
    await broker.start();
    const client = await ZServerConnection.attach({ socketPath, clientId: "ghost" });
    // Leave a subscription open, then vanish WITHOUT unsubscribing
    // (ChannelClient.dispose sends nothing).
    client.listen("onTick", undefined, () => undefined);
    await new Promise((r) => setTimeout(r, 250)); // let the subscribe reach the server
    client.dispose();
    await new Promise((r) => setTimeout(r, 400));
    // The fixture writes ZSERVER_UNSUB:<id> to stderr when the broker's
    // synthesized EventDispose reaches it.
    const connection = (broker as unknown as { connection: { stderrSnapshot(): string[] } | null })
      .connection;
    const stderr = connection?.stderrSnapshot().join("\n") ?? "";
    expect(stderr).toContain("ZSERVER_UNSUB:");
    await broker.stop();
  });
});
