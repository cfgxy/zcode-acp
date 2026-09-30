/**
 * Dropdown/registry agreement and reasoning-level learning.
 *
 * The backend registry (provider_config.json) is authoritative for personal
 * providers: config.json keeps stale names (claude-sonnet-5 after the upstream
 * rename to claude-sonnet-5-5) that the backend rejects with "Provider Registry
 * 中不存在 Model". And the reasoning-level vocabulary is per model (gpt-6-luna
 * only accepts enabled/disabled), learned from the backend's rejections.
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
        if (providerConfigRaw === null)
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return providerConfigRaw;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

const { buildConfigOptions, loadAllModels, modelContextWindow } =
  await import("../src/config/options.js");
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
    expect(ids).not.toContain("claude-sonnet-5");
    expect(ids).not.toContain("gpt-5.6-luna");
  });

  it("carries the backend provider id and name", () => {
    const m = loadAllModels().find((x) => x.modelId === "gpt-6-luna");
    expect(m).toMatchObject({ providerId: UUID, providerName: "APINoria" });
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
    // config.json-only builtin model: listed there, unknown to the backend
    expect(values).not.toContain("GLM-5.2");
  });

  it("keeps the full config.json list when the read carries no available list", async () => {
    const options = await buildConfigOptions(liveServer({ settings: { model: {} } }), "sess");
    const model = options.find((o) => o.id === "model");
    const values = (model?.options as Array<{ value: string }>).map((o) => o.value);
    expect(values).toContain("GLM-5.3");
  });
});

/** Backend that accepts only `accepted` reasoning levels for any model. */
function fakeServer(accepted: string[] | "none", sent: Array<Record<string, unknown>>) {
  const backend = {
    async request(id: number, method: string, params?: Record<string, unknown>) {
      if (method === "session/read") return { id, result: { settings: { model: {} } } };
      if (method !== "session/setModel") return { id, result: {} };
      const model = params?.model as { options?: { reasoningLevel?: string } };
      sent.push(model as Record<string, unknown>);
      const level = model.options?.reasoningLevel;
      if (accepted === "none") return { id, result: {} };
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

describe("applyModelSwitch reasoning-level ladder", () => {
  it("walks past rejected levels to the one the model accepts (gpt-6-luna: enabled)", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const ok = await applyModelSwitch(fakeServer(["enabled", "disabled"], sent), "s", "gpt-6-luna");
    expect(ok).toBe(true);
    const levels = sent.map(
      (m) => (m.options as { reasoningLevel?: string } | undefined)?.reasoningLevel,
    );
    expect(levels).toEqual([undefined, "max", "high", "enabled"]);
    expect(sent[0]).toMatchObject({ providerId: UUID, modelId: "gpt-6-luna" });
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
        if (method === "session/setModel") sent.push(params as Record<string, unknown>);
        if (method === "session/setModel") {
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
});
