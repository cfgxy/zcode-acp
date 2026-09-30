/**
 * Real-filesystem tests for the plan-key write path of personal-provider.ts.
 * (personal-provider.test.ts fakes node:fs with a Map, so it never touches
 * atomicWrite's symlink behaviour — that is exactly what these pin down.)
 *
 * The provider config holds the user's plan API key and is written through
 * PREDICTABLE names (`<file>.tmp-<pid>`, `<file>.bak-<ms>`): a same-uid attacker
 * who plants a symlink at one of them used to get the key (or a truncating write)
 * delivered to a file of their choosing.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

function sandbox(): { dir: string; config: string; zcodeConfig: string; victim: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-write-"));
  dirs.push(dir);
  const config = path.join(dir, "provider_config.json");
  const zcodeConfig = path.join(dir, "config.json");
  const victim = path.join(dir, "victim.txt");
  fs.writeFileSync(
    config,
    JSON.stringify({
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [] },
      },
    }),
  );
  fs.writeFileSync(
    zcodeConfig,
    JSON.stringify({
      provider: {
        p: {
          enabled: true,
          options: { baseURL: "https://open.bigmodel.cn/api/anthropic", apiKey: "PLACEHOLDER-KEY" },
        },
      },
    }),
  );
  fs.writeFileSync(victim, "VICTIM-ORIGINAL");
  return { dir, config, zcodeConfig, victim };
}

const load = () => import("../src/config/personal-provider.js");

describe("plan-key write path vs planted symlinks", () => {
  it("a symlink planted at the predictable temp name does not redirect the write", async () => {
    const { ensurePersonalGlmProvider } = await load();
    const { config, zcodeConfig, victim } = sandbox();
    fs.symlinkSync(victim, `${config}.tmp-${process.pid}`);

    const outcome = ensurePersonalGlmProvider(config, zcodeConfig);

    expect(outcome.status).toBe("added");
    expect(fs.readFileSync(victim, "utf8")).toBe("VICTIM-ORIGINAL"); // never written through the link
    expect(fs.readFileSync(config, "utf8")).toContain("GLM Coding Plan"); // the real target got it
    expect(fs.lstatSync(config).isSymbolicLink()).toBe(false);
  });

  it("a symlink planted at the backup name is not followed either", async () => {
    const { ensurePersonalGlmProvider } = await load();
    const { config, zcodeConfig, victim } = sandbox();
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    fs.symlinkSync(victim, `${config}.bak-1800000000000`);

    const outcome = ensurePersonalGlmProvider(config, zcodeConfig);

    // The backup could not be created safely, so the write is refused (skipped)
    // rather than following the link — and the victim is untouched either way.
    expect(fs.readFileSync(victim, "utf8")).toBe("VICTIM-ORIGINAL");
    expect(outcome.status).toBe("skipped");
    expect(fs.readFileSync(config, "utf8")).not.toContain("GLM Coding Plan");
  });

  it("a stale temp file from a crashed run is replaced, not an error", async () => {
    const { ensurePersonalGlmProvider } = await load();
    const { config, zcodeConfig } = sandbox();
    fs.writeFileSync(`${config}.tmp-${process.pid}`, "STALE-LEFTOVER");

    expect(ensurePersonalGlmProvider(config, zcodeConfig).status).toBe("added");
    expect(fs.existsSync(`${config}.tmp-${process.pid}`)).toBe(false);
  });

  it("the written file and its backup are 0600", async () => {
    const { ensurePersonalGlmProvider } = await load();
    const { dir, config, zcodeConfig } = sandbox();

    expect(ensurePersonalGlmProvider(config, zcodeConfig).status).toBe("added");

    expect(fs.statSync(config).mode & 0o777).toBe(0o600);
    const backups = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("provider_config.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(fs.statSync(path.join(dir, backups[0]!)).mode & 0o777).toBe(0o600);
  });

  it("is idempotent: a second run reports 'present' and writes nothing", async () => {
    const { ensurePersonalGlmProvider } = await load();
    const { dir, config, zcodeConfig } = sandbox();
    expect(ensurePersonalGlmProvider(config, zcodeConfig).status).toBe("added");
    const before = fs.readdirSync(dir).sort();
    expect(ensurePersonalGlmProvider(config, zcodeConfig).status).toBe("present");
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });
});

describe("pin resolution: a symlinked directory inside ~/.zcode cannot carry the key out of it", () => {
  // `~` is the current user's real home (os.homedir()), which this describe must not
  // touch — so it re-points HOME at a sandbox for a fresh module instance.
  async function withHome<T>(
    run: (ctx: {
      home: string;
      zcode: string;
      outside: string;
      resolve: (pin: string) => unknown;
    }) => T,
  ): Promise<T> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pp-home-"));
    dirs.push(home);
    const zcode = path.join(home, ".zcode");
    fs.mkdirSync(path.join(zcode, "v2"), { recursive: true });
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    const previous = process.env.HOME;
    process.env.HOME = home;
    vi.resetModules();
    try {
      const mod = await import("../src/config/personal-provider.js");
      return run({
        home,
        zcode,
        outside,
        resolve: (pin) =>
          mod.resolvePersonalProviderTarget({ ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: pin as string }),
      });
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      vi.resetModules();
    }
  }

  it("rejects a not-yet-existing file behind a symlinked directory that leaves ~/.zcode (was accepted)", async () => {
    await withHome(({ zcode, outside, resolve }) => {
      fs.symlinkSync(outside, path.join(zcode, "linkdir"));
      const pin = path.join(zcode, "linkdir", "provider_config.json"); // does not exist yet
      const target = resolve(pin) as { path: string; rejectedPin?: string };
      expect(target.rejectedPin).toBe(pin);
      expect(target.path).toBe(path.join(zcode, "v2", "provider_config.json"));
    });
  });

  it("rejects a dangling symlink pin (its target is unknowable)", async () => {
    await withHome(({ zcode, outside, resolve }) => {
      const pin = path.join(zcode, "dangling.json");
      fs.symlinkSync(path.join(outside, "none.json"), pin);
      expect((resolve(pin) as { rejectedPin?: string }).rejectedPin).toBe(pin);
    });
  });

  it("returns the RESOLVED path, so the location that was checked is the one written", async () => {
    await withHome(({ zcode, resolve }) => {
      const realDir = path.join(zcode, "realdir");
      fs.mkdirSync(realDir);
      fs.symlinkSync(realDir, path.join(zcode, "aliasdir")); // a link that STAYS inside ~/.zcode
      const target = resolve(path.join(zcode, "aliasdir", "provider_config.json")) as {
        path: string;
        rejectedPin?: string;
      };
      expect(target.rejectedPin).toBeUndefined();
      expect(target.path).toBe(fs.realpathSync(realDir) + path.sep + "provider_config.json");
    });
  });

  it("still accepts an ordinary not-yet-existing file inside ~/.zcode", async () => {
    await withHome(({ zcode, resolve }) => {
      const pin = path.join(zcode, "v2", "brand-new.json");
      const target = resolve(pin) as { path: string; rejectedPin?: string };
      expect(target.rejectedPin).toBeUndefined();
      expect(target.path).toBe(
        fs.realpathSync(path.join(zcode, "v2")) + path.sep + "brand-new.json",
      );
    });
  });

  it("rejects a pin that only shares a name prefix with ~/.zcode", async () => {
    await withHome(({ home, resolve }) => {
      const sibling = path.join(home, ".zcode-evil");
      fs.mkdirSync(sibling);
      expect((resolve(path.join(sibling, "x.json")) as { rejectedPin?: string }).rejectedPin).toBe(
        path.join(sibling, "x.json"),
      );
    });
  });
});

describe("the backup is 0600 from its first byte", () => {
  // Observing the mode "at creation" from inside the process is not possible (the
  // module binds node:fs by name, so a spy never sees its calls). Run the real
  // writer in a child under strace instead: the kernel's own openat() record shows
  // the flags and the creation mode. Skipped where strace is unavailable.
  const hasStrace = spawnSync("strace", ["-V"], { stdio: "ignore" }).status === 0;

  it.skipIf(!hasStrace)(
    "backup and temp file are opened O_CREAT|O_EXCL with mode 0600 (source is 0644)",
    () => {
      const { config, zcodeConfig, dir } = sandbox();
      fs.chmodSync(config, 0o644); // readable by others, like the desktop's own file
      // Transpile the SOURCE into the sandbox (dist/ is git-ignored and may not be
      // built): personal-provider.ts only needs ../utils.ts, which imports node: only.
      const built = path.join(dir, "built");
      fs.mkdirSync(path.join(built, "config"), { recursive: true });
      for (const rel of ["config/personal-provider.ts", "utils.ts"]) {
        const source = fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
        const { outputText } = ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        });
        fs.writeFileSync(path.join(built, rel.replace(/\.ts$/, ".js")), outputText);
      }
      fs.writeFileSync(path.join(built, "package.json"), '{"type":"module"}');
      const distEntry = path.join(built, "config", "personal-provider.js");
      const script = path.join(dir, "run.mjs");
      fs.writeFileSync(
        script,
        `import { ensurePersonalGlmProvider } from ${JSON.stringify(distEntry)};\n` +
          `process.stdout.write(ensurePersonalGlmProvider(${JSON.stringify(config)}, ${JSON.stringify(zcodeConfig)}).status);\n`,
      );
      const traceFile = path.join(dir, "trace.out");
      const run = spawnSync(
        "strace",
        ["-f", "-e", "trace=openat", "-o", traceFile, process.execPath, script],
        { encoding: "utf8" },
      );
      expect(run.stdout).toBe("added");
      const created = fs
        .readFileSync(traceFile, "utf8")
        .split("\n")
        .filter((line) => /provider_config\.json\.(bak|tmp)-/.test(line) && /O_CREAT/.test(line));
      expect(created).toHaveLength(2); // the backup and the temp file
      for (const line of created) {
        expect(line).toMatch(/O_EXCL/); // never follows a planted symlink
        expect(line).toMatch(/, 0600\)/); // never inherits the source's 0644
      }
    },
  );

  it("the finished backup is 0600 too (behavioural check, no strace needed)", async () => {
    const { ensurePersonalGlmProvider } = await load();
    const { dir, config, zcodeConfig } = sandbox();
    fs.chmodSync(config, 0o644);
    expect(ensurePersonalGlmProvider(config, zcodeConfig).status).toBe("added");
    const backup = fs.readdirSync(dir).find((n) => n.startsWith("provider_config.json.bak-"))!;
    expect(fs.statSync(path.join(dir, backup)).mode & 0o777).toBe(0o600);
  });
});
