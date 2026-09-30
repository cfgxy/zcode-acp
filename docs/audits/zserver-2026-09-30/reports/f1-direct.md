# F1 审计报告: 默认 (DIRECT) 路径回归 — 差分审查

- 视角 (perspective): REGRESSION ON THE DEFAULT (DIRECT) PATH via differential review
- 快照 (snapshot): /tmp/zacp-snap-033d775 (HEAD = 033d775d4ef4009d19ed814d340b40b9c5047075)
- 基线 (base): origin/feat/acp-subcommand-alias = db91aa61b5cc05dfa8c53f30a5e97d0b760f77de
- 日期 (UTC): 2026-09-30
- 报告语言: 中文; 标识符与引用保持原文
- 进度约定: 每完成一个 focus item 立即追加一节; 无法完成则追加 "NOT DONE: <原因>"

---

## 工作笔记 0 (初步, 未完成 Item 1; 防丢失先落盘)

### 构建级事实 (已实测)
- 沙箱: 基线树 `origin/` (git archive + tsc) 与快照树 `new/` (cp -a 快照); 快照自带 dist 与 `tsc` 重新构建结果逐字节一致 (diff -rq 无差异, 75 个 .js)。
- 基线 dist vs 快照 dist 的 **emitted JS 差异文件仅 7 个** (+ 新目录 backend/zserver):
  `cli.js`, `config/personal-provider.js`, `desktop-profile.js`, `handlers/server-requests.js`,
  `handlers/session.js`, `remote/session-close-endpoint.js`, `server.js`。
- 以下文件 emitted JS **逐字节相同** (sha256 相同): `backend/client.js`, `backend/listener.js`, `backend/types.js`,
  `backend/index.js`, `backend/supervise.js`, `backend/resolve.js`, `backend/credentials.js`, `utils.js`, `index.js`
  => `ZcodeBackend` / `EventStreamListener` / `TurnMonitor` 的运行时代码对 direct 路径零改动 (仅 .d.ts 类型变化)。
- `handlers/session.js` emitted diff 只有 1 处真实代码变化 (provider-registry latch 的正则加了 `|not supported in zserver backend mode`) + 2 处注释。
  其余 session.ts 改动 (classified(...) 换行、turnUsageBuckets 类型排版、`backend as ZcodeBackend` 强转) 编译后零代码差异。

### 初判: direct 路径上有运行时行为差异的区域 (待逐项验证)
 (A) desktop-profile.ts: PATH_ENV_KEYS + isTrustedPinPath 进入 isValidEnvValue —— `parseDesktopProfile` / `sanitizeDesktopEnv` /
     `captureDesktopProfile` 全在 direct 路径 (`ensureBackend()` -> `loadDesktopChildEnvWithRefresh()`) 上。
 (B) desktop-profile.ts: findServerAncestor 改用 isRuntimeHostProcess (祖先匹配放宽 + comm 精确匹配收紧)。
 (C) personal-provider.ts: pin 信任收紧(必须 resolve 到 ~/.zcode)、写入改 O_EXCL、新增 warn。
 (D) cli.ts: USAGE 文本、新子命令、`profile refresh` 输出追加 " in <path>"、被拒 pin 的新提示。
 (E) server.ts: 静态 import ZServerBackend (direct 启动也加载整个 zserver 模块图); ensureBackend 读 ZCODE_ACP_BACKEND + warn。
 (F)(G)(H) server-requests 能力守卫 / session.ts 正则 / session-close 可选调用: 预期对 direct 无影响 (待验证)。
