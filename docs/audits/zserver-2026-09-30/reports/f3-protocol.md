# F3 审计报告 — WIRE-PROTOCOL BYTE FIDELITY 与 FUZZING

- 审计视角: 线协议字节保真度 + decoder 健壮性 + broker 崩溃安全
- 审计对象快照: /tmp/zacp-snap-033d775 (HEAD = 033d775, 只读)
- 审计者沙箱: (见各节; 结束时删除)
- 报告语言: 中文; 标识符/引用保持原文
- 状态: 进行中 (每完成一个 focus item 立即追加)

2026-09-30T07:08:34Z

- 沙箱: /tmp/audit-f3-VRhcBal1 (结束时删除; 路径记录于 /tmp/audit-reports/.f3-sandbox-path)
- 快照不是 git 仓库 (snapshot 无 .git), 故只读源码 + dist; Node v22.22.3
- 真实 server bundle: ~/.zcode/server/zcode-server.cjs (11541169 bytes) — 仅用 grep -n / sed -n 窄读, 不打印 > 60 行
