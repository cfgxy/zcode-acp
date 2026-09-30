import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeBackend } from "../src/backend/types.js";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

import {
  translateConversationDelta,
  TurnCompletionGate,
  ZServerBackend,
} from "../src/backend/zserver/backend.js";

/** Collect translated events for assertion. */
function collect() {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  return {
    events,
    deliver: (e: { type: string; payload?: Record<string, unknown> }) => events.push(e),
  };
}

describe("translateConversationDelta", () => {
  it("maps turnHeader row.appended to turn.started", () => {
    const { events, deliver } = collect();
    translateConversationDelta(
      { op: "row.appended", row: { rowId: "1", kind: "turnHeader", state: "running" } },
      "sess-x",
      new Map(),
      deliver,
    );
    expect(events).toEqual([{ type: "turn.started", payload: {} }]);
  });

  it("emits assistantText row.upserted as an incremental text delta", () => {
    const emitted = new Map<string, number>();
    const { events, deliver } = collect();
    const row = { rowId: "r3", kind: "assistantText", text: "hello" };
    translateConversationDelta({ op: "row.upserted", row }, "sess-x", emitted, deliver);
    translateConversationDelta(
      { op: "row.upserted", row: { ...row, text: "hello world" } },
      "sess-x",
      emitted,
      deliver,
    );
    translateConversationDelta({ op: "row.upserted", row }, "sess-x", emitted, deliver);
    expect(events).toEqual([
      { type: "model.streaming", payload: { kind: "text_delta", delta: "hello" } },
      { type: "model.streaming", payload: { kind: "text_delta", delta: " world" } },
    ]);
  });

  it("maps row.delta streaming suffixes to text deltas", () => {
    const { events, deliver } = collect();
    translateConversationDelta(
      { op: "row.delta", rowId: "r9", delta: "he" },
      "sess-x",
      new Map(),
      deliver,
    );
    translateConversationDelta(
      { op: "row.delta", rowId: "r9", textDelta: "llo" },
      "sess-x",
      new Map(),
      deliver,
    );
    expect(events).toEqual([
      { type: "model.streaming", payload: { kind: "text_delta", delta: "he" } },
      { type: "model.streaming", payload: { kind: "text_delta", delta: "llo" } },
    ]);
  });

  it("ignores non-assistant rows and empty deltas", () => {
    const { events, deliver } = collect();
    translateConversationDelta(
      { op: "row.appended", row: { rowId: "2", kind: "userInput", text: "hi" } },
      new Map(),
      deliver,
    );
    translateConversationDelta(
      { op: "row.delta", rowId: "r1", delta: "" },
      "sess-x",
      new Map(),
      deliver,
    );
    expect(events).toEqual([]);
  });
});

describe("ZServerBackend", () => {
  it("satisfies the BridgeBackend surface structurally", () => {
    const backend = new ZServerBackend();
    const asInterface: BridgeBackend = backend;
    expect(typeof asInterface.request).toBe("function");
    expect(typeof asInterface.send).toBe("function");
    expect(typeof asInterface.registerEventListener).toBe("function");
    expect(typeof asInterface.unregisterEventListener).toBe("function");
    expect(asInterface.isDead).toBe(false);
    expect(asInterface.deathReason).toBeNull();
  });

  it("routes unknown methods to a visible unsupported error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-unsupported-"));
    tempDirs.push(root);
    fs.copyFileSync(
      new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
      path.join(root, "zcode-server.cjs"),
    );
    const backend = new ZServerBackend({ serverRoot: root });
    try {
      const response = await backend.request(1, "session/fork", {});
      expect(response.error?.message).toContain("not supported in zserver backend mode");
    } finally {
      await backend.close();
    }
  });
});

describe("TurnCompletionGate (quiescence completion)", () => {
  it("emits completion one grace after terminal when the stream is quiet", () => {
    vi.useFakeTimers();
    try {
      const outcomes: string[] = [];
      const gate = new TurnCompletionGate((o) => outcomes.push(o), 300);
      gate.onTerminalOutcome("succeeded");
      expect(outcomes).toEqual([]); // not immediate — frames may still be in flight
      vi.advanceTimersByTime(299);
      expect(outcomes).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(outcomes).toEqual(["succeeded"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms on stream activity so late text frames land before completion", () => {
    vi.useFakeTimers();
    try {
      const outcomes: string[] = [];
      const gate = new TurnCompletionGate((o) => outcomes.push(o), 300);
      gate.onTerminalOutcome("succeeded");
      vi.advanceTimersByTime(200);
      gate.onStreamActivity(); // late V4 frame: reply tail still streaming
      vi.advanceTimersByTime(200); // 400ms since terminal, 200ms since activity
      expect(outcomes).toEqual([]);
      vi.advanceTimersByTime(100); // grace elapsed since LAST activity
      expect(outcomes).toEqual(["succeeded"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose cancels the pending emission (session close / reconnect)", () => {
    vi.useFakeTimers();
    try {
      const outcomes: string[] = [];
      const gate = new TurnCompletionGate((o) => outcomes.push(o), 300);
      gate.onTerminalOutcome("failed");
      gate.dispose();
      vi.advanceTimersByTime(1000);
      expect(outcomes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("translateConversationDelta scoped row keys", () => {
  it("keeps same rowId across two sessions independent (no watermark bleed)", () => {
    const emitted = new Map<string, number>();
    const eventsA: unknown[] = [];
    const eventsB: unknown[] = [];
    const row = { rowId: "3", kind: "assistantText", text: "hello" };
    translateConversationDelta({ op: "row.upserted", row }, "sess-a", emitted, (e) =>
      eventsA.push(e),
    );
    // Same rowId, other session, SHORTER text: must still emit in full —
    // with bare rowIds the shared watermark would swallow it.
    translateConversationDelta(
      { op: "row.upserted", row: { ...row, text: "hi" } },
      "sess-b",
      emitted,
      (e) => eventsB.push(e),
    );
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect((eventsB[0] as { payload: { delta: string } }).payload.delta).toBe("hi");
  });
});

describe("ZServerBackend broker fallback", () => {
  it("falls back to a direct spawn when the broker socket is dead", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-fallback-"));
    tempDirs.push(root);
    fs.copyFileSync(
      new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
      path.join(root, "zcode-server.cjs"),
    );
    process.env.ZCODE_ACP_ZSERVER_SOCKET = `/tmp/dead-broker-${Date.now()}.sock`;
    const backend = new ZServerBackend({ serverRoot: root });
    try {
      // Attach fails (ECONNREFUSED) → fallback spawns the fake server →
      // session/list routes through listTasks and resolves with sessions [].
      const response = await backend.request(1, "session/list", {});
      expect(response.error).toBeUndefined();
      expect((response.result as { sessions: unknown[] }).sessions).toEqual([]);
    } finally {
      delete process.env.ZCODE_ACP_ZSERVER_SOCKET;
      await backend.close();
    }
  });
});

describe("ZServerBackend request timeout", () => {
  it("surfaces a wedged server as the exact 'timeout' error (retry semantics)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-timeout-"));
    tempDirs.push(root);
    fs.copyFileSync(
      new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
      path.join(root, "zcode-server.cjs"),
    );
    process.env.ZSERVER_FAKE_HANG_METHODS = "listTasks";
    const backend = new ZServerBackend({ serverRoot: root });
    try {
      const startedAt = Date.now();
      const response = await backend.request(1, "session/list", {}, 500);
      expect(response.error?.message).toBe("timeout");
      expect(Date.now() - startedAt).toBeLessThan(2000);
    } finally {
      delete process.env.ZSERVER_FAKE_HANG_METHODS;
      await backend.close();
    }
  });
});

describe("zserver round-5 audit fixes", () => {
  it("a failed spawn marks the backend dead with the heal marker (not wedged)", async () => {
    const backend = new ZServerBackend({ serverRoot: "/nonexistent-zserver-root" });
    const response = await backend.request(1, "session/list", {});
    expect(response.error?.message).toContain("backend reader exited");
    expect(backend.isDead).toBe(true);
    // ensureBackend-level retryability: the rejected spawn promise is not cached.
    const second = await backend.request(2, "session/list", {});
    expect(second.error?.message).toContain("backend reader exited");
  });
});

describe("buildCreateSessionParams (bridge param fidelity)", () => {
  it("forwards mode and editor MCP servers, not just the workspace", async () => {
    const { buildCreateSessionParams } = await import("../src/backend/zserver/backend.js");
    const params = buildCreateSessionParams(
      {
        workspace: { workspacePath: "/w" },
        mode: "yolo",
        mcpServers: [{ name: "editor-mcp", command: "npx" }],
      },
      "/w",
    );
    expect(params).toEqual({
      workspacePath: "/w",
      persistence: "immediate",
      mode: "yolo",
      mcpServers: [{ name: "editor-mcp", command: "npx" }],
    });
    // Nothing to forward → stays minimal.
    expect(buildCreateSessionParams({ workspace: { workspacePath: "/w" } }, "/w")).toEqual({
      workspacePath: "/w",
      persistence: "immediate",
    });
  });
});

describe("terminalResultType (outcome fidelity)", () => {
  it("preserves cancelled and failed, normalizes the rest", async () => {
    const { terminalResultType } = await import("../src/backend/zserver/backend.js");
    expect(terminalResultType("succeeded")).toBe("success");
    expect(terminalResultType("cancelled")).toBe("cancelled");
    expect(terminalResultType("failed")).toBe("error");
  });
});

describe("frameMatchesSession (workspace-scoped stream filtering)", () => {
  it("accepts only the owning session's frames by topic", async () => {
    const { frameMatchesSession } = await import("../src/backend/zserver/backend.js");
    const frame = (sid: string): unknown => ({ frame: { topic: `conversation/${sid}` } });
    expect(frameMatchesSession(frame("sess-a"), "sess-a")).toBe(true);
    // Same workspace, other session — what the listener actually receives.
    expect(frameMatchesSession(frame("sess-b"), "sess-a")).toBe(false);
    expect(frameMatchesSession({}, "sess-a")).toBe(false);
  });
});

describe("multi-agent audit round fixes", () => {
  it("idle recycling does NOT mark the backend dead (death-poller suicide)", async () => {
    process.env.ZCODE_ACP_ZSERVER_IDLE_MS = "150";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-idle-"));
    tempDirs.push(root);
    fs.copyFileSync(
      new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
      path.join(root, "zcode-server.cjs"),
    );
    try {
      const backend = new ZServerBackend({ serverRoot: root });
      const first = await backend.request(1, "session/list", {});
      expect(first.error).toBeUndefined();
      await new Promise((r) => setTimeout(r, 500)); // idle fires + child exits
      expect(backend.isDead).toBe(false);
      // Lazy respawn: next request works again.
      const second = await backend.request(2, "session/list", {});
      expect(second.error).toBeUndefined();
      await backend.close();
    } finally {
      delete process.env.ZCODE_ACP_ZSERVER_IDLE_MS;
    }
  });

  it("session/resume records the workspace for later sessionId-only calls", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-resume-"));
    tempDirs.push(root);
    fs.copyFileSync(
      new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
      path.join(root, "zcode-server.cjs"),
    );
    const backend = new ZServerBackend({ serverRoot: root });
    try {
      // After a bridge restart the mapping is empty; resume carries workspace.
      const response = await backend.request(1, "session/resume", {
        sessionId: "sess-r1",
        workspace: { workspacePath: "/tmp/resumed-ws" },
      });
      expect(response.error).toBeUndefined();
      const mapping = (backend as unknown as { workspaceBySession: Map<string, string> })
        .workspaceBySession;
      expect(mapping.get("sess-r1")).toBe("/tmp/resumed-ws");
    } finally {
      await backend.close();
    }
  });
});

describe("zserver session/resume revive (persisted-but-inactive session)", () => {
  // The server keeps only sessions with a live resident; after a restart or
  // idle eviction the session exists solely on disk and readSession answers
  // "Session is not active" (-32004). Only the task channel's resumeTask
  // re-hydrates it (the desktop's own continue-task path).
  it("revives an evicted session via resumeTask and retries the read", async () => {
    process.env.ZSERVER_FAKE_EVICT_SESSIONS = "sess_evicted";
    const backend = new ZServerBackend({ serverRoot: makeFakeRoot() });
    try {
      const response = await backend.request(1, "session/resume", {
        sessionId: "sess_evicted",
        workspace: { workspacePath: "/tmp/evicted-ws" },
      });
      expect(response.error).toBeUndefined();
      // The fake server only clears the eviction on a resumeTask naming the
      // same taskId, so a success here proves the revive + read retry ran.
      // Result is the fake server's readSession echo.
      expect(String(response.result)).toContain("readSession");
      expect(String(response.result)).toContain("sess_evicted");
      expect(
        (backend as unknown as { workspaceBySession: Map<string, string> }).workspaceBySession.get(
          "sess_evicted",
        ),
      ).toBe("/tmp/evicted-ws");
    } finally {
      delete process.env.ZSERVER_FAKE_EVICT_SESSIONS;
      await backend.close();
    }
  });

  it("session/load revives through the same path (same route case)", async () => {
    process.env.ZSERVER_FAKE_EVICT_SESSIONS = "sess_load_evicted";
    const backend = new ZServerBackend({ serverRoot: makeFakeRoot() });
    try {
      const response = await backend.request(1, "session/load", {
        sessionId: "sess_load_evicted",
        workspace: { workspacePath: "/tmp/evicted-ws2" },
      });
      expect(response.error).toBeUndefined();
      expect(String(response.result)).toContain("readSession");
    } finally {
      delete process.env.ZSERVER_FAKE_EVICT_SESSIONS;
      await backend.close();
    }
  });

  it("propagates a failed revive instead of the original not-active error", async () => {
    // resumeTask fails (e.g. the session file is gone) → its error surfaces so
    // the upstream classifier sees the real cause ("Session not found" keeps
    // the zcode_session_lost classification); the stale "not active" read
    // error must not mask it.
    process.env.ZSERVER_FAKE_EVICT_SESSIONS = "sess_gone";
    process.env.ZSERVER_FAKE_FAIL_METHODS = "resumeTask";
    const backend = new ZServerBackend({ serverRoot: makeFakeRoot() });
    try {
      const response = await backend.request(1, "session/resume", {
        sessionId: "sess_gone",
        workspace: { workspacePath: "/tmp/gone-ws" },
      });
      expect(response.error?.message).toContain("scripted failure: resumeTask");
      expect(response.error?.message).not.toContain("Session is not active");
    } finally {
      delete process.env.ZSERVER_FAKE_EVICT_SESSIONS;
      delete process.env.ZSERVER_FAKE_FAIL_METHODS;
      await backend.close();
    }
  });
});

function makeFakeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zserver-int-"));
  tempDirs.push(root);
  fs.copyFileSync(
    new URL("./fixtures/zserver-fake-server.mjs", import.meta.url).pathname,
    path.join(root, "zcode-server.cjs"),
  );
  return root;
}

interface BackendInternals {
  subscribedSessions: Set<string>;
  gatesBySession: Map<string, unknown>;
  connection: { channelOf(n: string): { call(m: string, ...a: unknown[]): Promise<unknown> } };
}

describe("ZServerBackend session flow (real backend + scripted server)", () => {
  it("session/create wires the subscription and mode/mcp forwarding end-to-end", async () => {
    const backend = new ZServerBackend({ serverRoot: makeFakeRoot() });
    try {
      const created = await backend.request(1, "session/create", {
        workspace: { workspacePath: "/tmp/ws-int" },
        mode: "yolo",
      });
      expect(created.error).toBeUndefined();
      expect((created.result as { session: { sessionId: string } }).session.sessionId).toBe(
        "sess_fake_1",
      );
      const internals = backend as unknown as BackendInternals;
      expect(internals.subscribedSessions.has("sess_fake_1")).toBe(true);
      expect(internals.gatesBySession.has("sess_fake_1")).toBe(true);
    } finally {
      await backend.close();
    }
  });

  it("a FAILED conversation subscribe rolls back the marker and lets the next subscribe retry", async () => {
    process.env.ZSERVER_FAKE_FAIL_METHODS = "subscribeConversationV4";
    const backend = new ZServerBackend({ serverRoot: makeFakeRoot() });
    try {
      await backend.request(1, "session/create", { workspace: { workspacePath: "/tmp/ws-fail" } });
      const internals = backend as unknown as BackendInternals;
      // subscribeConversation fires the RPC asynchronously; wait for the rollback.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && internals.subscribedSessions.has("sess_fake_1")) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(internals.subscribedSessions.has("sess_fake_1")).toBe(false); // rolled back
      expect(internals.gatesBySession.has("sess_fake_1")).toBe(false); // gate torn down
      // The next subscribe is NOT a silent no-op: it re-registers.
      delete process.env.ZSERVER_FAKE_FAIL_METHODS;
      const again = await backend.request(2, "session/subscribe", {
        sessionId: "sess_fake_1",
        workspace: { workspacePath: "/tmp/ws-fail" },
      });
      expect(again.error).toBeUndefined();
      expect(internals.subscribedSessions.has("sess_fake_1")).toBe(true);
    } finally {
      delete process.env.ZSERVER_FAKE_FAIL_METHODS;
      await backend.close();
    }
  });

  it("history (initial) frames are dropped while online frames stream — through the real wiring", async () => {
    const topic = "conversation/sess_fake_1";
    const row = (text: string): unknown => ({
      op: "row.appended",
      row: { rowId: "1", kind: "assistantText", text },
    });
    process.env.ZSERVER_FAKE_FRAMES = JSON.stringify([
      // history replay of a PAST turn — must NOT surface as live streaming
      { deliveryKind: "initial", frame: { topic, payload: { deltas: [row("OLD HISTORY")] } } },
      // a different session in the same workspace — must be filtered by topic
      {
        deliveryKind: "online",
        frame: { topic: "conversation/other", payload: { deltas: [row("FOREIGN")] } },
      },
      // the live frame for THIS session
      { deliveryKind: "online", frame: { topic, payload: { deltas: [row("LIVE")] } } },
    ]);
    const backend = new ZServerBackend({ serverRoot: makeFakeRoot() });
    const seen: string[] = [];
    try {
      backend.registerEventListener("sess_fake_1", {
        handleEvent: (event) => {
          if (event.type === "model.streaming") {
            seen.push(String((event.payload as { delta?: string }).delta));
          }
        },
      });
      await backend.request(1, "session/create", {
        workspace: { workspacePath: "/tmp/ws-frames" },
      });
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !seen.includes("LIVE")) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(seen).toEqual(["LIVE"]); // no history replay, no foreign session
    } finally {
      delete process.env.ZSERVER_FAKE_FRAMES;
      await backend.close();
    }
  });
});

describe("terminal outcome delivery (real wiring)", () => {
  async function runWithTerminal(
    terminal: Record<string, unknown>,
  ): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
    process.env.ZSERVER_FAKE_TERMINAL = JSON.stringify(terminal);
    process.env.ZCODE_ACP_ZSERVER_TURN_QUIESCE_MS = "60";
    const backend = new ZServerBackend({ serverRoot: makeFakeRoot() });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    try {
      backend.registerEventListener("sess_fake_1", {
        handleEvent: (event) => {
          if (event.type === "turn.completed" || event.type === "turn.failed") {
            events.push({ type: event.type, payload: event.payload as Record<string, unknown> });
          }
        },
      });
      await backend.request(1, "session/create", { workspace: { workspacePath: "/tmp/ws-term" } });
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && events.length === 0) {
        await new Promise((r) => setTimeout(r, 25));
      }
      return events;
    } finally {
      delete process.env.ZSERVER_FAKE_TERMINAL;
      delete process.env.ZCODE_ACP_ZSERVER_TURN_QUIESCE_MS;
      await backend.close();
    }
  }

  it("failed outcome → turn.failed carrying the server's error dict (retry/format consumers read it)", async () => {
    const events = await runWithTerminal({
      outcome: "failed",
      error: { code: "model_request_failed", message: "provider hiccup" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("turn.failed");
    expect(events[0]!.payload).toMatchObject({
      resultType: "error",
      error: { code: "model_request_failed", message: "provider hiccup" },
    });
  });

  it("cancelled outcome → turn.completed with resultType 'cancelled' (not folded into success)", async () => {
    const events = await runWithTerminal({ outcome: "cancelled" });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("turn.completed");
    expect(events[0]!.payload["resultType"]).toBe("cancelled");
  });

  it("succeeded outcome → turn.completed resultType success", async () => {
    const events = await runWithTerminal({ outcome: "succeeded" });
    expect(events[0]!.type).toBe("turn.completed");
    expect(events[0]!.payload["resultType"]).toBe("success");
  });
});
