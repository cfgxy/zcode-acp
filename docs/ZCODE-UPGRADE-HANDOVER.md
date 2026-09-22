# ZCode 升级交接文档（0.16.5 → 0.16.9 实战记录）

> 2026-09-21，zcode 桌面端/CLI 从 0.16.5 一路升级到 0.16.9（桌面 App 3.14.1），
> zcode-acp 与本机 ZCode 环境出现一整条连锁故障。本文档记录全部根因、修复与
> **下次 zcode 升级时的标准操作流程（SOP）**。所有结论均经实测验证，证据在
> 会话记录与本仓库测试中。

## TL;DR（下次 zcode 升级后的 SOP）

1. `zcode-acp profile refresh`（重抓桌面端进程环境变量）。
2. 若 backend 启动即死（`reader exited (stdout closed)` ×3 自愈失败）：
   对比 `/proc/<zcode-cli-pid>/environ` 与精简 spawn 环境，把**新增的必备环境变量**
   加进 `src/desktop-profile.ts` 的 `DESKTOP_PROFILE_ENV_KEYS`，重建 dist，再 refresh。
3. `pnpm typecheck && pnpm test && pnpm build`，然后跑
   `scripts/` 里的 bridge 探针验证 initialize + session/new。
4. 机器本地修复（repo 之外，升级会被覆盖，需重做）：
   - `python3 scripts/patch-zcode-tui-modellist.py`（TUI /model 列表显示）
   - `bash scripts/assemble-zcode-tui-runtime.sh <桌面App版本>`（裸 `zcode` TUI，可选）
   - 检查 `~/.zcode/v2/provider_config.json` 的 GLM 个人套餐条目是否还在（见下文）
5. 有真实对话后观察 usage/上下文条是否正常（turn 事件语义未回归验证，见"未验证项"）。

---

## 一、症状 → 根因 → 修复（本轮全部故障）

### 症状 A：backend 启动即死

```
[zcode-acp] backend: reader exited (stdout closed)
[zcode-acp] heal: create retry 1/3 failed: zcode backend reader exited (backend dead)
（×3 后 bridge 退出）
```

- **根因**：新版 zcode CLI 靠环境变量定位 provider 配置文件，桌面端拉起的进程带这些
  变量，bridge 精简 spawn 不带，CLI 启动即退出（stderr 一行
  `无法定位 CLI ZCode Built-in Provider Config：…`）。
- **修复**：`DESKTOP_PROFILE_ENV_KEYS`（`src/desktop-profile.ts`）加入
  `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`、`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`，
  重建后 `zcode-acp profile refresh` 从活进程重抓。
- **诊断套路（下次新变量重复此法）**：
  ```bash
  # 活着的桌面端 CLI 进程环境（真源）
  tr '\0' '\n' < /proc/$(pgrep -x zcode-cli | head -1)/environ | grep -E '^ZCODE|^ZAI'
  # 复现 bridge 的精简 spawn，逐个变量做增减对照试验
  ```
- **注意**：环境变量路径带版本号（如 `…/linux-x86_64/3.14.1/endpoint-<hash>/…`），
  **每次升级都会变**——这正是 profile refresh 机制存在的原因，白名单加键是一次性的。

### 症状 B：/model 切换失败（协议漂移）

```
Invalid params — (root): Unrecognized key: "runtimeModel"
provider-registry: sync failed: Method not found: workspace/updateProviderRegistry
```

- **根因**：0.16.9 协议大改（详见第二节协议事实表）。`runtimeModel` overlay 从协议中
  **彻底移除**；`workspace/updateProviderRegistry` 与 `session/updateRuntimeModelConfig`
  两个 RPC 删除；provider 注册改为 backend 从自己的文件读取。
- **修复**（本仓库，已提交）：
  - `applyModelSwitch` 只发 `{sessionId, model: {providerId, modelId,
    options?: {reasoningLevel}}, persistAsWorkspaceLastUsed: false}`；
  - 切换前 `session/read` 解析 backend registry 的规范 ref（大小写不敏感匹配、
    自动补 reasoning level、max→high 有界重试）；
  - config.json 旧 provider UUID → `provider_config.json` 新 UUID 的映射
    （`resolvePersonalProviderId`，按 `personalModelIds` 成员匹配）；
  - `syncProviderRegistry` 对 Method not found 优雅降级（只记一条日志后跳过）；
  - ACP 扩展面 `session/updateRuntimeModelConfig` 改为从 overlay 提取 model ref
    转发 `applyModelSwitch`；
  - resume 兜底 overlay 删除（协议上已不可能，`repairUnavailableModel` 保留）。

### 症状 C：模型在列表里但切不动 / 注册不上

- **根因**：provider 可用性 = backend 从两个文件自建 registry：
  1. 内置账户模板（`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向的 `zcode-builtin.json`，
     `account:bigmodel-individual-coding-plan` 等 8 种账户套餐模板）；
  2. 个人 provider（`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 指向的
     `~/.zcode/v2/provider_config.json`，桌面端维护）。
  桌面端的**账户绑定发生在它自己的运行时里**，不落这两个文件——CLI/bridge 创建的
  会话天生看不到账户套餐 provider。凭据拷贝（含跨机器）已验证无效：两台机器的
  `account-provider:…:api-key` 凭据本来就同源同值（解密对比一致）。
- **修复**：往 `provider_config.json` 加一条个人 provider（见第三节 runbook §3），
  apiKey 用 config.json 里个人套餐的 key——**计费落同一个套餐**，与官方登录等价。

### 症状 D：裸 `zcode` TUI 报 `Cannot find package '@zcode/tui'`

- **根因**：`loadTuiRuntime()` 在非 SEA 模式直接 `import("@zcode/tui")`；桌面托管的无头
  agent runtime（`~/.zcode/server/agents/glm/`）从未带过 TUI 包，`@zcode/tui` 是内部包
  不公开发布。
- **修复**：`bash scripts/assemble-zcode-tui-runtime.sh` —— 从社区重打包
  [zcode-app-cli](https://www.npmjs.com/package/zcode-app-cli) 提取官方
  `@zcode/tui` 入口 + 公开 npm 依赖（`@earendil-works/pi-tui@0.85.1`、`web-worker`、
  `marked`）组装到 `~/.zcode/server/agents/glm/node_modules/`。
- **残留**：tui dist 懒加载的 `./html_renderer`、`./elk-*.js` 任何公开源都没有——
  HTML 导出/图形布局功能会报缺文件，核心聊天不受影响。

### 症状 E：TUI `/model` 列表全部显示 `undefined`

- **根因**：0.16.9 构建自身缺陷——`formatModelList` 渲染 `id`/`alias`/`name` 字段，
  `app.listModels()` 返回的是 `ref`/`label`/`providerLabel` 形状；且 `alias`
  （`/model main|lite` 的别名）在整个构建里没有任何赋值代码，属未实现残留。
- **修复**：`python3 scripts/patch-zcode-tui-modellist.py`（bundle 打补丁，自动备份，
  幂等可重跑；每次 zcode 更新后重打）。切换动作本身走健康的匹配路径，不受影响，
  但要用 **`providerId/modelId` 完整形式**（裸模型名客户端解析不支持）。

---

## 二、0.16.9 协议事实表（app-server stdio）

| 项 | 现状 |
| --- | --- |
| stdio 信封 | `{id, method, params}`，**不带 `jsonrpc` 键**（带则 union 校验直接拒绝） |
| `session/create` | `{workspace: {workspacePath, workspaceKey}}`（不收 `cwd`）；**阻塞等** `session/requestRuntimePreferences` 握手（bridge 已自动应答三个布尔字段） |
| `session/setModel` | `{sessionId, model: {providerId, modelId, options?: {reasoningLevel}}, persistAsWorkspaceLastUsed?}`，strict schema；**拒绝 `runtimeModel`**；带 `providerId/modelId` 字符串也拒绝（必须对象） |
| reasoning level | 部分 provider **必填**（缺了报 "Reasoning level is required"）；本机 GLM 条目支持 low/high/max，**不支持 none** |
| `session/setThoughtLevel` | `{sessionId, thoughtLevel?, expectedRevision?, persistAsWorkspaceLastUsed?（默认 true）}` |
| `session/setMode` | mode 枚举 `plan\|build\|edit\|yolo\|auto` |
| `session/goal` | action 枚举 `show\|set\|replace\|pause\|resume\|clear`；set/replace 启动内部 turn |
| 已删除 | `workspace/updateProviderRegistry`、`session/updateRuntimeModelConfig`、`runtimeModel` 键（全协议零出现） |
| 模型目录 | `session/read` → `settings.model.available`（**窄于** registry 实际可切集合）；registry 本体 = builtin 模板 + provider_config.json |
| 模型 ref 解析 | 只认 `{providerId, modelId}` 对象或 `"providerId/modelId"` 字符串；裸 modelId / `main` 之外不解析 |
| 账户套餐 | `account:*` provider 由桌面端 provisioning 下发（`provider_config.json` 无 configuredDefault 也能在桌面端用），**CLI 侧不可复刻**；等价替代 = 个人 provider 条目 + 套餐 apiKey |

## 三、机器本地 runbook（repo 之外，升级后需重做/复查）

### 1. desktop profile refresh

```bash
zcode-acp profile refresh   # 需先重建 dist（zcode-acp 软链 → 本仓库 dist/cli.js）
```

### 2. provider_config.json 的 GLM 个人套餐条目

`~/.zcode/v2/provider_config.json` 的 `config.providerConfigRules.providerRules[]` 中
保持/重新加入（apiKey 取 config.json 个人套餐 provider 的 key；UUID 随意但不要用
`account:` 前缀）：

```json
{
  "providerId": "e8757c24-81ad-4cbb-bce9-9c50e1868e00",
  "providerName": "GLM Coding Plan (personal)",
  "config": {
    "group": "standard-personal",
    "access": {"type": "api-key", "apiKey": "<个人套餐 apiKey>"},
    "api": {"type": "anthropic-messages", "baseUrl": "https://open.bigmodel.cn/api/anthropic"},
    "personalModelIds": ["GLM-5.3-Flash", "GLM-5.3"],
    "modelOrder": ["GLM-5.3-Flash", "GLM-5.3"]
  }
}
```

注意：此文件由桌面端管理，桌面端重新同步 provider 时可能覆盖手工条目（症状：`/model`
又切不了 GLM → 重新加上即可）。备份惯例：`provider_config.json.bak-<时间戳>`。

### 3. TUI 运行时组装（可选，仅裸 `zcode` TUI 需要）

```bash
bash scripts/assemble-zcode-tui-runtime.sh   # 参数 1 = 桌面 App 版本号
```

### 4. TUI /model 列表显示补丁

```bash
python3 scripts/patch-zcode-tui-modellist.py
```

### 5. TUI 内切换模型的正确姿势

```
/model e8757c24-…/<modelId>     # 完整 provider/model 形式
```

`/model main` 可用（=默认模型）；`lite` 别名未实现；裸模型名不可用。

## 四、已验证 / 未验证

**已验证**：typecheck、830 测试、lint；bridge e2e（initialize + session/new +
`/model GLM-5.3-Flash` 切换）；直连 backend 的全部 17 个 RPC schema/行为探针；
跨机器凭据解密/对比（guxy-desk Windows 凭据 = 本机同值，拷贝无意义）。

**未验证 / 已知风险**：
- 真实 turn 的事件流（`turn.completed` usage 语义、`state.updated`）——0.16.5 时代
  的验证（`tests/fixtures/usage-probe-events.jsonl`）可能漂移，首次真实对话注意
  usage 条/上下文条，异常时 `ZCODE_ACP_DEBUG=1` 抓证据并用 `scripts/usage-semantics-probe.mjs` 复采；
- `session/fork` 成功路径返回字段名（探针被锁挡住，失败仅显示 "?"）；
- TUI `html_renderer`/`elk-*` 缺失文件（仅边缘功能触发）。

## 五、明确放弃项

- `/login bigmodel-coding-plan`：CLI 半成品——OAuth 授权可完成（本机回调），但 token
  兑换需要 BigModel OAuth appSecret，CLI 调用链不传、无环境变量可给，**必失败**。
- 账户 provider（`account:*`）在 CLI 会话注册：依赖桌面端运行时绑定，凭据拷贝已验证
  无效（两机同值），等上游开放 `provider/updateAccountConfig` 的合法调用方式再评估。
