import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const { ZServerBroker } = await import("/mnt/data/Codes/offcial/zcode-acp/dist/backend/zserver/broker.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "race-root-"));
fs.copyFileSync("/mnt/data/Codes/offcial/zcode-acp/tests/fixtures/zserver-fake-server.mjs", path.join(root, "zcode-server.cjs"));
const ROUNDS = Number(process.argv[2] || 30);
let bad = 0, sameIno = 0;
for (let r = 0; r < ROUNDS; r++) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  const target = path.join(dir, "b.sock");
  const dying = spawn(process.execPath, ["-e",
    "require('node:net').createServer().listen(process.argv[1],()=>console.log('bound'));setInterval(()=>{},1000)", target],
    { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((res) => dying.stdout.once("data", res));
  dying.kill("SIGKILL");
  await new Promise((res) => dying.once("exit", res));
  const probedIno = fs.lstatSync(target).ino;
  const a = new ZServerBroker(target, root), b = new ZServerBroker(target, root);
  const [ra, rb] = await Promise.allSettled([a.start(), b.start()]);
  const winners = [ra, rb].filter((x) => x.status === "fulfilled").length;
  const nowIno = (() => { try { return fs.lstatSync(target).ino; } catch { return null; } })();
  if (nowIno === probedIno) sameIno++;
  if (winners !== 1) {
    bad++;
    console.log(`round ${r}: winners=${winners} probedIno=${probedIno} inoNow=${nowIno} A=${ra.status} B=${rb.status}`);
  }
  await Promise.allSettled([a.stop(), b.stop()]);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`rounds=${ROUNDS} bad=${bad} pathInoEqualsProbedInoAfterStart=${sameIno}`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
