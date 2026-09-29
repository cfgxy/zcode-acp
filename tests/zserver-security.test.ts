import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isTrustedPinPath, sanitizeDesktopEnv } from "../src/desktop-profile.js";
import {
  BROKER_ALLOWED_CALLS,
  validateClientHeader,
  ZServerBroker,
} from "../src/backend/zserver/broker.js";
import { personalProviderConfigPath } from "../src/config/personal-provider.js";
import { encodeFrame, encodeMessage } from "../src/backend/zserver/protocol.js";
import { connect } from "node:net";

const tempDirs: string[] = [];
const sockets: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
  for (const s of sockets.splice(0)) fs.rmSync(s, { force: true });
});

describe("broker header validation (confused-deputy allowlist)", () => {
  it("allows exactly the RPC surface the bridge uses", () => {
    for (const [channel, methods] of Object.entries(BROKER_ALLOWED_CALLS)) {
      for (const method of methods) {
        expect(validateClientHeader([100, 1, channel, method]).ok).toBe(true);
      }
    }
    expect(validateClientHeader([102, 2, "zcode-agent", "onDynamicConversationFrame"]).ok).toBe(
      true,
    );
    expect(validateClientHeader([103, 2]).ok).toBe(true);
    expect(validateClientHeader([101, 2]).ok).toBe(true);
  });

  it("rejects credential/terminal/file/git and every non-allowlisted method", () => {
    for (const [channel, method] of [
      ["credential", "load"],
      ["terminal", "create"],
      ["file", "readFile"],
      ["git", "commit"],
      ["setting", "get"],
      ["zcode-agent", "disposeAll"],
      ["zcode-task", "enqueueTaskCommand"],
    ] as const) {
      const verdict = validateClientHeader([100, 1, channel, method]);
      expect(verdict.ok, `${channel}.${method}`).toBe(false);
    }
    expect(validateClientHeader([102, 1, "credential", "onDidMutate"]).ok).toBe(false);
  });

  it("rejects malformed shapes that would bypass id rewriting", () => {
    expect(validateClientHeader([100, "x", "zcode-agent", "createSession"]).ok).toBe(false); // string id
    expect(validateClientHeader([100, -1, "zcode-agent", "createSession"]).ok).toBe(false);
    expect(validateClientHeader([100, 1.5, "zcode-agent", "createSession"]).ok).toBe(false);
    expect(validateClientHeader([200, 1]).ok).toBe(false); // response types are not requests
    expect(validateClientHeader([204, 1, "zcode-agent", "createSession"]).ok).toBe(false);
    expect(validateClientHeader([100, 1]).ok).toBe(false); // call missing channel/name
    expect(validateClientHeader([103, 1, "x"]).ok).toBe(false); // dispose must be [type,id]
    expect(validateClientHeader("nope").ok).toBe(false);
    expect(validateClientHeader([100, 1, "zcode-agent", "createSession", "extra"]).ok).toBe(false);
  });

  it("a live broker disconnects a client that sends a forbidden call", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-sec-"));
    tempDirs.push(root);
    fs.copyFileSync(
      new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
      path.join(root, "zcode-server.cjs"),
    );
    const socketPath = path.join(os.tmpdir(), `zsec-${Date.now()}.sock`);
    sockets.push(socketPath);
    const broker = new ZServerBroker(socketPath, root);
    await broker.start();
    try {
      const raw = connect(socketPath);
      await new Promise<void>((resolve, reject) => {
        raw.once("connect", resolve);
        raw.once("error", reject);
      });
      raw.write(encodeFrame(encodeMessage([100, 7, "credential", "load"], ["zcodejwttoken"])));
      const deadline = Date.now() + 3000;
      const clientsOf = (): number =>
        (broker as unknown as { clients: Map<number, unknown> }).clients.size;
      while (Date.now() < deadline && clientsOf() > 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      raw.destroy();
      expect(clientsOf()).toBe(0);
    } finally {
      await broker.stop();
    }
  });

  it("binds the socket 0600 AT CREATION even under a hostile umask (no chmod-after-listen window)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-sec-"));
    tempDirs.push(root);
    const socketPath = path.join(os.tmpdir(), `zsec-mode-${Date.now()}.sock`);
    sockets.push(socketPath);
    // The whole bind→chmod window lives inside one event-loop tick, so no
    // poller can observe it; the broker reports the socket's mode from inside
    // the listen callback (before its own chmod) through a test seam instead.
    let modeAtBirth: number | undefined;
    const previous = process.umask(0o000); // hostile: a plain bind would yield 0777
    const broker = new ZServerBroker(socketPath, root);
    broker.onBoundForTest = (mode) => {
      modeAtBirth = mode;
    };
    try {
      await broker.start();
    } finally {
      process.umask(previous);
      await broker.stop();
    }
    expect(modeAtBirth).toBe(0o600);
  });
});

describe("profile pin path validation", () => {
  const home = "/home/tester";
  it("accepts pins under home, AppImage mounts and system roots", () => {
    expect(isTrustedPinPath(`${home}/.zcode/server/node`, home)).toBe(true);
    expect(isTrustedPinPath("/tmp/.mount_ZCode-6EQ0Ir/resources/tools/rg/rg", home)).toBe(true);
    expect(isTrustedPinPath("/opt/ZCode/resources/glm/zcode.cjs", home)).toBe(true);
  });

  it("rejects attacker-writable and traversal paths", () => {
    expect(isTrustedPinPath("/tmp/evil/provider.json", home)).toBe(false);
    expect(isTrustedPinPath("/var/tmp/x", home)).toBe(false);
    expect(isTrustedPinPath("relative/path", home)).toBe(false);
    expect(isTrustedPinPath(`${home}/../etc/passwd`, home)).toBe(false);
    expect(isTrustedPinPath(`${home}-evil/x`, home)).toBe(false); // prefix-confusion
    expect(isTrustedPinPath("/tmp/.mount_x/../../evil", home)).toBe(false);
  });

  it("sanitizeDesktopEnv refuses a tampered path pin (fails closed)", () => {
    expect(() =>
      sanitizeDesktopEnv({ ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/tmp/attacker/provider.json" }),
    ).toThrowError("desktop profile invalid");
    expect(() => sanitizeDesktopEnv({ ZCODE_SERVER_RUNTIME_ROOT: "/tmp/attacker" })).toThrowError(
      "desktop profile invalid",
    );
  });
});

describe("API-key write target confinement", () => {
  it("ignores a provider-config pin outside ~/.zcode (key must not be written there)", () => {
    const resolved = personalProviderConfigPath({
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/tmp/attacker/provider_config.json",
    } as NodeJS.ProcessEnv);
    expect(resolved).toBe(path.join(os.homedir(), ".zcode", "v2", "provider_config.json"));
  });

  it("accepts the legitimate pin under ~/.zcode", () => {
    const legit = path.join(os.homedir(), ".zcode", "v2", "provider_config.json");
    expect(
      personalProviderConfigPath({
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: legit,
      } as NodeJS.ProcessEnv),
    ).toBe(legit);
  });

  it("rejects a symlink inside ~/.zcode-like dir that escapes it", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zsec-out-"));
    tempDirs.push(outside);
    fs.writeFileSync(path.join(outside, "provider_config.json"), "{}");
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "zsec-link-"));
    tempDirs.push(linkDir);
    const link = path.join(linkDir, "provider_config.json");
    fs.symlinkSync(path.join(outside, "provider_config.json"), link);
    const resolved = personalProviderConfigPath({
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: link,
    } as NodeJS.ProcessEnv);
    expect(resolved).toBe(path.join(os.homedir(), ".zcode", "v2", "provider_config.json"));
  });
});

describe("broker spawn env hygiene", () => {
  it("strips task-scoped credentials (MULTICA_*, SSH agent) but keeps ordinary env", async () => {
    const { brokerBaseEnv } = await import("../src/backend/zserver/backend.js");
    const scrubbed = brokerBaseEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      MULTICA_TOKEN: "secret-task-token",
      MULTICA_TASK_ID: "t-1",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      ZCODE_ENV: "production",
    });
    expect(scrubbed).toEqual({ PATH: "/usr/bin", HOME: "/home/u", ZCODE_ENV: "production" });
  });
});
