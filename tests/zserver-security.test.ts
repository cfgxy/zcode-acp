import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isTrustedPinPath, sanitizeDesktopEnv } from "../src/desktop-profile.js";
import { validateClientHeader, ZServerBroker } from "../src/backend/zserver/broker.js";
import { personalProviderConfigPath } from "../src/config/personal-provider.js";
import {
  decodeMessage,
  encodeFrame,
  encodeMessage,
  FrameDecoder,
} from "../src/backend/zserver/protocol.js";
import { connect } from "node:net";

const tempDirs: string[] = [];
const sockets: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
  for (const s of sockets.splice(0)) fs.rmSync(s, { force: true });
});

describe("broker header validation", () => {
  it("does not restrict which (channel, name) a well-formed header names", () => {
    for (const [channel, method] of [
      ["zcode-agent", "createSession"],
      ["zcode-task", "resumeTask"],
      ["credential", "load"],
      ["terminal", "create"],
      ["file", "readFile"],
      ["git", "commit"],
    ] as const) {
      expect(validateClientHeader([100, 1, channel, method]).ok, `${channel}.${method}`).toBe(true);
    }
    expect(validateClientHeader([102, 2, "zcode-agent", "onDynamicConversationFrame"]).ok).toBe(
      true,
    );
    expect(validateClientHeader([102, 1, "credential", "onDidMutate"]).ok).toBe(true);
    expect(validateClientHeader([103, 2]).ok).toBe(true);
    expect(validateClientHeader([101, 2]).ok).toBe(true);
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

  /** A raw broker client that collects decoded frames and closure. */
  async function rawClient(socketPath: string): Promise<{
    send(header: unknown, body?: unknown): void;
    sendRaw(bytes: Buffer): void;
    frames: Array<{ header: unknown[]; body: unknown }>;
    closed(): boolean;
    destroy(): void;
  }> {
    const raw = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", resolve);
      raw.once("error", reject);
    });
    const frames: Array<{ header: unknown[]; body: unknown }> = [];
    let closed = false;
    const decoder = new FrameDecoder((payload) => {
      const message = decodeMessage(payload);
      frames.push({ header: message.header as unknown[], body: message.body });
    });
    raw.on("data", (chunk: Buffer) => decoder.push(chunk));
    raw.on("close", () => (closed = true));
    raw.on("error", () => undefined);
    return {
      send: (header, body) => raw.write(encodeFrame(encodeMessage(header, body))),
      sendRaw: (bytes) => raw.write(bytes),
      frames,
      closed: () => closed,
      destroy: () => raw.destroy(),
    };
  }

  async function withBroker(
    run: (broker: ZServerBroker, socketPath: string) => Promise<void>,
  ): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-sec-"));
    tempDirs.push(root);
    fs.copyFileSync(
      new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
      path.join(root, "zcode-server.cjs"),
    );
    const socketPath = path.join(
      os.tmpdir(),
      `zsec-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
    );
    sockets.push(socketPath);
    const broker = new ZServerBroker(socketPath, root);
    await broker.start();
    try {
      await run(broker, socketPath);
    } finally {
      await broker.stop();
    }
  }

  const untilTrue = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return cond();
  };

  it("caps outstanding requests per client instead of growing its id maps without bound", async () => {
    process.env.ZCODE_ACP_ZSERVER_MAX_PENDING = "3";
    process.env.ZSERVER_FAKE_HANG_METHODS = "listTasks";
    try {
      await withBroker(async (broker, socketPath) => {
        const client = await rawClient(socketPath);
        expect(await untilTrue(() => client.frames.length > 0)).toBe(true);
        for (let i = 0; i < 6; i++) client.send([100, i, "zcode-task", "listTasks"], undefined);
        // The first 3 hang server-side; the other 3 are answered by the broker itself.
        expect(
          await untilTrue(() => client.frames.filter((f) => f.header[0] === 202).length === 3),
        ).toBe(true);
        const limited = client.frames.filter((f) => f.header[0] === 202);
        expect((limited[0]!.body as { name: string }).name).toBe("BrokerLimitError");
        expect(broker.stats().pending).toBe(3);
        // A limit is not misbehaviour: the client stays attached.
        expect(client.closed()).toBe(false);
        client.destroy();
      });
    } finally {
      delete process.env.ZCODE_ACP_ZSERVER_MAX_PENDING;
      delete process.env.ZSERVER_FAKE_HANG_METHODS;
    }
  });

  it("cuts off a client whose frame cannot be decoded at all", async () => {
    await withBroker(async (broker, socketPath) => {
      const client = await rawClient(socketPath);
      expect(await untilTrue(() => client.frames.length > 0)).toBe(true);
      // Array tag claiming 2^28 elements in a 6-byte payload: undecodable.
      const bomb = Buffer.from([4, 0x80, 0x80, 0x80, 0x80, 0x01]);
      const header = Buffer.alloc(13);
      header.writeUInt8(1, 0);
      header.writeUInt32BE(bomb.length, 9);
      client.sendRaw(Buffer.concat([header, bomb]));
      expect(await untilTrue(() => client.closed())).toBe(true);
      expect(await untilTrue(() => broker.stats().clients === 0)).toBe(true);
    });
  });

  it("binds the socket 0600 AT CREATION even under a hostile umask (no chmod-after-listen window)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-sec-"));
    tempDirs.push(root);
    const socketPath = path.join(os.tmpdir(), `zsec-mode-${Date.now()}.sock`);
    sockets.push(socketPath);
    // The bind→chmod window is unobservable by polling; the broker reports the
    // socket's mode right after the synchronous bind (before its own chmod)
    // through a test seam instead.
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

  it("fails closed on a degenerate home (HOME=/ or empty used to trust EVERY path)", () => {
    // HOME=/ (a uid with no passwd entry, some containers) made homeRoot "/", so the
    // home check accepted /etc/passwd, /tmp/evil/... and everything else.
    for (const home of ["/", "", "relative/home", "//"]) {
      expect(isTrustedPinPath("/etc/passwd", home), `home=${JSON.stringify(home)}`).toBe(false);
      expect(isTrustedPinPath("/tmp/evil/rg", home), `home=${JSON.stringify(home)}`).toBe(false);
      expect(isTrustedPinPath("/root/.ssh/x", home), `home=${JSON.stringify(home)}`).toBe(false);
    }
    // The fixed roots still work regardless of home...
    expect(isTrustedPinPath("/opt/ZCode/resources/glm/zcode.cjs", "/")).toBe(true);
    expect(isTrustedPinPath("/tmp/.mount_ZCode-6EQ0Ir/resources/tools/rg/rg", "")).toBe(true);
    // ...and a healthy home is unaffected.
    expect(isTrustedPinPath("/home/tester/.zcode/server/node", "/home/tester")).toBe(true);
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
