#!/usr/bin/env node

/**
 * Unified CLI entry (`zcode-acp`). Every operational surface is a subcommand;
 * bare invocation opens the interactive REPL. See docs/adr/0007 for why the
 * old `zcode-acp-hub` / `zcode-quota` bins were folded in here and why
 * `zcode-acp-server` remains as a bin alias pointing at this same file.
 *
 * The legacy alias is detected via argv[0]: npm/pnpm install bin names as
 * symlinks, so both `zcode-acp` and `zcode-acp-server` resolve to dist/cli.js
 * while Node keeps the invoked path in argv — basename tells us which name the
 * user (or editor config) actually typed.
 */

import { basename } from "node:path";
import process from "node:process";

import { main as runHub } from "./bin/hub.js";
import { main as runQuota } from "./bin/quota.js";
import { main as runServer } from "./index.js";
import { DesktopProfileError, loadDesktopProfile, refreshDesktopProfile } from "./desktop-profile.js";
import {
  ensurePersonalGlmProvider,
  personalProviderConfigPath,
  type PersonalProviderOutcome,
} from "./config/personal-provider.js";
import { AGENT_INFO, ZCODE_CREDS_PATH } from "./utils.js";
import { runRepl } from "./repl/run.js";

/** What the dispatcher decided to run. `args` are the tokens after the subcommand. */
export type Invocation =
  | { kind: "help" }
  | { kind: "repl"; explicit: boolean }
  | { kind: "server" }
  | { kind: "hub" }
  | { kind: "profile-refresh" }
  | { kind: "quota"; args: string[] }
  | { kind: "unknown"; sub: string };

/**
 * Map (invoked name, argv) to a subcommand. Pure — exported for unit tests.
 *
 * `invokedAs` is basename(argv[1]); `zcode-acp-server` means we were spawned
 * by an editor config that expects the bridge to speak ACP on stdio with no
 * subcommand prefix. Bare `zcode-acp` opens the interactive REPL.
 */
export function resolveInvocation(invokedAs: string, argv: readonly string[]): Invocation {
  if (invokedAs === "zcode-acp-server") return { kind: "server" };
  const sub = argv[0];
  if (sub === undefined) return { kind: "repl", explicit: false };
  if (sub === "repl" || sub === "tui") return { kind: "repl", explicit: true };
  if (sub === "-h" || sub === "--help" || sub === "help") {
    return { kind: "help" };
  }
  // `acp` is a compat alias for launchers that append a protocol token to the
  // command name (Multica's `<cmd> acp` convention); extra argv is dropped
  // exactly as for `server`.
  if (sub === "acp") return { kind: "server" };
  switch (sub) {
    case "server":
      return { kind: "server" };
    case "hub":
      return { kind: "hub" };
    case "quota":
      return { kind: "quota", args: argv.slice(1) };
    case "profile":
      return argv[1] === "refresh" && argv.length === 2
        ? { kind: "profile-refresh" }
        : { kind: "unknown", sub: argv.join(" ") };
    default:
      return { kind: "unknown", sub };
  }
}

const HELP_TEXT = `Usage: zcode-acp [command] [options]

The single entry point for every zcode-acp-server surface. Bare invocation
opens the interactive REPL (agent chat in this terminal).

Commands:
  (none) | repl       Interactive agent chat (Ink UI): stream output, tool
                      rows, arrow-key permission prompts. /exit quits.
  quota [args...]   Plan usage cards (was the zcode-quota bin): -w watch,
                    -i <sec>, -d detail, -p plain, provider glm|go.
  hub               Run the remote-access hub daemon (was zcode-acp-hub;
                    usually auto-spawned by bridges, rarely run by hand).
  profile refresh   Capture the active Linux ZCode Desktop profile.
  server            The editor-facing ACP bridge over stdio (was
                    zcode-acp-server; editors normally launch it via the bin
                    alias without this subcommand).
  acp               Alias for "server", for launchers that spell the bridge
                    as "<command> acp".
  -h, --help        Show this help.
  --version         Show the package version.

Examples:
  zcode-acp                                # chat interactively in this repo
  zcode-acp quota -w                       # live usage monitor
  zcode-acp profile refresh                # refresh desktop attachment
  zcode-acp server                         # stdio bridge (for testing)`;

async function main(): Promise<void> {
  if (process.argv[2] === "--version") {
    process.stdout.write(`${AGENT_INFO.version}\n`);
    return;
  }
  const invocation = resolveInvocation(basename(process.argv[1] ?? ""), process.argv.slice(2));
  switch (invocation.kind) {
    case "help":
      process.stdout.write(HELP_TEXT + "\n");
      return;
    case "repl":
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await runRepl();
        return;
      }
      if (invocation.explicit) {
        process.stderr.write("zcode-acp: interactive REPL needs a TTY — run it from a terminal.\n");
        process.exit(2);
      }
      // Bare invocation without a TTY falls back to the stdio server: on
      // Windows npm shims spawn `node ...\dist\cli.js`, so argv[0] loses the
      // bin name and editors configured with either bin land here. Unix
      // pipes get the same fallback (JSON-RPC on stdin, exit on EOF).
      await runServer();
      return;
    case "server":
      await runServer();
      return;
    case "hub":
      await runHub();
      return;
    case "profile-refresh":
      try {
        process.stdout.write(`${refreshDesktopProfile()}\n`);
      } catch (error) {
        process.stderr.write(
          `zcode-acp: ${error instanceof DesktopProfileError ? error.message : "desktop profile invalid"}\n`,
        );
        process.exitCode = 1;
        return;
      }
      ensureGlmPersonalProviderAfterRefresh();
      return;
    case "quota":
      await runQuota(invocation.args);
      return;
    case "unknown":
      process.stderr.write(`zcode-acp: unknown command '${invocation.sub}'\n\n`);
      process.stdout.write(HELP_TEXT + "\n");
      process.exit(1);
  }
}

/**
 * Post-refresh guard: the desktop provisions provider_config.json on every
 * update/sync and drops manually-added entries, so re-ensure the GLM Coding
 * Plan personal provider right after the profile was re-captured (the two
 * actions share the exact same trigger: a desktop restart/update). The
 * provider path comes from the just-refreshed profile when loadable — the
 * capture proves the desktop is running and its pins are current. Best-effort:
 * outcome is reported, never thrown; refresh's exit code is untouched.
 */
function ensureGlmPersonalProviderAfterRefresh(): void {
  let providerPath: string;
  try {
    providerPath = personalProviderConfigPath(loadDesktopProfile().env);
  } catch {
    providerPath = personalProviderConfigPath();
  }
  const outcome: PersonalProviderOutcome = ensurePersonalGlmProvider(providerPath, ZCODE_CREDS_PATH);
  switch (outcome.status) {
    case "added":
      process.stdout.write(`personal provider: GLM Coding Plan entry re-added (${outcome.providerId})\n`);
      break;
    case "present":
      process.stdout.write(`personal provider: GLM Coding Plan entry present (${outcome.providerId})\n`);
      break;
    case "skipped":
      process.stdout.write(`personal provider: not touched — ${outcome.reason}\n`);
      break;
  }
}

// Only auto-run when this file is the executed entry — directly
// (`node dist/cli.js`) or through either bin symlink (`zcode-acp`,
// `zcode-acp-server`), where argv[1] keeps the symlink path. Imports (the
// test suite) fall through to a no-op.
const invokedDirectly = (() => {
  const entry = process.argv[1] ?? "";
  const name = basename(entry);
  return (
    entry.endsWith("cli.js") ||
    entry.endsWith("cli.ts") ||
    name === "zcode-acp" ||
    name === "zcode-acp-server"
  );
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(
      `zcode-acp: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
