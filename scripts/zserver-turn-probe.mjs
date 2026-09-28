// zserver-mode turn probe (ADR-0008 M1a): drives ONE real turn through the
// locally installed zcode-server.cjs using the channel protocol — the same
// surface the desktop uses for remote tasks.
//
//   createTask → subscribe onDynamicStreamEvent/onDynamicTaskTerminalOutcome
//   → sendPrompt("Reply with exactly: ok") → collect events → terminal.
//
// Consumes a tiny amount of real model quota (same convention as
// usage-semantics-probe.mjs). Prints every event's type + compact payload so
// the M1 ACP mapping can be designed against observed shapes instead of
// guesses.
//
// Usage: node scripts/zserver-turn-probe.mjs [workspace-dir] [prompt]
// Exit codes: 0 = turn completed; 1 = failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = path.resolve(
  process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "zserver-turn-")),
);
const prompt = process.argv[3] ?? "Reply with exactly: ok";
const clientId = `zserver-turn-probe-${process.pid}`;
const TURN_TIMEOUT_MS = 60_000;

const { ZServerConnection } = await import("../dist/backend/zserver/index.js");

const env = { ...process.env };
try {
  const { loadDesktopChildEnvWithRefresh } = await import("../dist/desktop-profile.js");
  Object.assign(env, loadDesktopChildEnvWithRefresh());
  // M1a: run the server in LOCAL authority mode so it answers the agent's
  // session/requestRuntimePreferences itself — otherwise it forwards the
  // request to the client (trusted-host-relay reverse RPC, M1b scope).
  env.ZCODE_SERVICE_AUTHORITY_MODE = "local";
  console.log(`[turn] profile env injected (authority forced to local)`);
} catch (error) {
  console.log(`[turn] no desktop profile (${error.message}); plain env`);
}

const connection = await ZServerConnection.spawn({ env, clientId });
console.log("[turn] connection ready");
const tasks = connection.channelOf("zcode-task");
const events = [];
let taskId;

try {
  // 1) createSession on the agent channel — this materializes the session row
  // in the agent db; createTask then adopts it via draftSessionId.
  const snapshot = await connection.call("createSession", { workspacePath: workspace });
  const sessionId = snapshot?.session?.sessionId ?? snapshot?.sessionId ?? snapshot?.session?.id;
  console.log(
    `[turn] createSession → sessionId=${sessionId} snapshotKeys=${snapshot ? Object.keys(snapshot).join(",") : "?"}`,
  );

  // 2) createTask — workspace-scoped task adopting the agent session.
  const created = await tasks.call("createTask", {
    workspacePath: workspace,
    draftSessionId: sessionId,
    clientId,
  });
  taskId = created?.taskId;
  const slashCount = Array.isArray(created?.initialSlashCommands)
    ? created.initialSlashCommands.length
    : "?";
  console.log(`[turn] createTask → taskId=${taskId} slashCommands=${slashCount}`);
  if (!taskId) {
    throw new Error(`createTask returned no taskId: ${JSON.stringify(created)?.slice(0, 200)}`);
  }

  // 2) subscribe BEFORE prompting (short turns complete fast).
  const streamEvents = tasks.listen("onDynamicStreamEvent", taskId, (data) => {
    events.push(data);
  });
  const terminalPromise = new Promise((resolve) => {
    tasks.listen("onDynamicTaskTerminalOutcome", taskId, (data) => resolve(data));
  });

  // 2b) wait for the task to become ready (agent runtime materialized).
  const readyPromise = new Promise((resolve) => {
    tasks.listen("onDynamicTaskReady", taskId, (data) => resolve(data));
  });
  const ready = await Promise.race([
    readyPromise,
    new Promise((resolve) => setTimeout(() => resolve({ kind: "watchdog" }), 30_000)),
  ]);
  console.log(`[turn] task ready: ${JSON.stringify(ready).slice(0, 200)}`);

  // 3) send the prompt.
  await tasks.call("sendPrompt", {
    taskId,
    content: prompt,
    clientId,
    clientMode: "desktop-continuous",
  });
  console.log("[turn] sendPrompt accepted; collecting events…");

  // 4) wait for the terminal outcome.
  const outcome = await Promise.race([
    terminalPromise.then((data) => ({ kind: "terminal", data })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "watchdog" }), TURN_TIMEOUT_MS)),
  ]);
  streamEvents();

  // 5) report.
  const counts = {};
  for (const event of events) {
    const t = event?.type ?? "?";
    counts[t] = (counts[t] ?? 0) + 1;
  }
  console.log(`[turn] event type counts: ${JSON.stringify(counts)}`);
  console.log(`[turn] outcome: ${JSON.stringify(outcome).slice(0, 300)}`);
  const shown = new Set();
  for (const event of events) {
    const t = event?.type ?? "?";
    if (shown.has(t)) continue;
    shown.add(t);
    console.log(`[turn] first "${t}": ${JSON.stringify(event).slice(0, 400)}`);
  }
  if (outcome.kind === "watchdog") {
    console.log("[turn] WATCHDOG — turn did not complete in 60s");
    process.exitCode = 1;
  } else {
    console.log("[turn] turn complete");
  }
} catch (error) {
  console.error(`[turn] failed: ${error.name}: ${error.message}`);
  console.error("[turn] server stderr tail:");
  for (const line of connection.stderrSnapshot()) {
    console.error(`    ${line}`);
  }
  if (taskId) {
    try {
      await tasks.call("closeTask", { taskId });
    } catch {
      /* best-effort */
    }
  }
  connection.dispose();
  process.exit(1);
}

try {
  await tasks.call("closeTask", { taskId });
  console.log("[turn] closeTask ok");
} catch (error) {
  console.log(`[turn] closeTask failed (non-fatal): ${error.message}`);
}
connection.dispose();
