/**
 * Model switching while ZCodeDesktop is closed.
 *
 * The desktop profile goes `stale`/`missing` as soon as the desktop process is
 * gone, but provider_config.json (where personal providers live) does not move.
 * applyModelSwitch maps a config.json-flavoured ref onto the backend's
 * fresh-UUID personal provider through that file; it used to read the path from
 * the profile only, so every non-default model failed with "Provider Registry
 * 中不存在 Model" whenever the desktop was closed.
 */

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyModelSwitch } from "../src/config/runtime-model.js";
import type { ZcodeAcpServer } from "../src/server.js";

const PERSONAL_PATH_SUFFIX = path.join(".zcode", "v2", "provider_config.json");
const BACKEND_UUID = "c5cace45-71df-4a2b-a567-d5e7e1dd6bc9";

const PROVIDER_CONFIG = {
  config: {
    providerConfigRules: {
      providerRules: [
        { providerId: BACKEND_UUID, config: { personalModelIds: ["claude-sonnet-5-5"] } },
      ],
    },
  },
};

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
      if (typeof p === "string" && p.endsWith(PERSONAL_PATH_SUFFIX)) {
        return JSON.stringify(PROVIDER_CONFIG);
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

describe("applyModelSwitch without a usable desktop profile", () => {
  it("still maps a personal-provider model to the backend provider id", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const backend = {
      async request(id: number, method: string, params?: Record<string, unknown>) {
        calls.push({ method, params });
        // The backend's `available` list omits the model (observed for non-default
        // models), which is what forces the provider_config.json lookup.
        if (method === "session/read") return { id, result: { settings: { model: {} } } };
        return { id, result: {} };
      },
    };
    const server = {
      ensureBackend: () => backend,
      nextId: () => 1,
      modelCache: new Map(),
    } as unknown as ZcodeAcpServer;

    const ok = await applyModelSwitch(server, "sess_zcode", `legacy-uuid\\claude-sonnet-5-5`);

    expect(ok).toBe(true);
    const set = calls.find((c) => c.method === "session/setModel");
    expect(set?.params?.model).toMatchObject({
      providerId: BACKEND_UUID,
      modelId: "claude-sonnet-5-5",
    });
  });
});
