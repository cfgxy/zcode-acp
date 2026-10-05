/**
 * Pending-screen registry filter + model-switch push (RUYI-437).
 *
 * Pending sessions (zcodeSid null) never read the backend, so the live
 * available-set stayed null and config.json's stale builtins (GLM-5.2,
 * GLM-5-Turbo, GLM-4.7-Flash, GLM-4.7 — all rejected by the backend registry
 * with "Provider Registry 中不存在 Model") lingered in the first-screen
 * dropdown. The personal registry alone filters them there. And unlike
 * setMode, session/setModel / session/updateRuntimeModelConfig rebuilt
 * nothing after a successful switch — the backend emits no state.updated on
 * a model switch (RUYI-434 QA), so the bridge pushes the rebuilt
 * config_option_update itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";

import { ZCODE_CREDS_PATH } from "../src/utils.js";

const UUID = "e71e30e7-d94e-4b81-9bcf-8802d2d86b62";
const BUILTIN = "builtin:bigmodel-coding-plan";

// Mirror the QA-observed shape: config.json still lists four builtin models
// the backend registry has dropped; the registry keeps GLM-5.3 (+Flash).
const CONFIG_JSON = {
  provider: {
    [BUILTIN]: {
      name: "GLM Coding Plan",
      kind: "anthropic",
      enabled: true,
      models: {
        "GLM-5.3": { limit: { context: 200000 } },
        "GLM-5.2": { limit: { context: 200000 } },
        "GLM-5-Turbo": { limit: { context: 200000 } },
        "GLM-4.7-Flash": { limit: { context: 200000 } },
        "GLM-4.7": { limit: { context: 200000 } },
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
          providerName: "GLM",
          config: { personalModelIds: ["GLM-5.3", "GLM-5.3-Flash"] },
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

const { buildConfigOptions } = await import("../src/config/options.js");
const { setModel, updateRuntimeModelConfig } = await import("../src/handlers/extensions.js");
const { setConfigOptionHandler } = await import("../src/handlers/session.js");

import { ZcodeAcpServer } from "../src/server.js";

beforeEach(() => {
  providerConfigRaw = JSON.stringify(PROVIDER_CONFIG);
});

describe("pending builtin filter (buildConfigOptions, zcodeSid null)", () => {
  it("drops the four registry-dead builtins and keeps GLM-5.3", async () => {
    const server = new ZcodeAcpServer();
    const options = await buildConfigOptions(server, null);
    const model = options.find((o) => o.id === "model");
    const values = (model?.options as Array<{ value: string }>).map((o) => o.value);
    for (const stale of ["GLM-5.2", "GLM-5-Turbo", "GLM-4.7-Flash", "GLM-4.7"]) {
      expect(values).not.toContain(stale);
    }
    expect(values).toContain("GLM-5.3");
  });

  it("the current value follows the FILTERED leading entry, no pre-pend resurrection", async () => {
    // config.json lists a stale model FIRST; the registry keeps only GLM-5.3.
    const original = { ...CONFIG_JSON.provider[BUILTIN].models };
    CONFIG_JSON.provider[BUILTIN].models = {
      "GLM-5.2": original["GLM-5.2"],
      "GLM-5.3": original["GLM-5.3"],
      "GLM-4.7": original["GLM-4.7"],
    };
    try {
      const server = new ZcodeAcpServer();
      const options = await buildConfigOptions(server, null);
      const model = options.find((o) => o.id === "model");
      expect(model?.currentValue).toBe("GLM-5.3");
      const values = (model?.options as Array<{ value: string }>).map((o) => o.value);
      expect(values).not.toContain("GLM-5.2");
      // The stale leader must not come back through the pre-pend branch.
      expect(values.filter((v) => v === "GLM-5.3")).toHaveLength(1);
    } finally {
      CONFIG_JSON.provider[BUILTIN].models = original;
    }
  });

  it("keeps the full config.json list when the registry file is missing", async () => {
    providerConfigRaw = null;
    const server = new ZcodeAcpServer();
    const options = await buildConfigOptions(server, null);
    const model = options.find((o) => o.id === "model");
    const values = (model?.options as Array<{ value: string }>).map((o) => o.value);
    expect(values).toContain("GLM-5.3");
    expect(values).toContain("GLM-5.2");
    expect(values).toContain("GLM-4.7");
  });

  it("keeps the full list when the registry carries no provider rules", async () => {
    providerConfigRaw = JSON.stringify({
      config: { providerConfigRules: { providerRules: [] } },
    });
    const server = new ZcodeAcpServer();
    const options = await buildConfigOptions(server, null);
    const model = options.find((o) => o.id === "model");
    const values = (model?.options as Array<{ value: string }>).map((o) => o.value);
    expect(values).toContain("GLM-5.2");
    expect(values).toContain("GLM-5.3");
  });
});

describe("model-switch handlers push config_option_update", () => {
  // session/read AFTER a successful switch: settings.model.current already
  // names the new model — the pushed currentValue must agree with it.
  const READ_AFTER_SWITCH = {
    settings: {
      model: {
        current: { providerId: BUILTIN, modelId: "GLM-5.3" },
        available: [{ ref: { providerId: UUID, modelId: "GLM-5.3" } }],
      },
    },
  };

  function makeServer(opts: { switchOk: boolean }) {
    const server = new ZcodeAcpServer();
    server.registerSession("sess_acp", "sess_zcode");
    const backend = {
      async request(id: number, method: string) {
        if (method === "session/read") return { id, result: READ_AFTER_SWITCH };
        if (method === "session/setModel") {
          return opts.switchOk
            ? { id, result: {} }
            : { id, error: { code: 1, message: "Provider Registry 中不存在 Model" } };
        }
        return { id, result: {} };
      },
    };
    server.backend = backend as unknown as ZcodeAcpServer["backend"];
    const notifications: Array<{ method: string; update: Record<string, unknown> }> = [];
    const cx = {
      notify: async (method: string, params: Record<string, unknown>) => {
        notifications.push({ method, update: params.update as Record<string, unknown> });
      },
    } as unknown as acp.AgentContext;
    return { server, notifications, cx };
  }

  const modelOptionOf = (update: Record<string, unknown>) => {
    expect(update.sessionUpdate).toBe("config_option_update");
    const model = (update.configOptions as Array<{ id: string; currentValue: string }>).find(
      (o) => o.id === "model",
    );
    return model?.currentValue;
  };

  it("session/setModel success pushes the update; currentValue agrees with session/read", async () => {
    const { server, notifications, cx } = makeServer({ switchOk: true });
    await setModel(server, { sessionId: "sess_acp", modelId: "GLM-5.3" }, cx);
    const pushed = notifications.filter((n) => n.update.sessionUpdate === "config_option_update");
    expect(pushed).toHaveLength(1);
    expect(modelOptionOf(pushed[0].update)).toBe("GLM-5.3");
  });

  it("session/setModel failure throws and pushes nothing", async () => {
    const { server, notifications, cx } = makeServer({ switchOk: false });
    await expect(
      setModel(server, { sessionId: "sess_acp", modelId: "GLM-5.2" }, cx),
    ).rejects.toThrow(/rejected/);
    expect(notifications).toHaveLength(0);
  });

  it("session/updateRuntimeModelConfig success pushes; failure does not", async () => {
    const ok = makeServer({ switchOk: true });
    await updateRuntimeModelConfig(
      ok.server,
      { sessionId: "sess_acp", runtimeModel: { model: { providerId: BUILTIN, modelId: "GLM-5.3" } } },
      ok.cx,
    );
    const pushed = ok.notifications.filter(
      (n) => n.update.sessionUpdate === "config_option_update",
    );
    expect(pushed).toHaveLength(1);
    expect(modelOptionOf(pushed[0].update)).toBe("GLM-5.3");

    const fail = makeServer({ switchOk: false });
    await expect(
      updateRuntimeModelConfig(
        fail.server,
        { sessionId: "sess_acp", runtimeModel: { model: { modelId: "GLM-5.2" } } },
        fail.cx,
      ),
    ).rejects.toThrow(/rejected/);
    expect(fail.notifications).toHaveLength(0);
  });

  it("session/set_config_option(model) still pushes (existing path, regression guard)", async () => {
    const { server, notifications, cx } = makeServer({ switchOk: true });
    const resp = await setConfigOptionHandler(
      server,
      { sessionId: "sess_acp", configId: "model", value: "GLM-5.3" } as unknown as acp.SetSessionConfigOptionRequest,
      cx,
    );
    const pushed = notifications.filter((n) => n.update.sessionUpdate === "config_option_update");
    expect(pushed).toHaveLength(1);
    expect(modelOptionOf(pushed[0].update)).toBe("GLM-5.3");
    expect(resp.configOptions.find((o) => o.id === "model")?.currentValue).toBe("GLM-5.3");
  });
});
