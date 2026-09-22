import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const DESKTOP_PROFILE_ENV_KEYS = [
  "ZCODE_APP_VERSION",
  "ZCODE_BASE_URL",
  // zcode ≥ the 2026-09 provider-config split: the CLI resolves its built-in /
  // personal provider configs through these pins; without them it exits at
  // startup ("无法定位 CLI ZCode Built-in Provider Config") and the backend
  // reader dies instantly.
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
] as const;

const DESKTOP_PROFILE_ENV_KEY_SET = new Set<string>(DESKTOP_PROFILE_ENV_KEYS);
const URL_ENV_KEYS = new Set<string>([
  "ZCODE_BASE_URL",
  "ZAI_BUSINESS_BASE_URL",
  "ZAI_OAUTH_ORIGIN",
]);
const CHILD_ENV_KEYS = ["HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"];
const MAX_ENV_VALUE_LENGTH = 4096;
const PROFILE_SCHEMA_VERSION = 1;
const REFRESH_LOCK_ATTEMPTS = 8;
const REFRESH_LOCK_WAIT_MS = 25;

export type DesktopProfileErrorCode = "invalid" | "missing" | "stale" | "unsupported";

export class DesktopProfileError extends Error {
  constructor(readonly code: DesktopProfileErrorCode) {
    super(`desktop profile ${code}`);
    this.name = "DesktopProfileError";
  }
}

export interface DesktopProfile {
  schemaVersion: 1;
  kind: "desktop-attached";
  platform: "linux";
  capturedAt: string;
  source: {
    bootId: string;
    uid: number;
    pid: number;
    startTime: string;
    serverPid: number;
    serverStartTime: string;
  };
  env: Record<string, string>;
}

export interface DesktopProfileFs {
  chmodSync(filePath: string, mode: number): void;
  closeSync(fd: number): void;
  existsSync(filePath: string): boolean;
  fsyncSync(fd: number): void;
  mkdirSync(dirPath: string, options: { mode: number; recursive: true }): void;
  openSync(filePath: string, flags: string, mode: number): number;
  readFileSync(filePath: string, encoding: "utf8"): string;
  readdirSync(dirPath: string): string[];
  renameSync(oldPath: string, newPath: string): void;
  rmSync(filePath: string, options: { force: true }): void;
  writeFileSync(fd: number, data: string, encoding: "utf8"): void;
}

export interface DesktopProfileRuntime {
  env: NodeJS.ProcessEnv;
  fs: DesktopProfileFs;
  home: string;
  now(): Date;
  platform: NodeJS.Platform;
  uid(): number;
}

const defaultRuntime: DesktopProfileRuntime = {
  env: process.env,
  fs,
  home: os.homedir(),
  now: () => new Date(),
  platform: process.platform,
  uid: () => process.getuid?.() ?? -1,
};

interface ProcStat {
  parentPid: number;
  startTime: string;
}

interface Candidate {
  env: Record<string, string>;
  pid: number;
  serverPid: number;
  serverStartTime: string;
  startTime: string;
}

function fail(code: DesktopProfileErrorCode): never {
  throw new DesktopProfileError(code);
}

export function desktopProfilePath(env = process.env, home = os.homedir()): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configHome, "zcode-acp", "desktop-profile.json");
}

export function isSensitiveEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    normalized === "ZCODE_WORKSPACE_IDENTITY" ||
    normalized.startsWith("SSH_") ||
    /TOKEN|API_?KEY|COOKIE|AUTHORIZATION|PASSWORD|SECRET|CREDENTIAL/.test(normalized)
  );
}

export function sanitizeDesktopEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const key of DESKTOP_PROFILE_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) continue;
    if (!isValidEnvValue(key, value)) fail("invalid");
    sanitized[key] = value;
  }
  return sanitized;
}

export function buildDesktopChildEnv(
  profileEnv: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = hostEnv[key];
    if (value !== undefined && !isSensitiveEnvKey(key)) childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(sanitizeDesktopEnv(profileEnv))) {
    childEnv[key] = value;
  }
  for (const key of Object.keys(childEnv)) {
    if (isSensitiveEnvKey(key)) delete childEnv[key];
  }
  delete childEnv.ZCODE_WORKSPACE_IDENTITY;
  return childEnv;
}

function isValidEnvValue(key: string, value: string): boolean {
  if (value.length > MAX_ENV_VALUE_LENGTH || /[\0\n\r]/.test(value)) return false;
  if (!URL_ENV_KEYS.has(key)) return true;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function read(runtime: DesktopProfileRuntime, filePath: string): string {
  try {
    return runtime.fs.readFileSync(filePath, "utf8");
  } catch {
    fail("stale");
  }
}

function parseProcStat(raw: string): ProcStat {
  const close = raw.lastIndexOf(")");
  if (close < 0) fail("stale");
  const fields = raw
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const parentPid = Number(fields[1]);
  const startTime = fields[19];
  if (!Number.isSafeInteger(parentPid) || parentPid < 0 || !/^\d+$/.test(startTime ?? "")) {
    fail("stale");
  }
  return { parentPid, startTime: startTime! };
}

function readProcStat(runtime: DesktopProfileRuntime, pid: number): ProcStat {
  return parseProcStat(read(runtime, `/proc/${pid}/stat`));
}

function readUid(runtime: DesktopProfileRuntime, pid: number): number {
  const match = /^Uid:\s+(\d+)/m.exec(read(runtime, `/proc/${pid}/status`));
  if (!match) fail("stale");
  return Number(match[1]);
}

function processMatches(runtime: DesktopProfileRuntime, pid: number, name: string): boolean {
  const cmdline = read(runtime, `/proc/${pid}/cmdline`).split("\0").filter(Boolean);
  const comm = read(runtime, `/proc/${pid}/comm`).trim();
  return comm === name || cmdline.some((token) => path.basename(token) === name);
}

function findServerAncestor(
  runtime: DesktopProfileRuntime,
  pid: number,
): { pid: number; startTime: string } | null {
  let current = readProcStat(runtime, pid).parentPid;
  const visited = new Set<number>();
  for (let depth = 0; current > 1 && depth < 64 && !visited.has(current); depth++) {
    visited.add(current);
    const stat = readProcStat(runtime, current);
    if (processMatches(runtime, current, "zcode-server.cjs")) {
      return { pid: current, startTime: stat.startTime };
    }
    current = stat.parentPid;
  }
  return null;
}

function parseEnviron(raw: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const entry of raw.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator);
    if (DESKTOP_PROFILE_ENV_KEY_SET.has(key)) env[key] = entry.slice(separator + 1);
  }
  return env;
}

function sameEnv(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function discoverCandidates(runtime: DesktopProfileRuntime, uid: number): Candidate[] {
  let entries: string[];
  try {
    entries = runtime.fs.readdirSync("/proc");
  } catch {
    fail("stale");
  }
  const candidates: Candidate[] = [];
  for (const entry of entries.filter((value) => /^\d+$/.test(value)).sort((a, b) => +a - +b)) {
    const pid = Number(entry);
    try {
      if (readUid(runtime, pid) !== uid || !processMatches(runtime, pid, "zcode-cli")) continue;
      const first = readProcStat(runtime, pid);
      const server = findServerAncestor(runtime, pid);
      if (!server) continue;
      const env = sanitizeDesktopEnv(parseEnviron(read(runtime, `/proc/${pid}/environ`)));
      const second = readProcStat(runtime, pid);
      const serverSecond = readProcStat(runtime, server.pid);
      if (first.startTime !== second.startTime || server.startTime !== serverSecond.startTime) {
        fail("stale");
      }
      candidates.push({
        env,
        pid,
        serverPid: server.pid,
        serverStartTime: server.startTime,
        startTime: first.startTime,
      });
    } catch (error) {
      if (error instanceof DesktopProfileError && error.code === "invalid") throw error;
      continue;
    }
  }
  return candidates;
}

export function captureDesktopProfile(
  runtime: DesktopProfileRuntime = defaultRuntime,
): DesktopProfile {
  if (runtime.platform !== "linux" || runtime.uid() < 0) fail("unsupported");
  const bootIdBefore = read(runtime, "/proc/sys/kernel/random/boot_id").trim();
  const uid = runtime.uid();
  const candidates = discoverCandidates(runtime, uid);
  const bootIdAfter = read(runtime, "/proc/sys/kernel/random/boot_id").trim();
  if (!bootIdBefore || bootIdBefore !== bootIdAfter) fail("stale");
  if (candidates.length === 0) fail("missing");
  if (candidates.some((candidate) => !sameEnv(candidate.env, candidates[0]!.env))) fail("invalid");
  const candidate = candidates[0]!;
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    kind: "desktop-attached",
    platform: "linux",
    capturedAt: runtime.now().toISOString(),
    source: {
      bootId: bootIdBefore,
      uid,
      pid: candidate.pid,
      startTime: candidate.startTime,
      serverPid: candidate.serverPid,
      serverStartTime: candidate.serverStartTime,
    },
    env: candidate.env,
  };
}

export function parseDesktopProfile(value: unknown): DesktopProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid");
  const profile = value as Partial<DesktopProfile>;
  const source = profile.source as Partial<DesktopProfile["source"]> | undefined;
  if (
    profile.schemaVersion !== PROFILE_SCHEMA_VERSION ||
    profile.kind !== "desktop-attached" ||
    profile.platform !== "linux" ||
    typeof profile.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(profile.capturedAt)) ||
    !source ||
    typeof source.bootId !== "string" ||
    !Number.isSafeInteger(source.uid) ||
    !Number.isSafeInteger(source.pid) ||
    !Number.isSafeInteger(source.serverPid) ||
    typeof source.startTime !== "string" ||
    typeof source.serverStartTime !== "string" ||
    !/^\d+$/.test(source.startTime) ||
    !/^\d+$/.test(source.serverStartTime) ||
    !profile.env ||
    typeof profile.env !== "object" ||
    Array.isArray(profile.env)
  ) {
    fail("invalid");
  }
  const env = profile.env as Record<string, unknown>;
  if (
    Object.entries(env).some(
      ([key, value]) =>
        !DESKTOP_PROFILE_ENV_KEY_SET.has(key) ||
        isSensitiveEnvKey(key) ||
        typeof value !== "string" ||
        !isValidEnvValue(key, value),
    )
  ) {
    fail("invalid");
  }
  return profile as DesktopProfile;
}

export function validateDesktopProfileSource(
  profile: DesktopProfile,
  runtime: DesktopProfileRuntime = defaultRuntime,
): void {
  if (runtime.platform !== "linux" || runtime.uid() < 0) fail("unsupported");
  const bootIdBefore = read(runtime, "/proc/sys/kernel/random/boot_id").trim();
  if (
    bootIdBefore !== profile.source.bootId ||
    runtime.uid() !== profile.source.uid ||
    readUid(runtime, profile.source.pid) !== profile.source.uid
  ) {
    fail("stale");
  }
  const processStatBefore = readProcStat(runtime, profile.source.pid);
  const serverStatBefore = readProcStat(runtime, profile.source.serverPid);
  const server = findServerAncestor(runtime, profile.source.pid);
  const processStatAfter = readProcStat(runtime, profile.source.pid);
  const serverStatAfter = readProcStat(runtime, profile.source.serverPid);
  const bootIdAfter = read(runtime, "/proc/sys/kernel/random/boot_id").trim();
  if (
    bootIdBefore !== bootIdAfter ||
    processStatBefore.startTime !== profile.source.startTime ||
    processStatAfter.startTime !== profile.source.startTime ||
    serverStatBefore.startTime !== profile.source.serverStartTime ||
    serverStatAfter.startTime !== profile.source.serverStartTime ||
    !processMatches(runtime, profile.source.pid, "zcode-cli") ||
    server?.pid !== profile.source.serverPid
  ) {
    fail("stale");
  }
}

export function loadDesktopProfile(
  runtime: DesktopProfileRuntime = defaultRuntime,
): DesktopProfile {
  if (runtime.platform !== "linux") fail("unsupported");
  const profilePath = desktopProfilePath(runtime.env, runtime.home);
  let raw: string;
  try {
    raw = runtime.fs.readFileSync(profilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("missing");
    fail("invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("invalid");
  }
  const profile = parseDesktopProfile(parsed);
  validateDesktopProfileSource(profile, runtime);
  return profile;
}

export function loadDesktopChildEnv(
  runtime: DesktopProfileRuntime = defaultRuntime,
): NodeJS.ProcessEnv {
  return buildDesktopChildEnv(loadDesktopProfile(runtime).env, runtime.env);
}

/**
 * Load a verified desktop profile, refreshing it once when its persisted source
 * no longer exists or is stale. Invalid profiles and unsupported platforms must
 * fail as-is instead of attempting to inspect process state.
 */
export function loadDesktopChildEnvWithRefresh(
  runtime: DesktopProfileRuntime = defaultRuntime,
): NodeJS.ProcessEnv {
  try {
    return loadDesktopChildEnv(runtime);
  } catch (error) {
    if (
      !(error instanceof DesktopProfileError) ||
      (error.code !== "missing" && error.code !== "stale")
    ) {
      throw error;
    }
  }
  const profilePath = desktopProfilePath(runtime.env, runtime.home);
  runtime.fs.mkdirSync(path.dirname(profilePath), { recursive: true, mode: 0o700 });
  const lockPath = `${profilePath}.refresh.lock`;
  for (let attempt = 0; attempt < REFRESH_LOCK_ATTEMPTS; attempt++) {
    let lockFd: number | undefined;
    try {
      lockFd = runtime.fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      waitForRefreshLock();
      try {
        return loadDesktopChildEnv(runtime);
      } catch (retryError) {
        if (
          !(retryError instanceof DesktopProfileError) ||
          (retryError.code !== "missing" && retryError.code !== "stale")
        ) {
          throw retryError;
        }
        continue;
      }
    }
    try {
      refreshDesktopProfile(runtime);
      return loadDesktopChildEnv(runtime);
    } finally {
      if (lockFd !== undefined) runtime.fs.closeSync(lockFd);
      runtime.fs.rmSync(lockPath, { force: true });
    }
  }
  fail("stale");
}

function waitForRefreshLock(): void {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, REFRESH_LOCK_WAIT_MS);
}

export function writeDesktopProfile(
  profile: DesktopProfile,
  runtime: DesktopProfileRuntime = defaultRuntime,
): string {
  const profilePath = desktopProfilePath(runtime.env, runtime.home);
  const dirPath = path.dirname(profilePath);
  const backupPath = `${profilePath}.bak`;
  const tempPath = `${profilePath}.tmp-${process.pid}-${Date.now()}`;
  runtime.fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  runtime.fs.chmodSync(dirPath, 0o700);
  let fd: number | undefined;
  try {
    fd = runtime.fs.openSync(tempPath, "wx", 0o600);
    runtime.fs.writeFileSync(fd, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    runtime.fs.fsyncSync(fd);
    runtime.fs.closeSync(fd);
    fd = undefined;
    runtime.fs.chmodSync(tempPath, 0o600);
    if (runtime.fs.existsSync(profilePath)) {
      runtime.fs.rmSync(backupPath, { force: true });
      runtime.fs.renameSync(profilePath, backupPath);
      runtime.fs.chmodSync(backupPath, 0o600);
    }
    runtime.fs.renameSync(tempPath, profilePath);
    runtime.fs.chmodSync(profilePath, 0o600);
    return profilePath;
  } catch (error) {
    if (fd !== undefined) runtime.fs.closeSync(fd);
    runtime.fs.rmSync(tempPath, { force: true });
    if (!runtime.fs.existsSync(profilePath) && runtime.fs.existsSync(backupPath)) {
      runtime.fs.renameSync(backupPath, profilePath);
    }
    throw error;
  }
}

export function refreshDesktopProfile(runtime: DesktopProfileRuntime = defaultRuntime): string {
  return writeDesktopProfile(captureDesktopProfile(runtime), runtime);
}
