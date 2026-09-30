import os from "node:os";
import path from "node:path";

/** Default broker socket location. Computed lazily so tests (and a changed
 *  XDG_RUNTIME_DIR) are honoured; {@link DEFAULT_BROKER_SOCKET} is the value at
 *  import time, kept for existing callers. */
export function defaultBrokerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".zcode"), "zserver-broker.sock");
}

export const DEFAULT_BROKER_SOCKET = defaultBrokerSocketPath();

const DISABLED_VALUES = new Set(["off", "0", "false", "none", "disabled"]);

/** `ZCODE_ACP_ZSERVER_SOCKET=off` turns the shared broker off for bridges:
 *  each bridge then spawns a private server (the pre-broker behaviour). */
export function isBrokerDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.ZCODE_ACP_ZSERVER_SOCKET?.trim().toLowerCase();
  return value !== undefined && DISABLED_VALUES.has(value);
}

/** Effective broker socket: ZCODE_ACP_ZSERVER_SOCKET wins on BOTH sides —
 *  clients attach to it and the broker must bind it, otherwise clients silently
 *  fall back to per-process servers and sharing quietly stops working. */
export function resolveBrokerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_ACP_ZSERVER_SOCKET?.trim() || defaultBrokerSocketPath(env);
}
