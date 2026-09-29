import {
  type DecodedMessage,
  encodeMessage,
  type RequestType,
  type ResponseType,
} from "./protocol.js";

export type Sender = (payload: Buffer) => void;

export interface RpcError extends Error {
  code?: unknown;
  kind?: unknown;
  status?: unknown;
  retryAfterMs?: unknown;
  data?: unknown;
  detail?: unknown;
  details?: unknown;
  taskId?: unknown;
  traceId?: unknown;
}

interface ResponseSink {
  (response: { type: ResponseType; id?: number; data?: unknown }): void;
}

const ERROR_PASSTHROUGH_KEYS = [
  "code",
  "kind",
  "status",
  "retryAfterMs",
  "data",
  "detail",
  "details",
  "taskId",
  "traceId",
] as const;

/**
 * Client half of the zcode channel protocol — semantics ported from the
 * open-source `ChannelClient` (packages/rpc), no code vendored. Requests queue
 * until the server's Initialize frame arrives; promise requests and event
 * subscriptions share the id space and both fail closed on dispose.
 */
export class ChannelClient {
  private initialized = false;
  private disposed = false;
  private lastRequestId = 0;
  private readonly handlers = new Map<number, ResponseSink>();
  private readonly pendingRejections = new Map<number, (error: Error) => void>();
  private readonly queued: Array<() => void> = [];
  private readonly eventListeners = new Map<number, (data: unknown) => void>();
  private initializeWaiters: Array<() => void> = [];

  constructor(private readonly send: Sender) {}

  /** Feed one decoded RPC message (a Regular-frame payload). */
  onMessage(message: DecodedMessage): void {
    if (this.disposed || !Array.isArray(message.header)) {
      return;
    }
    const [type, id] = message.header as [ResponseType, number?];
    if (type === (200 as ResponseType)) {
      this.initialized = true;
      for (const run of this.queued.splice(0)) {
        run();
      }
      for (const waiter of this.initializeWaiters.splice(0)) {
        waiter();
      }
      return;
    }
    const handler = id === undefined ? undefined : this.handlers.get(id);
    handler?.({ type, id, data: message.body });
  }

  /** Resolves once the server's Initialize frame has been processed. */
  whenInitialized(): Promise<void> {
    if (this.initialized) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.initializeWaiters.push(resolve);
    });
  }

  /**
   * Invoke `method` on `channelName`. `args` are positional — the server
   * adapter spreads them onto the service method (`handler[command](...args)`).
   */
  call(channelName: string, method: string, args: unknown[] = []): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(disposedError());
    }
    return new Promise((resolve, reject) => {
      const id = this.lastRequestId++;
      this.pendingRejections.set(id, reject);
      const run = () => {
        if (this.disposed || !this.pendingRejections.has(id)) {
          return;
        }
        this.handlers.set(id, (response) => {
          switch (response.type) {
            case 201: {
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              resolve(response.data);
              return;
            }
            case 202: {
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              reject(toRpcError(response.data));
              return;
            }
            case 203: {
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              reject(
                response.data instanceof Error ? response.data : new Error(String(response.data)),
              );
              return;
            }
          }
        });
        this.sendRequest(100 as RequestType, id, channelName, method, args);
      };
      if (this.initialized) {
        run();
      } else {
        this.queued.push(run);
      }
    });
  }

  /**
   * Subscribe to event `name` on `channelName`. Dynamic events (`onDynamic*`)
   * receive `arg` when the server invokes the event factory; static events
   * ignore it. The subscription request is sent on first listener attach and
   * disposed on last detach (mirrors the upstream Emitter ref-counting so
   * repeated subscribe/unsubscribe cycles re-arm server-side).
   */
  listen(
    channelName: string,
    name: string,
    arg: unknown,
    onFire: (data: unknown) => void,
  ): () => void {
    if (this.disposed) {
      throw disposedError();
    }
    const id = this.lastRequestId++;
    let attached = false;
    // Unsubscribe before the queued attach ran must cancel it, or the
    // subscription arms after the caller believes it is gone (leak).
    let cancelled = false;
    const attach = () => {
      if (this.disposed || attached || cancelled) {
        return;
      }
      attached = true;
      this.handlers.set(id, (response) => {
        if (response.type === 204) {
          onFire(response.data);
        }
      });
      this.eventListeners.set(id, onFire);
      this.sendRequest(102 as RequestType, id, channelName, name, arg);
    };
    if (this.initialized) {
      attach();
    } else {
      this.queued.push(attach);
    }
    return () => {
      if (!attached) {
        cancelled = true;
        return;
      }
      attached = false;
      this.handlers.delete(id);
      this.eventListeners.delete(id);
      this.sendRaw(encodeMessage([103 as RequestType, id], undefined));
    };
  }

  cancel(id: number): void {
    if (!this.pendingRejections.has(id)) {
      return;
    }
    this.sendRaw(encodeMessage([101 as RequestType, id], undefined));
    this.handlers.delete(id);
    this.pendingRejections.delete(id);
  }

  dispose(reason?: Error): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const rejection = reason ?? disposedError();
    for (const [id, reject] of [...this.pendingRejections]) {
      this.handlers.delete(id);
      reject(rejection);
      this.pendingRejections.delete(id);
    }
    this.handlers.clear();
    this.eventListeners.clear();
    this.queued.length = 0;
    this.initializeWaiters.length = 0;
  }

  private sendRequest(
    type: RequestType,
    id: number,
    channelName: string,
    name: string,
    arg: unknown,
  ): void {
    this.sendRaw(encodeMessage([type, id, channelName, name], arg));
  }

  private sendRaw(payload: Buffer): void {
    if (!this.disposed) {
      this.send(payload);
    }
  }
}

function disposedError(): Error {
  const error = new Error("zcode server channel client disposed");
  error.name = "ConnectionClosed";
  return error;
}

function toRpcError(data: unknown): RpcError {
  const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const error = new Error(String(record.message ?? "zcode server rpc error")) as RpcError;
  if (typeof record.name === "string") {
    error.name = record.name;
  }
  if (Array.isArray(record.stack)) {
    error.stack = record.stack.join("\n");
  }
  for (const key of ERROR_PASSTHROUGH_KEYS) {
    if (record[key] !== undefined) {
      error[key] = record[key];
    }
  }
  return error;
}

/**
 * Convenience facade: one service channel (e.g. "zcode-task", "zcode-agent")
 * over a shared ChannelClient. The client multiplexes all channels on the
 * same id space — channelName just rides in each request header.
 */
export class ServiceChannel {
  constructor(
    private readonly client: ChannelClient,
    private readonly channelName: string,
  ) {}

  call(method: string, ...args: unknown[]): Promise<unknown> {
    return this.client.call(this.channelName, method, args);
  }

  listen(event: string, arg: unknown, onFire: (data: unknown) => void): () => void {
    return this.client.listen(this.channelName, event, arg, onFire);
  }
}
