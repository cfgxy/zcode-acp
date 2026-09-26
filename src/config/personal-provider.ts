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
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ZCODE_CREDS_PATH, log } from "../utils.js";

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

/** The desktop-pinned path when available, else the standard location. */
export function personalProviderConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim();
  if (pinned) return pinned;
  const home = os.homedir();
  return path.join(home, ".zcode", "v2", "provider_config.json");
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
      provider?: Record<string, { enabled?: boolean; options?: { baseURL?: string; apiKey?: string } }>;
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
    return { status: "skipped", reason: `provider_config.json unreadable (${e instanceof Error ? e.message : String(e)})` };
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
    return { status: "skipped", reason: `write failed (${e instanceof Error ? e.message : String(e)})` };
  }
  log(`personal-provider: added GLM Coding Plan entry ${providerId}`);
  return { status: "added", providerId };
}

/** Backup + atomic replace, matching the desktop file's 0600 expectations. */
function atomicWrite(filePath: string, data: string): void {
  if (existsSync(filePath)) {
    const backup = `${filePath}.bak-${Date.now()}`;
    copyFileSync(filePath, backup);
    chmodSync(backup, 0o600);
  }
  const tmp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, filePath);
}
