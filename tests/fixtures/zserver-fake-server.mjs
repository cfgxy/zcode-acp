// Fake zcode-server.cjs (stdio mode) for connection tests.
//
// Hand-written re-implementation of the wire format (VQL/tag/frame encoders),
// kept separate from src/backend/zserver/protocol.ts so the two cross-check
// each other on framing and dispatch. NOT an independent oracle for the codec
// arithmetic: the VQL loop is the same algorithm as protocol.ts's, so a shared
// mistake there (negative numbers, >2^31, Buffer/VSBuffer bodies, nested
// Uint8Array, floats) would pass on both sides. Byte-level fidelity against
// the real bundle is verified separately (see ADR-0008, "线协议事实").
// Speaks: banner noise → zcode-hello → (ack) → Initialize frame → echo
// Promise responses.
//
// Test-only knobs (read here, not runtime configuration): ZSERVER_FAKE_*
// (SLOW_EXIT_MS, IGNORE_SIGTERM, PID_FILE, GRANDCHILD_IGNORES_SIGTERM,
// DIE_AFTER_MS, SPAWN_LOG, FAIL_METHODS, HANG_METHODS, DELAY_METHODS, TERMINAL,
// FRAMES, BIG_FRAMES, TASKS, PREFS) and ZSERVER_COALESCE.
//
// NOTE: executed as `<tmpdir>/zcode-server.cjs`, i.e. CommonJS — no ESM syntax.
// `process` is a global.

// Slow, orderly shutdown: trap SIGTERM and exit only after N ms — opens the
// window where a NEW spawn clears the backend's `closing` flag before the OLD
// child's exit event lands (the poisoned-flag race).
if (process.env.ZSERVER_FAKE_SLOW_EXIT_MS) {
  process.on("SIGTERM", () => {
    setTimeout(() => process.exit(0), Number(process.env.ZSERVER_FAKE_SLOW_EXIT_MS));
  });
}
// Swallow SIGTERM entirely (a wedged/trapping server): only SIGKILL escalation
// can end it.
if (process.env.ZSERVER_FAKE_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}
// Record own pid + spawn a same-group grandchild: lets tests assert that a
// group kill reaps the WHOLE tree while a leader-only kill leaves the grandchild.
if (process.env.ZSERVER_FAKE_PID_FILE) {
  const ignoresTerm = process.env.ZSERVER_FAKE_GRANDCHILD_IGNORES_SIGTERM === "1";
  const pidFile = process.env.ZSERVER_FAKE_PID_FILE;
  // The grandchild announces itself ONLY after its SIGTERM handler is armed
  // (it writes a ready marker); the leader publishes the pid file only once
  // that marker exists — otherwise a test can SIGTERM the grandchild during
  // node bootstrap, before the handler exists, and see it die spuriously.
  const readyMarker = pidFile + ".grandchild-ready";
  const grandchild = require("node:child_process").spawn(
    process.execPath,
    [
      "-e",
      (ignoresTerm ? "process.on('SIGTERM',()=>{});" : "") +
        `require('node:fs').writeFileSync(${JSON.stringify(readyMarker)},'1');` +
        "setInterval(()=>{},1000)",
    ],
    { stdio: "ignore" },
  );
  const publish = () => {
    if (!require("node:fs").existsSync(readyMarker)) return setTimeout(publish, 20);
    require("node:fs").writeFileSync(
      pidFile,
      JSON.stringify({ leader: process.pid, grandchild: grandchild.pid }),
    );
  };
  publish();
}

if (process.env.ZSERVER_FAKE_DIE_AFTER_MS) {
  setTimeout(() => process.exit(9), Number(process.env.ZSERVER_FAKE_DIE_AFTER_MS));
}

if (process.env.ZSERVER_FAKE_SPAWN_LOG) {
  require("node:fs").appendFileSync(process.env.ZSERVER_FAKE_SPAWN_LOG, `${process.pid}\n`);
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
let subscriptionCounter = 0;
const ownedSubscriptions = new Set();
const handleFrame = (payload) => {
  const { header, body } = decMsg(payload);
  const [type, id, , name] = header;
  if (type === 100) {
    // Scripted server-side failure for a method (202 PromiseError response).
    if ((process.env.ZSERVER_FAKE_FAIL_METHODS || "").split(",").includes(name)) {
      process.stdout.write(
        encFrame(msg([202, id], { message: `scripted failure: ${name}`, name: "Error" })),
      );
      return;
    }
    const hangMethods = (process.env.ZSERVER_FAKE_HANG_METHODS || "").split(",").filter(Boolean);
    if (hangMethods.includes(name)) return; // wedged-but-alive server simulation
    if (name === "createSession") {
      process.stdout.write(
        encFrame(
          msg([201, id], { session: { sessionId: "sess_fake_1" }, projection: {}, messages: [] }),
        ),
      );
      return;
    }
    if (name === "createTask") {
      process.stdout.write(encFrame(msg([201, id], { taskId: "sess_fake_1" })));
      return;
    }
    // Real-server shape: subscribeConversationV4 answers {ack:{subscriptionId,…}}
    // and the server OWNS that subscription until unsubscribeConversationV4 names
    // its id (a 103 EventDispose does not release it — verified on the real
    // server). ZSERVER_FAKE_DELAY_METHODS="subscribeConversationV4:400" delays the
    // answer so a release can race an in-flight subscribe.
    if (name === "subscribeConversationV4") {
      const subscriptionId = `sub-${++subscriptionCounter}`;
      ownedSubscriptions.add(subscriptionId);
      const delayMs = Number(
        (process.env.ZSERVER_FAKE_DELAY_METHODS || "")
          .split(",")
          .map((entry) => entry.split(":"))
          .find(([method]) => method === name)?.[1] ?? 0,
      );
      const answer = () =>
        process.stdout.write(
          encFrame(
            msg([201, id], {
              ack: { subscriptionId, mode: "snapshot", logEpoch: "e1", openTiming: {} },
            }),
          ),
        );
      if (delayMs > 0) setTimeout(answer, delayMs);
      else answer();
      return;
    }
    if (name === "unsubscribeConversationV4") {
      const subscriptionId = Array.isArray(body) ? body[0]?.subscriptionId : undefined;
      if (ownedSubscriptions.delete(subscriptionId)) {
        console.error(`ZSERVER_V4UNSUB:${subscriptionId}`);
      }
      // Like the real server: an unknown id is a silent no-op.
      process.stdout.write(encFrame(msg([201, id], undefined)));
      return;
    }
    // A prefs answer is observable: the broker must be the only responder.
    if (name === "respondSessionRuntimePreferences") {
      console.error("ZSERVER_PREFS_ANSWER");
    }
    // Scripted listTasks payload (ZSERVER_FAKE_TASKS = JSON). Unset keeps the
    // legacy echo string the connection/broker tests key on. The real server
    // answers with a BARE ARRAY of task metas.
    if (name === "listTasks" && process.env.ZSERVER_FAKE_TASKS) {
      process.stdout.write(encFrame(msg([201, id], JSON.parse(process.env.ZSERVER_FAKE_TASKS))));
      return;
    }
    process.stdout.write(encFrame(msg([201, id], `echo:${name}:${JSON.stringify(body)}`)));
  } else if (
    type === 102 &&
    name === "onDynamicSessionRuntimePreferencesRequest" &&
    process.env.ZSERVER_FAKE_PREFS === "1"
  ) {
    // Scripted runtime-preferences request (the broker answers it on its own
    // connection, with ids from the LOW range).
    setTimeout(() => {
      process.stdout.write(
        encFrame(msg([204, id], { requestId: "req-1", scope: "runtime-materialization" })),
      );
    }, 100);
  } else if (
    type === 102 &&
    name === "onDynamicTaskTerminalOutcome" &&
    process.env.ZSERVER_FAKE_TERMINAL
  ) {
    // Scripted terminal outcome (ZSERVER_FAKE_TERMINAL = JSON payload).
    setTimeout(() => {
      process.stdout.write(encFrame(msg([204, id], JSON.parse(process.env.ZSERVER_FAKE_TERMINAL))));
    }, 200);
  } else if (type === 102 && name === "onDynamicConversationFrame") {
    // Scripted conversation frames (ZSERVER_FAKE_FRAMES = JSON array of frames).
    // ZSERVER_FAKE_BIG_FRAMES="count:bytes" generates that many large frames
    // HERE — an env var carrying them would exceed the exec argument limit
    // (E2BIG) and the server would never start.
    const frames = JSON.parse(process.env.ZSERVER_FAKE_FRAMES || "[]");
    const [bigCount, bigBytes] = (process.env.ZSERVER_FAKE_BIG_FRAMES || "0:0")
      .split(":")
      .map(Number);
    for (let i = 0; i < bigCount; i++) {
      frames.push({
        deliveryKind: "online",
        frame: { topic: "conversation/x", payload: { text: "y".repeat(bigBytes) } },
      });
    }
    setTimeout(() => {
      for (const frame of frames) process.stdout.write(encFrame(msg([204, id], frame)));
    }, 150);
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
      console.error(`ZSERVER_UNSUB:${id}`);
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
    if (process.env.ZSERVER_COALESCE === "1") {
      // Initialize immediately followed by an unsolicited event frame in ONE
      // write: the client must hand the post-hello remainder to the decoder.
      process.stdout.write(
        Buffer.concat([encFrame(msg([200], undefined)), encFrame(msg([204, 424242], "coalesced"))]),
      );
    } else {
      process.stdout.write(encFrame(msg([200], undefined)));
    }
    if (acc.length > 0) drain();
    return;
  }
  drain();
});
