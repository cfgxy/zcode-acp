// External broker introspection with ZERO broker changes: ss + /proc only. `node status-ext.mjs <sock>`
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const sock = process.argv[2];
const rows = execFileSync("ss", ["-xpnH"]).toString().split("\n").filter(Boolean).map((l) => {
  const f = l.trim().split(/\s+/);
  return { state: f[1], path: f[4], inode: f[5], peer: f[7], pids: [...l.matchAll(/pid=(\d+)/g)].map((m) => +m[1]) };
});
const listener = execFileSync("ss", ["-xlpnH"]).toString().split("\n").find((l) => l.includes(` ${sock} `));
const brokerPid = +(/pid=(\d+)/.exec(listener ?? "")?.[1] ?? 0);
if (!brokerPid) { console.log("no broker listening on", sock); process.exit(10); }
const byInode = new Map(rows.map((r) => [r.inode, r]));
const proc = (pid) => { try { return `pid=${pid} comm=${readFileSync(`/proc/${pid}/comm`, "utf8").trim()} cmd=${readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ").slice(0, 70)}`; } catch { return `pid=${pid} (gone)`; } };
const accepted = rows.filter((r) => r.state === "ESTAB" && r.path === sock && r.pids.includes(brokerPid));
console.log(`broker: ${proc(brokerPid)}`);
const kids = execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(brokerPid)]).toString().split("\n").filter((l) => /zcode-server\.cjs/.test(l) && !/ownerPid/.test(l));
console.log(`shared server: ${kids.length ? kids.map((k) => k.trim().split(/\s+/)[0]).join(",") : "none (not spawned yet, or dead)"}`);
console.log(`attached clients: ${accepted.length}`);
for (const a of accepted) console.log("  - " + (byInode.get(a.peer)?.pids ?? []).map(proc).join(" ; "));
