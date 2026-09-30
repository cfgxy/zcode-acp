# f5-security — zserver 后端最终代码（HEAD 033d775）安全复测报告

- 审计视角：SECURITY RE-TEST（信任边界 / 文件系统与进程卫生 / 拒绝服务）
- 被审快照：`/tmp/zacp-snap-033d775`（只读；源码 + 已构建 dist/）
- 审计起始时间：见下方各节时间戳；所有实验均在 `/tmp/audit-f5-*` 沙箱内完成，HOME/XDG_* 指向沙箱，仅使用合成假值 `DUMMY-NOT-A-KEY`
- 语言：中文；标识符、引用原文保持 verbatim
- 严重度：HIGH / MEDIUM / LOW / UNVERIFIED，并逐项标注「威胁模型内 / 外」
- 威胁模型（docs/adr/0008 「安全模型」、SECURITY.md）：跨 uid 由 socket 权限隔离；真正的对手是「同 uid 受限主体」（沙箱 app / 只写受限的 agent / 仅能 exec 的工具子进程）——自身没有凭据/exec 能力，但可能通过 broker 或 profile/pin 处理获得。同 uid 且拥有完整文件写权限的代码执行 = 范围外。

---

## 进度总览（随各项完成时追加）

| 项 | 状态 |
| --- | --- |
| Item 1 broker 信任边界 | 进行中 |
| Item 2 文件系统相关代码 | 待办 |
| Item 3 env/进程/日志卫生 | 待办 |
| Item 4 DoS 清单与实测 | 待办 |

---
