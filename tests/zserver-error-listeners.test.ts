import fs from "node:fs";
import type * as NetModule from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeFrame, encodeMessage } from "../src/backend/zserver/protocol.js";
import { ZServerConnection } from "../src/backend/zserver/connection.js";

// Records every socket `connect()` hands out, so a test can put a real socket under stress. The
// sockets stay real; only their creation is observed.
const recorded = vi.hoisted(() => ({ sockets: [] as NetModule.Socket[] }));

vi.mock("node:net", async (importOriginal) => {
  const real = await importOriginal<typeof NetModule>();
  return {
    ...real,
    connect: (...args: Parameters<typeof real.connect>) => {
      const socket = real.connect(...args);
      recorded.sockets.push(socket);
      return socket;
    },
  };
});

const tempDirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  recorded.sockets.length = 0;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zerr-root-"));
  tempDirs.push(root);
  fs.copyFileSync(
    new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
    path.join(root, "zcode-server.cjs"),
  );
  return root;
}

async function until(cond: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return cond();
}

function captureStderr(): () => string {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return () => chunks.join("");
}

// `emit("error")` with no listener throws synchronously, so "does not throw" proves a listener
// is attached. Two emissions matter: a leftover `once` listener (the connect-phase reject, the
// exit hook) absorbs the FIRST error by accident and only a persistent one survives the second.
const boom = (label: string): Error => Object.assign(new Error(label), { code: "ECONNRESET" });

describe("a child's pipes and process object never let an 'error' event escape", () => {
  it.each(["stdin", "stdout", "stderr"] as const)(
    "%s survives repeated errors and the connection stays usable",
    async (stream) => {
      const connection = await ZServerConnection.spawn({ serverRoot: makeRoot() });
      cleanups.push(() => connection.dispose());
      const target = connection.child![stream]!;
      expect(() => {
        target.emit("error", boom("EPIPE #1"));
        target.emit("error", boom("EPIPE #2"));
      }).not.toThrow();
      await expect(connection.channelOf("zcode-task").call("listTasks")).resolves.toBeDefined();
    },
    20000,
  );

  it("the child process object survives repeated errors (a failed kill, IPC noise)", async () => {
    const connection = await ZServerConnection.spawn({ serverRoot: makeRoot() });
    cleanups.push(() => connection.dispose());
    let exits = 0;
    connection.onExit(() => exits++);
    expect(() => {
      connection.child!.emit("error", boom("kill EPERM #1"));
      connection.child!.emit("error", boom("kill EPERM #2"));
    }).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exits).toBe(0); // an error on a running child is not an exit
    await expect(connection.channelOf("zcode-task").call("listTasks")).resolves.toBeDefined();
  }, 20000);
});

describe("an attached broker socket that errors routes to close semantics", () => {
  async function attachToMinimalServer(): Promise<{
    connection: ZServerConnection;
    socket: NetModule.Socket;
  }> {
    const net = await import("node:net");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zerr-sock-"));
    tempDirs.push(dir);
    const socketPath = path.join(dir, "b.sock");
    // Just enough of a broker for attach(): send the Initialize frame on connect.
    const server = net.createServer((client) => {
      client.on("error", () => undefined);
      client.write(encodeFrame(encodeMessage([200], undefined)));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const connection = await ZServerConnection.attach({ socketPath, clientId: "error-listeners" });
    cleanups.push(() => connection.dispose());
    return { connection, socket: recorded.sockets.at(-1)! };
  }

  it("repeated socket errors are handled, reported, and end the connection", async () => {
    const { connection, socket } = await attachToMinimalServer();
    const stderr = captureStderr();
    let exitDetail: string | undefined;
    connection.onExit((_code, _signal, detail) => {
      exitDetail = detail;
    });

    expect(() => {
      socket.emit("error", boom("read ECONNRESET"));
      socket.emit("error", boom("write EPIPE"));
    }).not.toThrow();

    // Routed to the close path, so the heal machinery sees an ordinary connection loss...
    expect(await until(() => exitDetail !== undefined)).toBe(true);
    expect(exitDetail).toBe("socket closed");
    expect(socket.destroyed).toBe(true);
    // ...and the operator is told why, instead of a silent drop.
    expect(stderr()).toMatch(/attach socket error \(handled\): read ECONNRESET/);
  }, 20000);
});
