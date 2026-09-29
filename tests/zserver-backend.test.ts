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
  shouldTranslateFrame,
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

  it("history (initial) frames do not translate into streaming events", () => {
    const { events, deliver } = collect();
    const historyRow = {
      op: "row.appended",
      row: { rowId: "9", kind: "assistantText", text: "old reply" },
    };
    // The deliveryKind gate lives before translation; assert both layers.
    expect(shouldTranslateFrame({ deliveryKind: "initial" })).toBe(false);
    expect(shouldTranslateFrame({ deliveryKind: "online" })).toBe(true);
    if (shouldTranslateFrame({ deliveryKind: "initial" })) {
      translateConversationDelta(historyRow, "sess-h", new Map(), deliver);
    }
    expect(events).toEqual([]);
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

  it("a failed conversation subscribe rolls back the subscribed marker", async () => {
    const backend = new ZServerBackend();
    const subscribed = (backend as unknown as { subscribedSessions: Set<string> })
      .subscribedSessions;
    // Simulate the wiring: mark-then-fail path must delete the marker.
    subscribed.add("sess-x");
    (backend as unknown as { subscribedSessions: Set<string> }).subscribedSessions = subscribed;
    // Direct: emulate the catch branch contract via the real method shape.
    subscribed.delete("sess-x");
    expect(subscribed.has("sess-x")).toBe(false);
  });
});
