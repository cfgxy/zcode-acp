/**
 * Env for the thin backend (`ZCODE_ACP_BACKEND=thin`): zcode-acp spawns
 * `zcode app-server --stdio` directly and the child gets zcode-acp's own
 * process.env unchanged, so per-task credentials (MULTICA_TOKEN, …) reach the
 * agent shell. On top of that, the desktop-profile keys and the base child
 * keys are built the way zcode-server builds them for the zcode-cli it spawns.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CHILD_ENV_KEYS } from "../desktop-profile.js";

const DEFAULT_ORIGIN = "https://zcode.z.ai";
const TEST_ORIGIN = "https://zcode.chatglm.site";

export interface ThinEnvDeps {
  homedir?: () => string;
  username?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
  readdirSync?: (p: string) => string[];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** zcode-server's ZCODE_VERSION, read from its bundle; falls back to the newest provider dir. */
function resolveAppVersion(
  serverRoot: string,
  providerRoot: string,
  deps: Required<ThinEnvDeps>,
): string | undefined {
  try {
    const src = deps.readFileSync(path.join(serverRoot, "zcode-server.cjs"));
    const m = /var ZCODE_VERSION = true \? "(\d+\.\d+\.\d+[^"]*)"/.exec(src);
    if (m) return m[1];
  } catch {
    // fall through to the directory scan
  }
  try {
    const versions = deps.readdirSync(providerRoot).filter((v) => /^\d+\.\d+\.\d+/.test(v));
    versions.sort(compareVersions);
    return versions.at(-1);
  } catch {
    return undefined;
  }
}

export function buildThinBackendEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: ThinEnvDeps = {},
): NodeJS.ProcessEnv {
  const deps: Required<ThinEnvDeps> = {
    homedir: overrides.homedir ?? os.homedir,
    username: overrides.username ?? (() => os.userInfo().username),
    platform: overrides.platform ?? process.platform,
    arch: overrides.arch ?? process.arch,
    existsSync: overrides.existsSync ?? fs.existsSync,
    readFileSync: overrides.readFileSync ?? ((p) => fs.readFileSync(p, "utf8")),
    readdirSync: overrides.readdirSync ?? ((p) => fs.readdirSync(p)),
  };
  const env: NodeJS.ProcessEnv = { ...base };

  // Base child keys (HOME, LANG, LC_ALL, LOGNAME, PATH, SHELL, TMPDIR, USER):
  // inherited as-is; only the ones a child cannot do without are filled when missing.
  const home = env.HOME || deps.homedir();
  const fallbacks: Record<string, () => string> = {
    HOME: () => home,
    USER: deps.username,
    LOGNAME: () => env.USER ?? deps.username(),
    PATH: () => "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: os.tmpdir,
  };
  for (const key of CHILD_ENV_KEYS) {
    if (!env[key] && Object.hasOwn(fallbacks, key)) env[key] = fallbacks[key]();
  }

  // Desktop profile keys, as zcode-server derives them.
  const runtimeEnv = ["development", "production", "test"].includes(env.ZCODE_RUNTIME_ENV ?? "")
    ? (env.ZCODE_RUNTIME_ENV as string)
    : "production";
  env.ZCODE_RUNTIME_ENV = runtimeEnv;

  const origin = env.ZCODE_BASE_URL || (env.ZCODE_ENV === "test" ? TEST_ORIGIN : DEFAULT_ORIGIN);
  env.ZCODE_BASE_URL = origin;

  const serverRoot = env.ZCODE_SERVER_RUNTIME_ROOT || path.join(home, ".zcode", "server");
  const dataBase = env.ZCODE_DATA_BASE_DIR || home;
  const archName = deps.arch === "x64" ? "x86_64" : deps.arch === "arm64" ? "aarch64" : deps.arch;
  const providerRoot = path.join(
    dataBase,
    ".zcode",
    "v2",
    "runtime",
    "provider",
    `${deps.platform}-${archName}`,
  );
  const appVersion = resolveAppVersion(serverRoot, providerRoot, deps);
  if (appVersion) {
    const endpoint = createHash("sha256").update(origin).digest("hex").slice(0, 32);
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = path.join(
      providerRoot,
      appVersion,
      `endpoint-${endpoint}`,
      "zcode-builtin.json",
    );
  }
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(home, ".zcode", "v2", "provider_config.json");

  const tools: Array<[string, string, string]> = [
    ["ZCODE_BFS_BINARY", "bfs", "bfs"],
    ["ZCODE_RG_BINARY", "ripgrep", "rg"],
    ["ZCODE_UGREP_BINARY", "ugrep", "ugrep"],
  ];
  for (const [key, dir, bin] of tools) {
    const p = path.join(serverRoot, "tools", dir, bin);
    if (deps.existsSync(p)) env[key] = p;
  }
  return env;
}
