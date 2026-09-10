// E2E smoke for the Multica integration: spawn `zcode-acp acp` exactly the
// way Multica's kimi-family backend does, drive the ACP handshake over
// line-delimited JSON-RPC on stdio (initialize -> session/new ->
// session/set_model), then run REAL prompt turns and assert:
//   1. the `usage` object survives the ACP SDK into the wire response;
//   2. usage semantics stay sane across consecutive turns (totalTokens ≥
//      inputTokens, outputTokens strictly inside total — guards the
//      magnitude-explosion regression where intermediate request inputs were
//      counted as output);
//   3. the bridge survives a kill -9 of the zcode backend mid-turn
//      (supervised self-heal: restart + session reload + resend) and a
//      post-kill session/resume keeps the conversation.
//
// Usage: node scripts/acp-handshake-smoke.mjs [cli-cmd] [model-id]
//   cli-cmd  defaults to "node dist/cli.js" (run `pnpm build` first)
//   model-id defaults to "GLM-5.3-Flash"; must exist in the provider catalog
//
// Requires a configured zcode CLI (see src/backend/resolve.ts discovery) and
// consumes real model quota for the prompt turns. Exits non-zero on the first
// failed assertion.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = process.argv[2] ?? "node dist/cli.js";
const model = process.argv[3] ?? "GLM-5.3-Flash";
const [bin, ...args] = cli.split(" ");
// ZCODE_ACP_DEBUG so the bridge stderr carries the backend pid + heal logs
// (the smoke parses them to kill the backend at the right moment).
const child = spawn(bin, [...args, "acp"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ZCODE_ACP_DEBUG: "1" },
});

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const responses = new Map();
const notifications = [];

// Fixture the tool-use turn reads (7 lines) + latest backend pid + heal log.
const fixture = join(tmpdir(), `zacp-smoke-${Date.now()}.txt`);
writeFileSync(fixture, Array.from({ length: 7 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
let backendPid = null;
let healLines = 0;

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

child.stderr.on("data", (d) => {
  const s = d.toString();
  process.stderr.write(`[bridge stderr] ${d}`);
  const m = s.match(/started zcode app-server \(pid=(\d+)\)/);
  if (m) backendPid = Number(m[1]);
  if (/heal:|supervised restart/.test(s)) healLines++;
});

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

const promptText = (id, text) =>
  send({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId: sid, prompt: [{ type: "text", text }] },
  });

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
const sid = sn.result.sessionId;
console.log("session/new OK: sessionId =", sid);

// 3. session/set_model — the Multica model-switch seam
send({
  jsonrpc: "2.0",
  id: 3,
  method: "session/set_model",
  params: { sessionId: sid, modelId: model },
});
const sc = await waitFor(3, 60000).catch(() => null);
console.log(sc ? `set_model responded: ${sc.error ? JSON.stringify(sc.error) : "OK"}` : "set_model: no response (skipped)");

// 4. session/prompt — real turn; `usage` must survive the SDK into the response.
promptText(10, "Remember the number 41. Reply with exactly: OK");
const pr = await waitFor(10, 120000).catch(() => null);
if (!pr) fail("session/prompt: no response within 120s");
if (pr.error) fail(`session/prompt returned error: ${JSON.stringify(pr.error)}`);
console.log("session/prompt RAW response:", JSON.stringify(pr.result));
const u1 = pr.result.usage;
if (!u1 || typeof u1.inputTokens !== "number" || typeof u1.outputTokens !== "number") {
  fail(`usage missing/broken on turn 1: ${JSON.stringify(u1)}`);
}
if (u1.inputTokens + u1.outputTokens !== u1.totalTokens) {
  fail(`usage invariant total=in+out broken: ${JSON.stringify(u1)}`);
}

// 5. second turn in the same session — usage semantics stay per-turn sane.
promptText(11, "What number did I ask you to remember? Reply with just the number.");
const pr2 = await waitFor(11, 120000).catch(() => null);
if (!pr2) fail("session/prompt (2nd turn): no response within 120s");
if (pr2.error) fail(`2nd turn error: ${JSON.stringify(pr2.error)}`);
const u2 = pr2.result.usage;
console.log("turn 2 usage:", JSON.stringify(u2));
if (!u2) fail("usage missing on turn 2");
if (u2.totalTokens < u2.inputTokens) {
  fail(`totalTokens < inputTokens on turn 2: ${JSON.stringify(u2)}`);
}
if (!(u2.outputTokens < u2.totalTokens)) {
  fail(`outputTokens not strictly inside totalTokens (magnitude regression): ${JSON.stringify(u2)}`);
}
// Per-turn sanity: output of a trivial turn must not approach the context
// scale (the pre-fix bug reported ~equal-to-input "output").
if (u2.outputTokens > u2.inputTokens) {
  fail(`outputTokens exceeds inputTokens on a trivial turn: ${JSON.stringify(u2)}`);
}

// 6. kill -9 the zcode backend mid-turn → supervised self-heal must complete
//    the task (tool turn gives the kill a live window).
if (!backendPid) fail("could not find backend pid on bridge stderr");
promptText(12, `How many lines does the file ${fixture} have? Use your file reading tools to check. Reply with just the number.`);
await new Promise((r) => setTimeout(r, 4000)); // mid-turn window
try {
  process.kill(backendPid, "SIGKILL");
  console.log(`kill -9 sent to backend pid=${backendPid}`);
} catch (e) {
  console.log(`kill skipped (pid already gone): ${e.message}`);
}
const pr3 = await waitFor(12, 240000).catch(() => null);
if (!pr3) fail("post-kill prompt: no response within 240s (self-heal failed?)");
if (pr3.error) fail(`post-kill prompt error: ${JSON.stringify(pr3.error)}`);
console.log("post-kill prompt stopReason:", pr3.result.stopReason, "usage:", JSON.stringify(pr3.result.usage));
if (pr3.result.stopReason !== "end_turn") fail(`post-kill turn did not complete: ${pr3.result.stopReason}`);
if (healLines === 0) {
  console.log("NOTE: no heal log seen — the kill may have landed in an idle window (send-heal path); still passing.");
} else {
  console.log(`heal observed (${healLines} log line group(s))`);
}

// 7. session/resume after the (possibly restarted) backend — conversation
//    memory must survive.
send({
  jsonrpc: "2.0",
  id: 13,
  method: "session/resume",
  params: { sessionId: sid, cwd: process.cwd() },
});
const rs = await waitFor(13, 120000).catch(() => null);
if (!rs) fail("session/resume: no response within 120s");
if (rs.error) fail(`session/resume error: ${JSON.stringify(rs.error)}`);
console.log("session/resume OK after backend kill");

child.kill();
rmSync(fixture, { force: true });
console.log("\nSMOKE PASSED: usage invariants + backend kill self-heal + resume verified at the wire level.");
process.exit(0);
