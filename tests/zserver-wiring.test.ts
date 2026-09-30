import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROKER_ALLOWED_CALLS,
  BROKER_ALLOWED_EVENTS,
  validateClientHeader,
  ZServerBroker,
} from "../src/backend/zserver/broker.js";
import { TurnCompletionGate, ZServerBackend } from "../src/backend/zserver/backend.js";
import {
  ChannelClient,
  decodeMessage,
  encodeFrame,
  encodeMessage,
  FrameDecoder,
  ZServerConnection,
} from "../src/backend/zserver/index.js";

/**
 * Mutation-killer tests. Every test carries the id of the mutant it kills in
 * its title. They are self-contained: the recording server is the existing
 * fixture with two injected lines (asserted to apply exactly once), so no
 * fixture edit is required to drop this file in.
 */

// The polling helpers below wait up to 8s; the default 5s test timeout would turn every
// regression into an opaque "Test timed out" instead of the assertion that names the bug.
vi.setConfig({ testTimeout: 20_000 });

const FIXTURE = new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname;
const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];

beforeEach(() => {
  // Hermetic: an ambient ZCODE_ACP_ZSERVER_* value in the developer's shell must never change
  // what these tests exercise (an ambient broker socket would attach to the REAL broker).
  for (const name of [
    "ZCODE_ACP_ZSERVER_SOCKET",
    "ZCODE_ACP_ZSERVER_IDLE_MS",
    "ZCODE_ACP_ZSERVER_TURN_QUIESCE_MS",
    "ZCODE_ACP_ZSERVER_KILL_ESCALATION_MS",
    "ZCODE_ACP_ZSERVER_MAX_CLIENT_BUFFER",
    "ZCODE_ACP_ZSERVER_MAX_PENDING",
    "ZCODE_ACP_ZSERVER_MAX_CLIENT_WRITE_QUEUE",
    "ZCODE_ACP_ZSERVER_BROKER_IDLE_EXIT_MS",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
  vi.unstubAllEnvs(); // exception-safe restore of every stubbed env var
});

// ---------------------------------------------------------------------------
// Recording server: the fixture + "append every decoded request to a JSONL file".
// ---------------------------------------------------------------------------
const RECORD_STARTUP =
  'if (process.env.ZSERVER_FAKE_RECORD_FILE) require("node:fs").appendFileSync(' +
  "process.env.ZSERVER_FAKE_RECORD_FILE, JSON.stringify({ pid: process.pid, startup: true, " +
  'envKeys: Object.keys(process.env) }) + "\\n");\n';
const RECORD_FRAME =
  '\n  if (process.env.ZSERVER_FAKE_RECORD_FILE) require("node:fs").appendFileSync(' +
  "process.env.ZSERVER_FAKE_RECORD_FILE, JSON.stringify({ pid: process.pid, header, body }) + " +
  '"\\n");';
function replaceOnce(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) {
    throw new Error(`fixture drifted: anchor not found exactly once: ${anchor.slice(0, 50)}`);
  }
  return source.replace(anchor, () => replacement);
}

function stage(): { dir: string; root: string; rec: string; sock: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zk-")); // unique per call: no Date.now() collisions
  tempDirs.push(dir);
  const root = path.join(dir, "srv");
  fs.mkdirSync(root);
  let src = fs.readFileSync(FIXTURE, "utf8");
  src = replaceOnce(
    src,
    "const { header, body } = decMsg(payload);",
    `const { header, body } = decMsg(payload);${RECORD_FRAME}`,
  );
  src = replaceOnce(
    src,
    'process.stdout.write("Connecting to ssh.example.test...\\n");',
    `${RECORD_STARTUP}process.stdout.write("Connecting to ssh.example.test...\\n");`,
  );
  fs.writeFileSync(path.join(root, "zcode-server.cjs"), src);
  return { dir, root, rec: path.join(dir, "rec.jsonl"), sock: path.join(dir, "b.sock") };
}

interface Rec {
  pid: number;
  startup?: boolean;
  envKeys?: string[];
  header?: unknown[];
  body?: unknown;
}

function readRecs(file: string): Rec[] {
  if (!fs.existsSync(file)) return [];
  const out: Rec[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Rec);
    } catch {
      /* partially written trailing line */
    }
  }
  return out;
}

const frames = (file: string): Rec[] => readRecs(file).filter((r) => Array.isArray(r.header));
const callsOf = (file: string) =>
  frames(file)
    .filter((r) => r.header![0] === 100)
    .map((r) => ({
      channel: r.header![2] as string,
      method: r.header![3] as string,
      arg: (r.body as unknown[] | undefined)?.[0],
    }));
const listensOf = (file: string) =>
  frames(file)
    .filter((r) => r.header![0] === 102)
    .map((r) => ({ pid: r.pid, id: r.header![1] as number, event: r.header![3] as string }));
const disposesOf = (file: string) =>
  frames(file)
    .filter((r) => r.header![0] === 103)
    .map((r) => ({ pid: r.pid, id: r.header![1] as number }));
const startupPids = (file: string): number[] =>
  readRecs(file)
    .filter((r) => r.startup)
    .map((r) => r.pid);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

const WS = "/tmp/ws-killers";

// ---------------------------------------------------------------------------
// Group A — the survivors from the requested M1..M20 list
// ---------------------------------------------------------------------------
describe("group A: survivors of the requested list", () => {
  it("[M2] over-long header is rejected by the BOUND check (diagnostic pinned; cosmetic)", () => {
    // M2 (`> 4` -> `> 8`) is verdict-equivalent: the later length===2 / length!==4
    // branches reject 5..8 anyway. Only the diagnostic differs, so this pins the text.
    expect(validateClientHeader([100, 1, "zcode-agent", "createSession", "extra"])).toEqual({
      ok: false,
      reason: "header must be an array of 2..4 elements",
    });
  });

  it("[M15] a failed conversation subscribe sends EventDispose for every listener it armed", async () => {
    const { root, rec } = stage();
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    vi.stubEnv("ZSERVER_FAKE_FAIL_METHODS", "subscribeConversationV4");
    const backend = new ZServerBackend({ serverRoot: root });
    try {
      await backend.request(1, "session/create", { workspace: { workspacePath: WS } });
      // 3 listeners are armed by the subscribe attempt itself (terminal outcome, session
      // events, conversation frames) before the subscribe RPC; it fails; the rollback must
      // dispose all 3. The id-0 runtime-preferences responder is armed by spawn() and is
      // legitimately NOT part of the rollback, so it is excluded from the expected set.
      expect(await until(() => disposesOf(rec).length >= 3)).toBe(true);
      const armed = listensOf(rec)
        .filter((l) => l.event !== "onDynamicSessionRuntimePreferencesRequest")
        .map((l) => l.id)
        .sort((a, b) => a - b);
      const disposed = disposesOf(rec)
        .map((d) => d.id)
        .sort((a, b) => a - b);
      expect(armed).toHaveLength(3);
      expect(disposed).toEqual(armed);
    } finally {
      await backend.close();
    }
  });

  it("[M18] a disposed gate ignores a terminal outcome that arrives AFTER dispose", () => {
    vi.useFakeTimers();
    try {
      const outcomes: string[] = [];
      const gate = new TurnCompletionGate((o) => outcomes.push(o), 300);
      gate.dispose(); // heal/re-subscribe replaced this gate
      gate.onTerminalOutcome("succeeded"); // late event from the retired connection
      vi.advanceTimersByTime(1000);
      expect(outcomes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[M19] cancel() sends PromiseCancel and settles the pending call with Cancelled", async () => {
    const sent: Array<{ header: unknown[] }> = [];
    const client = new ChannelClient((payload) => {
      sent.push(decodeMessage(payload) as { header: unknown[] });
    });
    client.onMessage({ header: [200], body: undefined }); // Initialize
    const pending = client.call("zcode-agent", "slow");
    const id = sent[0]!.header[1] as number;
    client.cancel(id);
    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        (error: Error) => error.name,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 300)),
    ]);
    expect(outcome).toBe("Cancelled");
    expect(sent.map((m) => m.header[0])).toEqual([100, 101]);
    expect(sent[1]!.header[1]).toBe(id);
    // a late response for the cancelled id must be ignored, not throw
    expect(() => client.onMessage({ header: [201, id], body: "late" })).not.toThrow();
  });

  it("[M20b] a ZERO-length non-Regular frame (bare KeepAlive header) is swallowed, not delivered", () => {
    const delivered: Buffer[] = [];
    const decoder = new FrameDecoder((p) => delivered.push(p));
    const keepAlive = Buffer.alloc(13); // type 9, length 0
    keepAlive.writeUInt8(9, 0);
    decoder.push(Buffer.concat([keepAlive, encodeFrame(encodeMessage([201, 1], "ok"))]));
    expect(delivered).toHaveLength(1);
    expect(decodeMessage(delivered[0]!).header).toEqual([201, 1]);
  });
});

// ---------------------------------------------------------------------------
// Group B — broker security wiring
// ---------------------------------------------------------------------------
describe("group B: broker security", () => {
  it("[X7,X15,X16] the allowlist is EXACTLY this literal surface (a widening/narrowing must be deliberate)", () => {
    const sorted = (table: Readonly<Record<string, ReadonlySet<string>>>) =>
      Object.fromEntries(Object.entries(table).map(([k, v]) => [k, [...v].sort()]));
    expect(sorted(BROKER_ALLOWED_CALLS)).toEqual({
      "zcode-agent": [
        "createSession",
        "readSession",
        "sendPrompt",
        "subscribeConversationV4",
        "unsubscribeConversationV4",
      ],
      // No closeTask: the server binds no task to its creator (cross-client close).
      "zcode-task": ["createTask", "listTasks", "stopGeneration"],
    });
    expect(sorted(BROKER_ALLOWED_EVENTS)).toEqual({
      // No prefs-request event: only the broker's own connection listens for it.
      "zcode-agent": ["onDynamicConversationFrame", "onDynamicSessionEvent"],
      "zcode-task": ["onDynamicTaskTerminalOutcome"],
    });
  });

  it("[M6] client-routed ids never collide with the broker's OWN request ids on the shared wire", async () => {
    // The broker's own ChannelClient (runtime-preferences listen + respond) allocates
    // from 0 on the same connection the clients are multiplexed onto. If routed ids
    // started low, a client request and the broker's own respond call would carry the
    // SAME id: the server's answer to one would resolve the other.
    const { root, rec, sock } = stage();
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    vi.stubEnv("ZSERVER_FAKE_PREFS", "1"); // the server asks for runtime preferences once
    const broker = new ZServerBroker(sock, root);
    await broker.start();
    const client = await ZServerConnection.attach({ socketPath: sock, clientId: "collider" });
    try {
      await client.channelOf("zcode-task").call("listTasks");
      // Wait for the broker's OWN answer to reach the server.
      expect(
        await until(() =>
          callsOf(rec).some((c) => c.method === "respondSessionRuntimePreferences"),
        ),
      ).toBe(true);

      const brokerOwn = (header: unknown[]): boolean =>
        header[2] === "zcode-agent" &&
        (header[3] === "respondSessionRuntimePreferences" ||
          header[3] === "onDynamicSessionRuntimePreferencesRequest");
      const own = frames(rec).filter((r) => brokerOwn(r.header!));
      const routed = frames(rec).filter((r) => !brokerOwn(r.header!));
      const idOf = (r: Rec): number => r.header![1] as number;

      expect(own.length).toBeGreaterThanOrEqual(2); // the listen AND the respond call
      expect(routed.length).toBeGreaterThan(0);
      const ownIds = new Set(own.map(idOf));
      expect(routed.filter((r) => ownIds.has(idOf(r)))).toEqual([]);
    } finally {
      client.dispose();
      await broker.stop();
    }
  });

  it("[X22] a rejected client frame is ANSWERED with a readable error and never forwarded to the shared server", async () => {
    const { root, rec, sock } = stage();
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    const broker = new ZServerBroker(sock, root);
    await broker.start();
    const legit = await ZServerConnection.attach({ socketPath: sock, clientId: "legit" });
    try {
      // Non-vacuity: the recorder does see frames the broker forwards.
      await legit.channelOf("zcode-task").call("listTasks");
      expect(callsOf(rec).map((c) => c.method)).toContain("listTasks");

      // A second, hostile client sends a forbidden call and reads the reply.
      const raw = connect(sock);
      await new Promise<void>((resolve, reject) => {
        raw.once("connect", resolve);
        raw.once("error", reject);
      });
      const replies: Array<{ header: unknown[]; body: unknown }> = [];
      const decoder = new FrameDecoder((payload) => {
        const message = decodeMessage(payload);
        replies.push({ header: message.header as unknown[], body: message.body });
      });
      raw.on("data", (chunk: Buffer) => decoder.push(chunk));
      raw.write(encodeFrame(encodeMessage([100, 7, "credential", "load"], ["placeholder"])));
      expect(await until(() => replies.some((r) => r.header[0] === 202))).toBe(true);
      const reply = replies.find((r) => r.header[0] === 202)!;
      expect(reply.header[1]).toBe(7);
      expect((reply.body as { message: string }).message).toMatch(/credential\.load.*not allowed/);

      // Ordering barrier: the server handles stdin sequentially, so once this echo
      // returns, anything the broker forwarded earlier has already been recorded.
      await legit.channelOf("zcode-task").call("listTasks");
      expect(callsOf(rec).filter((c) => c.channel === "credential")).toEqual([]);
      raw.destroy();
    } finally {
      legit.dispose();
      await broker.stop();
    }
  });

  it("[X22b] a malformed frame with no answerable id is disconnected and never forwarded", async () => {
    // A header the validator rejects WITHOUT an id to reply to (string/negative/
    // fractional id, response-type) is cut off. If the handler fell through after
    // destroy(), `[100,"x","credential","load"]` would skip id rewriting (its id is
    // not a number) and reach the shared server verbatim.
    const { root, rec, sock } = stage();
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    const broker = new ZServerBroker(sock, root);
    await broker.start();
    const legit = await ZServerConnection.attach({ socketPath: sock, clientId: "legit" });
    try {
      await legit.channelOf("zcode-task").call("listTasks"); // non-vacuity: recorder works
      expect(callsOf(rec).map((c) => c.method)).toContain("listTasks");

      const hostile: unknown[][] = [
        [100, "not-a-number", "credential", "load"],
        [100, -1, "credential", "load"],
        [100, 1.5, "credential", "load"],
        [200, 1],
      ];
      for (const header of hostile) {
        const raw = connect(sock);
        await new Promise<void>((resolve, reject) => {
          raw.once("connect", resolve);
          raw.once("error", reject);
        });
        raw.resume(); // an unread socket never emits 'close'
        const closed = new Promise<void>((resolve) => raw.once("close", () => resolve()));
        raw.write(encodeFrame(encodeMessage(header, ["placeholder"])));
        await Promise.race([
          closed,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`not disconnected: ${JSON.stringify(header)}`)),
              8000,
            ),
          ),
        ]);
      }
      // Ordering barrier: the server reads stdin sequentially, and any (wrongly)
      // forwarded frame was written before its client's close was observed.
      await legit.channelOf("zcode-task").call("listTasks");
      expect(callsOf(rec).filter((c) => c.channel === "credential")).toEqual([]);
      expect(frames(rec).filter((r) => r.header![0] === 200)).toEqual([]);
    } finally {
      legit.dispose();
      await broker.stop();
    }
  });

  it("[X6,X11] the shared server never inherits task-scoped credentials from the broker's env", async () => {
    const { root, rec, sock } = stage();
    const scoped = [
      "MULTICA_AUDIT_SENTINEL",
      "SSH_AUTH_SOCK",
      "SSH_AGENT_PID",
      "SSH_CONNECTION",
      "SSH_CLIENT",
    ];
    for (const name of scoped) vi.stubEnv(name, "audit-placeholder");
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    const broker = new ZServerBroker(sock, root);
    await broker.start();
    const client = await ZServerConnection.attach({ socketPath: sock, clientId: "env-probe" });
    try {
      expect(await until(() => startupPids(rec).length > 0)).toBe(true);
      const keys = readRecs(rec).find((r) => r.startup)!.envKeys!;
      expect(keys).toContain("ZSERVER_FAKE_RECORD_FILE"); // non-vacuity: env does flow through
      expect(keys.filter((k) => scoped.includes(k))).toEqual([]);
    } finally {
      client.dispose();
      await broker.stop();
    }
  });

  it("[X8] a second broker refuses to evict a LIVE broker's socket", async () => {
    const { root, sock } = stage();
    const first = new ZServerBroker(sock, root);
    await first.start();
    const second = new ZServerBroker(sock, root);
    try {
      await expect(second.start()).rejects.toThrow(/already listening/);
      const client = await ZServerConnection.attach({ socketPath: sock, clientId: "still-served" });
      try {
        await expect(client.channelOf("zcode-task").call("listTasks")).resolves.toBe(
          "echo:listTasks:[]",
        );
      } finally {
        client.dispose();
      }
    } finally {
      await second.stop();
      await first.stop();
    }
  });

  it("[X12] start() replaces a STALE socket inode left behind by a crashed broker", async () => {
    const { root, sock } = stage();
    const crashed = spawn(
      process.execPath,
      [
        "-e",
        "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('bound\\n'))",
        sock,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    cleanups.push(() => crashed.kill("SIGKILL"));
    await new Promise<void>((resolve) => crashed.stdout!.once("data", () => resolve()));
    crashed.kill("SIGKILL");
    await new Promise((resolve) => crashed.once("exit", resolve));
    expect(fs.existsSync(sock)).toBe(true); // the stale socket inode really is there
    const broker = new ZServerBroker(sock, root);
    try {
      await broker.start();
      const client = await ZServerConnection.attach({ socketPath: sock, clientId: "after-crash" });
      client.dispose();
    } finally {
      await broker.stop();
    }
  });

  it("[X24] broker.stop() takes the shared zcode-server down with it (no orphan)", async () => {
    const { root, rec, sock } = stage();
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    const broker = new ZServerBroker(sock, root);
    await broker.start();
    const client = await ZServerConnection.attach({ socketPath: sock, clientId: "orphan-probe" });
    expect(await until(() => startupPids(rec).length > 0)).toBe(true);
    const pid = startupPids(rec)[0]!;
    cleanups.push(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    });
    expect(alive(pid)).toBe(true);
    client.dispose();
    await broker.stop();
    expect(await until(() => !alive(pid), 8000)).toBe(true);
  });

  it("[X26] a socket 'error' on an attached client is handled, never thrown (broker must not crash)", async () => {
    const { root, sock } = stage();
    const broker = new ZServerBroker(sock, root);
    const fake = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() {
        this.destroyed = true;
        return this;
      },
      write() {
        return true;
      },
    });
    try {
      (broker as unknown as { onClient(socket: unknown): void }).onClient(fake);
      expect(() => fake.emit("error", new Error("ECONNRESET"))).not.toThrow();
      expect(fake.destroyed).toBe(true);
    } finally {
      await broker.stop(); // onClient() lazily spawned the shared server: reap it
    }
  });
});

// ---------------------------------------------------------------------------
// Group C — backend wiring: what actually goes over the wire
// ---------------------------------------------------------------------------
describe("group C: backend wiring", () => {
  it("[X14,X17,X19,X13] create/send/stop/list send the right RPCs with the right arguments", async () => {
    const { root, rec } = stage();
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    vi.stubEnv(
      "ZSERVER_FAKE_TASKS",
      JSON.stringify([{ taskId: "t-1", workspacePath: "/w1", title: "First" }]),
    );
    const backend = new ZServerBackend({ serverRoot: root });
    try {
      const created = await backend.request(1, "session/create", {
        workspace: { workspacePath: WS },
        mode: "yolo",
      });
      expect(created.error).toBeUndefined();
      expect(
        (
          await backend.request(2, "session/send", {
            sessionId: "sess_fake_1",
            content: "hello world",
          })
        ).error,
      ).toBeUndefined();
      expect(
        (await backend.request(3, "session/stop", { sessionId: "sess_fake_1" })).error,
      ).toBeUndefined();
      const listed = await backend.request(4, "session/list", {});
      expect((listed.result as { sessions: unknown[] }).sessions).toEqual([
        { sessionId: "t-1", workspace: { workspacePath: "/w1" }, title: "First" },
      ]);

      const calls = callsOf(rec);
      const arg = (method: string) => calls.find((c) => c.method === method)?.arg;
      expect(arg("createSession")).toMatchObject({ workspacePath: WS, mode: "yolo" });
      expect(arg("createTask")).toMatchObject({ workspacePath: WS, draftSessionId: "sess_fake_1" });
      expect(arg("sendPrompt")).toMatchObject({
        workspacePath: WS,
        sessionId: "sess_fake_1",
        content: "hello world",
      });
      expect(arg("stopGeneration")).toEqual({ taskId: "sess_fake_1", workspacePath: WS });
    } finally {
      await backend.close();
    }
  });

  it("[X3] subscribing an already-subscribed session does not stack a second set of listeners", async () => {
    const { root, rec } = stage();
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    const backend = new ZServerBackend({ serverRoot: root });
    try {
      await backend.request(1, "session/create", { workspace: { workspacePath: WS } });
      for (const id of [2, 3]) {
        await backend.request(id, "session/subscribe", {
          sessionId: "sess_fake_1",
          workspace: { workspacePath: WS },
        });
      }
      await backend.request(4, "session/list", {}); // ordering barrier through the same pipe
      const frameListens = listensOf(rec).filter((l) => l.event === "onDynamicConversationFrame");
      expect(frameListens).toHaveLength(1);
    } finally {
      await backend.close();
    }
  });

  it("[X4] after restart the session is re-subscribed on the NEW server", async () => {
    const { root, rec } = stage();
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    const backend = new ZServerBackend({ serverRoot: root });
    try {
      await backend.request(1, "session/create", { workspace: { workspacePath: WS } });
      const firstPid = startupPids(rec)[0]!;
      // The subscribe RPC must have been ANSWERED before the restart: a still-in-flight one is
      // rejected by dispose(), and its failure rollback also clears the marker, masking X4.
      expect(
        await until(() => callsOf(rec).some((c) => c.method === "subscribeConversationV4")),
      ).toBe(true);
      await backend.request(9, "session/list", {}); // ordering barrier: replies are in-order
      await backend.restart("audit");
      const resumed = await backend.request(2, "session/resume", {
        sessionId: "sess_fake_1",
        workspace: { workspacePath: WS },
      });
      expect(resumed.error).toBeUndefined();
      const reListened = await until(() =>
        listensOf(rec).some((l) => l.pid !== firstPid && l.event === "onDynamicConversationFrame"),
      );
      expect(reListened).toBe(true);
    } finally {
      await backend.close();
    }
  });

  it("[X5] close() racing an in-flight spawn discards that late connection (no assigned-after-close orphan)", async () => {
    const { root, rec } = stage();
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    const backend = new ZServerBackend({ serverRoot: root });
    try {
      const pending = backend.request(1, "session/list", {}); // spawn #1 starts synchronously
      await backend.close(); // ...and is retired while still handshaking
      const response = await pending; // the waiter must be served by a FRESH spawn
      expect(response.error).toBeUndefined();
      const pids = startupPids(rec);
      expect(pids).toHaveLength(2); // mutant: the retired connection is adopted -> only 1 server
      expect(await until(() => !alive(pids[0]!))).toBe(true); // the retired server is really gone
    } finally {
      await backend.close();
    }
  });

  it("[X9] a frame from a client that vanished while the broker awaited the server is not forwarded", async () => {
    const { root, rec, sock } = stage();
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    const broker = new ZServerBroker(sock, root);
    await broker.start(); // cold: the shared server is spawned lazily, so the await gap is ~100ms+
    try {
      const raw = connect(sock);
      await new Promise<void>((resolve, reject) => {
        raw.once("connect", resolve);
        raw.once("error", reject);
      });
      raw.write(
        encodeFrame(encodeMessage([102, 5, "zcode-agent", "onDynamicSessionEvent"], undefined)),
        () => raw.destroy(),
      );
      // A second client both waits for the server to be up and acts as an in-order barrier.
      const probe = await ZServerConnection.attach({ socketPath: sock, clientId: "barrier" });
      try {
        await probe.channelOf("zcode-task").call("listTasks");
        expect(callsOf(rec).map((c) => c.method)).toContain("listTasks"); // non-vacuity
        expect(listensOf(rec).filter((l) => l.event === "onDynamicSessionEvent")).toEqual([]);
      } finally {
        probe.dispose();
      }
    } finally {
      await broker.stop();
    }
  });

  it("[X1] bytes that follow the hello line in the SAME chunk reach the frame decoder", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zk-x1-"));
    tempDirs.push(dir);
    // Minimal server: the hello line and the Initialize frame leave in ONE write() and
    // Initialize is never re-sent after the ack. Only the "remainder after the hello line is
    // handed to the frame decoder" path can therefore complete the handshake.
    const initHex = encodeFrame(encodeMessage([200], undefined)).toString("hex");
    fs.writeFileSync(
      path.join(dir, "zcode-server.cjs"),
      [
        'const hello = JSON.stringify({ type: "zcode-hello", version: "0", platform: process.platform, arch: process.arch, pid: process.pid }) + "\\n";',
        `process.stdout.write(Buffer.concat([Buffer.from(hello), Buffer.from(${JSON.stringify(initHex)}, "hex")]));`,
        "process.stdin.resume();",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const outcome = await Promise.race([
      ZServerConnection.spawn({ serverRoot: dir }).then(
        (connection) => ({ connection }),
        (error: Error) => ({ error }),
      ),
      new Promise<{ hang: true }>((resolve) => setTimeout(() => resolve({ hang: true }), 4000)),
    ]);
    if (!("connection" in outcome)) {
      expect.fail(
        `handshake did not complete: ${"hang" in outcome ? "hang" : outcome.error.message}`,
      );
    }
    outcome.connection.dispose();
  });

  it("[X2] idle recycling never reclaims a server that still has a registered session listener", async () => {
    const { root, rec } = stage();
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    vi.stubEnv("ZCODE_ACP_ZSERVER_IDLE_MS", "100");
    const backend = new ZServerBackend({ serverRoot: root });
    const listener = { handleEvent: () => undefined };
    try {
      backend.registerEventListener("sess_live", listener);
      await backend.request(1, "session/list", {});
      const pid = startupPids(rec)[0]!;
      cleanups.push(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      });
      // Phase 1: with a live listener the server must stay up across many idle periods.
      const deadline = Date.now() + 900;
      while (Date.now() < deadline) {
        expect(alive(pid)).toBe(true);
        await new Promise((r) => setTimeout(r, 50));
      }
      // Phase 2 (control, makes phase 1 meaningful): once the listener is gone it IS recycled.
      backend.unregisterEventListener("sess_live", listener);
      expect(await until(() => !alive(pid), 8000)).toBe(true);
    } finally {
      await backend.close();
    }
  });

  it("[X15,X16] every RPC/listener the backend uses is accepted by a LIVE broker (no silent disconnect)", async () => {
    const { root, rec, sock } = stage();
    vi.stubEnv("ZSERVER_FAKE_RECORD_FILE", rec);
    const broker = new ZServerBroker(sock, root);
    await broker.start();
    vi.stubEnv("ZCODE_ACP_ZSERVER_SOCKET", sock);
    const backend = new ZServerBackend({ serverRoot: "/nonexistent-direct-spawn-root" });
    try {
      const steps: Array<[string, Record<string, unknown>]> = [
        ["session/create", { workspace: { workspacePath: WS } }],
        ["session/send", { sessionId: "sess_fake_1", content: "hi" }],
        ["session/read", { sessionId: "sess_fake_1" }],
        ["session/messages", { sessionId: "sess_fake_1" }],
        ["session/list", {}],
        ["session/stop", { sessionId: "sess_fake_1" }],
      ];
      let id = 0;
      for (const [method, params] of steps) {
        const response = await backend.request(++id, method, params);
        expect(response.error, method).toBeUndefined();
      }
      expect(backend.isDead).toBe(false);
      const methods = new Set(callsOf(rec).map((c) => c.method));
      for (const m of [
        "createSession",
        "createTask",
        "sendPrompt",
        "readSession",
        "listTasks",
        "stopGeneration",
        "subscribeConversationV4",
      ]) {
        expect(methods.has(m), `server saw ${m}`).toBe(true);
      }
      const events = new Set(listensOf(rec).map((l) => l.event));
      for (const e of [
        "onDynamicTaskTerminalOutcome",
        "onDynamicSessionEvent",
        "onDynamicConversationFrame",
      ]) {
        expect(events.has(e), `server saw listen ${e}`).toBe(true);
      }
    } finally {
      await backend.close();
      await broker.stop();
    }
  });
});
