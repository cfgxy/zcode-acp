import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = [];

vi.mock("../src/backend/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/backend/index.js")>();
  class FakeBackend {
    isDead = false;
    constructor(argv: string[], env: NodeJS.ProcessEnv) {
      spawned.push({ argv, env });
    }
  }
  return {
    ...actual,
    ZcodeBackend: FakeBackend,
    resolveZcodeCommand: () => ["zcode", "app-server", "--stdio"],
  };
});

vi.mock("../src/desktop-profile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/desktop-profile.js")>();
  return { ...actual, loadDesktopChildEnvWithRefresh: () => ({ DESKTOP_PROFILE_MARKER: "1" }) };
});

const { ZcodeAcpServer } = await import("../src/server.js");

describe("ensureBackend backend choice", () => {
  const saved = new Map<string, string | undefined>();
  const keys = ["ZCODE_ACP_BACKEND", "MULTICA_TOKEN"];

  beforeEach(() => {
    spawned.length = 0;
    for (const key of keys) saved.set(key, process.env[key]);
    delete process.env.ZCODE_ACP_BACKEND;
    process.env.MULTICA_TOKEN = "mat_task_a";
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("defaults to thin: per-task MULTICA_TOKEN kept, no desktop profile overlay", () => {
    new ZcodeAcpServer().ensureBackend();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.env.MULTICA_TOKEN).toBe("mat_task_a");
    expect(spawned[0]!.env.DESKTOP_PROFILE_MARKER).toBeUndefined();
  });

  it("ZCODE_ACP_BACKEND=thin behaves like the default", () => {
    process.env.ZCODE_ACP_BACKEND = "thin";
    new ZcodeAcpServer().ensureBackend();
    expect(spawned[0]!.env.DESKTOP_PROFILE_MARKER).toBeUndefined();
  });

  it("ZCODE_ACP_BACKEND=direct keeps the desktop-profile path", () => {
    process.env.ZCODE_ACP_BACKEND = "direct";
    new ZcodeAcpServer().ensureBackend();
    expect(spawned[0]!.env.DESKTOP_PROFILE_MARKER).toBe("1");
    expect(spawned[0]!.env.MULTICA_TOKEN).toBe("mat_task_a");
  });

  it("a stale ZCODE_ACP_BACKEND=zserver falls back to thin", () => {
    process.env.ZCODE_ACP_BACKEND = "zserver";
    new ZcodeAcpServer().ensureBackend();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.env.DESKTOP_PROFILE_MARKER).toBeUndefined();
    expect(spawned[0]!.env.MULTICA_TOKEN).toBe("mat_task_a");
  });
});
