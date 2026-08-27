/**
 * session/set_model (snake_case spelling) regression tests.
 *
 * Multica's kimi-family ACP backend applies a model-pinned agent's model via
 * `session/set_model` with a `modelId` param — the legacy spelling of the
 * bridge's camelCase `session/setModel` extension. The route did not exist,
 * so every model-pinned task failed with -32601 before the alias was added.
 * These tests lock the handler contract for exactly the params Multica sends.
 */

import { describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";
import { setModel } from "../src/handlers/extensions.js";
import { ZcodeAcpServer } from "../src/server.js";

// Minimal fake config so applyModelSwitch's provider lookup never touches
// the real ~/.zcode/v2/config.json (keeps the test deterministic).
const FAKE_CONFIG = {
  provider: {
    "builtin:bigmodel-coding-plan": {
      name: "GLM Coding Plan",
      kind: "anthropic",
      enabled: true,
      options: { baseURL: "https://example.test/api" },
      models: {
        "GLM-5.3": { limit: { context: 1000000 }, reasoning: { variants: ["low", "high", "max"] } },
      },
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

/** Fake backend: records every request; answers setters with ok. */
class FakeBackend {
  isDead = false;
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  async request(
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: number; result?: unknown; error?: unknown }> {
    this.calls.push({ method, params });
    return { id, result: {} };
  }
}

function makeServer(): { server: ZcodeAcpServer; backend: FakeBackend } {
  const server = new ZcodeAcpServer();
  server.registerSession("sess_acp", "sess_zcode");
  const backend = new FakeBackend();
  server.backend = backend as unknown as ZcodeAcpServer["backend"];
  return { server, backend };
}

describe("setModel (session/set_model alias target)", () => {
  it("modelId without a provider prefix resolves to the builtin provider and reaches the backend overlay switch", async () => {
    const { server, backend } = makeServer();
    await setModel(server, { sessionId: "sess_acp", modelId: "GLM-5.3" });
    const call = backend.calls.find((c) => c.method === "session/setModel");
    expect(call).toBeDefined();
    expect(call?.params).toMatchObject({
      sessionId: "sess_zcode",
      persistAsWorkspaceLastUsed: false,
      model: { modelId: "GLM-5.3" },
    });
    const providerId = (call?.params?.model as { providerId?: string })?.providerId;
    expect(providerId).toMatch(/^builtin:/);
    // The overlay must carry the full model definition, not a bare id.
    expect(call?.params?.runtimeModel).toBeDefined();
  });

  it("missing modelId is rejected", async () => {
    const { server } = makeServer();
    await expect(setModel(server, { sessionId: "sess_acp" })).rejects.toThrow(/modelId/);
  });
});
