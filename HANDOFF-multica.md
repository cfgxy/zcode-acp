# Handoff:ZCode 接入 Multica(借壳 zcode-acp)交接手册

> 更新:2026-08-28
> 状态:**全链路已跑通**——任务派发、模型切换、prompt 回复、token 记账全部实测通过。
> 分支 `feat/acp-subcommand-alias` 三个 commit 本地未推送。本文档为内部交接备忘(中文),含部署环境细节,向上游提 PR 时请勿携带本文件与 `scripts/acp-handshake-smoke.mjs`。

---

## 1. 背景与架构(为什么是这个形态)

- **multica** 的智能体运行时定义在 `server/pkg/agent/`,三个层级:
  1. 协议族(protocol family)= `SupportedTypes` 白名单(`agent.go:300`,23 个)+ DB CHECK 约束;
  2. 内置运行时身份 = `builtin_runtimes.go` 的 `BuiltinRuntimes`(借已有协议族,如 omp 借 pi);
  3. runtime_profile(MUL-3284)= workspace 级自定义运行时,`protocol_family` 必须落在白名单内。
- **zcode CLI** 对外接口是自有的 `app-server --stdio`(私有方言,line-delimited JSON 且无 `jsonrpc` 字段),**不是** ACP;ACP 是它的历史协议(已废弃,`acp_session_id` 遗留列已迁移清空)。
- **zcode-acp**(本仓库)是第三方桥:拉起 `zcode app-server --stdio`,翻译成标准 ACP(JSON-RPC 2.0 over stdio)。v0.13.0,Apache-2.0,单主力作者(William Wang,91/94 commits)——**有单点维护风险,pin 版本,必要时 fork**。

**接入路线**(评估结论):借壳 `kimi` 协议族 + runtime_profile,零 multica 代码;中期目标是在 multica 加通用 `acp` 协议族"正名"。**借壳是生产可用但非终态**:provider 归账显示为 kimi、重试启发式按 kimi 经验走、multica 演进 kimi.go 会反向影响 zcode。

## 2. 为什么是 kimi 壳(选型依据)

multica 所有 ACP 族 backend 都硬编码厂商 token(`mcode acp`、`hermes acp`、`qodercli --acp`),`command_name` 指向 zcode-acp 后实际启动 `<cmd> acp`,需要一个"额外动作最少"的壳:

- **kimi ✅ 选它**:启动只拼 `"acp"`(`kimi.go:67`),`session/new` 只发标准 `cwd+mcpServers`,resume 走标准 `session/resume`(桥已实现),模型走 session/prompt 响应的 `usage`/`_meta`(见 §4 usage)。
- dim ❌:session/new 后强发 `set_config_option`(permission→full-access)+ `set_model`,是 dim 私有契约。
- mcode ❌:resume 被硬编码为"不支持"(typed rejection),续话能力报废。
- hermes:次选,`--model` 走 CLI flag 解析,摩擦多。

## 3. zcode-acp 分支改动(3 commits,均已过全套测试)

分支 `feat/acp-subcommand-alias`(基于 main):

| commit | 内容 | 关键文件 |
|---|---|---|
| `ad5d20f` | `acp` 子命令 = server 别名(multica 惯例 `<cmd> acp`;额外 argv 与 server 一致直接丢弃) | `src/cli.ts`、`tests/cli.test.ts` |
| `ea77129` | `session/set_model` 路由(multica kimi backend 用旧版 snake_case 拼白发 `{sessionId, modelId}`,缺路由时任务必失败 -32601;handler 本来就有,只缺注册) | `src/index.ts`、`tests/set-model-alias.test.ts` |
| `3900670` | **usage 转发**:multica 从 session/prompt 响应顶层 `usage` 计费(`hermes.go:1374 extractPromptResult`);translator 捕获原始桶(`session.updated`→inputTokens、`turn.completed`→totalTokens),响应带 `usage:{inputTokens,outputTokens,totalTokens,contextWindow}`,`outputTokens = totalTokens − inputTokens`(下限 0,即 multica 归一化器预期的 total=in+out 约定);一次性读取后删 `server.turnUsage` 条目防取消轮次回放旧数 | `event-translator.ts`、`server.ts`、`handlers/session.ts`、`index.ts`、`tests/turn-usage.test.ts` |

> 纠正记录:`usage.record` **不是通知协议**,是 Kimi CLI 的磁盘 wire log 文件格式(`kimi.go:560` 扫文件)。"桥发 usage.record 通知"的思路不成立——最终走的是 prompt 响应 `usage` 字段(grok 同款路径)。

**验证基线**:803/803 测试、lint、typecheck 全绿。线级冒烟脚本 `scripts/acp-handshake-smoke.mjs` 实测响应:
`{"stopReason":"end_turn","usage":{"inputTokens":15959,"outputTokens":3,"totalTokens":15962,"contextWindow":1000000}}`

## 4. 服务器环境变更(全部可逆,重装/换机需重做)

| 项 | 内容 |
|---|---|
| `~/.local/bin/zcode` | 软链 → `~/.zcode/server/agents/glm/zcode.cjs`(桌面端远程模式部署的 agent CLI,0.16.5)。桥的发现链是 PATH `zcode` → 桌面版路径,服务端部署不在其上 |
| 该 zcode.cjs | 已 `chmod +x`(否则 `spawn zcode EACCES`) |
| `~/.zcode/cli/config.json` | CLI 配置。`provider["builtin:bigmodel-coding-plan"]`(用户手工配,enabled:true,open.bigmodel.cn/api/anthropic,六个 GLM 型号)+ <third-party> 两家三方;另有 `zai`(海外,来自 `zcode login`,可删) |
| `~/.zcode/v2/config.json` | **桥读 provider 的唯一来源**(`ZCODE_CREDS_PATH`)。与 cli/config.json 同构,`builtin:` 前缀条目**必须显式 `"enabled": true`** 否则被过滤、multica 裸模型 id 解析失败 |

其他服务器事实:
- multica server 跑在 Docker(`multica-backend-1` / `<multica-postgres-container>` / `multica-frontend-1`,127.0.0.1:8080);daemon 是 brew 的 multica 0.4.29,`--foreground` 常驻,PATH 含 nvm bin(能解析 zcode-acp,无需 set-path)。
- `~/.zcode/server/zcode-server.cjs` 是 IDE 服务端(hello/ack 握手),**不能**充当 CLI;服务器部署**没有** `@zcode/tui`,裸跑/`tui` 子命令必报错,multica 只用 app-server 不受影响。
- `zcode login`(CLI 子命令)**无任何 provider 参数**,只走 z.ai OAuth;`login bigmodel-coding-plan` 等是 **TUI `/login` 斜杠命令**,服务器上不可用。国内版 = 手工配 provider 条目(已配好)。
- usage 看板:`multica runtime usage` 读 `task_usage_hourly`,**整点后封桶,滞后约 1 小时是设计行为**;原始行在 Postgres `task_usage` 表(docker exec <multica-postgres-container> psql -U multica -d multica)。

## 5. multica 侧配置(零代码,已生效)

- **runtime profile**:`<profile-id>`,"ZCode (ACP)",protocol_family=`kimi`,command_name=`zcode-acp`,workspace <workspace>(`<workspace-uuid>`)
- **runtime**:`<runtime-id>` "ZCode (ACP) (<this-host>)",online
- **agent**:`<agent-id>` "ZCode Dev",model=`GLM-5.3-Flash`
- 冒烟 issue:<ws>-85、<ws>-86(均 completed,<ws>-86 回复 "OK" 且 task_usage 有记录)
- 注意:<desktop-host> 也拉到了 profile 注册成 offline runtime;那台要用需同样装桥,不用可忽略

## 6. 已验证 / 未验证

| 接缝 | 状态 |
|---|---|
| `acp` 子命令启动、initialize、session/new | ✅ 实测 |
| set_model(GLM-5.3-Flash 及目录内任意型号) | ✅ 实测 |
| prompt 轮次 + 回复评论 + 任务完成 | ✅ <ws>-85/86 |
| token 记账(task_usage) | ✅ 44341/261509 已入库 |
| runtime usage 看板 | ⏳ 小时桶滞后,~02:05 后应显示 01:00 桶 |
| session/resume 续话 | ⏳ 未实测;桥声明 loadSession:true,在同一 issue 跟帖派任务即触发 |
| 缓存桶细分(cache_read/write) | ⚠️ zcode 上游不提供,恒为 0;计费精度受限,上游数据源问题非桥问题 |

## 7. 快速命令速查

```bash
# 重跑线级冒烟(initialize → session/new → set_model → 真实 prompt,打印原始响应)
timeout 150 node scripts/acp-handshake-smoke.mjs "node dist/cli.js" "GLM-5.3-Flash"

# 派测试任务
multica issue create --workspace-id <workspace-uuid> \
  --title "..." --assignee "ZCode Dev" --description "..."
multica agent tasks <agent-id> --workspace-id <workspace-uuid>
multica runtime usage <runtime-id> --workspace-id <workspace-uuid>

# 查原始 usage(绕过小时汇总)
docker exec <multica-postgres-container> psql -U multica -d multica \
  -c "SELECT * FROM task_usage ORDER BY created_at DESC LIMIT 5;"

# 桥改代码后的生效方式:pnpm build 即可(zcode-acp 软链 → dist/cli.js,daemon 每任务新拉进程)

# 排查任务时间线
grep -a "<task_id前缀>" ~/.multica/daemon.log
```

## 8. 终态路线(建议,未开工)

1. **multica 通用 `acp` 协议族 PR**(正名):新 `server/pkg/agent/acp.go`(参照 mcode.go 368 行去厂商化)+ `SupportedTypes`/`New()`/`launchHeaders` + CHECK 迁移(照 migration 370 dim 先例)+ 前端 `RUNTIME_PROFILE_PROTOCOL_FAMILIES`(`packages/core/types/agent.ts`)加项;usage 改从标准 usage_update 解析后,桥可去掉本分支的响应 usage(或保留,兼容无害)。切正名 = profile 的 `protocol_family` 改一行。
2. **zcode-acp 分支推送/上游 PR**:三个 commit 独立干净,可直接 PR;单作者项目,建议同时自维护 fork。
3. **resume 实测**:同一 issue 追问一次,确认 session/resume 续话与 `Result.ResumeRejected` 行为。

## 9. 关键文件索引

| 文件 | 作用 |
|---|---|
| `src/cli.ts` | 子命令分发(`acp` 别名在这) |
| `src/index.ts` | ACP 方法注册(set_model 路由、prompt usage wrapper) |
| `src/handlers/session.ts` | prompt 轮次循环、attachTurnUsage、turnUsageBuckets |
| `src/handlers/extensions.ts:207` | setModel handler(applyModelSwitch) |
| `src/config/options.ts` | provider 目录、DEFAULT_PROVIDER_ID、isBuiltinProvider(`builtin:` 前缀)、parseModelValue |
| `src/backend/resolve.ts` | zcode CLI 发现链(ZCODE_BIN → PATH → 桌面路径) |
| `docs/PROTOCOL.md` | 桥↔zcode 内部协议全文 |
| `scripts/acp-handshake-smoke.mjs` | 线级握手/轮次冒烟(本手册 §7) |
| multica `server/pkg/agent/kimi.go` | 借壳的 kimi backend(set_model 调用点 :301、usage 组装 :447-507) |
| multica `server/pkg/agent/hermes.go:1374` | extractPromptResult(usage 计费入口) |
| multica `server/pkg/agent/acp_usage.go` | usage 字段解析/归一化(inputTokens 歧义、total=in+out 约定) |
| multica `server/internal/handler/runtime_profile.go` | profile CRUD 服务端 |
| multica `server/cmd/multica/cmd_runtime_profile.go` | profile CLI(两级命令 `runtime profile`) |
