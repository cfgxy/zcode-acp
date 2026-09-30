# 变异战役 + 测试基建自审（zserver 测试套件）

审计对象：冻结快照 `/tmp/zacp-snap-4cfa1d3`（HEAD 4cfa1d3）。变异只在拷贝 `/tmp/audit-mut-7a5b47d170e6/repo` 上做（软链 node_modules 保留，未 git 操作，未触碰 `/mnt/data/Codes/offcial/zcode-acp` 的源码）。
测试命令：`npx vitest run tests/zserver-*.test.ts --no-cache`（vitest 2.1.9，6 个文件 / 71 个用例）。`--no-cache` 是为了不让 vitest 往软链指向的主仓库 `node_modules/.vite` 写 results.json（实测主仓库该文件 mtime 全程未变，18:46:33）。

## 方法与自校验（Segment 1）

- 变异流程：`cp X X.mutbak` → 精确字符串替换（`old` 必须恰好匹配 1 次，否则判 NOT-APPLIED，绝不当作"存活"）→ 跑 vitest（json reporter）→ `mv X.mutbak X` → 与快照原件 md5 比对。脚本：`/tmp/audit-mut-7a5b47d170e6/tools/{mutants,run-mutant}.mjs`；每个变异的 diff / 日志 / json 在 `.../out/<ID>.{diff,log,json,result.json}`。
- 基线（未变异）：2 次全绿 71/71（16.3s、15.7s）。
- Harness 自检：哨兵变异 S1（`ChannelClient.dispose()` 不再 reject 挂起请求）必须变红 → 实际 RED（`fails queued requests closed on dispose` 5s 超时），证明被改的文件就是测试真正执行的那份。
- 每个变异后扫描带审计标记环境变量的残留进程：全部 0 残留。
- 每次变异后 md5 与快照一致：全部 `restored-OK`（汇总见最后一段"还原自证"）。

## Mutation Results（M1–M20，用户指定清单）

| 编号 | 变异 | 结果 | 杀死它的测试或缺口（断言性质） |
|---|---|---|---|
| M1 | broker `validateClientHeader` 白名单检查恒不拒绝 | KILLED（2 红；security 文件重跑 3/3 红） | security › "rejects credential/terminal/file/git and every non-allowlisted method"（断言纯函数 verdict，行为级）；security › "a live broker disconnects a client that sends a forbidden call"（行为，但观测点是私有 `clients` Map 轮询） |
| M2 | `header.length > 4` → `> 8` | **SURVIVED（判定验证等价）** | 差分模糊 37,446 个 header：`ok` 差异 0；仅 `reason` 文案差异 11,520。原因：后面 `length===2`（101/103）与 `length!==4`（100/102）两个分支已拒绝所有长度 5..8。缺口=没有任何测试断言 reason 文案；要杀只能断言实现细节（见 Missing Tests K-M2，标注 cosmetic） |
| M3 | 去掉 `Number.isInteger(id)` | KILLED | security › "rejects malformed shapes that would bypass id rewriting"（仅 `1.5` 这一条输入起作用；行为级） |
| M4 | `BROKER_BIND_UMASK` 0o177 → 0o022 | KILLED | security › "binds the socket 0600 AT CREATION…"（`expected 493 to be 384`）。观测走生产代码里的 `onBoundForTest` 钩子（随后的 chmod 0600 会掩盖变异，所以必须有 seam）；行为级但依赖测试 seam |
| M5 | `maxClientBufferBytes` 检查整体注释 | KILLED（broker 文件重跑 5/5 红） | broker › "disconnects a client whose buffered frames exceed the cap"；断言读私有 `broker.clients.size`（实现细节）。该测试注释称"client 侧 socket 事件在 vitest worker 里观测不到"——**实测不成立**：根因是未消费(paused)的 raw socket 不会 emit `close`，`raw.resume()` 后 vitest 内 111ms、裸 node 内 50ms 即可观测（见 Infra F9） |
| M6 | `nextServerId` 起点 1_000_000 → 1 | KILLED（弱） | 只有 broker › "delivers repeated EventFire frames and honors unsubscribe end-to-end" 靠正则 `/ZSERVER_UNSUB:\d{6,}/` 杀死——断言的是 id 位数（即常量 1_000_000），不是"与 broker 自身 ChannelClient id 冲突"这一行为。名为 "no id-space collision" 的测试在 M6 下**仍绿** |
| M7 | terminal 判定改 `type >= 200`（EventFire 也删映射） | KILLED（3 红） | broker › EventFire 重复投递 / 双订阅独立 / detach hygiene；行为级 |
| M8 | client close 不再发合成 EventDispose | KILLED | broker › "synthesizes unsubscribe for subscriptions left by a detached client"，断言 fixture stderr 里的 `ZSERVER_UNSUB:`（fixture 私有约定） |
| M9 | watchdog tick 内加回 `setInterval(tick,2000)` | KILLED | lifecycle › "does not multiply timers while the owner is alive"（ticks=8317，上限 <60）；真实进程，行为级（用脚本字符串手术 `replace("2000","100")` 加速） |
| M10 | `process.kill(-pid,"SIGTERM")` → `child.kill("SIGTERM")` | KILLED | lifecycle › "dispose group-kills the whole tree: the grandchild dies, not just the leader"（真实进程；测试自己把升级延时设为 600000ms 以免 SIGKILL 掩盖） |
| M11 | 删除 SIGKILL 升级定时器 | KILLED（2 红） | lifecycle › "SIGTERM-ignoring server is SIGKILL-escalated…" 与 "escalation outlives the leader…"（真实进程） |
| M12 | 去掉 `child.once("error", …)` | KILLED | lifecycle › "ENOENT/EACCES-style spawn errors fail FAST…"（10002ms vs <4000ms；耗时断言，余量 2.5x） |
| M13 | exit 处理器去掉 `this.connection !== connection \|\|` | KILLED | lifecycle › "a retired connection's late exit does not poison the fresh connection"（600ms 慢退出打开竞态窗口，并断言旧 pid 仍存活以防空转） |
| M14 | 删除 `this.inFlight++` | KILLED | lifecycle › "idle recycling never closes the connection under an in-flight request"（收到 `channel client disposed` 而非 `timeout`） |
| M15 | subscribe 失败回调不再 `for unsubscribe of unsubscribers` | **SURVIVED** | 缺口：没有任何测试断言"失败尝试注册的 3 个 listener 被拆除（服务端收到 EventDispose）"。现有回滚测试只断言 marker 与 gate；其"下一次 subscribe 会重试"那一段是**空转**：fixture 的 `ZSERVER_FAKE_FAIL_METHODS` 在子进程 spawn 时已冻结，测试里 `delete process.env.…` 影响不到已存在的 server，第二次 subscribe 在服务端同样失败——实测 marker 在调用返回瞬间为 true，600ms 后又回到 false（探针输出 `VAC immediately-after marker=true` → `600ms-later marker=false`）。测试只看到了瞬态 |
| M16 | `shouldTranslateFrame` 恒 true | KILLED | backend › "history (initial) frames are dropped while online frames stream — through the real wiring"（seen `['OLD HISTORY']`）。行为级、真实接线；但帧形状（`deliveryKind`/`frame.topic`）由测试作者虚构（见 T5） |
| M17 | `frameMatchesSession` 恒 true | KILLED（2 红） | backend › `frameMatchesSession` 单测 + real wiring（seen `['FOREIGN']`） |
| M18 | `onTerminalOutcome` 去掉 disposed 早退 | **SURVIVED** | 缺口：现有 dispose 测试是"先 `onTerminalOutcome` 再 `dispose`"；没有"dispose 之后才到达的 terminal"这一竞态（heal/替换 gate 之后迟到的事件），而这正是该守卫存在的原因 |
| M19 | `cancel()` 去掉 reject 调用 | **SURVIVED** | 缺口：`ChannelClient.cancel` 无任何测试调用，且**生产代码零调用方**（grep：src 内唯一的 `.cancel(` 是 gate 的 `timer?.cancel()`）。=死代码 + 无契约测试；语义（"Cancelled" reject、发 `[101,id]`）无人守护 |
| M20 | FrameDecoder 去掉两处 `type === Regular` 判断 | KILLED（整体） | protocol › "delivers only Regular frames from the decoder"。**拆分后**：M20a（仅非空非 Regular 帧）KILLED；**M20b（仅零长度非 Regular 帧）SURVIVED**——测试里的 KeepAlive 带 4 字节 "junk"，从未出现零长度非 Regular 帧（最真实的 KeepAlive 形态）。M20b 的后果见 Missing Tests K-M20b |

汇总：20 个里 **16 KILLED / 4 SURVIVED**（M2 经差分验证在 verdict 上等价，不是行为缺口；M15、M18、M19 是真缺口；M20 整体被杀但其子变异 M20b 存活）。

杀伤质量：行为级杀死 12 个（M1、M3、M7、M9、M10、M11、M12、M13、M14、M16、M17、M20a）；靠实现细节/fixture 私有约定杀死 4 个（M4=生产测试 seam、M5=私有字段、M6=id 位数正则、M8=fixture stderr 标记）。

## Segment 2 — 额外变异（EXTRA，非清单内；我读代码时发现的"接线层"缺口）

方法同上（同一 harness、同样 md5 还原、同样 6 个原测试文件）。编号 X18/X20 未使用。共 28 个：RED 2 / GREEN 26，其中 2 个经验证为**等价变异**（X25、X29），其余 24 个是真缺口。

| 编号 | 变异 | 结果 | 说明 |
|---|---|---|---|
| X1 | onStdout：hello 行之后的剩余字节不再交给 frame decoder | SURVIVED | 现有测试 "hello line and Initialize frame arriving in ONE chunk" **结构上不可能**产生该场景：fixture 只在收到 client 的 ack 之后才发 Initialize，而 client 要先看到 hello 才发 ack，所以二者永远不在同一 chunk。测试名与实际覆盖不符（空转） |
| X2 | idle 回收忽略已注册的 session listener（有活跃会话也回收 server） | SURVIVED | 现有 idle 测试只断言 `isDead===false`，慢机器上定时器没触发也照样绿 |
| X3 | `subscribedSessions.has()` 幂等守卫删除 | SURVIVED | 没有任何断言统计发给 server 的 EventListen 帧数 |
| X4 | spawn() 里 `subscribedSessions.clear()` 删除 | SURVIVED | heal/restart 后 session 对新 server 失聪的路径无测试 |
| X5 | close-during-spawn 守卫删除 | SURVIVED | 竞态无测试 |
| X6 | broker 用原始 `process.env` 拉起共享 server（绕过 `brokerBaseEnv`） | SURVIVED（**安全**） | `brokerBaseEnv` 只有纯函数单测，`ensureServer` 里的**接线**无测试；MULTICA_* 会泄漏给所有 client 的 agent shell |
| X7 | 允许清单新增 `file.writeFile` | SURVIVED（**安全**） | "allows exactly the RPC surface" 测试遍历的是**源码自己的**表 → 对放宽/收窄都是同义反复；黑名单只列 7 个样例 |
| X8 | start() 探活结果被忽略（会驱逐**存活** broker 的 socket） | SURVIVED | 无"第二个 broker 不得抢占"测试 |
| X9 | routeClientFrame 的 "client 已消失" 守卫删除 | SURVIVED | 竞态无测试（未写 killer） |
| X10 | forgetSession 不再 dispose gate | SURVIVED | 只泄漏状态，无可观测输出（未写 killer，低价值） |
| X11 | TASK_SCOPED_ENV 丢掉 SSH_AGENT_PID/SSH_CONNECTION/SSH_CLIENT | SURVIVED（安全） | 单测只覆盖 MULTICA_* 与 SSH_AUTH_SOCK |
| X12 | start() 不再 unlink 陈旧 socket 文件 | SURVIVED | 无"崩溃后重启 broker"测试 |
| X13 | session/list 映射错误（sessionId 取 title） | SURVIVED | fixture 对 listTasks 永远回 echo 字符串，`tasks` 恒空，映射从未被执行（需更富的 fixture，未写 killer） |
| X14 | session/send 丢弃 prompt 内容 | SURVIVED | fixture 只回 echo，没有任何测试断言**发给 server 的参数** |
| X15 | 允许清单删掉 `sendPrompt` | SURVIVED | **没有任何测试让 ZServerBackend 走 broker**（`ZCODE_ACP_ZSERVER_SOCKET` 只在"死 socket 回退"一处被使用）|
| X16 | 事件允许清单删掉 `onDynamicTaskTerminalOutcome` | SURVIVED | 同上；broker 模式下 turn 永远无法完成 |
| X17 | session/stop：taskId 与 workspacePath 互换 | SURVIVED | 同 X14 |
| X19 | session/create 不再调用 createTask | SURVIVED | 同 X14 |
| X21 | request() 去掉 dead-backend 前缀分类 | KILLED | backend › "a failed spawn marks the backend dead with the heal marker" |
| X22 | **被拒绝的 client 帧在断开后仍被转发**（删 `return`） | SURVIVED（**安全，最严重**） | 现有 "live broker disconnects a client that sends a forbidden call" 只看 client 被断开，不看 server 是否收到；变异后 `credential.load` 帧照样送达共享 server |
| X23 | broker idle-exit 永不触发 | SURVIVED | 常量在模块加载时读取 + 内部 `process.exit`，需 resetModules 才能测 |
| X24 | broker.stop() 不 dispose 共享 server | SURVIVED | 没有任何测试断言 broker 停止后 server 进程消失 |
| X25 | stop() 里不再 `unlinkSync(socket)` | **等价（已验证）** | 探针：去掉显式 unlink 后 `existsAfterStop=false`——Node 的 `server.close()` 自己会删除 socket 文件 |
| X26 | broker 每客户端 `socket.on("error")` 删除 | SURVIVED | 崩溃防护；可用假 Socket 注入验证（见 killer） |
| X27 | attach() 的 socket "error" 监听删除 | SURVIVED | 需要真实 socket 错误注入（未写 killer，UNVERIFIED） |
| X28 | child stdin/stdout/stderr "error" 监听删除 | SURVIVED | 同上（EPIPE 注入，未写 killer，UNVERIFIED） |
| X29 | restart() 里 `await this.close()` → `void this.close()` | **等价（分析）** | `close()` 函数体内无 await，同步执行完毕，`void` 与 `await` 只差一个 microtask |
| X30 | decodeValue 数组长度守卫删除 | KILLED | protocol › "rejects array length claims exceeding the payload"（耦合到具体报错文案 vs 引擎自带的 "Invalid array length"） |

结论：清单内 M1–M14、M16、M17 这类"逐函数的守卫"覆盖得不错；缺口集中在**接线层**（backend↔broker 联通、发给 server 的参数、broker 生命周期、heal 路径）——原因是 fixture 只会 echo，并且**没有任何测试记录 server 侧收到了什么**。

## Segment 3 — Missing Tests（对每个 SURVIVED 可直接落地的 vitest 代码）

**完整可落地文件**：`/tmp/audit-reports/mutation-artifacts/zserver-mutation-killers.test.ts`（20 个用例，放进 `tests/` 即可，无需改 fixture、无需改 src）。
它在文件内自建"记录型 server"：对现有 `tests/fixtures/zserver-fake-server.mjs` 做 3 处**恰好匹配一次**的文本注入（每收到一帧就追加一行 JSONL；启动时记录 pid+env key；`ZSERVER_FAKE_TASKS` 让 `listTasks` 回真实结构）。锚点漂移会直接抛错，不会静默失效。这补上了现有套件的**根本缺口：没有任何测试能看到 server 侧收到了什么**（现有 fixture 只会 echo）。

### 验证方法（每条都是"红-绿"两侧实测，不是纸面推断）
1. 未变异代码上连续跑：**20/20 全绿，累计 5 次以上**（最终版另有 2 次），每个用例耗时 1–1139ms（最慢的是 X2，需要观察 900ms 的空闲窗口）。
2. 对每个存活变异，只跑 killer 文件，确认变红（`tools/kill-matrix.sh`），并确认**失败于断言而非 5s 超时**（发现 M15/X4/X24 起初是不透明的超时，加 `vi.setConfig({testTimeout:20000})` 后改为断言失败，见下表）。
3. 变异后 md5 与快照一致（见 Segment 6）。

### 存活变异 → killer 对照与实测结果

| 存活变异 | killer 用例（标题前缀） | 变异下的实测结果 | 断言的是行为吗 |
|---|---|---|---|
| M2 | `[M2]` | RED（reason 文案不同） | **否**，只钉住诊断文案；M2 在 verdict 上等价，标注 cosmetic，可选 |
| M15 | `[M15]` | RED：`expected false to be true`（等不到 3 个 EventDispose） | 是：server 侧确实收到 3 个 `[103,id]` 且与 3 个 listen id 一一对应 |
| M18 | `[M18]` | RED：`expected ['succeeded'] to deeply equal []` | 是（fake timers，无真实等待） |
| M19 | `[M19]` | RED：`expected 'HUNG' to be 'Cancelled'` | 是：发出 `[100,101]` 两帧、以 `Cancelled` reject、迟到响应被忽略 |
| M20b | `[M20b]` | RED：多投递了 1 个空 Buffer | 是 |
| X1 | `[X1]` | RED：`handshake did not complete: hang` | 是（自建最小 server，hello+Initialize 同一次 write） |
| X2 | `[X2]` | RED：有 listener 时 server 被回收 | 是：先证明"有 listener 900ms 内一直存活"，再以"注销 listener 后确实被回收"作对照，避免空转 |
| X3 | `[X3]` | RED：conversation-frame 的 EventListen 出现 3 次而非 1 次 | 是 |
| X4 | `[X4]` | RED：`expected false to be true`（新 server 上没有重新订阅） | 是（并修了我自己首版 killer 的缺陷，见下） |
| X5 | `[X5]` | RED：只启动了 1 个 server（被 close 的连接被采用） | 是 |
| X6、X11 | `[X6,X11]` | RED：5 个 task-scoped env key 泄漏给共享 server（X11 是其中 3 个） | 是：由 server 自己上报它的 env key 名（不含任何值） |
| X7、X15、X16 | `[X7,X15,X16]` | RED：允许清单与字面量不等 | **部分**：是字面量快照，加/删都要故意改测试——这正是想要的"放宽必须显式"。X15/X16 另由下一行的联通测试杀死 |
| X15、X16 | `[X15,X16] every RPC…LIVE broker` | RED：`session/send: e…`（被 broker 断开） | 是：真实 ZServerBackend→真实 broker→录制 server，全流程 |
| X8 | `[X8]` | RED：`promise resolved "undefined" instead of rejecting` | 是 |
| X9 | `[X9]` | RED：已消失 client 的 EventListen 被转发到 server | 是（依赖 broker 冷启动的等待窗口，约 100ms+；见 UNVERIFIED 备注） |
| X12 | `[X12]` | RED：`listen EADDRINUSE` | 是（真实崩溃：SIGKILL 一个绑定了 socket 的子进程，留下陈旧 inode） |
| X13、X14、X17、X19 | `[X14,X17,X19,X13]` | RED（4 个变异各自因不同断言变红） | 是：断言 createSession/createTask/sendPrompt/stopGeneration 的**参数**与 session/list 的映射 |
| X22 | `[X22]` | RED：`credential.load` 帧到达了 server | 是（**最重要**）：带非空性对照（先证明录制器能看到合法转发的帧）与顺序屏障（同一 server 顺序处理 stdin，后一个 echo 返回即表示前面的都已记录） |
| X24 | `[X24]` | RED：broker.stop() 后 server 进程仍存活 | 是（真实进程 + pid 探活） |
| X26 | `[X26]` | RED：`expected [Function] to not throw` | 是（注入假 socket 触发 'error'） |

**没有写 killer 的存活变异**：X10（只泄漏内存、无可观测输出）、X13 之外的 X23（broker idle-exit：常量在模块加载时读取且直接 `process.exit`，需 `vi.resetModules` + 拦截 exit，价值低）、X27/X28（需要真实的 socket/EPIPE 错误注入）。均标 **UNVERIFIED**——我没有为它们写并验证过测试。X25、X29 为等价变异，不需要测试。

### 我自己首版 killer 的缺陷（如实记录，均已修复并重新验证）
- `[M15]` 首版断言"disposes == 全部 listen"，把 `spawn()` 装的 id=0 runtime-preferences 应答器也算进去 → 在**未变异**代码上就红（期望 4 个 dispose 实际 3 个）。修：排除该 listen。
- `[X4]` 首版在订阅 RPC 尚未应答时就 restart：dispose 会 reject 那个在途 RPC，其失败回滚**同样会清掉** marker，把 X4 掩盖掉（变异下仍绿）。修：restart 前先等 server 应答并做顺序屏障。**这本身是一个提醒：X4 与"回滚清 marker"是两条等效路径，任何只看 marker 的断言都测不出它。**
- `[X1]` 首版用字符串手术改 fixture，可读性差；改为内联最小 server。
- 整个文件加了 `beforeEach` 里 `vi.stubEnv("ZCODE_ACP_ZSERVER_*","")`：否则开发者 shell 里残留的 `ZCODE_ACP_ZSERVER_SOCKET` 会让 `[X15,X16]` 之外的 backend 用例**连上真实 broker**（见 Infra F4）。注意：`stubEnv(...,"")` 把值设为空串，而生产代码里 `process.env.ZCODE_ACP_ZSERVER_SOCKET` 用真值判断，空串等同未设置。

### 代码位置索引（详见 artifacts 文件）
```
group A  [M2] [M15] [M18] [M19] [M20b]          — 请求清单中的存活项
group B  [X7,X15,X16] [X22] [X6,X11] [X8] [X12] [X24] [X26]   — broker 安全/生命周期
group C  [X14,X17,X19,X13] [X3] [X4] [X5] [X9] [X1] [X2] [X15,X16]   — backend 接线
```
关键最小片段（M19，行为级、无 I/O、即刻可读）：
```ts
it("[M19] cancel() sends PromiseCancel and settles the pending call with Cancelled", async () => {
  const sent: Array<{ header: unknown[] }> = [];
  const client = new ChannelClient((p) => { sent.push(decodeMessage(p) as { header: unknown[] }); });
  client.onMessage({ header: [200], body: undefined });          // Initialize
  const pending = client.call("zcode-agent", "slow");
  const id = sent[0]!.header[1] as number;
  client.cancel(id);
  const outcome = await Promise.race([
    pending.then(() => "resolved", (e: Error) => e.name),
    new Promise<string>((r) => setTimeout(() => r("HUNG"), 300)),
  ]);
  expect(outcome).toBe("Cancelled");
  expect(sent.map((m) => m.header[0])).toEqual([100, 101]);
  expect(sent[1]!.header[1]).toBe(id);
  expect(() => client.onMessage({ header: [201, id], body: "late" })).not.toThrow();
});
```
M18 / M20b 同理，见 artifacts 文件。
