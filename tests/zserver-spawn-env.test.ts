import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ZServerBroker } from "../src/backend/zserver/broker.js";
import { ZServerConnection, ZServerConnectionError } from "../src/backend/zserver/connection.js";

// `spawn` is a passthrough unless a test installs a hook, so the broker test below still starts
// a real (fixture) server. The desktop profile is pinned to a scripted value: the real one would
// read this machine's ZCode installation.
const hook = vi.hoisted(() => ({
  spawn: null as null | ((command: string, args: string[]) => unknown),
  pin: undefined as string | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) =>
      hook.spawn
        ? (hook.spawn(args[0] as string, args[1] as string[]) as ReturnType<typeof real.spawn>)
        : real.spawn(...args),
  };
});

vi.mock("../src/desktop-profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/desktop-profile.js")>()),
  loadDesktopChildEnvWithRefresh: () =>
    hook.pin === undefined ? {} : { ZCODE_SERVER_RUNTIME_ROOT: hook.pin },
}));

const tempDirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  hook.spawn = null;
  hook.pin = undefined;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A root that contains a bundle (its content never runs: `spawn` is scripted). */
function rootWithBundle(): string {
  const root = tempDir("zspawn-root-");
  fs.writeFileSync(path.join(root, "zcode-server.cjs"), "//");
  return root;
}

function fixtureRoot(): string {
  const root = tempDir("zspawn-fixture-");
  fs.copyFileSync(
    new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
    path.join(root, "zcode-server.cjs"),
  );
  return root;
}

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`spawn node ${code}`), { code });

/** What `child_process.spawn` returns when it fails asynchronously with a pid-less child. */
function failedChild(code: string): EventEmitter {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    killed: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  process.nextTick(() => child.emit("error", errno(code)));
  return child;
}

/** What `child_process.spawn` returns on EMFILE/ENFILE: it bails out BEFORE creating the stdio
 *  pipes, so the streams are null, and schedules an 'error' event for the next tick. */
function streamlessChild(code: string): EventEmitter {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    killed: false,
    stdin: null,
    stdout: null,
    stderr: null,
    kill: () => true,
  });
  process.nextTick(() => child.emit("error", errno(code)));
  return child;
}

describe("spawn errno classification", () => {
  it("EMFILE/ENFILE (no stdio pipes) is reported for what it is, and is retryable", async () => {
    const children: EventEmitter[] = [];
    hook.spawn = () => {
      const child = streamlessChild("EMFILE");
      children.push(child);
      return child;
    };
    const error = await ZServerConnection.spawn({ serverRoot: rootWithBundle() }).catch(
      (e: unknown) => e,
    );
    // Not a bare "Cannot read properties of undefined (reading 'on')" TypeError.
    expect(error).toBeInstanceOf(ZServerConnectionError);
    expect((error as ZServerConnectionError).message).toMatch(/EMFILE\/ENFILE/);
    // Out of descriptors is momentary: it must not be filed under "the binary cannot start".
    expect((error as ZServerConnectionError).phase).toBe("hello");
    // Node still emits the scheduled 'error' one tick later; with nobody listening that is an
    // uncaught exception that kills the bridge.
    expect(children[0]!.listenerCount("error")).toBeGreaterThan(0);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("EAGAIN (a momentary shortage of processes) is retryable, not a permanent spawn failure", async () => {
    hook.spawn = () => failedChild("EAGAIN");
    const error = await ZServerConnection.spawn({ serverRoot: rootWithBundle() }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZServerConnectionError);
    expect((error as ZServerConnectionError).phase).toBe("hello");
  }, 20000);

  it("ENOENT stays a permanent spawn failure", async () => {
    hook.spawn = () => failedChild("ENOENT");
    const error = await ZServerConnection.spawn({ serverRoot: rootWithBundle() }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZServerConnectionError);
    expect((error as ZServerConnectionError).phase).toBe("spawn");
  }, 20000);

  it("EACCES stays a permanent spawn failure", async () => {
    hook.spawn = () => failedChild("EACCES");
    const error = await ZServerConnection.spawn({ serverRoot: rootWithBundle() }).catch(
      (e: unknown) => e,
    );
    expect((error as ZServerConnectionError).phase).toBe("spawn");
  }, 20000);
});

describe("which server root a spawn uses", () => {
  function captureBundle(): string[] {
    const seen: string[] = [];
    hook.spawn = (_command, args) => {
      seen.push(args[0]!);
      return failedChild("ENOENT"); // the bundle path is all these tests look at
    };
    return seen;
  }

  it("a blank serverRoot option is 'unset': the env value is used, not the current directory", async () => {
    const root = rootWithBundle();
    const seen = captureBundle();
    await ZServerConnection.spawn({
      serverRoot: "   ",
      env: { ZCODE_SERVER_RUNTIME_ROOT: root },
    }).catch(() => undefined);
    // path.resolve("   ") is "<cwd>/   " — the lookup used to depend on where the bridge started.
    expect(seen).toEqual([path.join(root, "zcode-server.cjs")]);
  }, 20000);

  it("a blank env value with no option falls back to the default install location", async () => {
    const home = tempDir("zspawn-home-");
    const bundle = path.join(home, ".zcode", "server", "zcode-server.cjs");
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, "//");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const seen = captureBundle();
    await ZServerConnection.spawn({ env: { ZCODE_SERVER_RUNTIME_ROOT: "" } }).catch(
      () => undefined,
    );
    expect(seen).toEqual([bundle]);
  }, 20000);

  it("an explicit serverRoot beats the env value", async () => {
    const explicit = rootWithBundle();
    const fromEnv = rootWithBundle();
    const seen = captureBundle();
    await ZServerConnection.spawn({
      serverRoot: explicit,
      env: { ZCODE_SERVER_RUNTIME_ROOT: fromEnv },
    }).catch(() => undefined);
    expect(seen).toEqual([path.join(explicit, "zcode-server.cjs")]);
  }, 20000);

  it("a missing bundle names the path and how to fix it", async () => {
    const empty = tempDir("zspawn-empty-");
    const error = await ZServerConnection.spawn({ serverRoot: empty }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZServerConnectionError);
    expect((error as ZServerConnectionError).phase).toBe("spawn");
    const message = (error as ZServerConnectionError).message;
    expect(message).toContain(path.join(empty, "zcode-server.cjs"));
    expect(message).toMatch(/install ZCode/);
    expect(message).toContain("ZCODE_SERVER_RUNTIME_ROOT");
  });
});

describe("the broker resolves the server root like the bridge does", () => {
  it("the operator's ZCODE_SERVER_RUNTIME_ROOT beats the desktop profile's pin", async () => {
    const operatorRoot = fixtureRoot(); // a working server
    const pinnedRoot = tempDir("zspawn-pin-"); // a server that dies at once
    fs.writeFileSync(path.join(pinnedRoot, "zcode-server.cjs"), "process.exit(3);\n");
    hook.pin = pinnedRoot;
    const previous = process.env.ZCODE_SERVER_RUNTIME_ROOT;
    process.env.ZCODE_SERVER_RUNTIME_ROOT = operatorRoot;
    cleanups.push(() => {
      if (previous === undefined) delete process.env.ZCODE_SERVER_RUNTIME_ROOT;
      else process.env.ZCODE_SERVER_RUNTIME_ROOT = previous;
    });

    const dir = tempDir("zspawn-sock-");
    const socketPath = path.join(dir, "b.sock");
    const broker = new ZServerBroker(socketPath); // no explicit root: the env / pin decide
    await broker.start();
    cleanups.push(() => broker.stop());

    const connection = await ZServerConnection.attach({ socketPath, clientId: "root-precedence" });
    cleanups.push(() => connection.dispose());
    // Answered by the operator's (working) server. Had the pin won, the shared server would have
    // exited with code 3 and this attach/call would have failed.
    await expect(connection.channelOf("zcode-task").call("listTasks")).resolves.toBeDefined();
  }, 30000);
});
