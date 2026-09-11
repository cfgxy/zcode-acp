import { describe, expect, it } from "vitest";
import {
  isBackendDeadMessage,
  isDesktopProfileMissingMessage,
  isSessionLostMessage,
} from "../src/backend/supervise.js";

describe("isDesktopProfileMissingMessage", () => {
  it("matches the verified backend refusal, case-insensitively", () => {
    expect(isDesktopProfileMissingMessage("desktop profile missing")).toBe(true);
    expect(
      isDesktopProfileMissingMessage(
        'session/resume: Internal error (code=-32603, data={"details":"Desktop Profile Missing"})',
      ),
    ).toBe(true);
  });

  it("does not swallow unrelated classifications", () => {
    expect(isDesktopProfileMissingMessage("Session not found: zs_123")).toBe(false);
    expect(isDesktopProfileMissingMessage("zcode backend pipe broken")).toBe(false);
    expect(isDesktopProfileMissingMessage("desktop profile stale")).toBe(false);
  });

  it("stays distinct from the sibling classifiers", () => {
    const msg = "desktop profile missing";
    expect(isDesktopProfileMissingMessage(msg)).toBe(true);
    expect(isBackendDeadMessage(msg)).toBe(false);
    expect(isSessionLostMessage(msg)).toBe(false);
  });
});
