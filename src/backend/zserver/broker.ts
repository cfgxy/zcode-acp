import fs, { chmodSync, existsSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import { log, warn } from "../../utils.js";
import {
  decodeMessage,
  encodeFrame,
  encodeMessage,
  FrameDecoder,
  replaceHeader,
} from "./protocol.js";
import { clipDiagnostic, ZServerConnection } from "./connection.js";
import { brokerBaseEnv, runtimeEnvWithProfile } from "./backend.js";
import { resolveBrokerSocketPath } from "./socket-path.js";

export { DEFAULT_BROKER_SOCKET, resolveBrokerSocketPath } from "./socket-path.js";

/** sun_path limits: 107 usable bytes on Linux, 103 on macOS/BSD. Longer paths
 *  are silently TRUNCATED by bind()/connect(), which breaks stale-socket
 *  detection (existsSync on the full path is false while the truncated file
 *  exists) and yields a misleading EADDRINUSE. Fail loudly instead. */
export function assertSocketPathFits(socketPath: string): void {
  if (process.platform === "win32") {
    throw new Error(
      "zserver-broker uses unix domain sockets and is not supported on Windows " +
        "(set ZCODE_ACP_ZSERVER_SOCKET=off: each bridge spawns its own server)",
    );
  }
  const limit = process.platform === "darwin" ? 103 : 107;
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > limit) {
    throw new Error(
      `zserver-broker socket path is ${bytes} bytes (limit ${limit}): ${socketPath} — ` +
        "set ZCODE_ACP_ZSERVER_SOCKET to a shorter path (or XDG_RUNTIME_DIR)",
    );
  }
}

/** Injectable filesystem calls for {@link removeStaleSocket} (race tests). */
export interface StaleSocketFs {
  lstat(socketPath: string): fs.BigIntStats;
  unlink(socketPath: string): void;
}

/**
 * Identity of one filesystem object. An inode NUMBER alone does not identify a
 * dead socket file: once its last link is gone the number is free and can be
 * handed to the very next file created. On XFS, with two brokers starting on one
 * stale socket, the winner's fresh socket was seen taking the stale socket's
 * inode number (strace of a failing run), and comparing numbers alone let both
 * brokers "win" in 16 of 60 fresh-process runs. The birth time tells the two
 * apart; ctime backs it up on filesystems that report none. (A stale file
 * created within the same kernel timestamp tick as its replacement would still
 * compare equal — not a real case: a stale file is one a dead process left.)
 */
function socketIdentity(stats: fs.BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}:${stats.ctimeNs}`;
}

/** What happened to a leftover socket that had been probed as dead. */
export type StaleRemoval = "removed" | "gone" | "replaced";

/**
 * Remove a leftover socket file that a probe found dead, but only if the path
 * still holds THAT socket. The probe awaits, so another broker may have removed
 * the same stale file and bound its own live socket in the meantime; unlinking by
 * name then deleted the live one and left two brokers "ready" with the first
 * unreachable. `replaced` means somebody else won — the caller must not bind.
 * A file already removed by that other broker is `gone`, not an error (a bare
 * ENOENT used to abort the loser with a message unrelated to the real cause).
 */
export function removeStaleSocket(
  socketPath: string,
  probed: fs.BigIntStats,
  io: StaleSocketFs = {
    lstat: (p) => fs.lstatSync(p, { bigint: true }),
    unlink: (p) => unlinkSync(p),
  },
): StaleRemoval {
  let current: fs.BigIntStats;
  try {
    current = io.lstat(socketPath);
  } catch {
    return "gone";
  }
  if (!current.isSocket()) {
    throw new Error(
      `zserver-broker: ${socketPath} exists and is not a socket — refusing to remove it ` +
        "(move it away or set ZCODE_ACP_ZSERVER_SOCKET to another path)",
    );
  }
  if (socketIdentity(current) !== socketIdentity(probed)) return "replaced";
  log(`zserver-broker: removing stale socket ${socketPath}`);
  try {
    io.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "gone";
  }
  return "removed";
}

/** Idle ms with no attached client before the broker exits (0 = never). */
function clientIdleExitMs(): number {
  return Number(process.env.ZCODE_ACP_ZSERVER_BROKER_IDLE_EXIT_MS ?? 0) || 0;
}
/** Per-client inbound cap: a frame claiming more than this is a hostile/misbehaving peer. */
function maxClientBufferBytes(): number {
  return Number(process.env.ZCODE_ACP_ZSERVER_MAX_CLIENT_BUFFER ?? 0) || 8 * 1024 * 1024;
}

/**
 * Broker method allowlist. A broker client speaks raw channel frames straight
 * into ONE shared, already-authenticated zcode-server whose ServiceCollection
 * exposes every service (credential.load, terminal.*, file.*, git.*, …).
 * Forwarding unrestricted frames would make any process able to reach the
 * socket a full confused-deputy of the user's credentials. Only the RPC
 * surface ZServerBackend actually uses is forwarded; everything else is
 * rejected and the offending client disconnected.
 */
export const BROKER_ALLOWED_CALLS: Readonly<Record<string, ReadonlySet<string>>> = {
  "zcode-agent": new Set([
    "createSession",
    "readSession",
    "sendPrompt",
    "subscribeConversationV4",
    "unsubscribeConversationV4",
  ]),
  // No closeTask: ZServerBackend never closes server-side tasks, and the server
  // does not bind a task to its creator — an attached client could close (mark
  // deleted) another client's session. Add it back only with an owner check.
  "zcode-task": new Set(["createTask", "listTasks", "stopGeneration"]),
};
export const BROKER_ALLOWED_EVENTS: Readonly<Record<string, ReadonlySet<string>>> = {
  // No onDynamicSessionRuntimePreferencesRequest: only the broker's OWN
  // connection listens for it (it answers, attach clients must not).
  "zcode-agent": new Set(["onDynamicConversationFrame", "onDynamicSessionEvent"]),
  "zcode-task": new Set(["onDynamicTaskTerminalOutcome"]),
};

/** umask in force while the socket file is created (=> mode 0600 at birth). */
export const BROKER_BIND_UMASK = 0o177;

/** Policy rejections LOGGED per client; further ones are counted, not logged.
 *  A well-formed rejection is answered and never disconnects the client: a
 *  disconnect reads as "server died" to it (misleading, and it arms the
 *  bridge's backend-death shutdown), while a same-uid flooder can send ALLOWED
 *  calls just as cheaply — a violation cap protected nothing and cost a
 *  legitimate client its link on allowlist drift. */
const MAX_LOGGED_VIOLATIONS_PER_CLIENT = 5;

/** Unread bytes queued to one client before it is cut off: a client that never
 *  reads its replies must not make the shared broker buffer them forever. */
function maxClientWriteQueueBytes(): number {
  return Number(process.env.ZCODE_ACP_ZSERVER_MAX_CLIENT_WRITE_QUEUE ?? 0) || 8 * 1024 * 1024;
}

/** Outstanding (un-answered calls + live subscriptions) requests allowed per
 *  client. Bounds the broker's id maps against a client that never completes. */
function maxPendingPerClient(): number {
  return Number(process.env.ZCODE_ACP_ZSERVER_MAX_PENDING ?? 0) || 4096;
}

export type HeaderVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      /** Set when the header is well-formed and only POLICY rejected it: the
       *  client can be answered (its id is known) instead of just cut off. */
      replyTo?: number;
    };

/**
 * Validate a client frame header BEFORE any forwarding/re-encoding: exact shape
 * (bounded array, numeric type in 100..103, integer id), and — for calls and
 * subscriptions — an allowlisted (channel, name). 101/103 carry only [type,id].
 */
export function validateClientHeader(header: unknown): HeaderVerdict {
  if (!Array.isArray(header) || header.length < 2 || header.length > 4) {
    return { ok: false, reason: "header must be an array of 2..4 elements" };
  }
  const [type, id, channel, name] = header as [unknown, unknown, unknown, unknown];
  if (typeof type !== "number" || !Number.isInteger(type) || type < 100 || type > 103) {
    return { ok: false, reason: `request type ${String(type)} not allowed` };
  }
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
    // Non-numeric ids bypass id rewriting: the server would keep a subscription
    // that can never be routed back nor reclaimed on disconnect.
    return { ok: false, reason: "request id must be a non-negative integer" };
  }
  if (type === 101 || type === 103) {
    return header.length === 2
      ? { ok: true }
      : { ok: false, reason: "cancel/dispose header must be [type,id]" };
  }
  if (header.length !== 4 || typeof channel !== "string" || typeof name !== "string") {
    return { ok: false, reason: "call/listen header must be [type,id,channel,name]" };
  }
  const table = type === 100 ? BROKER_ALLOWED_CALLS : BROKER_ALLOWED_EVENTS;
  // Own-property lookup: the tables are plain objects, so a bare index would
  // resolve "__proto__"/"constructor"/"toString" to inherited members and
  // `?.has` would then throw on a non-Set — killing the broker from one frame.
  const allowed = Object.hasOwn(table, channel) ? table[channel] : undefined;
  if (!allowed?.has(name)) {
    return {
      ok: false,
      reason: `${type === 100 ? "call" : "event"} ${clipDiagnostic(channel, 80)}.${clipDiagnostic(name, 80)} is not allowed through the broker`,
      replyTo: id,
    };
  }
  return { ok: true };
}

/**
 * The shared server's V4 conversation subscription for one (workspace, session).
 * The server keys ownership by (workspace, topic, CONNECTION) and every broker
 * client rides the broker's single connection, so clients on the same session
 * share ONE subscription: a newer subscribe replaces the older id, and releasing
 * it would cut every other holder off. Hence: refcounted by holder, released
 * only when the last one leaves, always with the server's CURRENT id.
 */
interface SharedSubscription {
  workspacePath: string;
  sessionId: string;
  /** The server's current subscriptionId for this (workspace, session). */
  subscriptionId: string;
  /** Broker client ids currently holding it. */
  holders: Set<number>;
}

/** A subscribeConversationV4 call forwarded to the server whose ack is pending. */
interface PendingSubscribe {
  clientId: number;
  key: string;
  workspacePath: string;
  sessionId: string;
  /** The client cancelled (101) before the ack: release it the moment it lands. */
  cancelled: boolean;
}

/**
 * Key of a (workspace, session) pair. Both parts are CLIENT-CONTROLLED strings
 * and a NUL byte survives the wire, so a separator alone is not injective
 * ("a\0b"+"c" and "a"+"b\0c" would collide, letting one client hold or release
 * another's subscription). Length-prefixing the first part makes it unambiguous.
 */
function subscriptionKey(workspacePath: string, sessionId: string): string {
  return `${workspacePath.length}:${workspacePath}\0${sessionId}`;
}

/** The (workspacePath, sessionId) of a call body `[params]`, if well-formed. */
function subscriptionParams(body: unknown): { workspacePath: string; sessionId: string } | null {
  const params = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
  if (typeof params?.workspacePath === "string" && typeof params.sessionId === "string") {
    return { workspacePath: params.workspacePath, sessionId: params.sessionId };
  }
  return null;
}

/** In-flight subscribes tracked at once (bounds memory if the server never answers). */
const MAX_TRACKED_SUBSCRIBES = 4096;

interface ClientEntry {
  /** Broker-local client number, for log correlation only. */
  id: number;
  /** Policy rejections so far (drives log throttling only). */
  violations: number;
  socket: Socket;
  /** server-side request id → client-side request id (route responses/events back). */
  idByClient: Map<number, number>;
  /** client-side request id → server-side request id (translate cancel/dispose). */
  serverIdByClient: Map<number, number>;
  /** Keys of the shared V4 subscriptions this client holds. The server owns them
   *  on the BROKER's single connection, so a client that dies without
   *  unsubscribing (kill -9) would leave them owned for the shared server's life. */
  subscriptions: Set<string>;
}

/**
 * Machine-level broker (ADR-0008): keeps ONE zcode-server.cjs channel
 * connection alive and multiplexes any number of local clients over a unix
 * socket, so N zcode-acp processes share one server instead of each spawning
 * their own.
 *
 * Protocol per client: raw channel-protocol frames. On attach the broker
 * synthesizes the Initialize frame (the real server's single Initialize is
 * swallowed). Client frames are rewritten with broker-allocated server ids
 * (the response/event id space is per-connection); server responses and event
 * fires route back to the owning client via the id map. Consequence: sessions
 * are workspace-keyed server-side, so two clients on the SAME workspace share
 * the task list — fine for a personal-machine broker, documented in the ADR.
 */
export class ZServerBroker {
  private server: Server | null = null;
  private connection: ZServerConnection | null = null;
  private spawning: Promise<void> | null = null;
  private stopped = false;
  private rejectedFrames = 0;
  /** Inode of the socket file this broker bound (null until bound). */
  private socketIno: number | null = null;
  /** In-flight subscribeConversationV4 calls by server request id. Dropped when
   *  the ack arrives, or when the shared server exits (its subscriptions die with
   *  it). A client that vanishes mid-subscribe leaves its entry until the ack
   *  lands so that subscription can still be released. */
  private readonly pendingSubscribes = new Map<number, PendingSubscribe>();
  /** Live V4 conversation subscriptions on the shared server, by session key. */
  private readonly sharedSubscriptions = new Map<string, SharedSubscription>();
  /** Test seam: invoked with the socket file's mode at the instant of creation. */
  onBoundForTest?: (mode: number) => void;
  /** Process exit used by the idle-exit path (replaceable so tests can observe it). */
  exitProcess: (code: number) => void = (code) => process.exit(code);
  private readonly clients = new Map<number, ClientEntry>();
  private nextClientId = 1;
  /** Server-side id space is broker-global: per-client counters would collide
   *  (two clients' EventListen rewriting to id 1 collapse into ONE server-side
   *  subscription, and event routing becomes first-match ambiguity). The high
   *  offset keeps routed-client ids clear of the broker's OWN ChannelClient
   *  (prefs responder + subscriptions), which allocates from 0 on the same
   *  wire — same trick as ZcodeBackend.sendIdCounter. */
  private nextServerId = 1_000_000;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly socketPath: string = resolveBrokerSocketPath(),
    private readonly serverRoot?: string,
  ) {}

  private alreadyListeningError(): Error {
    return new Error(
      `zserver-broker: something is already listening on ${this.socketPath} (a broker is already running?)`,
    );
  }

  async start(): Promise<void> {
    assertSocketPathFits(this.socketPath);
    // Node reports a missing parent directory of a unix socket as EACCES, which
    // sends an operator hunting for a permissions problem that does not exist.
    const parent = path.dirname(this.socketPath);
    if (!existsSync(parent)) {
      throw new Error(
        `zserver-broker: socket directory ${parent} does not exist (create it, or set ` +
          "ZCODE_ACP_ZSERVER_SOCKET to a path in an existing directory)",
      );
    }
    let existing: fs.BigIntStats | null = null;
    try {
      existing = fs.lstatSync(this.socketPath, { bigint: true });
    } catch {
      /* nothing at the path */
    }
    if (existing) {
      // Only ever remove a leftover SOCKET. A plain file or a symlink at this
      // path is somebody's data (or a planted link): unlinking it silently
      // destroyed the file — refuse and say so instead.
      if (!existing.isSocket()) {
        throw new Error(
          `zserver-broker: ${this.socketPath} exists and is not a socket — refusing to remove it ` +
            "(move it away or set ZCODE_ACP_ZSERVER_SOCKET to another path)",
        );
      }
      // Probe before unlinking: a live listener would accept the connection; a
      // stale socket file refuses it. Never evict a live listener's socket.
      const live = await new Promise<boolean>((resolve) => {
        const probe = connect(this.socketPath);
        probe.once("connect", () => {
          probe.destroy();
          resolve(true);
        });
        probe.once("error", () => resolve(false));
      });
      if (live) throw this.alreadyListeningError();
      // The probe awaited: another broker may have replaced the stale socket
      // with its own live one since. Only ever remove the very socket that was
      // probed as dead.
      if (removeStaleSocket(this.socketPath, existing) === "replaced") {
        throw this.alreadyListeningError();
      }
    }
    const server = createServer((socket) => this.onClient(socket));
    this.server = server;
    const listening = new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      // Start-up failures (EADDRINUSE, EACCES…) reject start().
      server.once("error", reject);
    });
    // bind() creates the socket file with 0777 & ~umask; tightening it with
    // chmod AFTER listen leaves a window (umask 000/002 → group/world
    // connectable). Bind under umask 0177 so it is 0600 from creation.
    // listen(path) performs bind() synchronously (EADDRINUSE and friends
    // arrive later as an 'error' event), so the process-global umask is
    // changed only for this synchronous call — never across an await, where
    // unrelated code in this process would create files with it.
    const previousUmask = process.umask(BROKER_BIND_UMASK);
    try {
      this.server.listen(this.socketPath);
      // Test seam: the socket file's mode at the instant of creation.
      if (this.onBoundForTest && existsSync(this.socketPath)) {
        this.onBoundForTest(fs.statSync(this.socketPath).mode & 0o777);
      }
    } finally {
      process.umask(previousUmask);
    }
    try {
      await listening;
    } catch (error) {
      // Never bound: leave no half-started listener behind for stop() to act on.
      this.server = null;
      // Losing the bind race to another broker is the same condition the probe
      // reports — say so, not a bare errno.
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw this.alreadyListeningError();
      }
      throw error;
    }
    // The start-up `once("error", reject)` listener is spent by the FIRST later
    // server error (accept failing with EMFILE/ENFILE, …), which it swallows
    // silently, and the SECOND would be an uncaught exception that kills the
    // shared daemon (and every client with it). Keep a persistent listener: a
    // failed accept is a recoverable condition for the broker, not a reason to
    // die. Attached only after a successful bind so a broker that lost the start
    // race does not claim to be "still serving".
    server.on("error", (error: NodeJS.ErrnoException) => {
      warn(
        `zserver-broker: server error (${error.code ?? "unknown"}): ${error.message} — still serving`,
      );
    });
    // Identity of the socket file WE created: stop() must only remove it while
    // the path still holds this inode (a second broker may have replaced it).
    try {
      this.socketIno = fs.lstatSync(this.socketPath).ino;
    } catch {
      this.socketIno = null;
    }
    // The broker drives a server holding credentials; a world-connectable
    // socket would hand that to any local user. Restrict to the owner.
    try {
      chmodSync(this.socketPath, 0o600);
    } catch {
      /* best-effort; XDG_RUNTIME_DIR paths are 0700 anyway */
    }
    log(`zserver-broker: listening on ${this.socketPath}`);
    this.armIdleExit();
  }

  /** Spawn (or reuse) the shared server connection. Safe to race. */
  private async ensureServer(): Promise<ZServerConnection> {
    if (this.connection) return this.connection;
    if (!this.spawning) {
      this.spawning = (async () => {
        log("zserver-broker: spawning shared zcode-server");
        const connection = await ZServerConnection.spawn({
          // Same precedence as the bridge's own spawn (server.ts): the operator's
          // ZCODE_SERVER_RUNTIME_ROOT first, then the desktop profile's pin, then
          // the default. Left to the merged env alone, the pin silently beat the
          // operator here while the bridge honoured the operator.
          serverRoot: this.serverRoot ?? process.env.ZCODE_SERVER_RUNTIME_ROOT,
          clientId: "zserver-broker",
          env: await runtimeEnvWithProfile(brokerBaseEnv(process.env)),
        });
        connection.onExit((code, signal) => {
          warn(
            `zserver-broker: shared server exited (code=${code ?? "null"} signal=${signal ?? "null"}) — detaching ${this.clients.size} client(s)`,
          );
          this.connection = null;
          this.spawning = null;
          // Server-side state (subscriptions included) died with it: there is
          // nothing left to release, and stale ids must never be replayed
          // against a respawned server. Clients must learn: destroy their
          // sockets so their heal path re-attaches and re-subscribes.
          this.pendingSubscribes.clear();
          this.sharedSubscriptions.clear();
          for (const entry of this.clients.values()) {
            entry.subscriptions.clear();
            entry.socket.destroy();
          }
          this.clients.clear();
        });
        // Swallow the server's Initialize: every client gets a synthetic one.
        connection.onRawFrame((payload) => this.routeServerPayload(payload));
        if (this.stopped) {
          connection.dispose();
          return;
        }
        this.connection = connection;
        connection.listen("onDynamicSessionRuntimePreferencesRequest", undefined, (request) => {
          const requestId = (request as { requestId?: string } | null)?.requestId;
          if (!requestId) return;
          connection
            .channelOf("zcode-agent")
            .call("respondSessionRuntimePreferences", {
              requestId,
              resolution: {
                status: "ok",
                preferences: {
                  nativeSearchEnhancementsEnabled: true,
                  memoryEnabled: false,
                  askUserQuestionAutoResolutionEnabled: true,
                },
              },
            })
            .catch((error) => warn(`zserver-broker: prefs respond failed: ${error.message}`));
        });
      })();
    }
    // A rejected spawn must never be cached: reset it so the next client
    // retries (one transient failure must not wedge the broker forever).
    this.spawning.catch(() => {
      this.spawning = null;
    });
    await this.spawning;
    if (this.stopped) {
      // stop() raced the spawn: the connection was registered after the guard
      // in the spawn continuation — dispose it so no orphan server survives.
      (this.connection as ZServerConnection | null)?.dispose();
      throw new Error("zserver-broker: stopped while spawning");
    }
    return this.connection!;
  }

  private onClient(socket: Socket): void {
    const clientId = this.nextClientId++;
    const entry: ClientEntry = {
      id: clientId,
      violations: 0,
      socket,
      idByClient: new Map(),
      serverIdByClient: new Map(),
      subscriptions: new Set(),
    };
    this.clients.set(clientId, entry);
    log(`zserver-broker: client ${clientId} attached (${this.clients.size} attached)`);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const decoder = new FrameDecoder((payload) => {
      // routeClientFrame contains its own failures; the catch here is the
      // last line of defence — a rejection escaping a `void` promise would be
      // an unhandledRejection that kills the shared daemon.
      this.routeClientFrame(entry, payload).catch((error: unknown) => {
        warn(
          `zserver-broker: client ${clientId} frame handling failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        socket.destroy();
      });
    });
    socket.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      if (decoder.byteLength > maxClientBufferBytes()) {
        warn(`zserver-broker: client ${clientId} exceeded frame buffer limit — disconnecting`);
        socket.destroy();
      }
    });
    socket.once("close", () => {
      this.clients.delete(clientId);
      log(`zserver-broker: client ${clientId} detached (${this.clients.size} attached)`);
      // The client never sent unsubscribe frames (ChannelClient.dispose does
      // not emit them) — synthesize EventDispose for every subscription it
      // left open, or the shared server keeps firing events into a routed
      // void forever. In-flight promise ids get disposed too (harmless: their
      // responses would have nowhere to go).
      if (this.connection && entry.idByClient.size > 0) {
        for (const serverId of [...entry.idByClient.keys()]) {
          this.connection.rawSend(encodeMessage([103, serverId], undefined));
        }
      }
      // EventDispose only stops event delivery: the server keeps every V4
      // conversation subscription owned until unsubscribeConversationV4 names
      // it (verified on the real server). Drop this client's hold on each one —
      // its process may be gone (kill -9), and nobody else ever will release it.
      for (const key of entry.subscriptions) this.dropHolder(key, entry.id);
      entry.subscriptions.clear();
      entry.idByClient.clear();
      entry.serverIdByClient.clear();
      this.armIdleExit();
    });
    // Persistent (not once): a second 'error' after the first (e.g. write to
    // an already-RST socket) must not escape as unhandled and crash the broker.
    socket.on("error", (error) => {
      warn(`zserver-broker: client ${clientId} socket error: ${error.message}`);
      socket.destroy();
    });

    void this.ensureServer()
      .then((connection) => {
        if (this.clients.get(clientId) !== entry) return; // already gone
        socket.write(encodeFrame(encodeMessage([200], undefined)));
        void connection;
      })
      .catch((error) => {
        warn(`zserver-broker: server spawn failed for client ${clientId}: ${error.message}`);
        socket.destroy();
      });
  }

  private async routeClientFrame(entry: ClientEntry, payload: Buffer): Promise<void> {
    let connection: ZServerConnection;
    try {
      connection = await this.ensureServer();
    } catch (error) {
      warn(
        `zserver-broker: server unavailable for client frame: ${error instanceof Error ? error.message : String(error)}`,
      );
      entry.socket.destroy();
      return;
    }
    if (entry.socket.destroyed || ![...this.clients.values()].includes(entry)) {
      // The client vanished while we awaited the shared server: forwarding its
      // frame (e.g. an EventListen) would leak a server-side subscription that
      // can never be routed back.
      return;
    }
    let header: unknown[];
    try {
      header = decodeMessage(payload).header as unknown[];
    } catch (error) {
      warn(
        `zserver-broker: undecodable client frame (${
          error instanceof Error ? error.message : String(error)
        }) — disconnecting`,
      );
      entry.socket.destroy();
      return;
    }
    const verdict = validateClientHeader(header);
    if (!verdict.ok) {
      entry.violations++;
      this.rejectedFrames++;
      if (entry.violations <= MAX_LOGGED_VIOLATIONS_PER_CLIENT) {
        warn(`zserver-broker: client ${entry.id} frame rejected (${verdict.reason})`);
      } else if (entry.violations === MAX_LOGGED_VIOLATIONS_PER_CLIENT + 1) {
        warn(`zserver-broker: client ${entry.id} keeps sending rejected frames — not logging more`);
      }
      // A well-formed but disallowed request is ANSWERED, however often it
      // repeats: the client sees why instead of an opaque "socket closed" it
      // would misread as a server death (and heal against, or shut the bridge
      // down over). Only a frame with no answerable id — malformed — is cut off.
      if (verdict.replyTo !== undefined && !entry.socket.destroyed) {
        this.replyError(entry, verdict.replyTo, "BrokerPolicyError", verdict.reason);
        return;
      }
      entry.socket.destroy();
      return;
    }
    const [type, clientRequestId] = header as [number, number?];
    if (typeof clientRequestId === "number") {
      if (type === 101 || type === 103) {
        // Cancel/dispose carry the ORIGINAL client request id — translate back
        // to the server id allocated for that request; allocating a fresh id
        // here would no-op server-side and leak the subscription.
        const serverId = entry.serverIdByClient.get(clientRequestId);
        if (serverId === undefined) return;
        header[1] = serverId;
        entry.serverIdByClient.delete(clientRequestId);
        entry.idByClient.delete(serverId);
        // A cancelled subscribe may still succeed server-side: flag it so the
        // ack releases it instead of leaking an unreachable subscription.
        if (type === 101) {
          const pending = this.pendingSubscribes.get(serverId);
          if (pending) pending.cancelled = true;
        }
      } else {
        if (entry.idByClient.size >= maxPendingPerClient()) {
          // Resource limit, not misbehaviour: answer, don't count a violation.
          warn(`zserver-broker: client ${entry.id} exceeded the pending-request limit`);
          this.replyError(
            entry,
            clientRequestId,
            "BrokerLimitError",
            "too many outstanding requests through the broker",
          );
          return;
        }
        // A client's unsubscribe is handled HERE, never forwarded: the server keeps
        // one subscription per (workspace, session) on the broker's single
        // connection, so the client's own (possibly superseded) id would either be
        // a silent no-op or, if current, cut off every other holder.
        if (
          type === 100 &&
          this.handleUnsubscribeLocally(entry, clientRequestId, header, payload)
        ) {
          return;
        }
        const serverId = this.nextServerId++;
        entry.idByClient.set(serverId, clientRequestId);
        entry.serverIdByClient.set(clientRequestId, serverId);
        header[1] = serverId;
        if (type === 100) this.trackSubscribeCall(entry, serverId, header, payload);
      }
    }
    try {
      // Header-only rewrite: the body bytes are forwarded untouched (a full
      // decode→encode roundtrip is not byte-faithful — see replaceHeader).
      connection.rawSend(replaceHeader(payload, header));
    } catch (error) {
      warn(
        `zserver-broker: send to shared server failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      entry.socket.destroy();
    }
  }

  /**
   * unsubscribeConversationV4 from a client: drop ITS hold on the shared
   * subscription (the last holder out releases it on the server) and answer 201
   * itself. Idempotent like the server (an unknown subscription is a no-op).
   * Returns true when the frame was consumed.
   */
  private handleUnsubscribeLocally(
    entry: ClientEntry,
    clientRequestId: number,
    header: unknown[],
    payload: Buffer,
  ): boolean {
    if (header[2] !== "zcode-agent" || header[3] !== "unsubscribeConversationV4") return false;
    let params: { workspacePath: string; sessionId: string } | null = null;
    try {
      params = subscriptionParams(decodeMessage(payload).body);
    } catch {
      /* undecodable body: treated as a no-op below */
    }
    if (params) {
      const key = subscriptionKey(params.workspacePath, params.sessionId);
      // A subscribe of this client still in flight is withdrawn too.
      for (const pending of this.pendingSubscribes.values()) {
        if (pending.clientId === entry.id && pending.key === key) pending.cancelled = true;
      }
      if (entry.subscriptions.delete(key)) this.dropHolder(key, entry.id);
    }
    this.sendToClient(entry, encodeFrame(encodeMessage([201, clientRequestId], undefined)));
    return true;
  }

  /** Remember a forwarded subscribeConversationV4 so its ack can be attributed. */
  private trackSubscribeCall(
    entry: ClientEntry,
    serverId: number,
    header: unknown[],
    payload: Buffer,
  ): void {
    if (header[2] !== "zcode-agent" || header[3] !== "subscribeConversationV4") return;
    let params: { workspacePath: string; sessionId: string } | null = null;
    try {
      params = subscriptionParams(decodeMessage(payload).body);
    } catch {
      /* body undecodable: the server will reject it too */
    }
    if (!params || this.pendingSubscribes.size >= MAX_TRACKED_SUBSCRIBES) return;
    this.pendingSubscribes.set(serverId, {
      clientId: entry.id,
      key: subscriptionKey(params.workspacePath, params.sessionId),
      workspacePath: params.workspacePath,
      sessionId: params.sessionId,
      cancelled: false,
    });
  }

  /**
   * A subscribeConversationV4 ack arrived (or failed): attribute the server's
   * subscriptionId to the holder that asked for it. The server keeps ONE
   * subscription per (workspace, session) on the broker's connection, so a newer
   * ack replaces the older id — remember the newest and let every holder share it.
   */
  private settleSubscribe(serverId: number, ok: boolean, body: unknown): void {
    const pending = this.pendingSubscribes.get(serverId);
    if (!pending) return;
    this.pendingSubscribes.delete(serverId);
    if (!ok) return;
    const subscriptionId = (body as { ack?: { subscriptionId?: unknown } } | null)?.ack
      ?.subscriptionId;
    if (typeof subscriptionId !== "string") return;
    let shared = this.sharedSubscriptions.get(pending.key);
    if (shared) {
      shared.subscriptionId = subscriptionId;
    } else {
      shared = {
        workspacePath: pending.workspacePath,
        sessionId: pending.sessionId,
        subscriptionId,
        holders: new Set(),
      };
      this.sharedSubscriptions.set(pending.key, shared);
    }
    const holder = this.clients.get(pending.clientId);
    if (pending.cancelled || !holder) {
      // Nobody is left to use it (cancelled, or the client vanished mid-flight).
      if (shared.holders.size === 0) this.releaseShared(pending.key, shared);
      return;
    }
    shared.holders.add(pending.clientId);
    holder.subscriptions.add(pending.key);
  }

  /** One holder leaves; the LAST one out releases the server-side subscription. */
  private dropHolder(key: string, clientId: number): void {
    const shared = this.sharedSubscriptions.get(key);
    if (!shared) return;
    shared.holders.delete(clientId);
    if (shared.holders.size === 0) this.releaseShared(key, shared);
  }

  private releaseShared(key: string, shared: SharedSubscription): void {
    this.sharedSubscriptions.delete(key);
    const connection = this.connection;
    if (!connection) return; // the server is gone; its subscriptions went with it
    connection
      .channelOf("zcode-agent")
      .call("unsubscribeConversationV4", {
        workspacePath: shared.workspacePath,
        sessionId: shared.sessionId,
        subscriptionId: shared.subscriptionId,
      })
      .catch((error: Error) =>
        warn(
          `zserver-broker: releasing subscription for ${shared.sessionId} failed: ${error.message}`,
        ),
      );
  }

  /**
   * Write one frame to a client, refusing to buffer for a client that does not
   * read: Node queues unflushed writes in memory without bound, and the broker
   * answers every rejected/limited/unsubscribed request. A client whose unread
   * backlog passes the cap is cut off (and its holds released by the close
   * handler) rather than letting one stuck peer grow the shared daemon forever.
   */
  private sendToClient(entry: ClientEntry, frame: Buffer): void {
    if (entry.socket.destroyed) return;
    if (entry.socket.writableLength + frame.byteLength > maxClientWriteQueueBytes()) {
      warn(`zserver-broker: client ${entry.id} is not reading its replies — disconnecting`);
      entry.socket.destroy();
      return;
    }
    entry.socket.write(frame);
  }

  /** Answer one client request with a PromiseError (202) frame. */
  private replyError(entry: ClientEntry, id: number, name: string, message: string): void {
    this.sendToClient(
      entry,
      encodeFrame(encodeMessage([202, id], { message: `broker: ${message}`, name })),
    );
  }

  /** Point-in-time counters (tests, and the basis for a future status probe). */
  stats(): { clients: number; pending: number; rejected: number; sharedServerPid: number | null } {
    let pending = 0;
    for (const entry of this.clients.values()) pending += entry.idByClient.size;
    return {
      clients: this.clients.size,
      pending,
      rejected: this.rejectedFrames,
      sharedServerPid: this.connection?.child?.pid ?? null,
    };
  }

  /** Forward one server-side frame to its owning client (or drop). */
  private routeServerPayload(payload: Buffer): void {
    let header: unknown[];
    try {
      header = decodeMessage(payload).header as unknown[];
    } catch (error) {
      // Malformed server frames must never crash the broker (AGENTS.md:
      // event handlers are best-effort, never thrown into the event loop).
      warn(
        `zserver-broker: undecodable server frame (${
          error instanceof Error ? error.message : String(error)
        }) — dropped`,
      );
      return;
    }
    if (!Array.isArray(header)) return;
    const [type, id] = header as [number, number?];
    if (type === 200) return; // server Initialize — synthesized per client
    if (typeof id !== "number") return;
    // Terminal responses (201/202/203) retire the id mapping. EventFire (204)
    // reuses the EventListen request id for EVERY fire — deleting it after the
    // first event would silently drop the whole rest of the stream.
    const terminal = type === 201 || type === 202 || type === 203;
    if (terminal && this.pendingSubscribes.has(id)) {
      let body: unknown;
      if (type === 201) {
        try {
          body = decodeMessage(payload).body;
        } catch {
          /* undecodable ack: nothing to track */
        }
      }
      this.settleSubscribe(id, type === 201, body);
    }
    for (const entry of this.clients.values()) {
      const clientRequestId = entry.idByClient.get(id);
      if (clientRequestId === undefined) continue;
      if (terminal) {
        entry.idByClient.delete(id);
        // Only drop the reverse entry if it still points at THIS server id (a
        // client that reused a request id overwrote it with a newer one).
        if (entry.serverIdByClient.get(clientRequestId) === id) {
          entry.serverIdByClient.delete(clientRequestId);
        }
      }
      header[1] = clientRequestId;
      this.sendToClient(entry, encodeFrame(replaceHeader(payload, header)));
      return;
    }
  }

  private armIdleExit(): void {
    const idleMs = clientIdleExitMs();
    if (!idleMs || this.clients.size > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // Always emitted: a daemon that ends on its own would otherwise vanish with
      // no trace unless debug logging happened to be on (a supervisor that
      // restarts it then loops silently).
      warn(`zserver-broker: idle ${idleMs}ms with no clients — exiting`);
      // A failing stop() must not become an unhandledRejection; a failed clean
      // shutdown still ends the idle daemon (non-zero so a supervisor sees it).
      this.stop().then(
        () => this.exitProcess(0),
        (error: unknown) => {
          warn(
            `zserver-broker: idle stop failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          this.exitProcess(1);
        },
      );
    }, idleMs);
    this.idleTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // A SIGINT during the startup handshake must not orphan the in-flight
    // server child: wait for the spawn to settle (the continuation disposes
    // it when stopped) before tearing the listener down and exiting.
    await this.spawning?.catch(() => undefined);
    for (const entry of this.clients.values()) entry.socket.destroy();
    this.clients.clear();
    this.connection?.dispose();
    this.connection = null;
    const server = this.server;
    this.server = null;
    // Node's server.close() unlinks the socket path BY NAME. If another broker
    // replaced the path after we bound (the loser of a start race), that would
    // delete the WINNER's socket and silently push every client to a direct
    // spawn. Park a foreign socket for the duration of close() and put it back.
    let parked: string | null = null;
    if (server && this.socketIno !== null) {
      let current: fs.Stats | null = null;
      try {
        current = fs.lstatSync(this.socketPath);
      } catch {
        /* nothing at the path */
      }
      if (current && current.ino !== this.socketIno) {
        parked = `${this.socketPath}.parked-${process.pid}`;
        try {
          fs.renameSync(this.socketPath, parked);
        } catch {
          parked = null;
        }
      }
    }
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => {
        if (parked === null) {
          try {
            unlinkSync(this.socketPath);
          } catch {
            /* already gone */
          }
        }
        resolve();
      });
    });
    if (parked !== null) {
      try {
        fs.renameSync(parked, this.socketPath);
      } catch (error) {
        warn(
          `zserver-broker: could not restore the other broker's socket at ${this.socketPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
