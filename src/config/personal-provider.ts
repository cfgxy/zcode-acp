/**
 * Ensure the GLM Coding Plan is registered as a personal provider in the
 * desktop's provider_config.json.
 *
 * The desktop app provisions that file on every update/sync and silently
 * drops manually-added entries, so after each desktop upgrade the backend
 * registry loses the GLM plan ("Provider Registry 中不存在 Model" on
 * /model; sessions silently run on a third-party provider). `zcode-acp
 * profile refresh` runs in exactly that scenario, so it calls this to
 * re-add the entry: same apiKey as config.json's builtin plan provider
 * (→ same billing), anthropic-messages @ open.bigmodel.cn.
 *
 * Best-effort by contract: every failure path returns a skipped reason
 * instead of throwing — a provisioning problem must never fail the
 * profile refresh itself.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { ZCODE_CREDS_PATH, log, warn } from "../utils.js";

const GLM_MODEL_IDS = ["GLM-5.3-Flash", "GLM-5.3"];
const GLM_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
const MODEL_CONTEXT_WINDOW = 200000;

export type PersonalProviderOutcome =
  | { status: "present"; providerId: string }
  | { status: "added"; providerId: string }
  | { status: "skipped"; reason: string };

interface ProviderRule {
  providerId: string;
  providerName?: string;
  config?: {
    group?: string;
    access?: unknown;
    api?: unknown;
    personalModelIds?: unknown;
    modelOrder?: unknown;
  };
}

interface ProviderConfigFile {
  config?: {
    providerConfigRules?: { providerRules?: ProviderRule[] };
    modelConfigRules?: { providerModelRules?: Array<Record<string, unknown>> };
  };
}

/**
 * Absolute path of `p` with every EXISTING component resolved through symlinks,
 * and the not-yet-existing tail appended lexically. `realpath` alone throws for
 * a file that does not exist yet, and falling back to a lexical check there let
 * a symlinked DIRECTORY inside ~/.zcode carry the write out of it. Returns null
 * for a DANGLING symlink (it exists but its target is unknown, so it cannot be
 * trusted) or when no ancestor can be resolved.
 */
export function resolveThroughSymlinks(p: string): string | null {
  const tail: string[] = [];
  let current = p;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail.reverse());
    } catch {
      try {
        lstatSync(current);
        return null; // present but unresolvable: a dangling symlink
      } catch {
        /* truly absent: resolve the parent instead */
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export interface PersonalProviderTarget {
  /** The file the plan entry would be written to. */
  path: string;
  /** Set when the desktop pinned a path that was REFUSED (the pin itself). The
   *  backend reads the pinned file, so writing the default one instead would
   *  register the provider where nothing looks — callers should not write. */
  rejectedPin?: string;
}

/** Where the plan entry goes: the desktop pin when it is trustworthy, else the
 *  standard location — and, when a pin was refused, which one. */
export function resolvePersonalProviderTarget(
  env: NodeJS.ProcessEnv = process.env,
): PersonalProviderTarget {
  const home = os.homedir();
  const fallback = path.join(home, ".zcode", "v2", "provider_config.json");
  const pinned = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim();
  if (!pinned) return { path: fallback };
  // ensurePersonalGlmProvider WRITES the user's plan API key into this file. A
  // pin pointing anywhere else (a tampered profile / a spoofed "desktop host"
  // process's environ) would exfiltrate the key to an attacker-readable path.
  // Only accept a pin that RESOLVES (symlinks and all) inside ~/.zcode/ — also
  // when the file does not exist yet — and hand back the RESOLVED path, so the
  // location that was checked is the location that gets written.
  const zcodeRoot = resolveThroughSymlinks(path.join(home, ".zcode"));
  const resolved = resolveThroughSymlinks(pinned);
  if (zcodeRoot !== null && resolved !== null && resolved.startsWith(zcodeRoot + path.sep)) {
    return { path: resolved };
  }
  warn(
    `personal-provider: ignoring untrusted ZCODE_PERSONAL_PROVIDER_CONFIG_FILE pin ${pinned} ` +
      "(outside ~/.zcode)",
  );
  return { path: fallback, rejectedPin: pinned };
}

/** The desktop-pinned path when available, else the standard location. */
export function personalProviderConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePersonalProviderTarget(env).path;
}

function isGlmRule(rule: ProviderRule): boolean {
  const ids = rule.config?.personalModelIds;
  return (
    Array.isArray(ids) &&
    ids.some((m) => typeof m === "string" && m.toLowerCase().startsWith("glm-"))
  );
}

/** The plan apiKey from config.json's enabled bigmodel provider, or null. */
export function planApiKey(zcodeConfigPath = ZCODE_CREDS_PATH): string | null {
  try {
    const cfg = JSON.parse(readFileSync(zcodeConfigPath, "utf8")) as {
      provider?: Record<
        string,
        { enabled?: boolean; options?: { baseURL?: string; apiKey?: string } }
      >;
    };
    for (const p of Object.values(cfg.provider ?? {})) {
      const opts = p?.options ?? {};
      if (p?.enabled && opts.apiKey && opts.baseURL?.includes("bigmodel")) return opts.apiKey;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Idempotently ensure the GLM personal provider entry. `writeFile` is
 * injectable for tests; production passes the fs-backed atomic writer.
 */
export function ensurePersonalGlmProvider(
  providerConfigPath: string,
  zcodeConfigPath: string,
  writeFile: (path: string, data: string) => void = atomicWrite,
): PersonalProviderOutcome {
  let data: ProviderConfigFile;
  try {
    data = JSON.parse(readFileSync(providerConfigPath, "utf8")) as ProviderConfigFile;
  } catch (e) {
    return {
      status: "skipped",
      reason: `provider_config.json unreadable (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const rules = data.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) {
    return { status: "skipped", reason: "provider_config.json has no providerRules array" };
  }
  const existing = rules.find(isGlmRule);
  if (existing) return { status: "present", providerId: existing.providerId };

  const apiKey = planApiKey(zcodeConfigPath);
  if (!apiKey) {
    return { status: "skipped", reason: "no enabled bigmodel apiKey in config.json to register" };
  }
  const providerId = randomUUID();
  rules.push({
    providerId,
    providerName: "GLM Coding Plan (personal)",
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey },
      api: { type: "anthropic-messages", baseUrl: GLM_BASE_URL },
      personalModelIds: GLM_MODEL_IDS,
      modelOrder: GLM_MODEL_IDS,
    },
  });
  const modelRules = data.config?.modelConfigRules?.providerModelRules;
  if (Array.isArray(modelRules)) {
    for (const modelId of GLM_MODEL_IDS) {
      modelRules.push({
        modelId,
        config: { properties: { contextWindow: MODEL_CONTEXT_WINDOW } },
        providerId,
      });
    }
  }
  try {
    writeFile(providerConfigPath, `${JSON.stringify(data, null, 1)}\n`);
  } catch (e) {
    return {
      status: "skipped",
      reason: `write failed (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  log(`personal-provider: added GLM Coding Plan entry ${providerId}`);
  return { status: "added", providerId };
}

/**
 * Create `target` exclusively with mode 0600 from the first byte. `wx` is
 * O_CREAT|O_EXCL: it fails with EEXIST on ANY existing entry — a symlink planted
 * at a predictable name included — instead of following it, and the file is never
 * readable by others (a copy that inherits the source's 0644 and is chmod-ed
 * afterwards leaves a window where other providers' keys are world-readable).
 */
function writeExclusive(target: string, data: string | Buffer): void {
  const fd = openSync(target, "wx", 0o600);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fchmodSync(fd, 0o600); // mode above is masked by umask only downwards; make it exact
  } finally {
    closeSync(fd);
  }
}

/**
 * Backup + atomic replace, matching the desktop file's 0600 expectations.
 *
 * The temp and backup names are predictable and this file holds the user's plan
 * API key. A plain writeFileSync/copyFileSync FOLLOWS a symlink planted at such a
 * name (verified: it overwrites the link's target with our data), so both are
 * created exclusively. A stale temp file from an earlier crashed run is removed
 * first (unlink never follows the link, it removes the link itself).
 */
function atomicWrite(filePath: string, data: string): void {
  if (existsSync(filePath)) {
    writeExclusive(`${filePath}.bak-${Date.now()}`, readFileSync(filePath));
  }
  const tmp = `${filePath}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  writeExclusive(tmp, data);
  renameSync(tmp, filePath);
}
