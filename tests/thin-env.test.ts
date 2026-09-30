import { describe, expect, it } from "vitest";

import { buildThinBackendEnv, type ThinEnvDeps } from "../src/backend/thin-env.js";

const HOME = "/home/tester";
const ROOT = `${HOME}/.zcode/server`;

function deps(over: Partial<ThinEnvDeps> = {}): ThinEnvDeps {
  const files = new Set([
    `${ROOT}/tools/bfs/bfs`,
    `${ROOT}/tools/ripgrep/rg`,
    `${ROOT}/tools/ugrep/ugrep`,
  ]);
  return {
    homedir: () => HOME,
    username: () => "tester",
    platform: "linux",
    arch: "x64",
    existsSync: (p) => files.has(p),
    readFileSync: () => 'var ZCODE_VERSION = true ? "3.14.3" : "0.0.0";',
    readdirSync: () => ["3.14.1", "3.14.4"],
    ...over,
  };
}

describe("buildThinBackendEnv", () => {
  it("passes the whole base env through unchanged", () => {
    const env = buildThinBackendEnv(
      {
        HOME,
        MULTICA_TOKEN: "mat_abc",
        MULTICA_TASK_ID: "t1",
        SOME_API_KEY: "k",
        GITHUB_TOKEN: "g",
      },
      deps(),
    );
    expect(env.MULTICA_TOKEN).toBe("mat_abc");
    expect(env.MULTICA_TASK_ID).toBe("t1");
    expect(env.SOME_API_KEY).toBe("k");
    expect(env.GITHUB_TOKEN).toBe("g");
  });

  it("does not mutate the base env", () => {
    const base = { HOME };
    buildThinBackendEnv(base, deps());
    expect(base).toEqual({ HOME });
  });

  it("builds the profile keys the way zcode-server does", () => {
    const env = buildThinBackendEnv({ HOME }, deps());
    expect(env.ZCODE_RUNTIME_ENV).toBe("production");
    expect(env.ZCODE_BASE_URL).toBe("https://zcode.z.ai");
    expect(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe(
      `${HOME}/.zcode/v2/runtime/provider/linux-x86_64/3.14.3/endpoint-78d7c3bef4024722642626fe3669a799/zcode-builtin.json`,
    );
    expect(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBe(`${HOME}/.zcode/v2/provider_config.json`);
    expect(env.ZCODE_BFS_BINARY).toBe(`${ROOT}/tools/bfs/bfs`);
    expect(env.ZCODE_RG_BINARY).toBe(`${ROOT}/tools/ripgrep/rg`);
    expect(env.ZCODE_UGREP_BINARY).toBe(`${ROOT}/tools/ugrep/ugrep`);
  });

  it("maps arm64 to aarch64 and uses the test origin for ZCODE_ENV=test", () => {
    const env = buildThinBackendEnv({ HOME, ZCODE_ENV: "test" }, deps({ arch: "arm64" }));
    expect(env.ZCODE_BASE_URL).toBe("https://zcode.chatglm.site");
    expect(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toContain("/linux-aarch64/3.14.3/endpoint-");
  });

  it("falls back to the newest provider dir when the bundle version is unreadable", () => {
    const env = buildThinBackendEnv(
      { HOME },
      deps({
        readFileSync: () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toContain("/3.14.4/endpoint-");
  });

  it("skips tool binaries that do not exist", () => {
    const env = buildThinBackendEnv({ HOME }, deps({ existsSync: () => false }));
    expect(env.ZCODE_BFS_BINARY).toBeUndefined();
    expect(env.ZCODE_RG_BINARY).toBeUndefined();
    expect(env.ZCODE_UGREP_BINARY).toBeUndefined();
  });

  it("fills missing base keys and keeps present ones", () => {
    const env = buildThinBackendEnv({ PATH: "/custom/bin", LANG: "C" }, deps());
    expect(env.HOME).toBe(HOME);
    expect(env.USER).toBe("tester");
    expect(env.LOGNAME).toBe("tester");
    expect(env.PATH).toBe("/custom/bin");
    expect(env.LANG).toBe("C");
    expect(env.TMPDIR).toBeTruthy();
  });
});
