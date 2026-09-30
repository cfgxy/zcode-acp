/**
 * Unit tests for tool-helpers: pure functions that render tool output, build
 * diff content, extract exit codes and locations.
 */

import { describe, expect, it } from "vitest";

import {
  buildDiffContent,
  extractExitCode,
  extractLocations,
  parseSubagentMetadata,
  renderToolOutput,
} from "../src/translators/tool-helpers.js";

describe("renderToolOutput", () => {
  it("returns empty for null/undefined", () => {
    expect(renderToolOutput(null)).toBe("");
    expect(renderToolOutput(undefined)).toBe("");
  });

  it("returns plain strings truncated to OUTPUT_MAX", () => {
    expect(renderToolOutput("hello")).toBe("hello");
    const long = "x".repeat(20000);
    expect(renderToolOutput(long).length).toBeLessThan(long.length);
  });

  it("extracts .content from object payloads", () => {
    expect(renderToolOutput({ content: "wrapped" })).toBe("wrapped");
  });

  it("renders [failed] prefix on success:false with error", () => {
    expect(renderToolOutput({ success: false, error: "boom" })).toBe("[failed] boom");
    expect(renderToolOutput({ success: false, message: "oops" })).toBe("[failed] oops");
  });

  it("JSON-stringifies generic objects", () => {
    expect(renderToolOutput({ a: 1, b: 2 })).toBe(JSON.stringify({ a: 1, b: 2 }));
  });

  it("JSON-stringifies arrays", () => {
    expect(renderToolOutput([1, 2, 3])).toBe(JSON.stringify([1, 2, 3]));
  });
});

describe("extractExitCode", () => {
  it("reads perf.exitCode when present", () => {
    expect(extractExitCode({ perf: { exitCode: 42 } })).toBe(42);
    expect(extractExitCode({ perf: { exitCode: 0 } })).toBe(0);
  });

  it("falls back to 1 on success:false", () => {
    expect(extractExitCode({ success: false })).toBe(1);
  });

  it("falls back to 0 on success:true / unknown object", () => {
    expect(extractExitCode({ success: true })).toBe(0);
    expect(extractExitCode({ foo: "bar" })).toBe(0);
  });

  it("returns 1 for error payloads with no usable dict when isError", () => {
    expect(extractExitCode("some string", true)).toBe(1);
    expect(extractExitCode(null, true)).toBe(1);
  });

  it("returns 0 for non-error primitives", () => {
    expect(extractExitCode("ok")).toBe(0);
    expect(extractExitCode(null)).toBe(0);
  });

  it("parses the exact zcode 0.16.9 string payload 'Exit code N'", () => {
    // Real 0.16.9 failure shape (QA r3 probe, zcode_part_exit3.jsonl): the
    // WHOLE result is the plain string "Exit code 3" — no perf/success
    // fields, event still labelled completed.
    expect(extractExitCode("Exit code 3")).toBe(3);
    expect(extractExitCode("Exit code 127")).toBe(127);
    expect(extractExitCode("Exit code 1")).toBe(1);
    expect(extractExitCode("Exit code 0")).toBe(0);
  });

  it("keeps anchored matching: surrounding text or trailing newline never reads as failure", () => {
    // echo "Exit code 3" emits a trailing newline — a SUCCESS shape the
    // anchored match must not convert into a failure; same for the sentinel
    // embedded inside larger output.
    expect(extractExitCode("Exit code 3\n")).toBe(0);
    expect(extractExitCode("prefix\nExit code 3")).toBe(0);
    expect(extractExitCode("Exit code 3 (state.status=completed)")).toBe(0);
    expect(extractExitCode("exit code 3")).toBe(0);
    expect(extractExitCode("Exit code: 3")).toBe(0);
    // Registered in-band boundary: a command whose ENTIRE output is exactly
    // "Exit code 3" (e.g. printf without newline) is indistinguishable from
    // the failure sentinel — the anchored match deliberately resolves it as
    // a failure.
  });

  it("reads perf.detail.command.exitCode — the real 0.16.9 result shape", () => {
    // Verbatim payloads captured by the r3 isolated probe against real
    // zcode 0.16.9 (bridge-level session/event tool result). The landmine:
    // `success` stays TRUE for a failed command — the exit code lives
    // nested at perf.detail.command.exitCode, with status:"failed" alongside.
    const failed = {
      success: true,
      content: "Exit code 3",
      perf: {
        totalMs: 2048,
        detail: {
          kind: "command",
          command: {
            runMs: 1867,
            noOutputMs: 1867,
            exitCode: 3,
            timedOut: false,
            outputBytes: 0,
            category: "other",
            count: 1,
            name: "other",
            status: "failed",
            hash: "24688a57dbe66df2",
          },
        },
      },
      truncated: false,
      originalBytes: 11,
      returnedBytes: 11,
      budgetStrategy: "artifact",
    };
    expect(extractExitCode(failed)).toBe(3);
    const ok = {
      success: true,
      content: "ok",
      perf: {
        totalMs: 4101,
        detail: {
          kind: "command",
          command: {
            runMs: 3957,
            noOutputMs: 3957,
            exitCode: 0,
            timedOut: false,
            outputBytes: 3,
            category: "other",
            count: 1,
            name: "echo",
            status: "completed",
            hash: "290ab66316e211b0",
          },
        },
      },
      truncated: false,
      originalBytes: 2,
      returnedBytes: 2,
      budgetStrategy: "artifact",
    };
    expect(extractExitCode(ok)).toBe(0);
  });

  it("falls back to perf.detail.command.status when exitCode is absent", () => {
    expect(extractExitCode({ perf: { detail: { command: { status: "failed" } } } })).toBe(1);
    expect(extractExitCode({ perf: { detail: { command: { status: "completed" } } } })).toBe(0);
  });
});

describe("buildDiffContent", () => {
  it("returns [] for non file_diff displays", () => {
    expect(buildDiffContent(null)).toEqual([]);
    expect(buildDiffContent({ kind: "other" })).toEqual([]);
    expect(buildDiffContent({ kind: "file_diff", filePath: "", structuredPatch: [] })).toEqual([]);
  });

  it("builds a diff content block from +/- lines", () => {
    const out = buildDiffContent({
      kind: "file_diff",
      filePath: "src/a.ts",
      structuredPatch: [
        { newStart: 10, lines: [" ctx", "-old", "+new"] },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "diff",
      path: "src/a.ts",
      oldText: "ctx\nold",
      newText: "ctx\nnew",
    });
  });

  it("treats lines without prefix as context on both sides", () => {
    const out = buildDiffContent({
      kind: "file_diff",
      filePath: "f",
      structuredPatch: [{ newStart: 1, lines: ["noprefix", "+added"] }],
    });
    expect(out[0]?.oldText).toBe("noprefix");
    expect(out[0]?.newText).toBe("noprefix\nadded");
  });

  it("nulls oldText when only additions", () => {
    const out = buildDiffContent({
      kind: "file_diff",
      filePath: "f",
      structuredPatch: [{ newStart: 1, lines: ["+only"] }],
    });
    expect(out[0]?.oldText).toBeNull();
    expect(out[0]?.newText).toBe("only");
  });
});

describe("extractLocations", () => {
  it("prefers file_diff display hunks (Edit/Write)", () => {
    const locs = extractLocations(
      "Edit",
      {},
      {
        kind: "file_diff",
        filePath: "src/a.ts",
        structuredPatch: [{ newStart: 10 }, { newStart: 25 }],
      },
    );
    expect(locs).toEqual([
      { path: "src/a.ts", line: 10 },
      { path: "src/a.ts", line: 25 },
    ]);
  });

  it("returns [] without a file_diff display for unknown tools", () => {
    expect(extractLocations("Unknown", {})).toEqual([]);
  });
});

describe("parseSubagentMetadata", () => {
  it("parses agentId and usage from a synchronous sub-agent result string", () => {
    const content =
      "The deps are minimal...\nagentId: agent_73c7c63d-94e9-4c1f-9855-da189151c323 (use SendMessage ...)\n<usage>subagent_tokens: 40904\ntool_uses: 1\nduration_ms: 10559</usage>";
    const meta = parseSubagentMetadata(content);
    expect(meta).not.toBeNull();
    expect(meta!.agentId).toBe("agent_73c7c63d-94e9-4c1f-9855-da189151c323");
    expect(meta!.tokens).toBe(40904);
    expect(meta!.toolUses).toBe(1);
    expect(meta!.durationMs).toBe(10559);
    expect(meta!.background).toBeUndefined();
  });

  it("flags background launches (async_launched content)", () => {
    const content =
      "Async agent launched.\nagentId: agent_61f207dd-3818-435b-b9e9-b995ec45cdb1 (...)\nThe agent is working in the background.\noutput_file: /tmp/o.txt";
    const meta = parseSubagentMetadata(content);
    expect(meta).not.toBeNull();
    expect(meta!.agentId).toBe("agent_61f207dd-3818-435b-b9e9-b995ec45cdb1");
    expect(meta!.background).toBe(true);
  });

  it("parses the {content: string} object shape too (backend result envelope)", () => {
    const meta = parseSubagentMetadata({
      success: true,
      content: "done\nagentId: agent_xyz (use SendMessage)\n<usage>subagent_tokens: 100\ntool_uses: 2\nduration_ms: 50</usage>",
    });
    expect(meta).not.toBeNull();
    expect(meta!.agentId).toBe("agent_xyz");
    expect(meta!.tokens).toBe(100);
  });

  it("returns null for non-Agent results (no markers)", () => {
    expect(parseSubagentMetadata("just some bash output")).toBeNull();
    expect(parseSubagentMetadata({ content: "no markers here" })).toBeNull();
    expect(parseSubagentMetadata(null)).toBeNull();
    expect(parseSubagentMetadata(undefined)).toBeNull();
  });

  it("returns null when only a partial marker is present", () => {
    // agentId keyword but not the agent_xxx id shape → still matched by regex,
    // but here only the usage keyword with a malformed body → no match.
    expect(parseSubagentMetadata("agentId: something_else")).toBeNull();
  });
});
