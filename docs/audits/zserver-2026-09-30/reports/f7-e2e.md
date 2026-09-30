# F7 端到端混沌演练报告 (E2E chaos drills, REAL bridge process)

- 审计对象: zcode-acp-server, 23 个未推送 commit, final HEAD = 033d775
- 快照: /tmp/zacp-snap-033d775 (只读; 从其 dist/ 运行 bridge/broker)
- 基线: origin/feat/acp-subcommand-alias
- 视角: 真实 bridge 进程的故障注入 / 进程生命周期 / 孤儿进程检测
- 开始时间 (UTC): 2026-09-30T07:08Z
- 状态: 进行中 (每个场景结束后立即追加)

约定: 标识符/引用保持原文; 发现的严重度 HIGH/MEDIUM/LOW/UNVERIFIED; 另列 VERIFIED-OK.

---

## 0. 准备工作 (进行中)

