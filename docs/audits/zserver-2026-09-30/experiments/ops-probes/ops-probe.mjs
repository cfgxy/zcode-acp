// zserver-broker health probe: connect to the broker socket, exit 0 iff an Initialize frame arrives.
// Exit codes: 0 ok | 10 no socket (ENOENT) | 11 stale socket (ECONNREFUSED) | 12 closed before Initialize | 13 timeout | 14 other
import { connect } from "node:net";
const sock = process.argv[2] ?? process.env.ZCODE_ACP_ZSERVER_SOCKET;
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 3000);
const INIT = Buffer.from([4, 1, 6, 0xc8, 1, 0]); // serialize([200]) + serialize(undefined), 6 bytes
const fail = (code, msg) => { console.error(`probe: ${msg}`); process.exit(code); };
if (!sock) fail(14, "no socket path (arg or ZCODE_ACP_ZSERVER_SOCKET)");
const s = connect(sock);
let buf = Buffer.alloc(0);
const t = setTimeout(() => fail(13, `no Initialize within ${timeoutMs}ms (broker up, shared server not ready)`), timeoutMs);
s.on("error", (e) => fail({ ENOENT: 10, ECONNREFUSED: 11 }[e.code] ?? 14, `${e.code}: ${e.message}`));
s.on("close", () => fail(12, "connection closed before Initialize (shared server spawn failed, or rejected)"));
s.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  if (buf.length < 13 + INIT.length) return;
  if (buf[0] === 1 && buf.readUInt32BE(9) === INIT.length && buf.subarray(13, 13 + INIT.length).equals(INIT)) { clearTimeout(t); s.destroy(); process.exit(0); }
  fail(14, "first frame is not Initialize");
});
