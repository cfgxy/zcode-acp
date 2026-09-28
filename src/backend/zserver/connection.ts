import { spawn } from "node:child_process";
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

export type ZServerExitHandler = (code: number | null, signal: string | null) => void;

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
  private lineMode = true;
  private onHelloLine: ((line: string) => void) | null = null;
  private exited = false;

  private constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly serverRoot: string,
    readonly clientId: string,
  ) {
    this.exitFailure = new Promise<never>((_, reject) => {
      this.exitReject = reject;
    });
    // A rejected exitFailure with no active handshake awaiting it would crash
    // the process on unhandledRejection — keep a no-op catch attached (same
    // contract as the broadcast loser promises in remote/broadcast.ts).
    this.exitFailure.catch(() => undefined);
    this.client = new ChannelClient((payload) => {
      if (!this.exited && this.child.stdin.writable) {
        this.child.stdin.write(encodeFrame(payload));
      }
    });
    this.channel = new ServiceChannel(this.client, DEFAULT_CHANNEL);
    this.frameDecoder = new FrameDecoder((payload) => {
      this.client.onMessage(decodeMessage(payload));
    });
    this.child.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr!.on("data", (chunk: Buffer) => this.onStderr(chunk));
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      const detail = this.stderrTail.at(-1) ? `: ${this.stderrTail.at(-1)}` : "";
      this.exitReject(
        new ZServerConnectionError(
          "hello",
          `zcode server exited (code=${code ?? "null"} signal=${signal ?? "null"})${detail}`,
        ),
      );
      this.client.dispose(
        Object.assign(
          new Error(`zcode server exited (code=${code ?? "null"} signal=${signal ?? "null"})`),
          { name: "ConnectionClosed" },
        ),
      );
      for (const handler of [...this.exitHandlers]) {
        handler(code, signal);
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
    );
    await connection.handshake(options.version ?? "0.0.0");
    return connection;
  }

  private async handshake(version: string): Promise<void> {
    // Phase 1 — hello: the server prints a zcode-hello JSON line on stdout
    // (after any SSH banner noise) and waits up to 10s for the ack line.
    await Promise.race([this.awaitHello(), this.exitFailure, timeout(HELLO_TIMEOUT_MS, "hello")]);
    this.child.stdin.write(
      `${JSON.stringify({ type: "zcode-hello-ack", version, clientId: this.clientId })}\n`,
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
    if (!this.exited && this.child.exitCode === null && !this.child.killed) {
      this.child.kill("SIGTERM");
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
