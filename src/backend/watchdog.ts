/**
 * The backend watchdog, as a hidden CLI subcommand.
 *
 * Historically the watchdog body was an inline `node -e` script string built
 * in ZcodeBackend.startWatchdog — functional, but the whole script rode along
 * in the child cmdline (Owner feedback, RUYI-584). The body now lives here and
 * runs as `cli.js __zcode-watchdog <bridgePid> <zcodePid>`, mirroring the
 * engine's `__zcode-plugin-host` hidden-subcommand pattern; `process.title`
 * keeps the e1671c4 display name so ps stays readable.
 *
 * Behavior contract (unchanged from the inline version): poll the bridge pid
 * every 2s; once the bridge is gone, SIGKILL the zcode process group and
 * exit; if the zcode group disappears first, exit — a normal shutdown leaves
 * no lingering watchdog. kill/exit are injectable so tests can assert the
 * decisions without touching real process groups.
 */

import process from "node:process";

export interface WatchdogDeps {
  kill: (pid: number, signal?: string | number) => boolean;
  exit: (code?: number) => void;
}

function defaultWatchdogDeps(): WatchdogDeps {
  return {
    kill: (pid, signal) => process.kill(pid, signal as number | undefined),
    exit: (code) => process.exit(code),
  };
}

/**
 * Spawn argv for the watchdog child: `<entry> __zcode-watchdog <bridgePid>
 * <zcodePid>`. `entry` is the bridge's own `process.argv[1]` (dist/cli.js in
 * production), so the child always mirrors the running CLI build.
 */
export function watchdogSpawnArgv(entryPath: string, bridgePid: number, zcodePid: number): string[] {
  return [entryPath, "__zcode-watchdog", String(bridgePid), String(zcodePid)];
}

/**
 * One watchdog poll. Returns "continue" to keep polling; exits the process
 * (via deps) on either terminal condition. Logic mirrors the retired inline
 * script line for line.
 */
export function watchdogTick(
  bridgePid: number,
  zcodePid: number,
  deps: WatchdogDeps = defaultWatchdogDeps(),
): "continue" {
  // Bridge gone? → reap the whole zcode process group, then exit.
  try {
    deps.kill(bridgePid, 0);
  } catch {
    try {
      deps.kill(-zcodePid, "SIGKILL");
    } catch {
      // zcode group already gone — nothing left to reap.
    }
    deps.exit(0);
    return "continue";
  }
  // zcode already exited? → watchdog has no job left.
  try {
    deps.kill(-zcodePid, 0);
  } catch {
    deps.exit(0);
    return "continue";
  }
  return "continue";
}

/**
 * Subcommand entry (`cli.js __zcode-watchdog <bridgePid> <zcodePid>`). Never
 * returns under a real runtime: it polls until one of the terminal conditions
 * fires. Malformed argv exits 2.
 */
export function runWatchdog(argv: readonly string[], deps: WatchdogDeps = defaultWatchdogDeps()): void {
  const bridgePid = Number(argv[0]);
  const zcodePid = Number(argv[1]);
  if (!Number.isInteger(bridgePid) || bridgePid <= 0 || !Number.isInteger(zcodePid) || zcodePid <= 0) {
    process.stderr.write("zcode-acp: usage: cli.js __zcode-watchdog <bridgePid> <zcodePid>\n");
    deps.exit(2);
    return;
  }
  process.title = "zcode-acp-watchdog"; // ps/可读性：显示名与 inline 版一致（e1671c4）
  const tick = () => watchdogTick(bridgePid, zcodePid, deps);
  setInterval(tick, 2000);
  tick();
}
