# F4 并发与异步竞态审计报告 (zserver backend)

- 审计视角: CONCURRENCY / ASYNC RACES (状态机, 交错)
- 被审对象: /tmp/zacp-snap-033d775 (HEAD = 033d775, 只读快照, 含 dist/)
- 报告文件: /tmp/audit-reports/f4-concurrency.md (事实来源)
- 语言: 中文; 标识符/引用保持原文
- 协议: 每个焦点项完成后立即追加一节; 无法完成者写 "NOT DONE: <原因>"
- 严重度: HIGH / MEDIUM / LOW / UNVERIFIED; 另列 VERIFIED-OK

---

## 0. 进度日志

- [start] 报告文件创建; 尚未读代码。
- [setup] 沙箱: /tmp/audit-f4-aJzWzW (路径另存于 /tmp/audit-reports/.f4-sandbox-path); HOME/XDG_* 均指向沙箱内子目录。
- [setup] 已通读: protocol.ts / channel-client.ts / connection.ts / broker.ts / backend.ts (全文), session.ts heal 循环 (1373-1420, 854-953), server.ts restartBackend/ensureBackend, supervise.ts, fixture 全文。
- [setup] dist 与 src 一致性抽查: dist/backend/zserver/backend.js 含 `retired` 分类; broker.js 含 `socketIdentity`/`this.server = null` (033d775 修复均已编入 dist)。
