import fs from "node:fs";
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
