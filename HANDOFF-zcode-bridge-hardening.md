# Handoff：zcode-acp 桥侧加固（记账正确化 + 后端韧性）

> 更新：2026-08-29。写给接手 zcode-acp 桥改造的人。**Owner 已裁决（2026-08-29）：现阶段不动 multica 服务端代码**，所有问题在桥侧补齐。因此本文档范围仅限 `/home/guxy/Codes/offcial/zcode-acp` 仓库 + 服务器环境；multica 侧的正名方案勘察成果压缩保存在 §6 附录（已冻结，勿实施，勿删除——将来解冻时直接用）。
>
> 前置必读：同目录 `HANDOFF-multica.md`（借壳 kimi 方案现状、桥的 3 个既有 commit、服务器环境变更清单）。两份文档关系：那篇讲"怎么接进来的"，这篇讲"接进来之后发现的坑怎么在桥内修掉"。

## §0 开场白（写给后辈的信）

- 现状：桥（分支 `feat/acp-subcommand-alias`，commits `ad5d20f`/`ea77129`/`3900670`）已生产运行约 1 天，58 个 run 全链路可用。但暴露了三类问题：**token 记账失真**、**zcode 后端进程死亡导致任务 failed**、**缓存桶缺失**。本任务在桥内解决前两类、明确标记第三类。
- 已完成：借壳全链路、smoke 脚本、生产验证。multica 服务端零改动（这是裁决，不是遗留）。
- 你接手后第一件事：读 §1 的问题证据和 §2.1 的代码定位，然后按 M0 做语义实证——**在没有实证数据前禁止改 `turnUsageBuckets` 的语义**，这是本任务唯一的坑。

## §1 问题清单（全部有生产证据）

| # | 问题 | 证据 | 桥内可解 |
|---|---|---|---|
| P1 | output token 记账数量级失真 | SHAN-38 单 Issue multica 记账 input 1,901,442 / "output" 83,938,841（不可能；9 个 run）；全窗口 58 run 的 output 列全部不可信 | ✅ 已修（§5 M0/M1，2026-08-29） |
| P2 | cache_read 全 0 | 窗口期 58 run `cache_read_tokens=0`（对照组：Claude 运行时同期 87 万~190 万/run） | ✅ 已修（实证推翻"后端不提供"：cacheRead/Write 桶存在并已转发，§5 M0/M1） |
| P3 | zcode 后端进程死亡 → 任务 failed | SHAN-38 run `2026-08-28T20:46` 报 `session/resume: zcode backend reader exited (backend dead)`；SHAN-83 run `2026-08-29T00:35` failed，`00:37` 报 `session/resume: zcode backend reader exited (backend dead)`（kimi 供应商字样是借壳表现，真实故障是桥管理的 zcode 子进程退出） | ✅ 已修（§5 M2，监督自愈） |
| P4 | 后端启动失败无重试 | SHAN-38 run `2026-08-28T20:54` 报 `session/set_model: zcode create failed: zcode backend reader exited` | ✅ 已修（§5 M2，create 路径纳入监督） |
| P5 | runtime 零 skills 加载 | zcode 运行时 skills 目录缺失，窗口期智能体裸跑（反而效果很好，见 §2.4 说明） | ⚠️ 不是桥代码；属环境任务，见 §2.4，Owner 裁决 |
| P6 | provider 归账显示 kimi | multica 按 protocol_family 归账，桥无法改变 | ❌ 桥外，已冻结（§6） |

## §2 技术方案

### 2.1 P1 记账正确化

**代码定位（已勘察）**：

- `src/handlers/session.ts:1938` `turnUsageBuckets()`——当前实现：`inputTokens = raw.inputTokens ?? 0`，`outputTokens = Math.max(0, totalTokens − inputTokens)`。`:1931-1934` 注释说明了假设："`session.updated` carries cumulative inputTokens, `turn.completed` carries totalTokens — no outputTokens, no cache split"。
- `src/translators/event-translator.ts:53-60`（桶来源注释）、`:148-152`（session.updated → inputTokens）、`:334-338`（turn.completed → totalTokens，`||` 容错 fallback 到 `payload.tokenCount`）。
- `src/server.ts:170-172` `turnUsage` Map；`src/handlers/session.ts:1380-1383` translator 镜像写入。

**失真根因假设（M0 实证前不得当结论）**：`session.updated` 的 inputTokens 与 `turn.completed` 的 totalTokens **采样时机/语义不一致**（一个可能是会话级累计、一个可能是当轮累计，或跨 resume 后基准漂移），差值被 multica 当作 output 累加后爆炸。**先实证再修**：

- M0 做法：在 `event-translator.ts` 两条桶捕获点加 debug 日志（环境变量 `ZACP_USAGE_DEBUG=<path>` 时逐事件追加 JSON 行：时间、acp session id、事件名、原始桶）。跑一个真实 multica 任务（建议 SHAN-39 这种 10 run 量级的收尾任务），同时用 `multica issue runs <KEY> --output json` 拉对照。产出一张语义表：每个事件桶的真实含义（当轮/累计、是否含 output、resume 后是否清零）。
- M1 修法（按实证结果二选一，默认推荐 a）：
  - a) **差分累计**：桥内维护会话级 `lastTotal`，每轮 `turn_output = totalTokens_now − lastTotal − turn_input`（下限 0），跨轮累加；`inputTokens` 上报当轮增量。resume 后 `lastTotal` 用 resume 后第一条 `session.updated` 重新锚定。
  - b) 若实证发现 zcode 其实每轮给真实 output 桶（藏在 `_meta`/`tokenCount` 等字段）→ 直接转发，删掉差值凑数。
- 出口标准：一个 10+ 轮的真实任务，multica 记账 input/output 与人工估算偏差 <20%，且 output 不再出现数量级异常；`tests/turn-usage.test.ts` 用 M0 采集的真实桶序列做 fixture。

**P2 的处理**（⚠️ 本段假设已被 M0 实证推翻，实际做法见 §5）：后端**确实提供** `cacheReadTokens`/`cacheWriteTokens` 桶（session.updated 逐调用、turn.completed 当轮聚合），桥已原样转发（真实 0 也是真数据）。README"Token metering"节登记了最终语义。仍然禁止伪造缓存数。

### 2.2 P3/P4 后端韧性（桥内监督自愈）

现状：zcode 子进程死亡后，桥把 `session/resume`/`session/prompt` 的失败原样抛给 multica，multica 判任务 failed（那次 SHAN-83 收尾任务 failed 后靠 QA 人工发现并让 Leader 手动恢复）。

桥内方案（桥是 Session Authority，有条件自愈）：

1. **后端监督**：桥已有 backend 子进程管理（`src/backend/`）。加死亡探测：`reader exited` / `spawn 失败` / stdin stdio 断开时，不立即向上抛错，先进入自愈流程。
2. **自愈流程**：指数退避重启 backend（如 1s/4s/16s，上限 3 次）→ 成功后对活跃 ACP session 逐个执行 `session/resume`（zcode 支持，借壳方案已验证）→ resume 成功则把挂起的 turn 结果以正常路径返回；resume 失败（会话真丢了）才向 multica 报错。
3. **错误分类透传**：最终向上抛的错误消息加稳定前缀 `zcode_backend_dead_after_retry` / `zcode_session_lost` / `zcode_spawn_failed`，让 multica kimi.go 现有重试启发式能区分"可重试的基础设施错误"与"永久失败"，也让人从日志一眼分清桥故障与模型故障。
4. **边界**：自愈只覆盖"后端进程死亡/启动失败"；模型 provider 侧错误（GLM API 5xx 等）原样透传不重试（multica 已有重试）；重启后若 `session/resume` 成功但上下文与中断前不一致，必须报错而非静默继续——禁止静默丢上下文。

出口标准：两个复现用例进测试——①turn 进行中 `kill -9` zcode 子进程，桥自愈后任务正常完成；②重启后 session 真丢失，multica 收到带 `zcode_session_lost` 前缀的明确错误（而不是 hang 到超时）。

### 2.3 smoke 脚本扩展

`scripts/acp-handshake-smoke.mjs` 现在只断言握手和 usage 字段存在。扩展两个断言：①连续两轮 prompt 后 `totalTokens ≥ inputTokens` 且 `outputTokens < totalTokens`（防数量级回归）；②模拟 backend 重启后 `session/resume` 能恢复会话（可注入环境变量让桥的 backend 启动脚本指向一个会自杀的 wrapper）。保持脚本无外部依赖、单文件可跑。

### 2.4 P5 skills 目录（环境任务，桥外，需 Owner 裁决后执行）

事实：zcode 运行时窗口期零 skills 加载，实测**效果很好**（开发→Review→QA 多单一遍过、每 run 上下文约 25 万 vs Claude 运行时 81 万~270 万）。因此**不建议原样恢复全量 skills**。若要补，推荐最小集（放服务器 `~/.zcode/skills/`，zcode CLI 自动加载）：`guxy-evidence-bugfix`、`huayuebridge-deploy`、`multica-working-on-issues`、`multica-mentioning`、`docker-essentials` 五个以内，宁少勿多。这是 Owner 决策项，不阻塞 M0~M3。

## §3 任务分解

| 里程碑 | 内容 | 入口条件 | 出口条件 | 预估 |
|---|---|---|---|---|
| M0 | usage 语义实证（§2.1 M0 做法） | 桥本地可跑测试（基线 803/803） | 语义表写入 §5 执行记录 | 0.5 天 |
| M1 | `turnUsageBuckets` 修正 + 真实 fixture 测试 | M0 完成 | 出口标准见 §2.1；全量测试绿 | 1 天 |
| M2 | 后端监督自愈（§2.2） | 与 M0/M1 并行可行 | 两个复现用例过；SHAN-83 式任务不再 failed | 1~2 天 |
| M3 | smoke 扩展（§2.3） | M1、M2 完成 | 新断言全过 | 0.5 天 |
| M4 | （Owner 裁决后）最小 skills 部署 | Owner 选定清单 | 窗口式验证：1 个真实任务确认技能触发且无退化 | 0.5 天 |

决策树：

- M0 实证发现桶语义与 §2.1 两种假设都不符 → 把真实语义写进 §5，按"桥内能拿到的最准确口径"实现，原则不变：**input/output 必须各自语义稳定、可跨 run 累加**。
- M2 自愈后 multica 仍显示 failed → 检查错误分类前缀是否被 kimi.go 的重试路径正确消费；若 kimi.go 对非 kimi 错误串一律不重试 → 记录到 §5 并上报 Owner（这属于借壳的已知局限，桥内无解，不要绕）。
- 桥上游（William Wang）发新版本 → 先不升级；本任务完成前 pin 现版本。升级评估留到 §6 解冻时一起做。
- 任何改动需要动 `src/backend/` 之外的 zcode CLI 本体 → 方向错误（桥是隔离层），停下重读 §1。

## §4 关键产物索引

| 项 | 路径 |
|---|---|
| 桥仓库 | `/home/guxy/Codes/offcial/zcode-acp`，分支 `feat/acp-subcommand-alias`，5 commits（`ad5d20f`/`ea77129`/`3900670`/`f216426`/`46237a9`，后两个为文档） |
| 记账核心 | `src/handlers/session.ts` `turnUsageBuckets()`（真实分桶优先 + degraded fallback）；桶捕获 `src/translators/event-translator.ts`（session.updated 逐调用 / turn.completed 当轮聚合） |
| 语义证据 | `tests/fixtures/usage-probe-events.jsonl`（zcode 0.16.5 原始采集）；再采集用 `scripts/usage-semantics-probe.mjs`；仪表开关 `ZACP_USAGE_DEBUG=<path>`（`src/translators/usage-debug.ts`） |
| 监督自愈 | `src/backend/supervise.ts`（分类器+前缀）；`src/backend/client.ts` `restart()`；`src/handlers/session.ts` `healBackendAndReload()` / `createBackendSessionWithHeal()`；`src/index.ts` 死亡轮询器（`server.backendHealing` 门控）；测试 `tests/backend-heal.test.ts` |
| 后端管理 | `src/backend/`（监督自愈改这里） |
| smoke 脚本 | `scripts/acp-handshake-smoke.mjs` |
| 测试基线 | `tests/`（803/803 全绿为改造前置） |
| 服务器 zcode CLI | `~/.local/bin/zcode` → `~/.zcode/server/agents/glm/zcode.cjs`（0.16.5）；provider 配置 `~/.zcode/cli/config.json` 的 `builtin:bigmodel-coding-plan`（open.bigmodel.cn/api/anthropic） |
| 借壳现状 | 同目录 `HANDOFF-multica.md` |
| 记账对照命令 | `multica issue runs <KEY> --output json`（usage 按 run 分组；注意借壳期 output 列失真，M1 修复前仅 input 列可信） |
| 生产证据 | SHAN-38 runs `2026-08-28T20:46`、SHAN-83 run `2026-08-29T00:35`（P3/P4）；SHAN-38 aggregate usage（P1）；全窗口 58 run cache=0（P2） |

## §5 任务执行记录（后续追加，格式：日期 — 做了什么、结论、下一步）

- 2026-08-29 — 交接书成文（ Owner 裁决：不动 multica，桥侧补齐）。当前状态：M0 待启动。语义实证数据出来后，把"session.updated inputTokens = ?；turn.completed totalTokens = ?；resume 后是否清零"三行结论补在本条下方。
- 2026-08-29（同日第二次会话）— **M0 语义实证完成**（工具：`ZACP_USAGE_DEBUG` 全量 payload 采集 + `scripts/usage-semantics-probe.mjs` 真实多轮探测；原始证据存 `tests/fixtures/usage-probe-events.jsonl`）。三问答案：
  - **session.updated 的 inputTokens = 逐模型调用的输入**（≈该次调用发送的上下文占用）。每调用伴随两条 session.updated 变体（provider-usage 型 / content 型），usage 值相同；除 inputTokens 外还带该次调用的 outputTokens、totalTokens、cacheReadTokens、cacheWriteTokens。
  - **turn.completed 的 totalTokens = 当轮所有模型调用的 in+out 总和（gross）**，每轮重置、非会话累计。其 usage 完整对象：`{source:"provider", modelRequestCount, inputTokens(Σ各调用), outputTokens(Σ真实输出), totalTokens(=in+out), cacheReadTokens, cacheWriteTokens, reasoningTokens, …}`。实测 2 调用轮：19848+20005=39853=in ✓、136+10=146=out ✓。
  - **resume 后不涉及清零问题**：turn.completed 本来就每轮独立；重启+resume 后第一轮 input=完整历史上下文（实测 19994≈全部历史）。
  - **P1 根因确认**：旧公式 output = gross_total − context_occupancy，在多调用轮次把 (n−1) 次中间调用的输入记成输出（实测单轮虚增 19994≈1×上下文），长会话按轮累加 → 83M 爆炸。
  - **P2 判断被实证推翻**：zcode 后端**提供** cacheReadTokens/cacheWriteTokens（实测 cacheRead 0~2 万/调用，随命中变化），不再是"只能置 0"。
- 2026-08-29 — **M1 记账修正完成**：`turnUsageBuckets` 优先转发 turn.completed 的真实分桶（in/out/total/cacheRead/cacheWrite，total=in+out 满足 multica 归一化约定）；仅在后端不提供 output 桶时退回旧推导（标注 degraded）。上下文条改用占用值（session.updated 的 inputTokens），不再被 gross 总量撑爆 ~n×。`tests/turn-usage.test.ts` 用真实采集数值做 fixture（含 2 调用轮聚合、上下文条占用、降级路径）。真实后端复验：3 轮会话响应 usage 均为真实分桶（工具轮 `in=39768/out=102/cacheRead=29952`，修复前该轮会报 out≈19900）。
- 2026-08-29 — **M2 后端监督自愈完成**：`ZcodeBackend.restart()` 就地重启（listener/monitor 引用不失效）+ `healBackendAndReload()`（退避 1s/4s/16s 型、3 次；重启→重推 provider registry→session/resume 重载→模型修复）+ 稳定错误前缀 `zcode_backend_dead_after_retry` / `zcode_session_lost`（Session not found 实测分类，不重试）/ `zcode_spawn_failed`。接入四路径：ACP resume/load、lazy create（P4）、prompt send、**turn 进行中死亡**（500ms 内探测 → heal → 重发，走既有 transient 重试环）。过程中修掉三个真问题（各有 smoke 失败为证）：① `runEventTurn` 开头 `ensureBackend()` 会在死亡后抢答拉新进程、掩盖死亡（正是 P3 拖 120s 的行为）；② `index.ts` 的 2s 死亡轮询器直接关停整桥，与自愈竞态——已加 `server.backendHealing` 门控（heal 彻底失败才允许关停）；③ heal 重载后未重推 provider registry，重发报"历史任务使用的模型已不可用"。复现用例 `tests/backend-heal.test.ts`（5 个）：①kill -9 式死亡→heal→任务完成；②session 真丢失→`zcode_session_lost` 前缀且不重启；③重启后丢失→同前缀；④create 死亡→重启重试；⑤heal 耗尽→`zcode_backend_dead_after_retry`。
- 2026-08-29 — **M3 smoke 扩展完成并真实跑通**：`scripts/acp-handshake-smoke.mjs` 新增断言——连续两轮 total≥in、out<total、trivial 轮 out 不超 in、total=in+out 不变式；kill -9 zcode 后端（工具轮进行中）→ 桥自愈 → 任务 `end_turn` 完成（实测响应 `in=41548/out=47`，为两次发送的真实聚合）；kill 后 `session/resume` 正常。无外部依赖单文件。
- 当前状态：**814/814 测试全绿**（基线 803 + 11 新增），lint/typecheck/build 绿。本机即 multica 服务器（`/home/guxy/Codes/offcial/zcode-acp` 是指向本仓库的软链），`pnpm build` 后 daemon 每任务新拉进程，**修复已对生产生效**。
- 下一步：① 下一个真实 multica 任务完成后用 `multica issue runs <KEY> --output json` 对照 output 列（应回落到百级/千级，cache 列若被读取应非零）；② 观察 kimi.go 重试启发式对 `zcode_*` 前缀的实际消费（§3 决策树分支）；③ M4（最小 skills 部署）仍等 Owner 裁决，不阻塞。

## §6 附录：multica 正名方案（已冻结，勿实施）

Owner 2026-08-29 裁决现阶段不改 multica。以下勘察成果已核实、解冻时可执行，防止重复劳动：

- multica 运行时三层架构：`server/pkg/agent/agent.go:300` `SupportedTypes`（23 族）+ DB CHECK 约束（新增协议族必须同步 migration）；`builtin_runtimes.go` 内置身份；runtime_profile（MUL-3284）workspace 级。当前 zcode 借 `kimi` 族 profile（runtime_id `13323a2e-09b4-4eee-89b5-a8bb03d1de62`）。
- 正名路线：加 `acp` 协议族（白名单 + migration）→ 新建 `server/pkg/agent/acp.go`（对照 kimi.go 接口面：new/prompt/resume/set_model/cancel/usage，usage 从 prompt 响应顶层取，归一化约定 total=in+out 的出处是 `hermes.go:1374 extractPromptResult`）→ `builtin_runtimes.go` 注册 `zcode`（provider 字段定 `"zcode"`）→ 迁移 8 个 agent，kimi 壳 profile 保留作回退。
- 借壳债（正名时一并解决）：provider 归账显示 kimi；重试启发式按 kimi 经验；output 失真的 multica 侧归一化耦合。
- 已否决方案（勿重开）：dim 壳（session/new 后强发私有 set_config_option）、mcode 壳（resume 硬编码不支持）、hermes 壳（--model 走 CLI flag 摩擦大）、"usage.record 通知协议"（不成立，那是 Kimi CLI 磁盘 wire log 格式，`kimi.go:560` 扫描）、改 zcode CLI 适配 multica（方向反了）。
- 决策点（解冻时问 Owner）：DB migration 范围；桥仓库是否 fork（当前 v0.13.0 单主力作者，pin 版本）；provider 命名 `zcode`（推荐）vs `acp`；灰度策略。
