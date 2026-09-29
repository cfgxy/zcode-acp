import { spawn, type ChildProcess } from "node:child_process";
import { connect as netConnect } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { warn } from "../../utils.js";
import { ChannelClient, ServiceChannel } from "./channel-client.js";
import { decodeMessage, encodeFrame, FrameDecoder } from "./protocol.js";

export const DEFAULT_CHANNEL = "zcode-agent";
const HELLO_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 15_000;
const STDERR_TAIL_MAX_LINES = 30;

export interface ZServerSpawnOptions {
  /** Runtime root containing `node` and `zcode-server.cjs` (default ~/.zcode/server). */
  serverRoot?: string;
  /** Full child environment (profile pins merged in by the caller). */
  env?: NodeJS.ProcessEnv;
  clientId?: string;
  /** Value reported in the hello-ack; any non-empty string passes the schema. */
  version?: string;
}

export interface HelloInfo {
  version?: string;
  platform?: string;
  arch?: string;
  pid?: number;
}

export type ZServerExitHandler = (
  code: number | null,
  signal: string | null,
  detail?: string,
) => void;

export type ZServerConnectionPhase = "spawn" | "hello" | "ready";

export class ZServerConnectionError extends Error {
  constructor(
    readonly phase: ZServerConnectionPhase,
    message: string,
  ) {
    super(message);
    this.name = "ZServerConnectionError";
  }
}

/**
 * A zcode-server.cjs (stdio mode) child process with the channel protocol
 * client attached. Lifecycle: spawn → zcode-hello / zcode-hello-ack line
 * handshake → Initialize frame → RPC ready. The server is the ServiceCollection
 * owner (agent runtimes, device identity, provisioning); the desktop does not
 * need to be running (ADR-0008).
 */
export class ZServerConnection {
  readonly channel: ServiceChannel;

  private readonly client: ChannelClient;
  private readonly frameDecoder: FrameDecoder;
  private readonly exitHandlers = new Set<ZServerExitHandler>();
  private readonly stderrTail: string[] = [];
  private readonly exitFailure: Promise<never>;
  private exitReject!: (error: Error) => void;
  private rawBuffer: Buffer = Buffer.alloc(0);
  /** Hello line handshake only applies to spawn; attach starts framed. */
  private lineMode: boolean;
  private readonly rawFrameListeners = new Set<(payload: Buffer) => void>();
  private onHelloLine: ((line: string) => void) | null = null;
  private exited = false;

  private constructor(
    readonly child: ChildProcess | null,
    readonly serverRoot: string,
    readonly clientId: string,
    private readonly io: {
      writeFrame(payload: Buffer): void;
      shutdown(): void;
      bind(onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void): void;
      onExit(cb: (detail: string) => void): void;
    },
  ) {
    this.exitFailure = new Promise<never>((_, reject) => {
      this.exitReject = reject;
    });
    this.lineMode = child !== null;
    // A rejected exitFailure with no active handshake awaiting it would crash
    // the process on unhandledRejection — keep a no-op catch attached (same
    // contract as the broadcast loser promises in remote/broadcast.ts).
    this.exitFailure.catch(() => undefined);
    this.client = new ChannelClient((payload) => {
      if (!this.exited) {
        this.io.writeFrame(encodeFrame(payload));
      }
    });
    this.channel = new ServiceChannel(this.client, DEFAULT_CHANNEL);
    this.frameDecoder = new FrameDecoder((payload) => {
      // Malformed frames must never escape into the event loop (an uncaught
      // throw inside a stream 'data' handler kills the process).
      try {
        this.client.onMessage(decodeMessage(payload));
      } catch (error) {
        warn(
          `zserver: undecodable frame dropped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      for (const listener of [...this.rawFrameListeners]) {
        try {
          listener(payload);
        } catch {
          /* tap errors must not kill the connection */
        }
      }
    });
    this.io.bind(
      (chunk) => this.onStdout(chunk),
      (chunk) => this.onStderr(chunk),
    );
    this.io.onExit((detail) => {
      this.exited = true;
      const tail = this.stderrTail.at(-1) ? `: ${this.stderrTail.at(-1)}` : "";
      this.exitReject(new ZServerConnectionError("hello", `zcode server exited: ${detail}${tail}`));
      this.client.dispose(
        Object.assign(new Error(`zcode server exited: ${detail}${tail}`), {
          name: "ConnectionClosed",
        }),
      );
      for (const handler of [...this.exitHandlers]) {
        handler(null, null, detail);
      }
    });
  }

  static async spawn(options: ZServerSpawnOptions = {}): Promise<ZServerConnection> {
    const serverRoot = path.resolve(
      options.serverRoot ??
        options.env?.ZCODE_SERVER_RUNTIME_ROOT ??
        path.join(os.homedir(), ".zcode", "server"),
    );
    const bundle = path.join(serverRoot, "zcode-server.cjs");
    if (!existsSync(bundle)) {
      throw new ZServerConnectionError("spawn", `zcode server bundle not found: ${bundle}`);
    }
    // Prefer the deployed node (version-matched, sqlite-capable); fall back to ours.
    const deployedNode = path.join(serverRoot, "node");
    const nodeBin = existsSync(deployedNode) ? deployedNode : process.execPath;
    if (!existsSync(deployedNode)) {
      warn(`zserver: deployed node missing at ${deployedNode}, falling back to ${nodeBin}`);
    }

    const child = spawnChild(nodeBin, bundle, options.env ?? process.env);
    const connection = new ZServerConnection(
      child,
      serverRoot,
      options.clientId ?? `zcode-acp-${process.pid}`,
      childIo(child),
    );
    try {
      await connection.handshake(options.version ?? "0.0.0");
    } catch (error) {
      // A failed handshake must not leak the spawned server child. Attach the
      // stderr tail — a bundle crashing at startup prints its reason there.
      connection.dispose();
      if (error instanceof ZServerConnectionError) {
        const tail = connection.stderrTailLines(3);
        if (tail.length > 0) {
          error.message = `${error.message} | stderr: ${tail.join(" / ").slice(0, 400)}`;
        }
      }
      throw error;
    }
    return connection;
  }

  /**
   * Attach to an already-running zcode-server channel broker over a unix
   * socket (machine-level server reuse, ADR-0008). The broker synthesizes the
   * Initialize frame per attach — no hello handshake on this path.
   */
  static async attach(options: {
    socketPath: string;
    clientId?: string;
    serverRoot?: string;
  }): Promise<ZServerConnection> {
    const socket = netConnect(options.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const clientId = options.clientId ?? `zcode-acp-${process.pid}`;
    const connection = new ZServerConnection(null, options.serverRoot ?? "", clientId, {
      writeFrame: (payload) => {
        if (!socket.destroyed) socket.write(payload);
      },
      shutdown: () => socket.destroy(),
      bind: (onStdout, _onStderr) => {
        socket.on("data", (chunk) => onStdout(chunk));
        // Persistent (not once): RST/ECONNRESET must never surface as an
        // unhandled 'error' event — route to close semantics instead.
        socket.on("error", (error) => {
          warn(`zserver: attach socket error (handled): ${error.message}`);
          socket.destroy();
        });
      },
      onExit: (cb) => socket.once("close", () => cb("socket closed")),
    });
    try {
      await Promise.race([
        connection.client.whenInitialized(),
        connection.exitFailure,
        timeout(READY_TIMEOUT_MS, "ready"),
      ]);
    } catch (error) {
      // A failed attach must not leak the connected socket, nor leave a ghost
      // client entry on the broker (which would block its idle exit forever).
      connection.dispose();
      throw error;
    }
    return connection;
  }

  private async handshake(version: string): Promise<void> {
    // Phase 1 — hello: the server prints a zcode-hello JSON line on stdout
    // (after any SSH banner noise) and waits up to 10s for the ack line.
    await Promise.race([this.awaitHello(), this.exitFailure, timeout(HELLO_TIMEOUT_MS, "hello")]);
    this.io.writeFrame(
      Buffer.from(
        `${JSON.stringify({ type: "zcode-hello-ack", version, clientId: this.clientId })}\n`,
        "utf8",
      ),
    );
    // Phase 2 — the server constructs its ChannelServer right after the ack
    // and sends Initialize; gate first RPC on it.
    await Promise.race([
      this.client.whenInitialized(),
      this.exitFailure,
      timeout(READY_TIMEOUT_MS, "ready"),
    ]);
  }

  private awaitHello(): Promise<void> {
    return new Promise((resolve) => {
      this.onHelloLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        const message = parsed as HelloInfo & { type?: string };
        if (message?.type !== "zcode-hello") {
          return;
        }
        this.lineMode = false;
        resolve();
      };
    });
  }

  /** Send a pre-encoded channel message as one frame (broker path). */
  rawSend(payload: Buffer): void {
    if (!this.exited) {
      this.io.writeFrame(encodeFrame(payload));
    }
  }

  /** Observe every inbound Regular-frame payload (broker path). */
  onRawFrame(listener: (payload: Buffer) => void): () => void {
    this.rawFrameListeners.add(listener);
    return () => this.rawFrameListeners.delete(listener);
  }

  /** stderr tail (last lines) for failure diagnostics. */
  stderrTailLines(count = 5): string[] {
    return this.stderrTail.slice(-count);
  }

  onExit(handler: ZServerExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  stderrSnapshot(): string[] {
    return [...this.stderrTail];
  }

  whenReady(): Promise<void> {
    return this.client.whenInitialized();
  }

  call(method: string, ...args: unknown[]): Promise<unknown> {
    return this.channel.call(method, ...args);
  }

  listen(event: string, arg: unknown, onFire: (data: unknown) => void): () => void {
    return this.channel.listen(event, arg, onFire);
  }

  /** Channel access for any other registered service ("zcode-task", "zcode-session", …). */
  channelOf(name: string): ServiceChannel {
    return new ServiceChannel(this.client, name);
  }

  dispose(reason?: Error): void {
    this.client.dispose(reason);
    if (!this.exited) {
      this.io.shutdown();
    }
  }

  private onStdout(chunk: Buffer): void {
    if (this.lineMode) {
      // Scan on the raw bytes (not a decoded string): everything after the
      // hello line is binary framed RPC and must survive byte-exact.
      this.rawBuffer = Buffer.concat([this.rawBuffer, chunk]);
      for (;;) {
        const newlineIdx = this.rawBuffer.indexOf(0x0a);
        if (newlineIdx === -1) {
          return;
        }
        const line = this.rawBuffer.subarray(0, newlineIdx).toString("utf8");
        this.rawBuffer = this.rawBuffer.subarray(newlineIdx + 1);
        this.onHelloLine?.(line);
        if (!this.lineMode) {
          // Handshake done: whatever remains buffered is already framed RPC
          // data and must flow into the frame decoder.
          if (this.rawBuffer.length > 0) {
            this.frameDecoder.push(this.rawBuffer);
          }
          this.rawBuffer = Buffer.alloc(0);
          return;
        }
      }
    }
    this.frameDecoder.push(chunk);
  }

  private onStderr(chunk: Buffer): void {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      this.stderrTail.push(line);
      if (this.stderrTail.length > STDERR_TAIL_MAX_LINES) {
        this.stderrTail.shift();
      }
    }
  }
}

function childIo(child: ChildProcessWithoutNullStreams) {
  return {
    writeFrame(payload: Buffer): void {
      child.stdin.write(payload);
    },
    shutdown(): void {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    },
    bind(onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void): void {
      child.stdout!.on("data", onStdout);
      child.stderr!.on("data", onStderr);
    },
    onExit(cb: (detail: string) => void): void {
      child.once("exit", (code, signal) => cb(`code=${code ?? "null"} signal=${signal ?? "null"}`));
    },
  };
}

function spawnChild(
  nodeBin: string,
  bundle: string,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  try {
    return spawn(nodeBin, [bundle], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    throw new ZServerConnectionError("spawn", `zcode server spawn failed: ${String(error)}`);
  }
}

function timeout(ms: number, phase: ZServerConnectionPhase): Promise<never> {
  return new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(new ZServerConnectionError(phase, `zcode server ${phase} timeout after ${ms}ms`)),
      ms,
    ),
  );
}
