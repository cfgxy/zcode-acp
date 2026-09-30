import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnCompletionGate, ZServerBackend } from "../src/backend/zserver/backend.js";
import { removeStaleSocket, ZServerBroker } from "../src/backend/zserver/broker.js";
import { ChannelClient } from "../src/backend/zserver/channel-client.js";
import { decodeMessage } from "../src/backend/zserver/protocol.js";
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

describe("refused and failed subscriptions (broker 202 / subscribe rejection)", () => {
  function connectedClient(): { client: ChannelClient; sent: Buffer[] } {
    const sent: Buffer[] = [];
    const client = new ChannelClient((payload) => sent.push(payload));
    client.onMessage({ header: [200], body: undefined });
    return { client, sent };
  }

  it("a listen the broker refuses (202) is dropped and reported, not left silently deaf", () => {
    const { client } = connectedClient();
    const errors: Error[] = [];
    client.listen(
      "zcode-agent",
      "onDynamicConversationFrame",
      { a: 1 },
      () => undefined,
      (e) => errors.push(e),
    );
    const internals = client as unknown as ChannelInternals;
    expect(internals.handlers.size).toBe(1);
    client.onMessage({
      header: [202, 0],
      body: { message: "broker: event not allowed", name: "BrokerPolicyError" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/event not allowed/);
    expect(errors[0]!.name).toBe("BrokerPolicyError");
    expect(internals.handlers.size).toBe(0);
    expect(internals.eventListeners.size).toBe(0);
  });

  it("a refused listen with no onError handler warns instead of vanishing", () => {
    const { client } = connectedClient();
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      client.listen("zcode-task", "onDynamicTaskTerminalOutcome", "s1", () => undefined);
      client.onMessage({ header: [202, 0], body: { message: "broker: nope", name: "X" } });
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toMatch(
      /zcode-task\.onDynamicTaskTerminalOutcome subscription refused/,
    );
  });

  it("events still flow to a healthy listen (the 204 path is untouched)", () => {
    const { client } = connectedClient();
    const seen: unknown[] = [];
    client.listen(
      "c",
      "e",
      undefined,
      (d) => seen.push(d),
      () => seen.push("ERR"),
    );
    client.onMessage({ header: [204, 0], body: "one" });
    client.onMessage({ header: [204, 0], body: "two" });
    expect(seen).toEqual(["one", "two"]);
  });

  it("a refused conversation-frame listen rolls the WHOLE subscription back (no deaf session marked subscribed)", async () => {
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/create", { workspace: { workspacePath: "/tmp/ws-refuse" } });
    const internals = backend as unknown as BackendInternals;
    expect(internals.subscribedSessions.has("sess_fake_1")).toBe(true);

    // The broker answers the frame subscription with a 202 refusal.
    const client = internals.connection.client as unknown as {
      handlers: Map<number, (r: { type: number; id?: number; data?: unknown }) => void>;
      eventListeners: Map<number, unknown>;
    };
    const frameListenId = [...client.eventListeners.keys()].at(-1)!;
    client.handlers.get(frameListenId)!({
      type: 202,
      id: frameListenId,
      data: { message: "broker: refused", name: "BrokerPolicyError" },
    });

    expect(internals.subscribedSessions.has("sess_fake_1")).toBe(false);
    expect(internals.gatesBySession.has("sess_fake_1")).toBe(false);
    expect(internals.unsubscribersBySession.has("sess_fake_1")).toBe(false);
    // ...so the next subscribe re-registers instead of being short-circuited.
    const again = await backend.request(2, "session/subscribe", { sessionId: "sess_fake_1" });
    expect(again.error).toBeUndefined();
    expect(internals.subscribedSessions.has("sess_fake_1")).toBe(true);
  }, 20000);

  it("a failed subscribe call unsubscribes what this attempt registered (the 103s reach the server)", async () => {
    withEnv({ ZSERVER_FAKE_FAIL_METHODS: "subscribeConversationV4" });
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/create", { workspace: { workspacePath: "/tmp/ws-fail2" } });
    const internals = backend as unknown as BackendInternals;
    const unsubLines = (): string[] =>
      (backend as unknown as { connection: { stderrSnapshot(): string[] } }).connection
        .stderrSnapshot()
        .filter((line) => line.startsWith("ZSERVER_UNSUB:"));
    // Three listeners were registered. The fixture only logs an unsubscribe for
    // listens it armed a ticker for — the terminal-outcome and session-event ones;
    // the scripted conversation-frame listen has no ticker, so it never logs.
    expect(await until(() => unsubLines().length >= 2)).toBe(true);
    expect(internals.subscribedSessions.has("sess_fake_1")).toBe(false);
    expect(internals.unsubscribersBySession.has("sess_fake_1")).toBe(false);
  }, 20000);

  it("setup that throws (client disposed under the route) leaves no marker/gate behind", async () => {
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/list", {}); // connect
    const internals = backend as unknown as BackendInternals;
    // Dispose the transport client but keep the backend's reference: listen() throws.
    internals.connection.client.dispose();
    const subscribe = (
      backend as unknown as {
        subscribeConversation(c: unknown, w: string, s: string): void;
      }
    ).subscribeConversation.bind(backend);
    expect(() => subscribe(internals.connection, "/tmp/ws-x", "sess_throw")).toThrow();
    expect(internals.subscribedSessions.has("sess_throw")).toBe(false);
    expect(internals.gatesBySession.has("sess_throw")).toBe(false);
    expect(internals.unsubscribersBySession.has("sess_throw")).toBe(false);
  }, 20000);

  it("a stale failure never rolls back a NEWER attempt's state", async () => {
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/create", { workspace: { workspacePath: "/tmp/ws-stale" } });
    const internals = backend as unknown as BackendInternals;
    const client = internals.connection.client as unknown as {
      handlers: Map<number, (r: { type: number; id?: number; data?: unknown }) => void>;
      eventListeners: Map<number, unknown>;
    };
    // Capture the refusal callback of the FIRST attempt's frame listener...
    const firstFrameListenId = [...client.eventListeners.keys()].at(-1)!;
    const staleHandler = client.handlers.get(firstFrameListenId)!;
    // ...then release and re-subscribe: a NEW attempt now owns the session.
    (backend as unknown as { releaseSession(s: string): void }).releaseSession("sess_fake_1");
    await backend.request(2, "session/subscribe", { sessionId: "sess_fake_1" });
    const newer = internals.unsubscribersBySession.get("sess_fake_1");
    expect(newer).toHaveLength(3);

    // The stale attempt's refusal arrives late: it must be ignored.
    staleHandler({ type: 202, id: firstFrameListenId, data: { message: "late refusal" } });
    expect(internals.subscribedSessions.has("sess_fake_1")).toBe(true);
    expect(internals.unsubscribersBySession.get("sess_fake_1")).toBe(newer);
  }, 20000);
});

describe("cancel() and disposed completion gates (mutation-audit gaps)", () => {
  it("cancel() sends [101,id], settles the caller with Cancelled and frees the slot", async () => {
    const sent: Buffer[] = [];
    const client = new ChannelClient((payload) => sent.push(payload));
    client.onMessage({ header: [200], body: undefined });
    const call = client.call("c", "m");
    const settled = call.then(
      () => "resolved",
      (error: Error) => error.name,
    );
    const before = sent.length;
    client.cancel(0);
    await expect(settled).resolves.toBe("Cancelled");
    const cancelFrame = decodeMessage(sent[before]!);
    expect(cancelFrame.header).toEqual([101, 0]);
    const internals = client as unknown as ChannelInternals;
    expect(internals.handlers.size).toBe(0);
    expect(internals.pendingRejections.size).toBe(0);
    expect(() => client.cancel(0)).not.toThrow(); // already gone
  });

  it("a disposed gate ignores a terminal outcome that arrives LATER (heal/replace race)", () => {
    const emitted: string[] = [];
    const scheduled: Array<() => void> = [];
    const gate = new TurnCompletionGate(
      (outcome) => emitted.push(outcome),
      10,
      (fn) => {
        scheduled.push(fn);
        return { cancel: () => undefined };
      },
    );
    gate.dispose();
    gate.onTerminalOutcome("succeeded"); // arrives after dispose
    for (const fn of scheduled) fn();
    expect(scheduled).toHaveLength(0); // never even armed
    expect(emitted).toEqual([]);
  });
});

describe("session/list against the real listTasks shape", () => {
  // The deployed server's listTasks returns a BARE ARRAY of task metas (verified
  // against the bundle and a live run: 1575 rows). The old code read `.tasks`, so
  // it returned [] for every real server while its fixture-backed test passed.
  const tasks = [
    { taskId: "t1", workspacePath: "/w/a", title: "first", updatedAt: 1000, mode: "yolo" },
    { taskId: "t2", workspacePath: "/w/b", title: "second", updatedAt: 2000 },
  ];

  async function listWith(
    payload: unknown,
    params: Record<string, unknown> = {},
  ): Promise<
    Array<{
      sessionId?: string;
      workspace?: { workspacePath?: string };
      title?: string;
      updatedAt?: number;
    }>
  > {
    withEnv({ ZSERVER_FAKE_TASKS: JSON.stringify(payload) });
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    const response = await backend.request(1, "session/list", params);
    expect(response.error).toBeUndefined();
    return (response.result as { sessions: never[] }).sessions;
  }

  it("maps a bare array of task metas (what the real server returns)", async () => {
    const sessions = await listWith(tasks);
    expect(sessions).toEqual([
      { sessionId: "t1", workspace: { workspacePath: "/w/a" }, title: "first", updatedAt: 1000 },
      { sessionId: "t2", workspace: { workspacePath: "/w/b" }, title: "second", updatedAt: 2000 },
    ]);
  });

  it("still accepts a wrapped {tasks:[…]} shape", async () => {
    const sessions = await listWith({ tasks });
    expect(sessions.map((s) => s.sessionId)).toEqual(["t1", "t2"]);
  });

  it("degrades to [] for null / unexpected payloads instead of throwing", async () => {
    expect(await listWith(null)).toEqual([]);
    expect(await listWith({ unrelated: true })).toEqual([]);
  });

  it("asks the server for the caller's workspace only (it filters server-side)", async () => {
    const seen: unknown[] = [];
    withEnv({ ZSERVER_FAKE_TASKS: JSON.stringify(tasks) });
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/list", { workspace: { workspacePath: "/w/a" } });
    const client = (backend as unknown as BackendInternals).connection.client as unknown as {
      send: (payload: Buffer) => void;
    };
    const realSend = client.send.bind(client);
    client.send = (payload: Buffer) => {
      seen.push(decodeMessage(payload));
      realSend(payload);
    };
    await backend.request(2, "session/list", { workspace: { workspacePath: "/w/a" } });
    await backend.request(3, "session/list", {});
    const listCalls = (seen as Array<{ header: unknown[]; body: unknown }>).filter(
      (m) => m.header[3] === "listTasks",
    );
    expect(listCalls[0]!.body).toEqual([{ workspacePath: "/w/a" }]);
    expect(listCalls[1]!.body).toEqual([{}]);
  }, 20000);
});

describe("broker startup and shutdown safety", () => {
  function sockPath(dir: string): string {
    return path.join(dir, "b.sock");
  }
  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhard-life-"));
    tempDirs.push(dir);
    return dir;
  }
  async function probe(socketPath: string): Promise<boolean> {
    const { connect } = await import("node:net");
    return new Promise((resolve) => {
      const c = connect(socketPath);
      c.once("connect", () => {
        c.destroy();
        resolve(true);
      });
      c.once("error", () => resolve(false));
    });
  }

  it("refuses to delete a plain file sitting at the socket path (was silently unlinked)", async () => {
    const dir = tempDir();
    const target = sockPath(dir);
    fs.writeFileSync(target, "PRECIOUS-USER-DATA");
    const broker = new ZServerBroker(target, makeRoot());
    await expect(broker.start()).rejects.toThrow(/not a socket/);
    expect(fs.readFileSync(target, "utf8")).toBe("PRECIOUS-USER-DATA");
  });

  it("refuses to follow or delete a symlink at the socket path", async () => {
    const dir = tempDir();
    const victim = path.join(dir, "victim.txt");
    fs.writeFileSync(victim, "keep");
    const target = sockPath(dir);
    fs.symlinkSync(victim, target);
    const broker = new ZServerBroker(target, makeRoot());
    await expect(broker.start()).rejects.toThrow(/not a socket/);
    expect(fs.readFileSync(victim, "utf8")).toBe("keep");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it("does not treat a symlink to a stale socket as a stale socket (lstat, not stat)", async () => {
    const dir = tempDir();
    const realSock = path.join(dir, "real.sock");
    const { spawn } = await import("node:child_process");
    const dying = spawn(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer().listen(process.argv[1], () => console.log('bound'));" +
          "setInterval(() => {}, 1000);",
        realSock,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => dying.stdout!.once("data", () => resolve()));
    dying.kill("SIGKILL");
    await new Promise<void>((resolve) => dying.once("exit", () => resolve()));
    const target = sockPath(dir);
    fs.symlinkSync(realSock, target);
    // stat() would report "socket" through the link and unlink the LINK to bind
    // over it; the path holds somebody's symlink, so refuse instead.
    const broker = new ZServerBroker(target, makeRoot());
    await expect(broker.start()).rejects.toThrow(/not a socket/);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(realSock).isSocket()).toBe(true);
  }, 20000);

  it("removes a genuinely stale socket and starts", async () => {
    const dir = tempDir();
    const target = sockPath(dir);
    // A stale socket is what a process killed WITHOUT cleanup leaves behind
    // (closing the handle in-process would make libuv unlink the file itself).
    const { spawn } = await import("node:child_process");
    const dying = spawn(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer().listen(process.argv[1], () => console.log('bound'));" +
          "setInterval(() => {}, 1000);",
        target,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => dying.stdout!.once("data", () => resolve()));
    dying.kill("SIGKILL");
    await new Promise<void>((resolve) => dying.once("exit", () => resolve()));
    expect(fs.lstatSync(target).isSocket()).toBe(true);
    expect(await probe(target)).toBe(false);

    const broker = new ZServerBroker(target, makeRoot());
    await broker.start();
    cleanups.push(() => broker.stop());
    expect(await probe(target)).toBe(true);
  }, 20000);

  it("says something is already listening instead of evicting it", async () => {
    const dir = tempDir();
    const target = sockPath(dir);
    const first = new ZServerBroker(target, makeRoot());
    await first.start();
    cleanups.push(() => first.stop());
    const second = new ZServerBroker(target, makeRoot());
    await expect(second.start()).rejects.toThrow(/already listening/);
    expect(await probe(target)).toBe(true);
  });

  it("names a missing socket directory instead of Node's misleading EACCES", async () => {
    const broker = new ZServerBroker(
      path.join(os.tmpdir(), `zhard-nodir-${process.pid}`, "b.sock"),
      makeRoot(),
    );
    await expect(broker.start()).rejects.toThrow(/does not exist/);
  });

  it("a loser's stop() must not delete the winner's socket", async () => {
    const dir = tempDir();
    const target = sockPath(dir);
    const loser = new ZServerBroker(target, makeRoot());
    await loser.start();
    // A second broker takes over the path (the two-brokers start race).
    fs.unlinkSync(target);
    const winner = new ZServerBroker(target, makeRoot());
    await winner.start();
    cleanups.push(() => winner.stop());
    expect(await probe(target)).toBe(true);

    await loser.stop();

    expect(fs.existsSync(target)).toBe(true);
    expect(await probe(target)).toBe(true);
    // No parked leftovers.
    expect(fs.readdirSync(dir).filter((name) => name.includes("parked"))).toEqual([]);
  });

  it("a normal stop() still removes its own socket file", async () => {
    const dir = tempDir();
    const target = sockPath(dir);
    const broker = new ZServerBroker(target, makeRoot());
    await broker.start();
    expect(fs.existsSync(target)).toBe(true);
    await broker.stop();
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("an allowlist rejection is readable and does not look like a server death", () => {
  // Field evidence (E1/E2 on the previous snapshot): dropping one allowlisted
  // call made the broker cut the socket; the client saw "backend reader exited",
  // ran its heal loop against the same rejection forever, and the bridge shut
  // itself down with exit code 0. The rejection must now name itself.
  it("ZServerBackend gets a 'broker:' error, stays alive, and the broker keeps the connection", async () => {
    const { BROKER_ALLOWED_CALLS } = await import("../src/backend/zserver/broker.js");
    const tasksAllowed = BROKER_ALLOWED_CALLS["zcode-task"] as Set<string>;
    tasksAllowed.delete("listTasks");
    cleanups.push(() => {
      tasksAllowed.add("listTasks");
    });

    const socketPath = path.join(
      os.tmpdir(),
      `zhard-rej-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    cleanups.push(() => fs.rmSync(socketPath, { force: true }));
    const broker = new ZServerBroker(socketPath, makeRoot());
    await broker.start();
    cleanups.push(() => broker.stop());
    withEnv({ ZCODE_ACP_ZSERVER_SOCKET: socketPath });

    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    const first = await backend.request(1, "session/list", {});

    expect(first.error?.message).toMatch(/^broker: .*zcode-task\.listTasks.*not allowed/);
    // Not classified as infrastructure death: no heal loop, no bridge shutdown.
    expect(first.error?.message).not.toMatch(/backend reader exited/);
    expect(backend.isDead).toBe(false);
    expect(backend.deathReason).toBeNull();
    expect(broker.stats().clients).toBe(1);
    expect(broker.stats().rejected).toBe(1);

    // The same connection keeps working for allowed calls afterwards.
    const created = await backend.request(2, "session/create", {
      workspace: { workspacePath: "/tmp/ws-after-reject" },
    });
    expect(created.error).toBeUndefined();
    expect(backend.isDead).toBe(false);
    expect(broker.stats().clients).toBe(1);
  }, 30000);

  it("a rejection is not swallowed by the supervision classifiers", async () => {
    const { isBackendDeadMessage } = await import("../src/backend/supervise.js");
    expect(
      isBackendDeadMessage("broker: call zcode-task.listTasks is not allowed through the broker"),
    ).toBe(false);
  });
});

describe("V4 conversation subscriptions are released on the server", () => {
  // Field evidence (real server): an EventDispose (103) stops OUR delivery but the
  // server keeps the V4 subscription OWNED until unsubscribeConversationV4 names
  // its subscriptionId. The fixture reproduces that (ZSERVER_V4UNSUB marker on the
  // real unsubscribe RPC only).
  const WS = "/tmp/ws-v4";

  async function startBroker(): Promise<{
    broker: ZServerBroker;
    socketPath: string;
    unsubLines: () => string[];
  }> {
    const socketPath = path.join(
      os.tmpdir(),
      `zhard-v4-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    cleanups.push(() => fs.rmSync(socketPath, { force: true }));
    const broker = new ZServerBroker(socketPath, makeRoot());
    await broker.start();
    cleanups.push(() => broker.stop());
    const unsubLines = (): string[] => {
      const conn = (broker as unknown as { connection: { stderrSnapshot(): string[] } | null })
        .connection;
      return (conn?.stderrSnapshot() ?? []).filter((line) => line.startsWith("ZSERVER_V4UNSUB:"));
    };
    return { broker, socketPath, unsubLines };
  }

  const subscribe = (client: ZServerConnection, sessionId: string): Promise<unknown> =>
    client.channelOf("zcode-agent").call("subscribeConversationV4", {
      workspacePath: WS,
      sessionId,
      clientMode: "desktop-continuous",
    });
  const unsubscribe = (client: ZServerConnection, sessionId: string): Promise<unknown> =>
    client.channelOf("zcode-agent").call("unsubscribeConversationV4", {
      workspacePath: WS,
      sessionId,
      subscriptionId: "irrelevant-client-side-id",
    });

  it("ZServerBackend.releaseSession sends the real unsubscribeConversationV4 with the acked id", async () => {
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/create", { workspace: { workspacePath: WS } });
    const stderr = (): string[] =>
      (backend as unknown as { connection: { stderrSnapshot(): string[] } }).connection
        .stderrSnapshot()
        .filter((line) => line.startsWith("ZSERVER_V4UNSUB:"));
    // Let the fire-and-forget subscribe ack land so its id is known.
    await new Promise((r) => setTimeout(r, 300));
    expect(stderr()).toEqual([]);

    backend.releaseSession("sess_fake_1");

    expect(await until(() => stderr().length === 1)).toBe(true);
    expect(stderr()[0]).toMatch(/^ZSERVER_V4UNSUB:sub-\d+$/);
  }, 20000);

  it("a listen refused AFTER the subscribe was acked releases the server subscription too", async () => {
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/create", { workspace: { workspacePath: WS } });
    const stderr = (): string[] =>
      (backend as unknown as { connection: { stderrSnapshot(): string[] } }).connection
        .stderrSnapshot()
        .filter((line) => line.startsWith("ZSERVER_V4UNSUB:"));
    await new Promise((r) => setTimeout(r, 300)); // the subscribe ack has landed
    expect(stderr()).toEqual([]);

    // The broker now refuses the frame listen (e.g. a limit): the whole
    // subscription rolls back, and the acked server subscription must go with it.
    const client = (
      backend as unknown as {
        connection: {
          client: {
            handlers: Map<number, (r: { type: number; id?: number; data?: unknown }) => void>;
            eventListeners: Map<number, unknown>;
          };
        };
      }
    ).connection.client;
    const frameListenId = [...client.eventListeners.keys()].at(-1)!;
    client.handlers.get(frameListenId)!({
      type: 202,
      id: frameListenId,
      data: { message: "broker: refused", name: "BrokerLimitError" },
    });

    expect(await until(() => stderr().length === 1)).toBe(true);
  }, 20000);

  it("releaseSession while the subscribe is still IN FLIGHT releases it as soon as the ack lands", async () => {
    withEnv({ ZSERVER_FAKE_DELAY_METHODS: "subscribeConversationV4:400" });
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/create", { workspace: { workspacePath: WS } });
    const stderr = (): string[] =>
      (backend as unknown as { connection: { stderrSnapshot(): string[] } }).connection
        .stderrSnapshot()
        .filter((line) => line.startsWith("ZSERVER_V4UNSUB:"));

    backend.releaseSession("sess_fake_1"); // ack has NOT arrived yet
    expect(stderr()).toEqual([]);
    expect(await until(() => stderr().length === 1, 6000)).toBe(true);
  }, 20000);

  it("a client killed WITHOUT unsubscribing does not leave its subscription owned (kill -9)", async () => {
    const { broker, socketPath, unsubLines } = await startBroker();
    const client = await ZServerConnection.attach({ socketPath, clientId: "victim" });
    await subscribe(client, "sess-a");
    expect(broker.stats().clients).toBe(1);
    expect(unsubLines()).toEqual([]);

    // Hard disconnect: no unsubscribe, no goodbye.
    (client as unknown as { io: { shutdown(): void } }).io.shutdown();

    expect(await until(() => unsubLines().length === 1)).toBe(true);
  }, 20000);

  it("a shared subscription is released only when the LAST holder leaves", async () => {
    const { socketPath, unsubLines } = await startBroker();
    const a = await ZServerConnection.attach({ socketPath, clientId: "holder-a" });
    const b = await ZServerConnection.attach({ socketPath, clientId: "holder-b" });
    await subscribe(a, "sess-shared");
    await subscribe(b, "sess-shared"); // the server replaces the id; both share one subscription

    a.dispose();
    await new Promise((r) => setTimeout(r, 400));
    expect(unsubLines()).toEqual([]); // b still holds it

    b.dispose();
    expect(await until(() => unsubLines().length === 1)).toBe(true);
    // ...and it named the server's CURRENT id (the newer ack), not the first one.
    expect(unsubLines()[0]).toBe("ZSERVER_V4UNSUB:sub-2");
  }, 20000);

  it("a client's own unsubscribe is answered by the broker and never forwarded blindly", async () => {
    const { broker, socketPath, unsubLines } = await startBroker();
    const a = await ZServerConnection.attach({ socketPath, clientId: "leaver" });
    const b = await ZServerConnection.attach({ socketPath, clientId: "stayer" });
    await subscribe(a, "sess-u");
    await subscribe(b, "sess-u");

    // a's unsubscribe carries a client-side id the server never issued; it must
    // resolve (like the real server's no-op) and must NOT cut b off.
    await expect(unsubscribe(a, "sess-u")).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(unsubLines()).toEqual([]);
    expect(broker.stats().clients).toBe(2);

    await unsubscribe(b, "sess-u"); // last holder out
    expect(await until(() => unsubLines().length === 1)).toBe(true);
  }, 20000);

  it("a subscribe whose client vanished before the ack is released when the ack lands", async () => {
    withEnv({ ZSERVER_FAKE_DELAY_METHODS: "subscribeConversationV4:500" });
    const { socketPath, unsubLines } = await startBroker();
    const client = await ZServerConnection.attach({ socketPath, clientId: "vanisher" });
    void subscribe(client, "sess-late").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100)); // request is at the server, ack not yet
    (client as unknown as { io: { shutdown(): void } }).io.shutdown();
    expect(await until(() => unsubLines().length === 1, 6000)).toBe(true);
  }, 20000);

  it("a cancelled (101) subscribe is released when its ack lands", async () => {
    withEnv({ ZSERVER_FAKE_DELAY_METHODS: "subscribeConversationV4:500" });
    const { socketPath, unsubLines } = await startBroker();
    const client = await ZServerConnection.attach({ socketPath, clientId: "canceller" });
    const call = subscribe(client, "sess-cancel").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    (client as unknown as { client: ChannelClient }).client.cancel(
      [...(client as unknown as { client: ChannelInternals }).client.pendingRejections.keys()][0]!,
    );
    await call;
    expect(await until(() => unsubLines().length === 1, 6000)).toBe(true);
  }, 20000);
});

describe("least privilege on the broker allowlist", () => {
  it("does not expose closeTask (the server binds no task to its creator: cross-client close)", async () => {
    const { BROKER_ALLOWED_CALLS, validateClientHeader } =
      await import("../src/backend/zserver/broker.js");
    expect(BROKER_ALLOWED_CALLS["zcode-task"]!.has("closeTask")).toBe(false);
    expect(validateClientHeader([100, 1, "zcode-task", "closeTask"]).ok).toBe(false);
  });

  it("does not let attach clients listen for runtime-preferences requests (the broker alone answers)", async () => {
    const { BROKER_ALLOWED_EVENTS, validateClientHeader } =
      await import("../src/backend/zserver/broker.js");
    expect(
      BROKER_ALLOWED_EVENTS["zcode-agent"]!.has("onDynamicSessionRuntimePreferencesRequest"),
    ).toBe(false);
    expect(
      validateClientHeader([102, 1, "zcode-agent", "onDynamicSessionRuntimePreferencesRequest"]).ok,
    ).toBe(false);
  });

  it("still allows everything ZServerBackend really emits in attach mode", async () => {
    const { BROKER_ALLOWED_CALLS, BROKER_ALLOWED_EVENTS } =
      await import("../src/backend/zserver/broker.js");
    for (const call of [
      ["zcode-agent", "createSession"],
      ["zcode-agent", "readSession"],
      ["zcode-agent", "sendPrompt"],
      ["zcode-agent", "subscribeConversationV4"],
      ["zcode-agent", "unsubscribeConversationV4"],
      ["zcode-task", "createTask"],
      ["zcode-task", "listTasks"],
      ["zcode-task", "stopGeneration"],
    ] as const) {
      expect(BROKER_ALLOWED_CALLS[call[0]]!.has(call[1]), call.join(".")).toBe(true);
    }
    for (const event of [
      ["zcode-agent", "onDynamicConversationFrame"],
      ["zcode-agent", "onDynamicSessionEvent"],
      ["zcode-task", "onDynamicTaskTerminalOutcome"],
    ] as const) {
      expect(BROKER_ALLOWED_EVENTS[event[0]]!.has(event[1]), event.join(".")).toBe(true);
    }
  });
});

describe("a client that never reads its replies cannot make the broker buffer forever", () => {
  it("is cut off once its unread backlog passes the cap, and the broker survives", async () => {
    withEnv({ ZCODE_ACP_ZSERVER_MAX_CLIENT_WRITE_QUEUE: "2048" });
    const socketPath = path.join(
      os.tmpdir(),
      `zhard-wq-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    cleanups.push(() => fs.rmSync(socketPath, { force: true }));
    const broker = new ZServerBroker(socketPath, makeRoot());
    await broker.start();
    cleanups.push(() => broker.stop());

    // A raw client that PAUSES its socket: the kernel buffers fill, then Node's
    // writable queue grows with every reply the broker sends it.
    const { connect } = await import("node:net");
    const { encodeFrame, encodeMessage } = await import("../src/backend/zserver/protocol.js");
    const stuck = connect(socketPath);
    await new Promise<void>((resolve) => stuck.once("connect", resolve));
    stuck.on("error", () => undefined);
    let closed = false;
    stuck.on("close", () => (closed = true));
    stuck.pause();
    // Shrink what the kernel will absorb so the backlog reaches Node quickly.
    (stuck as unknown as { setRecvBufferSize?: (n: number) => void }).setRecvBufferSize?.(1024);

    const noisy = encodeFrame(encodeMessage([100, 1, "credential", "load"], undefined));
    const deadline = Date.now() + 8000;
    while (!closed && Date.now() < deadline) {
      for (let i = 0; i < 200 && !stuck.destroyed; i++) stuck.write(noisy);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(closed).toBe(true);
    expect(await until(() => broker.stats().clients === 0)).toBe(true);

    // The broker is unaffected: a fresh client still gets served.
    const ok = await ZServerConnection.attach({ socketPath, clientId: "after-stuck" });
    cleanups.push(() => ok.dispose());
    await expect(ok.channelOf("zcode-task").call("listTasks")).resolves.toBeDefined();
  }, 30000);

  it("also bounds FORWARDED server events (a paused subscriber must not grow the broker)", async () => {
    // Realistic volume: conversation frames carry text. 40 x ~60KB comfortably
    // exceeds what the kernel absorbs for a peer that stopped reading.
    withEnv({
      ZCODE_ACP_ZSERVER_MAX_CLIENT_WRITE_QUEUE: "65536",
      // Generated inside the fixture: 40 x 60KB frames, far past what the kernel
      // absorbs for a peer that stopped reading. (As an env var this would be
      // ~2.4MB and fail exec with E2BIG — the server would never start.)
      ZSERVER_FAKE_BIG_FRAMES: "40:60000",
    });
    const socketPath = path.join(
      os.tmpdir(),
      `zhard-wq2-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    cleanups.push(() => fs.rmSync(socketPath, { force: true }));
    const broker = new ZServerBroker(socketPath, makeRoot());
    await broker.start();
    cleanups.push(() => broker.stop());

    const { connect } = await import("node:net");
    const { encodeFrame, encodeMessage } = await import("../src/backend/zserver/protocol.js");
    const sub = connect(socketPath);
    await new Promise<void>((resolve) => sub.once("connect", resolve));
    sub.on("error", () => undefined);
    cleanups.push(() => sub.destroy());
    sub.pause(); // stuck from the start; it never reads a byte
    sub.write(
      encodeFrame(
        encodeMessage([102, 1, "zcode-agent", "onDynamicConversationFrame"], {
          workspacePath: "/w",
          sessionId: "x",
        }),
      ),
    );

    // The shared server must really be running (a failed spawn also drops clients).
    expect(await until(() => broker.stats().sharedServerPid !== null, 5000)).toBe(true);
    // Observe the BROKER's view (a paused raw socket may never emit 'close').
    expect(await until(() => broker.stats().clients === 1, 3000)).toBe(true);
    expect(await until(() => broker.stats().clients === 0, 15000)).toBe(true);
  }, 40000);
});

describe("V4 subscription keys are injective for client-controlled strings", () => {
  // A NUL survives the wire. With a bare NUL separator, (workspace "a\0b", session
  // "c") and (workspace "a", session "b\0c") shared one key, so client B could hold
  // — and by leaving, release — client A's subscription.
  it("two different (workspace, session) pairs never share a subscription: B leaving does not release A's", async () => {
    const socketPath = path.join(
      os.tmpdir(),
      `zhard-key-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    cleanups.push(() => fs.rmSync(socketPath, { force: true }));
    const broker = new ZServerBroker(socketPath, makeRoot());
    await broker.start();
    cleanups.push(() => broker.stop());
    const unsubLines = (): string[] =>
      (
        (
          broker as unknown as { connection: { stderrSnapshot(): string[] } | null }
        ).connection?.stderrSnapshot() ?? []
      ).filter((line) => line.startsWith("ZSERVER_V4UNSUB:"));

    const a = await ZServerConnection.attach({ socketPath, clientId: "victim" });
    const b = await ZServerConnection.attach({ socketPath, clientId: "attacker" });
    const subscribe = (client: ZServerConnection, workspacePath: string, sessionId: string) =>
      client.channelOf("zcode-agent").call("subscribeConversationV4", {
        workspacePath,
        sessionId,
        clientMode: "desktop-continuous",
      });

    await subscribe(a, "a\0b", "c"); // victim's real subscription
    await subscribe(b, "a", "b\0c"); // attacker's DIFFERENT pair that used to collide

    // The attacker leaves: only ITS subscription may be released (sub-2), never the victim's.
    b.dispose();
    expect(await until(() => unsubLines().length === 1)).toBe(true);
    expect(unsubLines()).toEqual(["ZSERVER_V4UNSUB:sub-2"]);

    a.dispose();
    expect(await until(() => unsubLines().length === 2)).toBe(true);
    expect(unsubLines()).toEqual(["ZSERVER_V4UNSUB:sub-2", "ZSERVER_V4UNSUB:sub-1"]);
  }, 20000);
});

describe("a server-level error after start-up must not kill the shared broker", () => {
  // accept() failing (EMFILE/ENFILE under fd pressure) surfaces as a server 'error'.
  // start() used a `once` listener, so the first such error after start-up was
  // swallowed silently and the second was an uncaught exception: one fd-exhaustion
  // episode would take down the machine-level daemon and every attached client.
  it("survives repeated server errors, logs them, and keeps serving", async () => {
    const socketPath = path.join(
      os.tmpdir(),
      `zhard-srverr-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    cleanups.push(() => fs.rmSync(socketPath, { force: true }));
    const broker = new ZServerBroker(socketPath, makeRoot());
    await broker.start();
    cleanups.push(() => broker.stop());

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    cleanups.push(() => {
      process.off("uncaughtException", onUncaught);
    });
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    cleanups.push(() => spy.mockRestore());

    const server = (broker as unknown as { server: import("node:net").Server }).server;
    for (let i = 0; i < 3; i++) {
      server.emit("error", Object.assign(new Error(`accept failed #${i}`), { code: "EMFILE" }));
    }
    await new Promise((r) => setTimeout(r, 50));

    expect(uncaught).toEqual([]);
    expect(writes.join("")).toMatch(/server error \(EMFILE\).*accept failed #2.*still serving/);
    // ...and the broker still accepts and serves a client afterwards.
    const client = await ZServerConnection.attach({ socketPath, clientId: "after-errors" });
    cleanups.push(() => client.dispose());
    await expect(client.channelOf("zcode-task").call("listTasks")).resolves.toBeDefined();
  }, 20000);
});

describe("untrusted text never floods or forges logs and errors", () => {
  it("clipDiagnostic bounds length and collapses newlines (no forged extra log lines)", async () => {
    const { clipDiagnostic } = await import("../src/backend/zserver/connection.js");
    expect(clipDiagnostic("short")).toBe("short");
    expect(clipDiagnostic("a\nb\r\nc")).toBe("a b c");
    const clipped = clipDiagnostic("x".repeat(5000), 300);
    expect(clipped.length).toBeLessThan(340);
    expect(clipped).toContain("[+4700 chars]");
    expect(clipped).not.toMatch(/[\r\n]/);
  });

  it("a rejection reason carrying a huge, newline-laden channel name stays short and single-line", async () => {
    const { validateClientHeader } = await import("../src/backend/zserver/broker.js");
    const verdict = validateClientHeader([
      100,
      1,
      `${"x".repeat(100_000)}\n[zcode-acp] zserver-broker: shared server exited (code=0)`,
      "y\nz",
    ]);
    expect(verdict.ok).toBe(false);
    const reason = verdict.ok ? "" : verdict.reason;
    expect(reason.length).toBeLessThan(400);
    expect(reason).not.toMatch(/[\r\n]/);
    expect(reason).toMatch(/not allowed through the broker$/);
  });

  it("the broker's always-on warn for a hostile frame is one bounded line", async () => {
    const socketPath = path.join(
      os.tmpdir(),
      `zhard-log-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    cleanups.push(() => fs.rmSync(socketPath, { force: true }));
    const broker = new ZServerBroker(socketPath, makeRoot());
    await broker.start();
    cleanups.push(() => broker.stop());
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    cleanups.push(() => spy.mockRestore());

    const { connect } = await import("node:net");
    const { encodeFrame, encodeMessage } = await import("../src/backend/zserver/protocol.js");
    const raw = connect(socketPath);
    await new Promise<void>((resolve) => raw.once("connect", resolve));
    raw.on("error", () => undefined);
    cleanups.push(() => raw.destroy());
    raw.write(
      encodeFrame(
        encodeMessage([100, 5, `${"z".repeat(200_000)}\nFORGED LINE`, "call"], undefined),
      ),
    );
    expect(await until(() => writes.some((w) => w.includes("frame rejected")))).toBe(true);
    const line = writes.find((w) => w.includes("frame rejected"))!;
    expect(line.length).toBeLessThan(500);
    expect(line.trimEnd()).not.toMatch(/\n/);
    expect(writes.join("")).not.toContain("FORGED LINE");
  }, 20000);

  it("a server's huge last stderr line is clipped in the exit error the editor sees", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-hard-stderr-"));
    tempDirs.push(root);
    fs.writeFileSync(
      path.join(root, "zcode-server.cjs"),
      'console.error("E".repeat(6000) + " api_key=FAKE-NOT-A-KEY"); process.exit(3);\n',
    );
    const error = (await ZServerConnection.spawn({ serverRoot: root }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error.message).toMatch(/zcode server exited: code=3/);
    expect(error.message.length).toBeLessThan(900); // was ~6KB, repeated in every warn
    expect(error.message).toContain("chars]");
  }, 20000);
});

describe("attach refuses a socket the current user does not own", () => {
  it("passes for our own socket, is a no-op when absent, and refuses a foreign owner", async () => {
    const { assertSocketOwnedByUs } = await import("../src/backend/zserver/connection.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhard-owner-"));
    tempDirs.push(dir);
    const socketPath = path.join(dir, "b.sock");
    const broker = new ZServerBroker(socketPath, makeRoot());
    await broker.start();
    cleanups.push(() => broker.stop());

    expect(() => assertSocketOwnedByUs(socketPath)).not.toThrow(); // ours
    expect(() => assertSocketOwnedByUs(path.join(dir, "nope.sock"))).not.toThrow(); // absent

    // Pretend to be a different uid: the (our-owned) file now looks foreign.
    const realUid = process.getuid!();
    const spy = vi.spyOn(process, "getuid").mockReturnValue(realUid + 1);
    cleanups.push(() => spy.mockRestore());
    expect(() => assertSocketOwnedByUs(socketPath)).toThrow(/refusing to attach/);
    await expect(ZServerConnection.attach({ socketPath, clientId: "imposter" })).rejects.toThrow(
      /refusing to attach/,
    );
  }, 20000);
});

describe("the client and the broker read the socket variable the same way", () => {
  it("a padded ZCODE_ACP_ZSERVER_SOCKET still attaches to the broker (both sides trim)", async () => {
    const socketPath = path.join(
      os.tmpdir(),
      `zhard-trim-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    cleanups.push(() => fs.rmSync(socketPath, { force: true }));
    const broker = new ZServerBroker(socketPath, makeRoot());
    await broker.start();
    cleanups.push(() => broker.stop());
    withEnv({ ZCODE_ACP_ZSERVER_SOCKET: `  ${socketPath}  ` });
    const backend = new ZServerBackend({ serverRoot: "/nonexistent-direct-spawn-root" });
    cleanups.push(() => backend.close());
    const response = await backend.request(1, "session/list", {});
    expect(response.error).toBeUndefined();
    // Attached to the shared broker, not silently running a private server.
    expect((backend as unknown as { connection: { child: unknown } }).connection.child).toBeNull();
    expect(broker.stats().clients).toBe(1);
  }, 20000);
});

describe("a request whose connection is retired under it is classified as healable", () => {
  it("an in-flight read cut off by restart() reports the restarting marker, not a bare 'disposed'", async () => {
    const { isBackendDeadMessage } = await import("../src/backend/supervise.js");
    withEnv({ ZSERVER_FAKE_HANG_METHODS: "readSession" });
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/list", {}); // connection is up

    // Never answered by the fixture: stays in flight until the connection is retired.
    const inFlight = backend.request(
      2,
      "session/read",
      { sessionId: "sess_x", workspace: { workspacePath: "/tmp/ws-retired" } },
      30_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await backend.restart("a concurrent session's heal");

    const response = await inFlight;
    expect(response.error?.message).toMatch(/disposed/); // the underlying cause stays visible
    // A heal classifier must recognise it, or the caller fails outright instead of healing.
    expect(isBackendDeadMessage(response.error!.message)).toBe(true);
  }, 20000);

  it("a server that DIES under an in-flight request stays 'backend dead', not 'restarting'", async () => {
    const { BACKEND_RESTARTING_MARKER, isBackendDeadMessage } =
      await import("../src/backend/supervise.js");
    withEnv({ ZSERVER_FAKE_HANG_METHODS: "readSession", ZSERVER_FAKE_DIE_AFTER_MS: "900" });
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/list", {});

    // The connection is still the CURRENT one when the server exits: a death, not a retirement.
    const response = await backend.request(
      2,
      "session/read",
      { sessionId: "sess_x", workspace: { workspacePath: "/tmp/ws-died" } },
      30_000,
    );
    expect(backend.isDead).toBe(true);
    expect(isBackendDeadMessage(response.error!.message)).toBe(true);
    // Each marker means something different to the caller: "restarting" says a heal is already
    // under way, "reader exited" says the backend is gone. A death must not claim the former.
    expect(response.error!.message).toMatch(/backend reader exited \(backend dead\)/);
    expect(response.error!.message).not.toContain(BACKEND_RESTARTING_MARKER);
  }, 20000);

  it("a genuine server error that raced the retirement keeps its own message", async () => {
    const { isBackendDeadMessage, isSessionLostMessage } =
      await import("../src/backend/supervise.js");
    withEnv({ ZSERVER_FAKE_FAIL_METHODS: "readSession" });
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    await backend.request(1, "session/list", {});

    // The raw-frame tap runs synchronously right AFTER the 202 rejected the pending call and
    // BEFORE the request's continuation: restart() from here retires the connection in exactly
    // the window where the server's own error has already been delivered.
    const connection = (
      backend as unknown as {
        connection: { onRawFrame(listener: (payload: Buffer) => void): () => void };
      }
    ).connection;
    let restarted = false;
    connection.onRawFrame((payload) => {
      const header = decodeMessage(payload).header as number[];
      if (header[0] !== 202 || restarted) return;
      restarted = true;
      void backend.restart("raced the server's own answer");
    });

    const response = await backend.request(2, "session/read", {
      sessionId: "sess_x",
      workspace: { workspacePath: "/tmp/ws-raced" },
    });
    expect(restarted).toBe(true); // the race really happened, or this test proves nothing
    // The server said "scripted failure" — an answer about the session, not about the transport.
    // Relabelling it "restarting" would send a needless heal and hide what the server said.
    expect(response.error?.message).toMatch(/scripted failure: readSession/);
    expect(isBackendDeadMessage(response.error!.message)).toBe(false);
    expect(isSessionLostMessage(response.error!.message)).toBe(false);
  }, 20000);

  it("an ordinary failure on a live connection keeps its own message", async () => {
    const { isBackendDeadMessage } = await import("../src/backend/supervise.js");
    withEnv({ ZSERVER_FAKE_FAIL_METHODS: "readSession" });
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    const response = await backend.request(1, "session/read", {
      sessionId: "sess_x",
      workspace: { workspacePath: "/tmp/ws-live" },
    });
    expect(response.error?.message).toMatch(/scripted failure: readSession/);
    // A plain server-side error is not a backend death: it must not trigger a heal.
    expect(isBackendDeadMessage(response.error!.message)).toBe(false);
  }, 20000);
});

describe("a session/create that fails part-way leaves no addressing state behind", () => {
  it("createTask timing out after createSession succeeded does not record the workspace", async () => {
    withEnv({ ZSERVER_FAKE_HANG_METHODS: "createTask" });
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    const response = await backend.request(
      1,
      "session/create",
      { workspace: { workspacePath: "/tmp/ws-partial" } },
      300,
    );
    expect(response.error?.message).toBe("timeout");
    const internals = backend as unknown as BackendInternals;
    // The caller never received the session id, so nothing can ever address it.
    expect(internals.workspaceBySession.size).toBe(0);
    expect(internals.subscribedSessions.size).toBe(0);
  }, 20000);

  it("a create that completes still records the workspace and subscribes", async () => {
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    const response = await backend.request(1, "session/create", {
      workspace: { workspacePath: "/tmp/ws-complete" },
    });
    expect(response.error).toBeUndefined();
    const internals = backend as unknown as BackendInternals;
    expect(internals.workspaceBySession.get("sess_fake_1")).toBe("/tmp/ws-complete");
    expect(internals.subscribedSessions.has("sess_fake_1")).toBe(true);
  }, 20000);
});

describe("removing a stale socket never removes a live one that replaced it", () => {
  interface StatInit {
    ino?: number;
    dev?: number;
    birth?: bigint;
    ctime?: bigint;
    socket?: boolean;
  }
  const socketStat = ({
    ino = 11,
    dev = 1,
    birth = 1000n,
    ctime = 1000n,
    socket = true,
  }: StatInit = {}): fs.BigIntStats =>
    ({
      isSocket: () => socket,
      ino: BigInt(ino),
      dev: BigInt(dev),
      birthtimeNs: birth,
      ctimeNs: ctime,
    }) as unknown as fs.BigIntStats;
  function fakeFs(current: fs.BigIntStats | Error, unlinkError?: NodeJS.ErrnoException) {
    const unlinked: string[] = [];
    return {
      unlinked,
      io: {
        lstat: (): fs.BigIntStats => {
          if (current instanceof Error) throw current;
          return current;
        },
        unlink: (socketPath: string): void => {
          if (unlinkError) throw unlinkError;
          unlinked.push(socketPath);
        },
      },
    };
  }
  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: simulated`), { code });

  it("removes the very socket that was probed as dead", () => {
    const { io, unlinked } = fakeFs(socketStat());
    expect(removeStaleSocket("/s", socketStat(), io)).toBe("removed");
    expect(unlinked).toEqual(["/s"]);
  });

  it("leaves a different socket alone: another broker won the race and bound its own", () => {
    const { io, unlinked } = fakeFs(socketStat({ ino: 99, birth: 2000n, ctime: 2000n }));
    expect(removeStaleSocket("/s", socketStat(), io)).toBe("replaced");
    expect(unlinked).toEqual([]); // unlinking by name here is what deleted the live broker's socket
  });

  it("a replacement that REUSED the dead socket's inode number is still a different socket", () => {
    // The real failure: the dead socket's inode number was free again and the winner's fresh
    // socket took it (seen in an strace of a failing run on XFS). Same dev + same ino, later
    // birth time.
    const { io, unlinked } = fakeFs(socketStat({ birth: 2000n, ctime: 2000n }));
    expect(removeStaleSocket("/s", socketStat(), io)).toBe("replaced");
    expect(unlinked).toEqual([]);
  });

  it("with no birth time reported, a changed ctime still tells the two apart", () => {
    const { io, unlinked } = fakeFs(socketStat({ birth: 0n, ctime: 2000n }));
    expect(removeStaleSocket("/s", socketStat({ birth: 0n }), io)).toBe("replaced");
    expect(unlinked).toEqual([]);
  });

  it("treats a same-inode socket on ANOTHER device as a different socket", () => {
    const { io, unlinked } = fakeFs(socketStat({ dev: 2 }));
    expect(removeStaleSocket("/s", socketStat({ dev: 1 }), io)).toBe("replaced");
    expect(unlinked).toEqual([]);
  });

  it("a socket already removed by the winner is 'gone', not an error", () => {
    expect(removeStaleSocket("/s", socketStat(), fakeFs(errno("ENOENT")).io)).toBe("gone");
  });

  it("an ENOENT from the unlink itself (removed between look and remove) is 'gone' too", () => {
    const { io } = fakeFs(socketStat(), errno("ENOENT"));
    expect(removeStaleSocket("/s", socketStat(), io)).toBe("gone");
  });

  it("any other unlink failure is surfaced, not swallowed", () => {
    const { io } = fakeFs(socketStat(), errno("EACCES"));
    expect(() => removeStaleSocket("/s", socketStat(), io)).toThrow(/EACCES/);
  });

  it("refuses to remove something that is no longer a socket (a file dropped in its place)", () => {
    const { io, unlinked } = fakeFs(socketStat({ socket: false }));
    expect(() => removeStaleSocket("/s", socketStat(), io)).toThrow(/not a socket/);
    expect(unlinked).toEqual([]);
  });
});

describe("two brokers starting on the same stale socket", () => {
  async function probeLive(socketPath: string): Promise<boolean> {
    const { connect } = await import("node:net");
    return new Promise((resolve) => {
      const c = connect(socketPath);
      c.once("connect", () => {
        c.destroy();
        resolve(true);
      });
      c.once("error", () => resolve(false));
    });
  }

  it("exactly one wins, the loser says so, and stopping the loser leaves the winner reachable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhard-race-"));
    tempDirs.push(dir);
    const target = path.join(dir, "b.sock");
    // A leftover socket from a process killed without cleanup.
    const { spawn } = await import("node:child_process");
    const dying = spawn(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer().listen(process.argv[1], () => console.log('bound'));" +
          "setInterval(() => {}, 1000);",
        target,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve) => dying.stdout!.once("data", () => resolve()));
    dying.kill("SIGKILL");
    await new Promise<void>((resolve) => dying.once("exit", () => resolve()));
    expect(await probeLive(target)).toBe(false);

    // Both look at the stale file and probe it before either has removed it.
    const a = new ZServerBroker(target, makeRoot());
    const b = new ZServerBroker(target, makeRoot());
    cleanups.push(() => a.stop());
    cleanups.push(() => b.stop());
    const [ra, rb] = await Promise.allSettled([a.start(), b.start()]);

    const winners = [ra, rb].filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1); // two "ready" brokers, the first unreachable, was the bug
    const loserResult = [ra, rb].find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(loserResult.reason?.message)).toMatch(/already listening/);
    expect(await probeLive(target)).toBe(true);

    const loser = ra.status === "rejected" ? a : b;
    await loser.stop();
    expect(await probeLive(target)).toBe(true); // Node's close() unlinks by name: must not hit the winner
  }, 20000);

  it("a broker that loses the BIND race (cross-process interleaving) says so and cannot remove the winner's socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhard-bindrace-"));
    tempDirs.push(dir);
    const target = path.join(dir, "b.sock");
    const winner = new ZServerBroker(target, makeRoot());
    await winner.start();
    cleanups.push(() => winner.stop());
    expect(await probeLive(target)).toBe(true);

    // Two processes both saw the stale file; the winner removed it and bound before the loser's
    // own removal, which then found nothing to remove ("gone") and went on to bind. In one
    // process that interleaving cannot happen (look, remove and bind are synchronous), so the
    // loser's first look at the path is made to miss what the winner already bound.
    const realLstat = fs.lstatSync.bind(fs);
    let hidden = false;
    const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((
      p: fs.PathLike,
      options?: object,
    ) => {
      if (!hidden && p === target) {
        hidden = true;
        throw Object.assign(new Error("ENOENT: simulated"), { code: "ENOENT" });
      }
      return realLstat(p, options as never);
    }) as typeof fs.lstatSync);
    cleanups.push(() => spy.mockRestore());

    const loser = new ZServerBroker(target, makeRoot());
    // A bare "listen EADDRINUSE" tells the operator nothing about a broker already running.
    await expect(loser.start()).rejects.toThrow(/already listening/);
    expect(hidden).toBe(true); // the race really was simulated, or this test proves nothing
    spy.mockRestore();

    // Stopping the loser must not touch the path: Node's close() unlinks by name, and a
    // listener that never bound would take the winner's socket file with it.
    await loser.stop();
    expect(fs.lstatSync(target).isSocket()).toBe(true);
    expect(await probeLive(target)).toBe(true);
  }, 20000);
});

describe("releasing a session silences its armed completion gate", () => {
  interface GateInternals {
    gatesBySession: Map<string, { pendingOutcome: string | null }>;
  }

  /** A session whose terminal outcome has arrived: the gate is armed and will emit
   *  `turn.completed` once the quiet period passes, unless something disposes it first. */
  async function armedSession(): Promise<{ backend: ZServerBackend; events: string[] }> {
    withEnv({
      ZSERVER_FAKE_TERMINAL: JSON.stringify({ outcome: "success" }),
      ZCODE_ACP_ZSERVER_TURN_QUIESCE_MS: "500",
    });
    const backend = new ZServerBackend({ serverRoot: makeRoot() });
    cleanups.push(() => backend.close());
    const events: string[] = [];
    backend.registerEventListener("sess_fake_1", {
      handleEvent: (event) => {
        events.push(event.type);
      },
    });
    await backend.request(1, "session/create", { workspace: { workspacePath: "/tmp/ws-gate" } });
    const gates = (backend as unknown as GateInternals).gatesBySession;
    // The fixture fires the terminal outcome ~200ms after the listener attaches.
    expect(await until(() => gates.get("sess_fake_1")?.pendingOutcome === "success", 3000)).toBe(
      true,
    );
    return { backend, events };
  }

  it("control: left alone, an armed gate completes the turn after the quiet period", async () => {
    const { events } = await armedSession();
    expect(await until(() => events.includes("turn.completed"), 3000)).toBe(true);
  }, 20000);

  it("releaseSession while the gate is armed: no turn.completed is delivered afterwards", async () => {
    const { backend, events } = await armedSession();
    backend.releaseSession("sess_fake_1");
    // Past the 500ms quiet period: a gate left armed would have fired by now.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(events).not.toContain("turn.completed");
  }, 20000);
});
