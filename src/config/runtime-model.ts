/**
 * Runtime model switching.
 *
 * `applyModelSwitch` sends `session/setModel` with a `model` ref
 * (`{providerId, modelId}`). The backend resolves BOTH provider definition and
 * model-call auth from its workspace provider registry — the bridge pushes that
 * registry (with full model elements and inline apiKeys for third-party
 * providers) at backend spawn / session create, so the switch request itself
 * carries no provider payload.
 *
 * Protocol drift note (zcode 0.16.9 / app 3.14.1, 2026-09): the `runtimeModel`
 * overlay key was REMOVED from the protocol entirely — `session/setModel` and
 * `session/resume` run strict schemas that reject it with `Invalid params —
 * Unrecognized key: "runtimeModel"`, and the minified backend no longer
 * contains the string. Sending a full provider definition inline was the
 * pre-refactor contract; the registry push replaced it.
 */

import { formatModelValue, parseModelValue } from "./options.js";
import { loadDesktopProfile } from "../desktop-profile.js";
import { readFileSync } from "node:fs";
import { log, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";

/**
 * Switch a session's model via `session/setModel`.
 *
 * `value` is the configOption value: either `"providerId\modelId"` (encoded) or
 * a legacy plain modelId — both resolved against the BACKEND's registry, not
 * config.json: since zcode 0.16.9 the backend builds its registry from its own
 * provider files (builtin account templates + provider_config.json), so the
 * canonical ref comes from `session/read`'s `settings.model.available`. The
 * lookup is case-insensitive on modelId (the backend canonicalises to
 * lowercase); a unique match is used directly, an ambiguous one prefers the
 * requested providerId. When the requested model is absent from `available`
 * the ref is still sent verbatim — the backend's registry is wider than the
 * list (its precise errors drive two bounded reasoning-level retries). Models
 * truly absent from the registry (e.g. the GLM coding-plan account models for
 * bridge-created sessions — the desktop provisions those separately) fail with
 * the backend's "Provider Registry 中不存在 Model" error.
 *
 * `persistAsWorkspaceLastUsed: false` keeps this a runtime-only change.
 * Invalidates the model cache on success.
 */
export async function applyModelSwitch(
  server: ZcodeAcpServer,
  zcodeSid: string,
  value: string,
): Promise<boolean> {
  const requested = parseModelValue(value);
  const backend = server.ensureBackend();
  const read = await backend.request(server.nextId(), "session/read", { sessionId: zcodeSid });
  const available = extractAvailableModels(read.result);
  const resolved = resolveBackendRef(available, requested);
  // Fall back through two layers when the read's `available` list doesn't list
  // the model — that list is narrower than the registry validateSelection
  // actually checks (observed: a provider's non-default models are absent from
  // `available` yet still switchable):
  //   1. config.json's provider ids are desktop-legacy — the backend registers
  //      personal providers from provider_config.json under fresh UUIDs. Map
  //      via personalModelIds membership.
  //   2. verbatim requested ref.
  const mappedProviderId = resolved ? null : resolvePersonalProviderId(requested.modelId);
  const ref = resolved ?? {
    providerId: mappedProviderId ?? requested.providerId,
    modelId: requested.modelId,
  };
  const send = (model: typeof ref) =>
    backend.request(
      server.nextId(),
      "session/setModel",
      { sessionId: zcodeSid, model, persistAsWorkspaceLastUsed: false },
      15000,
    );
  let resp = await send(ref);
  // Providers with mandatory reasoning effort reject a bare ref ("Reasoning
  // level is required for …") and their entry may be missing from `available`
  // (so no defaultLevel was attached). Retry with the observed template
  // defaults, bounded to two attempts.
  for (const level of ["max", "high"]) {
    if (
      !resp.error ||
      !/reasoning level is required/i.test(resp.error.message) ||
      ref.options
    ) {
      break;
    }
    resp = await send({ ...ref, options: { reasoningLevel: level } });
  }
  if (resp.error) {
    warn(`runtime-model: switch failed: ${resp.error.message}`);
    return false;
  }
  invalidateModelCache(server, zcodeSid);
  return true;
}

interface BackendModelEntry {
  ref: { providerId: string; modelId: string };
  reasoning?: { defaultLevel?: string };
}

/** Pull `settings.model.available` out of a `session/read` result. */
function extractAvailableModels(result: unknown): BackendModelEntry[] {
  const settings = (result as { settings?: { model?: { available?: unknown } } } | undefined)
    ?.settings;
  const available = settings?.model?.available;
  if (!Array.isArray(available)) return [];
  return available.filter(
    (m): m is BackendModelEntry =>
      !!m &&
      typeof m === "object" &&
      !!(m as BackendModelEntry).ref?.providerId &&
      !!(m as BackendModelEntry).ref?.modelId,
  );
}

interface PersonalProviderRule {
  providerId: string;
  config?: { personalModelIds?: unknown };
}

/**
 * Map a modelId to the backend-registered personal provider that carries it,
 * reading the desktop's provider_config.json (path pinned by the desktop
 * profile's ZCODE_PERSONAL_PROVIDER_CONFIG_FILE). config.json's provider UUIDs
 * are desktop-legacy and unknown to the backend registry. Best-effort — null
 * when the file is missing, unreadable, or lists no match.
 */
function resolvePersonalProviderId(modelId: string): string | null {
  try {
    const profile = loadDesktopProfile();
    const configPath = profile.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    if (!configPath) return null;
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      config?: { providerConfigRules?: { providerRules?: PersonalProviderRule[] } };
    };
    const rules = raw.config?.providerConfigRules?.providerRules ?? [];
    const hit = rules.find((r) => {
      const ids = r.config?.personalModelIds;
      return (
        Array.isArray(ids) &&
        ids.some((m) => typeof m === "string" && m.toLowerCase() === modelId.toLowerCase())
      );
    });
    return hit?.providerId ?? null;
  } catch (e) {
    log(`runtime-model: personal provider map unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Match a requested config.json-flavoured ref against the backend's registry.
 * Case-insensitive on both ids; exact-ref hits win, then unique modelId hits,
 * then providerId-narrowed picks. Adds the entry's default reasoning level —
 * some providers reject a bare ref ("Reasoning level is required for …").
 */
function resolveBackendRef(
  available: BackendModelEntry[],
  requested: { providerId: string; modelId: string },
): { providerId: string; modelId: string; options?: { reasoningLevel: string } } | null {
  if (available.length === 0) return null;
  const lower = (s: string) => s.toLowerCase();
  const exact = available.find(
    (m) =>
      lower(m.ref.providerId) === lower(requested.providerId) &&
      lower(m.ref.modelId) === lower(requested.modelId),
  );
  const byModel = available.filter((m) => lower(m.ref.modelId) === lower(requested.modelId));
  const entry =
    exact ??
    (byModel.length === 1
      ? byModel[0]
      : byModel.find((m) => lower(m.ref.providerId) === lower(requested.providerId)));
  if (!entry) return null;
  const level = entry.reasoning?.defaultLevel;
  return {
    providerId: entry.ref.providerId,
    modelId: entry.ref.modelId,
    ...(level ? { options: { reasoningLevel: level } } : {}),
  };
}

/** Invalidate the session-level model cache after a switch. */
export function invalidateModelCache(server: ZcodeAcpServer, zcodeSid: string): void {
  server.modelCache.delete(zcodeSid);
}

// Re-exported so callers that only import runtime-model.ts can format values.
export { formatModelValue };
