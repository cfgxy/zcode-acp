/**
 * Tests for the supervised backend self-heal (M2 of the bridge-hardening
 * handoff) — the P3/P4 production failures:
 *   P3: zcode subprocess dies mid-turn → task failed (SHAN-83 2026-08-29)
 *   P4: backend dead at session/create → set_model failed (SHAN-38 2026-08-28)
 *
 * The bridge is the Session Authority: a dead backend is restarted in place
 * (same object, listeners preserved), the affected session reloaded via
 * zcode session/resume, and the turn re-sent. Only genuinely unrecoverable
 * states surface upward, with stable error prefixes
 * (zcode_session_lost / zcode_backend_dead_after_retry) that Multica's
 * retry heuristics can classify.
 *
 * Reproduction cases (handoff §2.2 exit criteria):
 *   ① turn in flight, backend killed → bridge heals → task completes
 *   ② backend restarted but the session file is gone → zcode_session_lost
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { ensureRealSession, prompt, resumeSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

interface Call {
  method: string;
  params: Record<string, unknown>;
}

const DEAD_MSG = "zcode backend reader exited (backend dead)";

/**
 * Scriptable fake backend.
 *   - `sendScript`: per-send behaviour — "ok" delivers a complete turn,
 *     "die-after-accept" accepts then marks the backend dead (kill -9
 *     mid-turn, no further events and no further successful requests).
 *   - `resumeResponses`: consumed one per session/resume call; exhaustion
 *     means success.
 * `revive()` simulates a supervised restart: clears the dead markers so the
 * next requests succeed again.
 */
function fakeBackend(sendScript: Array<"ok" | "die-after-accept">, resumeResponses: unknown[]) {
  const calls: Call[] = [];
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  let sendIndex = -1;
  let resumeIndex = 0;
  let dead = false;
  const backend = {
    isDead: false,
    deathReason: null as string | null,
    request: async (_id: number, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (dead) return { error: { message: DEAD_MSG } };
      switch (method) {
        case "workspace/updateProviderRegistry":
          return { result: {} };
        case "session/resume": {
          const resp = resumeResponses[resumeIndex++];
          return resp ?? { result: {} };
        }
        case "session/subscribe":
          return { result: { eventSeq: 0 } };
        case "session/read":
          return { result: { projection: { status: "idle", contextUsed: 0 }, settings: {} } };
        case "session/messages":
          return { result: { messages: [] } };
        case "session/send": {
          sendIndex++;
          const behaviour = sendScript[sendIndex] ?? "ok";
          if (behaviour === "die-after-accept") {
            // kill -9: the send was accepted, then the process (and its
            // event stream) dies.
            dead = true;
            backend.isDead = true;
            backend.deathReason = "stdout closed";
            return { result: { accepted: true } };
          }
          const events: ZcodeEvent[] = [
            { type: "turn.started" },
            { type: "turn.completed", payload: { resultType: "success" } },
          ];
          for (const e of events) {
            for (const l of listeners) l.handleEvent(e);
          }
          return { result: { accepted: true } };
        }
        default:
          return { result: {} };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return {
    backend,
    calls,
    revive: () => {
      dead = false;
      backend.isDead = false;
      backend.deathReason = null;
    },
  };
}

function stubCx(): acp.AgentContext {
  return { notify: async () => {}, request: async () => ({}) } as unknown as acp.AgentContext;
}

/**
 * Server wired to the fake backend with a heal patch: restartBackend revives
 * the fake (clears the dead markers) instead of spawning a real process, and
 * counts restarts.
 */
function setup(backend: ZcodeBackend, revive: () => void): { server: ZcodeAcpServer; restarts: () => number } {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  let restartCount = 0;
  server.restartBackend = async () => {
    restartCount++;
    revive();
    return backend;
  };
  return { server, restarts: () => restartCount };
}

function promptParams(): acp.PromptRequest {
  return { sessionId: "sess_h", prompt: [{ type: "text", text: "hello" }] } as acp.PromptRequest;
}

const count = (calls: Call[], method: string) => calls.filter((c) => c.method === method).length;

describe("backend self-heal: mid-turn death (P3)", () => {
  it("① restarts the backend, reloads the session, resends, and completes the turn", async () => {
    const { backend, calls, revive } = fakeBackend(["die-after-accept", "ok"], []);
    const { server, restarts } = setup(backend, revive);
    server.registerSession("sess_h", "zs_h");
    server.markBackendLoaded("sess_h");

    const result = await prompt(server, promptParams(), stubCx(), 1);

    expect(result).toEqual({ stopReason: "end_turn" });
    // One supervised restart, one reload, and the prompt re-sent — in order:
    // send(dead) → restart+resume → send(ok).
    expect(restarts()).toBe(1);
    expect(count(calls, "session/resume")).toBe(1);
    expect(count(calls, "session/send")).toBe(2);
    const firstSend = calls.findIndex((c) => c.method === "session/send");
    const resume = calls.findIndex((c) => c.method === "session/resume");
    const secondSend = calls.findIndex((c, i) => i > firstSend && c.method === "session/send");
    expect(resume).toBeGreaterThan(firstSend);
    expect(secondSend).toBeGreaterThan(resume);
  }, 20000);

  it("surfaces zcode_backend_dead_after_retry when every restart dies again", async () => {
    // The send dies, and every post-restart reload also fails with the dead
    // marker — the heal budget exhausts and the classified error propagates
    // (enough scripted dead resumes to cover the overlay retry path too).
    const deadResumes = Array.from({ length: 8 }, () => ({ error: { message: DEAD_MSG } }));
    const { backend, revive } = fakeBackend(["die-after-accept"], deadResumes);
    const { server } = setup(backend, revive);
    server.registerSession("sess_h", "zs_h");
    server.markBackendLoaded("sess_h");

    await expect(prompt(server, promptParams(), stubCx(), 1)).rejects.toThrow(
      /zcode_backend_dead_after_retry/,
    );
  }, 30000);
});

describe("backend self-heal: session lost (P3 terminal case)", () => {
  it("② prefixes a Session-not-found resume failure with zcode_session_lost (no restart)", async () => {
    const { backend, calls, revive } = fakeBackend([], [
      { error: { code: -32603, message: "Session not found: zs_lost" } },
    ]);
    const { server, restarts } = setup(backend, revive);
    server.registerSession("sess_lost", "zs_lost");

    await expect(
      resumeSession(
        server,
        { sessionId: "sess_lost", cwd: "/tmp" } as acp.ResumeSessionRequest,
        stubCx(),
      ),
    ).rejects.toThrow(/^zcode_session_lost: /);

    // A lost session is NOT an infrastructure failure — no restart attempted.
    expect(restarts()).toBe(0);
    expect(count(calls, "session/resume")).toBe(1);
  });

  it("classifies zcode_session_lost when the session dies WITH the backend and cannot be reloaded", async () => {
    // Resume hits a dead backend → heal restarts it → the reload finds the
    // session file gone → classified terminal error, not a retry loop.
    const { backend, revive } = fakeBackend([], [
      { error: { message: DEAD_MSG } }, // initial resume: backend dead
      { error: { code: -32603, message: "Session not found: zs_gone" } }, // post-restart reload
      { error: { code: -32603, message: "Session not found: zs_gone" } }, // (overlay retry, same answer)
    ]);
    const { server, restarts } = setup(backend, revive);
    server.registerSession("sess_gone", "zs_gone");

    await expect(
      resumeSession(
        server,
        { sessionId: "sess_gone", cwd: "/tmp" } as acp.ResumeSessionRequest,
        stubCx(),
      ),
    ).rejects.toThrow(/^zcode_session_lost: /);
    expect(restarts()).toBe(1);
  }, 20000);
});

describe("backend self-heal: create path (P4)", () => {
  it("retries session/create after a dead backend is restarted", async () => {
    // Lazy placeholder materialization: the first create resolves with the
    // dead marker (the P4 evidence shape: "zcode create failed: zcode
    // backend reader exited"), the post-restart retry succeeds.
    const calls: Call[] = [];
    let createCount = 0;
    const backend = {
      isDead: false,
      deathReason: null as string | null,
      request: async (_id: number, method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "session/create") {
          createCount++;
          if (createCount === 1) return { error: { message: DEAD_MSG } };
          return { result: { session: { sessionId: "zs_new", title: "t" } } };
        }
        return { result: {} };
      },
      send: () => {},
      pollServerRequests: () => [],
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    const server = new ZcodeAcpServer();
    server.backend = backend;
    server.restartBackend = async () => {
      (backend as unknown as { isDead: boolean }).isDead = false;
      (backend as unknown as { deathReason: string | null }).deathReason = null;
      return backend;
    };
    server.pendingSessions.set("sess_lazy", { cwd: "/tmp" });

    const sid = await ensureRealSession(server, "sess_lazy");

    expect(sid).toBe("zs_new");
    expect(createCount).toBe(2);
  });
});
