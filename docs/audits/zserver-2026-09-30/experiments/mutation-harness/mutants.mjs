// Mutation specs. Every `old` MUST match exactly `count` (default 1) times or
// the harness aborts that mutant as NOT-APPLIED (never silently "survives").
const B = "src/backend/zserver/broker.ts";
const C = "src/backend/zserver/connection.ts";
const K = "src/backend/zserver/backend.ts";
const CC = "src/backend/zserver/channel-client.ts";
const P = "src/backend/zserver/protocol.ts";

export const mutants = [
  {
    id: "M1",
    file: B,
    desc: "validateClientHeader allowlist check never rejects",
    edits: [{ old: "if (!table[channel]?.has(name)) {", neu: "if (false && !table[channel]?.has(name)) {" }],
  },
  {
    id: "M2",
    file: B,
    desc: "header.length > 4  ->  > 8",
    edits: [{ old: "header.length < 2 || header.length > 4", neu: "header.length < 2 || header.length > 8" }],
  },
  {
    id: "M3",
    file: B,
    desc: "drop Number.isInteger(id)",
    edits: [
      {
        old: 'typeof id !== "number" || !Number.isInteger(id) || id < 0',
        neu: 'typeof id !== "number" || id < 0',
      },
    ],
  },
  {
    id: "M4",
    file: B,
    desc: "BROKER_BIND_UMASK 0o177 -> 0o022",
    edits: [{ old: "export const BROKER_BIND_UMASK = 0o177;", neu: "export const BROKER_BIND_UMASK = 0o022;" }],
  },
  {
    id: "M5",
    file: B,
    desc: "maxClientBufferBytes cap check commented out",
    edits: [
      {
        old: `      if (decoder.byteLength > maxClientBufferBytes()) {
        warn(\`zserver-broker: client \${clientId} exceeded frame buffer limit — disconnecting\`);
        socket.destroy();
      }
`,
        neu: `      /* MUTANT M5: cap check removed */
`,
      },
    ],
  },
  {
    id: "M6",
    file: B,
    desc: "nextServerId start 1_000_000 -> 1",
    edits: [{ old: "private nextServerId = 1_000_000;", neu: "private nextServerId = 1;" }],
  },
  {
    id: "M7",
    file: B,
    desc: "terminal = type >= 200 (EventFire 204 also retires the id mapping)",
    edits: [
      {
        old: "const terminal = type === 201 || type === 202 || type === 203;",
        neu: "const terminal = type >= 200;",
      },
    ],
  },
  {
    id: "M8",
    file: B,
    desc: "no synthetic EventDispose on client close",
    edits: [
      {
        old: `      if (this.connection && entry.idByClient.size > 0) {
        for (const serverId of [...entry.idByClient.keys()]) {
          this.connection.rawSend(encodeMessage([103, serverId], undefined));
        }
      }
`,
        neu: `      /* MUTANT M8: synthetic EventDispose removed */
`,
      },
    ],
  },
  {
    id: "M9",
    file: C,
    desc: "watchdog tick re-arms setInterval(tick,2000) (self-replicating timer bug)",
    edits: [{ old: "const tick = () => {", neu: "const tick = () => { setInterval(tick, 2000);" }],
  },
  {
    id: "M10",
    file: C,
    desc: "shutdown(): group SIGTERM -> leader-only child.kill(SIGTERM)",
    edits: [{ old: 'process.kill(-child.pid!, "SIGTERM");', neu: 'child.kill("SIGTERM");' }],
  },
  {
    id: "M11",
    file: C,
    desc: "SIGKILL escalation timer removed",
    edits: [
      {
        old: `        const escalate = setTimeout(() => {
          try {
            process.kill(-child.pid!, 0);
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, killEscalationMs());
        escalate.unref();
`,
        neu: `        /* MUTANT M11: escalation removed */
`,
      },
    ],
  },
  {
    id: "M12",
    file: C,
    desc: 'onExit: child.once("error") removed (spawn error no longer routes to exit)',
    edits: [
      {
        old: 'child.once("error", (error) => once(`spawn error: ${error.message}`));',
        neu: "/* MUTANT M12 */",
      },
    ],
  },
  {
    id: "M13",
    file: K,
    desc: "exit handler ignores per-connection identity (closing only)",
    edits: [{ old: "if (this.connection !== connection || this.closing) {", neu: "if (this.closing) {" }],
  },
  {
    id: "M14",
    file: K,
    desc: "request(): this.inFlight++ removed",
    edits: [{ old: "this.inFlight++;", neu: "/* MUTANT M14 */" }],
  },
  {
    id: "M15",
    file: K,
    desc: "subscribe-failure rollback no longer unsubscribes listeners",
    edits: [
      {
        old: "for (const unsubscribe of unsubscribers) unsubscribe();",
        neu: "/* MUTANT M15 */",
      },
    ],
  },
  {
    id: "M16",
    file: K,
    desc: "shouldTranslateFrame always true (history frames translated)",
    edits: [
      {
        old: 'return (data as { deliveryKind?: string } | null)?.deliveryKind !== "initial";',
        neu: "return true;",
      },
    ],
  },
  {
    id: "M17",
    file: K,
    desc: "frameMatchesSession always true (foreign-session frames accepted)",
    edits: [{ old: "return topic === `conversation/${sessionId}`;", neu: "return true;" }],
  },
  {
    id: "M18",
    file: K,
    desc: "TurnCompletionGate.onTerminalOutcome: drop disposed early-exit",
    edits: [
      {
        old: "if (this.disposed) return; // a disposed gate must never re-arm and emit",
        neu: "/* MUTANT M18 */",
      },
    ],
  },
  {
    id: "M19",
    file: CC,
    desc: "ChannelClient.cancel(): drop the Cancelled rejection",
    edits: [
      {
        old: 'reject(Object.assign(new Error("Cancelled"), { name: "Cancelled" }));',
        neu: "/* MUTANT M19 */",
      },
    ],
  },
  {
    id: "M20",
    file: P,
    desc: "FrameDecoder: deliver ALL frame types (both Regular checks removed)",
    edits: [
      {
        old: "if (type === FrameType.Regular) this.onMessage(Buffer.alloc(0));",
        neu: "this.onMessage(Buffer.alloc(0));",
      },
      {
        old: `      if (type === FrameType.Regular) {
        this.onMessage(body);
      }`,
        neu: `      this.onMessage(body);`,
      },
    ],
  },
  {
    id: "M20a",
    file: P,
    desc: "FrameDecoder: non-empty non-Regular frames delivered (site 2 only)",
    edits: [
      {
        old: `      if (type === FrameType.Regular) {
        this.onMessage(body);
      }`,
        neu: `      this.onMessage(body);`,
      },
    ],
  },
  {
    id: "M20b",
    file: P,
    desc: "FrameDecoder: ZERO-length non-Regular frames delivered (site 1 only)",
    edits: [
      {
        old: "if (type === FrameType.Regular) this.onMessage(Buffer.alloc(0));",
        neu: "this.onMessage(Buffer.alloc(0));",
      },
    ],
  },
  // ---- harness sanity: must go red, proves each mutated file is the one executed ----
  {
    id: "S1",
    file: CC,
    desc: "SANITY: ChannelClient.dispose() does not reject pending (must be killed)",
    edits: [{ old: "reject(rejection);", neu: "/* MUTANT S1 */" }],
  },
];

// ---------------- EXTRA mutants (not requested; wiring gaps spotted while reading) ----------------
export const extras = [
  { id: "X1", file: C, desc: "onStdout: bytes after the hello line are no longer handed to the frame decoder",
    edits: [{ old: `          if (this.rawBuffer.length > 0) {
            this.frameDecoder.push(this.rawBuffer);
          }
`, neu: `          /* X1 */
` }] },
  { id: "X2", file: K, desc: "armIdleTimer ignores registered session listeners (recycles a server that has live sessions)",
    edits: [{ old: "if (this.listeners.size > 0 || this.inFlight > 0) {", neu: "if (this.inFlight > 0) {" }] },
  { id: "X3", file: K, desc: "subscribeConversation idempotency guard removed (resume stacks duplicate listeners)",
    edits: [{ old: "if (this.subscribedSessions.has(sessionId)) return;", neu: "/* X3 */" }] },
  { id: "X4", file: K, desc: "spawn(): subscribedSessions.clear() removed (session deaf after heal/restart)",
    edits: [{ old: "    this.subscribedSessions.clear();\n", neu: "    /* X4 */\n" }] },
  { id: "X5", file: K, desc: "spawn(): close-during-spawn guard removed (late connection assigned after close())",
    edits: [{ old: "if (this.closing || generation !== this.spawnGeneration) {", neu: "if (false) {" }] },
  { id: "X6", file: B, desc: "broker spawns the shared server with the RAW process.env (brokerBaseEnv bypassed)",
    edits: [{ old: "env: await runtimeEnvWithProfile(brokerBaseEnv(process.env)),", neu: "env: await runtimeEnvWithProfile(process.env)," }] },
  { id: "X7", file: B, desc: "allowlist widened with a NEW dangerous channel (file.writeFile) absent from the deny-list test",
    edits: [{ old: `"zcode-task": new Set(["createTask", "listTasks", "stopGeneration", "closeTask"]),`,
              neu: `"zcode-task": new Set(["createTask", "listTasks", "stopGeneration", "closeTask"]),
  file: new Set(["writeFile"]),` }] },
  { id: "X8", file: B, desc: "start(): live-broker probe result ignored (evicts a LIVE broker's socket)",
    edits: [{ old: "if (live) {", neu: "if (false && live) {" }] },
  { id: "X9", file: B, desc: "routeClientFrame: 'client vanished while awaiting server' guard removed",
    edits: [{ old: "if (entry.socket.destroyed || ![...this.clients.values()].includes(entry)) {", neu: "if (false) {" }] },
  { id: "X10", file: K, desc: "forgetSession no longer disposes the completion gate",
    edits: [{ old: `    this.gatesBySession.get(sessionId)?.dispose();
    this.gatesBySession.delete(sessionId);
    // Row keys are namespaced`, neu: `    this.gatesBySession.delete(sessionId);
    // Row keys are namespaced` }] },
  { id: "X11", file: K, desc: "TASK_SCOPED_ENV loses SSH_AGENT_PID/SSH_CONNECTION/SSH_CLIENT",
    edits: [{ old: "/^(MULTICA_|SSH_AUTH_SOCK$|SSH_AGENT_PID$|SSH_CONNECTION$|SSH_CLIENT$)/", neu: "/^(MULTICA_|SSH_AUTH_SOCK$)/" }] },
  { id: "X12", file: B, desc: "start(): stale socket file no longer unlinked",
    edits: [{ old: `      unlinkSync(this.socketPath);
    }
    this.server = createServer((socket) => this.onClient(socket));`, neu: `    }
    this.server = createServer((socket) => this.onClient(socket));` }] },
  { id: "X13", file: K, desc: "session/list mapping broken (sessionId taken from title)",
    edits: [{ old: "sessionId: t.taskId,", neu: "sessionId: t.title," }] },
  { id: "X14", file: K, desc: "session/send drops the prompt content",
    edits: [{ old: `          content,
          clientId: this.clientId,`, neu: `          content: "",
          clientId: this.clientId,` }] },
];
mutants.push(...extras);

// ---------------- EXTRA-2: allowlist narrowing / forward-after-reject / route body fidelity ----------------
mutants.push(
  { id: "X15", file: B, desc: "allowlist NARROWED: sendPrompt removed (broker-mode bridge can never send a prompt)",
    edits: [{ old: `    "sendPrompt",\n`, neu: `` }] },
  { id: "X16", file: B, desc: "event allowlist NARROWED: onDynamicTaskTerminalOutcome removed (turn never completes via broker)",
    edits: [{ old: `"zcode-task": new Set(["onDynamicTaskTerminalOutcome"]),`, neu: `"zcode-task": new Set([]),` }] },
  { id: "X17", file: K, desc: "session/stop: taskId/workspacePath swapped",
    edits: [{ old: `await tasks.call("stopGeneration", { taskId: sessionId, workspacePath: target });`,
              neu: `await tasks.call("stopGeneration", { taskId: target, workspacePath: sessionId });` }] },
  { id: "X19", file: K, desc: "session/create: createTask call removed",
    edits: [{ old: `        await tasks.call("createTask", {
          workspacePath,
          draftSessionId: sid,
          clientId: this.clientId,
        });
`, neu: `` }] },
  { id: "X21", file: K, desc: "request(): dead-backend prefix classification removed",
    edits: [{ old: `          message:
            this.isDead && !message.includes("backend reader exited")
              ? \`zcode backend reader exited (backend dead): \${message}\`
              : message,`, neu: `          message: message,` }] },
  { id: "X22", file: B, desc: "SECURITY: rejected client frame is still FORWARDED to the shared server (return removed after destroy)",
    edits: [{ old: `      warn(\`zserver-broker: rejected client frame (\${verdict.reason}) — disconnecting\`);
      entry.socket.destroy();
      return;
    }`, neu: `      warn(\`zserver-broker: rejected client frame (\${verdict.reason}) — disconnecting\`);
      entry.socket.destroy();
    }` }] },
);

// ---------------- EXTRA-3: untested features ----------------
mutants.push(
  { id: "X23", file: B, desc: "armIdleExit disabled (broker idle-exit never fires)",
    edits: [{ old: "if (!CLIENT_IDLE_EXIT_MS || this.clients.size > 0) return;", neu: "return;" }] },
  { id: "X24", file: B, desc: "stop(): shared server connection no longer disposed (server child outlives broker)",
    edits: [{ old: `    this.connection?.dispose();
    this.connection = null;
    await new Promise<void>((resolve) => {`, neu: `    this.connection = null;
    await new Promise<void>((resolve) => {` }] },
  { id: "X25", file: B, desc: "stop(): socket file no longer unlinked",
    edits: [{ old: `        try {
          unlinkSync(this.socketPath);
        } catch {
          /* already gone */
        }
        resolve();`, neu: `        resolve();` }] },
  { id: "X26", file: B, desc: "onClient: per-client 'error' listener removed (RST would crash the broker)",
    edits: [{ old: `    socket.on("error", (error) => {
      warn(\`zserver-broker: client \${clientId} socket error: \${error.message}\`);
      socket.destroy();
    });`, neu: `` }] },
  { id: "X27", file: C, desc: "attach(): persistent socket 'error' handler removed",
    edits: [{ old: `        socket.on("error", (error) => {
          warn(\`zserver: attach socket error (handled): \${error.message}\`);
          socket.destroy();
        });`, neu: `` }] },
  { id: "X28", file: C, desc: "spawn(): child stdin/stdout/stderr 'error' listeners removed (EPIPE crash path)",
    edits: [{ old: `  child.stdin.on("error", swallowError);
  child.stdout!.on("error", swallowError);
  child.stderr!.on("error", swallowError);`, neu: `` }] },
  { id: "X29", file: K, desc: "restart(): close() no longer awaited before respawn is attempted (ordering)",
    edits: [{ old: `  async restart(_reason: string): Promise<void> {
    await this.close();`, neu: `  async restart(_reason: string): Promise<void> {
    void this.close();` }] },
  { id: "X30", file: P, desc: "decodeValue array-length guard removed (2^31 element claim)",
    edits: [{ old: "if (length > buffer.byteLength - state.pos) {", neu: "if (false) {" }] },
);
