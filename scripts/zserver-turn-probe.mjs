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

// A workspace the probe creates itself is removed on exit; a caller-supplied
// one is never touched.
const ownedWorkspace = process.argv[2]
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), "zserver-turn-"));
const workspace = path.resolve(process.argv[2] ?? ownedWorkspace);
process.on("exit", () => {
  if (ownedWorkspace) fs.rmSync(ownedWorkspace, { force: true, recursive: true });
});
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
  // Pin the agent command: the deployed resolver's native-binary candidate
  // (agents/glm/zcode-agent) is absent here; zcode.cjs is the real runtime.
  env.ZCODE_AGENT_SERVER_COMMAND = `${env.ZCODE_SERVER_RUNTIME_ROOT ?? `${process.env.HOME}/.zcode/server`}/node`;
  env.ZCODE_AGENT_SERVER_ARGS_JSON = JSON.stringify([
    `${env.ZCODE_SERVER_RUNTIME_ROOT ?? `${process.env.HOME}/.zcode/server`}/agents/glm/zcode.cjs`,
    "app-server",
    "--stdio",
  ]);
  console.log(`[turn] profile env injected (authority forced to local)`);
} catch (error) {
  console.log(`[turn] no desktop profile (${error.message}); plain env`);
}

const connection = await ZServerConnection.spawn({ env, clientId });
console.log("[turn] connection ready");
const tasks = connection.channelOf("zcode-task");
const agentChannel = connection.channelOf("zcode-agent");
// M1b: trusted-host-relay 必答回路 —— agent 的 session/requestRuntimePreferences
// 经 server 转发为该动态事件；不应答则 session/create 超时、sendText FK 失败。
connection.listen("onDynamicSessionRuntimePreferencesRequest", undefined, (request) => {
  console.log(`[turn] runtime-preferences request ${request?.requestId} scope=${request?.scope}`);
  agentChannel
    .call("respondSessionRuntimePreferences", {
      requestId: request.requestId,
      resolution: {
        status: "ok",
        preferences: {
          nativeSearchEnhancementsEnabled: true,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true,
        },
      },
    })
    .then(() => console.log("[turn] runtime-preferences responded"));
});
const events = [];
let taskId;
let watchdogTimer;

try {
  // 1) createSession on the agent channel — this materializes the session row
  // in the agent db; createTask then adopts it via draftSessionId.
  const snapshot = await connection.call("createSession", {
    workspacePath: workspace,
    persistence: "immediate",
  });
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

  // 2) subscribe BEFORE prompting (short turns complete fast). The inner
  // session event stream carries state updates; the V4 conversation frames
  // carry the actual content deltas (text, tool calls).
  const streamEvents = connection.listen(
    "onDynamicSessionEvent",
    { workspacePath: workspace, sessionId: taskId, deliveryKind: "live" },
    (data) => events.push(data),
  );
  const frames = [];
  const frameEvents = connection.listen(
    "onDynamicConversationFrame",
    { workspacePath: workspace, sessionId: taskId },
    (data) => {
      // Frames are WORKSPACE-scoped: keep only this session's topic.
      if (data?.frame?.topic !== `conversation/${taskId}`) return;
      frames.push(data);
      for (const delta of data?.frame?.payload?.deltas ?? []) events.push(delta);
    },
  );
  try {
    const sub = await Promise.race([
      agentChannel.call("subscribeConversationV4", {
        workspacePath: workspace,
        sessionId: taskId,
        clientMode: "desktop-continuous",
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("subscribe timeout 15s")), 15_000),
      ),
    ]);
    console.log(`[turn] subscribeConversationV4 → ${JSON.stringify(sub).slice(0, 160)}`);
  } catch (error) {
    console.log(`[turn] subscribeConversationV4 failed: ${error.message}`);
  }
  const terminalPromise = new Promise((resolve) => {
    tasks.listen("onDynamicTaskTerminalOutcome", taskId, (data) => resolve(data));
  });

  // 2b) wait for the task to become ready (agent runtime materialized).
  const readyPromise = new Promise((resolve) => {
    tasks.listen("onDynamicTaskReady", taskId, (data) => resolve(data));
  });
  const ready = await Promise.race([
    readyPromise,
    new Promise((resolve) => {
      watchdogTimer = setTimeout(() => resolve({ kind: "watchdog" }), 30_000);
    }),
  ]);
  clearTimeout(watchdogTimer);
  console.log(`[turn] task ready: ${JSON.stringify(ready).slice(0, 200)}`);

  // 3) send the prompt.
  // 走内层 agent 服务的 session/send 协议路径（等价 bridge 的 session/send），
  // 而非 facade 的 v4 sendText —— 后者要求 agent 侧 session 行先落库（FK）。
  await connection.call("sendPrompt", {
    workspacePath: workspace,
    sessionId: taskId,
    content: prompt,
    clientId,
    clientMode: "desktop-continuous",
  });
  console.log("[turn] sendPrompt accepted; collecting events…");

  // 4) wait for the terminal outcome.
  const outcome = await Promise.race([
    terminalPromise.then((data) => ({ kind: "terminal", data })),
    new Promise((resolve) => {
      watchdogTimer = setTimeout(() => resolve({ kind: "watchdog" }), TURN_TIMEOUT_MS);
    }),
  ]);
  streamEvents();

  // 5) report.
  const counts = {};
  for (const event of events) {
    const t = event?.type ?? "?";
    counts[t] = (counts[t] ?? 0) + 1;
  }
  const frameKinds = frames.map(
    (f) =>
      `${f?.kind}/${f?.deliveryKind}:${f?.frame?.entries?.length ?? f?.frame?.messages?.length ?? "?"}`,
  );
  console.log(`[turn] frames(${frames.length}): ${frameKinds.join(" | ").slice(0, 600)}`);
  const ops = [];
  for (const f of frames) {
    for (const d of f?.frame?.payload?.deltas ?? []) {
      ops.push(d);
    }
  }
  console.log(`[turn] delta ops: ${ops.map((d) => d.op).join(", ")}`);
  for (const d of ops) {
    if (d.op === "row.appended" || d.op === "row.upserted" || d.op === "row.updated") {
      console.log(
        `[turn] ${d.op} kind=${d.row?.kind} state=${d.row?.state}: ${JSON.stringify(d.row).slice(0, 350)}`,
      );
    }
  }
  for (const f of frames) {
    if (f?.deliveryKind !== "online") continue;
    const inner = f.frame ?? {};
    console.log(`[turn] online frame keys: ${Object.keys(inner).join(",")}`);
    const batch = inner.batch ?? inner.ops ?? inner.records ?? null;
    console.log(`[turn] online frame body: ${JSON.stringify(batch ?? inner).slice(0, 1200)}`);
    break;
  }
  console.log(`[turn] outcome: ${JSON.stringify(outcome).slice(0, 300)}`);
  const shown = new Set();
  for (const event of [...events, ...frames]) {
    const t = event?.type ?? event?.frame?.type ?? "?";
    if (shown.has(t)) continue;
    shown.add(t);
    console.log(`[turn] first "${t}": ${JSON.stringify(event).slice(0, 400)}`);
  }
  frameEvents();
  clearTimeout(watchdogTimer);
  if (outcome.kind === "watchdog") {
    console.log("[turn] WATCHDOG — turn did not complete in 60s");
    process.exitCode = 1;
  } else {
    console.log("[turn] turn complete");
  }
} catch (error) {
  clearTimeout(watchdogTimer);
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
