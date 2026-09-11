/**
 * Backend supervision primitives (M2 of the bridge-hardening handoff).
 *
 * The bridge is the Session Authority over the zcode subprocess: when that
 * subprocess dies mid-task, the failure must NOT propagate raw to the ACP
 * client (Multica marks the task failed) — instead the bridge restarts the
 * backend with backoff, reloads the affected session via zcode
 * `session/resume`, and only then reports a classified, stable-prefixed
 * error upward so the client's retry heuristics can tell infrastructure
 * failures from model failures.
 *
 * Stable error prefixes (part of the wire contract with Multica's kimi.go):
 *   zcode_backend_dead_after_retry — restarts exhausted, backend won't live
 *   zcode_session_lost             — session file gone; resume can't recover
 *   zcode_spawn_failed             — the zcode binary itself won't start
 */

/** Stable error prefixes (part of the wire contract with Multica's kimi.go). */
export const ERR_BACKEND_DEAD_AFTER_RETRY = "zcode_backend_dead_after_retry";
export const ERR_SESSION_LOST = "zcode_session_lost";
export const ERR_SPAWN_FAILED = "zcode_spawn_failed";

/** Canonical dead-backend marker emitted by ZcodeBackend (markReaderDead). */
export const BACKEND_DEAD_MARKER = "backend reader exited";

/** Restart-marker resolved onto in-flight requests during a supervised restart. */
export const BACKEND_RESTARTING_MARKER = "zcode backend restarting";

/**
 * turn.failed cause code the turn loop throws when it notices the backend
 * process died mid-turn. Registered in TRANSIENT_CAUSE_CODES so prompt()'s
 * retry loop treats it as retryable infrastructure, not a model failure.
 */
export const BACKEND_DEAD_TURN_CODE = "zcode_backend_dead";

export function isBackendDeadMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes(BACKEND_DEAD_MARKER) ||
    m.includes("backend pipe broken") ||
    m.includes(BACKEND_RESTARTING_MARKER)
  );
}

/**
 * Whether a zcode error message means "this session no longer exists" — the
 * verified shape is `Session not found: <sid>` (probed 2026-08-29 against
 * zcode 0.16.5). Used to classify post-restart resume failures: the backend
 * is healthy, the SESSION is gone, and no restart can help.
 */
export function isSessionLostMessage(message: string): boolean {
  return /session not found/i.test(message);
}

/**
 * Whether an error means the desktop identity snapshot no longer matches the
 * running desktop app — the verified shape is `desktop profile missing`
 * (observed 2026-09-10 when the desktop app restarted: the persisted profile
 * recorded the old app process, validation marked it stale, and the refresh
 * raced the app coming back up). Healable: the supervised restart re-resolves
 * the backend env through loadDesktopBackendEnv, whose refresh captures the
 * NEW app's identity — once the app is back, later attempts succeed.
 */
export function isDesktopProfileMissingMessage(message: string): boolean {
  return /desktop profile missing/i.test(message);
}

/** Prefix an error message with a stable classification marker. */
export function classified(prefix: string, message: string): string {
  return message.startsWith(prefix) ? message : `${prefix}: ${message}`;
}
