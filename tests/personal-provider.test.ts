/**
 * Tests for the GLM personal-provider guard that `zcode-acp profile refresh`
 * runs after every profile re-capture: the desktop provisions
 * provider_config.json on update/sync and drops manually-added entries, so
 * the guard must idempotently re-add the GLM Coding Plan (same apiKey as
 * config.json's builtin plan provider → same billing) and skip cleanly on
 * every malformed/absent input — never throwing into the refresh path.
 */

import { describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";

const HOME = "/home/test";

vi.mock("node:os", () => ({
  default: { homedir: () => HOME },
}));

/** Map-based fake fs rooted at these files. */
const files = new Map<string, string>();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string, enc?: string) => {
      if (files.has(p)) return files.get(p);
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
    writeFileSync: (p: string, data: string) => {
      files.set(p, typeof data === "string" ? data : String(data));
    },
    copyFileSync: (from: string, to: string) => {
      if (!files.has(from)) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.set(to, files.get(from)!);
    },
    chmodSync: () => {},
    renameSync: (from: string, to: string) => {
      if (!files.has(from)) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    // actual is only used for its constants; keep shape honest
    __actual: actual,
  } as unknown as typeof import("node:fs");
});

const { ensurePersonalGlmProvider, personalProviderConfigPath, planApiKey } = await import(
  "../src/config/personal-provider.js"
);

const PROVIDER_CONFIG_PATH = `${HOME}/.zcode/v2/provider_config.json`;

function baseProviderConfig(): string {
  return JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  });
}

const ZCODE_CONFIG = JSON.stringify({
  provider: {
    "builtin:bigmodel-coding-plan": {
      enabled: true,
      options: { baseURL: "https://open.bigmodel.cn/api/anthropic", apiKey: "plan-key-123" },
      models: { "GLM-5.3": {} },
    },
  },
});

function setup(opts: { providerConfig?: string; zcodeConfig?: string } = {}): { writes: string[] } {
  files.clear();
  files.set(PROVIDER_CONFIG_PATH, opts.providerConfig ?? baseProviderConfig());
  files.set(ZCODE_CREDS_PATH, opts.zcodeConfig ?? ZCODE_CONFIG);
  const writes: string[] = [];
  return { writes };
}

describe("ensurePersonalGlmProvider", () => {
  it("adds the GLM entry with the plan apiKey when absent", () => {
    setup();
    const outcome = ensurePersonalGlmProvider(PROVIDER_CONFIG_PATH, ZCODE_CREDS_PATH, (p, d) => {
      files.set(p, d);
    });
    expect(outcome.status).toBe("added");
    if (outcome.status !== "added") return;
    const saved = JSON.parse(files.get(PROVIDER_CONFIG_PATH)!);
    const rules = saved.config.providerConfigRules.providerRules;
    const glm = rules.find((r: { providerId: string }) => r.providerId === outcome.providerId);
    expect(glm.config.access).toEqual({ type: "api-key", apiKey: "plan-key-123" });
    expect(glm.config.api).toEqual({ type: "anthropic-messages", baseUrl: "https://open.bigmodel.cn/api/anthropic" });
    expect(glm.config.personalModelIds).toEqual(["GLM-5.3-Flash", "GLM-5.3"]);
    // per-model rules registered too
    const modelRules = saved.config.modelConfigRules.providerModelRules;
    expect(modelRules.filter((m: { providerId: string }) => m.providerId === outcome.providerId)).toHaveLength(2);
  });

  it("is idempotent — reports present without rewriting when a GLM entry exists", () => {
    setup();
    const first = ensurePersonalGlmProvider(PROVIDER_CONFIG_PATH, ZCODE_CREDS_PATH, (p, d) => {
      files.set(p, d);
    });
    expect(first.status).toBe("added");
    const before = files.get(PROVIDER_CONFIG_PATH);
    const second = ensurePersonalGlmProvider(PROVIDER_CONFIG_PATH, ZCODE_CREDS_PATH, () => {
      throw new Error("must not write when present");
    });
    expect(second).toEqual({ status: "present", providerId: (first as { providerId: string }).providerId });
    expect(files.get(PROVIDER_CONFIG_PATH)).toBe(before);
  });

  it("detects GLM entries case-insensitively (desktop writes lowercase ids)", () => {
    setup({
      providerConfig: JSON.stringify({
        config: {
          providerConfigRules: {
            providerRules: [
              { providerId: "p1", config: { personalModelIds: ["glm-5.3-flash"] } },
            ],
          },
        },
      }),
    });
    const outcome = ensurePersonalGlmProvider(PROVIDER_CONFIG_PATH, ZCODE_CREDS_PATH, () => {
      throw new Error("must not write");
    });
    expect(outcome).toEqual({ status: "present", providerId: "p1" });
  });

  it("skips when config.json has no usable plan apiKey", () => {
    setup({ zcodeConfig: JSON.stringify({ provider: {} }) });
    const outcome = ensurePersonalGlmProvider(PROVIDER_CONFIG_PATH, ZCODE_CREDS_PATH, () => {
      throw new Error("must not write");
    });
    expect(outcome.status).toBe("skipped");
  });

  it("skips on unreadable or malformed provider_config.json without throwing", () => {
    files.clear();
    files.set(ZCODE_CREDS_PATH, ZCODE_CONFIG);
    expect(ensurePersonalGlmProvider(PROVIDER_CONFIG_PATH, ZCODE_CREDS_PATH).status).toBe("skipped");

    setup({ providerConfig: "not json" });
    expect(ensurePersonalGlmProvider(PROVIDER_CONFIG_PATH, ZCODE_CREDS_PATH).status).toBe("skipped");

    setup({ providerConfig: JSON.stringify({ config: {} }) });
    expect(ensurePersonalGlmProvider(PROVIDER_CONFIG_PATH, ZCODE_CREDS_PATH).status).toBe("skipped");
  });
});

describe("personalProviderConfigPath", () => {
  it("prefers the desktop-pinned env path", () => {
    expect(
      personalProviderConfigPath({ ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/pinned/provider_config.json" }),
    ).toBe("/pinned/provider_config.json");
  });

  it("falls back to ~/.zcode/v2/provider_config.json", () => {
    expect(personalProviderConfigPath({})).toBe(`${HOME}/.zcode/v2/provider_config.json`);
  });
});

describe("planApiKey", () => {
  it("reads the enabled bigmodel provider's key from config.json", () => {
    setup();
    expect(planApiKey(ZCODE_CREDS_PATH)).toBe("plan-key-123");
  });

  it("ignores enabled providers on other hosts and missing files", () => {
    setup({
      zcodeConfig: JSON.stringify({
        provider: { other: { enabled: true, options: { baseURL: "https://api.example.com", apiKey: "x" } } },
      }),
    });
    expect(planApiKey(ZCODE_CREDS_PATH)).toBeNull();
    expect(planApiKey("/nonexistent/path")).toBeNull();
  });
});
