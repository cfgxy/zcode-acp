/**
 * Turn usage forwarding tests — the metering path for clients that bill from
 * a top-level `usage` object on the session/prompt response (Multica's
 * kimi-family ACP backend). Covers: raw bucket capture in EventTranslator
 * (`session.updated` inputTokens, `turn.completed` totalTokens), the bucket
 * derivation, and the one-shot attach semantics on the response.
 */

import { describe, expect, it } from "vitest";

import { EventTranslator } from "../src/translators/event-translator.js";
import { attachTurnUsage, turnUsageBuckets } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

function ev(type: string, payload: Record<string, unknown> = {}) {
  return { type, payload };
}

type PromptResponse = Parameters<typeof attachTurnUsage>[2];

describe("EventTranslator lastRawUsage capture", () => {
  it("captures inputTokens + contextWindow from session.updated", () => {
    const t = new EventTranslator();
    t.translate(ev("session.updated", { usage: { inputTokens: 1234 }, contextWindow: 32000 }));
    expect(t.lastRawUsage).toEqual({ inputTokens: 1234, contextWindow: 32000 });
  });

  it("captures totalTokens from turn.completed, preferring usage.totalTokens over tokenCount", () => {
    const t = new EventTranslator();
    t.translate(ev("turn.completed", { usage: { totalTokens: 5000 }, tokenCount: 1 }));
    expect(t.lastRawUsage.totalTokens).toBe(5000);
  });

  it("invokes the onRawUsage hook with the live object (by reference)", () => {
    const seen: Array<{ inputTokens?: number }> = [];
    const t = new EventTranslator((u) => seen.push(u));
    t.translate(ev("session.updated", { usage: { inputTokens: 10 }, contextWindow: 100 }));
    t.translate(ev("session.updated", { usage: { inputTokens: 20 }, contextWindow: 100 }));
    // The hook hands out the same mutable object each time — the holder
    // (server.turnUsage) sees later mutations without re-registration, and
    // the final read observes the latest buckets.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(t.lastRawUsage);
    expect(seen[1]).toBe(t.lastRawUsage);
    expect(t.lastRawUsage.inputTokens).toBe(20);
  });
});

describe("turnUsageBuckets", () => {
  it("derives outputTokens as totalTokens − inputTokens", () => {
    expect(turnUsageBuckets({ inputTokens: 100, totalTokens: 250 })).toEqual({
      inputTokens: 100,
      outputTokens: 150,
      totalTokens: 250,
    });
  });

  it("floors outputTokens at 0 when inputTokens exceeds totalTokens", () => {
    const b = turnUsageBuckets({ inputTokens: 300, totalTokens: 250 })!;
    expect(b.outputTokens).toBe(0);
    expect(b.inputTokens).toBe(300);
  });

  it("passes contextWindow through when present", () => {
    expect(turnUsageBuckets({ inputTokens: 1, totalTokens: 2, contextWindow: 32000 })).toMatchObject({
      contextWindow: 32000,
    });
  });

  it("returns null when the turn produced no usage", () => {
    expect(turnUsageBuckets(undefined)).toBeNull();
    expect(turnUsageBuckets({})).toBeNull();
    expect(turnUsageBuckets({ inputTokens: 0, totalTokens: 0 })).toBeNull();
  });
});

describe("attachTurnUsage", () => {
  function fakeResponse(): PromptResponse {
    return { stopReason: "end_turn" } as unknown as PromptResponse;
  }

  it("attaches derived usage to the prompt response and deletes the entry", () => {
    const server = new ZcodeAcpServer();
    server.turnUsage.set("sess_a", { inputTokens: 100, totalTokens: 250 });
    const out = attachTurnUsage(server, "sess_a", fakeResponse());
    expect(out).toMatchObject({
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 150, totalTokens: 250 },
    });
    expect(server.turnUsage.has("sess_a")).toBe(false);
  });

  it("leaves the response untouched when no usage was captured", () => {
    const server = new ZcodeAcpServer();
    const out = attachTurnUsage(server, "sess_b", fakeResponse());
    expect(out).toEqual({ stopReason: "end_turn" });
    expect(Object.keys(out)).toEqual(["stopReason"]);
  });
});
