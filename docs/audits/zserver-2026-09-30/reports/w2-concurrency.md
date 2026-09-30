# W2 concurrency & async-race audit — snapshot 592c65c (read-only)

Method: line-by-line dry-run of the new primitives + experiments against dist/ and a patched copy of
tests/fixtures/zserver-fake-server.mjs (in /tmp/audit-conc2-*, removed at the end). Real server bundle
(~/.zcode/server/zcode-server.cjs) read with grep+sed only. No key/token values read.

Severity: HIGH / MEDIUM / LOW / UNVERIFIED. Line refs are snapshot lines (src/backend/zserver/*.ts unless noted).

---
## FOCUS 5 (static part, real bundle) — releaseSession never releases the V4 conversation subscription

Bundle facts (zcode-server.cjs, 11.5MB; line numbers are of the bundle as deployed 2026-09-26):
- 271663  createStdioServer: ONE connection scope per stdio server process:
          createZCodeAgentConnectionScope(agentService,{connectionId:`server-stdio-<uuid>`, role:"trusted-host-relay"}).
- 206002/205996 scope.subscribeConversationV4: forwardedConnection(params) -> no trusted carrier from our bridge ->
          connectionId = the scope's own `server-stdio-<uuid>`; entry stored in scope.owned keyed
          (kind, workspaceKey, topic, subscriptionId, connectionId) + routeKeyByOwnership keyed (kind, workspaceKey, topic, connectionId).
- 218903..218983 base.subscribeConversationV4 -> rememberV4SubscriptionRoute() (215959): replaces `previous`
          route with the same (workspaceKey, topic, connectionId) ownership key; does NOT unsubscribe the previous one.
- 206021/218985/216017 unsubscribeConversationV4 -> unsubscribeV4Route(): needs params.subscriptionId (from the
          subscribe ack: result.ack.subscriptionId) -> client.request(conversationUnsubscribe) -> forget route.
- 206195 scope.dispose() (called from stdio stop() on stdin close, 271689): Promise.allSettled(owned entries -> unsubscribeBase).
          => (a) YES: the V4 subscription is bound to the (per stdio server process) connectionId and is auto-released when
          that server's stdio closes. NOT released on a per-session basis unless unsubscribeConversationV4 is called.
- 205838 invalidateWorkspaceRuntime: on CLI runtime restart the scope only forget()s local ownership (CLI-side state died with the CLI).
- Frame routing (205680 routeIncomingFrame/ownsFrame): frames are fired to the per-(kind,workspace) emitter only if an
          owned entry with the SAME subscriptionId+topic exists; otherwise staged (if a pending group exists) or dropped.

---
## FOCUS 1 — ChannelClient.call AbortSignal (experiment E1, dist of 592c65c; 24 assertions, all as predicted)

Code under test: channel-client.ts:102-152 (onAbort/cleanup/resolve/reject wrappers, run() guard at :117), :221-229 abandon, :231-246 dispose.

Dry-run (all JS is single-threaded; "same tick" = same synchronous block, "same loop iteration" = two callbacks queued for one event-loop turn):
- 201 and abort same tick, 201 first:  T0 handlers.get(id)->201 branch: handlers.delete, pending.delete, resolve()->cleanup() removes the
  abort listener, resolveRaw(v).  T1 ac.abort(): listener already removed -> nothing.  Result ok, 0 listeners, 0 map entries. (E1 1a)
- abort first, 201 second:  T0 onAbort->abandon: pending.get(id) present -> handlers.delete, pending.delete, reject()->cleanup()+rejectRaw.
  T1 client.onMessage(201): handlers.get(id) undefined -> `handler?.()` no-op.  No double settle, no double delete (delete of an absent key is
  a no-op anyway). (E1 1b, 1c both orders for 202)
- timer(abort) vs I/O(201) in one loop iteration: timers phase precedes check/poll phases, so an overdue abort timer wins over a 201 from setImmediate
  (E1 1j). Either order settles exactly once; the loser is dropped. The cost of losing is only "a completed server-side call is reported as timeout".
- call queued BEFORE Initialize, abort before run(): pending.delete in abandon -> run() sees `!pendingRejections.has(id)` and returns BEFORE
  handlers.set/sendRequest: request never sent, no handler, listener removed (E1 1d: frames sent after Initialize = 0). Live queued siblings still
  run (1e).
- dispose() with a signal-scoped pending call: dispose loops pendingRejections and invokes the WRAPPED reject -> cleanup() runs -> 0 listeners on
  the signal afterwards; later ac.abort() is inert (1f, 1g).
- N calls sharing one signal: N listeners attached, all removed on abort/settle (1h: 25 -> 0).

[LOW] channel-client.ts:116-119,149 — aborted-before-Initialize calls stay in `queued` as closures until Initialize/dispose (1i: 1000 aborted calls =>
  queued.length 1000, only drained by Initialize or dispose). Bounded by the handshake (<=15s READY_TIMEOUT, then connection.dispose()), and in
  production spawn()/attach() only return the connection AFTER Initialize, so `queued` is empty for every caller of ServiceChannel. Pure
  hygiene; fix if desired: `const i = this.queued.indexOf(run); if (i>=0) this.queued.splice(i,1)` inside abandon, or ignore.

No HIGH/MEDIUM found in focus 1. (cancel() at :205 is unused in src — grep — so its Cancelled path is dead code.)

---
## FOCUS 5 (cont., real bundle + CLI) — what the server does with the V4 conversation subscription

Read from ~/.zcode/server/zcode-server.cjs (host) and agents/glm/zcode.cjs (CLI child; minified, bounded grep):
- CLI gateway subscribeReserved(t): `n = subscriptionIdByConnection.get(t.connectionId)`; the previous sub for that connectionId is DELETED,
  then a new `sub-<epoch>-<serial>` is created and stored by connectionId. => AT MOST ONE live subscription per (session publisher, connectionId);
  re-subscribing REPLACES, it does not stack.  unsubscribe(t,n) removes by subscriptionId (+connectionId check).
- Host scope: `owned` map keyed (kind, workspace, topic, subscriptionId, connectionId); `routeKeyByOwnership` (kind, workspace, topic,
  connectionId) -> remember() drops the previous owned entry for the same ownership key.
- Our bridge never sends a trusted carrier, so connectionId = the stdio server's own `server-stdio-<uuid>`: ONE connectionId per zcode-server
  process. Direct mode: one bridge <-> one server (1:1). Broker mode: ALL bridges attached to the broker share that single connectionId.
- scope.dispose() (stdio close) -> Promise.allSettled(owned -> unsubscribeBase): all V4 subs released when the server process/stdio goes away.

Answers to the three questions:
 (a) YES bound to connection: released automatically on stdio close / server exit. Not per-session, not per-EventListen.
 (b) releaseSession() only sends 103 for the 3 EventListen ids (task terminal outcome / session events / conversation frames). It does NOT call
     unsubscribeConversationV4 (grep: the only mention of that name in src/ is the broker allowlist at broker.ts:74; subscriptionId from the
     subscribe ack is never even read - `.call(...)` result is discarded at backend.ts:528-533). So the host `owned` entry + CLI subscription
     for that session stay alive until the server process ends. Cost is bounded: 1 owned entry + 1 CLI subscription per (session, server
     process), replaced on re-subscribe (no stacking), frames for it are computed/sent and dropped by the emitter (no listener). It is a
     bounded resource leak, not an unbounded one; the docstring at backend.ts:558-566 ("Without it every session kept three server
     subscriptions") over-claims: after release the session still holds ONE server-side V4 subscription.
 (c) Broker mode: the connectionId is shared by every attached bridge, so the V4 subscription is effectively a per-(session,server) singleton.
     Consequences: (i) two bridges subscribing the same session REPLACE each other's subscriptionId on host+CLI, but frames still reach both
     because delivery goes through the workspace-scoped `routedEvent` emitter that every EventListen(onDynamicConversationFrame) hangs on;
     (ii) if releaseSession() DID call unsubscribeConversationV4 it would tear down the ONE subscription for ALL bridges on that session and
     silence the others => the missing RPC is, in broker mode, accidentally protective; a fix must be mode-aware (direct mode only, or
     refcount across clients - which the broker could do because it sees every client frame).

---
## FOCUS 2 — request() abandon vs multi-step route(): orphan session (experiments E2, E2b; post-fix dist vs pre-fix copy = same dist with the two `channelOf(..., signal)` args removed)

Code: backend.ts:271-289 (`abandon.abort(timedOut)` after `reject(timedOut)`), :329-330 (request-scoped channels), :332-348 (session/create: createSession -> workspaceBySession.set -> createTask -> subscribeConversation).

Dry-run, timer fires while createSession is pending (T0 = timer callback):
  T0   reject(timedOut) (race settles, reactions queued as microtasks); abandon.abort(timedOut) -> onAbort -> ChannelClient.abandon(id):
       handlers.delete(id), pendingRejections.delete(id), reject(reason).  No 101 is sent.
  T0+  microtasks: request() catch -> {error:{message:"timeout"}}; route() `await createSession` throws -> route ends (race already settled: handled, no
       unhandledRejection).  `workspaceBySession.set` (:340) and createTask/subscribe are NEVER reached.
  T1   server answers createSession (201) -> handlers.get(id) undefined -> dropped. The new session id is never learned by the bridge.
Timer fires while createTask is pending: createSession already answered and `workspaceBySession[sid]` set; createTask was already SENT (server will finish it);
  abort abandons only the local wait; subscribeConversation is never reached.

Measured (fake server, 150ms request timeout, answer delay swept 110..190ms; "server saw" = RPCs actually received):
  post-fix, createSession slow, delay >=150: bridge=timeout | server saw createSession ONLY | subscribed=0 wsMap=0 handlers/pending/evListeners back to baseline
  post-fix, createTask slow,    delay >=150: bridge=timeout | server saw createSession>createTask | subscribed=0 wsMap=1 (stale sid->workspace entry)
  pre-fix,  either case:                     bridge=timeout | server saw createSession>createTask>subscribeConversationV4 | subscribed=1, gate=1, unsubscribers=3,
                                             evListeners+3, handlers+3 - a fully wired session NOBODY references (sid never returned to the caller), never released
  (delay <150 -> success in all four runs; the boundary is exactly the timer.)

Impact of the new behaviour, from the real bundle (zcode-server.cjs @2026-09-26 build):
  - agent.createSession (bundle 217421) only calls the CLI `session/create` (persistence "immediate" is forced by buildCreateSessionParams, backend.ts:679) and
    rememberSessionTrace; it does NOT touch the task index. Only zcode-task.createTask(draftSessionId) (bundle 222465..222585) does syncTaskIndexMeta +
    initializeGroupedTaskAtTop + notifySyncerSession + emitWorkspaceTaskListChanged. listTasks (222945) reads that index, and the bridge lists sessions via listTasks.
  - So the createSession-slow case leaves a PERSISTED, LIVE-RESIDENT-then-evicted but UN-INDEXED session record: invisible to session/list and to the desktop task list,
    no bridge state, no live subscription. The createTask-slow case leaves an indexed, unsubscribed empty task (+1 stale workspaceBySession entry).
  - Caller side is unchanged: createBackendSessionWithHeal (handlers/session.ts:198-206) treats "timeout" as non-dead -> throws "zcode create failed: timeout"; the editor/Multica
    retries with a fresh session/create -> a NEW session. Both before and after the fix the first session is unreferenced.

[LOW] backend.ts:329-330,340,341 — net effect vs pre-fix is an improvement for the bridge (no unreleased 3 EventListen + V4 subscription + gate + 4 map entries per timed-out create),
  at the price of leaving an un-indexed persisted session (createSession-slow) or a stale wsMap entry (createTask-slow) on the server side. Trigger needs the 15s create timeout
  (handlers/session.ts:199) to fire mid-create; realistic only on cold CLI bootstrap. No live-resource leak; disk/db litter only. I could not verify whether the CLI garbage-collects
  never-indexed empty sessions -> UNVERIFIED (cleanup policy).
  Suggested fix (pick one):
   (a) minimal: scope the abort signal to the FIRST call only (createSession); after it returns a sid, run createTask+subscribe on an unscoped channel so the session is completed
       (== pre-fix outcome for the steps after createSession, without pinning a handler for a wedged createSession).  Residual: sid still unknown to the timed-out caller.
   (b) compensating: after createSession succeeded, if the signal aborted, complete createTask then closeTask({taskId:sid}) (both allowlisted in the broker) fire-and-forget, so the
       server ends clean.  Cannot be done for the createSession-slow case unless the late 201 is still observed (needs an `onLate` hook in ChannelClient.call, or not abandoning that call).
   (c) also drop the stale `workspaceBySession` entry in route() when the signal aborted after :340 (one line in a `catch`/`finally`).
