import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZServerBroker } from "../src/backend/zserver/broker.js";
import { ZServerBackend } from "../src/backend/zserver/backend.js";
import {
  buildWatchdogScript,
  ZServerConnection,
  ZServerConnectionError,
} from "../src/backend/zserver/connection.js";
import { assertSocketPathFits, resolveBrokerSocketPath } from "../src/backend/zserver/broker.js";

const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

function makeRoot(fixtureEnv?: Record<string, string>): string {
  void fixtureEnv;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-life-"));
  tempDirs.push(root);
  fs.copyFileSync(
    new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
    path.join(root, "zcode-server.cjs"),
  );
  return root;
}

describe("watchdog script (real execution)", () => {
  it("rejects non-integer pids (no string interpolation into node -e)", () => {
    expect(() => buildWatchdogScript(NaN, 5)).toThrow();
    expect(() => buildWatchdogScript(5, undefined as unknown as number)).toThrow();
    expect(() => buildWatchdogScript(-1, 5)).toThrow();
    expect(() => buildWatchdogScript(1, 2.5)).toThrow();
  });

  it("exits on its own once the owner is gone and reaps the group (no immortal orphan)", async () => {
    // Owner: a short-lived process we control. Victim: a detached sleeper group.
    const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    victim.unref();
    const owner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const watchdog = spawn(process.execPath, ["-e", buildWatchdogScript(owner.pid!, victim.pid!)], {
      stdio: "ignore",
      detached: true,
    });
    watchdog.unref();
    cleanups.push(() => {
      for (const p of [victim.pid, owner.pid, watchdog.pid]) {
        try {
          if (p) process.kill(p, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    });

    expect(alive(victim.pid!)).toBe(true);
    owner.kill("SIGKILL"); // owner dies WITHOUT cleanup — the Zed force-kill case
    // Group reaped...
    expect(await until(() => !alive(victim.pid!), 6000)).toBe(true);
    // ...AND the watchdog itself terminates (the bug: it lived forever).
    expect(await until(() => !alive(watchdog.pid!), 6000)).toBe(true);
  }, 20000);

  it("does not multiply timers while the owner is alive (exit-code-free steady state)", async () => {
    const owner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
    });
    victim.unref();
    // Instrumented copy: count ticks per second to prove linear (not doubling) growth.
    const instrumented =
      buildWatchdogScript(owner.pid!, victim.pid!).replace(
        "const tick = () => {",
        "let n = 0; setInterval(() => { process.stdout.write('T'); }, 1e9).unref(); const tick = () => { n++; if (n % 1 === 0) process.stderr.write('t');",
      ) + "";
    const watchdog = spawn(process.execPath, ["-e", instrumented.replace("2000", "100")], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    watchdog.unref();
    cleanups.push(() => {
      for (const p of [victim.pid, owner.pid, watchdog.pid]) {
        try {
          if (p) process.kill(p, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    });
    let ticks = 0;
    watchdog.stderr!.on("data", (d: Buffer) => {
      ticks += d.length;
    });
    await new Promise((r) => setTimeout(r, 1500));
    // 100ms period over 1.5s = ~15 ticks. The doubling bug produced >1000.
    expect(ticks).toBeGreaterThan(5);
    expect(ticks).toBeLessThan(60);
  }, 15000);
});

describe("connection lifecycle regressions", () => {
  it("handshake failure disposes the spawned child (no leaked server process)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-nohello-"));
    tempDirs.push(root);
    const pidFile = path.join(root, "pid.json");
    // Bundle that records its pid then never says hello → hello timeout (10s).
    fs.writeFileSync(
      path.join(root, "zcode-server.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
        "setInterval(()=>{},1000);\n",
    );
    await expect(ZServerConnection.spawn({ serverRoot: root })).rejects.toBeInstanceOf(
      ZServerConnectionError,
    );
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    cleanups.push(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    });
    // The failed handshake must have torn the child down (M-G: no dispose → alive).
    expect(await until(() => !alive(pid), 6000)).toBe(true);
  }, 30000);

  it("a crashing bundle's stderr text reaches the error message", async () => {
    const root = makeRoot();
    fs.writeFileSync(
      path.join(root, "zcode-server.cjs"),
      'console.error("无法定位 provider config"); process.exit(3);\n',
    );
    await expect(ZServerConnection.spawn({ serverRoot: root })).rejects.toThrow(
      /无法定位 provider config/,
    );
  });

  it("ENOENT/EACCES-style spawn errors fail FAST via the error→exit route (not the 10s hello timeout)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-noexec-"));
    tempDirs.push(root);
    // A "node" that exists but cannot execute → async spawn error, no 'exit'.
    fs.writeFileSync(path.join(root, "node"), "not an executable");
    fs.chmodSync(path.join(root, "node"), 0o644);
    fs.writeFileSync(path.join(root, "zcode-server.cjs"), "//");
    const startedAt = Date.now();
    await expect(ZServerConnection.spawn({ serverRoot: root })).rejects.toBeInstanceOf(
      ZServerConnectionError,
    );
    expect(Date.now() - startedAt).toBeLessThan(4000);
  }, 20000);

  it("dispose group-kills the whole tree: the grandchild dies, not just the leader", async () => {
    const root = makeRoot();
    const pidFile = path.join(root, "pids.json");
    process.env.ZSERVER_FAKE_PID_FILE = pidFile;
    let connection: ZServerConnection | undefined;
    try {
      connection = await ZServerConnection.spawn({ serverRoot: root });
      expect(await until(() => fs.existsSync(pidFile), 5000)).toBe(true);
      const { leader, grandchild } = JSON.parse(fs.readFileSync(pidFile, "utf8")) as {
        leader: number;
        grandchild: number;
      };
      cleanups.push(() => {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          /* already gone */
        }
      });
      expect(alive(leader) && alive(grandchild)).toBe(true);
      // Escalation pushed far beyond the assertion window: ONLY the initial
      // group SIGTERM can explain the grandchild dying inside it. (With the
      // default 5s escalation a leader-only SIGTERM was masked by the later
      // group SIGKILL — the mutation survived until this was isolated.)
      process.env.ZCODE_ACP_ZSERVER_KILL_ESCALATION_MS = "600000";
      connection.dispose();
      expect(await until(() => !alive(leader), 3000)).toBe(true);
      expect(await until(() => !alive(grandchild), 3000)).toBe(true);
    } finally {
      delete process.env.ZSERVER_FAKE_PID_FILE;
      delete process.env.ZCODE_ACP_ZSERVER_KILL_ESCALATION_MS;
    }
  }, 30000);

  it("SIGTERM-ignoring server is SIGKILL-escalated (the group dies, not just politely asked)", async () => {
    const root = makeRoot();
    const pidFile = path.join(root, "pids.json");
    process.env.ZSERVER_FAKE_PID_FILE = pidFile;
    process.env.ZSERVER_FAKE_IGNORE_SIGTERM = "1";
    process.env.ZCODE_ACP_ZSERVER_KILL_ESCALATION_MS = "300";
    let connection: ZServerConnection | undefined;
    try {
      connection = await ZServerConnection.spawn({ serverRoot: root });
      expect(await until(() => fs.existsSync(pidFile), 5000)).toBe(true);
      const { leader, grandchild } = JSON.parse(fs.readFileSync(pidFile, "utf8")) as {
        leader: number;
        grandchild: number;
      };
      cleanups.push(() => {
        for (const p of [leader, grandchild]) {
          try {
            process.kill(p, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      });
      connection.dispose();
      await new Promise((r) => setTimeout(r, 150));
      expect(alive(leader)).toBe(true); // SIGTERM was ignored — escalation not yet due
      expect(await until(() => !alive(leader) && !alive(grandchild), 4000)).toBe(true);
    } finally {
      delete process.env.ZSERVER_FAKE_PID_FILE;
      delete process.env.ZSERVER_FAKE_IGNORE_SIGTERM;
      delete process.env.ZCODE_ACP_ZSERVER_KILL_ESCALATION_MS;
    }
  }, 30000);

  it("escalation outlives the leader: a SIGTERM-immune grandchild is SIGKILLed after the leader exited", async () => {
    // Leader exits politely on SIGTERM; grandchild ignores it. The escalation
    // timer must NOT be cancelled by the leader's exit (old bug: it was), and
    // must kill the GROUP (a leader-only kill can't reach the grandchild).
    const root = makeRoot();
    const pidFile = path.join(root, "pids.json");
    process.env.ZSERVER_FAKE_PID_FILE = pidFile;
    process.env.ZSERVER_FAKE_GRANDCHILD_IGNORES_SIGTERM = "1";
    process.env.ZCODE_ACP_ZSERVER_KILL_ESCALATION_MS = "500";
    let connection: ZServerConnection | undefined;
    try {
      connection = await ZServerConnection.spawn({ serverRoot: root });
      expect(await until(() => fs.existsSync(pidFile), 5000)).toBe(true);
      const { leader, grandchild } = JSON.parse(fs.readFileSync(pidFile, "utf8")) as {
        leader: number;
        grandchild: number;
      };
      cleanups.push(() => {
        for (const p of [leader, grandchild]) {
          try {
            process.kill(p, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      });
      connection.dispose();
      expect(await until(() => !alive(leader), 3000)).toBe(true); // leader gone on SIGTERM
      expect(alive(grandchild)).toBe(true); // immune grandchild survives SIGTERM
      // Escalation (500ms) fires after the leader is already dead and kills the group.
      expect(await until(() => !alive(grandchild), 4000)).toBe(true);
    } finally {
      delete process.env.ZSERVER_FAKE_PID_FILE;
      delete process.env.ZSERVER_FAKE_GRANDCHILD_IGNORES_SIGTERM;
      delete process.env.ZCODE_ACP_ZSERVER_KILL_ESCALATION_MS;
    }
  }, 30000);

  it("hello line and Initialize frame arriving in ONE chunk both survive", async () => {
    const root = makeRoot();
    // Fixture variant: write the ack response (Initialize) immediately with hello.
    const fixture = fs.readFileSync(path.join(root, "zcode-server.cjs"), "utf8");
    fs.writeFileSync(
      path.join(root, "zcode-server.cjs"),
      fixture.replace(
        "let acc = Buffer.alloc(0);",
        "process.env.ZSERVER_COALESCE = '1'; let acc = Buffer.alloc(0);",
      ),
    );
    const connection = await ZServerConnection.spawn({ serverRoot: root });
    try {
      await expect(connection.call("initialize", { x: 1 })).resolves.toContain("echo:initialize");
    } finally {
      connection.dispose();
    }
  });
});

describe("backend lifecycle regressions", () => {
  it("a failed spawn sets the spawn-failed wire prefix and is retryable when the root becomes valid", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-retry-"));
    tempDirs.push(root);
    const backend = new ZServerBackend({ serverRoot: root }); // no bundle yet
    const first = await backend.request(1, "session/list", {});
    expect(first.error).toBeDefined();
    expect(backend.deathReason).toMatch(/^spawn failed:/);
    // Make the root valid; a cached-rejection bug would keep failing forever.
    fs.copyFileSync(
      new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
      path.join(root, "zcode-server.cjs"),
    );
    const second = await backend.request(2, "session/list", {});
    expect(second.error).toBeUndefined();
    await backend.close();
  });

  it("a retired connection's late exit does not poison the fresh connection", async () => {
    // Old child takes 600ms to die after SIGTERM: the NEW spawn (which clears
    // `closing`) is guaranteed to finish BEFORE the old exit event lands.
    process.env.ZSERVER_FAKE_SLOW_EXIT_MS = "600";
    const root = makeRoot();
    const backend = new ZServerBackend({ serverRoot: root });
    try {
      await backend.request(1, "session/list", {});
      const oldConn = (backend as unknown as { connection: { child: { pid: number } } }).connection;
      const oldPid = oldConn.child.pid;
      await backend.restart("test");
      // Old child must STILL be alive here (else the race window never opened
      // and this test would be vacuous).
      expect(alive(oldPid)).toBe(true);
      expect(await until(() => !alive(oldPid), 3000)).toBe(true); // old exit lands...
      expect(backend.isDead).toBe(false); // ...and must not mark the fresh connection dead
      const after = await backend.request(2, "session/list", {});
      expect(after.error).toBeUndefined();
    } finally {
      delete process.env.ZSERVER_FAKE_SLOW_EXIT_MS;
      await backend.close();
    }
  }, 20000);

  it("idle recycling never closes the connection under an in-flight request", async () => {
    process.env.ZCODE_ACP_ZSERVER_IDLE_MS = "50";
    const root = makeRoot();
    process.env.ZSERVER_FAKE_HANG_METHODS = "listTasks";
    const backend = new ZServerBackend({ serverRoot: root });
    try {
      // Request hangs 600ms (> idleMs=50ms×several) then times out — the idle
      // timer must keep re-arming rather than nulling the connection mid-flight.
      const response = await backend.request(1, "session/list", {}, 600);
      expect(response.error?.message).toBe("timeout");
      expect((response.error?.message ?? "").includes("channelOf")).toBe(false);
    } finally {
      delete process.env.ZCODE_ACP_ZSERVER_IDLE_MS;
      delete process.env.ZSERVER_FAKE_HANG_METHODS;
      await backend.close();
    }
  }, 20000);
});

describe("broker path handling", () => {
  it("resolveBrokerSocketPath honors ZCODE_ACP_ZSERVER_SOCKET (client and broker agree)", () => {
    expect(resolveBrokerSocketPath({ ZCODE_ACP_ZSERVER_SOCKET: "/tmp/x.sock" } as never)).toBe(
      "/tmp/x.sock",
    );
    expect(resolveBrokerSocketPath({} as never)).toMatch(/zserver-broker\.sock$/);
  });

  it("rejects socket paths beyond sun_path instead of silently truncating", () => {
    expect(() => assertSocketPathFits("/tmp/" + "x".repeat(140) + ".sock")).toThrow(/shorter path/);
    expect(() => assertSocketPathFits("/tmp/ok.sock")).not.toThrow();
  });

  it("broker start() surfaces the path-length error clearly", async () => {
    const broker = new ZServerBroker("/tmp/" + "y".repeat(140) + ".sock");
    await expect(broker.start()).rejects.toThrow(/bytes \(limit/);
  });
});
