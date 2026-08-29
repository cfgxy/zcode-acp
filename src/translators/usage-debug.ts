/**
 * Usage-semantics instrumentation (M0 of the bridge-hardening handoff).
 *
 * When `ZACP_USAGE_DEBUG=<path>` is set, every usage-bearing backend event
 * (`session.updated`, `turn.started`, `turn.completed`, `turn.failed`) is
 * appended to the file as one JSON line with its FULL payload — not just the
 * buckets the translator currently reads. The point is empirical: the
 * handoff forbids changing `turnUsageBuckets` semantics without captured
 * evidence, and hidden buckets (real outputTokens, cache splits) may live in
 * payload fields the translator ignores.
 *
 * Writes are synchronous appends (events are low-frequency; sync guarantees
 * the line lands even if the bridge dies mid-turn). Any write failure warns
 * once and disables the tap — instrumentation must never break the bridge.
 */

import { appendFileSync } from "node:fs";
import process from "node:process";

import { warn } from "../utils.js";

/** Event types whose full payload is captured. */
const CAPTURED_TYPES = new Set([
  "session.updated",
  "turn.started",
  "turn.completed",
  "turn.failed",
]);

let target: string | null | undefined;

function resolveTarget(): string | null {
  if (target !== undefined) return target;
  const raw = process.env["ZACP_USAGE_DEBUG"];
  target = raw && raw.length > 0 ? raw : null;
  return target;
}

/** True when the usage tap is armed (`ZACP_USAGE_DEBUG` set to a path). */
export function usageDebugEnabled(): boolean {
  return resolveTarget() !== null;
}

/**
 * Append one captured event as a JSON line:
 * `{ts, session, event, payload}`. `session` is the caller-supplied label
 * (acp session id, or acp·zcode composite) — enough to correlate lines with
 * turns and with the ZACP_USAGE_DEBUG lines of other bridge processes.
 */
export function logUsageEvent(
  session: string | undefined,
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!CAPTURED_TYPES.has(event)) return;
  const path = resolveTarget();
  if (!path) return;
  try {
    appendFileSync(
      path,
      JSON.stringify({ ts: new Date().toISOString(), session, event, payload }) + "\n",
    );
  } catch (e) {
    warn(
      `usage-debug: write failed, disabling tap ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
    target = null;
  }
}
