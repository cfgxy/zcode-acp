/**
 * Tests for transient turn.failed classification and the retry-gate predicate.
 *
 * The retry loop itself (in `prompt`) is deeply coupled to a live backend and
 * is not unit-tested here; instead we cover the predicates that drive it:
 * `isTransientTurnError` (is this worth retrying at all?) and
 * `isRetryableTurnError` (transient AND not rate-limit/quota — the GLM
 * rate-limit class must fail fast at attempt 1 instead of burning retries).
 * The real `turn.failed` payload is a nested object — the recoverable cause
 * lives under `error.cause` while the top-level code is almost always the
 * generic `UNKNOWN_ERROR` wrapper — so classification must look at `cause`
 * and not be fooled by the wrapper.
 */

import { describe, expect, it } from "vitest";

import {
  classifyTurnError,
  isRetryableTurnError,
  isTransientTurnError,
} from "../src/translators/tool-helpers.js";

describe("isTransientTurnError", () => {
  it("matches a transient cause.code (model_request_failed)", () => {
    // The real-world shape observed in transcripts.
    const err = {
      code: "UNKNOWN_ERROR",
      message: "Turn execution failed",
      cause: {
        code: "model_request_failed",
        message: "Network connection failed for the provider request.",
      },
    };
    expect(isTransientTurnError(err)).toBe(true);
  });

  it("matches other whitelisted cause codes", () => {
    for (const code of [
      "invalid_model_request",
      "provider_not_configured",
      "timeout",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "fetch_failed",
    ]) {
      expect(isTransientTurnError({ cause: { code } })).toBe(true);
    }
  });

  it("matches the provider-rejection message shape", () => {
    // The reported interrupt: cause code invalid_model_request with the
    // "Provider rejected the model request" message — retry rather than die.
    const err = {
      code: "UNKNOWN_ERROR",
      message: "Turn execution failed",
      cause: {
        code: "invalid_model_request",
        message: "Provider rejected the model request. (Turn execution failed)",
      },
    };
    expect(isTransientTurnError(err)).toBe(true);
    expect(
      isTransientTurnError({ cause: { message: "provider rejected the model request" } }),
    ).toBe(true);
  });

  it("matches via message keyword when code is absent/unrecognised", () => {
    expect(
      isTransientTurnError({
        cause: { message: "Network connection failed for the provider request." },
      }),
    ).toBe(true);
    expect(isTransientTurnError({ cause: { message: "upstream timed out (110)" } })).toBe(true);
    expect(isTransientTurnError({ cause: { message: "service unavailable" } })).toBe(true);
  });

  it("falls back to the top-level error when no cause is present", () => {
    // Some failures may not nest a cause; the top-level fields should still be
    // inspected as a fallback.
    expect(isTransientTurnError({ code: "timeout" })).toBe(true);
    expect(isTransientTurnError({ message: "network unreachable" })).toBe(true);
  });

  it("returns false for the UNKNOWN_ERROR wrapper WITHOUT a cause", () => {
    // The generic wrapper alone must not be classified as transient — that
    // would retry every business error.
    expect(isTransientTurnError({ code: "UNKNOWN_ERROR", message: "Turn execution failed" })).toBe(
      false,
    );
  });

  it("returns false for non-transient business errors", () => {
    expect(isTransientTurnError({ code: "prompt is running" })).toBe(false);
    expect(isTransientTurnError({ code: "1308", message: "prompt is running" })).toBe(false);
    expect(isTransientTurnError({ cause: { code: "INVALID_PARAMS", message: "bad input" } })).toBe(
      false,
    );
  });

  it("returns false for non-object / malformed input", () => {
    expect(isTransientTurnError(null)).toBe(false);
    expect(isTransientTurnError(undefined)).toBe(false);
    expect(isTransientTurnError("model_request_failed")).toBe(false);
    expect(isTransientTurnError([])).toBe(false);
    expect(isTransientTurnError({})).toBe(false);
  });

  it("inspects cause.type as an alias for cause.code", () => {
    // The translator also surfaces `type` on some payloads. "rate_limit" is
    // no longer transient — it belongs to the fail-fast rate-limit class.
    expect(isTransientTurnError({ cause: { type: "timeout" } })).toBe(true);
    expect(isTransientTurnError({ cause: { type: "rate_limit" } })).toBe(false);
  });

  it("does NOT fall back to top-level when a non-transient cause exists", () => {
    // A non-transient cause must short-circuit before the top-level fallback,
    // otherwise a transient-looking top-level message would override it.
    expect(
      isTransientTurnError({
        code: "timeout", // transient-looking top level
        message: "network blip",
        cause: { code: "INVALID_PARAMS", message: "bad input" }, // fatal cause
      }),
    ).toBe(false);
  });
});

describe("classifyTurnError", () => {
  it("classifies the GLM 1302 rate-limit Chinese message (cause-nested)", () => {
    // Real-world shape: runtime model_usage.error_code is always NULL, so the
    // numeric code never reaches the bridge — only the Chinese message text.
    const err = {
      code: "UNKNOWN_ERROR",
      message: "Turn execution failed",
      cause: {
        message: "您的账户已达到速率限制, 请稍后再试 ( potentially the account 13812345678 )",
      },
    };
    expect(classifyTurnError(err)).toBe("rate_limit");
  });

  it("classifies the GLM 1310 quota Chinese message (cause-nested)", () => {
    const err = {
      code: "UNKNOWN_ERROR",
      message: "Turn execution failed",
      cause: {
        message: "您已达到每周/每月使用上限, 如需更多额度请升级套餐",
      },
    };
    expect(classifyTurnError(err)).toBe("quota");
  });

  it("classifies via detail when message is absent", () => {
    expect(
      classifyTurnError({ cause: { detail: "您的账户已达到速率限制" } }),
    ).toBe("rate_limit");
    expect(classifyTurnError({ cause: { detail: "您已达到使用上限" } })).toBe("quota");
  });

  it("classifies the bare top-level shape when no cause is present", () => {
    // Some failures surface without a nested cause at all.
    expect(classifyTurnError({ message: "您的账户已达到速率限制" })).toBe("rate_limit");
    expect(classifyTurnError({ message: "您已达到使用上限" })).toBe("quota");
  });

  it("classifies the structured rate_limit code into the rate-limit class", () => {
    // Previously treated as transient+retryable; now fail-fast like the
    // message-based GLM rate limits.
    expect(classifyTurnError({ cause: { code: "rate_limit" } })).toBe("rate_limit");
    expect(classifyTurnError({ cause: { type: "rate_limit" } })).toBe("rate_limit");
  });

  it("does NOT fall back to top-level when a non-rate-limit cause exists", () => {
    // Mirror of the isTransientTurnError short-circuit rule.
    expect(
      classifyTurnError({
        code: "UNKNOWN_ERROR",
        message: "您的账户已达到速率限制",
        cause: { code: "INVALID_PARAMS", message: "bad input" },
      }),
    ).toBeNull();
  });

  it("returns null for normal network errors (no misclassification)", () => {
    expect(
      classifyTurnError({
        cause: { code: "model_request_failed", message: "Network connection failed." },
      }),
    ).toBeNull();
    expect(classifyTurnError({ cause: { message: "upstream timed out (110)" } })).toBeNull();
    expect(classifyTurnError({ cause: { message: "service unavailable" } })).toBeNull();
    expect(classifyTurnError({ code: "prompt is running" })).toBeNull();
    expect(classifyTurnError({ cause: { code: "INVALID_PARAMS", message: "bad input" } })).toBeNull();
  });

  it("returns null for non-object / malformed input", () => {
    expect(classifyTurnError(null)).toBeNull();
    expect(classifyTurnError(undefined)).toBeNull();
    expect(classifyTurnError("您的账户已达到速率限制")).toBeNull();
    expect(classifyTurnError([])).toBeNull();
    expect(classifyTurnError({})).toBeNull();
  });
});

describe("isRetryableTurnError", () => {
  it("excludes the GLM rate-limit class: fails at attempt 1, never continues", () => {
    // The retry gate consumes this predicate; rate-limit/quota errors must
    // propagate immediately instead of re-sending through MAX_TURN_ATTEMPTS.
    const rateLimit = {
      code: "UNKNOWN_ERROR",
      message: "Turn execution failed",
      cause: { message: "您的账户已达到速率限制, 请稍后再试" },
    };
    expect(isRetryableTurnError(rateLimit)).toBe(false);

    const quota = {
      code: "UNKNOWN_ERROR",
      message: "Turn execution failed",
      cause: { message: "您已达到每周/每月使用上限" },
    };
    expect(isRetryableTurnError(quota)).toBe(false);

    expect(isRetryableTurnError({ cause: { code: "rate_limit" } })).toBe(false);
  });

  it("still retries ordinary transient failures", () => {
    expect(
      isRetryableTurnError({
        cause: { code: "model_request_failed", message: "Network connection failed." },
      }),
    ).toBe(true);
    expect(isRetryableTurnError({ cause: { code: "timeout" } })).toBe(true);
  });

  it("never retries fatal or malformed errors", () => {
    expect(isRetryableTurnError({ cause: { code: "INVALID_PARAMS", message: "bad input" } })).toBe(
      false,
    );
    expect(isRetryableTurnError(null)).toBe(false);
    expect(isRetryableTurnError({})).toBe(false);
  });
});
