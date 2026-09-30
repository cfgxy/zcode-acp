# zserver 深审报告存档（2026-09-30）

本目录保存针对 `feat/acp-subcommand-alias` 未推送系列（23 个提交，最终 HEAD `033d775`）
多轮高强度审计的**全部报告原件**与**实验脚本**。报告为审计员当时的原文快照（含已被
后续修复推翻的结论），阅读时以下方"结果去向"列为准；修复的最终事实以
`docs/adr/0008-zserver-stdio-backend.md` 为准。

审计约定（对所有轮次生效）：报告先落盘再逐项追加；审计员不得修改仓库；实验只在
/tmp 沙箱内做并清理；不读取/不打印任何 API key 或 token 的值；未复现的结论一律标注
UNVERIFIED；每条修复都要做变异验证（备份 → 变异 → 跑 → 按拷贝还原，不 `git checkout`）。

## reports/ — 审计报告

| 报告              | 视角                    | 审计对象     | 状态                             | 结果去向                                                                                                                                                               |
| ----------------- | ----------------------- | ------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| protocol.md       | 线协议/字节保真         | 4cfa1d3      | 完成                             | 原型键一帧杀 broker（E1a/E1b）→ 已修（`Object.hasOwn`）                                                                                                                |
| concurrency.md    | 并发/异步竞态           | 4cfa1d3      | 完成（focus 1）                  | inFlight 守恒、idle 不误杀；两个 LOW 后续处理                                                                                                                          |
| mutation.md       | 变异战役 + 测试自审     | 4cfa1d3      | 完成                             | M/X 清单；X10/X27/X28 的 killer 在 033d775 补齐，X23 实为 592c65c 已覆盖                                                                                               |
| realserver.md     | 真 server 实测          | 4cfa1d3 时代 | 完成                             | `listTasks` 裸数组、V4 订阅 103 后仍 OWNED、closeTask 跨客户端 → 全部已修                                                                                              |
| sec-a.md          | 安全（第一视角）        | b2c943c      | 完成                             | 退化 HOME 信任所有路径、provider 写入跟随符号链接 → 已修；同 uid pin 缺口入档威胁模型外                                                                                |
| sec-b.md          | 安全（第二视角）        | b2c943c      | **空**（中断）                   | 其高危项（fd 耗尽、server error 持久监听）由主会话亲自完成                                                                                                             |
| ops.md            | SRE/可运维性            | 多轮         | 完成                             | 演练 1-9 全记录；8-A2 trim、8-B 优先级、8-D1 双 broker、8-D3 空闲自退 → 033d775 修；E1-E3 静默降级/15s 卡顿 → 仍开（ADR"仍未处理"）                                    |
| w2-concurrency.md | 二波并发                | 592c65c      | 完成（focus 1/2/5）              | create 中途失败残留 → 033d775 修；queued 残留 → 有界不修（已记录）                                                                                                     |
| w2-errors.md      | 二波错误分类            | 592c65c      | 完成                             | 在途请求分类、EMFILE/EAGAIN、超时注释 → 033d775 修；`void sendSessionUpdate`（上游代码）→ 不动                                                                         |
| w2-protocol.md    | 二波协议复测            | 592c65c      | 部分                             | 原型键修复 420 组合 + 真 broker 24 帧复测通过；id 上界分析未交付                                                                                                       |
| f1-direct.md      | direct 默认路径回归差分 | 033d775      | **被叫停**（差分构建事实已完成） | 已证实：direct 运行时 emitted JS 仅 7 文件有差异且均有意为之，client/listener/types/supervise 逐字节相同；desktop-profile/personal-provider/cli/server 的 A-H 项未验完 |
| f2-docs.md        | 文档↔代码↔bundle 契约   | 033d775      | 被叫停（仅索引）                 | 无发现                                                                                                                                                                 |
| f3-protocol.md    | 协议模糊测试            | 033d775      | 被叫停（仅头部）                 | 无发现                                                                                                                                                                 |
| f4-concurrency.md | 并发状态机              | 033d775      | 被叫停（通读完成，无发现）       | 确认 033d775 修复均在 dist 中                                                                                                                                          |
| f5-security.md    | 安全复测                | 033d775      | 被叫停（仅进度表）               | 无发现                                                                                                                                                                 |
| f6-soak.md        | 长跑泄漏/测试卫生       | 033d775      | 被叫停（仅头部）                 | 无发现                                                                                                                                                                 |
| f7-e2e.md         | 真实 bridge 混沌演练    | 033d775      | 被叫停（仅头部）                 | 无发现                                                                                                                                                                 |

f1-f7 于 2026-09-30 由所有者叫停（判断为边际收益过低），未跑出实质发现即终止。

## experiments/ — 实验脚本与道具

- `mutation-harness/`：变异审计全套（`mutants.mjs` 变异定义、`run-mutant.mjs` 单变异
  执行器、`kill-matrix.sh` 幸存者复跑、`zserver-mutation-killers.test.ts` 27KB killer
  测试，以及 033d775 轮使用的 `run-mut2.sh`）。用法见 `mutants.mjs` 头注释。
- `broker-race/`：ADR"第十二轮"引用的复现脚本——`race.mjs`（两个 broker 抢同一陈旧
  socket，双赢家率 16/60 的测法）、`fsprobe3.mjs`（冷/热进程的 inode 号复用探针，
  xfs 2/60、tmpfs 0/60）、`reuse.mjs`（最早的顺序探针，未复用，仅留档）。
- `ops-probes/`：ops.md 演练 9（状态探针可行性）与退出码扩展的实证脚本。

## 一页结论（2026-09-30 收敛时点）

- 二波审计（w2-*）之后新发现仅剩 LOW，全部修复或如实入档（ADR"仍未处理"）。
- 033d775 修掉的最后一批：双 broker 抢同一陈旧 socket 双赢家（根因含 inode 号复用）、
  在途请求被 restart 切断的分类、`session/create` 中途失败残留、EMFILE/ENFILE/EAGAIN
  分类、`ZCODE_SERVER_RUNTIME_ROOT` 空值与优先级、broker 空闲自退无声、X10/X27/X28 killer。
- 仍未修（有意保留，均已在 ADR 入档）：broker 无 per-client 会话隔离、看门狗 pgid 复用
  窗口、aborted 调用留在 `queued`、无状态探针/日志无时间戳/退出码不区分"已在运行"、
  静默降级与 wedged broker 的 15s 等待、二次 SIGTERM 残留 socket 文件、同 uid pin 缺口、
  `void sendSessionUpdate` 无 `.catch`（上游代码）。
