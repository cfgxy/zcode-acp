/**
 * Tests for the hidden `__zcode-watchdog` subcommand (src/backend/watchdog.ts).
 *
 * The watchdog body used to be an inline `node -e` script spawned from
 * src/backend/client.ts — a huge cmdline (RUYI-584 Owner feedback). It now
 * lives in this module and runs as `cli.js __zcode-watchdog <bridgePid>
 * <zcodePid>`. Behavior equivalence is asserted with injected kill/exit deps,
 * so the unit suite never sends real process-group signals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWatchdog, watchdogSpawnArgv, watchdogTick } from "../src/backend/watchdog.js";

function mockDeps() {
  return { kill: vi.fn(() => true), exit: vi.fn(() => undefined) };
}

describe("watchdogTick", () => {
  it("keeps polling while both the bridge and the zcode group are alive", () => {
    const deps = mockDeps();
    expect(watchdogTick(100, 200, deps)).toBe("continue");
    expect(deps.kill).toHaveBeenCalledTimes(2);
    expect(deps.kill).toHaveBeenNthCalledWith(1, 100, 0);
    expect(deps.kill).toHaveBeenNthCalledWith(2, -200, 0);
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it("kills the zcode process group and exits when the bridge disappears", () => {
    const deps = mockDeps();
    deps.kill.mockImplementation((pid: number) => {
      if (pid === 100) throw new Error("ESRCH"); // bridge gone
      return true;
    });
    watchdogTick(100, 200, deps);
    expect(deps.kill).toHaveBeenCalledWith(-200, "SIGKILL");
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it("exits without signaling when the zcode group is already gone", () => {
    const deps = mockDeps();
    deps.kill.mockImplementation((pid: number) => {
      if (pid === -200) throw new Error("ESRCH"); // zcode group gone
      return true;
    });
    watchdogTick(100, 200, deps);
    expect(deps.exit).toHaveBeenCalledWith(0);
    expect(deps.kill).not.toHaveBeenCalledWith(-200, "SIGKILL");
  });
});

describe("runWatchdog (subcommand entry)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects malformed argv with exit code 2", () => {
    const deps = mockDeps();
    runWatchdog(["not-a-pid"], deps);
    expect(deps.exit).toHaveBeenCalledWith(2);
  });

  it("sets the display title and polls every 2s via injected deps", () => {
    const deps = mockDeps();
    const prevTitle = process.title;
    try {
      runWatchdog(["100", "200"], deps);
      expect(process.title).toBe("zcode-acp-watchdog"); // e1671c4 behavior kept
      expect(deps.kill).toHaveBeenCalledTimes(2); // immediate first tick: bridge + group probes
      vi.advanceTimersByTime(2000);
      expect(deps.kill).toHaveBeenCalledTimes(4);
      vi.advanceTimersByTime(4000);
      expect(deps.kill).toHaveBeenCalledTimes(8);
      expect(deps.exit).not.toHaveBeenCalled();
    } finally {
      process.title = prevTitle;
    }
  });
});

describe("watchdogSpawnArgv", () => {
  it("builds the short hidden-subcommand argv (no inline -e script)", () => {
    expect(watchdogSpawnArgv("/opt/acp/dist/cli.js", 111, 222)).toEqual([
      "/opt/acp/dist/cli.js",
      "__zcode-watchdog",
      "111",
      "222",
    ]);
  });
});
