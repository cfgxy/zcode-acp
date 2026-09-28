// Fake zcode-server.cjs (stdio mode) for connection tests.
//
// Deliberately re-implements the wire format independently from
// src/backend/zserver/protocol.ts (hand-rolled VQL/tag/frame encoders) so the
// two implementations cross-check each other. Speaks: banner noise →
// zcode-hello → (ack) → Initialize frame → echo Promise responses.
//
// NOTE: executed as `<tmpdir>/zcode-server.cjs`, i.e. CommonJS — no ESM syntax.
// `process` is a global.

if (process.env.ZSERVER_FAKE_DIE_AFTER_MS) {
  setTimeout(() => process.exit(9), Number(process.env.ZSERVER_FAKE_DIE_AFTER_MS));
}

process.stdout.write("Connecting to ssh.example.test...\n");
process.stdout.write("Welcome to the banner.\n");
process.stdout.write(
  `${JSON.stringify({ type: "zcode-hello", version: "9.9.9-fake", platform: process.platform, arch: process.arch, pid: process.pid })}\n`,
);

let acc = Buffer.alloc(0);
let acked = false;

const vql = (v) => {
  const out = [];
  if (v === 0) {
    out.push(0);
  } else {
    for (let x = v; x !== 0; x = x >>> 7) out.push(x & 0b0111_1111);
    for (let i = 0; i < out.length - 1; i++) out[i] |= 0b1000_0000;
  }
  return out;
};
const ser = (v, parts) => {
  if (v === undefined) parts.push(Buffer.from([0]));
  else if (typeof v === "string") {
    const b = Buffer.from(v);
    parts.push(Buffer.from([1, ...vql(b.length)]), b);
  } else if (Array.isArray(v)) {
    parts.push(Buffer.from([4, ...vql(v.length)]));
    for (const e of v) ser(e, parts);
  } else if (typeof v === "number" && (v | 0) === v) {
    parts.push(Buffer.from([6, ...vql(v)]));
  } else {
    const b = Buffer.from(JSON.stringify(v));
    parts.push(Buffer.from([5, ...vql(b.length)]), b);
  }
};
const msg = (h, b) => {
  const p = [];
  ser(h, p);
  ser(b, p);
  return Buffer.concat(p);
};
const encFrame = (payload) => {
  const h = Buffer.alloc(13);
  h.writeUInt8(1, 0);
  h.writeUInt32BE(0, 1);
  h.writeUInt32BE(0, 5);
  h.writeUInt32BE(payload.length, 9);
  return Buffer.concat([h, payload]);
};
const decMsg = (payload) => {
  let pos = 0;
  const ri = () => {
    let v = 0;
    for (let n = 0; ; n += 7) {
      const b = payload[pos++];
      v |= (b & 0b0111_1111) << n;
      if (!(b & 0b1000_0000)) return v;
    }
  };
  const dv = () => {
    const t = payload[pos++];
    if (t === 0) return undefined;
    if (t === 1) {
      const l = ri();
      return payload.subarray(pos, (pos += l)).toString();
    }
    if (t === 6) return ri();
    if (t === 4) {
      const l = ri();
      const a = [];
      for (let i = 0; i < l; i++) a.push(dv());
      return a;
    }
    if (t === 5) {
      const l = ri();
      return JSON.parse(payload.subarray(pos, (pos += l)).toString());
    }
    throw new Error(`fake server: unexpected tag ${t}`);
  };
  const header = dv();
  const body = dv();
  return { header, body };
};

const listeners = new Map();
const handleFrame = (payload) => {
  const { header, body } = decMsg(payload);
  const [type, id, , name] = header;
  if (type === 100) {
    process.stdout.write(encFrame(msg([201, id], `echo:${name}:${JSON.stringify(body)}`)));
  } else if (type === 102) {
    // Subscribe: fire N events with the SAME listen id (EventFire semantics),
    // then keep a ticker so unsubscribe (103) is observable.
    let n = 0;
    listeners.set(
      id,
      setInterval(() => {
        n += 1;
        process.stdout.write(encFrame(msg([204, id], `evt-${n}`)));
      }, 20),
    );
  } else if (type === 103) {
    const t = listeners.get(id);
    if (t) {
      clearInterval(t);
      listeners.delete(id);
    }
  }
};

const drain = () => {
  for (;;) {
    if (acc.length < 13) return;
    const len = acc.readUInt32BE(9);
    if (acc.length < 13 + len) return;
    const payload = acc.subarray(13, 13 + len);
    acc = acc.subarray(13 + len);
    handleFrame(payload);
  }
};

process.stdin.on("data", (d) => {
  acc = Buffer.concat([acc, d]);
  if (!acked) {
    const i = acc.indexOf(10);
    if (i === -1) return;
    const line = acc.subarray(0, i).toString();
    acc = acc.subarray(i + 1);
    acked = true;
    const ack = JSON.parse(line);
    if (ack.type !== "zcode-hello-ack" || !ack.clientId) process.exit(2);
    process.stdout.write(encFrame(msg([200], undefined)));
    if (acc.length > 0) drain();
    return;
  }
  drain();
});
