import type { BridgeBackend, ZcodeEvent, ZcodeResponse } from "../types.js";
import { loadDesktopChildEnvWithRefresh } from "../../desktop-profile.js";
import { warn } from "../../utils.js";
import type { EventListenerLike } from "../types.js";
import { ServiceChannel, ZServerConnection } from "./index.js";

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
export async function runtimeEnvWithProfile(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  try {
    const pins = loadDesktopChildEnvWithRefresh();
    return { ...base, ...pins };
  } catch {
    return base;
  }
}

export class ZServerBackend implements BridgeBackend {
  isDead = false;
  deathReason: string | null = null;

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
  private spawnPromise: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Idle ms before the server child is shut down (0 = keep forever). */
  private readonly idleMs = Number(process.env.ZCODE_ACP_ZSERVER_IDLE_MS ?? 0) || 0;

  constructor(
    private readonly options: ZServerBackendOptions = {},
    private readonly clientId = `zcode-acp-zserver-${process.pid}`,
  ) {}

  private async ensureConnection(): Promise<ZServerConnection> {
    if (this.connection) return this.connection;
    if (!this.spawnPromise) {
      this.spawnPromise = this.spawn();
    }
    await this.spawnPromise;
    return this.connection!;
  }

  private async spawn(): Promise<void> {
    const socketPath = process.env.ZCODE_ACP_ZSERVER_SOCKET;
    let connection: ZServerConnection | null = null;
    if (socketPath) {
      try {
        connection = await ZServerConnection.attach({ socketPath, clientId: this.clientId });
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
    this.connection = connection;
    this.isDead = false;
    this.deathReason = null;
    // Server-side subscriptions died with the previous connection (spawn
    // mode: new server child; attach mode: possibly respawned shared server).
    // Re-establish lazily via session/resume on the heal path.
    this.subscribedSessions.clear();
    this.emittedByRow.clear();
    connection.onExit((code, signal) => {
      this.isDead = true;
      // Message carries the canonical "backend reader exited" marker so the
      // supervision classifiers (isBackendDeadMessage) recognize zserver-mode
      // deaths and the heal path fires exactly as for the direct backend.
      this.deathReason =
        "zcode backend reader exited (backend dead): " +
        `zcode server exited (code=${code ?? "null"} signal=${signal ?? "null"})`;
      warn(`backend: ${this.deathReason}`);
    });
    this.armIdleTimer();
    // Forwarded runtime-preferences requests (desktop-attached-remote
    // authority): answer with the server's own local-mode defaults so
    // session/create completes. No-op under local authority (never fires).
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
      if (this.listeners.size > 0) {
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
    _timeoutMs = 15000,
  ): Promise<ZcodeResponse> {
    this.armIdleTimer();
    try {
      const connection = await this.ensureConnection();
      const result = await this.route(connection, method, params);
      return { id, result: result as Record<string, unknown> };
    } catch (error) {
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
    }
  }

  private async route(
    connection: ZServerConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const workspace = (params["workspace"] ?? {}) as {
      workspacePath?: string;
      workspaceKey?: string;
    };
    const workspacePath = workspace.workspacePath ?? (workspace.workspaceKey as string) ?? "";
    const sessionId = (params["sessionId"] as string) ?? "";
    const agentChannel = connection.channelOf("zcode-agent");
    const tasks = connection.channelOf("zcode-task");
    switch (method) {
      case "session/create": {
        if (!workspacePath) throw new Error("session/create requires workspace.workspacePath");
        const snapshot = (await agentChannel.call("createSession", {
          workspacePath,
          persistence: "immediate",
        })) as { session?: { sessionId?: string } };
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
        const result = await agentChannel.call("readSession", { workspacePath: target, sessionId });
        // The heal path resumes after a backend restart; server-side
        // subscriptions died with the old connection — re-establish them so
        // the turn loop sees events again (idempotent via subscribedSessions).
        this.subscribeConversation(connection, target, sessionId);
        return result;
      }
      case "session/list": {
        const metas = (await tasks.call("listTasks", {})) as {
          tasks?: Array<{ taskId?: string; workspacePath?: string; title?: string }>;
        };
        return {
          sessions: (metas?.tasks ?? []).map((t) => ({
            sessionId: t.taskId,
            workspace: { workspacePath: t.workspacePath },
            title: t.title,
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
    const gate = new TurnCompletionGate((outcome) => {
      const type: ZcodeEvent["type"] = outcome === "failed" ? "turn.failed" : "turn.completed";
      deliver({
        type,
        payload: { resultType: outcome === "failed" ? "error" : "success" },
      });
    });
    this.gatesBySession.set(sessionId, gate);
    connection.channelOf("zcode-task").listen("onDynamicTaskTerminalOutcome", sessionId, (data) => {
      const outcome = (data as { outcome?: string } | null)?.outcome;
      if (typeof outcome === "string") gate.onTerminalOutcome(outcome);
    });
    // Session state notifications (settings changes) pass through unwrapped.
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
    );
    // Conversation rows → turn lifecycle + text deltas.
    agentChannel
      .call("subscribeConversationV4", {
        workspacePath,
        sessionId,
        clientMode: "desktop-continuous",
      })
      .then(() => {
        connection.listen("onDynamicConversationFrame", { workspacePath, sessionId }, (data) => {
          gate.onStreamActivity();
          const deltas =
            (data as { frame?: { payload?: { deltas?: Array<Record<string, unknown>> } } })?.frame
              ?.payload?.deltas ?? [];
          for (const delta of deltas) {
            translateConversationDelta(delta, sessionId, this.emittedByRow, (event) =>
              deliver(event),
            );
          }
        });
      })
      .catch((error) => warn(`backend: conversation subscribe failed: ${error.message}`));
  }

  send(method: string, params: Record<string, unknown>): void {
    void this.request(0, method, params).catch(() => undefined);
  }

  registerEventListener(sessionId: string, listener: EventListenerLike): void {
    const set = this.listeners.get(sessionId) ?? new Set();
    set.add(listener);
    this.listeners.set(sessionId, set);
  }

  unregisterEventListener(sessionId: string, listener: EventListenerLike): void {
    this.listeners.get(sessionId)?.delete(listener);
  }

  /** Drop per-session streaming state (called on session close/eviction). */
  forgetSession(sessionId: string): void {
    this.listeners.delete(sessionId);
    this.gatesBySession.get(sessionId)?.dispose();
    this.gatesBySession.delete(sessionId);
    // Row keys are namespaced `${sessionId}:${rowId}` (rowIds are per-session
    // log positions and would otherwise collide across sessions).
    for (const key of [...this.emittedByRow.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.emittedByRow.delete(key);
    }
  }

  async close(): Promise<void> {
    this.connection?.dispose();
    this.connection = null;
    this.spawnPromise = null;
  }

  /** Supervised heal path: respawn the server connection in place. */
  async restart(_reason: string): Promise<void> {
    await this.close();
    await this.ensureConnection();
  }
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
    this.pendingOutcome = outcome;
    this.arm(++this.generation);
  }

  dispose(): void {
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
