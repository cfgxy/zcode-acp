# Real-server audit: does the broker allowlist cover the real ZServerBackend call chain?

Snapshot: /tmp/zacp-snap-4cfa1d3 (HEAD 4cfa1d3, dist/ built 2026-09-29 19:39, dist allowlist == src allowlist).
Real server: ~/.zcode/server/zcode-server.cjs (11,541,169 B, mtime 09-26) + ~/.zcode/server/node (v22.16.0).
Harness/scratch: /tmp/audit-real-o5UzxX (deleted at the end). Report is appended experiment by experiment.
Key line refs: src/backend/zserver/{backend,broker,connection,channel-client}.ts; "bundle:N" = line N of zcode-server.cjs.

## 覆盖矩阵

Scope: everything ZServerBackend can put on the wire in ATTACH mode. Exhaustiveness check: the only
emission primitives are ChannelClient.sendRequest (call=100, listen=102) and sendRaw (103 unsubscribe,
101 cancel), see channel-client.ts:125/167/182/191; every consumer in src/ was grepped (only backend.ts
and broker.ts use channelOf/listen/call). "Observed" = seen by a passive tap on ChannelClient.sendRaw
during experiment B/B2/B3 and validated with the real validateClientHeader().

### Calls (type 100)

| # | (channel, method) | emitted at | arg shape (observed) | in BROKER_ALLOWED_CALLS | exists on real server | observed via broker |
|---|---|---|---|---|---|---|
| 1 | zcode-agent.createSession | backend.ts:303 (session/create) | {mode,persistence,workspacePath} | YES | bundle:217421 | yes (B) |
| 2 | zcode-task.createTask | backend.ts:310 | {clientId,draftSessionId,workspacePath} | YES | bundle:222465 | yes (B) |
| 3 | zcode-agent.subscribeConversationV4 | backend.ts:496 (fire-and-forget) | {clientMode,sessionId,workspacePath} | YES | bundle:218903 (+scope wrapper 206021 region) | yes (B) |
| 4 | zcode-agent.readSession | backend.ts:340 read, :360 load/resume, :373 messages | {sessionId,workspacePath} | YES | bundle:217656 | yes (B, x3) |
| 5 | zcode-agent.sendPrompt | backend.ts:321 (session/send) | {clientId,clientMode,content,sessionId,workspacePath} | YES | bundle:218324 | fixture only (B2). NOT sent to real server (no-LLM rule) |
| 6 | zcode-task.stopGeneration | backend.ts:344 | {taskId,workspacePath} | YES | bundle:222714 | yes (B) |
| 7 | zcode-task.listTasks | backend.ts:380 (session/list) | {} | YES | bundle:222945 | yes (B, x2) |
| 8 | zcode-agent.respondSessionRuntimePreferences | backend.ts:204 | - | not needed: emitted ONLY when `!attached` (backend.ts:198). In attach mode the BROKER sends it on its own ChannelClient (broker.ts:253), which bypasses routeClientFrame/validateClientHeader | bundle:218565 | not from client (B: broker-own frame seen, id 1) |

### Events (type 102) - listen channel resolution: `connection.listen()` => DEFAULT_CHANNEL "zcode-agent" (connection.ts:12,305); `channelOf("zcode-task").listen()` => "zcode-task"

| # | (channel, event) | emitted at | arg shape | in BROKER_ALLOWED_EVENTS | exists on real server | observed |
|---|---|---|---|---|---|---|
| 9 | zcode-task.onDynamicTaskTerminalOutcome | backend.ts:448 via channelOf("zcode-task") | string (sessionId) | YES | bundle:223586 | yes (B) |
| 10 | zcode-agent.onDynamicSessionEvent | backend.ts:460 via connection.listen | {deliveryKind,sessionId,workspacePath} | YES | bundle:218738 | yes, channel = zcode-agent (B) |
| 11 | zcode-agent.onDynamicConversationFrame | backend.ts:476 via connection.listen | {sessionId,workspacePath} | YES | bundle:219355 (+scope 206034) | yes (B) |
| 12 | zcode-agent.onDynamicSessionRuntimePreferencesRequest | backend.ts:199, only `!attached` | undefined | YES (but only the broker's own connection uses it; see note) | bundle:218622 | broker-own frame [102,0,...] (B) |

### Control frames

| type | emitted at | validator | observed |
|---|---|---|---|
| 103 EventDispose ([103,id]) | channel-client.ts:182, triggered by the unsubscribers in backend.ts:510 (subscribe rollback) | accepted: length==2 | yes (B3: 6 frames, all ok=true, ids translated by broker to server ids) |
| 101 PromiseCancel | channel-client.ts:191 `cancel()` | accepted | NEVER emitted: no caller of ChannelClient.cancel exists in src |
| broker-synthesized 103 on client socket close | broker.ts:315-318 | n/a (rawSend, unvalidated) | yes (B: 3x after driver exit) |

### Allowlist entries with NO emitter in ZServerBackend (dead entries)

| entry | in allowlist | any emitter in src/dist? | real server has it | note |
|---|---|---|---|---|
| zcode-agent.unsubscribeConversationV4 | broker.ts:71 | none (grep src, dist, scripts: only the allowlist line) | yes: bundle:218985 base, bundle:206021 connection-scope wrapper | ZServerBackend never unsubscribes a V4 subscription; see Findings |
| zcode-task.closeTask | broker.ts:73 | none in ZServerBackend/bridge. Only scripts/zserver-turn-probe.mjs:232,242 (direct spawn, not via broker) | yes: bundle:222892 | ZServerBackend never closes server-side tasks/sessions; see Findings |

### Real-bundle presence of every name (grep -o counts, then read in context)
All 10 call names + 4 events exist. Owners (found by reading the code, not by header heuristics):
- zcode-agent channel = `createZCodeAgentService` (bundle:215493) wrapped by `createZCodeAgentConnectionScope(role:"trusted-host-relay")` for the stdio server (bundle:271662-271670): createSession, readSession, sendPrompt, subscribeConversationV4, unsubscribeConversationV4, respondSessionRuntimePreferences, onDynamicSessionEvent, onDynamicConversationFrame, onDynamicSessionRuntimePreferencesRequest.
- zcode-task channel = `createZCodeTaskServiceAdapter` (bundle:221201): createTask, listTasks, stopGeneration, closeTask, onDynamicTaskTerminalOutcome (and onDynamicTaskReady, not used by ZServerBackend).
- Static coverage verdict: every (channel,name) that ZServerBackend can emit in attach mode is inside the allowlist. 0 gaps found statically. 2 dead entries (unsubscribeConversationV4, closeTask).

## 实验记录

### B - fixture broker, ZServerBackend attach mode, full lifecycle (PASS, 0 rejections)
- Setup: broker (dist/backend/zserver/broker.js, same class the CLI `zserver-broker` subcommand builds) on a private socket in /tmp/audit-real-o5UzxX, serverRoot = instrumented copy of tests/fixtures/zserver-fake-server.mjs (diff vs original = frame log + one scripted prefs event; a pristine byte-identical copy was also staged). ZCODE_ACP_DEBUG=1 on broker and client. Client = ZServerBackend with ZCODE_ACP_ZSERVER_SOCKET set; connection verified `attached=true` (child==null) so it did not silently fall back to a direct spawn.
- Flow (through backend.request, the same surface handlers use): session/create -> subscribe -> read -> messages -> list -> list(cwd) -> stop -> resume -> closeTask(cleanup) -> close.
- Client result: all 8 requests ok, isDead=false throughout. Passive tap: validatorRejected=0.
- Broker stderr: only "listening / client attached / spawning shared zcode-server / detached". `grep -c "rejected client frame"` = 0.
- Server side (shared fixture frame log): every client frame arrived with a broker-allocated id >= 1000000; broker's own frames used low ids (0,1). Scripted prefs request (id 0 fire) was answered by the BROKER (`respondSessionRuntimePreferences` with the exact preferences body, id 1) - no client involvement.
- Conclusion: allowlist covers the fixture-visible call chain; prefs answer path in attach mode is broker-only, as designed.

### B2 - same + session/send (fixture only) (PASS)
- Added `session/send` => zcode-agent.sendPrompt {clientId,clientMode,content,sessionId,workspacePath}: ok=true, broker rejected 0, result {accepted:true}. Driver refuses send flows unless `--fixture 1` (guard so it can never reach the real server).

### B3 - subscribe failure rollback => client-originated 103 through broker (PASS)
- Fixture scripted `subscribeConversationV4` to fail (ZSERVER_FAKE_FAIL_METHODS). backend.ts:501-514 rolls back: 3 unsubscribers each => [103,id]. Observed 6x type 103 from the client (two attempts), validator ok, broker translated client ids to server ids (fixture saw 103 1000002/3/4 and 1000007/8/9). Broker stderr: 0 rejections. Client warn: "conversation subscribe failed: scripted failure: subscribeConversationV4" (correct, visible).

### C - REAL zcode-server behind the broker, ZServerBackend attach mode, NO LLM turn (PASS for the allowlist; 1 unrelated anomaly, see C2)
- Setup: broker started exactly like `zcode-acp zserver-broker` but from a runner script (`new ZServerBroker(sock, undefined)` => default serverRoot ~/.zcode/server, real bundle + real node v22.16.0). ZCODE_ACP_DEBUG=1. Desktop profile valid, authority mode `desktop-attached-remote` (so the server DOES forward prefs requests to the client side). Workspace = empty dir /tmp/audit-real-o5UzxX/ws/C. Only ONE real server existed at a time (the user's own desktop server pid 2246838 untouched). Driver refuses `session/send` unless `--fixture 1`, so sendPrompt was never sent to the real server.
- Flow: attach pre-warm -> ZServerBackend attach (verified `attached=true`, child==null, so no silent direct-spawn fallback) -> session/create -> subscribe -> read -> messages -> list -> list(cwd) -> stop -> resume -> closeTask (issued from a SECOND attached client) -> close.
- Results (client): all 8 requests ok, isDead=false throughout. create 4786 ms, read 237 ms, stop 12 ms, resume 111 ms. Real readSession snapshot keys: messages,projection,protocol,runtime,session,settings,slashCommands,todoGroups,todos.
- Broker stderr: listening / 3x attached-detached / spawning shared server. `rejected client frame` count = 0. Passive client tap: validatorRejected=0. Real server returned ZERO error responses (no 202/203) for any client or broker frame (tap of every srv-in frame).
- Prefs path (the key risk): the real server fired `onDynamicSessionRuntimePreferencesRequest` DURING createSession (scope=`runtime-materialization`, event id 0 = the broker's own listen). The BROKER answered it (own frame [100,1,zcode-agent,respondSessionRuntimePreferences]; server resolved it 201), and only then did createSession resolve. So session/create does NOT hang on prefs in attach mode; the client-side responder is correctly skipped (backend.ts:198). No double answer.
- Frame ids: all client frames reached the real server with broker ids >= 1000000; broker-own frames used ids 0,1 (no collision).
- Real-server process facts (ps): shared server RSS ~329 MB at peak (pid 751754); its agent `zcode-cli` (pid 752174) is in its OWN process group (server group had 1 member), with ~10 MCP children (ssh-mcp-server, uvx mcp-server-fetch, uvx mcp-proxy-for-aws, zcode-node-repl...). Watchdog (`node -e`) was a child of the broker with ownerPid = broker pid.
- Orderly stop: SIGTERM to broker => broker exited; all 152 recorded descendant pids (broker, server, agent, MCP children, watchdog) were gone right after. ~/.config/zcode-acp/desktop-profile.json{,.bak} mtime/size identical before/after (no profile refresh write).
- Cross-client observation: `closeTask{taskId}` issued from a SECOND attached client (clientId audit-other-client) closed the first client's session: result ok. The allowlist does not bind a task to its creating client.
- State residue caused by this run in the user's real ~/.zcode store: 1 session + 1 task row created (persistence:"immediate"), then flagged deleted through the product's own closeTask. Nothing was written into the workspace dir (empty). I did not hand-edit any DB. `find -newer` on ~/.zcode is dominated by unrelated live processes (desktop server, other agents, the production bridge's acp-lazy-sessions.json) so it cannot isolate my writes.
- Anomaly: `session/list` returned n=0 sessions in BOTH calls, even right after creating a session (own=0). Not an allowlist problem (listTasks was forwarded and answered 201). Investigated in C2.

### C2 - why did session/list return 0 sessions on the real server? (read-only probe through the broker; shape only, no titles/paths/ids recorded)
- Raw `zcode-task.listTasks({})` through the broker returned a BARE ARRAY: len=1575, each element keys = createdAt,mode,model,provider,status,target,taskId,title,titleOverridden,traceId,updatedAt,workspacePath; 1421 distinct workspaces. No `tasks` property.
- ZServerBackend `session/list` (backend.ts:380-389) reads `metas?.tasks ?? []` => always `[]` against the real server: observed n=0 twice (C) and twice more (C2), while an array-aware mapping would yield 1575. `listTasks({workspacePath: <empty tmp ws>})` returned len=0 (server filters by workspace when given).
- The fixture replies `echo:listTasks:[]` (a string), so `metas?.tasks` is also undefined there and the unit tests (zserver-backend.test.ts:209 "resolves with sessions []") pass for the wrong reason. Bundle: `listTasks` = `tasks.map(rememberIndexedTaskMeta)` (bundle:222945-222950) returns the array directly.
- Broker involvement: none by construction (broker only rewrites the header; body bytes untouched, replaceHeader), but attribution to the broker is only PROVEN by the direct-connect run below (C2d).

### C2d - same read-only probe WITHOUT the broker (ZServerBackend spawns its own real server; no ZCODE_ACP_ZSERVER_SOCKET) - attribution control
- `attached=false`, child pid recorded; raw `listTasks({})` => identical bare array len=1575, 1421 workspaces, same element keys; `listTasks({workspacePath: emptyTmp})` => len=0. Backend mapping `session/list` => n=0 (twice); "array-aware mapping would yield n=1575". Zero validator rejections (irrelevant here) and zero server errors.
- Conclusion: the `session/list` => [] defect is NOT caused by the broker/allowlist. It is in ZServerBackend (backend.ts:380-389 expects `{tasks:[...]}`, the real server returns a bare array). It reproduces identically direct and via broker. Impact through the bridge: `listSessions`/`adoptStoredTitle`/hub discovery see zero sessions in zserver mode.
- Side observation (direct mode only): the client registered its own `onDynamicSessionRuntimePreferencesRequest` listener (frame seen in the client tap), which is exactly the frame that is absent from the client in attach mode (C) - confirms backend.ts:198 `if (!attached)`.
- Cleanup check: the direct child exited after `backend.close()`; no group members and no watchdog `node -e` left for it (ps).

### E1 - forced allowlist rejection: broker = /tmp dist COPY with `listTasks` deleted from zcode-task (snapshot untouched, diff = that one line); client = UNMODIFIED snapshot dist; fixture server
Flow: create -> list -> (2.6 s idle) -> read -> restart() -> list.
| moment | CLIENT view (ZServerBackend) | BROKER stderr |
|---|---|---|
| session/create | ok (createSession, createTask, 3 listens, subscribeConversationV4 all allowed) | client attached |
| session/list #1 (=> listTasks) | `error.message` = "zcode backend reader exited (backend dead): zcode server exited: socket closed"; `isDead=true`; `deathReason` = "zcode backend reader exited (backend dead): zcode server exited (socket closed)". Client stderr: the same backend-dead warn; no word about rejection or allowlist | `rejected client frame (call zcode-task.listTasks is not allowed through the broker) — disconnecting` (warn(), so NOT debug-gated) |
| collateral | the fire-and-forget subscribeConversationV4 was still in flight and was killed with the socket: warn "conversation subscribe failed: zcode server exited: socket closed", rollback emitted 3x [103,id] | - |
| session/read afterwards | "zcode backend reader exited (backend dead): zcode server channel client disposed" | - |
| restart() | `isDead=false`, `attachedAfterRestart=true` (child==null): it RE-ATTACHED to the live broker. It did NOT fall back to a direct spawn | client 3 attached |
| session/list #2 | identical death message again (rejected again) | 2nd `rejected client frame ... listTasks` |
- The brief's premise ("broker cuts the socket, client silently falls back to a direct connection") does not match the code or the run: fallback to direct spawn only happens when `ZServerConnection.attach` itself FAILS (backend.ts:141-154). A mid-session rejection is a "backend dead" that heal re-attaches to the same broker (ADR-0008:97-98 "restart/heal retries the broker first") => the rejected call is rejected again on every attempt: a permanent failure loop, not a silent fallback.
- Rejection reason exists ONLY in the broker's stderr. The client-visible strings carry the canonical "backend reader exited" marker, so supervise.ts isBackendDeadMessage() classifies it as infrastructure death and the bridge runs its heal loop / death poller.

### E3 - control: UNMODIFIED broker, fixture server exits by itself 1 s after start (genuine server death)
- CLIENT: after 1.5 s `isDead=true`, `deathReason` = "zcode backend reader exited (backend dead): zcode server exited (socket closed)" - byte-identical to the deathReason in E1 (rejection). Next request error: "zcode backend reader exited (backend dead): zcode server channel client disposed" (E1 read-after-death gave the same string).  restart() re-attached (attachedAfterRestart=true) and the broker respawned the shared server for the new client.
- BROKER stderr: "zserver-broker: shared server exited (code=null signal=null) — detaching 1 client(s)" then a new "spawning shared zcode-server". No "rejected client frame".
- Verdict for the brief's question: a CLIENT cannot tell "rejected by the allowlist" from "server died": deathReason is identical (`zcode server exited (socket closed)`), the ONLY discriminator is the broker's own stderr (rejection = "rejected client frame (...) — disconnecting", death = "shared server exited ... detaching N client(s)"). The broker never tells the client why (no error frame is written before `socket.destroy()`, broker.ts:373-377).
- One behavioural difference: a death heals (the respawned server serves the retry), a rejection does not (same frame is rejected forever).

### E2 - blast radius at BRIDGE level: real `dist/cli.js acp` process in zserver mode (ZCODE_ACP_BACKEND=zserver, ZCODE_ACP_ZSERVER_SOCKET=<fixture broker>), ACP `initialize` + `session/list` only (no session/new, no prompt, no LLM; fallback server root pinned to the FIXTURE so a silent fallback could never start the real server)
| | E2a: broker = dist-copy WITHOUT listTasks | E2b (control): unmodified broker |
|---|---|---|
| ACP `initialize` | ok | ok |
| ACP `session/list` response | ERROR `Internal error`, data.details = "zcode list failed: zcode backend reader exited (backend dead): zcode server exited: socket closed" | ok, 0 sessions |
| bridge process | logs `shutting down (backend dead)` ~0.9 s after the failed list and EXITS with code 0 (index.ts:120-123 death poller: `backend.isDead && !backendHealing`; listSessions has no heal wrapper) | stays alive until stdin closed |
| broker stderr | `rejected client frame (call zcode-task.listTasks is not allowed through the broker) — disconnecting` | none |
- So one allowlist miss on a harmless read-only call does not degrade a feature: it kills the entire bridge (all sessions of that editor connection) with EXIT CODE 0, and every client-visible string says "backend dead"/"socket closed". Nothing on the client side mentions the allowlist.
- Paths that DO go through the heal loop (session/create via createBackendSessionWithHeal, send via healBackendAndReload; HEAL_ATTEMPTS=3, backoff 0/1/4 s) would re-attach each time (E1: restart re-attaches to the same broker) and be rejected again => `zcode_backend_dead_after_retry` after ~5 s. INFERRED from E1 + session.ts:1356-1410; NOT run end-to-end (needs a prompt turn; fixture-only would have been possible but the bridge issues many other RPCs that the fixture does not implement, so attribution would be unreliable).
