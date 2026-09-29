import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { log, warn } from "../../utils.js";
import {
  decodeMessage,
  encodeFrame,
  encodeMessage,
  FrameDecoder,
  replaceHeader,
} from "./protocol.js";
import { ZServerConnection } from "./connection.js";
import { runtimeEnvWithProfile } from "./backend.js";

export const DEFAULT_BROKER_SOCKET = path.join(
  process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".zcode"),
  "zserver-broker.sock",
);

const CLIENT_IDLE_EXIT_MS = Number(process.env.ZCODE_ACP_ZSERVER_BROKER_IDLE_EXIT_MS ?? 0) || 0;
/** Per-client inbound cap: a frame claiming more than this is a hostile/misbehaving peer. */
function maxClientBufferBytes(): number {
  return Number(process.env.ZCODE_ACP_ZSERVER_MAX_CLIENT_BUFFER ?? 0) || 64 * 1024 * 1024;
}

interface ClientEntry {
  socket: Socket;
  /** server-side request id → client-side request id (route responses/events back). */
  idByClient: Map<number, number>;
  /** client-side request id → server-side request id (translate cancel/dispose). */
  serverIdByClient: Map<number, number>;
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
  private readonly clients = new Map<number, ClientEntry>();
  private nextClientId = 1;
  /** Server-side id space is broker-global: per-client counters would collide
   *  (two clients' EventListen rewriting to id 1 collapse into ONE server-side
   *  subscription, and event routing becomes first-match ambiguity). */
  private nextServerId = 1;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly socketPath: string = DEFAULT_BROKER_SOCKET,
    private readonly serverRoot?: string,
  ) {}

  async start(): Promise<void> {
    if (existsSync(this.socketPath)) {
      // Probe before unlinking: a live broker would accept the connection; a
      // stale file refuses it. Never evict a live broker's socket.
      const live = await new Promise<boolean>((resolve) => {
        const probe = connect(this.socketPath);
        probe.once("connect", () => {
          probe.destroy();
          resolve(true);
        });
        probe.once("error", () => resolve(false));
      });
      if (live) {
        throw new Error(`zserver-broker: a live broker is already listening on ${this.socketPath}`);
      }
      unlinkSync(this.socketPath);
    }
    this.server = createServer((socket) => this.onClient(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath, () => resolve());
      this.server!.once("error", reject);
    });
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
          serverRoot: this.serverRoot,
          clientId: "zserver-broker",
          env: await runtimeEnvWithProfile(process.env),
        });
        connection.onExit((code, signal) => {
          warn(
            `zserver-broker: shared server exited (code=${code ?? "null"} signal=${signal ?? "null"}) — detaching ${this.clients.size} client(s)`,
          );
          this.connection = null;
          this.spawning = null;
          // Server-side state (subscriptions included) died with it. Clients
          // must learn: destroy their sockets so their heal path re-attaches
          // and re-subscribes against the respawned server.
          for (const entry of this.clients.values()) {
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
      socket,
      idByClient: new Map(),
      serverIdByClient: new Map(),
    };
    this.clients.set(clientId, entry);
    log(`zserver-broker: client ${clientId} attached (${this.clients.size} attached)`);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const decoder = new FrameDecoder((payload) => {
      void this.routeClientFrame(entry, payload);
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
      this.armIdleExit();
    });
    socket.once("error", () => socket.destroy());

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
    const header = decodeMessage(payload).header as unknown[];
    if (!Array.isArray(header)) return;
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
      } else {
        const serverId = this.nextServerId++;
        entry.idByClient.set(serverId, clientRequestId);
        entry.serverIdByClient.set(clientRequestId, serverId);
        header[1] = serverId;
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

  /** Forward one server-side frame to its owning client (or drop). */
  private routeServerPayload(payload: Buffer): void {
    const header = decodeMessage(payload).header as unknown[];
    if (!Array.isArray(header)) return;
    const [type, id] = header as [number, number?];
    if (type === 200) return; // server Initialize — synthesized per client
    if (typeof id !== "number") return;
    // Terminal responses (201/202/203) retire the id mapping. EventFire (204)
    // reuses the EventListen request id for EVERY fire — deleting it after the
    // first event would silently drop the whole rest of the stream.
    const terminal = type === 201 || type === 202 || type === 203;
    for (const entry of this.clients.values()) {
      const clientRequestId = entry.idByClient.get(id);
      if (clientRequestId === undefined) continue;
      if (terminal) {
        entry.idByClient.delete(id);
        for (const [clientKey, serverKey] of entry.serverIdByClient) {
          if (serverKey === id) entry.serverIdByClient.delete(clientKey);
        }
      }
      header[1] = clientRequestId;
      entry.socket.write(encodeFrame(replaceHeader(payload, header)));
      return;
    }
  }

  private armIdleExit(): void {
    if (!CLIENT_IDLE_EXIT_MS || this.clients.size > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log(`zserver-broker: idle ${CLIENT_IDLE_EXIT_MS}ms with no clients — exiting`);
      this.connection?.dispose();
      this.server?.close(() => unlinkSync(this.socketPath));
      process.exit(0);
    }, CLIENT_IDLE_EXIT_MS);
    this.idleTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const entry of this.clients.values()) entry.socket.destroy();
    this.clients.clear();
    this.connection?.dispose();
    this.connection = null;
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        try {
          unlinkSync(this.socketPath);
        } catch {
          /* already gone */
        }
        resolve();
      });
    });
  }
}
