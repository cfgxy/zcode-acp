/**
 * Dropdown/registry agreement and reasoning-level learning (RUYI-434).
 *
 * The backend registry (provider_config.json) is authoritative for personal
 * providers: config.json keeps stale names (claude-sonnet-5 after the upstream
 * rename to claude-sonnet-5-5) that the backend rejects with "Provider Registry
 * 中不存在 Model". Live sessions must also drop builtin models the account
 * does not have — against the available ∪ personal-registry UNION, because
 * `available` alone is too narrow (GLM-5.3-Flash is switchable yet absent).
 * The reasoning-level vocabulary is per model (gpt-6-luna only accepts
 * enabled/disabled) and is learned from the backend's two rejection shapes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";

const UUID = "c5cace45-71df-4a2b-a567-d5e7e1dd6bc9";

const CONFIG_JSON = {
  provider: {
    "builtin:plan": {
      name: "Plan",
      kind: "anthropic",
      enabled: true,
      models: {
        "GLM-5.3": { limit: { context: 200000 } },
        "GLM-5.2": { limit: { context: 200000 } },
      },
    },
    "legacy-uuid": {
      name: "Legacy",
      kind: "openai-compatible",
      models: {
        "claude-sonnet-5": { limit: { context: 123 } },
        "gpt-5.6-luna": { limit: { context: 123 } },
      },
    },
  },
};

const PROVIDER_CONFIG = {
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: UUID,
          providerName: "APINoria",
          config: { personalModelIds: ["gpt-6-luna", "claude-sonnet-5-5"] },
        },
      ],
    },
    modelConfigRules: {
      providerModelRules: [
        {
          modelId: "gpt-6-luna",
          providerId: UUID,
          config: { properties: { contextWindow: 1000000 } },
        },
      ],
    },
  },
};

let providerConfigRaw: string | null = JSON.stringify(PROVIDER_CONFIG);

vi.mock("../src/desktop-profile.js", () => ({
  loadDesktopProfile: () => {
    throw Object.assign(new Error("desktop profile is stale"), { code: "stale" });
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string, ...rest: unknown[]) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(CONFIG_JSON);
      if (typeof p === "string" && p.endsWith("provider_config.json")) {
        if (providerConfigRaw === null) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return providerConfigRaw;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

const { buildConfigOptions, loadAllModels, modelContextWindow } = await import(
  "../src/config/options.js"
);
const { applyModelSwitch, resetLearnedLevels } = await import("../src/config/runtime-model.js");

import type { ZcodeAcpServer } from "../src/server.js";

beforeEach(() => {
  providerConfigRaw = JSON.stringify(PROVIDER_CONFIG);
  resetLearnedLevels();
});

describe("loadAllModels follows the backend registry", () => {
  it("lists personal models from provider_config.json, not stale config.json names", () => {
    const ids = loadAllModels().map((m) => m.modelId);
    expect(ids).toContain("GLM-5.3");
    expect(ids).toContain("gpt-6-luna");
    expect(ids).toContain("claude-sonnet-5-5");
    // Renamed upstream: config.json's old name must not linger.
    expect(ids).not.toContain("claude-sonnet-5");
    expect(ids).not.toContain("gpt-5.6-luna");
  });

  it("carries the backend provider id and name", () => {
    const m = loadAllModels().find((x) => x.modelId === "gpt-6-luna");
    expect(m).toMatchObject({ providerId: UUID, providerName: "APINoria" });
  });

  it("does not repeat a builtin model under a personal provider", () => {
    // A personal provider that also carries a builtin-named model must not
    // shadow it — the builtin (account-auth) entry wins.
    const original = CONFIG_JSON.provider["legacy-uuid"].models;
    CONFIG_JSON.provider["legacy-uuid"] = {
      ...CONFIG_JSON.provider["legacy-uuid"],
      models: { "GLM-5.3": { limit: { context: 1 } } },
    };
    try {
      const refs = loadAllModels().filter((m) => m.modelId === "GLM-5.3");
      expect(refs).toHaveLength(1);
      expect(refs[0].providerId).toBe("builtin:plan");
    } finally {
      CONFIG_JSON.provider["legacy-uuid"] = {
        ...CONFIG_JSON.provider["legacy-uuid"],
        models: original,
      };
    }
  });

  it("falls back to config.json custom providers when the registry is unreadable", () => {
    providerConfigRaw = null;
    const ids = loadAllModels().map((m) => m.modelId);
    expect(ids).toContain("claude-sonnet-5");
  });

  it("takes a personal model's context window from the backend registry", () => {
    expect(modelContextWindow(UUID, "gpt-6-luna")).toBe(1000000);
    expect(modelContextWindow("builtin:plan", "GLM-5.3")).toBe(200000);
  });
});

describe("buildConfigOptions on a live session", () => {
  function liveServer(read: unknown) {
    const backend = {
      async request(id: number, method: string) {
        if (method === "session/read") return { id, result: read };
        return { id, result: {} };
      },
    };
    return { ensureBackend: () => backend, nextId: () => 1 } as unknown as ZcodeAcpServer;
  }

  const liveRead = {
    settings: {
      model: {
        current: { providerId: "builtin:plan", modelId: "GLM-5.3" },
        available: [{ ref: { providerId: "account:x", modelId: "GLM-5.3" } }],
      },
    },
  };

  it("drops builtin models the backend account does not have", async () => {
    const options = await buildConfigOptions(liveServer(liveRead), "sess");
    const model = options.find((o) => o.id === "model");
    const values = (model?.options as Array<{ value: string }>).map((o) => o.value);
    expect(values).toContain("GLM-5.3");
    expect(values).toContain(`${UUID}\\gpt-6-luna`);
    // config.json-only builtin model: listed there, unknown to the backend.
    expect(values).not.toContain("GLM-5.2");
  });

  it("keeps a personal model the available list omits (available ∪ registry union)", async () => {
    // gpt-6-luna is in the personal registry but NOT in `available` — the list
    // is narrower than the registry (observed: GLM-5.3-Flash switchable, absent).
    const options = await buildConfigOptions(liveServer(liveRead), "sess");
    const model = options.find((o) => o.id === "model");
    const values = (model?.options as Array<{ value: string }>).map((o) => o.value);
    expect(values).toContain(`${UUID}\\gpt-6-luna`);
  });

  it("keeps the full config.json list when the read carries no available list", async () => {
    const options = await buildConfigOptions(liveServer({ settings: { model: {} } }), "sess");
    const model = options.find((o) => o.id === "model");
    const values = (model?.options as Array<{ value: string }>).map((o) => o.value);
    expect(values).toContain("GLM-5.3");
    expect(values).toContain("GLM-5.2");
  });
});

describe("applyModelSwitch reasoning-level ladder", () => {
  /** Backend that accepts only `accepted` reasoning levels for any model. */
  function fakeServer(accepted: string[], sent: Array<Record<string, unknown>>) {
    const backend = {
      async request(id: number, method: string, params?: Record<string, unknown>) {
        if (method === "session/read") return { id, result: { settings: { model: {} } } };
        if (method !== "session/setModel") return { id, result: {} };
        const model = params?.model as { options?: { reasoningLevel?: string } };
        sent.push(model as Record<string, unknown>);
        const level = model.options?.reasoningLevel;
        if (!level) {
          return { id, error: { code: -32602, message: "Reasoning level is required for p/m" } };
        }
        if (!accepted.includes(level)) {
          return {
            id,
            error: { code: -32602, message: `Reasoning effort "${level}" is not supported by p/m` },
          };
        }
        return { id, result: {} };
      },
    };
    return {
      ensureBackend: () => backend,
      nextId: () => 1,
      modelCache: new Map(),
    } as unknown as ZcodeAcpServer;
  }

  const levelsOf = (sent: Array<Record<string, unknown>>) =>
    sent.map((m) => (m.options as { reasoningLevel?: string } | undefined)?.reasoningLevel);

  it("retries once with max for max/high-vocabulary models", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const ok = await applyModelSwitch(fakeServer(["max"], sent), "s", "GLM-5.3");
    expect(ok).toBe(true);
    expect(levelsOf(sent)).toEqual([undefined, "max"]);
  });

  it("walks past rejected levels for enabled/disabled models (gpt-6-luna)", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const ok = await applyModelSwitch(fakeServer(["enabled", "disabled"], sent), "s", "gpt-6-luna");
    expect(ok).toBe(true);
    expect(levelsOf(sent)).toEqual([undefined, "max", "high", "enabled"]);
    expect(sent[0]).toMatchObject({ providerId: UUID, modelId: "gpt-6-luna" });
  });

  it("skips the resolved defaultLevel when the ladder walks", async () => {
    // available carries defaultLevel=max; backend rejects max, accepts high.
    const backend = {
      async request(id: number, method: string, params?: Record<string, unknown>) {
        if (method === "session/read") {
          return {
            id,
            result: {
              settings: {
                model: {
                  available: [
                    {
                      ref: { providerId: UUID, modelId: "gpt-6-luna" },
                      reasoning: { defaultLevel: "max" },
                    },
                  ],
                },
              },
            },
          };
        }
        if (method !== "session/setModel") return { id, result: {} };
        const model = params?.model as { options?: { reasoningLevel?: string } };
        sent.push(model as Record<string, unknown>);
        const level = model.options?.reasoningLevel;
        if (!level) return { id, result: {} };
        if (level === "max") {
          return {
            id,
            error: { code: -32602, message: `Reasoning effort "max" is not supported by p/m` },
          };
        }
        return { id, result: {} };
      },
    };
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      ensureBackend: () => backend,
      nextId: () => 1,
      modelCache: new Map(),
    } as unknown as ZcodeAcpServer;
    const ok = await applyModelSwitch(server, "s", "gpt-6-luna");
    expect(ok).toBe(true);
    // max tried once (as defaultLevel), never re-sent by the ladder.
    expect(levelsOf(sent)).toEqual(["max", "high"]);
  });

  it("gives up after the bounded ladder and reports failure", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const ok = await applyModelSwitch(fakeServer([], sent), "s", "gpt-6-luna");
    expect(ok).toBe(false);
    // bare ref + the 6 ladder rungs, never unbounded
    expect(sent).toHaveLength(7);
  });

  it("does not retry on an unrelated error", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const backend = {
      async request(id: number, method: string, params?: Record<string, unknown>) {
        if (method === "session/setModel") {
          sent.push(params as Record<string, unknown>);
          return { id, error: { code: 1, message: "Provider Registry 中不存在 Model" } };
        }
        return { id, result: { settings: { model: {} } } };
      },
    };
    const server = {
      ensureBackend: () => backend,
      nextId: () => 1,
      modelCache: new Map(),
    } as unknown as ZcodeAcpServer;
    expect(await applyModelSwitch(server, "s", "gpt-6-luna")).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("remembers the working level: the next switch needs no retries", async () => {
    const first: Array<Record<string, unknown>> = [];
    await applyModelSwitch(fakeServer(["enabled"], first), "s", "gpt-6-luna");
    expect(first.length).toBeGreaterThan(1);

    const second: Array<Record<string, unknown>> = [];
    const ok = await applyModelSwitch(fakeServer(["enabled"], second), "s", "gpt-6-luna");
    expect(ok).toBe(true);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ options: { reasoningLevel: "enabled" } });
  });

  it("prefers the backend's defaultLevel over the learned cache", async () => {
    const ladder: Array<Record<string, unknown>> = [];
    await applyModelSwitch(fakeServer(["enabled"], ladder), "s", "gpt-6-luna");

    // Same model now appears in `available` with a backend-provided default.
    const sent: Array<Record<string, unknown>> = [];
    const backend = {
      async request(id: number, method: string, params?: Record<string, unknown>) {
        if (method === "session/read") {
          return {
            id,
            result: {
              settings: {
                model: {
                  available: [
                    {
                      ref: { providerId: UUID, modelId: "gpt-6-luna" },
                      reasoning: { defaultLevel: "high" },
                    },
                  ],
                },
              },
            },
          };
        }
        if (method !== "session/setModel") return { id, result: {} };
        sent.push(params as Record<string, unknown>);
        return { id, result: {} };
      },
    };
    const server = {
      ensureBackend: () => backend,
      nextId: () => 1,
      modelCache: new Map(),
    } as unknown as ZcodeAcpServer;
    const ok = await applyModelSwitch(server, "s", "gpt-6-luna");
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].model).toMatchObject({ options: { reasoningLevel: "high" } });
  });
});
