# ADR-0008: zserver 模式——复用本机部署的 zcode-server.cjs 作为 zcode-acp 后端

## 状态

Accepted（M0/M1a/M1b/M2/M2.5 已落地并经真实 server 探针 + 多视角审计验证；仍开放的项见"已知差距"与"分阶段"）

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

- **负整数可以往返**（已订正）：本文早先版本声称"`-1` 会解码成大正数"，
  经 codec 实测与对照部署 bundle 的 `writeInt32VQL`/`readIntVQL` 逐位核对
  为**错误**——VQL 位运算按有符号 32 位折回，-1 编码为 `06 FF FF FF FF 0F`
  并精确解回，-2^31…2^31-1 全部往返（`tests/zserver-protocol.test.ts`
  断言）。≥2^31 的整数与浮点走 Object/JSON 路径。
- bridge handler 栈实际消费的 backend 方法面（zserver 路由需覆盖）：
  `session/create|send|read|subscribe|stop|load|resume|list`。
  `session/subscribe` 是 EventStreamListener 的水位订阅——返回
  `{eventSeq}`（当前 seq），事件投递由本侧会话订阅承担。
- ZServerBackend 的死亡错误文案含规范 marker `backend reader exited`，
  使 `isBackendDeadMessage` 分类器对 zserver 模式同样生效（heal 路径
  无差别工作）。

### 时序事实（第三轮深审补记）

- **terminal 与正文走两条无序通道**：`onDynamicTaskTerminalOutcome`
  （zcode-task 通道）与 `onDynamicConversationFrame`（V4 订阅）之间没有
  顺序保证。terminal 先到而正文未收完时立即判定完成会截断回复——
  ZServerBackend 用静默期门（TurnCompletionGate，
  `ZCODE_ACP_ZSERVER_TURN_QUIESCE_MS`，默认 300ms）在 terminal 后等流
  静默再发 turn.completed/failed，任何帧/会话事件重置计时。
- **V4 rowId 是每会话日志位置**（"1","2","3"…），跨会话会碰撞——增量
  水位必须以 `${sessionId}:${rowId}` 复合键存放。
- broker attach 失败（如 broker 死亡）回退直接 spawn；restart/heal 会
  先重试 broker。

### 退化路径事实（第四轮深审补记）

- **请求超时是精确契约**：EventStreamListener 的订阅重试键于
  `error.message === "timeout"`（字面匹配）。ZServerBackend.request 必须
  实现 per-request 超时并返回该精确文案——server 半死（不响应不退出）
  时才能走重试/heal 而不是永久挂起。
- **interaction 中继是 ZcodeBackend 专属能力**（pollServerRequests/
  sendReply）；handleServerRequests 以能力守卫短路 zserver 模式，yolo
  会话不产生交互请求。
- **broker 只可 header-only 改写帧**：body 的 decode→encode 往返不是
  字节保真的（顶层 VSBuffer(3) 翻为 Buffer(2)、对象全量重排）——
  replaceHeader 重编码 header 后拼接原始 body 字节。
- `session/resume` 携带 workspace（bridge 侧 `workspaceFor(cwd)`），跨
  bridge 重启的 workspace 映射恢复无需额外机制（已验证调用链）。

### 失败缓存与生命周期残留（第五轮深审补记）

- **spawn 失败不得缓存 rejected promise**：失败的 spawnPromise 若留存，
  backend 永久卡死（isDead 不置位、heal 不触发）。失败时清缓存并置
  带 marker 的 isDead。
- **V4 initial 帧是历史回放**：订阅重建（resume/heal）后的首帧携带全量
  日志行，翻译它会把历史 assistantText 当 live 流重新发出（编辑器重复
  显示）。只翻译 deliveryKind==="online" 的帧；历史由 readSession 快照
  重建。
- **broker 客户端不告而别要代发退订**：ChannelClient.dispose 不发
  unsubscribe 帧——broker 在客户端 socket close 时代发 EventDispose，
  否则共享 server 对已离开的客户端永久投递事件。

### 参数保真（第六轮深审补记）

- **bridge 的 session/create 携带 mode:"yolo" 与可选 mcpServers**（resume
  同带 mcpServers）——zserver 路由必须转发两者：丢 mode 会静默改变权限
  行为，丢 mcpServers 会静默丢失编辑器配置的 MCP server。
  buildCreateSessionParams 纯函数承载该映射并有向量测试。

### 已知差距（低严重度，入档待实测）

- `session/load` 的回放/tail 语义：路由直通 readSession，快照形状与
  bridge 回放 handler 的消费契合未经编辑器实测。
- 会话状态回收：`ZServerBackend.releaseSession`（退订三个 EventListen、
  用 subscribe ack 里的 subscriptionId 调 `unsubscribeConversationV4` 释放
  server 端 V4 订阅、销毁完成门、清流式计数）已接入 remote session-close
  端点；bridge 自身的会话驱逐（`BACKEND_RESIDENT_TTL_MS` 过期）不会调用它——
  退役发生在编辑器/远程关闭会话时，而非 TTL 过期时。保留
  `workspaceBySession`（后续 send/read 只带 sessionId，靠它寻址）、
  `listeners`（由 handler 持有）与 `seqBySession`（水位不可回退）。
  **更正**：上一版提交（592c65c）写成"释放 server 端订阅"，实际只发了 103
  EventDispose——在真 server 上实测，103 只停止我方事件投递，**server 仍持有
  V4 订阅**，只有 `unsubscribeConversationV4` 才释放（探针：订阅后
  `resyncConversationV4` 判定 OWNED；仅 103 后仍 OWNED；调 RPC 后 NOT-OWNED）。
  订阅归属键是 (workspace, topic, **connection**)：直连模式一个 bridge 对应一条
  连接，随进程结束自动释放；**broker 模式所有客户端共用 broker 那一条连接**，
  客户端异常退出（kill -9）不会有人替它退订，订阅会一直挂到共享 server 结束。
  所以 broker 现在按 (workspace, session) 对 V4 订阅做引用计数：记录每个
  subscribe 的 ack，客户端断开/显式退订/cancel（含 ack 还在飞时断开）都只是
  放弃自己的持有，**最后一个持有者离开才向 server 发退订**，且用 server 当前
  的 id（后来的 subscribe 会替换旧 id）。客户端发来的
  `unsubscribeConversationV4` 由 broker 本地处理并自行应答 201，不盲转发——
  盲转发要么因 id 已被替换而空转，要么在 id 恰好是当前值时切断其他持有者。
  已用真 server 验证：kill 掉持有订阅的客户端后，修复前 OWNED、修复后 NOT-OWNED。
- `session/send` 的 `attachments` 在 zserver 模式被丢弃；broker 模式下无法按
  客户端传递任务级凭据。（`session/list` 已修：真 server 的 `listTasks` 返回
  **裸数组**，旧代码读 `.tasks` 因而对真 server 永远返回空——fixture 回字符串
  所以单测因错误原因通过；现按数组解析并向 server 传 workspace 过滤。）
- **仍未处理（如实记录，不代表不重要）**：
  - broker 没有 per-client 会话隔离，白名单只约束方法名不约束参数：同 uid 的
    受限主体可对别人的 sessionId 调 `sendPrompt`/`readSession`（在"同 uid 已被
    视为可信"的模型内是设计取舍；要收紧需"客户端只能操作自己 createSession
    出来的 sessionId"这类参数级约束）。
  - 看门狗按 pgid `kill(-pgid, SIGKILL)`：owner 死后 pgid 数字被别的进程组复用
    的窗口未量化（直连后端 `client.ts` 是同款模式，非本特性引入）。
  - aborted 的调用在 Initialize 之前仍留在 `queued` 里直到握手结束（有界，
    生产路径上 `queued` 恒为空）。
  - broker 只有日志、无状态探针（`stats()` 仅进程内可用）；日志无时间戳、无 pid，
    client id 是自增整数；退出码不区分"已在运行"与真故障（同为 1）；启动时若已有
    broker 在监听，新进程报 `something is already listening`，不区分"重复启动"与
    真故障。（已修的部分见下"第十二轮：LOW 项收尾"：空闲自退不再无声、双 broker
    抢同一陈旧 socket 不再各自 "ready"。）
  - **bundle 缺失时的降级是静默的**：broker 起不来自己的 server（例如它的
    `serverRoot` 下没有 bundle）时，接入它的 bridge 只会看到
    `broker attach failed (zcode server exited: socket closed) — falling back`，
    真因 `zcode server bundle not found` 只出现在 broker 自己的日志里。
  - attach 失败回退到私有 server 时，一个"接受连接却永不应答"的挂死 broker 会让
    每次 spawn（含 heal 的每一轮）白等 `READY_TIMEOUT_MS`（15s）——`request()`
    的超时只覆盖 `route()`，不覆盖之前的 `ensureConnection()`。
  - 二次 SIGTERM 落回默认动作（`process.once`），此时 socket 文件会残留；下次
    启动按陈旧 socket 清理。
  - **同 uid 前提下的 pin 缺口（SECURITY.md 把"已在主机上有代码执行"列为范围外，
    这三条都需要同 uid 已能写文件，故不在项目声明的威胁模型内；如实记录并按
    性价比取舍）**。均由安全审计实测：
    - 符号链接：`isTrustedPinPath` 只做词法检查，`~/link -> /outside` 下的 pin
      被接受并且 `${root}/node` 真的以该 uid 执行到 home 外的二进制；校验在加载期、
      解析在 exec 期，其间没有 realpath 或 fd 固定。**未修**——修复要在 exec 时
      改用 realpath 后的路径，牵动整个 pin 传递链；本机真实 profile 的 6 个路径
      pin 均为直接路径（未经符号链接，只看了是否穿过链接，未读值）。
    - 伪 AppImage 挂载点：同 uid 可自建 `/tmp/.mount_x/` 冒充。**未修**——需要
      mountinfo 判据，而该判据基于对另一款 AppImage 的观察，ZCode 桌面端未验证。
    - URL pin（`ZCODE_BASE_URL` 等）没有主机白名单，bridge 交给子进程的 env 里
      会同时含被篡改的 URL 与 API key。真实 CLI 是否把 key 发往该 URL **未验证**，
      且直连路径明确"尊重用户自定义端点"，所以加白名单会破坏一个有意的功能。
      已修的同类问题见下"安全模型"：退化 HOME、provider 写目标的符号链接。
- 第七轮终扫无新增中等以上问题，深审循环终止（后续多视角审计仍发现新问题，
  见下文各轮补记——"终止"仅指当时视角下的收敛）。
- **审计方法的教训**：单视角连续审阅每轮都会发现新问题，改为多视角并行后一次
  性发现的问题远多于任何单轮；但更大的收益来自**在真 server 上动手**——
  `session/list` 永远为空、V4 订阅在 103 之后仍被持有、`closeTask` 可跨客户端
  关别人会话，都是 fixture 与单测里看不见的，只有对真 server 跑一遍才暴露。
  全部审计报告原件与实验脚本存档于 `docs/audits/zserver-2026-09-30/`（索引见其 README）。
  另外：审计员的结论要亲自重跑（曾有审计员的最终消息为空、报告只写了头部；
  也有把"实现细节"当成"行为已被保护"的测试），对测试做变异验证之前不要信它。

### 测试稳定性：`remote-file-endpoint` 偶发 502（已定位并修）

该文件里每个用例都在**同一个固定端口 18700** 上起 bridge，hub 经 Node 进程全局的
keep-alive `http.globalAgent` 代理过去。上一个用例池化的、已随 bridge 停止而关闭的
socket 会被下一个用例的请求复用——客户端尚未看到 FIN 时写入即 `ECONNRESET`，hub
把它报成 502。用追踪预加载在失败的运行里抓到：`ECONNRESET reusedSocket=true`（另有
一次 `ECONNREFUSED reusedSocket=false`）。确定性复现（同一固定端口 40 轮 起服务/
请求/停服务）：不清理 20 轮失败，每轮 `http.globalAgent.destroy()` 后 0 轮失败，
且 destroy 之后 agent 仍可正常使用。现于该文件的 `afterEach` 里 destroy。

**诚实的边界**：该测试文件的失败率**并不稳定**，我没能测出一个可引用的数字——
不同时段的实测是 10 次里 2 次、6 次里 1 次、8 次里 2 次，而修复前后的两组交错
对比里（12 对：origin 失败 1 次、工作树 0 次；修复之后的 20 对与 CPU 满载下的
14 对：两边都 0 次）根本没有足够的失败样本去**统计地区分**修复前后。所以"已修"
的依据是机制，不是 A/B 的失败次数：追踪预加载在失败的运行里抓到
`ECONNRESET reusedSocket=true`，确定性脚本 40 轮里不清理失败 20 轮、清理后 0 轮。
失败也不是我的改动引入的——它在未改动的 origin 树上同样出现过（上述 12 对里的
那 1 次）。另一个同模式的测试文件 `remote-endpoint.test.ts` 我用同样的追踪跑了
12 次，没有观察到复用池化 socket 的 `ECONNRESET`，所以没有改它。

### 订阅窗口与取值保真（第八轮深审补记）

- **帧监听器必须先于订阅调用注册**：server 端订阅在 ack 时刻即生效，
  ack 之后才发 EventListen 的窗口内触发的帧会被投到不存在的监听器上
  丢失（快 turn 的 turn.started 可能丢）。
- **terminal outcome 的 "cancelled" 是字面契约**（bridge 以
  `turnResultType === "cancelled"` 判取消）——不可折叠为 "success"，
  否则用户取消被误报为干净完成（terminalResultType 承载映射）。
- TurnMonitor 消费 `result.projection`：内层 readSession 快照顶层含
  projection 键，形状契合（深层字段待编辑器实机确认）。

### 事件流作用域（第十轮深审补记）

- **onDynamicConversationFrame 的 emitter 按 workspaceKey 键控（workspace
  级）**：同一 workspace 的所有会话共享一条帧流，会话仅由
  frame.topic（"conversation/<sid>"）区分——按会话监听必须先过
  frameMatchesSession 再进 gate/翻译，否则跨会话串流（正文/turn 状态
  互相污染），且外会话帧不得重臂本会话的完成静默门。
- onDynamicSessionEvent 的键含 sessionId、onDynamicTaskTerminalOutcome
  内部按 sessionId 过滤——二者天然会话级（已排除）。
- 已知差距追加：zserver 模式暂不产出 usage/session.updated（上下文条
  无数据），需实测 V4 行中的 usage 形状后补。

### 多 agent 并行深审（第十一次审查，5 视角）

单人 dry-run 十轮后改用 5 个并行 subagent 各持正交视角逐行审阅未推送
diff（并发竞态 / 协议字节保真 / 资源生命周期 / 错误处理降级 / 集成契约），
一次性发现 7 高 + 12 中 + 9 低——显著多于单视角连续十轮的任何一轮，
证实"每轮都发现新问题"源于单视角盲区而非代码无限恶化。关键修复：

- `'error'` 事件零监听（child/stdin/socket）——异步 EPIPE/RST 击穿进程；
  补齐监听并路由进 exit 语义。
- broker 双 id 分配器线上相撞：broker 自身 ChannelClient（低段 id）与
  客户端路由 id 共用 server id 空间——路由 id 移至 1_000_000 高段
  （同 ZcodeBackend.sendIdCounter 手法）。
- 空闲回收=自杀：idle 关闭 → onExit 置 isDead → index.ts 死亡轮询 2s
  内杀 bridge；closing 标志区分"主动关闭"与"意外死亡"（新 spawn 复位）。
- resume 不记录 workspace：跨 bridge 重启后首次 sendPrompt 带空
  workspacePath 必失败——resume/load 现在重建映射并在缺 workspace 时
  显式报错。
- broker rejected spawning 永久缓存；attach 失败泄漏 socket+幽灵客户端；
  SIGINT 启动窗口孤儿——均已修。
- 子进程组杀+SIGKILL 升级+看门狗（owner 被 SIGKILL 时回收整组）。
- `session/messages` 路由（readSession.messages 透传，形状待实测）——
  此前历史回放静默空白。
- 订阅失败回滚 subscribedSessions；decodeRpcJsonValue 补参考实现两条
  守卫；FrameDecoder 只投递 Regular 帧；数组长度上界；帧解码 try/catch
  不入事件循环；restart() 不抛（防实例劈分）；spawn 失败带 "spawn
  failed" 前缀（wire 分类契约）；terminal outcome 透传 error 字典；
  unregister 删空 Set（idle 回收可达）；routeClientFrame await 后复查
  客户端存活性；broker 客户端 socket 持久 error 监听+写前检查。

仍开放（需实机数据）：usage/session.updated 产出、readSession 深层
projection/messages 形状、tool.updated 合成、busy 错误码 1308 语义。

### 安全模型（多视角审计补记）

威胁模型：跨 uid 用户在 socket 权限下被隔离；**同 uid 的受限主体**（沙箱
应用、被限制文件写入的 agent、仅能 exec 的工具子进程）是本特性真正防御
的对象，因为它们本无凭据/执行权，却可能借 broker 或 profile 获得。

- **broker 是 confused deputy 的天然候选**：共享 server 的
  ServiceCollection 暴露 credential.load、terminal._、file._、git.* 等全部
  服务。broker 因此**只转发** bridge 实际使用的 (channel, method/event)
  白名单（`BROKER_ALLOWED_CALLS/EVENTS`），header 先经 `validateClientHeader`
  严格校验（形状、numeric id、请求类型 100..103）。
  - **拒绝语义**：格式良好但被策略拒绝的请求（如 `credential.load`）由 broker
    回一个 202 错误帧（`broker: … not allowed through the broker`，携带客户端
    自己的 id），客户端能读到原因；**只有无法解码/没有可回复 id 的帧才断开**。
    早期实现一律直接断 socket，客户端只能看到 "socket closed"，与 server
    崩溃无法区分，并会触发无意义的 heal 循环。中间一版加过"累计 5 次违规即
    断开"，二波审计实测证明它把同样的问题带回来了：第 5 次拒绝后客户端读到
    `zcode server exited: socket closed`，`isDead` 置位，2 秒后 index.ts 的死亡
    轮询把整个 bridge 关掉——而同 uid 的洪泛者发**被允许**的调用同样廉价，
    上限只保护了寥寥无几却让合法客户端在白名单漂移时丢连接。现改为永不因可
    回复的拒绝断开，同一客户端只记前 5 条日志
    （`MAX_LOGGED_VIOLATIONS_PER_CLIENT`）。真正需要约束的是未读回复的堆积，
    见下一条。
  - **会话属主检查（setModel/setMode/setThoughtLevel/goalSession/compactSession）**：
    这 5 个调用会改动既有会话，server 不把会话绑定到创建者，同 uid 的另一个
    attach 客户端本可改别人会话的模型/模式或触发压缩。白名单放行它们的同时，
    broker 只对**会话属主**转发：客户端对某 (workspace, session) 发
    `subscribeConversationV4` 时，若当前无存活属主即认领（create/resume 都先
    订阅再改动）；先到先得，后来者订阅不会抢占；属主断开即释放，重启的 bridge
    重新订阅即可认领回来。未持有的会话、缺字段或无法解码的 body 一律 202 拒绝
    （`not owned`），不断开。属主表的 key 复用 `subscriptionKey`（长度前缀，
    抗 NUL 拼接碰撞），渠道/方法名查表用 `Object.hasOwn`。此前 broker 模式下
    `session/set_model` 被白名单拒绝（`setModel is not allowed through the
    broker`），是 RUYI-318 里 set_model 失败的另一个独立原因。
  - **resumeTask（session/resume 的复活原语）**：channel 的 `readSession` 只服务
    有存活 resident 的会话，server 重启/空闲驱逐后只剩磁盘记录的会话会回
    `Session is not active`（-32004）；direct 后端的 `session/resume` 自带从
    session store 重载，channel 版没有。`ZServerBackend.readSessionReviving`
    遇到该错误时调 `zcode-task.resumeTask({taskId, workspacePath})`
    （resumeSnapshotOrLegacy → agent resumeSession，与桌面端“继续任务”同一条
    路径），再重读一次；`resumeTask` 自身的错误原样抛出，保证 `Session not
    found` 仍归类为 `zcode_session_lost`。白名单放行 `resumeTask`，但**不**进
    属主守卫：resume 发生在 `subscribeConversationV4` 之前，属主尚未认领，加守
    卫会把自己挡死。其信任级别与 `createTask` 相同——只唤醒既有会话、不发 prompt，
    桥接器也不传 automation/offPeak 等元参数。`sendPrompt` 非幂等，不做自动重试。
  - **不读回复的客户端**：Node 对未刷出的写入无界排队，而 broker 会应答每个被
    拒/被限/被退订的请求，并转发 server 事件。所有向客户端的写入统一走
    `sendToClient`，未读积压超过 `ZCODE_ACP_ZSERVER_MAX_CLIENT_WRITE_QUEUE`
    （默认 8MB）就断开该客户端（其持有的订阅由 close 处理器释放），不让一个
    卡住的对端把共享守护进程撑大。
  - **白名单必须按自有属性查表**：表是普通对象字面量，`table["__proto__"]`/
    `constructor`/`toString` 会解析到继承成员，`?.has` 随即对非 Set 调用而抛
    `TypeError`；这条抛错逃出 `void` 掉的 promise 成为 unhandledRejection，
    **一帧即可杀死机器级共享 broker**（已实测复现，进程 6ms 退出）。现用
    `Object.hasOwn` 查表，且 `routeClientFrame` 的返回 promise 带兜底 `.catch`
    ——任何未预期抛错只断开该客户端，不再连坐所有客户端。
  - **每客户端上限**：未决请求（未应答调用 + 存活订阅）默认 4096
    （`ZCODE_ACP_ZSERVER_MAX_PENDING`），超限回 `BrokerLimitError` 而不断连；
    此前未应答的调用只在客户端断开时才回收。
  - **白名单最小权限**：只放行 ZServerBackend 在 attach 模式下真正会发的调用。
    移除了 `closeTask`（server 不把任务绑定到创建者，附着的客户端可以关掉别人
    的会话——实测：第二个客户端 closeTask 关掉了第一个客户端的 session；
    ZServerBackend 从不发它，要加回须带属主检查）和
    `onDynamicSessionRuntimePreferencesRequest`（只有 broker 自己的连接监听并
    应答，走 rawSend 不经校验；附着客户端不该监听它）。
    注意：同一 server 连接内仍无 per-client 会话隔离（事件按 workspace 键控，
    `frameMatchesSession` 只是客户端自愿过滤）——同 workspace 的客户端互相可见，
    属已接受的个人机器语义。白名单只约束**方法名**，不约束参数（`readSession`
    可指向任意 workspace）；在"同 uid 已被视为可信读者"的模型内这是设计取舍，
    不在模型内则需要参数级约束（未做）。
- **socket 创建即 0600**：`bind()` 在 `umask(0o177)` 下执行，消除
  "listen 后才 chmod" 的窗口（`onBoundForTest` 接缝使其可确定性测试）。
  `listen(path)` 在同一同步段内完成 `bind()`（EADDRINUSE 等以后续 `error`
  事件到达，已实测），所以 umask 只在该同步调用内改动、绝不跨 `await`——
  跨 await 会让同进程里无关的文件创建也被带成 0600（进程全局状态）。
- **profile 路径类 pin 必须可信**（`isTrustedPinPath`：绝对、无 `..`、位于
  home / AppImage `/tmp/.mount_*` / `/opt` / `/usr`）；路径 pin 决定 server
  加载哪份 provider 配置、执行哪个二进制，被篡改即凭据外泄/RCE 面。
  `profile refresh` 写入 API key 的目标（`resolvePersonalProviderTarget`）额外
  要求**穿过符号链接解析后**落在 `~/.zcode/` 内——包括文件尚不存在的情形：
  旧实现在 `realpath` 因 ENOENT 抛错时退化成词法检查，`~/.zcode/linkdir`
  （指向别处的符号链接目录）下的新文件因此被放行（安全审计实测：先 resolve、
  再由攻击者在目标目录放入合法 JSON，套餐 key 就被写到 `~/.zcode` 之外）。现在
  逐级向上找到第一个存在的祖先做 `realpath` 再拼回不存在的尾部；悬空符号链接
  因目标不可知而拒绝；**返回的是解析后的路径**，检查的位置就是写入的位置（旧实现
  返回原始 pin，每次使用都重新解析符号链接，这是 TOCTOU 的根因）。**被拒绝的 pin 不再让 refresh 悄悄改写
  默认路径**：后端读的是 pin 指向的文件，写到默认路径等于把 provider 登记在
  没人读的地方却报告成功；现在 refresh 什么都不写，并输出被拒绝的 pin 路径
  与原因。成功时的输出也带上实际写入的文件路径。两处校验口径不同
  （`isTrustedPinPath` 放行整个 home，写入目标只放行 `~/.zcode`）是有意的：
  读取一份 pin 的风险远低于把 API key 写进去。
- **provider 配置的写入不跟随符号链接**：该文件含用户的套餐 API key，却经可预测
  的名字写入（`<file>.tmp-<pid>`、`<file>.bak-<毫秒>`）。安全审计实测：同 uid 主体
  在这两个名字上预置符号链接，`writeFileSync`/`copyFileSync` 会**跟随**并截断覆盖
  链接目标（内容为含套餐 key 与其它 provider key 的 JSON），随后 `chmod` 也跟随，
  最后 `rename` 把符号链接本身换成 `provider_config.json`；备份名只含毫秒，预置
  4000 个链接仅需约 85ms。现在两者都用 `openSync(…, "wx", 0o600)`（O_CREAT|O_EXCL：
  对任何已存在条目，符号链接也包括在内，报 EEXIST 而不跟随；且**创建即 0600**——
  旧的 `copyFileSync` 先按源文件的 0644 落地再 chmod，留下一个含其它 provider key
  的备份对他人可读的窗口）；陈旧的临时文件先 `rmSync`（unlink 删链接本身）。
  测试用 `strace` 读内核的 `openat` 记录来断言标志与创建时的权限位——进程内的
  spy 观察不到该模块的调用（它按名字绑定了 `node:fs`）。
- **`isTrustedPinPath` 在退化 HOME 下失效**：`HOME=/`（无 passwd 条目的 uid、部分
  容器）或空时 `homeRoot` 变成 `/`，整个文件系统都被信任（实测 `/etc/passwd`、
  `/tmp/evil/rg` 均返回 true）。现在 home 为空/`/`/非绝对时对 home 分支 fail-closed，
  只剩固定根（`/tmp/.mount_*`、`/opt`、`/usr`）可匹配。
- **broker 的其它加固**：订阅键（`workspace`+`session`）对客户端可控字符串做单射
  编码——NUL 能穿过线协议，纯 NUL 分隔时 (`"a\0b"`,`"c"`) 与 (`"a"`,`"b\0c"`) 撞成
  同一个键，一个客户端可以持有并（离开时）释放另一个的订阅；start 之后的 server
  `error` 用持久监听（旧的 `once` 让第一次 accept 失败（如 EMFILE）被静默吞掉、
  第二次变成未捕获异常，杀死整个共享守护进程，已实测）；拒绝原因与 server stderr
  尾行里的不可信文本限长并折成单行（曾实测一帧带 4MB 通道名即向常开 warn 写 4MB，
  换行可伪造日志行）；`attach` 在连接前校验 socket 文件属主是当前用户（Node 拿不到
  SO_PEERCRED，文件属主是能拿到的证明）；客户端与 broker 对
  `ZCODE_ACP_ZSERVER_SOCKET` 都 `trim()`（此前只有 broker 侧 trim，带空格的值让
  bridge 悄悄回退到私有 server）。
- **宿主进程识别收紧**：comm 仅接受 `zcode-host-loca`/`zcode-host-remo`
  精确截断，全名仅匹配 argv[0]（原先任一 argv token 即可冒充宿主）。
- **broker 的 spawn env 去除任务级凭据**（`MULTICA_*`、SSH agent 变量）：
  broker 是机器级共享守护，继承启动者任务的令牌会让所有客户端 agent shell
  带着别人的凭据。直连模式保持原语义（daemon 注入的任务凭据是设计需要）。
- profile export 以 `O_NOFOLLOW` + `fchmod` 写入，不跟随预置符号链接。
- 每客户端入站缓冲上限默认 8MB（`replaceHeader` 对大帧有线性放大）。
- 未覆盖/UNVERIFIED：profile 文件本身无完整性绑定（每次 spawn 仍应优先
  从 `/proc/<pid>/environ` 重采）、无 SO_PEERCRED（Node 原生不可得）。

### 第十二轮：LOW 项收尾（二波审计遗留，逐条实测后修）

每条都先复现、再修、再对修复做变异验证（备份 → 变异 → 跑 → 按拷贝还原）。

- **在途请求被 `restart()` 切断**：请求所在连接被并发会话的 heal 换掉时，调用方读到
  裸的 `zcode server channel client disposed`，没有任何 heal 分类器认得它，请求直接
  失败；直连后端对同一场景返回 `zcode backend restarting`。现在按"错误名为
  `ConnectionClosed` 且请求所用的连接已不是当前连接"改写成 restarting 标记。
  两个条件缺一不可，各有测试：只看错误名会把"服务端在途死亡"（连接仍是当前的）
  误标成 restarting；只看连接身份会把与退役竞速的**真实服务端错误**也改写掉。
- **`session/create` 中途失败留下的映射**：`createSession` 成功、`createTask` 超时后，
  `workspaceBySession` 里留着一个调用方永远拿不到 id 的条目。现在只在 create 完成
  后才登记。（server 端那个未入索引的会话无法在此清理：`closeTask` 不在白名单，
  见"最小权限"。）
- **两个 broker 同时起在同一个陈旧 socket 上**：此前偶发**两个都 "ready"**，先到者
  不可达。根因分两层。① 探活是异步的，探活与 `unlink` 之间另一个 broker 可能已经
  删掉陈旧文件并 bind 了自己的活 socket，按名字 `unlink` 就删掉了活的。现在用
  `removeStaleSocket`：`unlink` 前再 `lstat` 一次，只删探活时看到的那一个。
  ② 第一版用 inode 号做"是不是同一个文件"的判据，**实测不够**：陈旧文件的 inode 号
  空出来后，赢家新建的 socket 会拿到同一个号（strace 抓到一次失败运行：探活时与赢家
  新建之后的 `statx` 返回相同的 `stx_ino`），此时输家把赢家的活 socket 当成自己探活
  过的那个陈旧文件，按名字删掉。只比 inode 号时，全新进程各跑 1 轮的双赢家率是
  16/60；判据补上出生时间和 ctime 后，同一方法 0/120。
  复用与进程的冷热有关，不是文件系统的固有属性：一个最小探针（被 kill 的进程留下
  socket → `unlink` → 本进程 bind）在**长期运行的进程**里循环数百轮从未复用
  （xfs 与 tmpfs 都是 0），在**全新进程**里各做一轮时 xfs 上 2/60、tmpfs
  （/dev/shm）0/60。所以只在 XFS 的冷进程里观测到；不要据此推断别的文件系统上
  不会发生。探针的复用率（2/60）低于 broker 竞态的双赢家率（16/60），差异的原因
  我没有查清（UNVERIFIED，不作解释）。
  另外：bind 竞速的输家收到裸 `EADDRINUSE` 时改报 `already listening`；失败的
  `start()` 不再保留 `server`——否则输家的 `stop()` 会去关闭一个从未 bind 过的
  监听器，并按名字 `unlink` 那个路径（变异实测：赢家的 socket 文件随之消失）；
  持久的 server `error` 监听改为 bind 成功之后才挂，输家不会自称 "still serving"。
- **spawn 的 errno 分类**：`EMFILE`/`ENFILE` 时 Node 在创建 stdio 之前就返回，
  `child.stdin` 为 `null`，`childIo` 抛的是不含真因的 TypeError；现在报出"没有 stdio
  管道（描述符耗尽？）"并归为可重试（phase `hello`），同时给那个孩子挂上 `error`
  监听（Node 仍会在下一个 tick 发一次 `error`，无人监听即崩进程）。`EAGAIN` 是
  瞬时的进程数不足，此前与 `ENOENT`/`EACCES` 一并被当成永久失败，heal 会直接放弃；
  现在可重试。`ENOENT`/`EACCES` 仍是永久的（各有测试防止过度放宽）。
- **server 部署根的解析**：`ZCODE_SERVER_RUNTIME_ROOT=`（空）此前被 `??` 当成已设置，
  `path.resolve("")` 即当前目录——查找结果取决于 bridge 从哪启动。现在空白视为未设置。
  broker 之前不传 `serverRoot`，落到"env 与 profile pin 合并后的值"，pin 覆盖了运维者
  的 env；bridge 则显式传 env。现在 broker 与 bridge 同序：运维者的 env → profile pin
  → 默认。bundle 缺失的错误现在说明去哪装、怎么改。
- **broker 空闲自退不再无声**：`log()` 受 `ZCODE_ACP_DEBUG` 门控，与 `Restart=always`
  组合时守护进程每隔几秒无痕地退出重启。改为 `warn()`。
- **此前只有变异分析、没有 killer 的项，补上测试并验证**：`releaseSession` 使已武装的
  完成门静默（mutation.md X10）；attach socket 与子进程各管道的 `error` 监听
  （X27/X28，按"连续两次 emit 不抛"设计——一个残留的 `once` 监听会偶然吸收第一次
  错误，只有持久监听扛得住第二次）。broker 空闲自退（X23）：报告针对的快照
  4cfa1d3 确实没有 killer，592c65c 加入的两个空闲自退测试之后才覆盖；本轮复测
  确认该变异仍被它们杀死。

**没有修、也没有断言的**：`session.ts` 里的 `void sendSessionUpdate(...)` 没有 `.catch`
（审计标记为 UNVERIFIED）。blame 显示那行代码来自上游提交（2026-08-24），不在本特性
的 diff 内；`notify` 在对端关闭后是否拒绝未在活的 SDK 连接上复现，故不动。

### 环境变量一览

| 变量                                       | 作用                                                                                         | 默认                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------- |
| `ZCODE_ACP_BACKEND`                        | `direct` 回到旧的 app-server 子进程后端（无法识别的值告警并用 direct）                       | zserver                                |
| `ZCODE_ACP_ZSERVER_SOCKET`                 | **客户端 attach 与 broker bind 共用**的 socket 路径；`off` 关闭共享（每 bridge 私有 server） | `$XDG_RUNTIME_DIR/zserver-broker.sock` |
| `ZCODE_ACP_ZSERVER_IDLE_MS`                | 无会话监听且无在途请求 N ms 后回收 server 子进程                                             | 0（关闭）                              |
| `ZCODE_ACP_ZSERVER_TURN_QUIESCE_MS`        | terminal 后等流静默的宽限                                                                    | 300                                    |
| `ZCODE_ACP_ZSERVER_MAX_CLIENT_BUFFER`      | broker 每客户端入站缓冲上限（字节）                                                          | 8MB                                    |
| `ZCODE_ACP_ZSERVER_MAX_PENDING`            | broker 每客户端未决请求（未应答调用 + 存活订阅）上限                                         | 4096                                   |
| `ZCODE_ACP_ZSERVER_MAX_CLIENT_WRITE_QUEUE` | broker 每客户端未读回复/事件积压上限（字节），超限断开该客户端                               | 8MB                                    |
| `ZCODE_ACP_ZSERVER_BROKER_IDLE_EXIT_MS`    | broker 无客户端 N ms 后自退出（手动启动 broker 时）；bridge 自动拉起的 broker 默认 10 分钟   | 0（关闭）                              |
| `ZCODE_ACP_ZSERVER_KILL_ESCALATION_MS`     | dispose 时 SIGTERM→SIGKILL 升级延迟                                                          | 5000                                   |
| `ZCODE_SERVER_RUNTIME_ROOT`                | server 部署根（`node` + `zcode-server.cjs`）                                                 | `~/.zcode/server`                      |

本表只列生产代码读取的变量；测试夹具专用的 `ZSERVER_FAKE_*`/`ZSERVER_COALESCE`
见 `tests/fixtures/zserver-fake-server.mjs` 文件头，不属于运行时配置面。

注：`ZCODE_SERVER_RUNTIME_ROOT` 空白视为未设置，且优先于桌面 profile 的 pin
（bridge 与 broker 一致；此前 broker 让 pin 覆盖了运维者的值）。

注：自本节「默认共享 broker」起，不需要设置任何环境变量：zserver 是默认后端，
bridge 自动 attach 默认 socket，不存在则拉起 broker。socket 路径超过
sun_path 上限（Linux 107 / macOS 103 字节）时 broker 启动即报错而非静默
截断；Windows 不支持 broker（无 unix socket 语义），每个 bridge 各自
spawn server。

### 默认共享 broker（自动拉起与回收）

动机：每个 bridge 各开一个 `zcode-server.cjs`（~120MB + agent 子进程）既浪费又让
各会话互不可见；而要求用户配 `ZCODE_ACP_BACKEND`/`ZCODE_ACP_ZSERVER_SOCKET` 等于
默认不共享（实测 4 个 bridge 各有一个私有 server、socket 文件不存在）。

- **默认后端是 zserver**（`ZCODE_ACP_BACKEND=direct` 回到旧路径）。`server.ts` 构造
  `ZServerBackend` 时传 `autoBroker: true`；直接 `new ZServerBackend()`（测试、工具）
  默认不碰真实 broker。
- **attach 顺序**：显式 `ZCODE_ACP_ZSERVER_SOCKET` → 否则默认路径 → 失败回退私有
  server（与原先一致）。`ZCODE_ACP_ZSERVER_SOCKET=off` 关闭共享。Windows 不做 broker。
- **自动拉起**（`autospawn.ts`）：仅当 attach 报 `ENOENT`/`ECONNREFUSED`（没人监听）
  才拉起；wedged broker（ready 超时）、属主不符等不触发拉起，避免叠加第二个 broker。
  拉起后以 150ms 间隔重试 attach，最长 8s；失败后 60s 内不再拉起（一次等待，不是每次
  请求一次）；同进程 5s 节流。
- **生命周期（为什么 A 退出不会带走 B 正在用的 broker）**：broker 由 `detached: true`
  新会话拉起，stdio 指向 socket 旁的 `zserver-broker.log`，`unref()`，**不是**拉起者的
  子进程；`brokerBaseEnv` 剥掉 `MULTICA_*`/`SSH_*` 这类任务级凭据。A 退出、A 所在进程组被
  杀、编辑器关闭都不影响它。回收靠**空闲退出而非属主**：自动拉起时默认
  `ZCODE_ACP_ZSERVER_BROKER_IDLE_EXIT_MS=10min`，`onClient` 取消待触发计时器，最后一个
  客户端断开才重新计时——只要还有任何 bridge 连着，broker 就不会退出。
- **竞态**：两个 bridge 同时拉起，依赖 broker 已有的 bind 独占 + `removeStaleSocket`
  （dev+ino+birth time+ctime）——输家报 `already listening` 退出，两边都 attach 到赢家。
- **已知边界**：broker 是长驻进程，升级 zcode-acp 后旧 broker 继续服务到空闲退出
  （未做版本校验）；需要立即生效时 `pkill -f 'cli.js zserver-broker'`，下一个 bridge 会拉起新的。
  client 恰在 broker 空闲退出瞬间 attach 时，走既有 heal 路径（重新 attach/拉起）。
- **实测**（fake server，隔离 socket 目录，idle=4s）：A、B 先后启动 → 1 个 broker + 1 个
  server；A 退出后 broker/server 仍在；B 退出、空闲 4s 后二者都已退出、socket 已清理。

### 下拉以后端 registry 为准（模型切换与 reasoning 档位）

背景：`config.json`（桌面端维护）会漂移——上游改名后旧名留在里面（`claude-sonnet-5` →
`claude-sonnet-5-5`、`gpt-5.6-luna` → `gpt-6-luna`），下拉里选它们只会得到
`Provider Registry 中不存在 Model`；而后端只认 `provider_config.json` 的
`personalModelIds` 与内置账号模板。

- **personal provider 取自后端**（`config/personal-models.ts`）：`loadAllModels()` 在
  `provider_config.json` 可读时，用它**替换** `config.json` 里的非 builtin provider；不可读/为空才
  回退 `config.json`。builtin 模型若已由同名 personal 模型覆盖则不重复列出。`config.json` 不改。
- **活会话再按 `session/read` 收窄 builtin**：`buildConfigOptions` 拿到 `available` 后，builtin
  模型只在 `available` 或 personal registry 命中时保留（账号已换到 GLM-5.3，`GLM-5.2`/`GLM-4.7`
  留在 config.json 里只会报错）。注意 `available` 本身偏窄（`GLM-5.3-Flash` 不在其中却可切换），
  所以只用它做“排除”的一侧依据而不是白名单——与 personal registry 取并集。
- **reasoning 档位从后端的拒绝中学**（`runtime-model.ts`）：档位词表按模型且随版本变化
  （`gpt-6-luna` 只有 `enabled`/`disabled`，实测 max/high/…/none 全被拒；claude-* 是 low…max；
  GLM 是 low/high/max）。收到 `Reasoning level is required` 或 `Reasoning effort "X" is not
  supported` 时按 `max → high → enabled → medium → low → xhigh` 依次重试（有界，已试过的跳过）；
  成功的档位按 `provider/model` 缓存，下次首发即带。不去读 `zcode-builtin.json`（随版本漂移）。
  其他错误（如 registry 中不存在）不重试。
- **thought 下拉**本就来自 `session/read` 的 `thoughtLevel.available`，切换后重建即跟随新模型
  （`gpt-6-luna` 显示 `enabled/disabled`）。
- **实测**（真实 zcode-server，私有模式）：`gpt-6-luna`（enabled）、`gpt-5.6-terra/sol`、
  `claude-fable-5`、`claude-opus-5-5`、`claude-sonnet-5-5`、`GLM-5.3`、`GLM-5.3-Flash` 均切换成功。

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
- **M1b（已完成，真实一轮已跑通）**：`scripts/zserver-turn-probe.mjs`
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
  对话内容帧已由 `ZServerBackend` 经 `subscribeConversationV4`/
  `onDynamicConversationFrame` 映射（初始帧丢弃、按 topic 过滤会话、静默门
  控制 turn 完成）；仍未覆盖的项见"已知差距"。`desktop-attached-remote`
  权威下的 runtime-preferences 应答回路已在探针中就位（local 权威下 server
  自答、事件不触发）。
  **runtime-preferences 中继（已解决）**：desktop-attached-remote 权威下
  server 不自答 agent 的 `session/requestRuntimePreferences`，而是经动态事件
  `onDynamicSessionRuntimePreferencesRequest` 转发给连接客户端，须用
  `respondSessionRuntimePreferences({requestId, resolution:{status:"ok",
preferences}})` 应答，否则 `session/create` 超时并使后续 `sendText` 因
  agent 侧 session 行缺失报 `FOREIGN KEY constraint failed`。现由
  `ZServerBackend`（spawn 模式）或 `ZServerBroker`（共享模式，**仅 broker
  一处**应答，attach 客户端不再重复）实现，默认偏好取 server local 模式的
  默认值。强制 `ZCODE_SERVICE_AUTHORITY_MODE=local` 无法绕过——server 会经
  中继握手重新注入 `desktop-attached-remote`（agent `/proc/<pid>/environ`
  实证）。
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
