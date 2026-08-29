// Usage-semantics probe (M0 of the bridge-hardening handoff): drives REAL
// turns against the real zcode backend and records every usage-bearing event
// via the bridge's ZACP_USAGE_DEBUG tap, so the semantics of
// `session.updated` inputTokens vs `turn.completed` totalTokens can be read
// from captured evidence instead of guesswork.
//
// Phases:
//   A) fresh bridge: initialize → session/new → set_model → 3 prompts in ONE
//      session (turn 3 forces a file-read tool call = multi-API-call turn)
//   B) bridge RESTARTED: session/resume the same zcode session → 1 prompt
//      (reveals whether the input bucket re-anchors to full history)
//
// Usage: node scripts/usage-semantics-probe.mjs [cli-cmd] [model-id]
//   cli-cmd  defaults to "node dist/cli.js" (run `pnpm build` first)
//   model-id defaults to "GLM-5.3-Flash"
//
// Consumes real (tiny) model quota. Writes the event capture next to this
// script as usage-probe-events.jsonl and prints a per-turn summary table.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = process.argv[2] ?? "node dist/cli.js";
const model = process.argv[3] ?? "GLM-5.3-Flash";
const [bin, ...args] = cli.split(" ");

const capturePath = join(process.cwd(), "scripts", "usage-probe-events.jsonl");
rmSync(capturePath, { force: true });

// Fixture file the tool-use turn must read (7 lines).
const fixture = join(tmpdir(), `zusage-probe-${Date.now()}.txt`);
writeFileSync(fixture, Array.from({ length: 7 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");

const bridgeEnv = {
  ...process.env,
  ZACP_USAGE_DEBUG: capturePath,
  ZCODE_ACP_DEBUG: "1",
};

let stderrTail = "";

async function phase(label, prompts, resumeSid) {
  const child = spawn(bin, [...args, "acp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: bridgeEnv,
  });
  const responses = new Map();
  let id = 0;
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      responses.set(msg.id, msg);
    }
  });
  child.stderr.on("data", (d) => {
    stderrTail += d.toString();
    process.stderr.write(`[${label} stderr] ${d}`);
  });
  const send = (method, params) => {
    const mid = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    return mid;
  };
  const waitFor = (mid, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        if (responses.has(mid)) {
          clearInterval(tick);
          resolve(responses.get(mid));
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(tick);
          reject(new Error(`timeout waiting for response id=${mid}`));
        }
      }, 50);
    });

  try {
    const iid = send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const init = await waitFor(iid, 30000);
    if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`);

    let sessionId;
    if (resumeSid) {
      // cwd is required by the ACP resume schema (the bridge ignores it — the
      // session root stays backend-authoritative).
      const rid = send("session/resume", { sessionId: resumeSid, cwd: process.cwd() });
      const r = await waitFor(rid, 60000);
      if (r.error) throw new Error(`session/resume error: ${JSON.stringify(r.error)}`);
      sessionId = resumeSid;
    } else {
      const nid = send("session/new", { cwd: process.cwd(), mcpServers: [] });
      const n = await waitFor(nid, 30000);
      if (n.error) throw new Error(`session/new error: ${JSON.stringify(n.error)}`);
      sessionId = n.result.sessionId;
      const sid = send("session/set_model", { sessionId, modelId: model });
      await waitFor(sid, 60000).catch(() => {});
    }

    const usages = [];
    for (const text of prompts) {
      const pid = send("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      const pr = await waitFor(pid, 180000);
      if (pr.error) throw new Error(`prompt error: ${JSON.stringify(pr.error)}`);
      usages.push({ prompt: text.slice(0, 48), usage: pr.result.usage ?? null });
    }
    // The zcode sid is only on stderr debug logs (lazy materialization line):
    // "session/new <acpSid> → created sess_<uuid> (lazy, on first use)".
    const m = stderrTail.match(/created (sess_[0-9a-f-]{36}) \(lazy/);
    return { usages, zcodeSid: m ? m[1] : null, acpSid: sessionId };
  } finally {
    child.kill();
    await new Promise((r) => child.on("exit", r));
  }
}

console.log(`probe fixture: ${fixture}`);
console.log(`capture file: ${capturePath}\n`);

const a = await phase(
  "A",
  [
    "Remember the number 17. Reply with exactly: OK",
    "What number did I ask you to remember? Reply with just the number.",
    `How many lines does the file ${fixture} have? Use your file reading tools to check. Reply with just the number.`,
  ],
  null,
);
console.log(`\nphase A usages (same session, 3 turns):`);
for (const u of a.usages) console.log(`  ${JSON.stringify(u.usage)}  <- ${u.prompt}`);

if (!a.zcodeSid) {
  console.error("\nPROBE INCOMPLETE: zcode sid not found on stderr — cannot run resume phase");
  process.exit(1);
}

const b = await phase(
  "B",
  ["What number did I ask you to remember earlier? Reply with just the number."],
  a.zcodeSid,
);
console.log(`\nphase B usage (bridge restarted, session/resume ${a.zcodeSid.slice(0, 8)}…):`);
for (const u of b.usages) console.log(`  ${JSON.stringify(u.usage)}  <- ${u.prompt}`);

// Summarize the capture: per event, the bucket fields the translator reads.
console.log(`\ncaptured events:`);
const lines = readFileSync(capturePath, "utf8").trim().split("\n");
for (const line of lines) {
  const rec = JSON.parse(line);
  const p = rec.payload ?? {};
  const u = p.usage ?? {};
  const buckets = [
    `usage.in=${u.inputTokens ?? "-"}`,
    `usage.out=${u.outputTokens ?? "-"}`,
    `usage.total=${u.totalTokens ?? "-"}`,
    `tokenCount=${p.tokenCount ?? "-"}`,
    `ctx=${p.contextWindow ?? u.contextWindow ?? "-"}`,
  ].join(" ");
  const extra = Object.keys(u).filter(
    (k) => !["inputTokens", "outputTokens", "totalTokens", "contextWindow"].includes(k),
  );
  const extraStr = extra.length ? ` EXTRA_USAGE_KEYS=[${extra.join(",")}]` : "";
  console.log(`  ${rec.ts} ${rec.event.padEnd(15)} ${buckets}${extraStr}`);
}
console.log(`\nPROBE DONE: ${lines.length} events captured in ${capturePath}`);
