/**
 * Tests for multi-provider model discovery and model-value encoding.
 *
 * History: loadProviderModels() hardcoded a single builtin provider id, so
 * custom providers configured in the ZCode desktop app never appeared in the
 * dropdown. These tests lock the new behaviour: loadAllModels() aggregates ALL
 * enabled builtin providers PLUS every custom provider (the newer CLI no
 * longer sets `enabled` on third-party providers, so filtering on it would
 * drop them). Builtin models encode as bare modelIds, and third-party models
 * carry their providerId prefix.
 *
 * The buildRuntimeModel overlay tests were removed with the overlay itself:
 * zcode 0.16.9 dropped the `runtimeModel` key from the protocol (strict
 * schemas reject it); provider definitions and inline apiKeys now travel only
 * through the workspace provider registry push (provider-registry.ts).
 */

import { describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";

/** Fake config.json with one builtin (OAuth, no apiKey) + one custom (apiKey). */
const FAKE_CONFIG = {
  provider: {
    "builtin:primary": {
      name: "Primary",
      kind: "anthropic",
      enabled: true,
      options: { baseURL: "https://example.test/api" },
      models: {
        "model-a": { limit: { context: 1000000 } },
        "model-b": { limit: { context: 200000 } },
      },
    },
    "builtin:secondary": {
      name: "Secondary",
      kind: "anthropic",
      enabled: false,
      options: { baseURL: "https://example.test/api2" },
      models: { "model-a": { limit: { context: 1000000 } } },
    },
    "custom-provider-alpha": {
      name: "Alpha",
      kind: "openai-compatible",
      enabled: true,
      source: "custom",
      options: {
        apiKey: "test-key-alpha",
        baseURL: "http://127.0.0.1:8000/v1",
      },
      models: {
        "alpha-1": { limit: { context: 200000 } },
      },
    },
    "custom-provider-beta": {
      name: "Beta",
      kind: "anthropic",
      source: "custom",
      options: { apiKey: "test-key-beta", baseURL: "https://example.test/api" },
      models: { "beta-1": { limit: { context: 200000 } } },
    },
    "custom-provider-gamma": {
      name: "Gamma",
      kind: "openai-compatible",
      enabled: false,
      source: "custom",
      options: { apiKey: "test-key-gamma", baseURL: "http://127.0.0.1:8001/v1" },
      models: { "gamma-1": { limit: { context: 200000 } } },
    },
  },
};

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(FAKE_CONFIG);
      return actual.readFileSync(p);
    },
  };
});

// Import AFTER vi.mock is set up.
const { loadAllModels, modelContextWindow, parseModelValue, formatModelValue } = await import(
  "../src/config/options.js"
);

describe("loadAllModels", () => {
  it("collects enabled builtins + active custom providers", () => {
    const models = loadAllModels();
    const ids = models.map((m) => m.modelId);
    // Enabled builtin + enabled custom appear.
    expect(ids).toContain("model-a");
    expect(ids).toContain("model-b");
    expect(ids).toContain("alpha-1");
    // Disabled builtin (Secondary) stays out — its model-a never duplicates.
    expect(ids.filter((id) => id === "model-a")).toHaveLength(1);
    // beta-1 (custom WITHOUT an enabled flag) is included: the newer CLI leaves
    // `enabled` unset on active third-party providers, so "absent" = enabled.
    expect(ids).toContain("beta-1");
    // gamma-1 (custom with an EXPLICIT enabled:false) is excluded.
    expect(ids).not.toContain("gamma-1");
  });

  it("tracks provider identity for every custom provider", () => {
    const models = loadAllModels();
    const beta = models.find((m) => m.modelId === "beta-1");
    expect(beta?.providerName).toBe("Beta");
    expect(beta?.providerId).toBe("custom-provider-beta");
  });

  it("carries the provider name for display", () => {
    const models = loadAllModels();
    const alpha = models.find((m) => m.modelId === "alpha-1");
    expect(alpha?.providerName).toBe("Alpha");
    expect(alpha?.providerId).toBe("custom-provider-alpha");
  });
});

describe("modelContextWindow", () => {
  it("looks up context by provider+model (not hardcoded provider)", () => {
    expect(modelContextWindow("builtin:primary", "model-a")).toBe(1000000);
    expect(modelContextWindow("custom-provider-alpha", "alpha-1")).toBe(200000);
  });

  it("returns 0 for an unknown provider/model", () => {
    expect(modelContextWindow("unknown", "nope")).toBe(0);
  });
});

describe("parseModelValue / formatModelValue", () => {
  it("builtin providers encode as bare modelId (no prefix)", () => {
    // The common case stays clean — builtin models show just the modelId.
    const value = formatModelValue("builtin:primary", "model-a");
    expect(value).toBe("model-a");
    expect(parseModelValue(value)).toEqual({
      providerId: "builtin:primary",
      modelId: "model-a",
    });
  });

  it("third-party providers round-trip providerId + modelId", () => {
    const value = formatModelValue("custom-provider-alpha", "alpha-1");
    expect(value).toBe("custom-provider-alpha\\alpha-1");
    expect(parseModelValue(value)).toEqual({
      providerId: "custom-provider-alpha",
      modelId: "alpha-1",
    });
  });

  it("a plain modelId (no backslash) resolves to the first enabled builtin provider", () => {
    const parsed = parseModelValue("model-a");
    expect(parsed.modelId).toBe("model-a");
    expect(parsed.providerId).toBe("builtin:primary");
  });

  it("splits on the FIRST backslash only (modelId may contain none)", () => {
    const parsed = parseModelValue("pid\\model-a");
    expect(parsed).toEqual({ providerId: "pid", modelId: "model-a" });
  });
});
