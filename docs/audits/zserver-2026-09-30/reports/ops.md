# 可观测性与可运维性审计（SRE 视角）— zserver 模式 / zserver-broker

- 审计对象：只读快照 `/tmp/zacp-snap-4cfa1d3`（HEAD 4cfa1d3，dist 已构建）。未读取/修改 `/mnt/data/Codes/offcial/zcode-acp`。
- 实验：`/tmp/audit-ops-xJMTSW/`（结束清理）；后端一律用 `tests/fixtures/zserver-fake-server.mjs`（复制为 serverRoot 下的 `zcode-server.cjs`），无真实 server、无真实凭据；泄漏类实验只用合成的 `FAKE-*` 串。
- 环境：Node v22.22.3，Linux 5.14（x86_64），uid 1000。
- 约定：表中 stderr 行前的 `+NNNms` 是**演练脚本**加的墙钟偏移——代码本身的 `log()/warn()` 不输出时间戳，也不输出 pid（见 Findings）。
- 本文件按"演练完成顺序"分段追加；文末依次是 Findings / 最小可观测性改造建议 / 日志卫生审计表 / 残留检查。


---
## 演练记录

### 演练 1 — broker 启动（每种情形 DEBUG 未设 / DEBUG=1 各跑一遍；退出码为实测）

| 场景 | 运维者看到的输出 | 退出码 | 能否一眼定位 | 建议 |
|---|---|---|---|---|
| 1a 启动成功 | **stdout** `zserver-broker: ready`（不是 stderr）；DEBUG=1 另有 stderr `[zcode-acp] zserver-broker: listening on <sock>`。socket 模式 0600；SIGTERM 后 socket 被删。**"ready" 打印时共享 server 尚未 spawn**（ps 里无 fixture 进程，懒启动） | SIGTERM→0 | 能看出"进程在监听"，**看不出 server 是否可用**（ready≠healthy）；broker 退出本身无任何日志（两档都没有 "received SIGTERM"） | 启动后 eager 探活一次 server 并打印 pid/version；停机打一行 |
| 1b socket 路径超长（128B，限 107） | stderr：`zcode-acp: fatal: Error: zserver-broker socket path is 128 bytes (limit 107): <path> — set ZCODE_ACP_ZSERVER_SOCKET to a shorter path (or XDG_RUNTIME_DIR)` + 3 行 `at ... dist/...js` 栈 | 1 | **能**（文案好）；栈是噪音 | 已知运维错误不打栈；给专用退出码 |
| 1c 已有 live broker | `zcode-acp: fatal: Error: zserver-broker: a live broker is already listening on <sock>` + 栈；先起的 broker 不受影响 | 1 | 能；但退出码与"真故障"相同——systemd `Restart=on-failure` 会把良性重复启动当故障循环重启 | 已在运行→专用码（如 75/EX_TEMPFAIL 或 0 可配置） |
| 1d stale socket（kill -9 遗留） | 路径仍是 socket 文件；重启直接 `ready`，**无任何"发现并清理了陈旧 socket"提示**（DEBUG=1 也只有 listening 一行） | 自动恢复 | 恢复成功，但无痕，事后无法知道发生过 | 清理陈旧 socket 时 `log()` 一行（含路径） |
| 1e 路径上是**普通文件**（33B，内容 `PRECIOUS-USER-DATA-DO-NOT-DELETE`） | broker 正常 `ready`；**文件被静默 unlink 并换成 socket**，broker 退出后路径为 absent，原内容不可恢复。DEBUG 开/关都无任何提示 | 0/运行中 | **不能**（数据被删且无日志） | 只 unlink `isSocket()` 为真且探测 ECONNREFUSED 的路径；否则报错退出 |
| 1f socket 父目录不存在 | `zcode-acp: fatal: Error: listen EACCES: permission denied <sock>` + 8 行栈 | 1 | **会误导**：真实原因是 ENOENT，Node v22.22.3 把 unix bind 的缺目录报成 EACCES（隔离脚本复现，未测其他 Node 版本）；默认路径回退到 `~/.zcode/`（XDG_RUNTIME_DIR 未设时），该目录不存在同样触发 | start() 前 `stat(dirname)` 给出 "directory does not exist" |
| 1g 路径上有**非 broker 的 live 监听者** | 同 1c 文案 "a live broker is already listening" | 1 | 能拒绝；措辞不准（任何监听者都被叫 broker） | 文案改 "something is already listening" |
| 1h 两个 broker 同时启动于同一 stale 文件之上（TOCTOU） | CLI 层 6/6 次恰好 1 赢 1 输（输家 exit 1，输家文案未采集）。**进程内强制交错**（两个 probe 都先于 unlink）：两个 `start()` 都 fulfilled、两个 server 都 `listening=true`；随后一次客户端 connect 落在 B 上、A 收到 0 次连接（A 是不可达的孤儿监听）；`A.stop()` 无条件 `unlinkSync(socketPath)` → **B 存活但路径 ENOENT，所有客户端 attach 失败并回退直连** | 0 | **不能**：B 日志里一切正常 | listen 前用 `wx` 语义/lockfile；stop() 只在 inode 仍是自己时 unlink |
| Windows（读码） | `assertSocketPathFits` 抛 `zserver-broker uses unix domain sockets and is not supported on Windows (use ZCODE_ACP_BACKEND=zserver without a broker: each bridge spawns its own server)`，走同一 fatal 路径 | 1 | 能（文案清晰）。[UNVERIFIED：未在 Windows 实跑；且 win32 下 `startGroupWatchdog` 直接 return，SIGKILL 后无孤儿回收] | — |

演练 1 附注：DEBUG=1 下 1f 未单独重跑（`start()` 的 listen 失败路径无 `log()` 调用，DEBUG 不改变输出，[读码]）。全部 fatal 类失败都经 `cli.ts:303-308` 的 `zcode-acp: fatal: ${err.stack}`，所以**每个启动错误都带内部栈**。


### 演练 2 — broker 运行期（真实 broker 进程 + fixture server + 独立实现编解码的原始 socket 客户端；DEBUG 未设 / =1 各一轮，另在私有 user/pid/net 命名空间内复测）

| 场景 | 运维者看到的输出（broker stderr） | 能否定位"是谁" | 建议 |
|---|---|---|---|
| 2a 客户端 attach/detach | **DEBUG 未设：完全无输出**（`log()` 门控）。DEBUG=1：`client 1 attached (1 attached)` / `spawning shared zcode-server` / `client 1 detached (0 attached)`。首个客户端触发懒 spawn 时（两档都有）`[zcode-acp] backend: desktop profile unavailable (desktop profile missing) — spawning server with plain env (local authority)`——由 **broker** 进程打出，却带 `backend:` 前缀 | 否：client id 是自增整数，重启即归 1，无 pid/uid/cmd/时间戳 | attach 时（异步）解析对端 pid+cmdline 并进日志；warn/log 加 ISO 时间戳与进程标签 `[broker pid=N]` |
| 2b 白名单拒绝（发 `credential.load`） | `[zcode-acp] zserver-broker: rejected client frame (call credential.load is not allowed through the broker) — disconnecting`（**warn，两档都有**，**无 client id**）。客户端侧只见 socket 被关，无原因帧 | **否**。DEBUG=1 时紧随一行 `client 2 detached (0 attached)`（同毫秒），只能靠相邻性猜——并发两个客户端就会猜错 | 拒绝日志带 client id + 对端 pid/cmd；发生拒绝时先解析、后 destroy |
| 2c 畸形帧（不可解码） | `undecodable client frame (Expected property name or '}' in JSON at position 1 (line 1 column 2)) — disconnecting`，**无 client id** | 否 | 同上 |
| 2d 帧超限（上限调到 64KB，客户端声称 200000B 并发 70000B） | `client 4 exceeded frame buffer limit — disconnecting`（**有 id**） | 只有 id，无 pid | 同上；日志里带上限值与实际缓冲字节数 |
| 2e 半截帧后挂起的客户端 | 无任何日志；broker **没有任何连接级空闲/握手超时**（读码：`onClient` 内无 `setTimeout`），该连接一直占用 `clients.size` | 否 | 见演练 6 的 idle-exit 实测 |
| 2g 共享 server 被 SIGKILL / 自身 exit(1) | `zserver-broker: shared server exited (code=null signal=null) — detaching 4 client(s)`（warn）。**实际是 SIGKILL / exit code 1，但日志恒为 `code=null signal=null`**：`connection.ts:134-136` 以 `handler(null, null, detail)` 调用，`broker.ts:227-231` 只取前两个参数，真正的 `detail`（`code=1 signal=null`）被丢弃。**且 server 的 stderr 尾部一个字也没进 broker 日志**（server 崩溃时打了一行 FATAL，broker 日志里检索不到，实测 `contains server stderr = false`） | 不适用（这是"哪层坏了"的核心证据，被丢了） | `onExit` 取第三参 `detail`；同时 `warn` 出 `stderrTailLines(5)`（截断+脱敏，见日志卫生） |
| 2h 崩溃后新客户端 attach | 懒重生成功，新客户端收到 Initialize（`fInit=true`）；已被踢的客户端由其自身 heal 路径重连 | — | broker 自愈行为良好；缺一条"respawned shared server pid=…"日志 |
| 2i 对一次**失败的第二次启动 / 任何裸 connect** | 命名空间内实测：探测连接使 live broker 打出 `client 1 attached` → `spawning shared zcode-server` → `client 1 detached`；**fixture server 数 0→1**。裸 connect 即触发共享 server 的懒 spawn（真实 server 握手约 1.9s（ADR M0 实测）、常驻约 120MB（`backend.ts:220-221` 的注释，非本次实测））；broker 无 server 级空闲回收，直到 broker 自身 SIGTERM 才被回收（2.5s 后 fixture 数回到 0） | — | 这直接决定健康探针设计（见演练 9） |
| 2j 日志注入 | 客户端发 body 为 `\n[zcode-acp] FORGED` 的畸形对象帧，broker 一个事件产生 **3 行** stderr，其中一行是以 `[zcode-acp] FORGED" is not valid JSON) — disconnecting` 开头的、外观合法的日志行（V8 的 `JSON.parse` 报错内嵌 payload 片段，约错误位置前后各 10 字符）。 | — | 记录前 `JSON.stringify` 转义 / 去掉控制字符，不内嵌 payload 片段 |

**对端身份（peer credentials）可行性——实测结论**

- Node 无 SO_PEERCRED：`net.Server` 接受的 socket 其 `_handle` 是 `Pipe`，实测 handle 仅 7 个 API 名，匹配 `/cred|peer|uid|pid|ucred/i` 的为空（`net.Socket` 上只有 TCP 用的 `_getpeername`）。
- `/proc/net/unix` **不够**：列为 `Num RefCount Protocol Flags Type St Inode Path`，没有对端 inode 列，只能得到"本端 inode"（accepted 端带 listener 的 Path，client 端无 Path），无法配对到 client pid。
- **`ss -xpn` 可行**（实测 3/3 + 2/2 命中）：`ss -xpnH` 输出 `Local:inode` 与 `Peer:inode`；broker 侧 accepted socket 的 `Peer` 即 client socket 的 inode，再按 inode 找到 client 行的 `users:(("node",pid=N,fd=M))`。在私有命名空间起 3 个带不同 argv 标签的 client 进程，join 结果与真值 pid 全部一致（match=true ×3）。
- **`lsof -U +E` 更省事**：一条命令直接给出 `->INO=<peer inode> <pid>,<comm>,<fd>`（同样实测命中）。
- broker 内可用 `readlinkSync('/proc/self/fd/'+sock._handle.fd)` 得到本端 inode（实测 `_handle.fd` 可读且 readlink 给出 `socket:[inode]`）。
- 代价：本机 2109 条 unix socket 时 `ss -xpnH` 约 **85–106 ms**（5 次）。仅用于 attach/拒绝这类低频事件可以接受，**不可**放在每帧路径。
- 权限：同 uid 的对端无需 root（本次实验全在无 root 的用户命名空间里完成）；跨 uid 的客户端本来就被 0600 socket 挡在外面。
- 平台：`ss` 仅 Linux；macOS 需 `lsof -U`；Windows 无 broker。
- 见"设计前提验证"一节（下方）——必须在 `socket.destroy()` **之前**解析。

**设计前提验证（peer pid 必须在 `socket.destroy()` 之前解析）**：在私有命名空间内，对同一连接分别在 destroy 前后跑 `ss -xpnH`——destroy 前 `server inode → peer inode → client pid` 命中（pid 8 = 真值 8）；destroy 后该 client 的行与 server 侧行**都已从 `ss` 消失**（对端收到 EOF 后自行关闭），无法再 join。而 broker 现有的所有"拒绝/畸形/超限"分支都是**先 `warn` 再 `socket.destroy()` 且 warn 里不含 client id**（`broker.ts:303/348-351/364-370/374-376`）。因此若做 peer 解析，必须挂在 `onClient()` 入口（attach 时一次，缓存进 `ClientEntry`）而不是拒绝时再补。另：`accepted._getpeername()` 对 unix socket 返回 `{}`（无用）。

**结论（问题 2 的"UDS 能否取 peer credentials"）**：Node 原生不能；`/proc/net/unix` 不能；**`ss -xpn` / `lsof -U +E` 可以**，在 Linux 上可作为 best-effort 替代（约 90ms，同 uid 无需 root），建议异步、超时 300ms、失败静默降级为只记 client id。

### 演练 3 — 客户端侧 ZServerBackend / ZServerConnection（进程内驱动，私有命名空间；捕获客户端全部 stderr）

| 场景 | 客户端看到的 stderr | `isDead` / `deathReason` / 后续请求错误 | 能否与其他原因区分 | 建议 |
|---|---|---|---|---|
| 3a 正常 attach 到 broker | **0 行**（attach 成功不打印；`ZServerBackend`/`ZServerConnection` 内**没有任何 `log()` 调用**，只有 `warn()`）。无公开 API 区分"已 attach / 直连"，只能窥探私有字段 `connection.child === null` | `isDead=false deathReason=null` | 不能确认自己连的是 broker 还是私有 server | attach 成功 `log()` 一行（路径+broker 身份）；暴露 `mode` getter |
| 3b-1 broker 拒绝一帧（`zcode-agent.compactSession` 不在白名单） | `backend: zcode backend reader exited (backend dead): zcode server exited (socket closed)` | `deathReason` = 同上；随后请求 `…(backend dead): zcode server channel client disposed`；**12ms** 内 `isDead=true` | — | |
| 3b-2 共享 server 被 SIGKILL | **同一字符串**（因 harness 进程内同时持有两个 attach 后端，出现两行相同日志——真实环境每个 bridge 一行，但行内无任何 id，两行无法区分） | `deathReason` **逐字节相同**；25ms | | |
| 3b-3 broker 被 kill -9 | 前一行多 `zserver: attach socket error (handled): read ECONNRESET`，其后 **同一字符串** | `deathReason` **逐字节相同**；31ms | | |
| → 结论 | 三种不同根因 → 客户端 `deathReason` 完全一致，且**措辞是 "zcode server exited"**。3b-1 与 3b-3 里 server 其实活着，被点名的是错误的一层。原因：`connection.ts:211` attach 路径的 close 一律回调 `"socket closed"`，`backend.ts:186-188` 拼成 `zcode server exited (…)`。broker 侧对应日志见演练 2（拒绝行无 client id、server 退出行 code/signal 恒为 null） | | **不能**（这是运维者"哪一层坏了"问题的核心缺口） | attach 模式下文案改为 `broker connection closed`；被拒绝时 broker 在 destroy 前写一个错误帧/或用可区分的关闭原因（见改造建议 #3） |
| 3c-1 broker 从未启动（ENOENT） | `backend: broker attach failed (connect ENOENT /tmp/…/b3.sock) — falling back to direct zcode server spawn`（**warn，恒输出**）；随后 profile 告警。请求成功（92ms），已在**私有 server** 上 | `isDead=false`（回退成功） | 能：含 errno 与路径，ENOENT vs 3c-2 的 ECONNREFUSED 可区分"没起 / 陈旧 socket" | 文案补后果：`this bridge now runs a PRIVATE server (~120MB); sharing is OFF until it exits` |
| 3c-2 陈旧 socket（ECONNREFUSED） | 同上，errno 换成 `ECONNREFUSED`（138ms） | 同上 | 能 | 同上 |
| 3c-3 回退是否"醒目" | 单行、与其它 warn 同格式同前缀，无时间戳，无后果说明；被随后的 `desktop profile unavailable…` 行紧接着冲淡 | — | 一般（要在满屏 `[zcode-acp]` 里找） | 见上 |
| 3c-4 回退是否粘性（**实测**） | broker 恢复后，同一后端再发请求 **2.5s+多次**：`attached=false` 不变，私有 server 一直在（fixture 数=1）。attach 只在 `spawn()` 内尝试（`backend.ts:141-154`），而 `spawn()` 只在 `this.connection` 为空时触发，即私有 server 自己死亡之后 | — | **看不出**哪些 bridge 已脱离 broker；`ps` 是唯一办法 | 至少加一行"回退为粘性"提示；或周期性/下次空闲时重试 attach |
| 3d-1 直连、bundle 不存在 | 进程内只出现 `desktop profile unavailable (desktop profile missing) — spawning server with plain env`（**误导：指向 profile，而真因是 bundle 不存在**）；bundle 路径只在请求错误里 | 请求错误：`zcode backend reader exited (backend dead): zcode server bundle not found: <path>`；`deathReason="spawn failed: zcode server bundle not found: <path>"`——两者前缀不同（wire 契约：前者让 heal 循环把永久性故障先当瞬时死亡重试，最终才按 `spawn failed` 归为 `zcode_spawn_failed`）。整段最终对编辑器可见文本见演练 5 | 靠 heal 日志能读到（演练 5） | spawn 失败在 `ensureConnection` 的 `.catch` 里 `warn` 一行含 deathReason |
| 3d-2 直连、`<root>/node` 缺失 | `zserver: deployed node missing at <root>/node, falling back to <execPath>`（warn） | 请求成功 | 能（文案好） | — |
| 3d-3 server 只起进程不打 hello（wedge） | 仅 profile 告警 | `zcode backend reader exited (backend dead): zcode server hello timeout after 10000ms`（10011ms 后） | 能：带 phase 与耗时 | 超时时 stderr 尾部为空则不附加（正确） |

**关联 id 审计**：`backend/zserver/*` 中所有 `warn()`（`backend.ts:51/148/189/215/424/513/520/578`，`connection.ts:106/154/207/415/425`）**没有一行带 sessionId 或请求 id**；`send(${method}) failed`、`conversation subscribe failed: ${error.message}`、`listener failed`、`runtime preferences respond failed` 都只有错误文本。`clientId`（`zcode-acp-zserver-<pid>`）会随 `createTask`/`sendPrompt` 的 body 发给 server，但 **attach 路径从不把它告诉 broker**（`connection.ts:186-226`：连上就等 Initialize，没有握手帧），broker 日志里只有自增整数。因此 bridge 日志 ↔ broker 日志 ↔ server 记录三者之间没有任何可 grep 的共同键；日志本身也没有时间戳（`utils.ts:145-153`），连"按时间对齐"这条退路也没有。

### 演练 5 — 真实 bridge 端到端（`dist/cli.js acp`，`ZCODE_ACP_BACKEND=zserver`，私有命名空间；用 ACP JSON-RPC 驱动，记录**编辑器/Multica 实际收到什么**）

| 场景 | 编辑器/Multica 收到的 ACP 响应 | bridge stderr（未设 DEBUG，全是 `warn`） | 能否定位 |
|---|---|---|---|
| 5a 握手前 server 崩溃（3 行 stderr，末行 900B，均含合成 `FAKE-*`；退出码 1） | `error.code=-32603`，`error.message="Internal error"`（**编辑器若只显示 message 就是这 4 个词**），`data.details`（1512B）= `zcode_backend_dead_after_retry: zcode create failed after 3 supervised restarts (zcode backend reader exited (backend dead): zcode server exited: code=1 signal=null: <末行 stderr 全文> \| stderr: <三行拼接，截到 400 字符>)` | 15 行 / 11.5KB，**同一长串重复 7 次**（`session/create hit a dead backend` 1 次 + `zserver respawn failed` 3 次 + `heal: create retry` 3 次），每次夹一行 `desktop profile unavailable…` | 稳定前缀 `zcode_backend_dead_after_retry` 分类可用；根因文本在，但被截断规则和重复淹没（见下） |
| 5b 握手后崩溃（收到 `sendPrompt` 即 exit(1)，单行 1.6KB stderr 含 FAKE bearer 与 api_key） | `data.details`（1816B）= `zcode_backend_dead_after_retry: zcode send failed: …zcode server exited: code=1 signal=null: <1.6KB 整行，无截断>` | 15 行 / 7.1KB，该整行出现 3 次；另有一行 `backend: … zcode server exited (code=1 signal=null)`（不含 stderr） | 同上 |
| 5c bundle 不存在（永久性 spawn 失败） | `data.details` = `zcode_spawn_failed: zcode create failed after 3 supervised restarts (spawn failed: zcode server bundle not found: <path>)`——**前缀区分了"永久不可启动"，且带路径** | 8 次 `desktop profile unavailable (desktop profile missing) — spawning server with plain env`（**每次 spawn 一条，误导：真因是 bundle 不存在，不是 profile**）；带 `ZCODE_ACP_HEAL_BACKOFF_MS=200` 时到客户端可见失败 2257ms；**默认 backoff 下 heal 间隔 0s / 1s / 4s ≈ 5s 才向客户端报告一个永久性错误**（`session.ts:1356-1360`，读码推算） | 能（路径+前缀）；但文案无修复提示（对比直连后端 `client.ts:144` 有 `install the zcode CLI, put it on PATH, or set ZCODE_BIN`；zserver 没有说该设 `ZCODE_SERVER_RUNTIME_ROOT`） |
| 6e 已 attach 的**空闲** bridge，broker 被 kill -9 | 无响应可言（无在途请求）。bridge 进程在 kill 后 **~1.8s 自行退出，退出码 0** | `backend: zcode backend reader exited (backend dead): zcode server exited (socket closed)`（warn，kill 后 21ms）；**随后 `shutting down (backend dead)` 走 `log()`，未设 DEBUG 时不可见**；**没有回退直连**（回退只发生在 heal 路径，而空闲 bridge 没有请求可触发 heal）。下一次编辑器请求落在已死的 stdio 上 | 只看到"socket closed"，且**退出码 0 伪装成正常退出** |

**stderrTail 泄漏路径（逐字节实测，`leak.mjs`；全部使用合成 `FAKE-*` 串）**

| marker（位置） | 进入 ACP `data.details` | 进入 bridge stderr（份数） |
|---|---|---|
| 握手期：第 1 行 stderr 内（~30B 处） | 是 | 是（7） |
| 握手期：第 2 行 stderr 内（~110B 处） | 是 | 是（7） |
| 握手期：900B 末行的**行尾** | **是** | 是（7） |
| 握手后：1.6KB 单行的**行首** | 是 | 是（3） |
| 握手后：同一 1.6KB 行的**行尾** | **是** | 是（3） |

结论：**"400 字符"上限只作用于其中一条路径**。`connection.ts:172-174` 的 `| stderr: … .slice(0, 400)`（仅握手失败）之外，`connection.ts:127` 的 exit 处理器把 `stderrTail.at(-1)`（**最后一行，原样全文，无上限**）拼进 `zcode server exited: <detail>: <line>`，该文本既是握手失败的 `exitFailure`，也是握手后所有在途请求被 `client.dispose(...)` 拒绝时的错误；它再经 `backend.ts:270-281` → `session.ts` 的 `zcode send failed: …` / `heal: …` warn → `classified(...)` → ACP `data.details`。**所以 400 是"看起来有上限"的假象**：实测 1.6KB 的行整行到达了编辑器，且在总是开启的 `warn` 里被重复 3–7 次。

### 演练 6 — 信号、回收、重启（私有 user/pid/net/mount 命名空间内，`ps` 全量精确；每项标注 fixture 行为，避免把"server 自己退出"误记为"被回收"）

| 场景 | 实测 | 运维者看到的日志 | 结论 |
|---|---|---|---|
| SIGINT → 有客户端、server 在线的 broker | exit **0**，+20ms；socket 文件被删；客户端连接被关；server 4ms 内消失（`stop()`→`dispose()`→`shutdown()` 向 server 进程组发 SIGTERM；fixture 同时会在 stdin EOF 时自退，**本行无法区分二者**）；看门狗 ~1.9s 后自退 | **无任何输出**（DEBUG=1 也无：`stop()` 没有日志，唯一的 `log` 是 idle-exit） | 干净，但**无痕**（事后无法知道是谁/何时停的） |
| SIGTERM | 同 SIGINT，exit 0，+23ms | 同上 | 同上 |
| **SIGHUP** | broker **被信号杀死**（`code=null signal=SIGHUP`），+15ms；**socket 文件残留**（stale）；无清理、无日志 | 无 | 从 ssh/终端启动的 broker，会话一断（SIGHUP）就无声死亡并留下 stale socket；重启可自恢复（见 1d），但期间所有 attach 客户端被 RST |
| **SIGUSR2** | 同 SIGHUP：`signal=SIGUSR2` 杀死 broker，socket 残留 | 无 | `kill -USR2` 是业界惯例的"打印状态"信号，在当前实现下是**杀死共享 broker**（影响所有 bridge） |
| kill -9 broker（server 有一个**忽略 SIGTERM 的同组孙进程**） | broker 秒杀；客户端立即见 close；server 114ms 消失（fixture 自退）；**孙进程 1704ms 后被看门狗 SIGKILL 整组回收**；看门狗随后自退。重启于 stale socket：自动恢复，日志仅 DEBUG 下 `listening on …` | 无"发现 stale socket"提示 | **回收有效**：看门狗按设计工作，孤儿窗口 ≤ ~2s |
| kill -9 broker（**不死 server**：吞 EPIPE/EOF，n=6，以隔离"看门狗"这一因素） | server 消失时间（ms）：1945 / 1940 / 1981 / 1961 / 1955 / 73 | — | 与看门狗 2000ms 轮询一致（相位近乎固定）；**看门狗是唯一保障** |
| SIGTERM broker，且 server **忽略 SIGTERM + 不死**，`KILL_ESCALATION_MS=500`（n=6） | broker 21–41ms 就退出；server 直到 **1929–2003ms** 才消失（**6/6 晚于 500ms 升级点**） | 无 | 文档里的"SIGTERM→SIGKILL 升级延迟"在 **broker 路径上不生效**：`shutdown()` 的升级定时器是 `unref` 的，而 `cli.ts:162-163` 在 `stop()` 后立刻 `process.exit(0)`；真正兜底的是看门狗（~2s 内）。默认值 5000ms 因此**对 broker 是误导**（对长寿命 bridge 的 idle 回收才有意义） |
| **broker 重启的重叠窗口**（server 忽略 SIGTERM，SIGTERM 后立即起新 broker 并 attach） | 新共享 server 就绪时，**旧 server 仍存活的次数 = 4/5**（`[2,2,1,2,2]`） | 无 | 重启期间最多 ~2s 出现两个共享 server（同一 workspace 的 sqlite/端口类资源争用风险 — [UNVERIFIED：未对真实 server 验证]） |
| SIGTERM 于**共享 server spawn 卡住（不发 hello）**时 | broker **9243ms** 才退出（`stop()` 先 `await this.spawning`，被 10s hello 超时卡住）；期间客户端一直拿不到 Initialize；日志只有 `server spawn failed for client 1: zcode server hello timeout after 10000ms`（在 10s 时才出现） | 无"正在停止"提示 | 9.2s 已逼近 `docker stop` 默认 10s 宽限（会被升级为 SIGKILL 并留下 stale socket）；systemd 默认 `TimeoutStopSec=90s` 不受影响。另：`process.once("SIGTERM", stop)` 用的是 `once`，**第二个 SIGTERM 走默认动作直接杀进程**——**已实测（演练 8-D2）**：第二个 SIGTERM 于 +1508ms 令 broker `signal=SIGTERM` 死亡，socket 文件残留（stale） |
| idle-exit（`BROKER_IDLE_EXIT_MS=1500`） | (a) 客户端离开后 **1516ms** exit 0，server 回收，socket 删除 ✔；(b) **幽灵客户端**（发 5 个杂散字节后不关闭）→ 9s 后 broker **仍在运行（idle-exit 被永久阻塞）**：无连接级空闲/握手超时 | idle-exit 那一行是 `log()`，未设 DEBUG 不可见 | ADR 环境变量表没有提这个阻塞条件 |
| **广播影响：优雅重启 broker**（2 个**空闲**已 attach 的真实 bridge） | broker SIGTERM 后，**两个 bridge 都在 ~1.96s 内自行退出（exit 0）** | bridge 侧：`backend: zcode backend reader exited (backend dead): zcode server exited (socket closed)`；随后的 `shutting down (backend dead)` 是 `log()`，未设 DEBUG **不可见** | **重启 broker = 顺带重启所有空闲编辑器的 ACP agent 进程**。而有在途 prompt 的 bridge 走自愈（见下），两种行为不一致 |
| **在途 prompt** 的 attached bridge，broker kill -9 | **203ms** 内出现回退 warn；bridge 存活；序列：`zcode server exited (socket closed)` → `prompt: backend died mid-turn — supervised self-heal + resend` → `broker attach failed (connect ECONNREFUSED …) — falling back to direct zcode server spawn`；此后 bridge 有了**自己的私有 server**（ps 计数 1），且不再回到 broker | 上述三行（warn，恒输出） | 在途场景自愈良好、时延低；但**回退后共享永久丢失**（见演练 3c-4） |
| 空闲 bridge，broker kill -9（演练 5 的 6e） | bridge ~1.8s 后 **exit 0**；无回退 | 仅 `zcode server exited (socket closed)` 可见 | 同上，且**退出码 0** 让 supervisor 无法区分正常退出与后端死亡 |
| **误归因**：server 被 SIGKILL 时有一个在途请求；此前 server 曾向 stderr 写过一行无关内容 | 在途请求被拒绝为 `ConnectionClosed: zcode server exited: code=null signal=SIGKILL: ZSERVER_UNSUB:0` | — | 文案把**一条很久以前的无关 stderr 行**当作死因附上（`connection.ts:127` 只取 `stderrTail.at(-1)`，不看时间/是否与本次退出相关） |

**看门狗的运维可见性**：看门狗是 `node -e '<脚本>'`，`ps` 里显示成一长串 `node -e const ownerPid = N; const pgid = M; …`（约 45MB RSS 的裸 node 进程，每个 server 一个）——运维者在 `ps`/`pstree` 里看到的是一堆没有名字的 `node -e`，**无法一眼认出属于 zcode-acp**（无 `argv0` 标记、`env: {}` 不带任何标识）。属于可运维性小缺口。

**补充演练 5d — 真实 Node 崩溃格式下 stderrTail 的实际效果**（server 因未捕获异常崩溃，异常对象带一个含合成 `FAKE` bearer 的 `config.headers.Authorization` 属性；这是 axios 类 HTTP 错误常见的形状）

真实崩溃的 stderr 共 13 行，`Node.js v22.22.3` 是**最后一行**，敏感属性在中间（第 8–11 行）。实测：

| 路径 | 编辑器收到的 `data.details` | 含 FAKE bearer？ | 含真实错误文本（`request failed with status code 401`）？ |
|---|---|---|---|
| 握手前崩溃（取末 3 行拼接） | `…zcode server exited: code=1 signal=null: Node.js v22.22.3 \| stderr:   } / } / Node.js v22.22.3` | 否 | **否** |
| 握手后崩溃（取末 1 行） | `…zcode server exited: code=1 signal=null: Node.js v22.22.3` | 否 | **否** |

含义（两面都要写清楚）：
1. **对最常见的崩溃形状，stderrTail 既不泄漏也不诊断**：运维者拿到的 "死因" 只是 Node 版本横幅，真正的错误（401）在两个通道（ACP、bridge stderr）里都**看不到**——因为只取最后 1/3 行，而 Node 未捕获异常转储把真正的信息放在中间。
2. **但只要最后一行是一条日志行，就整行透传**（演练 5a/5b：900B/1.6KB 行整行、含 `Authorization: Bearer …` 与 `api_key=…`，到达编辑器并在 always-on warn 中重复 3–7 次）。泄漏与否取决于"server 的哪一行恰好最后写"，**不是设计保证**。
3. 内容取舍应改为：按"已知敏感模式"脱敏后再取尾、并优先保留含 `Error`/`FATAL` 的行，而不是"最后 N 行"。

**server bundle 的结构性事实**（只读 `~/.zcode/server/zcode-server.cjs` 的**代码结构**，未读任何配置值；全部为结构判断）：
- bundle 内有 `redactAgentDiagnostic()`，模式覆盖 `api[-_]?key|authorization|cookie|credential|password|secret|token` 赋值、`Bearer|Basic <token>`、`sk-…`，且 agent stderr 尾部每行截 1000 字符 + 保留 20 行（约 `bundle:213877` 附近，`AGENT_STDERR_*` 常量）。**这说明 server 作者本人认为 stderr 里会出现凭据**。
- **但该脱敏作用于 server 捕获的 agent 子进程 stderr，不是 server 自身的 stderr**。zcode-acp 读取的是后者（`connection.ts:348-358`），且 zcode-acp 侧**没有任何脱敏**。server 自身 stderr 是否已脱敏：**UNVERIFIED**（未在真实崩溃上验证）。
- bundle 里存在 `[zcode-process-exception] <json>` 这一结构化诊断行格式（`ZCODE_PROCESS_DIAGNOSTIC_PREFIX`，name≤128/message≤4000/stack≤16000 字符，带 `errorId`/`occurredAt`），当前 zcode-acp **没有解析它**；若 server 自身崩溃也发这一行，则可以拿到结构化、已脱敏的死因（**UNVERIFIED**：未确认 server 主进程是否发出该行）。

### 演练 9 — 健康探针（`--probe` 的可行性，脚本实证）

探针脚本（**19 行 / 17 行有效代码**，已另存 `/tmp/audit-reports/ops-probe.mjs`）：连 broker socket，读到第一帧并逐字节确认是 `Initialize`（`[200]` + `undefined`，负载 6 字节）则退出 0；否则按原因给不同退出码。**协议可行，全部为实测**（私有命名空间，fixture server）：

| 状态 | 探针退出码 | 耗时 | 文本 |
|---|---|---|---|
| 无 broker，socket 路径不存在 | **10** | 242ms | `ENOENT: connect ENOENT <sock>` |
| stale socket 文件（kill -9 遗留） | **11** | 193ms | `ECONNREFUSED` |
| 路径上是普通文件 | 11（与 stale 无法区分） | 170ms | `ECONNREFUSED`（Linux 对普通文件 connect 同样返回 ECONNREFUSED） |
| 有 live 监听者但不说话（decoy） | **13** | 1649ms（预算 1500） | `no Initialize within 1500ms` |
| 健康 broker，**冷**（首个客户端触发共享 server spawn） | **0** | 196ms（fixture；真实 server 约 1.9s，见 ADR M0，预算需 ≥5s） | — |
| 健康 broker，热 ×5 | 0 | 104–228ms（含约 40ms node 启动） | — |
| broker 在，共享 server 刚被 SIGKILL | **0**（探针触发懒重生） | 211ms | — |
| broker 在，共享 server **卡住不发 hello** | 预算 3s → **13**；预算 15s → **12**（broker 在 10s hello 超时后掐断连接） | 3122ms / 7052ms | 两种退出码的语义：13=服务未就绪，12=服务 spawn 失败 |

**"0" 的含义强于 TCP 连通**：broker 只有在 `ensureServer()` 成功（共享 server 完成 hello + Initialize）后才向客户端写合成 Initialize（`broker.ts:331-336`）。所以探针 0 = broker 存活 **且** 共享 server 进程已握手就绪，不只是"端口通"。它**不**验证 server 能处理 RPC（白名单里没有 `initialize`，见"最小改造"）。

**实测暴露的三个副作用（决定探针不能原样上线）**：
1. **探针会触发共享 server 懒 spawn**：冷 broker 下 fixture 数 0→1。真实 server 约 120MB + agent 进程。用探针做"是否需要保活"的判断会自我实现。
2. **周期性探针永久阻止 broker idle-exit**：`BROKER_IDLE_EXIT_MS=2500`，无探针时 2489ms 退出；每 ~0.7s 一次探针（12 次）→ 9662ms 仍在运行；停止探针后 11470ms 才退出。
3. **DEBUG=1 下每次探针 2 行日志**（`client N attached` / `client N detached`），且 `nextClientId` 递增——之后 WARN 里的 client id 会莫名偏大。
→ 结论：探针必须**绕开数据路径的 accept 副作用**——而 accept 副作用（占 id、清 idle、触发 spawn）在**任何** connect 上都会发生（实测：不发字节的 connect+close 同样使 fixture 数 0→1），所以探针不能走数据 socket。可行做法是独立控制 socket（见"演练 4b"原型实测）。上面 0/10–14 的退出码矩阵作为**客户端协议**仍然成立，只是应当连控制 socket。

### 演练 4 — 关键状态自省（能否不重启就看到 client 数 / 共享 server pid / 订阅数 / 未决请求数）

**现状（读码 + 实测）：没有任何自省手段。**
- `ZServerBroker` 的全部状态是私有字段（`clients` Map、`connection`、`nextServerId`、每个 `ClientEntry` 的两个 id Map，`broker.ts:147-163`），无 getter、无信号处理、无命令、无 stats 帧。
- `cli.ts:172-173` 只注册 SIGINT/SIGTERM。**实测 SIGUSR2 与 SIGHUP 默认动作是"杀死进程"**（演练 6：broker 被信号杀死、socket 残留、所有 bridge 被断开）；SIGUSR1 被 Node 用于开 inspector（实测 `Debugger listening on ws://127.0.0.1:9229/…`，并真的在回环监听 9229）。所以"`kill -USR2` 打印状态"在**当前代码下会杀掉共享 broker**——必须先注册处理器再谈用它。
- 订阅数 / 未决请求数：`entry.idByClient.size` 同时包含"未决 promise"与"长期事件订阅"（`broker.ts:390-392`），且 broker 收到终态帧才删除 promise id；要区分两者需要记录 header 类型（100 vs 102）。**当前没有，需新增小改动**。

**零改动的外部近似（已实测可用）**：用 `ss -xpn` + `/proc` 拼出 broker pid、共享 server pid、client 数与每个 client 的 pid+命令行。脚本已存 `/tmp/audit-reports/ops-status-ext.mjs`（约 25 行）。在真实 bridge ×2 + 1 个原始客户端 + 1 个 broker 的场景下，**DEBUG 未设、broker 自身日志为空**时，该脚本 195ms 给出：

```
broker: pid=8 comm=node cmd=…/node /tmp/zacp-snap-4cfa1d3…
shared server: 24
attached clients: 3
  - pid=38 …  - pid=1 …  - pid=16 …
```

三个 client pid（38 / 1 / 16）与驱动脚本记录的真值（bridge#1=16、bridge#2=38、raw=1）**完全一致**；共享 server 通过 `ps --ppid <broker>` 识别。限制：只有 Linux；订阅数/未决请求数不可得；命令行在我的原型里被截到 70 字符所以只看到脚本路径前缀（这是原型的显示问题，不是技术限制）。

**最小实现建议的可行性判断（更正版；初稿把"同 socket 私有请求头"当作可行，经读 `onClient()` 与实测后撤回）**

- **撤回**："同一 socket 上加私有请求头（如 104），broker 在 `validateClientHeader` 前识别并直接应答，不 spawn、不占 id、不重置 idle"**不可行**。原因（`broker.ts:283-341`，已实测）：`onClient()` 在 accept 的**同一同步段**里就 `nextClientId++`、`log(attached)`、清 `idleTimer`，并立即 `void this.ensureServer()`；而真实客户端（`ChannelClient` 在收到 Initialize 前会排队一切请求）**在拿到 Initialize 之前不会发任何字节**，所以 broker 无法"等第一帧再决定要不要 spawn"。实测：对未改动的 broker 做**一次不发任何字节的 connect+close**，fixture server 数 0→1，DEBUG 日志出现 `client 1 attached` / `spawning shared zcode-server` / `client 1 detached`。`routeClientFrame` 也以 `await this.ensureServer()` 开头（`broker.ts:346`），同样先于解码。
- 因此可行方案只有：**(a) SIGUSR2 状态转储**（无协议改动、无副作用）；**(b) 独立控制 socket**（`<sock>.ctl`，探针/status 走它，与数据路径完全隔离）；**(c) accept 后设短宽限再 spawn**（每次 attach 增加固定延迟，且要重构 accept 时的登记逻辑，不推荐）。
- 行数以"下文原型实测"为准，见"演练 4b"。

### 演练 7 — CLI 契约（退出码 / 流 / 参数处理；hermetic HOME；`profile` 类命令用合成 runtime-host 让捕获成功后再变换导出目标）

| 命令 | 退出码 | stdout / stderr | 结论 |
|---|---|---|---|
| `zserver-broker --help` / `-h` | **不退出**（被我的 1.5s 超时 SIGKILL） | stdout `zserver-broker: ready` | **`--help` 会真的启动一个 broker**（`cli.ts:153-175` 完全不解析 argv）。3 点被叫醒的人敲 `--help` 得到一个前台 daemon 并占用 socket |
| `zserver-broker --probe` / `status` / `--no-such-flag` | 同上 | 同上 | 任何多余参数都被静默忽略并启动 broker |
| `zserver-broker --socket <path>`（同时 env 指向另一路径） | 同上 | 实测只创建了 env 指向的 socket，`--socket` 路径未创建 | **`--socket` 被静默忽略**，broker 绑的是 env（或默认）路径；与客户端约定不一致时只会表现为"attach 失败并回退" |
| `--help` / `help` | 0 | stdout 30 行 | HELP_TEXT 的 broker 条目只有两行（`cli.ts:98-99`），**没有** `ZCODE_ACP_BACKEND`、`ZCODE_ACP_DEBUG`、退出码、信号、socket 默认路径 |
| `--version` | 0 | `0.13.0` | — |
| 未知子命令（含 `zserver-brokre` 手误） | **1** | **用法全文打到 stdout**，错误一行在 stderr | 错误用法信息应走 stderr；管道/systemd 场景 stdout 被污染 |
| `profile`（缺动作） | 1 | `unknown command 'profile'` | 措辞误导（`profile` 是已知命令，缺的是 `refresh|export`） |
| `profile export a b` | 1 | `unknown command 'profile export a b'` | 同上 |
| REPL 无 TTY（`cli.ts:139`） | **2** | stderr 一行 | 同为用法错误，此处用 2、上面用 1，**契约不统一** |
| 无桌面在运行时：`profile export` / `export /nonexistent/…` / `refresh` | 1 | 恒为 `zcode-acp: desktop profile missing` | **捕获失败先于目标路径校验，且原因被折叠成一个枚举**：无 zcode-cli 进程 / 无 runtime-host 祖先 / 环境不一致 / 非 Linux，运维者无法区分（代码里 `desktop-profile.ts:54` 的错误类只带 code，没有 detail） |
| 合成 host 下 `export` 到新文件 | 0 | stdout 打印路径；文件模式 0600 | 好 |
| `export` 覆盖已有文件 | 0 | 静默覆盖（11B → 765B） | 代码注释明说不用 O_EXCL（`cli.ts:225-227`），行为一致，但无提示 |
| `export` 到目录 / 符号链接 / `/dev/full` / 空路径 | 1 | `zcode-acp: cannot write profile export to <path>: <errno …>` | 好：带路径与 errno（目录/符号链接的具体 errno 文本在我的表格里被截断，未逐条核对） |
| `export` 到只读目录 | **1**（EACCES，带路径） | `cannot write profile export to …: EACCES: permission denied, open '…'` | **注意**：我第一次在"映射为 root 的命名空间"里测得 exit 0，那是 root 绕过 DAC 的**测试伪影**；改用无 uid 映射（65534，真实 DAC）的命名空间复测后为 1。此前草稿里的 0 作废 |
| `profile refresh`，当 `XDG_CONFIG_HOME` 只读 | 1 | **`zcode-acp: desktop profile invalid`** | **真实原因是 EACCES 写不了 profile 文件**，却被 `cli.ts:181-183` 的兜底文案 `"desktop profile invalid"` 覆盖（非 `DesktopProfileError` 一律换成这句） |

退出码全集（实测 + 读码）：`0` 成功；`1` 一切失败（包括**良性**的"已有 live broker"、路径超长、EACCES、未捕获异常 `cli.ts:305`）；`2` 仅 REPL 无 TTY。**没有一个专用码可让 supervisor 区分"重复启动（无需重启）"与"真故障"**。`zserver-broker` 的 `ready` 走 **stdout**，其余诊断走 stderr。

### 演练 8 — 运维者会踩的配置/时序陷阱（私有命名空间；除注明外均为实测）

| 场景 | 实测 | 运维者看到 | 结论 |
|---|---|---|---|
| **8-A** broker 用默认路径起（`$XDG_RUNTIME_DIR/zserver-broker.sock` 已 bound），bridge 只设 `ZCODE_ACP_BACKEND=zserver`（**不设** socket 变量），bridge 与 broker **均 DEBUG=1** | 0 个客户端 attach；bridge 的 fixture server 的父进程是 bridge 自己（`ppid=16`=bridge pid） | **bridge stderr 中匹配 `broker\|attach\|socket\|private\|shar` 的行数 = 0**；broker 日志无任何 attach | 客户端**不会**去找默认路径（`backend.ts:138` 只读 env，无默认）；bridge 静默运行私有 server，而健康的 broker 空转。ADR 环境变量表把默认值 `$XDG_RUNTIME_DIR/zserver-broker.sock` 写在"客户端 attach 与 broker bind 共用"这一行，容易被读成两边都有默认；同页的注释说"attach 需要同时设置二者"，但 HELP/README 都没有 |
| **8-A2** `ZCODE_ACP_ZSERVER_SOCKET=" <path>"`（前导空格，EnvironmentFile 引号手误） | broker 用 `.trim()`（`broker.ts:26`）正常绑定；bridge 用原值（`backend.ts:138`）→ 回退 | bridge：`broker attach failed (connect ENOENT  <path>) — falling back…`（**路径前两个空格是唯一线索**）；broker 全程无客户端 | 两侧对同一变量的规范化**不一致** |
| **8-B** 运维者设 `ZCODE_SERVER_RUNTIME_ROOT=<ROOT>/root`；桌面（合成）profile 把该键钉到 `server-PIN` | **broker 用了 profile 的 pin（server-PIN）**，无视运维者的 env；**同一 env 值下 bridge 直连模式用了运维者的值（root）** | broker 日志只有 `spawning shared zcode-server`，**不含 bundle 路径、版本、pid**（命中 `zcode-server.cjs\|pid=\|server-PIN` 的日志行 = 0） | 原因：`runtimeEnvWithProfile` 是 `{...base, ...pins}`（`backend.ts:49`，pin 覆盖 env），broker 不传 `serverRoot`（`cli.ts:155`）→ 落到 `options.env.ZCODE_SERVER_RUNTIME_ROOT`（`connection.ts:141-145`）即被覆盖的值；bridge 则显式传 `serverRoot: process.env.ZCODE_SERVER_RUNTIME_ROOT`（`server.ts:253`）。**两者对同一变量的优先级相反**。本机真实 zcode-cli 环境里确有 `ZCODE_SERVER_RUNTIME_ROOT` 这个键（仅看键名，未读值），所以在装了桌面的机器上该不对称是真实存在的；两值是否恰好相等 [UNVERIFIED] |
| **8-C** 客户端可控字符串进入**常开**的 warn | 一帧带 **4,000,000 字符** channel 名 → broker 一次性向 stderr 写 **4,000,240 字节**（单行）；50KB 名 × 40 次连接+拒绝 / 4s → **2.0MB** 常开 stderr（≈500 B/ms，无限流、无去重）；名字里带 2 个换行 → **3 行**物理 stderr，其中第 2、3 行是外观合法的伪造日志（`client 1 detached (0 attached)`、`shared server exited (code=0 signal=null)…`） | `[zcode-acp] zserver-broker: rejected client frame (call credential.load` / `[zcode-acp] zserver-broker: client 1 detached (0 attached)` / `[zcode-acp] zserver-broker: shared server exited (code=0 signal=null) — detaching 0 client(s) is not allowed through the broker) — disconnecting` | **日志伪造 + 洪泛**：`broker.ts:119`（拒绝原因内嵌未转义、未限长的 channel/name）经 `broker.ts:374` 无条件 warn。socket 是 0600，只有同 uid 主体能触发（ADR 威胁模型里正是这类主体）。对 journald/`Zed.log` 的影响是日志完整性与体积，而非凭据 |
| **8-D1** 两个 broker 在同一 stale socket 上近乎同时启动（0–6ms 错开，自然竞争，×40） | **40/40 恰好一个赢家，0 次双 ready**；输家 39 次是 `a live broker is already listening`，**1 次是裸 `Error: ENOENT: no such file or directory, unlink '<sock>'`**（两者都看见 stale 文件，先到者 unlink，后到者的 `unlinkSync` 抛 ENOENT，`broker.ts:186`） | 输家为一个带栈的 fatal | 自然频率下双 ready 未复现（强制交错才复现，见演练 1h）；但 1/40 的输家给出了与真因（"有人先抢到了"）无关的文案 |
| **8-D2** SIGTERM 后 1.5s 再发一个 SIGTERM（此时 `stop()` 正阻塞在卡住的 server spawn 上） | broker 以 `signal=SIGTERM` 死亡（+1508ms），**socket 文件残留** | 无 | `cli.ts:173` 用 `process.once`，第二个信号落回默认动作（杀进程） |
| **8-D3** `BROKER_IDLE_EXIT_MS=1500`，broker 开机启动、始终无客户端 | 约 2.8s 后 **exit 0**，无任何日志（stderr 空；stdout 只有 `ready`） | — | `start()` 末尾就 `armIdleExit()`（`broker.ts:213`）；与 `Restart=always` 组合会每 ~2s 重启一次，且每次 exit 0 无痕。ADR 表格只写"无客户端 N ms 后自退出" |

### 演练 E — broker 在、但它自己的 server 起不来 / broker 挂死（进程内 ZServerBackend，私有命名空间）

| 场景 | 客户端 stderr | 结果 | 结论 |
|---|---|---|---|
| **E1** broker 在，但**它的** `serverRoot` 下没有 bundle（客户端自己的 root 正常） | `backend: broker attach failed (zcode server exited: socket closed) — falling back to direct zcode server spawn` | 请求在 131ms 内成功，但已落在**私有 server** | 客户端文案再次说 "zcode server exited"（此处根本没有 server 退出过）；**真因 `zcode server bundle not found: <path>` 只在 broker 日志里**（`server spawn failed for client 1: …`）。结果是：**一个起不来 server 的 broker 会让所有 bridge 静默降级为私有 server，且从 bridge 侧完全看不出原因** |
| **E2** 某个 live 监听者接受连接但**永不发 Initialize**（挂死的 broker / 路径被别的进程占了） | `broker attach failed (zcode server ready timeout after 15000ms) — falling back…`（在 **17.0s** 时才出现） | 请求在 **15108ms** 后成功（私有 server） | attach 等满 `READY_TIMEOUT_MS=15000`（`connection.ts:14`）才回退 |
| **E3** 同 E2，但请求自己带 15s 超时（`session/create` 实际传的值，`session.ts:202`） | 同上（+32.5s） | **15083ms 后返回 ok**，不是超时错误；随后 `isDead=false deathReason=null` | `request()` 的 per-request 超时只包住 `route()`（`backend.ts:255`），**在它之前的 `await this.ensureConnection()`（`backend.ts:248`）不受这个超时约束**。运维者看到的是"首个 prompt 卡 15s"，唯一线索是之后才出现的一行回退 warn |
