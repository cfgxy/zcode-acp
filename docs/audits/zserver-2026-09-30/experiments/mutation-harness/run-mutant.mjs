// usage: node run-mutant.mjs <ID|BASE> [--tests "tests/a.test.ts tests/b.test.ts"] [--tag suffix]
// Applies ONE mutant to the COPY, runs vitest, restores (mv .mutbak), verifies md5 vs snapshot.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = "/tmp/audit-mut-7a5b47d170e6";
const REPO = `${ROOT}/repo`;
const SNAP = "/tmp/zacp-snap-4cfa1d3";
const OUT = `${ROOT}/out`;
const MARK = "7a5b47d170e6";
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const id = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const tag = opt("--tag", "");
const testsArg = opt("--tests", null);
const timeoutMs = Number(opt("--timeout", "420000"));
const label = id + tag;

const md5 = (f) => crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex");

const testFiles = testsArg
  ? testsArg.split(/\s+/).filter(Boolean)
  : fs
      .readdirSync(`${REPO}/tests`)
      .filter((f) => /^zserver-.*\.test\.ts$/.test(f))
      .sort()
      .map((f) => `tests/${f}`);

let mutant = null;
if (id !== "BASE") {
  const { mutants } = await import("./mutants.mjs");
  mutant = mutants.find((m) => m.id === id);
  if (!mutant) {
    console.error(`unknown mutant ${id}`);
    process.exit(2);
  }
}

let restored = true;
let target = null;
let bak = null;
function restore() {
  if (target && bak && fs.existsSync(bak)) {
    fs.renameSync(bak, target); // mv .mutbak -> original
  }
  restored = true;
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    restore();
    process.exit(130);
  });
}

const result = { id: label, desc: mutant?.desc ?? "baseline (no mutation)" };
try {
  if (mutant) {
    target = path.join(REPO, mutant.file);
    bak = `${target}.mutbak`;
    if (fs.existsSync(bak)) throw new Error(`stale backup present: ${bak}`);
    fs.copyFileSync(target, bak, fs.constants.COPYFILE_EXCL); // backup
    fs.chmodSync(bak, fs.statSync(target).mode);
    restored = false;
    let src = fs.readFileSync(target, "utf8");
    for (const e of mutant.edits) {
      const n = src.split(e.old).length - 1;
      const want = e.count ?? 1;
      if (n !== want) {
        result.status = "NOT-APPLIED";
        result.note = `old-string matched ${n}x (wanted ${want}): ${e.old.slice(0, 60)}`;
        throw new Error(result.note);
      }
      src = src.replace(e.old, () => e.neu);
    }
    fs.writeFileSync(target, src);
    const d = spawnSync("diff", ["-u", bak, target], { encoding: "utf8" });
    fs.writeFileSync(`${OUT}/${label}.diff`, d.stdout);
  }

  const outJson = `${OUT}/${label}.json`;
  fs.rmSync(outJson, { force: true });
  const started = Date.now();
  const r = spawnSync(
    `${REPO}/node_modules/.bin/vitest`,
    [
      "run",
      ...testFiles,
      "--no-cache",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${outJson}`,
    ],
    {
      cwd: REPO,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ZACP_AUDIT_MARK: MARK, FORCE_COLOR: "0", NO_COLOR: "1" },
    },
  );
  result.durationMs = Date.now() - started;
  result.exit = r.status;
  result.signal = r.signal;
  fs.writeFileSync(`${OUT}/${label}.log`, `${r.stdout ?? ""}\n---STDERR---\n${r.stderr ?? ""}`);
  result.timedOut = r.error?.code === "ETIMEDOUT";
  const all = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  result.unhandled = /Unhandled (Errors|Rejection)/i.test(all);
  result.syntaxOrImportError = /(SyntaxError|Transform failed|Failed to load url|ERROR.*esbuild)/i.test(all);
} catch (e) {
  result.error = String(e.message ?? e);
} finally {
  restore();
}

// md5 restore proof for the mutated file
if (mutant) {
  const a = md5(target);
  const b = md5(path.join(SNAP, mutant.file));
  result.md5 = { repo: a, snap: b, equal: a === b };
  fs.appendFileSync(
    `${OUT}/restore-proof.txt`,
    `${label}\t${mutant.file}\trepo=${a}\tsnap=${b}\t${a === b ? "OK" : "MISMATCH"}\n`,
  );
}

// parse vitest json
try {
  const j = JSON.parse(fs.readFileSync(`${OUT}/${label}.json`, "utf8"));
  result.total = j.numTotalTests;
  result.passed = j.numPassedTests;
  result.failed = j.numFailedTests;
  result.failedSuites = j.numFailedTestSuites;
  result.failures = [];
  for (const f of j.testResults) {
    if (f.status === "failed" && f.assertionResults.every((a) => a.status !== "failed")) {
      result.failures.push({
        file: path.basename(f.name),
        test: "<FILE-LEVEL FAILURE>",
        msg: String(f.message ?? "").split("\n")[0].slice(0, 200),
      });
    }
    for (const a of f.assertionResults) {
      if (a.status === "failed") {
        result.failures.push({
          file: path.basename(f.name),
          test: a.fullName,
          msg: String((a.failureMessages ?? [""])[0]).split("\n")[0].slice(0, 200),
          ms: a.duration,
        });
      }
    }
  }
} catch (e) {
  result.parseError = String(e.message ?? e);
}

// leaked-process sweep: only processes carrying THIS audit's env marker.
await new Promise((r) => setTimeout(r, 2500)); // let watchdogs (2s tick) reap
const leaked = [];
for (const p of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
  if (Number(p) === process.pid) continue;
  try {
    const env = fs.readFileSync(`/proc/${p}/environ`, "latin1");
    if (env.includes(`ZACP_AUDIT_MARK=${MARK}`)) {
      const cmd = fs.readFileSync(`/proc/${p}/cmdline`, "latin1").replace(/\0/g, " ").slice(0, 100);
      leaked.push({ pid: Number(p), cmd });
    }
  } catch {
    /* gone / not readable */
  }
}
result.leaked = leaked;
for (const l of leaked) {
  try {
    process.kill(l.pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

fs.writeFileSync(`${OUT}/${label}.result.json`, JSON.stringify(result, null, 2));
const verdict =
  result.status === "NOT-APPLIED"
    ? "NOT-APPLIED"
    : result.timedOut
      ? "TIMEOUT"
      : (result.failed ?? 0) > 0 || (result.failedSuites ?? 0) > 0
        ? "RED"
        : result.exit !== 0
          ? "RED(exit!=0, no failing test)"
          : "GREEN";
console.log(
  `${label}\t${verdict}\tfailed=${result.failed}/${result.total}\texit=${result.exit}\tdur=${result.durationMs}ms\tunhandled=${result.unhandled}\tleaked=${leaked.length}\tmd5=${result.md5 ? (result.md5.equal ? "restored-OK" : "MISMATCH!") : "-"}`,
);
for (const f of result.failures ?? []) console.log(`   FAIL ${f.file} :: ${f.test} :: ${f.msg}`);
if (result.error) console.log(`   ERROR ${result.error}`);
