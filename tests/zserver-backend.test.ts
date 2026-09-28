import { describe, expect, it } from "vitest";

import type { BridgeBackend } from "../src/backend/types.js";
import { ZServerBackend, translateConversationDelta } from "../src/backend/zserver/backend.js";

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
      new Map(),
      deliver,
    );
    expect(events).toEqual([{ type: "turn.started", payload: {} }]);
  });

  it("emits assistantText row.upserted as an incremental text delta", () => {
    const emitted = new Map<string, number>();
    const { events, deliver } = collect();
    const row = { rowId: "r3", kind: "assistantText", text: "hello" };
    translateConversationDelta({ op: "row.upserted", row }, emitted, deliver);
    translateConversationDelta(
      { op: "row.upserted", row: { ...row, text: "hello world" } },
      emitted,
      deliver,
    );
    translateConversationDelta({ op: "row.upserted", row }, emitted, deliver);
    expect(events).toEqual([
      { type: "model.streaming", payload: { kind: "text_delta", delta: "hello" } },
      { type: "model.streaming", payload: { kind: "text_delta", delta: " world" } },
    ]);
  });

  it("maps row.delta streaming suffixes to text deltas", () => {
    const { events, deliver } = collect();
    translateConversationDelta({ op: "row.delta", rowId: "r9", delta: "he" }, new Map(), deliver);
    translateConversationDelta(
      { op: "row.delta", rowId: "r9", textDelta: "llo" },
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
    translateConversationDelta({ op: "row.delta", rowId: "r1", delta: "" }, new Map(), deliver);
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
    const backend = new ZServerBackend();
    // No connection needed: unsupported methods fail before channel access.
    const response = await backend.request(1, "session/fork", {});
    expect(response.error?.message).toContain("not supported in zserver backend mode");
  });
});
