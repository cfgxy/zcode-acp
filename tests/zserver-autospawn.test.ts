import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZServerBackend } from "../src/backend/zserver/backend.js";
import { ZServerBroker } from "../src/backend/zserver/broker.js";

import {
  attachOrLaunchBroker,
  isBrokerAbsentError,
  resetAutoBrokerState,
} from "../src/backend/zserver/autospawn.js";
import { isBrokerDisabled, resolveBrokerSocketPath } from "../src/backend/zserver/socket-path.js";

const absent = (): Error => Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
const refused = (): Error =>
  Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const warnings = vi.hoisted(() => [] as string[]);
vi.mock("../src/utils.js", async (original) => ({
  ...(await original<typeof import("../src/utils.js")>()),
  warn: (message: string) => {
    warnings.push(message);
  },
}));

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  resetAutoBrokerState();
  warnings.length = 0;
  vi.stubEnv("ZCODE_ACP_ZSERVER_SOCKET", "");
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
  vi.unstubAllEnvs();
});

function stageRuntimeDir(): { dir: string; root: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zauto-"));
  tempDirs.push(dir);
  const root = path.join(dir, "root");
  fs.mkdirSync(root);
  fs.copyFileSync(
    new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
    path.join(root, "zcode-server.cjs"),
  );
  return { dir, root };
}

describe("attachOrLaunchBroker", () => {
  it("attaches without launching when a broker is already there", async () => {
    const launch = vi.fn(() => true);
    const result = await attachOrLaunchBroker({ attach: async () => "conn", launch, ...clock() });
    expect(result).toBe("conn");
    expect(launch).not.toHaveBeenCalled();
  });

  it("launches once when absent, then attaches when the broker comes up", async () => {
    let up = false;
    const attach = vi.fn(async () => {
      if (!up) throw absent();
      return "conn";
    });
    const launch = vi.fn(() => {
      up = true;
      return true;
    });
    const result = await attachOrLaunchBroker({ attach, launch, ...clock() });
    expect(result).toBe("conn");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying while the launched broker is still starting", async () => {
    let calls = 0;
    const attach = async (): Promise<string> => {
      if (++calls < 6) throw refused();
      return "conn";
    };
    const result = await attachOrLaunchBroker({ attach, launch: () => true, ...clock() });
    expect(result).toBe("conn");
    expect(calls).toBe(6);
  });

  it("does not launch for errors other than 'nobody is listening'", async () => {
    const launch = vi.fn(() => true);
    const wedged = Object.assign(new Error("ready timeout"), { code: "ETIMEDOUT" });
    await expect(
      attachOrLaunchBroker({
        attach: async () => {
          throw wedged;
        },
        launch,
        ...clock(),
      }),
    ).rejects.toBe(wedged);
    expect(launch).not.toHaveBeenCalled();
  });

  it("never launches when no launcher is given (explicit socket)", async () => {
    await expect(
      attachOrLaunchBroker({
        attach: async () => {
          throw absent();
        },
        ...clock(),
      }),
    ).rejects.toThrow("ENOENT");
  });

  it("gives up after the wait window and throws so the caller can use a private server", async () => {
    const launch = vi.fn(() => true);
    await expect(
      attachOrLaunchBroker({
        attach: async () => {
          throw absent();
        },
        launch,
        ...clock(),
      }),
    ).rejects.toThrow("ENOENT");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("does not re-launch during the cooldown after a failed launch", async () => {
    const launch = vi.fn(() => true);
    const c = clock();
    const attach = async (): Promise<string> => {
      throw absent();
    };
    await expect(attachOrLaunchBroker({ attach, launch, ...c })).rejects.toThrow();
    await expect(attachOrLaunchBroker({ attach, launch, ...c })).rejects.toThrow();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("a launcher that cannot start fails fast without waiting", async () => {
    const c = clock();
    const before = c.now();
    await expect(
      attachOrLaunchBroker({
        attach: async () => {
          throw absent();
        },
        launch: () => false,
        ...c,
      }),
    ).rejects.toThrow("ENOENT");
    expect(c.now()).toBe(before);
  });
});

describe("isBrokerAbsentError", () => {
  it("only ENOENT/ECONNREFUSED count as absent", () => {
    expect(isBrokerAbsentError(absent())).toBe(true);
    expect(isBrokerAbsentError(refused())).toBe(true);
    expect(isBrokerAbsentError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
    expect(isBrokerAbsentError(new Error("ready timeout"))).toBe(false);
  });
});

describe("socket variable", () => {
  it("off-like values disable the shared broker", () => {
    for (const value of ["off", "OFF", "0", "false", "none", " disabled "]) {
      expect(isBrokerDisabled({ ZCODE_ACP_ZSERVER_SOCKET: value } as never)).toBe(true);
    }
    expect(isBrokerDisabled({} as never)).toBe(false);
    expect(isBrokerDisabled({ ZCODE_ACP_ZSERVER_SOCKET: "/tmp/x.sock" } as never)).toBe(false);
  });

  it("the default path follows XDG_RUNTIME_DIR at call time", () => {
    expect(resolveBrokerSocketPath({ XDG_RUNTIME_DIR: "/run/user/1" } as never)).toBe(
      "/run/user/1/zserver-broker.sock",
    );
  });
});

describe("ZServerBackend default broker wiring", () => {
  it("autoBroker attaches to the default socket (no env needed)", async () => {
    const { dir, root } = stageRuntimeDir();
    vi.stubEnv("XDG_RUNTIME_DIR", dir);
    const broker = new ZServerBroker(path.join(dir, "zserver-broker.sock"), root);
    await broker.start();
    cleanups.push(() => broker.stop());

    const backend = new ZServerBackend({
      serverRoot: "/nonexistent-direct-spawn-root",
      autoBroker: true,
    });
    cleanups.push(() => backend.close());
    const response = await backend.request(1, "session/create", {
      workspace: { workspacePath: "/tmp" },
    });
    // A private spawn from the nonexistent root would have failed.
    expect(response.error).toBeUndefined();
  });

  it("without autoBroker the default socket is never touched", async () => {
    const { dir, root } = stageRuntimeDir();
    vi.stubEnv("XDG_RUNTIME_DIR", dir);
    const broker = new ZServerBroker(path.join(dir, "zserver-broker.sock"), root);
    await broker.start();
    cleanups.push(() => broker.stop());

    const backend = new ZServerBackend({ serverRoot: "/nonexistent-direct-spawn-root" });
    cleanups.push(() => backend.close());
    const response = await backend.request(1, "session/create", {
      workspace: { workspacePath: "/tmp" },
    });
    // Private spawn from the nonexistent root: the live broker was not used.
    expect(response.error?.message).toContain("bundle not found");
  });

  it("ZCODE_ACP_ZSERVER_SOCKET=off skips the broker even with autoBroker", async () => {
    const { dir, root } = stageRuntimeDir();
    vi.stubEnv("XDG_RUNTIME_DIR", dir);
    vi.stubEnv("ZCODE_ACP_ZSERVER_SOCKET", "off");
    const broker = new ZServerBroker(path.join(dir, "zserver-broker.sock"), root);
    await broker.start();
    cleanups.push(() => broker.stop());

    const backend = new ZServerBackend({
      serverRoot: "/nonexistent-direct-spawn-root",
      autoBroker: true,
    });
    cleanups.push(() => backend.close());
    const response = await backend.request(1, "session/create", {
      workspace: { workspacePath: "/tmp" },
    });
    // Private spawn from the nonexistent root: the live broker was not used.
    expect(response.error?.message).toContain("bundle not found");
    // "off" is a switch, not a socket path: nothing may even try to attach to it.
    expect(warnings.filter((w) => w.includes("broker attach failed"))).toEqual([]);
  });
});
