# 并发与异步竞态审计（第二轮）— 快照 4cfa1d3

- 视角：并发/异步竞态。对象：src/backend/zserver/{backend,connection,broker,channel-client,protocol}.ts（快照只读，dist 已构建）。
- 方法：逐行 dry-run + 基于 dist/ 的实测。沙箱 /tmp/audit-conc-d8Fi7a（结束时清理）；fake server = tests/fixtures/zserver-fake-server.mjs 的沙箱副本（仅新增 hello 延迟 / frame 日志 / 失败延迟 三个开关，不改协议行为）。
- 文件为分段追加：每完成一个重点追加一段；末尾有汇总的 "## Findings" / "## Verified-OK"。
- 记号：T0/T1… 为事件循环上的先后；"宏任务" = 定时器/I/O 回调，"微任务" = promise 续体。所有 file:line 均指快照内文件。

---

## 段 1 / 重点 1：inFlight 与 idle timer、close()、restart() 的交错

代码：
- backend.ts:82  `private inFlight = 0;`
- backend.ts:245-246  `this.armIdleTimer(); this.inFlight++;`（request() 同步前缀，紧接着进入 try）
- backend.ts:282-284  `} finally { this.inFlight--; }`
- backend.ts:228-234  idle 定时器回调：`if (this.listeners.size > 0 || this.inFlight > 0) { this.armIdleTimer(); return; } void this.close();`

dry-run：
- T0 request() 被调用 → 同步执行到第一个 await 之前：armIdleTimer()（clear+set，不会抛）→ inFlight++（0→1）→ 进入 try → `await ensureConnection()` 让出。++ 与 try 之间没有 await、没有可抛语句，因此每个 ++ 恰好对应一个 finally --（守恒）。
- T1 idle 定时器触发（宏任务）：inFlight=1 → 只会重新 arm，不会 close。即"只要有请求处于 ++ 与 -- 之间，idle 回收不会关连接"。
- T1' 定时器在 ++ 之前触发：检查与 `void this.close()` 在同一同步块内（close() 体是同步的，async 只影响返回值）。请求要么在检查之前已 ++（被推迟），要么在 close() 体之后才到达（看到 connection=null、spawnPromise=null，重新 spawn）。二者之间没有任何可插入点（定时器回调是宏任务，request() 的 ++ 是另一个宏任务/微任务里的同步段）。
- T2 ensureConnection 抛错（spawn 失败）：位于 try 内 → catch 返回 {error} → finally --。
- T3 close()/restart() 与在途请求交错：close() 不触碰 inFlight；在途请求经 ensureConnection 循环重新 spawn/加入新 spawn，最终仍走同一个 finally。
- T4 超时：Promise.race 的定时器赢 → 进入 catch → finally -- ；但 route() 并未被取消（race 不会取消输家），此后 inFlight 对该"僵尸 route 续体"少计 1。
- 重入：request→route→subscribeConversation 不再调用 request()；send() 是 fire-and-forget 的 request()（配对正常）。

实测（dist，沙箱）：
- E1a：spawn 必然失败（无 bundle），200 个并发 request → 200 个 error，inFlight=0，isDead=true，deathReason 以 "spawn failed:" 开头。
- E1b：150ms hello 延迟，50 个并发 request，期间穿插 5 次 close()（i%10==5 时）→ 50/50 成功（ensureConnection 循环重新 spawn），inFlight=0。
- E1c：ZSERVER_FAKE_HANG_METHODS=listTasks，10 个 300ms 超时请求 → 10 个 "timeout"，inFlight=0；但 ChannelClient 中 pendingRejections=10、handlers=11（10 个悬挂 call + 1 个 prefs listen）——超时后客户端从不 cancel，条目一直留到连接 dispose。

结论（本段）：inFlight 守恒成立；无法构造出"++ 与 -- 不配对"或"idle 在请求处于 ++..-- 之间关连接"的交错。两处次要观察（超时后 route 续体不受 inFlight 保护；超时调用的 handlers/pendingRejections 残留到连接结束）记入汇总的 LOW 项。idle 机制默认关闭（idleMs = ZCODE_ACP_ZSERVER_IDLE_MS 默认 0），上述仅在显式开启时相关。

