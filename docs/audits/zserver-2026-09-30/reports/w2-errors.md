# W2 audit: error handling / degradation paths / integration with existing contracts
Snapshot: /tmp/zacp-snap-592c65c (HEAD 592c65c, dist/ built). Reviewer perspective: error-handling + contract integration.
Method: read contract files line by line, then real experiments against dist/ with tests/fixtures/zserver-fake-server.mjs as serverRoot.
All experiments ran with a temp HOME (no real desktop profile, no real keys). No API key / token value was read or printed.

(sections are appended per focus as each completes; final Error-Text Ledger / Findings / Verified-OK are assembled at the end)


---
## Focus 1 — healsInPlace end-to-end (experiment: exp1-heals-in-place.mjs, dist/ + fake server, hermetic PID/HOME namespace)

Setup: `new ZcodeAcpServer()` with ZCODE_ACP_BACKEND=zserver, serverRoot=fake-server dir. Real sequence: session/create -> SIGKILL child + remove bundle -> `server.restartBackend()` -> `ensureBackend()` -> real `resumeSession()` (syncProviderRegistry -> resumePreservingModel -> healBackendAndReload x3).

Raw results (verbatim keys):
- A  ctor: `{"cls":"ZServerBackend","healsInPlace":true,"isDead":false}`
- C  after SIGKILL: `isDead:true`, deathReason=`zcode backend reader exited (backend dead): zcode server exited (code=null signal=SIGKILL)`, `connectionNull:false`
- C2 plain request after death, NO restart: error=`zcode backend reader exited (backend dead): zcode server channel client disposed`, **spawnAttempts:0**, isDead stays true, connection still the dead object
- D  restartBackend (bundle missing): `returnedSameInstance:true, ensureSameAfterRestart:true, isDead:true, connectionNull:true`, deathReason=`spawn failed: zcode server bundle not found: <root>/zcode-server.cjs`
- D2 counterfactual (healsInPlace forced false): `replaced:true, listenerOrphanedOnOld:true` -> proves what the fix prevents
- E  heal exhausted via real resumeSession (3 rounds, 7 spawn attempts total, backendHealing cleared): final error = `zcode_spawn_failed: spawn failed: zcode server bundle not found: <root>/zcode-server.cjs`; deathReason=`spawn failed: ...` (CONSISTENT with prefix); same instance
- F  positive control (bundle restored 5ms into heal): resume OK, `isDead:false, deathReason:null, sameInstance:true, backendHealing:false`

Conclusions:
- Fix (2) is real and effective end-to-end for the spawn-phase failure: same instance before/after restart, ERR_SPAWN_FAILED chosen, prefix agrees with deathReason.
- Premise correction (matters for Focus 2): **an unexpected child death does NOT self-respawn on the next request.** `ensureConnection()` returns `this.connection` when non-null, and the exit handler never nulls it (backend.ts:112, :191-207). Only `close()` (idle recycle / restart / shutdown) nulls it. The comment at backend.ts:63-67 ("restart() and ensureConnection() respawn the transport in place") is therefore only true after close(). Consequence: after a crash, isDead stays true until a request fails AND the heal path runs; with no traffic the index.ts poller ends the bridge in <=2s (same as the direct backend).

---
## Focus 3 — phase classification boundary (`child.pid === undefined`) (experiment: exp3-phase-matrix.mjs)

Each scenario = real spawn of a crafted `<root>/node`, run through 3 layers: ZServerConnection.spawn -> ZServerBackend.request -> real `resumeSession()` heal loop. "nodeProbe" is Node's own event log for the same spawn (independent oracle of the fix's premise).

| # | scenario | node's own events | conn phase / ms | backend deathReason prefix | heal final error (3 rounds) |
|---|----------|------------------|-----------------|----------------------------|-----------------------------|
| a | node script w/ bad shebang interp (execve ENOENT) | `error ENOENT`, pid undefined | `spawn` / 9ms | `spawn failed: zcode server exited: spawn error: spawn <root>/node ENOENT` | `zcode_spawn_failed: spawn failed: ...ENOENT` |
| b | file mode 0644 (EACCES) | `error EACCES` | `spawn` / 8ms | `spawn failed: ...EACCES` | `zcode_spawn_failed: ...EACCES` |
| c | directory named `node` | `error EACCES` (not EISDIR) | `spawn` / 3ms | `spawn failed: ...EACCES` | `zcode_spawn_failed: ...EACCES` |
| d1 | starts, prints to stderr, exit 3 before hello | `exit code=3` (pid defined) | `hello` / 6ms | `zcode backend reader exited (backend dead): zcode server exited: code=3 signal=null: boom: cannot open db` | `zcode_backend_dead_after_retry: backend did not recover after 3 supervised restarts (...)` |
| d2 | hello, then exit 5 (bridge's ack write hits EPIPE -> only `warn "child io error (handled): write EPIPE"`) | `exit code=5` | `hello` / 10ms | same shape, `code=5` | `zcode_backend_dead_after_retry` |
| e1 | hello, then child closes stdin but stays alive (ack write -> EPIPE, swallowed) | none (alive) | **`ready` / 15034ms** | `zcode backend reader exited (backend dead): zcode server ready timeout after 15000ms` | (not run: slow) |
| e2 | stdout closed, no hello, alive | none | **`hello` / 10036ms** | `...hello timeout after 10000ms` | (not run: slow) |

Answers to 3(a)-(e):
- (a)(b)(c): fix (1) verified end-to-end. ENOENT/EACCES(/dir) -> phase `spawn` -> `spawn failed:` -> ERR_SPAWN_FAILED; a crash after start stays retryable `hello` -> ERR_BACKEND_DEAD_AFTER_RETRY. Directory-as-node yields EACCES, not EISDIR.
- (e) EPIPE on a LIVE child: NO faster path. With hello already received the wait is the 15s READY timeout (not 10s hello); with no hello it is the 10s hello timeout. EPIPE only surfaces as a warn line (`swallowError`, connection.ts:437-439). The comment at connection.ts:434-436 says "Route to exit path" but swallowError does not route anywhere. A child that dies (d2) is detected in ~10ms via the exit event, so the slow path needs a live-but-deaf child.

### Focus 3 addendum — direct-backend parity + transient errno edges (exp3b / exp3c)

Direct `ZcodeBackend` (client.ts) for the same spawn failures (request error text is always the bare `zcode backend reader exited (backend dead)`; the reason lives in deathReason):

| scenario | direct deathReason | starts with `spawn failed` | zserver (post-fix) |
|---|---|---|---|
| ENOENT | `spawn failed: <bin> not found — install the zcode CLI, put it on PATH, or set ZCODE_BIN` | yes | `spawn failed: zcode server exited: spawn error: spawn <root>/node ENOENT` (yes) |
| EACCES | `spawn failed: spawn <bin> EACCES` | yes | yes |
| dir-as-bin | `spawn failed: spawn <dir> EACCES` | yes | yes |
| crash after start | `stdout closed` | no (retryable) | `zcode backend reader exited (backend dead): zcode server exited: code=3 ...` (no, retryable) |

=> Classification is now CONSISTENT with direct for ENOENT/EACCES/dir/crash. Cosmetic: zserver wording says "zcode server exited: spawn error: ..." for a process that never started (connection.ts:142 builds `zcode server exited: ${detail}` for both kinds) and loses direct's actionable "install the zcode CLI / set ZCODE_BIN" hint.

EAGAIN (RLIMIT_NPROC fork failure, `ulimit -u 8`): Node emits `error EAGAIN` with pid undefined and stdio streams present -> zserver: phase `spawn` -> `spawn failed: ...EAGAIN` -> ERR_SPAWN_FAILED; direct: `spawn failed: spawn <bin> EAGAIN` -> ERR_SPAWN_FAILED. Parity, but EAGAIN is a TRANSIENT resource condition labeled as the permanent "binary won't start" class in BOTH backends (the heal loop still makes 3 attempts; only the final prefix is affected).

EMFILE (fd exhaustion; `ulimit -n 40`, 2..6 fds free): `spawn()` returns early for EMFILE/ENFILE WITHOUT creating child.stdin/stdout/stderr, so `childIo()` throws a bare `TypeError: Cannot read properties of undefined (reading 'on')` at `child.stdin.on(...)` (connection.ts:441) -> not a ZServerConnectionError -> deathReason = `zcode backend reader exited (backend dead): Cannot read properties of undefined (reading 'on')` (retryable class: acceptable for a transient errno) but the real cause (EMFILE) is invisible to user/log. No process leak (no child exists), no crash (child 'error' listener is attached first, connection.ts:440). See Finding F-LOW-EMFILE.

---
## Focus 4 + 5 — broker 202 rejection as seen by an attach-mode client (experiment: exp4-broker-202.mjs)

Setup: real `ZServerBroker` (dist-copy with ONLY `listTasks` removed from BROKER_ALLOWED_CALLS; diff shown, snapshot untouched) + real `ZServerBackend` attaching over the unix socket (`ZCODE_ACP_ZSERVER_SOCKET`), fake server behind the broker.

Focus 4 — `request(2,"session/list")` (routes to `zcode-task.listTasks`, rejected):
- `error.message` = `broker: call zcode-task.listTasks is not allowed through the broker`
- has `broker:` prefix: YES; contains "backend reader exited": NO; `isBackendDeadMessage()`: **false**; `isDead` stays **false**, deathReason null; not the literal "timeout".
- => Fix (4) is PROVEN to work for policy rejections: no heal is triggered, the client sees the real reason, backend stays alive. Callers (listSessions etc.) surface `zcode list failed: broker: ...` (no retry, correct for a permanent policy error).

Focus 5 — raw error from `channelOf("zcode-task").call("listTasks")`:
- `instanceof Error`, **name = "BrokerPolicyError"** (toRpcError copies `record.name` when it is a string, channel-client.ts:278-280), message = `broker: call ...`, stack is a string beginning `BrokerPolicyError: broker: call ...` (no `stack` array sent by the broker -> native stack kept), own keys = only `name` (no code/kind/data passthrough because the broker sends only `{message,name}`; consumers that key on `error.code` see undefined).
- `BrokerLimitError` (MAX_PENDING=2): all 3 calls rejected with `{name:"BrokerLimitError", message:"broker: too many outstanding requests through the broker"}`; isDead false. NOTE the limit counts LIVE SUBSCRIPTIONS too (each session holds 3), which is why even the first call was refused in my run (3 live subs >= 2). Matches the code comment, not a bug.

New degradation observed (5d) — **5th policy violation reintroduces the opaque "socket closed" AND arms the bridge-suicide poller**:
- violations 1..4 are answered with a clean 202 (4a, 5a, 5c(listen), 5d-i0). The 5th is `entry.violations < MAX_VIOLATIONS_PER_CLIENT` == false -> `socket.destroy()` (broker.ts:434-443).
- Client then sees: `zcode backend reader exited (backend dead): zcode server exited: socket closed` ; deathReason `zcode backend reader exited (backend dead): zcode server exited (socket closed)`; isDead=true; broker `stats().clients:0`, shared server pid UNCHANGED (the server never exited).
- Consequences: (i) message wrongly claims "zcode server exited" although only this client was cut; (ii) isBackendDeadMessage=true so create/resume/send paths run a heal (re-attach works: 5e restart -> `isDead:false`, new ClientEntry, violations reset), but non-heal callers (listSessions, adoptStoredTitle...) just fail; (iii) with no heal running, index.ts's 2s poller sees `isDead && !backendHealing` and calls `shutdown("backend dead")` (see Focus 2). So a persistent allowlist drift (old machine-level broker daemon outliving a bridge upgrade — the broker is documented as machine-level and long-lived) is tolerated for 4 calls and then kills the bridge. Same end state as before the fix, just delayed by 4 calls, and the final message is again misleading.
- Also: a rejected `listen()` (102) gets its 202 IGNORED by ChannelClient (handler only acts on 204, channel-client.ts:180-184): `fired:0`, no warn line, `eventListeners`/`handlers` entries stay registered (size 4 incl. the rejected one) -> the session is silently deaf and the entry leaks until dispose. Unreachable today (the client's listen set is a strict subset of BROKER_ALLOWED_EVENTS — I cross-checked every call/listen in backend.ts) but it is exactly the drift scenario above.
- The broker already counts a rejected 102 as a violation; a later `103` for it is dropped silently (`serverIdByClient.get` undefined, broker.ts:451-452) — harmless.

### Focus 4/5 cross-check against the REAL server bundle (~/.zcode/server/zcode-server.cjs, code read only, no secrets touched)
- Server emits 202 (PromiseError) with `{name, message, stack:[...], + passthrough keys code/kind/status/retryAfterMs/data/detail/details/taskId/traceId}` and 203 (PromiseErrorObj) with the raw error object; `Unknown channel` timeouts are 202 with `name:"Unknown channel"`, `stack: undefined` (lines ~199915-199961, ~200005-200013). `toRpcError` (channel-client.ts:275-290) mirrors this exactly (name, message, `stack` array joined, same 9 passthrough keys) -> the broker-synthesized `{message,name}` body is a strict subset of the real 202 shape, so it decodes with the same code path (proven in exp4: name=BrokerPolicyError).
- Reference client on an EventListen id: `handlers.set(id, r => emitter.fire(r.data))` fires the listener for ANY response type, so a 202 on a listen would surface as a bogus event carrying `{message,name}`. Our ChannelClient instead acts only on 204 (channel-client.ts:180-184) and DROPS 202/203 on listens. Neither implementation surfaces the failure; ours is safer (no garbage event) but the subscription is silently deaf. Same conclusion as above: unreachable today, latent on allowlist drift.

---
## Focus 6 — unhandledRejection surface (experiment: exp6-unhandled.mjs; a process-level `unhandledRejection`/`uncaughtException` counter was installed)

Real reproductions (dist/, fake server). Result: **0 unhandledRejection, 0 uncaughtException in S1..S8.**

| id | how it was provoked | observed |
|----|---------------------|----------|
| S1 | `subscribeConversationV4` hangs (FAKE_HANG_METHODS), then `close()` disposes the connection -> the pending call rejects with ConnectionClosed | identity guard hit (`this.connection !== connection`) -> silent early return, 0 warns, 0 unhandled. State after: gate disposed, unsubscribers dropped (close() clears), `subscribedSessions` still holds the sid (close() does NOT clear it; `spawn()` does, backend.ts:186) -> S1b: next request respawns and `session/subscribe` re-arms correctly (`subscribed:true, gate:true`). |
| S2 | same hang, but the server child is SIGKILLed (exit path: connection is still `this.connection`) | rollback branch runs: marker deleted, unsubscribers invoked (no-ops on a disposed client), gate disposed; one `warn: backend: conversation subscribe failed: zcode server exited: code=null signal=SIGKILL`; 0 unhandled. |
| S3 | `session/subscribe` on the dead-but-still-current connection | `ChannelClient.listen()` throws SYNCHRONOUSLY (`disposedError`, channel-client.ts:167-169) inside `subscribeConversation`, AFTER `subscribedSessions.add` and `gatesBySession.set` (backend.ts:436-475) -> converted into a normal error by `request()`'s catch (`zcode backend reader exited (backend dead): zcode server channel client disposed`, isBackendDeadMessage=true); leaves a poisoned marker + live gate. Harmless in practice: the connection stays dead until `restart()`, and S3b shows restart() clears both (`subscribed:false, gate:false`). 0 unhandled. |
| S4 | in-flight `session/read` while `restart()` runs | error text = `zcode server channel client disposed` -> `isBackendDeadMessage()` = **false**; direct backend reference gives `zcode backend reader exited (backend dead)` (true). See Finding F-LOW-INFLIGHT. |
| S5 | `close()` raced into 3 consecutive spawns (forces ensureConnection exhaustion) | fix (3) verified: `deathReason = "zcode backend reader exited (backend dead): zserver connection unavailable"`, isDead=true, thrown message is the same text (no more "(unknown)"); S5b: next request respawns, `isDead:false, deathReason:null`. |
| S7 | first spawn hangs, close() supersedes it, second spawn succeeds, then the FIRST spawn rejects late | identity guard in ensureConnection's `promise.catch` works: `isDead:false`, `deathReason:null`, connection intact; the late failure only reaches its own waiter. |
| S8 | `request(..., timeoutMs=1000)` against a server that never says hello | took **10005 ms** (returned the hello-timeout dead message). The per-request timeout wraps only `route()` (backend.ts:273-289); `ensureConnection()` (spawn/handshake, up to 10s hello + 15s ready + broker-attach 15s) runs BEFORE the race and ignores `timeoutMs`. Callers keyed on the literal "timeout" (listener.ts:95, session.ts:1441) therefore never see a timeout for a wedged spawn; they get the dead marker and heal instead — arguably better, but the comment at backend.ts:266-269 ("mirroring the direct backend's contract") overstates. See Finding F-LOW-TIMEOUT-SPAWN. |

### Focus 6 — full promise-site inventory and verdicts (every `void ` / `.then(` / `.catch(` in src/; counted by grep: 22 files; the 4 zserver/listener files were read line by line, the others by call site + callee body)

Legend: SAFE = rejection impossible or explicitly absorbed; SAFE* = safe only because of an invariant noted.

zserver + broker (the files this batch touched):
| site | construct | verdict |
|---|---|---|
| backend.ts:119 `promise.catch(...)` in ensureConnection | identity-guarded handler; the awaited `this.spawnPromise` also carries the rejection to waiters | SAFE (S7: late failure of a superseded spawn -> no state damage, no unhandled) |
| backend.ts:219-232 prefs responder `.call().catch(warn)` | `channelOf().call` is inside a listen callback; `call()` can only reject (never throw sync: `disposed` -> `Promise.reject`) | SAFE |
| backend.ts:250 `void this.close()` (idle timer) | `close()` has no awaits that can reject: sets flags, `dispose()`s (sync), nulls fields | SAFE* (would become unhandled if close() ever throws; `connection.dispose()` -> `io.shutdown()` -> `process.kill` is try/caught) |
| backend.ts:273-289 `Promise.race([route, timeout])` | loser (`route()` after timeout) keeps running; `route` rejections after the race settled are swallowed by Promise.race's internal handlers | SAFE (S8/S4 no unhandled) |
| backend.ts:528-555 `agentChannel.call("subscribeConversationV4").catch(handler)` | identity guard `this.connection !== connection` returns BEFORE any state touch, no throw inside handler; `unsubscribe()` calls inside are `sendRaw` on a disposed client (guarded by `if(!this.disposed)`) | SAFE (S1, S2 measured: 0 unhandled). The one hazard is a SYNC throw from `connection.listen()` (S3) which happens before `.call()` and is caught by request()'s try/catch, leaving a stale marker until `restart()` |
| backend.ts:598 `void this.request(0,...).then(...)` in `send()` | `request()` never rejects (all paths return `{error}`) | SAFE* |
| broker.ts:302 prefs responder `.catch(warn)` | same as above | SAFE |
| broker.ts:308 `this.spawning.catch(()=>{spawning=null})` | swallow + reset; `await this.spawning` is re-thrown to callers | SAFE |
| broker.ts:341 `routeClientFrame(...).catch(destroy)` | last-resort catch; routeClientFrame itself try/catches ensureServer, decodeMessage, rawSend | SAFE. Note `replyError` writes to a socket: `socket.write` on a destroyed socket emits 'error' (handled by the persistent `socket.on("error")`), guarded anyway by `if (entry.socket.destroyed) return` |
| broker.ts:381-390 `void this.ensureServer().then(write).catch(destroy)` | `.then` body can throw (socket.write on ended socket) -> caught by the trailing `.catch` | SAFE |
| broker.ts:556 `this.stop().then(exit0, exit1)` | two-arg then: rejection routed to the 2nd arg; the promise returned by `.then` cannot reject unless `exitProcess` throws (test seam only; default `process.exit`) | SAFE* |
| broker.ts:575 `await this.spawning?.catch(()=>undefined)` | swallow | SAFE |
| connection.ts:96 `exitFailure.catch(()=>undefined)` | keeps `exitFailure` handled even with no handshake awaiting it | SAFE (the 3 `Promise.race([... this.exitFailure ...])` sites also attach handlers) |
| connection.ts:226/243/252 `Promise.race([..., timeout(...)])` | `timeout()` rejection after the race is won stays handled by race's internal `.then` on every member; timers `unref`'d | SAFE |
| cli.ts:163 `broker.stop().then(exit0, exit1)` | same 2-arg pattern | SAFE |

Bridge level:
| site | verdict |
|---|---|
| index.ts:111/114/122 `void shutdown(...)` | `shutdown` awaits `remoteHandle.stop()` and `server.backend.close()` without try/catch -> a rejection there = unhandled + `process.exit(0)` never reached (bridge hangs alive). `ZServerBackend.close()`/`ZcodeBackend.close()` do not reject in practice (ZcodeBackend.close has try/finally, no rethrow; remote stop is bounded). SAFE* — LOW hygiene note only |
| index.ts:176 `.then(resp => attachTurnUsage(...))` | returned to the SDK (handled by the SDK's request pipeline) | SAFE |
| index.ts:241, cli.ts:321 `main().catch(...)` | terminal handlers | SAFE |
| session.ts:330 `void upsertSessionTask(...)`, :705 `void updateSessionTitle(...)` | both bodies are fully wrapped in try/catch returning false (tasks-index.ts:148-215, 271-326) | SAFE |
| session.ts:706 `void sendSessionUpdate(...)` | `cx.notify` rejection when the client link is gone would be unhandled (no `.catch`), unlike the `emitTurnState` sibling (session.ts:716-719, has `.catch`). ACP SDK `notify` after peer close: not reproduced here (needs a live SDK connection) -> **UNVERIFIED**, see F-LOW-VOID-NOTIFY |
| session.ts:1129-1146 `withPreemptLock` `next.finally(...).catch(...)` | comment-documented pattern | SAFE |
| session.ts:2153 `void dispatchPlanIfChanged(...).catch(()=>{})` | SAFE |
| handlers/background-tasks.ts:135,156 `void this.onTaskStatus/forwardText` and extensions.ts:162 `void listener.markCancelled` | bodies read in full: they only `await server.notifyByZcodeSid()` which has an internal try/catch returning false (server.ts:412-428) and pure map ops -> cannot reject | SAFE* |
| server-requests.ts:192, 423, 783, 806, 898 | each has a rejection arm or `.catch` (read) | SAFE |
| remote/broadcast.ts:39 `void conn.closed.then(...)`, :164 `promise.catch(()=>undefined)` | `closed` is a never-rejecting promise per SDK contract; comment in file documents the loser pattern | SAFE* |
| remote/endpoint.ts:339,352,358,359 `void registerOnce()` | body is try/catch around every await, and the pre-try `lastSessions` block is wrapped | SAFE |
| remote/hub-server.ts:327,339 `void close().finally(...)`, `void handleHttp().catch(...)` | `close()` wraps server.close callbacks; `.finally` on a rejected `close()` would re-reject (unhandled) but `close()` resolves on all paths | SAFE* |
| bin/hub.ts:62-63 `void hub.close().then(() => process.exit(0))` | no rejection arm; `close()` resolves on all paths | SAFE* (LOW hygiene) |
| repl/*.tsx/run.ts (12 `void`) | REPL-only; run.ts installs its own `uncaughtException`/`unhandledRejection` handlers (run.ts:65,101) | out of scope for the bridge; SAFE |

Node 22 default (`--unhandled-rejections=throw`) was confirmed: an unhandled rejection exits the process with code 1. There is NO global `unhandledRejection` handler in the bridge/broker path (only in the REPL), so any missed site would kill the bridge or the shared broker.
Verdict for the batch: no unhandled path found in the code touched by 592c65c; the new identity-guard early `return` in `subscribeConversation`'s catch leaves nothing unhandled (S1/S2 measured).

---
## Focus 7 — broker attach failure -> direct fallback; `spawn failed` prefix contract (experiment: exp7-fallback-chain.mjs)

| case | attach failure | direct spawn | request() | deathReason | heal final error (Multica sees) | broker visible to user? |
|---|---|---|---|---|---|---|
| a | `connect ENOENT <sock>` | fails (bundle missing) | `zcode backend reader exited (backend dead): zcode server bundle not found: <root>/zcode-server.cjs` | `spawn failed: zcode server bundle not found: ...` | `zcode_spawn_failed: spawn failed: zcode server bundle not found: ...` | NO (only in a separate warn line per attempt) |
| b | `connect ECONNREFUSED <sock>` (regular file) | fails | same as a | same as a | same as a | NO |
| c | `connect ENOENT` | WORKS | ok in 74ms | null | (n/a) | silent private-server fallback: one warn line `backend: broker attach failed (...) — falling back to direct zcode server spawn` |
| d | wedged broker (accepts, never Initialize) -> `zcode server ready timeout after 15000ms` | WORKS | **ok, but only after 15087ms** | null | (n/a) | one warn line |

Answers to 7:
- deathReason for "broker attach failed AND direct also fails" is the DIRECT failure only (`spawn failed: ...`): `connection ??= await ZServerConnection.spawn(...)` throws, and the attach error is only ever emitted through `warn` (backend.ts:160-167). Prefix contract holds: `startsWith("spawn failed")` -> ERR_SPAWN_FAILED, consistent with session.ts:230/1410.
- Log chain visible? YES but only on stderr, one line per attempt, no correlation id: the heal loop produced 7 broker-attach warn lines for 3 heal rounds (`brokerAttemptWarns:7`, 25 warn lines total). The final error text (what Multica/clients see) contains NO mention of the broker. A user who set ZCODE_ACP_ZSERVER_SOCKET and gets `zcode_spawn_failed: ... bundle not found` cannot tell from the error that the broker route was tried and failed first (they see it only if they capture stderr).
- Silent-degradation risk (case c/d): a missing/dead broker converts "shared server" into "private server per bridge" with a single warn. That is by design (comment backend.ts:160), but case d shows a wedged broker (accepts the connection but never answers) costs a full 15s on EVERY spawn AND on every heal round (ensureConnection -> spawn() re-tries attach each time, "the restart/heal path retries the broker first"), i.e. up to 3x15s before falling back inside a heal; the caller's own `request` timeout (10-15s) does not bound it (see S8). See Finding F-LOW-WEDGED-BROKER.
- Credential-scoping note (verified by reading, not run): the fallback direct spawn uses `runtimeEnvWithProfile(process.env)` (full env incl. MULTICA_*), whereas the broker path deliberately strips task-scoped vars (`brokerBaseEnv`). So the private fallback server is started with the task-scoped credentials in the environment; this is the intended non-shared path (one bridge, one task) and not a leak.

---
## Focus 8 — `ensureGlmPersonalProviderAfterRefresh` (cli.ts:260-303) (experiments: exp8-profile-refresh.mjs, exp8b-symlink-pin.mjs; temp HOME; API key = literal `FAKE-KEY-DO-NOT-USE-0000`, no real key touched)

Pin-rejected path (1: injected `resolveTarget` returns `rejectedPin`, `ensure` wired to throw if called):
- stdout (one line): `personal provider: not touched — the desktop pins /etc/evil/provider_config.json, which is outside ~/.zcode and is refused as a write target for the plan key`
- `ensure` NOT called; nothing thrown; **process exit code 0**. cli.ts:178-189 confirms `process.exitCode = 1` is set only when `refreshDesktopProfile()` itself throws; the post-refresh guard never sets it. So a refused pin is a soft, exit-0 notice (matches the "best-effort, refresh's exit code is untouched" contract in the docblock). Note the message goes to STDOUT, not stderr, and the pinned path is echoed verbatim to the terminal (path only; no secret).
- `resolvePersonalProviderTarget` additionally emits `warn("personal-provider: ignoring untrusted ZCODE_PERSONAL_PROVIDER_CONFIG_FILE pin <p> (outside ~/.zcode)")` on stderr (2b) — double reporting, harmless.

Catch branch (`loadDesktopProfile()` throws -> `resolvePersonalProviderTarget()` with PROCESS env):
- 2a clean env: default target `<HOME>/.zcode/v2/provider_config.json`; entry re-added (fake key written into the temp file only): `personal provider: GLM Coding Plan entry re-added (<uuid>) in <HOME>/.zcode/v2/provider_config.json`.
- 2b hostile `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=<outside ~/.zcode>` in the process env: **refused by the same validation** — same "not touched — the desktop pins ..." line, warn on stderr, **evil file byte-identical, default file untouched, no sibling files created** in the evil dir. The catch branch therefore does not widen trust: it applies the identical `resolvePersonalProviderTarget` check, it merely takes the pin from the process env instead of the (unloadable) profile.
- Resolver matrix (same validator): outside-home abs -> rejected; `~/.zcode/../evil` -> rejected; `~/.zcode-evil/...` (prefix confusion) -> rejected (the `+ path.sep` suffix works); relative path -> rejected; empty / whitespace -> treated as unset (default); inside ~/.zcode existing or not-yet-existing -> accepted.
- Symlink escape: EXISTING target through a symlinked dir under ~/.zcode pointing outside -> rejected (realpath resolves it; B: outside file untouched, no key written). NON-EXISTENT target through a symlinked dir -> the `catch` lexical branch ACCEPTS the pin (personal-provider.ts:89-94: `pinned` startsWith `~/.zcode/` and has no `..`), `path` = the symlinked location; but `ensurePersonalGlmProvider` then does `readFileSync` -> ENOENT -> `skipped: provider_config.json unreadable`, and it only ever reads-then-writes an EXISTING file (no create path: `atomicWrite` is reached only after a successful read+parse). So the lexical acceptance of a non-existent pin cannot produce a write today (A: outside dir stayed empty). LOW latent gap: if a future change creates missing files, this lexical branch would follow the symlink. See Finding F-LOW-LEXICAL-PIN.
- Behavioral note: when the desktop is NOT running (catch branch, the common REPL/bare CLI case) the guard still WRITES the plan key into `~/.zcode/v2/provider_config.json` if it exists and has no GLM rule. That is the documented purpose ("re-ensure after refresh"), but the docblock says the target comes "from the just-refreshed profile when loadable"; in the catch branch a process-env pin from a parent (e.g. an agent runtime) is trusted equally, bounded by the ~/.zcode check.
