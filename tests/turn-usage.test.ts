/**
 * Turn usage forwarding tests — the metering path for clients that bill from
 * a top-level `usage` object on the session/prompt response (Multica's
 * kimi-family ACP backend). Covers: raw bucket capture in EventTranslator
 * (`session.updated` per-call usage, `turn.completed` turn-aggregate usage),
 * the bucket derivation, and the one-shot attach semantics on the response.
 *
 * The "real backend" cases replay the exact buckets captured from zcode
 * 0.16.5 (evidence: tests/fixtures/usage-probe-events.jsonl, probe run
 * 2026-08-29): a 2-request tool turn where call 1 = {in 19848, out 136,
 * cacheRead 19712}, call 2 = {in 20005, out 10, cacheRead 19840}, and
 * turn.completed aggregates to {in 39853, out 146, total 39999, cacheRead
 * 39552}. The old code derived output = total − occupancy = 39999 − 20005 =
 * 19994 — counting call 1's input as output, the exact miscount behind
 * Multica's exploding output column.
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

describe("EventTranslator real-backend buckets (zcode 0.16.5 probe)", () => {
  // Captured per-call session.updated payloads (usage-carrying variants;
  // probe run 2026-08-29, 2-request tool turn).
  const CALL1 = { inputTokens: 19848, outputTokens: 136, totalTokens: 19984, cacheReadTokens: 19712, cacheWriteTokens: 0 };
  const CALL2 = { inputTokens: 20005, outputTokens: 10, totalTokens: 20015, cacheReadTokens: 19840, cacheWriteTokens: 0 };
  const TURN_AGGREGATE = {
    source: "provider",
    modelRequestCount: 2,
    inputTokens: 39853,
    outputTokens: 146,
    totalTokens: 39999,
    cacheReadTokens: 39552,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };

  it("ends a multi-request turn holding the turn aggregate, not a per-call snapshot", () => {
    const t = new EventTranslator();
    t.translate(ev("session.updated", { usage: CALL1 }));
    t.translate(ev("session.updated", { usage: CALL1, contextWindow: 1000000 }));
    t.translate(ev("session.updated", { usage: CALL2 }));
    t.translate(ev("turn.completed", { usage: TURN_AGGREGATE, tokenCount: 39999 }));
    expect(t.lastRawUsage).toEqual({
      inputTokens: 39853,
      outputTokens: 146,
      totalTokens: 39999,
      cacheReadTokens: 39552,
      cacheWriteTokens: 0,
      contextWindow: 1000000,
    });
  });

  it("emits the context-bar occupancy at turn end, not the Σ-processed gross", () => {
    const t = new EventTranslator();
    t.translate(ev("session.updated", { usage: CALL2, contextWindow: 1000000 }));
    const out = t.translate(ev("turn.completed", { usage: TURN_AGGREGATE }));
    // Occupancy = last call's input (20005); gross total (39999) would
    // inflate the bar ~2× after a 2-request turn.
    expect(out).toEqual([{ kind: "UsageDelta", used: 20005, size: 1000000 }]);
  });

  it("falls back to totalTokens for the context bar when no session.updated arrived", () => {
    const t = new EventTranslator();
    const out = t.translate(ev("turn.completed", { usage: { totalTokens: 5000 } }));
    expect(out).toEqual([{ kind: "UsageDelta", used: 5000, size: 0 }]);
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

  it("forwards real backend buckets verbatim, cache split included", () => {
    expect(
      turnUsageBuckets({
        inputTokens: 39853,
        outputTokens: 146,
        totalTokens: 39999,
        cacheReadTokens: 39552,
        cacheWriteTokens: 0,
        contextWindow: 1000000,
      }),
    ).toEqual({
      inputTokens: 39853,
      outputTokens: 146,
      totalTokens: 39999,
      cacheReadTokens: 39552,
      cacheWriteTokens: 0,
      contextWindow: 1000000,
    });
  });

  it("defaults totalTokens to in+out when the backend omits it", () => {
    const b = turnUsageBuckets({ inputTokens: 1000, outputTokens: 40 })!;
    expect(b.totalTokens).toBe(1040);
    expect(b.outputTokens).toBe(40);
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

  it("attaches the real turn aggregate (probe capture) verbatim", () => {
    const server = new ZcodeAcpServer();
    server.turnUsage.set("sess_real", {
      inputTokens: 39853,
      outputTokens: 146,
      totalTokens: 39999,
      cacheReadTokens: 39552,
      cacheWriteTokens: 0,
      contextWindow: 1000000,
    });
    const out = attachTurnUsage(server, "sess_real", fakeResponse());
    expect(out).toMatchObject({
      usage: {
        inputTokens: 39853,
        outputTokens: 146,
        totalTokens: 39999,
        cacheReadTokens: 39552,
        cacheWriteTokens: 0,
      },
    });
  });

  it("leaves the response untouched when no usage was captured", () => {
    const server = new ZcodeAcpServer();
    const out = attachTurnUsage(server, "sess_b", fakeResponse());
    expect(out).toEqual({ stopReason: "end_turn" });
    expect(Object.keys(out)).toEqual(["stopReason"]);
  });
});
