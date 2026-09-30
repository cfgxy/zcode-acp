import net from "node:net";
import fs from "node:fs";
import path from "node:path";
const dir = process.argv[2];
const p = path.join(dir, "s.sock");
const bind = () => new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(p, () => res(s)); });
let same = 0; const N = 40; let sameCtime = 0;
for (let i = 0; i < N; i++) {
  const a = await bind();
  const sa = fs.lstatSync(p, { bigint: true });
  // Simulate "removed as stale, then another broker binds a new one": unlink, then a fresh bind.
  a.close(); try { fs.unlinkSync(p); } catch {}
  const b = await bind();
  const sb = fs.lstatSync(p, { bigint: true });
  if (sa.ino === sb.ino && sa.dev === sb.dev) { same++; if (sa.ctimeNs === sb.ctimeNs) sameCtime++; }
  b.close(); try { fs.unlinkSync(p); } catch {}
}
console.log(`same inode number reused: ${same}/${N};  of those, identical ctimeNs: ${sameCtime}`);
