import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { log, warn } from "../../utils.js";
import { decodeMessage, encodeFrame, encodeMessage, FrameDecoder } from "./protocol.js";
import { ZServerConnection } from "./connection.js";

export const DEFAULT_BROKER_SOCKET = path.join(
  process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".zcode"),
  "zserver-broker.sock",
);

const CLIENT_IDLE_EXIT_MS = Number(process.env.ZCODE_ACP_ZSERVER_BROKER_IDLE_EXIT_MS ?? 0) || 0;

interface ClientEntry {
  socket: Socket;
  /** clientId-space request id → server-side request id. */
  idByClient: Map<number, number>;
  nextServerId: number;
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
  private readonly clients = new Map<number, ClientEntry>();
  private nextClientId = 1;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly socketPath: string = DEFAULT_BROKER_SOCKET,
    private readonly serverRoot?: string,
  ) {}

  async start(): Promise<void> {
    if (existsSync(this.socketPath)) {
      // Stale socket from a dead broker — a live broker would accept connections.
      unlinkSync(this.socketPath);
    }
    this.server = createServer((socket) => this.onClient(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath, () => resolve());
      this.server!.once("error", reject);
    });
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
          env: process.env,
        });
        connection.onExit((code, signal) => {
          warn(
            `zserver-broker: shared server exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
          );
          this.connection = null;
          this.spawning = null;
        });
        // Swallow the server's Initialize: every client gets a synthetic one.
        connection.onRawFrame((payload) => this.routeServerPayload(payload));
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
    return this.connection!;
  }

  private onClient(socket: Socket): void {
    const clientId = this.nextClientId++;
    const entry: ClientEntry = { socket, idByClient: new Map(), nextServerId: 1 };
    this.clients.set(clientId, entry);
    log(`zserver-broker: client ${clientId} attached (${this.clients.size} attached)`);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const decoder = new FrameDecoder((payload) => {
      void this.routeClientFrame(entry, payload);
    });
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
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
    const connection = await this.ensureServer();
    const message = decodeMessage(payload);
    const header = message.header as unknown[];
    if (!Array.isArray(header)) return;
    const clientRequestId = header[1];
    if (typeof clientRequestId === "number") {
      const serverId = entry.nextServerId++;
      entry.idByClient.set(serverId, clientRequestId);
      header[1] = serverId;
    }
    connection.rawSend(encodeMessage(header, message.body));
  }

  /** Forward one server-side frame to its owning client (or drop). */
  private routeServerPayload(payload: Buffer): void {
    const message = decodeMessage(payload);
    const header = message.header as unknown[];
    if (!Array.isArray(header)) return;
    const [type, id] = header as [number, number?];
    if (type === 200) return; // server Initialize — synthesized per client
    if (typeof id !== "number") return;
    for (const entry of this.clients.values()) {
      const clientRequestId = entry.idByClient.get(id);
      if (clientRequestId === undefined) continue;
      entry.idByClient.delete(id);
      header[1] = clientRequestId;
      entry.socket.write(encodeFrame(encodeMessage(header, message.body)));
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
