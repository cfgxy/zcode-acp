import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDesktopBackendEnv } from "../src/server.js";

describe("loadDesktopBackendEnv merge semantics", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ["MULTICA_TASK_ID", "MULTICA_TOKEN", "MULTICA_AGENT_ID", "PATH", "ZCODE_MODEL"]) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const profile = {
    PATH: "/desktop/bin:/usr/bin",
    ZCODE_ENV: "desktop",
    HOME: "/home/guxy",
  };

  it("desktop profile alone, when not spawned by a Multica daemon", () => {
    const env = loadDesktopBackendEnv(profile);
    expect(env.PATH).toBe("/desktop/bin:/usr/bin");
    expect(env.ZCODE_ENV).toBe("desktop");
    expect(env.MULTICA_TOKEN).toBeUndefined();
  });

  it("daemon MULTICA_* survive the merge (no conflict with the profile)", () => {
    process.env.MULTICA_TASK_ID = "01a0890d";
    process.env.MULTICA_TOKEN = "mat_test123";
    process.env.MULTICA_AGENT_ID = "43324e0c";
    const env = loadDesktopBackendEnv(profile);
    expect(env.MULTICA_TOKEN).toBe("mat_test123");
    expect(env.MULTICA_TASK_ID).toBe("01a0890d");
    expect(env.MULTICA_AGENT_ID).toBe("43324e0c");
  });

  it("desktop profile wins conflicts (free-tier identity markers)", () => {
    process.env.MULTICA_TASK_ID = "01a0890d";
    process.env.PATH = "/daemon/bin";
    const env = loadDesktopBackendEnv(profile);
    expect(env.PATH).toBe("/desktop/bin:/usr/bin");
    expect(env.ZCODE_ENV).toBe("desktop");
    expect(env.MULTICA_TASK_ID).toBe("01a0890d");
  });
});
