/**
 * Resolve the argv to launch the ZCode app-server subprocess.
 *
 * The ZCode CLI is a Node `.cjs` that relies on a `#!/usr/bin/env node` shebang.
 * Processes launched by GUI launchd (no shell profile) have no `node` on PATH,
 * so the shebang fails. We sidestep it by constructing `[node, zcode.cjs,
 * "app-server", "--stdio"]` with an explicit, sqlite-capable Node binary.
 */

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

import { log } from "../utils.js";

/** `which bin` — resolve a binary on PATH without external deps. */
function whichSync(bin: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const out = execFileSync("which", [bin], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Glob the Zed-bundled node directories, newest version first. */
function zedBundledNodes(): string[] {
  const base = path.join(os.homedir(), "Library/Application Support/Zed/node");
  if (!existsSync(base)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.startsWith("node-v"))
    .sort()
    .reverse()
    .map((d) => path.join(base, d, "bin", "node"));
}

/**
 * Candidate Node binaries in priority order. Deduped, order-preserving.
 * Falls back to the Zed-bundled Node glob as a last resort.
 */
function candidateNodeBinaries(env: NodeJS.ProcessEnv): string[] {
  const cands: string[] = [];
  const envNode = env.ZCODE_NODE;
  if (envNode) cands.push(envNode);
  cands.push("/opt/homebrew/bin/node", "/usr/local/bin/node");
  const whichNode = whichSync("node", env);
  if (whichNode) cands.push(whichNode);
  cands.push(...zedBundledNodes());
  const seen = new Set<string>();
  return cands.filter((c) => {
    if (!c || seen.has(c)) return false;
    seen.add(c);
    return true;
  });
}

/**
 * Verify a Node binary can load `node:sqlite` (ZCode depends on it; Node < 22
 * lacks the module and would crash). Uses `new DatabaseSync(...)` because a
 * bare reference would mis-detect support.
 */
function nodeSupportsSqlite(nodeBin: string, env: NodeJS.ProcessEnv): boolean {
  if (!nodeBin || !existsSync(nodeBin)) return false;
  try {
    execFileSync(nodeBin, ["-e", "new (require('node:sqlite').DatabaseSync)(':memory:')"], {
      env,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Well-known desktop-app bundle locations of the shipped `zcode.cjs`
 * (mirrors the per-platform table in README). The app never adds the CLI to
 * PATH, so a bare terminal launch of the REPL/editor bridge finds it here.
 */
function bundledZcodeCandidates(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(localAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs")];
  }
  return [
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    path.join(home, "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
    "/opt/ZCode/resources/glm/zcode.cjs",
    "/usr/share/zcode/resources/glm/zcode.cjs",
  ];
}

/**
 * Resolution chain for the zcode CLI when ZCODE_BIN is unset: PATH first
 * (absolute path so the spawn no longer depends on the child's PATH), then
 * the desktop-app bundle locations. `null` when nothing is found — the caller
 * falls back to the bare name and lets spawn surface the failure.
 */
function discoverZcodeBin(env: NodeJS.ProcessEnv): string | null {
  const onPath = whichSync("zcode", env);
  if (onPath) return onPath;
  for (const c of bundledZcodeCandidates()) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Replace any existing surface selection with exactly one desktop surface. */
export function withDesktopSurface(argv: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--surface") {
      i++;
      continue;
    }
    if (arg.startsWith("--surface=")) continue;
    result.push(arg);
  }
  result.push("--surface", "desktop");
  return result;
}

/** Resolve the full argv to launch `zcode app-server --stdio --surface desktop`. */
export function resolveZcodeCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const zcodeBin = env.ZCODE_BIN ?? discoverZcodeBin(env) ?? "zcode";
  // Non-JS bin (e.g. a `zcode` command or wrapper) → use as-is, rely on its own shebang.
  if (!/\.(cjs|mjs|js)$/.test(zcodeBin)) {
    return withDesktopSurface([zcodeBin, "app-server", "--stdio"]);
  }
  // JS file → launch with an explicit sqlite-capable Node to bypass the shebang.
  for (const nodeBin of candidateNodeBinaries(env)) {
    if (nodeSupportsSqlite(nodeBin, env)) {
      let ver = "?";
      try {
        // argv form (no shell, space-safe); capture stderr so it doesn't leak.
        ver = execFileSync(nodeBin, ["--version"], {
          encoding: "utf8",
          env,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      } catch {
        // keep "?"
      }
      log(`resolve: launching zcode with node ${nodeBin} (${ver})`);
      return withDesktopSurface([nodeBin, zcodeBin, "app-server", "--stdio"]);
    }
  }
  log(
    "resolve: no sqlite-capable node found; falling back to PATH-resolved zcode shebang " +
      "(may fail under GUI launch)",
  );
  return withDesktopSurface([zcodeBin, "app-server", "--stdio"]);
}
