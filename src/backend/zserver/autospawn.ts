import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { log, warn } from "../../utils.js";

/**
 * Auto-launch of the shared broker (ADR-0008). The first bridge that finds no
 * broker starts one; every later bridge attaches to it.
 *
 * Lifetime: the broker is deliberately NOT the spawning bridge's child — it
 * runs in its own session (`detached`) with no stdio tie, so the first bridge
 * exiting (or its process group being killed) cannot take the broker away from
 * the bridges that attached later. It is reclaimed by idle exit instead: once
 * the LAST client has been gone for {@link DEFAULT_BROKER_IDLE_EXIT_MS} it
 * stops itself (and its shared server).
 */

/** Idle exit applied to an auto-spawned broker unless the operator set one. */
export const DEFAULT_BROKER_IDLE_EXIT_MS = 10 * 60_000;
/** How long to keep retrying attach after launching a broker. */
const ATTACH_WAIT_MS = 8_000;
const ATTACH_POLL_MS = 150;
/** Never launch more than one broker per process within this window. */
const SPAWN_THROTTLE_MS = 5_000;
/** After a launch that never became attachable, stop trying for a while so a
 *  broken install costs one wait, not one per request/heal round. */
const FAILURE_COOLDOWN_MS = 60_000;

let lastSpawnAt = 0;
let cooldownUntil = 0;

/** Test seam: forget launch throttling/cooldown state. */
export function resetAutoBrokerState(): void {
  lastSpawnAt = 0;
  cooldownUntil = 0;
}

/** True when the error means "nobody is listening there (yet)". Anything else
 *  (wedged broker, foreign-owned socket, …) must not trigger a launch. */
export function isBrokerAbsentError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/** Start a detached broker process. Returns false when it could not be started. */
export function spawnBrokerDetached(socketPath: string, baseEnv: NodeJS.ProcessEnv): boolean {
  // dist/backend/zserver/autospawn.js → dist/cli.js
  const cliJs = fileURLToPath(new URL("../../cli.js", import.meta.url));
  if (!existsSync(cliJs)) {
    warn(`backend: cannot auto-start broker, ${cliJs} not found (running from src?)`);
    return false;
  }
  let logFd: number | null = null;
  try {
    // Beside the socket: XDG_RUNTIME_DIR is tmpfs, so the log cannot grow forever.
    logFd = openSync(path.join(path.dirname(socketPath), "zserver-broker.log"), "a", 0o600);
  } catch {
    /* no log file: the broker's output is dropped */
  }
  try {
    const idleMs = baseEnv.ZCODE_ACP_ZSERVER_BROKER_IDLE_EXIT_MS?.trim();
    const child = spawn(process.execPath, [cliJs, "zserver-broker"], {
      detached: true,
      stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
      env: {
        ...baseEnv,
        ZCODE_ACP_ZSERVER_SOCKET: socketPath,
        ZCODE_ACP_ZSERVER_BROKER_IDLE_EXIT_MS: idleMs || String(DEFAULT_BROKER_IDLE_EXIT_MS),
      },
    });
    // Async spawn failures arrive as 'error'; without a listener Node would
    // crash the bridge.
    child.once("error", (error) => warn(`backend: broker spawn failed: ${error.message}`));
    child.unref();
    log(`backend: started shared broker on ${socketPath} (pid ${child.pid})`);
    return true;
  } catch (error) {
    warn(`backend: broker spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
}

export interface AutoBrokerOptions<T> {
  attach: () => Promise<T>;
  /** Launch a broker; omit to attach only. Returns false when it cannot start. */
  launch?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Attach to the broker; if none is running, launch one and keep retrying the
 * attach. Two bridges racing to launch is fine: bind is exclusive, the loser
 * broker exits, and both attach to the winner. Throws the last attach error so
 * the caller can fall back to a private server.
 */
export async function attachOrLaunchBroker<T>(options: AutoBrokerOptions<T>): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    return await options.attach();
  } catch (first) {
    if (!options.launch || !isBrokerAbsentError(first)) throw first;
    const start = now();
    if (start < cooldownUntil || start - lastSpawnAt < SPAWN_THROTTLE_MS) throw first;
    lastSpawnAt = start;
    if (!options.launch()) {
      cooldownUntil = start + FAILURE_COOLDOWN_MS;
      throw first;
    }
    let last: unknown = first;
    while (now() - start < ATTACH_WAIT_MS) {
      await sleep(ATTACH_POLL_MS);
      try {
        return await options.attach();
      } catch (error) {
        last = error;
        if (!isBrokerAbsentError(error)) throw error;
      }
    }
    cooldownUntil = now() + FAILURE_COOLDOWN_MS;
    throw last;
  }
}
