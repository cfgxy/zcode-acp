import { spawn, type ChildProcess } from "node:child_process";
import { connect as netConnect } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
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

/** Why the transport ended: the process/socket closed, or it never started. */
type ExitKind = "exit" | "spawn-error";

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
      onExit(cb: (detail: string, kind: ExitKind) => void): void;
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
    this.io.onExit((detail, kind) => {
      this.exited = true;
      const last = this.stderrTail.at(-1);
      const tail = last ? `: ${clipDiagnostic(last)}` : "";
      // A process that never started (ENOENT/EACCES) is a PERMANENT spawn
      // failure — phase "spawn" is what makes the backend classify it as
      // `spawn failed:` (ERR_SPAWN_FAILED, no futile heal loop). A process that
      // started and then died mid-handshake stays retryable ("hello").
      this.exitReject(
        new ZServerConnectionError(
          kind === "spawn-error" ? "spawn" : "hello",
          `zcode server exited: ${detail}${tail}`,
        ),
      );
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
    // An empty or blank value counts as unset: `path.resolve("")` is the current
    // directory, so `ZCODE_SERVER_RUNTIME_ROOT=` used to make the lookup depend on
    // wherever the bridge happened to be started.
    const configuredRoot = [options.serverRoot, options.env?.ZCODE_SERVER_RUNTIME_ROOT]
      .map((value) => value?.trim())
      .find((value) => value);
    const serverRoot = path.resolve(configuredRoot ?? path.join(os.homedir(), ".zcode", "server"));
    const bundle = path.join(serverRoot, "zcode-server.cjs");
    if (!existsSync(bundle)) {
      throw new ZServerConnectionError(
        "spawn",
        `zcode server bundle not found: ${bundle} — install ZCode (the server lives under ` +
          "~/.zcode/server) or point ZCODE_SERVER_RUNTIME_ROOT at a directory containing zcode-server.cjs",
      );
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
          error.message = `${error.message} | stderr: ${clipDiagnostic(tail.join(" / "), 400)}`;
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
    assertSocketOwnedByUs(options.socketPath);
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
      onExit: (cb) => socket.once("close", () => cb("socket closed", "exit")),
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

  listen(
    event: string,
    arg: unknown,
    onFire: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): () => void {
    return this.channel.listen(event, arg, onFire, onError);
  }

  /** Channel access for any other registered service ("zcode-task", "zcode-session", …).
   *  With `signal`, aborting it abandons that channel's still-pending calls. */
  channelOf(name: string, signal?: AbortSignal): ServiceChannel {
    return new ServiceChannel(this.client, name, signal);
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

/**
 * The broker socket lives at a predictable path, so another local user could
 * pre-create a socket there and impersonate the broker. Only attach to a socket
 * file owned by the current user (Node exposes no SO_PEERCRED, so the file's
 * owner is the available proof). No-op where uids do not exist (Windows).
 */
export function assertSocketOwnedByUs(socketPath: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  let owner: number;
  try {
    owner = lstatSync(socketPath).uid;
  } catch {
    return; // absent: the connect below reports ENOENT/ECONNREFUSED
  }
  if (owner !== uid) {
    throw new Error(
      `broker socket ${socketPath} is owned by uid ${owner}, not ${uid} — refusing to attach`,
    );
  }
}

/**
 * Server stderr is untrusted free text that ends up in error messages shown to
 * the editor and repeated in always-on warnings: a single stderr line can be
 * kilobytes long. Bound it and keep it on one line (a newline would forge extra
 * log lines).
 */
export function clipDiagnostic(text: string, max = 300): string {
  const oneLine = text.replace(/[\r\n]+/g, " ");
  return oneLine.length > max
    ? `${oneLine.slice(0, max)}… [+${oneLine.length - max} chars]`
    : oneLine;
}

/** Delay before SIGTERM is escalated to SIGKILL on the server's process group. */
function killEscalationMs(): number {
  return Number(process.env.ZCODE_ACP_ZSERVER_KILL_ESCALATION_MS ?? 0) || 5000;
}

/**
 * Watchdog script (runs as `node -e`): polls the owner's liveness and, when the
 * owner (bridge/broker) dies without cleanup, SIGKILLs the whole server process
 * group so it cannot orphan. Mirrors the proven pattern in backend/client.ts:
 * `process.exit(0)` on BOTH terminal branches and NO setInterval inside tick —
 * an earlier zserver copy re-armed a timer every tick (timer count doubled each
 * 2s) and never exited (orphaned 45MB watchdogs after every owner death).
 *
 * It also outlives the group LEADER: it exits only when the whole group is
 * empty (kill(-pgid,0) throws), so a grandchild ignoring SIGTERM after the
 * leader died is still reaped when the owner goes away.
 */
export function buildWatchdogScript(ownerPid: number, pgid: number): string {
  if (
    !Number.isSafeInteger(ownerPid) ||
    !Number.isSafeInteger(pgid) ||
    ownerPid <= 0 ||
    pgid <= 0
  ) {
    throw new Error("watchdog requires positive integer pids");
  }
  return `
    const ownerPid = ${ownerPid};
    const pgid = ${pgid};
    const tick = () => {
      try { process.kill(ownerPid, 0); }
      catch {
        try { process.kill(-pgid, 'SIGKILL'); } catch {}
        process.exit(0);
      }
      try { process.kill(-pgid, 0); }
      catch { process.exit(0); }
    };
    setInterval(tick, 2000);
    tick();
  `;
}

function startGroupWatchdog(pgid: number | undefined): void {
  // Unsupported on Windows (no process groups) and pointless without a pid
  // (spawn failure: async ENOENT leaves child.pid undefined).
  if (process.platform === "win32" || !pgid) return;
  const watchdog = spawn(process.execPath, ["-e", buildWatchdogScript(process.pid, pgid)], {
    stdio: "ignore",
    detached: true, // own process group: never part of the group it reaps
    env: {},
  });
  // A failed watchdog spawn (EAGAIN/ENOMEM) must not crash the bridge.
  watchdog.on("error", (error) => {
    warn(`zserver: watchdog spawn failed (handled): ${error.message}`);
  });
  watchdog.unref();
}

function childIo(child: ChildProcessWithoutNullStreams) {
  // Async stream/child errors (EPIPE against a dying child, ENOENT/EACCES
  // spawn failures) arrive as 'error' events — without a listener they crash
  // the whole process (same lesson as backend/client.ts). Route to exit path.
  const swallowError = (error: Error): void => {
    warn(`zserver: child io error (handled): ${error.message}`);
  };
  child.on("error", swallowError);
  child.stdin.on("error", swallowError);
  child.stdout!.on("error", swallowError);
  child.stderr!.on("error", swallowError);
  // Watchdog: if this process (bridge/broker) dies without cleanup — Zed
  // force-kills are the proven scenario — reap the whole server process
  // group so it cannot orphan (pattern proven in backend/client.ts).
  startGroupWatchdog(child.pid);
  // shutdown() must be idempotent: group-kill via process.kill(-pid) never sets
  // child.killed, so without this every repeated dispose re-signalled the group
  // and armed another escalation timer.
  let shutdownStarted = false;
  return {
    writeFrame(payload: Buffer): void {
      if (!child.stdin.destroyed) child.stdin.write(payload);
    },
    shutdown(): void {
      // Group kill (child spawned detached → its pid IS its pgid), with a
      // SIGKILL escalation if SIGTERM is ignored or trapped.
      if (!shutdownStarted && child.exitCode === null && !child.killed) {
        shutdownStarted = true;
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        const escalate = setTimeout(() => {
          try {
            process.kill(-child.pid!, 0);
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, killEscalationMs());
        escalate.unref();
        // Keep the escalation armed past the leader's exit: if a grandchild
        // ignored SIGTERM the group is still alive and must be SIGKILLed.
        // (unref'd timer; the kill(-pgid,0) probe inside makes it a no-op when
        // the group is already gone.)
      }
    },
    bind(onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void): void {
      child.stdout!.on("data", onStdout);
      child.stderr!.on("data", onStderr);
    },
    onExit(cb: (detail: string, kind: ExitKind) => void): void {
      // Fire-once across 'exit' AND spawn 'error': an async spawn failure
      // (ENOENT/EACCES) emits 'error' then 'close' and NEVER 'exit' — without
      // this the handshake sat out the full 10s hello timeout.
      let fired = false;
      const once = (detail: string, kind: ExitKind): void => {
        if (fired) return;
        fired = true;
        cb(detail, kind);
      };
      child.once("exit", (code, signal) =>
        once(`code=${code ?? "null"} signal=${signal ?? "null"}`, "exit"),
      );
      child.once("error", (error) => {
        // 'error' is also emitted for failed kill()/IPC on a RUNNING child —
        // that is not an exit (the real 'exit' still follows). Only a child
        // that never got a pid is a spawn failure — permanent for ENOENT/EACCES
        // (the binary cannot start), but EAGAIN is a momentary shortage of
        // processes: reporting it as permanent would make the heal path give up
        // on a machine that recovers a second later.
        if (child.pid === undefined) {
          const code = (error as NodeJS.ErrnoException).code;
          once(`spawn error: ${error.message}`, code === "EAGAIN" ? "exit" : "spawn-error");
        }
      });
    },
  };
}

function spawnChild(
  nodeBin: string,
  bundle: string,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  let child: ChildProcessWithoutNullStreams;
  try {
    // detached: the child heads its own process group, so shutdown can reap
    // the server AND its agent grandchildren together (kill(-pgid)).
    child = spawn(nodeBin, [bundle], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    throw new ZServerConnectionError("spawn", `zcode server spawn failed: ${String(error)}`);
  }
  if (!child.stdin || !child.stdout || !child.stderr) {
    // EMFILE/ENFILE: Node schedules an 'error' event and returns BEFORE creating
    // the stdio pipes, so the streams are missing. That 'error' still arrives on
    // the next tick and, with no listener, would kill the process — attach one
    // before giving up. Transient (retryable), unlike ENOENT/EACCES.
    child.on("error", (error) => warn(`zserver: child spawn error (handled): ${error.message}`));
    throw new ZServerConnectionError(
      "hello",
      "zcode server spawn failed: no stdio pipes could be created " +
        "(out of file descriptors — EMFILE/ENFILE?)",
    );
  }
  return child;
}

function timeout(ms: number, phase: ZServerConnectionPhase): Promise<never> {
  return new Promise<never>((_, reject) => {
    const handle = setTimeout(
      () =>
        reject(new ZServerConnectionError(phase, `zcode server ${phase} timeout after ${ms}ms`)),
      ms,
    );
    // The losing side of a Promise.race must not pin the event loop for the
    // remaining seconds after the handshake already won.
    handle.unref?.();
  });
}
