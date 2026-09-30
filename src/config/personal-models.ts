/**
 * The backend's personal-provider registry (provider_config.json).
 *
 * Since zcode 0.16.9 the backend builds its registry from its own provider
 * files, NOT from config.json: a model is switchable only when it appears in
 * some provider rule's `personalModelIds` (or in a builtin account template).
 * config.json is desktop-owned and drifts (models renamed/removed upstream),
 * so the dropdown and the model-switch mapping both read this file — config.json
 * only contributes display metadata for models the backend also knows.
 *
 * Every reader is best-effort: a missing/unreadable file yields "no personal
 * providers" and callers fall back to config.json.
 */

import { readFileSync } from "node:fs";

import { loadDesktopProfile } from "../desktop-profile.js";
import { personalProviderConfigPath } from "./personal-provider.js";
import { log } from "../utils.js";

export interface PersonalProvider {
  providerId: string;
  providerName: string;
  modelIds: string[];
}

interface ProviderConfigShape {
  config?: {
    providerConfigRules?: {
      providerRules?: Array<{
        providerId?: unknown;
        providerName?: unknown;
        config?: { personalModelIds?: unknown; modelOrder?: unknown };
      }>;
    };
    modelConfigRules?: {
      providerModelRules?: Array<{
        providerId?: unknown;
        modelId?: unknown;
        config?: { properties?: { contextWindow?: unknown } };
      }>;
    };
  };
}

/**
 * Where provider_config.json lives. The desktop profile's pin wins when the
 * profile is usable, but the profile goes `stale`/`missing` whenever ZCodeDesktop
 * is closed — and the file itself does not move. Falling back to the operator's
 * env pin / the standard ~/.zcode/v2 location keeps the personal-provider
 * lookup working without the desktop (every non-default model switch used to
 * fail with "Provider Registry 中不存在 Model" once the desktop was closed).
 */
export function personalProviderConfigFile(): string {
  let pinEnv: NodeJS.ProcessEnv = process.env;
  try {
    pinEnv = { ...process.env, ...loadDesktopProfile().env };
  } catch (e) {
    log(
      `personal-models: desktop profile unusable, using default provider path: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return personalProviderConfigPath(pinEnv);
}

function readProviderConfig(): ProviderConfigShape | null {
  try {
    return JSON.parse(readFileSync(personalProviderConfigFile(), "utf8")) as ProviderConfigShape;
  } catch (e) {
    log(
      `personal-models: provider_config.json unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/** Personal providers (with at least one model) in the backend's own order. */
export function loadPersonalProviders(): PersonalProvider[] {
  const rules = readProviderConfig()?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return [];
  const out: PersonalProvider[] = [];
  for (const r of rules) {
    if (typeof r?.providerId !== "string" || !r.providerId) continue;
    const ids = r.config?.personalModelIds;
    if (!Array.isArray(ids)) continue;
    const modelIds = ids.filter((m): m is string => typeof m === "string" && m.length > 0);
    if (modelIds.length === 0) continue;
    out.push({
      providerId: r.providerId,
      providerName:
        typeof r.providerName === "string" && r.providerName ? r.providerName : r.providerId,
      modelIds,
    });
  }
  return out;
}

/**
 * Context window the backend registered for a model (0 when unknown). Prefers
 * the exact provider; falls back to any provider carrying the same modelId so
 * a config.json-flavoured provider id still resolves.
 */
export function personalModelContextWindow(providerId: string, modelId: string): number {
  const rules = readProviderConfig()?.config?.modelConfigRules?.providerModelRules;
  if (!Array.isArray(rules)) return 0;
  const lower = modelId.toLowerCase();
  let fallback = 0;
  for (const r of rules) {
    if (typeof r?.modelId !== "string" || r.modelId.toLowerCase() !== lower) continue;
    const cw = r.config?.properties?.contextWindow;
    if (typeof cw !== "number" || cw <= 0) continue;
    if (r.providerId === providerId) return cw;
    fallback ||= cw;
  }
  return fallback;
}
