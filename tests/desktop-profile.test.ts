import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withDesktopSurface } from "../src/backend/resolve.js";
import {
  buildDesktopChildEnv,
  captureDesktopProfile,
  DESKTOP_PROFILE_ENV_KEYS,
  DesktopProfileError,
  desktopProfilePath,
  type DesktopProfileFs,
  type DesktopProfileRuntime,
  isSensitiveEnvKey,
  loadDesktopChildEnvWithRefresh,
  loadDesktopProfile,
  parseDesktopProfile,
  sanitizeDesktopEnv,
  writeDesktopProfile,
} from "../src/desktop-profile.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

function procStat(pid: number, comm: string, parentPid: number, startTime: string): string {
  const fields = ["S", String(parentPid), ...Array(17).fill("0"), startTime];
  return `${pid} (${comm}) ${fields.join(" ")}\n`;
}

function procRuntime(
  candidateEnvs: Array<{ env: string; pid: number }> = [
    { env: "ZCODE_ENV=desktop\0ZCODE_BASE_URL=https://api.example.test/v1\0", pid: 200 },
  ],
  persistedProfile?: unknown,
): DesktopProfileRuntime {
  const files = new Map<string, string>([
    ["/proc/sys/kernel/random/boot_id", "boot-test\n"],
    ["/proc/100/stat", procStat(100, "node", 1, "1000")],
    ["/proc/100/cmdline", "node\0/opt/ZCode/zcode-server.cjs\0"],
    ["/proc/100/comm", "node\n"],
  ]);
  for (const candidate of candidateEnvs) {
    files.set(`/proc/${candidate.pid}/stat`, procStat(candidate.pid, "zcode-cli", 100, "2000"));
    files.set(`/proc/${candidate.pid}/status`, "Name:\tzcode-cli\nUid:\t1000\t1000\t1000\t1000\n");
    files.set(`/proc/${candidate.pid}/cmdline`, "node\0/opt/ZCode/zcode-cli\0");
    files.set(`/proc/${candidate.pid}/comm`, "zcode-cli\n");
    files.set(`/proc/${candidate.pid}/environ`, candidate.env);
  }
  if (persistedProfile !== undefined) {
    files.set(
      "/home/test/.config/zcode-acp/desktop-profile.json",
      JSON.stringify(persistedProfile),
    );
  }
  const pendingWrites = new Map<number, { path: string; data: string }>();
  const fakeFs = {
    chmodSync(): void {},
    closeSync(fd: number): void {
      const pending = pendingWrites.get(fd);
      if (pending) files.set(pending.path, pending.data);
    },
    existsSync(filePath: string): boolean {
      return files.has(filePath);
    },
    fsyncSync(): void {},
    mkdirSync(): void {},
    openSync(filePath: string): number {
      pendingWrites.set(1, { path: filePath, data: "" });
      return 1;
    },
    readFileSync(filePath: string): string {
      const value = files.get(filePath);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    readdirSync(dirPath: string): string[] {
      if (dirPath !== "/proc") throw new Error("unexpected directory");
      return ["self", "100", ...candidateEnvs.map((candidate) => String(candidate.pid))];
    },
    renameSync(oldPath: string, newPath: string): void {
      const value = files.get(oldPath);
      if (value === undefined) throw new Error("missing rename source");
      files.delete(oldPath);
      files.set(newPath, value);
    },
    rmSync(filePath: string): void {
      files.delete(filePath);
    },
    writeFileSync(fd: number, data: string): void {
      const pending = pendingWrites.get(fd);
      if (!pending) throw new Error("missing write target");
      pending.data += data;
    },
  } as DesktopProfileFs;
  return {
    env: {},
    fs: fakeFs,
    home: "/home/test",
    now: () => new Date("2026-09-06T00:00:00.000Z"),
    platform: "linux",
    uid: () => 1000,
  };
}

describe("desktop profile environment", () => {
  it("uses the exact allowlist and strips sensitive child environment keys", () => {
    expect(DESKTOP_PROFILE_ENV_KEYS).toEqual([
      "ZCODE_APP_VERSION",
      "ZCODE_BASE_URL",
      "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
      "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
      "ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED",
      "ZCODE_ENV",
      "ZCODE_RUNTIME_ENV",
      "ZCODE_SERVICE_AUTHORITY_MODE",
      "ZCODE_BFS_BINARY",
      "ZCODE_RG_BINARY",
      "ZCODE_UGREP_BINARY",
      "ZCODE_SERVER_RUNTIME_ROOT",
      "ZAI_BUSINESS_BASE_URL",
      "ZAI_OAUTH_ORIGIN",
      "ZAI_OAUTH_CLIENT_ID",
    ]);
    const profileEnv = sanitizeDesktopEnv({
      ZCODE_ENV: "desktop",
      ZCODE_WORKSPACE_IDENTITY: "workspace-value",
      ANTHROPIC_API_KEY: "api-key-value",
    });
    const child = buildDesktopChildEnv(profileEnv, {
      HOME: "/home/test",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "ssh-value",
      ZCODE_BIN: "/opt/zcode.cjs",
      ZCODE_NODE: "/opt/node",
      ZCODE_WORKSPACE_IDENTITY: "workspace-value",
    });
    expect(child).toEqual({ HOME: "/home/test", PATH: "/usr/bin", ZCODE_ENV: "desktop" });
    expect(JSON.stringify(child)).not.toContain("workspace-value");
    expect(JSON.stringify(child)).not.toContain("api-key-value");
    expect(JSON.stringify(child)).not.toContain("ssh-value");
    expect(isSensitiveEnvKey("authorization")).toBe(true);
    expect(isSensitiveEnvKey("someCredentialPath")).toBe(true);
  });

  it("rejects unsafe URL values without including the value in the error", () => {
    const unsafe = "https://user:pass@example.test/v1?token=value#fragment";
    expect(() => sanitizeDesktopEnv({ ZCODE_BASE_URL: unsafe })).toThrowError(
      new DesktopProfileError("invalid"),
    );
    try {
      sanitizeDesktopEnv({ ZCODE_BASE_URL: unsafe });
    } catch (error) {
      expect(String(error)).not.toContain(unsafe);
      expect(String(error)).not.toContain("pass");
    }
  });
});

describe("desktop profile capture and storage", () => {
  it("validates the persisted schema and rejects non-allowlisted keys", () => {
    const profile = captureDesktopProfile(procRuntime());
    expect(parseDesktopProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
    expect(() =>
      parseDesktopProfile({ ...profile, env: { ...profile.env, ACCESS_TOKEN: "hidden" } }),
    ).toThrowError("desktop profile invalid");
  });

  it("loads an active source and returns stable missing/stale errors", () => {
    const profile = captureDesktopProfile(procRuntime());
    expect(loadDesktopProfile(procRuntime(undefined, profile))).toEqual(profile);
    expect(() => loadDesktopProfile(procRuntime())).toThrowError("desktop profile missing");
    expect(() =>
      loadDesktopProfile(
        procRuntime(undefined, {
          ...profile,
          source: { ...profile.source, startTime: "9999" },
        }),
      ),
    ).toThrowError("desktop profile stale");
  });

  it("refreshes once when the profile is missing or stale", () => {
    const profile = captureDesktopProfile(procRuntime());
    expect(loadDesktopChildEnvWithRefresh(procRuntime())).toMatchObject({
      ZCODE_ENV: "desktop",
    });
    expect(
      loadDesktopChildEnvWithRefresh(
        procRuntime(undefined, { ...profile, source: { ...profile.source, startTime: "9999" } }),
      ),
    ).toMatchObject({ ZCODE_BASE_URL: "https://api.example.test/v1" });
  });

  it("does not refresh invalid profiles", () => {
    const runtime = procRuntime(undefined, { invalid: true });
    expect(() => loadDesktopChildEnvWithRefresh(runtime)).toThrowError("desktop profile invalid");
  });

  it("propagates capture failures after a missing profile", () => {
    const runtime = procRuntime([
      { env: "ZCODE_ENV=one\0", pid: 200 },
      { env: "ZCODE_ENV=two\0", pid: 201 },
    ]);
    expect(() => loadDesktopChildEnvWithRefresh(runtime)).toThrowError("desktop profile invalid");
  });

  it("captures an attached zcode-cli with its zcode-server ancestor", () => {
    const profile = captureDesktopProfile(procRuntime());
    expect(profile).toEqual({
      schemaVersion: 1,
      kind: "desktop-attached",
      platform: "linux",
      capturedAt: "2026-09-06T00:00:00.000Z",
      source: {
        bootId: "boot-test",
        uid: 1000,
        pid: 200,
        startTime: "2000",
        serverPid: 100,
        serverStartTime: "1000",
      },
      env: { ZCODE_BASE_URL: "https://api.example.test/v1", ZCODE_ENV: "desktop" },
    });
  });

  it("fails safely when candidate allowlisted environments differ", () => {
    const runtime = procRuntime([
      { env: "ZCODE_ENV=one\0", pid: 200 },
      { env: "ZCODE_ENV=two\0", pid: 201 },
    ]);
    expect(() => captureDesktopProfile(runtime)).toThrowError("desktop profile invalid");
    try {
      captureDesktopProfile(runtime);
    } catch (error) {
      expect(String(error)).not.toContain("one");
      expect(String(error)).not.toContain("two");
    }
  });

  it("uses XDG_CONFIG_HOME and writes 0700/0600 with a previous-version backup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-profile-"));
    tempDirs.push(root);
    const runtime = procRuntime();
    runtime.env = { XDG_CONFIG_HOME: root };
    runtime.fs = fs as unknown as DesktopProfileFs;
    const profile = captureDesktopProfile(procRuntime());
    const profilePath = writeDesktopProfile(profile, runtime);
    writeDesktopProfile({ ...profile, capturedAt: "2026-09-06T00:01:00.000Z" }, runtime);

    expect(profilePath).toBe(path.join(root, "zcode-acp", "desktop-profile.json"));
    expect(fs.statSync(path.dirname(profilePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(profilePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${profilePath}.bak`).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(profilePath, "utf8")).schemaVersion).toBe(1);
  });

  it("falls back to ~/.config for the profile path", () => {
    expect(desktopProfilePath({}, "/home/test")).toBe(
      "/home/test/.config/zcode-acp/desktop-profile.json",
    );
  });
});

describe("desktop app-server argv", () => {
  it("appends exactly one desktop surface", () => {
    expect(withDesktopSurface(["zcode", "app-server", "--stdio"])).toEqual([
      "zcode",
      "app-server",
      "--stdio",
      "--surface",
      "desktop",
    ]);
    expect(
      withDesktopSurface(["zcode", "app-server", "--surface", "web", "--stdio", "--surface=other"]),
    ).toEqual(["zcode", "app-server", "--stdio", "--surface", "desktop"]);
  });
});
