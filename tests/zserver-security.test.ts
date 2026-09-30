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

  it("forwards the session-resume revive primitive (zcode-task.resumeTask)", () => {
    // session/resume must be able to revive a persisted-but-inactive session
    // through the broker — removing this from the allowlist breaks resume
    // across server restarts with a 202 policy rejection.
    expect(validateClientHeader([100, 1, "zcode-task", "resumeTask"]).ok).toBe(true);
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

  it("answers a forbidden call with a readable 202 error and keeps the client attached", async () => {
    await withBroker(async (broker, socketPath) => {
      const client = await rawClient(socketPath);
      client.send([100, 7, "credential", "load"], ["zcodejwttoken"]);
      expect(await untilTrue(() => client.frames.some((f) => f.header[0] === 202))).toBe(true);
      const reply = client.frames.find((f) => f.header[0] === 202)!;
      // The reply carries the CLIENT's id (not a broker-internal one) and names the reason.
      expect(reply.header[1]).toBe(7);
      expect((reply.body as { message: string }).message).toMatch(/credential\.load.*not allowed/);
      expect(client.closed()).toBe(false);
      expect(broker.stats().clients).toBe(1);
      expect(broker.stats().rejected).toBe(1);
      client.destroy();
    });
  });

  it("keeps answering a client that is rejected over and over (a cut-off reads as server death)", async () => {
    await withBroker(async (broker, socketPath) => {
      const client = await rawClient(socketPath);
      expect(await untilTrue(() => client.frames.length > 0)).toBe(true);
      // Far past the old 5-violation cutoff: every one must still get its own reply.
      for (let i = 0; i < 25; i++) client.send([100, 100 + i, "terminal", "create"], []);
      expect(
        await untilTrue(() => client.frames.filter((f) => f.header[0] === 202).length === 25),
      ).toBe(true);
      const ids = client.frames.filter((f) => f.header[0] === 202).map((f) => f.header[1]);
      expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => 100 + i));
      expect(client.closed()).toBe(false);
      expect(broker.stats().clients).toBe(1);
      expect(broker.stats().rejected).toBe(25);
      // ...and a legitimate request on the same connection still works.
      client.send([100, 900, "zcode-task", "listTasks"], undefined);
      expect(
        await untilTrue(() =>
          client.frames.some((f) => f.header[0] === 201 && f.header[1] === 900),
        ),
      ).toBe(true);
      client.destroy();
    });
  });

  it("survives EVERY Object.prototype property name as a channel (one frame must not kill the daemon)", async () => {
    // Regression: table[channel]?.has threw a TypeError for "__proto__" /
    // "constructor" / "toString" …, escaping a `void` promise as an
    // unhandledRejection that terminated the whole shared broker.
    const names = Object.getOwnPropertyNames(Object.prototype);
    expect(names).toContain("__proto__");
    for (const name of names) {
      expect(validateClientHeader([100, 1, name, "x"]).ok, `call ${name}`).toBe(false);
      expect(validateClientHeader([102, 1, name, "x"]).ok, `event ${name}`).toBe(false);
    }
    await withBroker(async (broker, socketPath) => {
      const attacker = await rawClient(socketPath);
      const bystander = await rawClient(socketPath);
      // Both must be attached (Initialize received) before the hostile frames.
      expect(await untilTrue(() => attacker.frames.length > 0 && bystander.frames.length > 0)).toBe(
        true,
      );
      for (const [i, name] of [
        "__proto__",
        "constructor",
        "toString",
        "hasOwnProperty",
      ].entries()) {
        attacker.send([100, i, name, "x"], undefined);
      }
      bystander.send([100, 1, "zcode-task", "listTasks"], undefined);
      // The broker is alive and still routes for the bystander.
      expect(await untilTrue(() => bystander.frames.some((f) => f.header[0] === 201))).toBe(true);
      expect(broker.stats().clients).toBeGreaterThanOrEqual(1);
      attacker.destroy();
      bystander.destroy();
    });
  });

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
