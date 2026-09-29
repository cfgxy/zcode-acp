import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZServerBackend } from "../src/backend/zserver/backend.js";
import { ZServerBroker } from "../src/backend/zserver/broker.js";
import { ChannelClient } from "../src/backend/zserver/channel-client.js";
import { ZServerConnection, ZServerConnectionError } from "../src/backend/zserver/connection.js";
import { ZcodeAcpServer } from "../src/server.js";

const tempDirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-hard-"));
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
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

function withEnv(vars: Record<string, string>): void {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  cleanups.push(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

interface ChannelInternals {
  handlers: Map<number, unknown>;
  pendingRejections: Map<number, unknown>;
  eventListeners: Map<number, unknown>;
}

interface BackendInternals {
  connection: { client: ChannelClient };
  gatesBySession: Map<string, unknown>;
  unsubscribersBySession: Map<string, unknown[]>;
  subscribedSessions: Set<string>;
  workspaceBySession: Map<string, string>;
  emittedByRow: Map<string, number>;
  terminalErrorBySession: Map<string, unknown>;
}

describe("ChannelClient request abandonment", () => {
  it("abort settles the call, frees its handler, and drops a late response", async () => {
    const sent: Buffer[] = [];
    const client = new ChannelClient((payload) => sent.push(payload));
    client.onMessage({ header: [200], body: undefined });
    const controller = new AbortController();
    const call = client.call("zcode-task", "listTasks", [], controller.signal);
    const internals = client as unknown as ChannelInternals;
    expect(internals.handlers.size).toBe(1);
    expect(internals.pendingRejections.size).toBe(1);

    const reason = new Error("gave up");
    controller.abort(reason);
    await expect(call).rejects.toBe(reason);
    expect(internals.handlers.size).toBe(0);
    expect(internals.pendingRejections.size).toBe(0);
    // A late answer to the abandoned id is a silent no-op, not a crash.
    expect(() => client.onMessage({ header: [201, 0], body: "late" })).not.toThrow();
    // Abandon is LOCAL: no 101 cancel is sent (the server-side work may be a
    // side-effecting sendPrompt that must not be aborted).
    const cancelFrames = sent.filter(
      (payload) => payload[0] === 4 && payload[2] === 6 && payload[3] === 101,
    );
    expect(cancelFrames).toHaveLength(0);
  });

  it("an already-aborted signal rejects immediately without sending anything", async () => {
    const sent: Buffer[] = [];
    const client = new ChannelClient((payload) => sent.push(payload));
    client.onMessage({ header: [200], body: undefined });
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    await expect(client.call("c", "m", [], controller.signal)).rejects.toThrow("pre-aborted");
    expect(sent).toHaveLength(0);
  });

  it("a normal response after a signal was attached cleans the abort listener", async () => {
    const client = new ChannelClient(() => undefined);
    client.onMessage({ header: [200], body: undefined });
    const controller = new AbortController();
    const call = client.call("c", "m", [], controller.signal);
    client.onMessage({ header: [201, 0], body: "ok" });
    await expect(call).resolves.toBe("ok");
    // Aborting afterwards must not throw or resurrect anything.
    expect(() => controller.abort(new Error("late abort"))).not.toThrow();
  });
});

describe("timed-out requests do not pin connection state", () => {
  it("request timeout abandons the pending call (handlers stop growing per timeout)", async () => {
    withEnv({ ZSERVER_FAKE_HANG_METHODS: "listTasks" });
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    const first = await backend.request(1, "session/list", {}, 150);
    expect(first.error?.message).toBe("timeout");
    const client = (backend as unknown as BackendInternals).connection.client;
    const internals = client as unknown as ChannelInternals;
    const baseline = internals.handlers.size;
    for (let i = 0; i < 10; i++) {
      const response = await backend.request(2 + i, "session/list", {}, 100);
      expect(response.error?.message).toBe("timeout");
    }
    // Before the fix every timeout left one handler + one pendingRejection.
    expect(internals.handlers.size).toBe(baseline);
    expect(internals.pendingRejections.size).toBe(0);
  }, 20000);
});

describe("close() and the completion gate", () => {
  it("close() disposes armed gates so no turn.completed fires after shutdown", async () => {
    withEnv({
      ZSERVER_FAKE_TERMINAL: JSON.stringify({ outcome: "succeeded" }),
      ZCODE_ACP_ZSERVER_TURN_QUIESCE_MS: "400",
    });
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    const events: string[] = [];
    backend.registerEventListener("sess_fake_1", {
      handleEvent: (event) => {
        if (event.type === "turn.completed") events.push(event.type);
      },
    });
    await backend.request(1, "session/create", { workspace: { workspacePath: "/tmp/ws-gate" } });
    // The fake fires the terminal outcome ~200ms after subscribe; the gate then
    // waits 400ms of quiet. Close inside that window.
    await new Promise((r) => setTimeout(r, 320));
    await backend.close();
    await new Promise((r) => setTimeout(r, 700));
    expect(events).toEqual([]);
    expect((backend as unknown as BackendInternals).gatesBySession.size).toBe(0);
  }, 20000);
});

describe("session release", () => {
  async function subscribedBackend(): Promise<ZServerBackend> {
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/create", { workspace: { workspacePath: "/tmp/ws-rel" } });
    return backend;
  }

  it("keeps the unsubscribe handles of a subscribed session (they used to be discarded)", async () => {
    const backend = await subscribedBackend();
    const internals = backend as unknown as BackendInternals;
    expect(internals.unsubscribersBySession.get("sess_fake_1")).toHaveLength(3);
  });

  it("releaseSession sends the 103 unsubscribes to the server and clears live state", async () => {
    const stderrLog = path.join(os.tmpdir(), `zserver-rel-${process.pid}-${Date.now()}.log`);
    cleanups.push(() => fs.rmSync(stderrLog, { force: true }));
    const backend = await subscribedBackend();
    const internals = backend as unknown as BackendInternals;
    const stderrLines = (): string[] =>
      (backend as unknown as { connection: { stderrSnapshot(): string[] } }).connection
        .stderrSnapshot()
        .filter((line) => line.startsWith("ZSERVER_UNSUB:"));
    const before = stderrLines().length;

    backend.releaseSession("sess_fake_1");

    // The server (fixture) saw EventDispose for each live listener it had a
    // ticker for — proof the unsubscribe reached the wire, not just a local call.
    expect(await until(() => stderrLines().length > before)).toBe(true);
    expect(internals.unsubscribersBySession.has("sess_fake_1")).toBe(false);
    expect(internals.gatesBySession.has("sess_fake_1")).toBe(false);
    expect(internals.subscribedSessions.has("sess_fake_1")).toBe(false);
    expect(internals.terminalErrorBySession.has("sess_fake_1")).toBe(false);
    expect([...internals.emittedByRow.keys()].some((key) => key.startsWith("sess_fake_1:"))).toBe(
      false,
    );
    // Retirement is not deletion: the addressing map survives so the session
    // can still be sent to / re-subscribed after the editor touches it again.
    expect(internals.workspaceBySession.get("sess_fake_1")).toBe("/tmp/ws-rel");
  });

  it("releaseSession drops that session's streaming counters and only that session's", async () => {
    const backend = await subscribedBackend();
    const internals = backend as unknown as BackendInternals;
    internals.emittedByRow.set("sess_fake_1:row-1", 12);
    internals.emittedByRow.set("sess_fake_1:row-2", 3);
    internals.emittedByRow.set("sess_other:row-1", 7);
    backend.releaseSession("sess_fake_1");
    expect([...internals.emittedByRow.keys()]).toEqual(["sess_other:row-1"]);
  });

  it("releaseSession is idempotent and a later subscribe re-arms cleanly", async () => {
    const backend = await subscribedBackend();
    const internals = backend as unknown as BackendInternals;
    backend.releaseSession("sess_fake_1");
    expect(() => backend.releaseSession("sess_fake_1")).not.toThrow();
    const again = await backend.request(2, "session/subscribe", { sessionId: "sess_fake_1" });
    expect(again.error).toBeUndefined();
    expect(internals.subscribedSessions.has("sess_fake_1")).toBe(true);
    expect(internals.unsubscribersBySession.get("sess_fake_1")).toHaveLength(3);
  });

  it("releasing a session that was never subscribed is a harmless no-op", () => {
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    expect(() => backend.releaseSession("never-seen")).not.toThrow();
  });
});

describe("in-place healing keeps the backend instance", () => {
  it("a dead zserver backend is NOT replaced by ensureBackend (listeners live on it)", () => {
    const server = new ZcodeAcpServer();
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    backend.isDead = true;
    backend.deathReason = "zcode backend reader exited (backend dead): boom";
    server.backend = backend;
    expect(server.ensureBackend()).toBe(backend);
  });

  it("a dead backend WITHOUT healsInPlace is still replaced (direct-backend contract unchanged)", () => {
    withEnv({ ZCODE_ACP_BACKEND: "zserver" });
    const server = new ZcodeAcpServer();
    const legacy = {
      isDead: true,
      deathReason: "stdout closed",
      request: async () => ({ id: 0, result: {} }),
      send: () => undefined,
      registerEventListener: () => undefined,
      unregisterEventListener: () => undefined,
      restart: async () => undefined,
      close: async () => undefined,
    };
    server.backend = legacy as never;
    const replacement = server.ensureBackend();
    expect(replacement).not.toBe(legacy);
    cleanups.push(() => replacement.close());
  });

  it("exhausting the respawn attempts records a death reason (else the classified error says '(unknown)')", async () => {
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    // Every spawn resolves WITHOUT assigning a connection (as if close() raced
    // it each time) — the state ensureConnection's attempt loop gives up in.
    (backend as unknown as { spawn: () => Promise<void> }).spawn = async () => undefined;
    const response = await backend.request(1, "session/list", {});
    expect(response.error?.message).toMatch(/zserver connection unavailable/);
    expect(backend.isDead).toBe(true);
    expect(backend.deathReason).toMatch(/zserver connection unavailable/);
    // ...and it keeps the marker the supervision classifiers key on.
    expect(backend.deathReason).toMatch(/backend reader exited/);
  });

  it("the heal-exhaustion error records WHY (no '(unknown)' death reason)", async () => {
    // A root whose bundle vanished mid-life: every attempt fails the same way.
    const root = makeRoot();
    const backend = new ZServerBackend({ serverRoot: root });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/list", {});
    await backend.close();
    fs.rmSync(path.join(root, "zcode-server.cjs"));
    const response = await backend.request(2, "session/list", {});
    expect(response.error).toBeDefined();
    expect(backend.isDead).toBe(true);
    expect(backend.deathReason).toBeTruthy();
    expect(backend.deathReason).not.toBe("unknown");
  });
});

describe("spawn failure classification", () => {
  it("an async spawn error (ENOENT/EACCES) is a permanent spawn failure, not a retryable death", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-hard-noexec-"));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "node"), "not an executable");
    fs.chmodSync(path.join(root, "node"), 0o644);
    fs.writeFileSync(path.join(root, "zcode-server.cjs"), "//");

    const error = await ZServerConnection.spawn({ serverRoot: root }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZServerConnectionError);
    expect((error as ZServerConnectionError).phase).toBe("spawn");

    // End to end through the backend: the supervise.ts wire contract.
    const backend = new ZServerBackend({ serverRoot: root });
    cleanups.push(() => backend.close());
    const response = await backend.request(1, "session/list", {});
    expect(response.error).toBeDefined();
    expect(backend.deathReason).toMatch(/^spawn failed:/);
  }, 20000);

  it("a server that starts and then crashes stays RETRYABLE (phase hello, not spawn)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-hard-crash-"));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "zcode-server.cjs"), "process.exit(3);\n");
    const error = await ZServerConnection.spawn({ serverRoot: root }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZServerConnectionError);
    expect((error as ZServerConnectionError).phase).toBe("hello");
  }, 20000);
});

describe("dispose idempotence", () => {
  it("repeated dispose signals the group once (no re-kill, no extra escalation timers)", async () => {
    withEnv({ ZCODE_ACP_ZSERVER_KILL_ESCALATION_MS: "600000" });
    const connection = await ZServerConnection.spawn({ serverRoot: makeRoot() });
    const realSetTimeout = globalThis.setTimeout;
    let escalations = 0;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 600000) escalations++;
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout;
    cleanups.push(() => {
      globalThis.setTimeout = realSetTimeout;
    });
    connection.dispose();
    connection.dispose();
    connection.dispose();
    expect(escalations).toBe(1);
  }, 20000);
});

describe("broker failure containment", () => {
  async function startBroker(): Promise<{ broker: ZServerBroker; socketPath: string }> {
    const socketPath = path.join(
      os.tmpdir(),
      `zhard-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    cleanups.push(() => fs.rmSync(socketPath, { force: true }));
    const broker = new ZServerBroker(socketPath, makeRoot());
    await broker.start();
    cleanups.push(() => broker.stop());
    return { broker, socketPath };
  }

  it("a throw escaping frame handling disconnects that client instead of killing the daemon", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    cleanups.push(() => {
      process.off("unhandledRejection", onUnhandled);
    });
    const { broker, socketPath } = await startBroker();
    (broker as unknown as { routeClientFrame: () => Promise<void> }).routeClientFrame =
      async () => {
        throw new Error("simulated internal failure");
      };
    const { connect } = await import("node:net");
    const socket = connect(socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    let closed = false;
    socket.on("close", () => (closed = true));
    socket.on("error", () => undefined);
    const { encodeFrame, encodeMessage } = await import("../src/backend/zserver/protocol.js");
    socket.write(encodeFrame(encodeMessage([100, 1, "zcode-task", "listTasks"], undefined)));
    expect(await until(() => closed)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
  }, 20000);

  it("a server frame for a reused client id only retires the entry it owns", async () => {
    const { broker } = await startBroker();
    const writes: Buffer[] = [];
    const entry = {
      id: 99,
      violations: 0,
      socket: { destroyed: false, write: (b: Buffer) => writes.push(b), destroy: () => undefined },
      // server id 1000005 (the OLD request) answered late; client id 5 has since
      // been reused for server id 1000006 (the NEWER, still-pending request).
      idByClient: new Map([
        [1000005, 5],
        [1000006, 5],
      ]),
      serverIdByClient: new Map([[5, 1000006]]),
    };
    (broker as unknown as { clients: Map<number, unknown> }).clients.set(99, entry);
    const { encodeMessage } = await import("../src/backend/zserver/protocol.js");
    (broker as unknown as { routeServerPayload(payload: Buffer): void }).routeServerPayload(
      encodeMessage([201, 1000005], "late answer"),
    );
    expect(writes).toHaveLength(1);
    expect(entry.idByClient.has(1000005)).toBe(false);
    // The newer request keeps its reverse mapping, so it can still be cancelled.
    expect(entry.serverIdByClient.get(5)).toBe(1000006);
    (broker as unknown as { clients: Map<number, unknown> }).clients.delete(99);
  });

  it("an idle-exit stop() failure is reported and exits non-zero (no unhandled rejection)", async () => {
    withEnv({ ZCODE_ACP_ZSERVER_BROKER_IDLE_EXIT_MS: "40" });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    cleanups.push(() => {
      process.off("unhandledRejection", onUnhandled);
    });
    const socketPath = path.join(
      os.tmpdir(),
      `zhard-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    cleanups.push(() => fs.rmSync(socketPath, { force: true }));
    const broker = new ZServerBroker(socketPath, makeRoot());
    const exits: number[] = [];
    broker.exitProcess = (code) => {
      exits.push(code);
    };
    const realStop = broker.stop.bind(broker);
    broker.stop = async () => {
      await realStop();
      throw new Error("simulated stop failure");
    };
    await broker.start(); // no client ever attaches → idle timer fires
    expect(await until(() => exits.length > 0)).toBe(true);
    expect(exits).toEqual([1]);
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
  }, 20000);

  it("a clean idle-exit stop() exits 0", async () => {
    withEnv({ ZCODE_ACP_ZSERVER_BROKER_IDLE_EXIT_MS: "40" });
    const socketPath = path.join(
      os.tmpdir(),
      `zhard-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    cleanups.push(() => fs.rmSync(socketPath, { force: true }));
    const broker = new ZServerBroker(socketPath, makeRoot());
    const exits: number[] = [];
    broker.exitProcess = (code) => {
      exits.push(code);
    };
    await broker.start();
    expect(await until(() => exits.length > 0)).toBe(true);
    expect(exits).toEqual([0]);
  }, 20000);
});

describe("abort listener hygiene", () => {
  it("a settled call leaves no abort listener behind on a long-lived signal", async () => {
    const { getEventListeners } = await import("node:events");
    const client = new ChannelClient(() => undefined);
    client.onMessage({ header: [200], body: undefined });
    const controller = new AbortController();
    const call = client.call("c", "m", [], controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    client.onMessage({ header: [201, 0], body: "ok" });
    await call;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("non-fatal child errors", () => {
  it("an 'error' event on a RUNNING child (e.g. a failed kill) is not treated as an exit", async () => {
    const connection = await ZServerConnection.spawn({ serverRoot: makeRoot() });
    cleanups.push(() => connection.dispose());
    let exits = 0;
    connection.onExit(() => exits++);
    connection.child!.emit("error", new Error("kill EPERM"));
    await new Promise((r) => setTimeout(r, 50));
    expect(exits).toBe(0);
    // Still fully usable: the transport was never declared dead.
    await expect(connection.channelOf("zcode-task").call("listTasks")).resolves.toBeDefined();
  }, 20000);
});
