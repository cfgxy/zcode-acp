import type { BridgeBackend, ZcodeEvent, ZcodeResponse } from "../types.js";
import { loadDesktopChildEnvWithRefresh } from "../../desktop-profile.js";
import { warn } from "../../utils.js";
import type { EventListenerLike } from "../types.js";
import { ServiceChannel, ZServerConnection, ZServerConnectionError } from "./index.js";

export interface ZServerBackendOptions {
  serverRoot?: string;
  clientId?: string;
}

/**
 * Backend adapter (ADR-0008 M2): emulates the app-server JSON-RPC surface the
 * bridge handlers use (session/create|send|read|list|load|resume|stop) on top
 * of a locally spawned zcode-server.cjs channel connection, and translates the
 * server's task/row event dialect into the app-server event dialect the
 * translator consumes (turn.started / model.streaming / turn.completed /
 * turn.failed / state.updated).
 *
 * Deliberately minimal: editor-visible parity (tool rows, replay, slash,
 * extensions) lands incrementally — unsupported methods fail with a visible
 * "not supported in zserver mode" error instead of misbehaving silently.
 */
/**
 * Best-effort desktop identity pins: when a desktop profile is capturable,
 * merge its env over the base so the spawned server (and its agents) carry the
 * desktop-attached identity markers; otherwise the server runs in local
 * authority mode, which is a verified-working fallback (billing resolves via
 * ~/.zcode/v2/config.json either way).
 */
/** Env keys that carry ONE task's/session's credentials or identity. The broker
 *  is a machine-level daemon shared by every client, so a token inherited from
 *  whichever process happened to start it must never reach other clients'
 *  agent shells (credential mixing + silent expiry breakage). */
const TASK_SCOPED_ENV = /^(MULTICA_|SSH_AUTH_SOCK$|SSH_AGENT_PID$|SSH_CONNECTION$|SSH_CLIENT$)/;

/** Broker-mode env: everything except task-scoped credentials. */
export function brokerBaseEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!TASK_SCOPED_ENV.test(key)) out[key] = value;
  }
  return out;
}

export async function runtimeEnvWithProfile(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  try {
    const pins = loadDesktopChildEnvWithRefresh();
    return { ...base, ...pins };
  } catch (error) {
    warn(
      `backend: desktop profile unavailable (${
        error instanceof Error ? error.message : String(error)
      }) — spawning server with plain env (local authority)`,
    );
    return base;
  }
}

export class ZServerBackend implements BridgeBackend {
  isDead = false;
  deathReason: string | null = null;
  /** The transport is respawned IN PLACE: by `restart()` (the supervised heal)
   *  and, after `close()`/idle recycling, lazily by the next request. An
   *  unexpected death is deliberately NOT respawned by an ordinary request — it
   *  must stay observable so the heal path (and a mid-turn fast-fail) sees it.
   *  Either way the instance stays, so a dead marker must never make the bridge
   *  replace it: the turn loops' listeners live on it (server.ts ensureBackend
   *  honours this). */
  readonly healsInPlace = true;

  private connection: ZServerConnection | null = null;
  private readonly listeners = new Map<string, Set<EventListenerLike>>();
  /** taskId → workspacePath (task targets are needed for per-session calls). */
  private readonly workspaceBySession = new Map<string, string>();
  /** Per-session streaming state: emitted text length per assistant row. */
  private readonly emittedByRow = new Map<string, number>();
  private seqBySession = new Map<string, number>();
  /** Sessions with live server-side subscriptions (conversation/terminal/state). */
  private readonly subscribedSessions = new Set<string>();
  private readonly gatesBySession = new Map<string, TurnCompletionGate>();
  /** Teardown for a session's three live server-side listeners (terminal
   *  outcome / session events / conversation frames). Kept until the session is
   *  released or the connection dies — the success path used to drop them, so
   *  they could never be reclaimed. */
  private readonly unsubscribersBySession = new Map<string, SessionTeardown>();
  private readonly terminalErrorBySession = new Map<string, Record<string, unknown> | undefined>();
  private spawnPromise: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Idle ms before the server child is shut down (0 = keep forever). */
  private readonly idleMs = Number(process.env.ZCODE_ACP_ZSERVER_IDLE_MS ?? 0) || 0;
  /** Requests currently awaiting route(): idle recycling must never close the
   *  connection out from under them (a slow spawn/request outliving idleMs
   *  would otherwise get its connection nulled mid-flight). */
  private inFlight = 0;
  /** Intentional-shutdown marker: the child's exit during close() must NOT
   *  mark the backend dead — index.ts's death poller would kill the whole
   *  bridge within 2s otherwise (idle recycle == suicide without this). */
  private closing = false;
  /** Monotonic spawn generation: a close() during an in-flight spawn() must
   *  leave the late connection disposed, not assigned (orphan/dual-server). */
  private spawnGeneration = 0;

  constructor(
    private readonly options: ZServerBackendOptions = {},
    private readonly clientId = `zcode-acp-zserver-${process.pid}`,
  ) {}

  private async ensureConnection(): Promise<ZServerConnection> {
    // Loop: a close()/restart() racing an in-flight spawn makes that spawn
    // dispose its own late connection and return without assigning — the
    // waiter must then start (or join) a fresh spawn instead of dereferencing
    // a null connection.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.connection) return this.connection;
      if (!this.spawnPromise) {
        const promise = this.spawn();
        this.spawnPromise = promise;
        // A rejected spawnPromise must never be cached. The handler is
        // identity-guarded: a superseded (older) spawn failing late must not
        // clobber a newer spawn's promise nor mark a healthy backend dead.
        promise.catch((error: unknown) => {
          if (this.spawnPromise !== promise) return;
          this.spawnPromise = null;
          this.isDead = true;
          const message = error instanceof Error ? error.message : String(error);
          // Wire contract (supervise.ts consumers): "spawn failed" prefix
          // classifies permanent unbootable states (ERR_SPAWN_FAILED, no
          // infinite retry); anything else keeps the backend-dead marker for
          // retryable healing.
          this.deathReason =
            error instanceof ZServerConnectionError && error.phase === "spawn"
              ? `spawn failed: ${message}`
              : `zcode backend reader exited (backend dead): ${message}`;
        });
      }
      await this.spawnPromise;
    }
    if (!this.connection) {
      // Record why, or the classified heal-exhaustion error degrades to "(unknown)".
      const message = "zcode backend reader exited (backend dead): zserver connection unavailable";
      this.isDead = true;
      this.deathReason = message;
      throw new Error(message);
    }
    return this.connection;
  }

  private async spawn(): Promise<void> {
    const generation = ++this.spawnGeneration;
    // A fresh spawn starts a fresh lifecycle: clear the intentional-shutdown
    // marker (idle-recycle/close set it so the OLD child's exit was ignored;
    // without clearing here the backend could never respawn).
    this.closing = false;
    const socketPath = process.env.ZCODE_ACP_ZSERVER_SOCKET;
    let connection: ZServerConnection | null = null;
    let attached = false;
    if (socketPath) {
      try {
        connection = await ZServerConnection.attach({ socketPath, clientId: this.clientId });
        attached = true;
      } catch (error) {
        // Broker down should not take the bridge down: fall back to a direct
        // server spawn (the restart/heal path retries the broker first).
        warn(
          `backend: broker attach failed (${
            error instanceof Error ? error.message : String(error)
          }) — falling back to direct zcode server spawn`,
        );
      }
    }
    connection ??= await ZServerConnection.spawn({
      serverRoot: this.options.serverRoot,
      clientId: this.clientId,
      env: await runtimeEnvWithProfile(process.env),
    });
    if (this.closing || generation !== this.spawnGeneration) {
      // close() raced the spawn: nobody wants this connection anymore.
      connection.dispose();
      return;
    }
    this.connection = connection;
    this.isDead = false;
    this.deathReason = null;
    this.closing = false;
    // Server-side subscriptions died with the previous connection (spawn
    // mode: new server child; attach mode: possibly respawned shared server).
    // Re-establish lazily via session/resume on the heal path.
    this.subscribedSessions.clear();
    this.emittedByRow.clear();
    // The handles belong to the dead connection's (already disposed) client:
    // there is nothing left to unsubscribe from.
    this.unsubscribersBySession.clear();
    connection.onExit((code, signal, detail) => {
      // Per-CONNECTION identity, not the shared `closing` flag: an old child's
      // exit can arrive after a NEW spawn cleared the flag (SIGTERM takes
      // hundreds of ms). Only the CURRENT connection dying is a backend
      // death; a retired connection's exit is the expected end of close().
      if (this.connection !== connection || this.closing) {
        return;
      }
      this.isDead = true;
      // Message carries the canonical "backend reader exited" marker so the
      // supervision classifiers (isBackendDeadMessage) recognize zserver-mode
      // deaths and the heal path fires exactly as for the direct backend.
      this.deathReason =
        "zcode backend reader exited (backend dead): " +
        `zcode server exited (${detail ?? `code=${code ?? "null"} signal=${signal ?? "null"}`})`;
      warn(`backend: ${this.deathReason}`);
    });
    this.armIdleTimer();
    // Forwarded runtime-preferences requests (desktop-attached-remote
    // authority): answer with the server's own local-mode defaults so
    // session/create completes. No-op under local authority (never fires).
    // Attach mode: the BROKER owns the shared server and answers there — a
    // second responder per attached client would double-answer the same
    // requestId (second respond errors "request not found").
    if (!attached)
      connection.listen("onDynamicSessionRuntimePreferencesRequest", undefined, (request) => {
        const requestId = (request as { requestId?: string } | null)?.requestId;
        if (!requestId) return;
        connection
          .channelOf("zcode-agent")
          .call("respondSessionRuntimePreferences", {
            requestId,
            resolution: {
              status: "ok",
              preferences: {
                nativeSearchEnhancementsEnabled: true,
                memoryEnabled: false,
                askUserQuestionAutoResolutionEnabled: true,
              },
            },
          })
          .catch((error) => warn(`backend: runtime preferences respond failed: ${error.message}`));
      });
  }

  /**
   * Idle reclamation: with zero registered session listeners the server child
   * holds ~120MB + agent processes for nothing, so it is shut down after
   * ZCODE_ACP_ZSERVER_IDLE_MS (0 = keep forever) and lazily respawned on the
   * next request.
   */
  private armIdleTimer(): void {
    if (!this.idleMs) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.listeners.size > 0 || this.inFlight > 0) {
        this.armIdleTimer();
        return;
      }
      void this.close();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /** app-server JSON-RPC surface emulation. Resolves {result} or {error}. */
  async request(
    id: number,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15000,
  ): Promise<ZcodeResponse> {
    this.armIdleTimer();
    this.inFlight++;
    try {
      const connection = await this.ensureConnection();
      // Per-request timeout, mirroring the direct backend's contract: callers
      // (EventStreamListener subscribe retry, resume retry) key on the exact
      // error message "timeout" — a wedged-but-alive server must surface as a
      // retryable timeout, not hang the turn setup forever.
      let timeoutHandle: NodeJS.Timeout | undefined;
      const abandon = new AbortController();
      try {
        const result = await Promise.race([
          this.route(connection, method, params, abandon.signal),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              const timedOut = new RequestTimeoutError();
              reject(timedOut);
              // The caller gave up: forget the calls this request still has in
              // flight (no 101 — a sendPrompt must not be aborted server-side).
              // Otherwise every timeout pinned a response handler for the whole
              // life of the connection against a wedged server. A late answer
              // is dropped.
              abandon.abort(timedOut);
            }, timeoutMs);
            timeoutHandle.unref?.();
          }),
        ]);
        return { id, result: result as Record<string, unknown> };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch (error) {
      if (error instanceof RequestTimeoutError) {
        return { id, error: { message: "timeout" } };
      }
      const message = error instanceof Error ? error.message : String(error);
      // Died while this request was in flight → classify as backend-dead so
      // the supervised heal path (restart + resume) engages.
      return {
        id,
        error: {
          message:
            this.isDead && !message.includes("backend reader exited")
              ? `zcode backend reader exited (backend dead): ${message}`
              : message,
        },
      };
    } finally {
      this.inFlight--;
    }
  }

  private async route(
    connection: ZServerConnection,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const workspace = (params["workspace"] ?? {}) as {
      workspacePath?: string;
      workspaceKey?: string;
    };
    const workspacePath = workspace.workspacePath ?? (workspace.workspaceKey as string) ?? "";
    const sessionId = (params["sessionId"] as string) ?? "";
    // Request-scoped channels: a timeout abandons whatever is still pending
    // (and stops a multi-step route at its next call). Long-lived calls such as
    // the conversation subscription use their own unscoped channel.
    const agentChannel = connection.channelOf("zcode-agent", signal);
    const tasks = connection.channelOf("zcode-task", signal);
    switch (method) {
      case "session/create": {
        if (!workspacePath) throw new Error("session/create requires workspace.workspacePath");
        const snapshot = (await agentChannel.call(
          "createSession",
          buildCreateSessionParams(params, workspacePath),
        )) as { session?: { sessionId?: string } };
        const sid = snapshot?.session?.sessionId;
        if (!sid) throw new Error("createSession returned no sessionId");
        this.workspaceBySession.set(sid, workspacePath);
        await tasks.call("createTask", {
          workspacePath,
          draftSessionId: sid,
          clientId: this.clientId,
        });
        this.subscribeConversation(connection, workspacePath, sid);
        return { session: { sessionId: sid } };
      }
      case "session/send": {
        const content = (params["content"] as string) ?? "";
        const target = this.workspaceBySession.get(sessionId) ?? workspacePath;
        await agentChannel.call("sendPrompt", {
          workspacePath: target,
          sessionId,
          content,
          clientId: this.clientId,
          clientMode: "desktop-continuous",
        });
        return { accepted: true };
      }
      case "session/subscribe": {
        // The EventStreamListener's watermark subscription. Server-side event
        // delivery is handled by our conversation subscriptions; the listener
        // only needs the current seq watermark here.
        const target = this.workspaceBySession.get(sessionId) ?? workspacePath;
        this.subscribeConversation(connection, target, sessionId);
        return { eventSeq: this.seqBySession.get(sessionId) ?? 0 };
      }
      case "session/read": {
        const target = this.workspaceBySession.get(sessionId) ?? workspacePath;
        return await agentChannel.call("readSession", { workspacePath: target, sessionId });
      }
      case "session/stop": {
        const target = this.workspaceBySession.get(sessionId) ?? workspacePath;
        await tasks.call("stopGeneration", { taskId: sessionId, workspacePath: target });
        return {};
      }
      case "session/load":
      case "session/resume": {
        const target = this.workspaceBySession.get(sessionId) ?? workspacePath;
        if (!target) {
          throw new Error(
            "session/resume requires workspace (no mapping for session — " +
              "send workspace:{workspacePath} so later session/send can address it)",
          );
        }
        // Remember the mapping: session/send / read / stop carry only sessionId
        // (no workspace), and after a bridge restart this is the only place
        // the mapping is rebuilt.
        this.workspaceBySession.set(sessionId, target);
        const result = await agentChannel.call("readSession", { workspacePath: target, sessionId });
        // The heal path resumes after a backend restart; server-side
        // subscriptions died with the old connection — re-establish them so
        // the turn loop sees events again (idempotent via subscribedSessions).
        this.subscribeConversation(connection, target, sessionId);
        return result;
      }
      case "session/messages": {
        // History surface (replay/differ baseline). The inner readSession
        // snapshot carries the persisted message log; deep shape parity with
        // the direct backend's dialect is pending live verification (ADR), but
        // routing it beats the previous silent blank (fetchMessages warn+[]).
        const target = this.workspaceBySession.get(sessionId) ?? workspacePath;
        const snapshot = (await agentChannel.call("readSession", {
          workspacePath: target,
          sessionId,
        })) as { messages?: unknown };
        return { messages: snapshot?.messages ?? [] };
      }
      case "session/list": {
        // The real server's listTasks returns a BARE ARRAY of task metas (verified
        // against the deployed bundle: `tasks.map(rememberIndexedTaskMeta)`), not
        // `{tasks:[…]}`; it filters by workspace when one is given. `.tasks` is
        // accepted too so a wrapped shape (older/newer server) keeps working.
        const raw = (await tasks.call("listTasks", workspacePath ? { workspacePath } : {})) as
          TaskMeta[] | { tasks?: TaskMeta[] } | null;
        const metas = Array.isArray(raw) ? raw : (raw?.tasks ?? []);
        return {
          sessions: metas.map((t) => ({
            sessionId: t.taskId,
            workspace: { workspacePath: t.workspacePath },
            title: t.title,
            updatedAt: t.updatedAt,
          })),
        };
      }
      default:
        throw new Error(`method ${method} is not supported in zserver backend mode yet`);
    }
  }

  /** Subscribe conversation V4 + session events and translate into the
   *  app-server event dialect, delivering to per-session listeners. */
  private subscribeConversation(
    connection: ZServerConnection,
    workspacePath: string,
    sessionId: string,
  ): void {
    // One server-side subscription per session per connection; re-calling
    // (resume after heal) must not stack duplicate EventListen requests.
    if (this.subscribedSessions.has(sessionId)) return;
    this.subscribedSessions.add(sessionId);
    const agentChannel: ServiceChannel = connection.channelOf("zcode-agent");
    const deliver = (event: {
      type: ZcodeEvent["type"];
      payload?: Record<string, unknown>;
    }): void => {
      const seq = (this.seqBySession.get(sessionId) ?? 0) + 1;
      this.seqBySession.set(sessionId, seq);
      const zcodeEvent: ZcodeEvent = {
        sessionId,
        seq,
        type: event.type,
        payload: event.payload ?? {},
      };
      for (const listener of this.listeners.get(sessionId) ?? []) {
        try {
          listener.handleEvent(zcodeEvent);
        } catch (error) {
          warn(
            `backend: listener failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    };
    // Turn terminal outcome → turn.completed / turn.failed, gated on stream
    // quiescence: terminal and the V4 text frames travel on independent
    // channels, so completing on terminal alone truncates long replies.
    // Re-subscribing after a restart replaces any gate left by the dead
    // connection (its pending timer would emit spuriously into this one).
    this.gatesBySession.get(sessionId)?.dispose();
    this.unsubscribersBySession.delete(sessionId);
    const gate = new TurnCompletionGate((outcome) => {
      const type: ZcodeEvent["type"] = outcome === "failed" ? "turn.failed" : "turn.completed";
      const payload: Record<string, unknown> = { resultType: terminalResultType(outcome) };
      const error = this.terminalErrorBySession.get(sessionId);
      if (outcome === "failed" && error) payload["error"] = error;
      deliver({ type, payload });
    });
    this.gatesBySession.set(sessionId, gate);
    const unsubscribers: SessionTeardown = [];
    this.unsubscribersBySession.set(sessionId, unsubscribers);
    // One attempt-scoped rollback for every way this subscription can fail (the
    // subscribe call rejected, a listen was refused, registration threw). It only
    // acts while THIS attempt still owns the session's state: a failure that
    // arrives after close()/restart()/releaseSession — or after a newer attempt
    // took over — must not delete the newer attempt's marker (the next subscribe
    // would then stack a second listener set on the same connection).
    const rollback = (reason: string, error: Error): void => {
      if (this.unsubscribersBySession.get(sessionId) !== unsubscribers) return;
      // A failed subscription must not stay marked "subscribed": every later
      // subscribe/resume would be no-opped and the session would stay deaf.
      this.subscribedSessions.delete(sessionId);
      // Tear down what this attempt registered, or the NEXT subscribe stacks a
      // second set (frames delivered twice, a disposed gate re-arming into a
      // duplicate turn.completed).
      for (const unsubscribe of unsubscribers) unsubscribe();
      gate.dispose();
      if (this.gatesBySession.get(sessionId) === gate) this.gatesBySession.delete(sessionId);
      this.unsubscribersBySession.delete(sessionId);
      // A listen refusal can leave a subscription the server DID open (the
      // subscribe call succeeded): release it or it is owned until disconnect.
      unsubscribers.releaseServerSubscription?.();
      warn(`backend: ${reason}: ${error.message}`);
    };
    try {
      unsubscribers.push(
        connection.channelOf("zcode-task").listen(
          "onDynamicTaskTerminalOutcome",
          sessionId,
          (data) => {
            const record = data as { outcome?: string; error?: Record<string, unknown> } | null;
            if (typeof record?.outcome !== "string") return;
            // Carry the error dict through: turn.failed consumers read payload.error
            // for user-facing formatting and transient-retry classification.
            this.terminalErrorBySession.set(sessionId, record.error);
            gate.onTerminalOutcome(record.outcome);
          },
          (error) => rollback("terminal-outcome subscription refused", error),
        ),
      );
      // Session state notifications (settings changes) pass through unwrapped.
      unsubscribers.push(
        connection.listen(
          "onDynamicSessionEvent",
          { workspacePath, sessionId, deliveryKind: "live" },
          (data) => {
            const notification = (data as { notification?: Record<string, unknown> } | null)
              ?.notification;
            if (!notification) return;
            gate.onStreamActivity();
            deliver({ type: "state.updated", payload: notification });
          },
          (error) => rollback("session-event subscription refused", error),
        ),
      );
      // Conversation rows → turn lifecycle + text deltas. The listener MUST be
      // registered BEFORE the subscribe call: the server-side subscription goes
      // live at the ack, and frames fired between the ack and a later
      // EventListen would be routed to a handler that does not exist yet.
      unsubscribers.push(
        connection.listen(
          "onDynamicConversationFrame",
          { workspacePath, sessionId },
          (data) => {
            // The server's frame emitter is WORKSPACE-scoped (keyed by
            // resolveWorkspaceKey) — this listener receives frames for EVERY session
            // in the workspace, distinguished only by frame.topic. Foreign frames
            // must be dropped before the gate too (another session's traffic must
            // not re-arm this session's completion quiescence).
            if (!frameMatchesSession(data, sessionId)) return;
            gate.onStreamActivity();
            if (!shouldTranslateFrame(data)) return;
            const deltas =
              (data as { frame?: { payload?: { deltas?: Array<Record<string, unknown>> } } })?.frame
                ?.payload?.deltas ?? [];
            for (const delta of deltas) {
              translateConversationDelta(delta, sessionId, this.emittedByRow, (event) =>
                deliver(event),
              );
            }
          },
          (error) => rollback("conversation-frame subscription refused", error),
        ),
      );
    } catch (error) {
      // listen() throws when the client was disposed under us (close() raced
      // this route): leave no marker/gate behind, and let the request fail.
      rollback(
        "subscription setup failed",
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
    // The server OWNS the V4 conversation subscription until
    // unsubscribeConversationV4 names its subscriptionId — an EventDispose (103)
    // on the frame listener only stops OUR delivery (verified on the real
    // server: the subscription stays owned). Keep the id from the ack so
    // release/rollback can free it.
    let serverSubscriptionId: string | null = null;
    let settled = false;
    let wantsRelease = false;
    const unsubscribeOnServer = (): void => {
      if (serverSubscriptionId === null) return;
      const subscriptionId = serverSubscriptionId;
      serverSubscriptionId = null;
      // Fire-and-forget on the LIVE connection; a dead one already dropped it.
      if (this.connection !== connection) return;
      connection
        .channelOf("zcode-agent")
        .call("unsubscribeConversationV4", { workspacePath, sessionId, subscriptionId })
        .catch((error: Error) =>
          warn(`backend: unsubscribeConversationV4 failed for ${sessionId}: ${error.message}`),
        );
    };
    unsubscribers.releaseServerSubscription = () => {
      if (!settled) {
        // The subscribe call is still in flight: free it the moment its ack lands.
        wantsRelease = true;
        return;
      }
      unsubscribeOnServer();
    };
    agentChannel
      .call("subscribeConversationV4", {
        workspacePath,
        sessionId,
        clientMode: "desktop-continuous",
      })
      .then((ack) => {
        settled = true;
        const id = (ack as { ack?: { subscriptionId?: unknown } } | null)?.ack?.subscriptionId;
        serverSubscriptionId = typeof id === "string" ? id : null;
        if (wantsRelease) unsubscribeOnServer();
      })
      .catch((error: Error) => {
        settled = true;
        rollback("conversation subscribe failed", error);
      });
  }

  /**
   * Release a retired session's LIVE state: the three event listeners (103
   * EventDispose), the server-side V4 conversation subscription
   * (unsubscribeConversationV4 with the subscriptionId from the subscribe ack —
   * the 103s alone do NOT free it, verified on the real server), the completion
   * gate and the per-row streaming counters. Without it every session ever
   * touched stayed subscribed for the bridge's life.
   *
   * Deliberately KEPT, because retirement is not deletion (a session the editor
   * touches again must come back intact and re-subscribe lazily):
   *  - `workspaceBySession`: session/send|read|subscribe carry only a sessionId;
   *    this mapping is the only way to address the session again.
   *  - `listeners`: owned by the handlers (turn loop, background-task listener),
   *    which register once and never re-register.
   *  - `seqBySession`: a listener's high-water mark must not see seq go back.
   * Idempotent.
   */
  releaseSession(sessionId: string): void {
    const teardown = this.unsubscribersBySession.get(sessionId);
    for (const unsubscribe of teardown ?? []) {
      try {
        unsubscribe();
      } catch (error) {
        warn(
          `backend: unsubscribe failed for ${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    // The 103s above only stop OUR event delivery. The server keeps the V4
    // conversation subscription owned until unsubscribeConversationV4 names it.
    teardown?.releaseServerSubscription?.();
    this.unsubscribersBySession.delete(sessionId);
    this.gatesBySession.get(sessionId)?.dispose();
    this.gatesBySession.delete(sessionId);
    this.subscribedSessions.delete(sessionId);
    this.terminalErrorBySession.delete(sessionId);
    // Row keys are namespaced `${sessionId}:${rowId}` (rowIds are per-session
    // log positions and would otherwise collide across sessions).
    for (const key of [...this.emittedByRow.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.emittedByRow.delete(key);
    }
  }

  send(method: string, params: Record<string, unknown>): void {
    void this.request(0, method, params).then((response) => {
      if (response.error) {
        warn(`backend: send(${method}) failed: ${response.error.message}`);
      }
    });
  }

  registerEventListener(sessionId: string, listener: EventListenerLike): void {
    const set = this.listeners.get(sessionId) ?? new Set();
    set.add(listener);
    this.listeners.set(sessionId, set);
  }

  unregisterEventListener(sessionId: string, listener: EventListenerLike): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    set.delete(listener);
    // Drop the empty set (mirrors ZcodeBackend): stale empty sets keep
    // listeners.size > 0 forever, which permanently disarms idle recycling.
    if (set.size === 0) this.listeners.delete(sessionId);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.spawnGeneration++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Completion gates hold live timers that deliver turn.completed into
    // `listeners`: one left armed across a close/heal would end the very turn
    // the heal is about to resend. Their subscriptions die with the connection.
    for (const gate of this.gatesBySession.values()) gate.dispose();
    this.gatesBySession.clear();
    this.unsubscribersBySession.clear();
    this.connection?.dispose();
    this.connection = null;
    this.spawnPromise = null;
  }

  /** Supervised heal path: respawn the server connection in place. Never
   *  throws — a transient respawn failure stays visible via the next
   *  request's error (driving the next heal round). The instance is kept:
   *  server.ts ensureBackend() honours `healsInPlace`, so the dead marker left
   *  by a failed respawn does not get this backend replaced (which would
   *  orphan every listener registered on it). */
  async restart(_reason: string): Promise<void> {
    await this.close();
    try {
      await this.ensureConnection();
    } catch (error) {
      warn(
        `backend: zserver respawn failed after restart (${
          error instanceof Error ? error.message : String(error)
        }) — next request retries`,
      );
    }
  }
}
/**
 * Terminal outcome → translator resultType. "cancelled" is a literal the
 * bridge keys on (turnResultType === "cancelled") for cancellation semantics —
 * collapsing it into "success" misreports user cancels as clean completions.
 */
export function terminalResultType(outcome: string): string {
  if (outcome === "failed") return "error";
  if (outcome === "cancelled") return "cancelled";
  return "success";
}

/**
 * Bridge session/create params → inner createSession params. The bridge sends
 * mode:"yolo" (full-auto assumption) and optional editor MCP servers — both
 * are valid createSession fields and MUST be forwarded: dropping the mode
 * silently changes permission behaviour, dropping mcpServers silently loses
 * editor-configured servers.
 */
export function buildCreateSessionParams(
  params: Record<string, unknown>,
  workspacePath: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { workspacePath, persistence: "immediate" };
  if (typeof params["mode"] === "string") out.mode = params["mode"];
  if (Array.isArray(params["mcpServers"]) && params["mcpServers"].length > 0) {
    out.mcpServers = params["mcpServers"];
  }
  return out;
}

/**
 * Session gate for workspace-scoped frame streams: the server keys frame
 * emitters by workspace, so a per-session listener sees every session's
 * frames — only the frame topic ("conversation/<sessionId>") identifies the
 * owning session. Without this filter, one session's text/turn rows bleed
 * into another session's listeners.
 */
export function frameMatchesSession(data: unknown, sessionId: string): boolean {
  const topic = (data as { frame?: { topic?: string } } | null)?.frame?.topic;
  return topic === `conversation/${sessionId}`;
}

/**
 * History gate: the V4 subscription's FIRST frame (deliveryKind "initial")
 * replays the session's full log — rows for every past turn. Translating it
 * would re-emit history assistantText as live model.streaming (duplicated
 * text in the editor after every resume/heal). The bridge rebuilds history
 * from the readSession snapshot instead, so only online frames translate.
 */
export function shouldTranslateFrame(data: unknown): boolean {
  return (data as { deliveryKind?: string } | null)?.deliveryKind !== "initial";
}

/**
 * Pure translation of one conversation delta into app-server event dialect.
 * `emittedByRow` tracks per-row emitted text length so full-row upserts only
 * emit the new suffix as model.streaming text deltas.
 */
export function translateConversationDelta(
  delta: Record<string, unknown>,
  scope: string,
  emittedByRow: Map<string, number>,
  deliver: (event: { type: ZcodeEvent["type"]; payload?: Record<string, unknown> }) => void,
): void {
  const op = delta["op"] as string;
  const row = (delta["row"] ?? {}) as Record<string, unknown>;
  // Namespace by scope (sessionId): bare rowIds are per-session log positions
  // and collide across sessions sharing one backend.
  const rowKey = `${scope}:${String(row["rowId"] ?? delta["rowId"] ?? "")}`;
  if (op === "row.appended" && row["kind"] === "turnHeader") {
    deliver({ type: "turn.started", payload: {} });
    return;
  }
  if (op === "row.delta" && rowKey !== `${scope}:`) {
    const chunk = (delta["delta"] ?? delta["textDelta"] ?? delta["text"]) as string | undefined;
    if (typeof chunk === "string" && chunk.length > 0) {
      deliver({ type: "model.streaming", payload: { kind: "text_delta", delta: chunk } });
    }
    return;
  }
  if ((op === "row.upserted" || op === "row.appended") && row["kind"] === "assistantText") {
    const text = (row["text"] as string) ?? "";
    const emitted = emittedByRow.get(rowKey) ?? 0;
    if (text.length > emitted) {
      deliver({
        type: "model.streaming",
        payload: { kind: "text_delta", delta: text.slice(emitted) },
      });
      emittedByRow.set(rowKey, text.length);
    }
  }
}
/** Teardown handles for one session's subscription attempt: the local listener
 *  unsubscribers, plus the hook that releases the SERVER-side V4 subscription. */
type SessionTeardown = Array<() => void> & { releaseServerSubscription?: () => void };

/** The task-meta fields session/list consumers read (the server sends more). */
interface TaskMeta {
  taskId?: string;
  workspacePath?: string;
  title?: string;
  updatedAt?: number;
}

class RequestTimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "RequestTimeoutError";
  }
}

export interface ScheduledHandle {
  cancel(): void;
}

function defaultSchedule(fn: () => void, ms: number): ScheduledHandle {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

/**
 * Quiescence gate for turn completion (ADR-0008): the terminal outcome arrives
 * on the zcode-task channel while reply text streams over the V4 conversation
 * subscription — two channels with no ordering guarantee between them.
 * Emitting completion on terminal arrival alone truncates replies (turn loop
 * exits while tail frames are in flight). The gate waits for the stream to go
 * quiet for `graceMs` after a terminal outcome before emitting; any frame or
 * session event re-arms the timer. If no frames follow at all (short or
 * already-flushed turns), completion lands one grace period after terminal.
 */
export class TurnCompletionGate {
  private pendingOutcome: string | null = null;
  private generation = 0;
  private timer: ScheduledHandle | null = null;

  constructor(
    private readonly emit: (outcome: string) => void,
    private readonly graceMs: number = Number(process.env.ZCODE_ACP_ZSERVER_TURN_QUIESCE_MS ?? 0) ||
      300,
    private readonly schedule: (fn: () => void, ms: number) => ScheduledHandle = defaultSchedule,
  ) {}

  /** Any conversation frame or session event: the stream is still alive. */
  onStreamActivity(): void {
    if (this.pendingOutcome === null || this.timer === null) {
      return;
    }
    this.arm(this.generation);
  }

  onTerminalOutcome(outcome: string): void {
    if (this.disposed) return; // a disposed gate must never re-arm and emit
    this.pendingOutcome = outcome;
    this.arm(++this.generation);
  }

  private disposed = false;

  dispose(): void {
    this.disposed = true;
    this.timer?.cancel();
    this.timer = null;
    this.pendingOutcome = null;
  }

  private arm(generation: number): void {
    this.timer?.cancel();
    const outcome = this.pendingOutcome;
    if (outcome === null) return;
    this.timer = this.schedule(() => {
      if (generation !== this.generation || this.pendingOutcome !== outcome) return;
      this.pendingOutcome = null;
      this.timer = null;
      this.emit(outcome);
    }, this.graceMs);
  }
}
