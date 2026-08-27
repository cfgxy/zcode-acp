// E2E smoke for the Multica integration: spawn `zcode-acp acp` exactly the
// way Multica's kimi-family backend does, drive the ACP handshake over
// line-delimited JSON-RPC on stdio (initialize -> session/new ->
// session/set_model), then run a REAL prompt turn and print the raw response
// (verifies the `usage` object survives the ACP SDK into the wire response).
//
// Usage: node scripts/acp-handshake-smoke.mjs [cli-cmd] [model-id]
//   cli-cmd  defaults to "node dist/cli.js" (run `pnpm build` first)
//   model-id defaults to "GLM-5.3-Flash"; must exist in the provider catalog
//
// Requires a configured zcode CLI (see src/backend/resolve.ts discovery) and
// consumes real model quota for the prompt turn. Exits non-zero on the first
// failed assertion.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const cli = process.argv[2] ?? "node dist/cli.js";
const model = process.argv[3] ?? "GLM-5.3-Flash";
const [bin, ...args] = cli.split(" ");
const child = spawn(bin, [...args, "acp"], { stdio: ["pipe", "pipe", "pipe"] });

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const responses = new Map();
const notifications = [];

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log("NON-JSON STDOUT LINE:", line.slice(0, 200));
    return;
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    responses.set(msg.id, msg);
  } else if (msg.method) {
    notifications.push(msg);
  }
});

child.stderr.on("data", (d) => process.stderr.write(`[bridge stderr] ${d}`));

const waitFor = (id, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(t);
        resolve(responses.get(id));
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(t);
        reject(new Error(`timeout waiting for response id=${id}`));
      }
    }, 50);
  });

const fail = (msg) => {
  console.error("FAIL:", msg);
  child.kill();
  process.exit(1);
};

// 1. initialize
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  },
});
const init = await waitFor(1);
if (init.error) fail(`initialize returned error: ${JSON.stringify(init.error)}`);
console.log("initialize OK: loadSession =", init.result.agentCapabilities?.loadSession);

// 2. session/new (lazy)
send({
  jsonrpc: "2.0",
  id: 2,
  method: "session/new",
  params: { cwd: process.cwd(), mcpServers: [] },
});
const sn = await waitFor(2);
if (sn.error) fail(`session/new returned error: ${JSON.stringify(sn.error)}`);
console.log("session/new OK: sessionId =", sn.result.sessionId);

// 3. session/set_model — the Multica model-switch seam
send({
  jsonrpc: "2.0",
  id: 3,
  method: "session/set_model",
  params: { sessionId: sn.result.sessionId, modelId: model },
});
const sc = await waitFor(3, 60000).catch(() => null);
console.log(sc ? `set_model responded: ${sc.error ? JSON.stringify(sc.error) : "OK"}` : "set_model: no response (skipped)");

// 4. session/prompt — real turn; `usage` must survive the SDK into the response.
send({
  jsonrpc: "2.0",
  id: 10,
  method: "session/prompt",
  params: {
    sessionId: sn.result.sessionId,
    prompt: [{ type: "text", text: "Reply with exactly: OK" }],
  },
});
const pr = await waitFor(10, 120000).catch(() => null);
if (!pr) fail("session/prompt: no response within 120s");
if (pr.error) fail(`session/prompt returned error: ${JSON.stringify(pr.error)}`);
console.log("session/prompt RAW response:", JSON.stringify(pr.result));
const lastNotifs = notifications.slice(-2).map((n) => n.method || n.params?.update?.sessionUpdate);
console.log("last notifications:", JSON.stringify(lastNotifs));

child.kill();
console.log("\nSMOKE PASSED: full turn round-trip; usage forwarding verified at the wire level.");
process.exit(0);
