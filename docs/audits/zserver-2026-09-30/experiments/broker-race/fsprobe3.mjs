import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
// Variant A: fresh directory per round (what race.mjs does).  Variant B: one directory reused.
// After the killed process leaves its socket: (1) unlink, then (2) bind in THIS process — the
// exact steps the winning broker performs.
const base = process.argv[2];
const N = Number(process.argv[3] || 60);
const variant = process.argv[4] || "fresh";
const sharedDir = fs.mkdtempSync(path.join(base, "fp3-shared-"));
let reuse = 0, btimeDiffers = 0;
for (let i = 0; i < N; i++) {
  const dir = variant === "fresh" ? fs.mkdtempSync(path.join(base, "fp3-")) : sharedDir;
  const p = path.join(dir, "b.sock");
  const dying = spawn(process.execPath, ["-e",
    "require('node:net').createServer().listen(process.argv[1],()=>console.log('bound'));setInterval(()=>{},1000)", p],
    { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((res) => dying.stdout.once("data", res));
  dying.kill("SIGKILL");
  await new Promise((res) => dying.once("exit", res));
  const before = fs.lstatSync(p, { bigint: true });
  fs.unlinkSync(p);
  const s = net.createServer();
  await new Promise((res, rej) => { s.once("error", rej); s.listen(p, res); });
  const after = fs.lstatSync(p, { bigint: true });
  if (before.ino === after.ino && before.dev === after.dev) { reuse++; if (before.birthtimeNs !== after.birthtimeNs) btimeDiffers++; }
  s.close();
  if (variant === "fresh") fs.rmSync(dir, { recursive: true, force: true });
}
fs.rmSync(sharedDir, { recursive: true, force: true });
console.log(JSON.stringify({ variant, N, inoReused: reuse, reusedButBirthDiffers: btimeDiffers }));
