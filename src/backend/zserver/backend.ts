import type { BridgeBackend, ZcodeEvent, ZcodeResponse } from "../types.js";
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
  private spawnPromise: Promise<void> | null = null;

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
    const connection = await ZServerConnection.spawn({
      serverRoot: this.options.serverRoot,
      clientId: this.clientId,
    });
    this.connection = connection;
    this.isDead = false;
    this.deathReason = null;
    connection.onExit((code, signal) => {
      this.isDead = true;
      this.deathReason = `zcode server exited (code=${code ?? "null"} signal=${signal ?? "null"})`;
      // Reject in-flight work visibly; the supervision path classifies it.
      warn(`backend: ${this.deathReason}`);
    });
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

  /** app-server JSON-RPC surface emulation. Resolves {result} or {error}. */
  async request(
    id: number,
    method: string,
    params: Record<string, unknown> = {},
    _timeoutMs = 15000,
  ): Promise<ZcodeResponse> {
    try {
      const connection = await this.ensureConnection();
      const result = await this.route(connection, method, params);
      return { id, result: result as Record<string, unknown> };
    } catch (error) {
      return { id, error: { message: error instanceof Error ? error.message : String(error) } };
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
        return await agentChannel.call("readSession", { workspacePath: target, sessionId });
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
    // Turn terminal outcome → turn.completed / turn.failed.
    connection.channelOf("zcode-task").listen("onDynamicTaskTerminalOutcome", sessionId, (data) => {
      const outcome = (data as { outcome?: string } | null)?.outcome;
      const type: ZcodeEvent["type"] = outcome === "failed" ? "turn.failed" : "turn.completed";
      deliver({
        type,
        payload: { resultType: outcome === "failed" ? "error" : "success" },
      });
    });
    // Session state notifications (settings changes) pass through unwrapped.
    connection.listen(
      "onDynamicSessionEvent",
      { workspacePath, sessionId, deliveryKind: "live" },
      (data) => {
        const notification = (data as { notification?: Record<string, unknown> } | null)
          ?.notification;
        if (!notification) return;
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
          const deltas =
            (data as { frame?: { payload?: { deltas?: Array<Record<string, unknown>> } } })?.frame
              ?.payload?.deltas ?? [];
          for (const delta of deltas) {
            translateConversationDelta(delta, this.emittedByRow, (event) => deliver(event));
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
    for (const rowId of [...this.emittedByRow.keys()]) {
      if (rowId.includes(sessionId)) this.emittedByRow.delete(rowId);
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
  emittedByRow: Map<string, number>,
  deliver: (event: { type: ZcodeEvent["type"]; payload?: Record<string, unknown> }) => void,
): void {
  const op = delta["op"] as string;
  const row = (delta["row"] ?? {}) as Record<string, unknown>;
  const rowId = String(row["rowId"] ?? delta["rowId"] ?? "");
  if (op === "row.appended" && row["kind"] === "turnHeader") {
    deliver({ type: "turn.started", payload: {} });
    return;
  }
  if (op === "row.delta" && rowId) {
    const chunk = (delta["delta"] ?? delta["textDelta"] ?? delta["text"]) as string | undefined;
    if (typeof chunk === "string" && chunk.length > 0) {
      deliver({ type: "model.streaming", payload: { kind: "text_delta", delta: chunk } });
    }
    return;
  }
  if ((op === "row.upserted" || op === "row.appended") && row["kind"] === "assistantText") {
    const text = (row["text"] as string) ?? "";
    const emitted = emittedByRow.get(rowId) ?? 0;
    if (text.length > emitted) {
      deliver({
        type: "model.streaming",
        payload: { kind: "text_delta", delta: text.slice(emitted) },
      });
      emittedByRow.set(rowId, text.length);
    }
  }
}
