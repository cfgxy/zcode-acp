// zserver-mode live probe (ADR-0008 M0): spawns the LOCALLY INSTALLED
// ~/.zcode/server/zcode-server.cjs in stdio mode, completes the
// zcode-hello / zcode-hello-ack handshake, waits for the channel Initialize
// frame and issues one RPC against the "zcode-agent" channel.
//
// This proves the zcode-server transport end-to-end without the desktop app
// being attached — the identity env (profile pins) is injected at spawn from
// the captured desktop profile when available.
//
// Usage: node scripts/zserver-probe.mjs [--no-profile] [method] [json-args]
//   --no-profile   spawn without the desktop profile env (server falls back to
//                  its own local authority mode)
//   method         default "initialize"
//   json-args      JSON array of positional args, default []
//
// Exit codes: 0 = probe ok; 1 = any failure (message on stderr).
import fs from "node:fs";

const args = process.argv.slice(2);
const noProfile = args.includes("--no-profile");
const filtered = args.filter((a) => a !== "--no-profile");
const method = filtered[0] ?? "initialize";
let methodArgs = [];
if (filtered[1]) {
  try {
    methodArgs = JSON.parse(filtered[1]);
  } catch {
    console.error(`zserver-probe: json-args is not valid JSON: ${filtered[1]}`);
    process.exit(1);
  }
}

const { ZServerConnection } = await import("../dist/backend/zserver/index.js");

const env = { ...process.env };
if (!noProfile) {
  try {
    const { loadDesktopChildEnvWithRefresh } = await import("../dist/desktop-profile.js");
    const profileEnv = loadDesktopChildEnvWithRefresh();
    Object.assign(env, profileEnv);
    console.log(
      `[probe] profile env injected (${Object.keys(profileEnv).length} keys), authority=${profileEnv.ZCODE_SERVICE_AUTHORITY_MODE ?? "none"}`,
    );
  } catch (error) {
    console.log(`[probe] no desktop profile available (${error.message}); spawning with plain env`);
  }
}

const serverRoot = env.ZCODE_SERVER_RUNTIME_ROOT ?? `${process.env.HOME}/.zcode/server`;
if (!fs.existsSync(`${serverRoot}/zcode-server.cjs`)) {
  console.error(`[probe] no zcode-server.cjs at ${serverRoot}`);
  process.exit(1);
}

const startedAt = Date.now();
let connection;
try {
  connection = await ZServerConnection.spawn({
    serverRoot,
    env,
    clientId: `zserver-probe-${process.pid}`,
  });
} catch (error) {
  console.error(`[probe] connection failed: ${error.message}`);
  process.exit(1);
}
console.log(`[probe] handshake + Initialize ok in ${Date.now() - startedAt}ms`);
console.log(`[probe] server hello identified itself via stderr tail:`);
for (const line of connection.stderrSnapshot().slice(-3)) {
  console.log(`        ${line}`);
}

// NOTE: do not subscribe to guessed event names here — the server's
// ProxyChannel.fromService throws synchronously on unknown events, which
// crashes the whole server process (observed 3.14.3). Subscribe only to
// event names confirmed from the service descriptor.

try {
  const result = await Promise.race([
    connection.call(method, ...methodArgs),
    new Promise((_, reject) => setTimeout(() => reject(new Error("call timeout 20s")), 20_000)),
  ]);
  console.log(`[probe] ${method} → ${JSON.stringify(result)}`);
  console.log("[probe] OK — zserver transport verified end-to-end");
} catch (error) {
  console.error(`[probe] ${method} failed: ${error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  connection.dispose();
}
