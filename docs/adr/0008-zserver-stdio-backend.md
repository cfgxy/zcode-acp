# ADR-0008: zserver 模式——复用本机部署的 zcode-server.cjs 作为 zcode-acp 后端

## 状态

Accepted（M0 已落地并活体验证；M1/M2 待实施，见"分阶段"）

## 背景

zcode-acp 现在直接 spawn `zcode app-server --stdio` 作为后端，身份环境变量
（provider pins、`ZCODE_SERVICE_AUTHORITY_MODE=desktop-attached-remote` 等）
通过 desktop-profile 从活进程抓取（见 `src/desktop-profile.ts`）。痛点：

- 桌面端与 SSH server 断连后，`zcode-server.cjs`（sshd-session 子进程）与其
  agent 子进程全部死亡，profile 源进程失活 → 后端无法 spawn，重连后必须手动
  `profile refresh`。
- desktop-profile 的源进程存活校验把"env 值仍然有效"和"抓取时的 pid 还活着"
  绑死在一起，而实测两代 server 的 profile env 逐字节相同。

源码研究（开源仓库 zai-org/ZCode，结合本机 `~/.zcode/server/zcode-server.cjs`
v3.14.3 bundle 反查）确认的进程拓扑事实：

- 桌面本地任务：host 进程（argv[0] 改名 `zcode-host-local-N`）经
  `ZCodeAgentProcessManager` spawn **同一个** `zcode.cjs app-server --stdio`。
  zcode-acp 本来就是"另一个壳"，后端进程与桌面完全相同。
- 远程任务：桌面把 server bundle 部署到远端 `~/.zcode/server/`，SSH exec
  `node zcode-server.cjs`（stdio 模式），随后该 server 作为 ServiceCollection
  owner 托管 agent 运行时、设备身份（deviceMid）与 provider provisioning，
  按 workspace spawn app-server 子进程。
- server 有两个官方入口：`entry-stdio.ts`（桌面远程连接在用）与
  `entry-http.ts`（Web 客户端在用，`PORT` + `ZCODE_SERVER_AUTH_TOKEN`）。
- stdio 间通信是 unix socketpair（libuv pipe 底层），**socket 无法经
  /proc/<pid>/fd 重开（ENXIO）**——复用桌面"正在用"的那个 server 实例不可行，
  也不必（它命悬 sshd-session）。

## 决策

zcode-acp 增加 **zserver 模式**：直接拉起本机已安装的
`~/.zcode/server/zcode-server.cjs`（stdio 模式），由 zcode-acp 充当该 server
的通道客户端（与桌面端在远程连接中的角色一致）。

- **不 vendor 任何代码**：协议客户端（帧、序列化、ChannelClient）在
  `src/backend/zserver/` 中按开源仓库 `packages/rpc` 的线格式自行实现；
  server 产物直接用本机 `~/.zcode/server/` 下已部署的文件，不复制不下载。
- **身份 env 在 spawn 时一次性注入**（复用 desktop-profile 捕获），server 的
  生命周期由 zcode-acp 拥有，与桌面是否连接彻底解耦。
- 通道：`zcode-agent`（`ServiceChannels.ZCodeAgent`）。服务适配遵循
  `ProxyChannel` 约定：方法 = 位置参数数组（`handler[command](...args)`），
  事件 = `onXxx`（`on` 后跟大写字母）；`onDynamic*` 为动态事件。

### 线协议事实（M0 实测，供后续维护）

1. 握手（行模式）：server 在 stdout 打印一行
   `{"type":"zcode-hello",version,platform,arch,pid}`；客户端回写一行
   `{"type":"zcode-hello-ack",version,clientId}`（`helloAckMessageSchema`：
   clientId 非空字符串）。握手前的 SSH banner/MOTD 行必须跳过。
2. 帧：13 字节头 `type(1)|id(4BE)|ack(4BE)|len(4BE)` + payload；RPC 只走
   Regular(1)。收帧必须"整帧到齐才消费"（对端实现有 peek-先于-消费的修复，
   我们同样如此）。
3. 序列化：1 字节 DataType 标签（Undefined=0/String=1/Buffer=2/VSBuffer=3/
   Array=4/Object=5/Int=6）+ VQL（7-bit varint）长度；Object 走 JSON，
   嵌套 Uint8Array 用 `__zcode_rpc_nested_uint8array_v1` base64 标记。
   注意 `subarray(pos, pos += ri())` 这类求值顺序坑（两处实现都曾中招）。
4. 消息：请求 = `serialize([100|101|102|103, id, channelName, name])` +
   `serialize(arg)`；响应 = `serialize([200..204, id])` + `serialize(data)`。
   server 构造完 ChannelServer 后立即发 Initialize(200)，客户端必须等它。
5. 已知服务面（v3.14.3 facade）：`initialize / createTask / sendPrompt /
stopGeneration / compactSession / goalSession / respondPermission /
respondElicitation / resumeTask / closeTask / deliverSessionMessage / …`；
   `initialize({workspacePath})` 返回
   `{available, workspaceKey, protocolName, protocolVersion, transportKind}`。

### 协议约束（M2 实测补记）

- **负整数不经 VQL Int 编解码往返**（`-1` 会解码成大正数）——上游同款
  codec、桌面端同样不发负数，本协议族的事实约束。bridge 构造参数时
  不得携带负整数（当前所有路由参数均为字符串/正数/布尔）。
- bridge handler 栈实际消费的 backend 方法面（zserver 路由需覆盖）：
  `session/create|send|read|subscribe|stop|load|resume|list`。
  `session/subscribe` 是 EventStreamListener 的水位订阅——返回
  `{eventSeq}`（当前 seq），事件投递由本侧会话订阅承担。
- ZServerBackend 的死亡错误文案含规范 marker `backend reader exited`，
  使 `isBackendDeadMessage` 分类器对 zserver 模式同样生效（heal 路径
  无差别工作）。

### 粗糙边缘（server 侧，避免踩坑）

- `ProxyChannel.fromService` 对**未知事件名同步 throw**，会把整个 server 进程
  砸掉（实测）。订阅事件名必须先从服务面确认。
- 未知 channel 的请求会被缓冲 1 秒后报 `Unknown channel`，不会崩。

## 备选方案

- **/proc/<pid>/fd 注入桌面进程的 stdio**：否决。两形态的 stdio 都是
  socketpair，内核禁止经 /proc 重开（ENXIO）；即便回退到管道形态，响应流
  单读端被 host 独占，两个读者抢字节做不成任何请求/响应协议（已实验证明）。
- **仅放宽 desktop-profile 存活校验（stale 回退）**：保留为 fallback 班底，
  但它不解决"server 全死"窗口，且每 spawn 都要重新校验身份。
- **entry-http + WS**：与 stdio 同级的合法对接口，留作后续多客户端场景的
  演进方向；stdio 模式与桌面远程连接的路径完全同构，先做它。

## 分阶段

- **M0（已完成，活体验证）**：`src/backend/zserver/` 传输栈
  （帧/序列化/ChannelClient/连接握手）+ 单测 + `scripts/zserver-probe.mjs`。
  活体验证：真实 `~/.zcode/server/zcode-server.cjs` + desktop profile env，
  握手 1.9s，`initialize` 返回 available=true。
- **M1a（已完成，任务面考古 + 真实调用打通到最后一环）**：
  `scripts/zserver-turn-probe.mjs`。已实测确认的服务面与流程：
  - channel **`zcode-task`**（任务 facade）：`createTask / sendPrompt /
respondPermission / respondElicitation / closeTask / stopGeneration /
compactSession / goalSession` + 动态事件 `onDynamicStreamEvent(taskId) /
onDynamicTaskEvent({taskId,…}) / onDynamicTaskReady(taskId) /
onDynamicTaskTerminalOutcome(taskId) / onDynamicSessionEvent /
onDynamicWorkspaceEvent`。
  - channel **`zcode-agent`**（内层 agent 服务）：`createSession({workspacePath})`
    返回完整快照（`session/settings/projection/messages/slashCommands`…）。
  - `sendPrompt` 的 `content` 是**纯字符串**（非内容块数组）；`taskId` 即
    session id（`sess_*`）；事件订阅必须先于 sendPrompt（动态事件 `onDynamic*`
    携参返回 Event）。
- **M1b（进行中，真实一轮已跑通）**：`scripts/zserver-turn-probe.mjs`
  完整闭环：`createSession` → `createTask(draftSessionId)` →
  `sendPrompt`（走内层 `zcode-agent` channel 的 session/send 路径，
  **非** facade 的 v4 sendText——后者要求 agent 侧 session 行已落库，
  否则 sqlite `FOREIGN KEY constraint failed`）→ 事件流
  （`onDynamicSessionEvent` live 投递，`state.updated` 帧）→
  `onDynamicTaskTerminalOutcome` 终态 `succeeded` → `closeTask`。
  消息持久化（用户+助手）与套餐模型解析
  （`account:bigmodel-individual-coding-plan/GLM-5.3`）均实证。
  关键协议事实：**动态事件必须携带 arg**（`onDynamicStreamEvent(taskId)`、
  `onDynamicSessionEvent({workspacePath, sessionId, deliveryKind})`）；
  `deliveryKind: "live"` 对应 server 端 `desktop-continuous`。
  agent 命令解析存在 flake（会选 `agents/glm/zcode-agent` 包装脚本，
  其 `#!/usr/bin/env node` 在净化 env 下 ENOENT），用
  `ZCODE_AGENT_SERVER_COMMAND`/`ZCODE_AGENT_SERVER_ARGS_JSON` 钉死。
  剩余：对话内容帧走 `subscribeConversationV4`/`onDynamicConversationFrame`
  （V4 帧订阅语义待映射）；`desktop-attached-remote` 权威下的
  runtime-preferences 应答回路已在探针中就位（local 权威下 server 自答、
  事件不触发）。
  `session/requestRuntimePreferences`。desktop-attached-remote 权威模式下，
  server 不自答该请求，而是 fire `sessionRuntimePreferencesRequestEmitter`
  转发给**客户端连接作用域**（`createZCodeAgentConnectionScope(role:
"trusted-host-relay")`——一个 V4 帧路由器：clientHello 身份声明、ownership、
  flow-control、订阅路由）。实测：不实现该中继客户端时 agent 拿不到 runtime
  preferences → `session/create` 超时/缺席 → `sendText` 在 agent sqlite 报
  `FOREIGN KEY constraint failed`（`message.session_id → session(id)` 无行，
  已用 `~/.zcode/cli/db/db.sqlite` 查询证实）。强制
  `ZCODE_SERVICE_AUTHORITY_MODE=local` 无法绕过：server 经中继握手与
  `initializeRuntimeProcessEnv` 的 env patch 重新注入
  `desktop-attached-remote`（agent `/proc/<pid>/environ` 实证）。
  **M1b 工作**：实现 trusted-host-relay 客户端——Initialize 后发送 V4
  clientHello（connectionId + clientMode "desktop-continuous" + 下游声明），
  订阅中继帧并应答 `session/requestRuntimePreferences`（server local 模式的
  默认值可作首版应答：`{askUserQuestionAutoResolutionEnabled: true,
nativeSearchEnhancementsEnabled: true, memoryEnabled: false}`），以及
  permission/elicitation 的 `resolveInteraction` host-command 往返。作用域
  源码在 bundle 内可读（`createZCodeAgentConnectionScope`，~9KB）。
- **M2（已完成）**：`ZCODE_ACP_BACKEND=zserver` 开关已接入
  `server.ensureBackend`（默认路径不变）；`BridgeBackend` 接口统一
  handlers 消费面；`ZServerBackend` 仿真 app-server RPC 面
  （session/create|send|read|list|load|resume|stop）并把 V4 deltas 翻译为
  app-server 事件方言（turn.started/model.streaming/turn.completed|failed）。
  支持 `ZCODE_ACP_ZSERVER_IDLE_MS` 空闲自动回收 server 子进程。
- **M2.5（已完成）：broker 复用**。`zcode-acp zserver-broker`（UDS：
  `$XDG_RUNTIME_DIR/zserver-broker.sock`）保活一台共享 zcode-server，
  多个 zcode-acp 以 `ZCODE_ACP_ZSERVER_SOCKET=<path>` attach（
  `ZServerConnection.attach`，跳过 hello、由 broker 合成 Initialize）。
  broker 按 id 重写路由帧（client id ↔ server id 映射，事件帧循原路
  返回属主客户端）；runtime-preferences 必答回路收敛在 broker 一处。
  语义注意：server 按 workspaceKey 隔离会话，同 workspace 的多客户端
  共享任务面（个人机器场景可接受）。spawn 模式仍可作为无 broker 的
  退化路径。

## 后果

- 正面：后端生命周期归 zcode-acp，桌面断连/升级不再打断或失效；身份注入
  每次 server 启动仅一次；与桌面共享同一 server artifact（版本随部署走），
  无需自备后端代码。
- 代价：backend 层新增一条协议栈与映射层（M1 的主要工作量）；server bundle
  版本漂移时线协议可能变化——M0 已把全部线格式固化为带向量测试的代码，
  漂移时测试先行报警。
