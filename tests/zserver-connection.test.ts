import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ZServerConnection } from "../src/backend/zserver/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

/** Stage a fake server root: copies the fixture as zcode-server.cjs (no node → fallback). */
function makeServerRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-test-"));
  tempDirs.push(root);
  fs.copyFileSync(
    new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
    path.join(root, "zcode-server.cjs"),
  );
  return root;
}

describe("ZServerConnection", () => {
  it("completes the hello handshake across banner noise and serves RPC calls", async () => {
    const connection = await ZServerConnection.spawn({ serverRoot: makeServerRoot() });
    try {
      // The Initialize gate opened — the call resolves with the positional
      // args array echoed back (ProxyChannel spreads them onto the method).
      const result = (await connection.call("initialize", { workspace: "/tmp/w" })) as string;
      expect(result).toBe('echo:initialize:[{"workspace":"/tmp/w"}]');

      // A second call reuses the same ready channel.
      await expect(connection.call("listTasks")).resolves.toBe("echo:listTasks:[]");
    } finally {
      connection.dispose();
    }
  });

  it("rejects spawn when the bundle is missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-empty-"));
    tempDirs.push(root);
    await expect(ZServerConnection.spawn({ serverRoot: root })).rejects.toMatchObject({
      phase: "spawn",
    });
  });

  it("surfaces child exit during handshake with the stderr tail", async () => {
    const root = makeServerRoot();
    // Overwrite the bundle with an immediate crash (stderr line included).
    fs.writeFileSync(
      path.join(root, "zcode-server.cjs"),
      'console.error("无法定位 provider");process.exit(3);\n',
    );
    await expect(ZServerConnection.spawn({ serverRoot: root })).rejects.toMatchObject({
      phase: "hello",
      message: expect.stringContaining("code=3"),
    });
  });
});
