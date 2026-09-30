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
import { loadPersonalProviders } from "./personal-models.js";
import { log, warn } from "../utils.js";
import type { ZcodeAcpServer } from "../server.js";

/**
 * Reasoning levels tried, in order, when the backend rejects a switch over the
 * level. The vocabulary is per model AND per backend version (gpt-5.x: none…max,
 * claude-*: low…max, GLM: disabled/high/max, unmatched models fall to a generic
 * `enabled`/`disabled` pair), so the bridge learns it from the backend's own
 * rejections instead of mirroring its builtin rules — those drift.
 */
const LEVEL_LADDER = ["max", "high", "enabled", "medium", "low", "xhigh"] as const;

/** The level that last switched a model successfully, keyed `provider/model`. */
const workingLevels = new Map<string, string>();

function levelKey(ref: { providerId: string; modelId: string }): string {
  return `${ref.providerId}/${ref.modelId}`.toLowerCase();
}

/** Backend rejected the switch over the reasoning level (missing or unsupported). */
function isLevelError(message: string): boolean {
  return (
    /reasoning level is required/i.test(message) ||
    /reasoning effort .* is not supported/i.test(message)
  );
}

/** Test hook: forget learned levels. */
export function resetLearnedLevels(): void {
  workingLevels.clear();
}

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
 * list (its precise errors drive the bounded reasoning-level retries). Models
 * truly absent from the registry fail with the backend's "Provider Registry
 * 中不存在 Model" error.
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
  const mappedProviderId = resolved ? null : resolvePersonalProviderId(requested);
  const ref = resolved ?? {
    providerId: mappedProviderId ?? requested.providerId,
    modelId: requested.modelId,
  };
  const send = (model: { providerId: string; modelId: string; options?: unknown }) =>
    backend.request(
      server.nextId(),
      "session/setModel",
      { sessionId: zcodeSid, model, persistAsWorkspaceLastUsed: false },
      15000,
    );

  // A level that worked before beats a bare ref (saves a round-trip); the
  // backend's own defaultLevel (already on `ref`) beats the cache.
  const key = levelKey(ref);
  const learned = workingLevels.get(key);
  const first = ref.options
    ? ref
    : learned
      ? { ...ref, options: { reasoningLevel: learned } }
      : ref;
  let used = first.options?.reasoningLevel;
  let resp = await send(first);

  // The backend rejects a bad level with a precise error but never lists the
  // valid ones, so walk the ladder — bounded, skipping what was already tried.
  const tried = new Set<string>(used ? [used] : []);
  for (const level of LEVEL_LADDER) {
    if (!resp.error || !isLevelError(resp.error.message)) break;
    if (tried.has(level)) continue;
    tried.add(level);
    resp = await send({ ...ref, options: { reasoningLevel: level } });
    used = level;
  }
  if (resp.error) {
    warn(`runtime-model: switch failed: ${resp.error.message}`);
    return false;
  }
  if (used) workingLevels.set(key, used);
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

/**
 * Map a requested ref onto the backend-registered personal provider that
 * carries the model (provider_config.json; config.json's provider UUIDs are
 * desktop-legacy and unknown to the backend). The requested provider wins when
 * it really carries the model, else the first provider that does. Best-effort —
 * null when the file is missing, unreadable, or lists no match.
 */
function resolvePersonalProviderId(requested: {
  providerId: string;
  modelId: string;
}): string | null {
  try {
    const want = requested.modelId.toLowerCase();
    const carriers = loadPersonalProviders().filter((p) =>
      p.modelIds.some((m) => m.toLowerCase() === want),
    );
    return (
      carriers.find((p) => p.providerId === requested.providerId)?.providerId ??
      carriers[0]?.providerId ??
      null
    );
  } catch (e) {
    log(
      `runtime-model: personal provider map unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
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
