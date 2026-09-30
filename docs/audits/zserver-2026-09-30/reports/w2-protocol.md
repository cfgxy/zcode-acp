# w2-protocol 审计报告 (线协议字节 + broker 转发语义)
快照: /tmp/zacp-snap-592c65c (HEAD 592c65c, 只读)   Node v22.22.3
实验目录: /tmp/audit-proto2-yYaRou (结束后清理)   broker 均以独立子进程运行, HOME/XDG 指向实验目录, 不触碰真实配置/凭据
按"做一项写一项"顺序追加; 发现格式: [级别] 快照内 file:line + 原文 + 复现 + 影响 + 建议

---
## A. broker 原型键修复验证 (Object.hasOwn)

### A1. validateClientHeader 纯函数遍历 (dist/backend/zserver/broker.js:106 / src/backend/zserver/broker.ts:139)
做了什么: 对 dist/backend/zserver/broker.js 导出的 validateClientHeader, 用 Object.getOwnPropertyNames(Object.prototype) (共 12 个: constructor,__defineGetter__,__defineSetter__,hasOwnProperty,__lookupGetter__,__lookupSetter__,isPrototypeOf,propertyIsEnumerable,toString,valueOf,__proto__,toLocaleString) 作为 channel, type 取 100 与 102, name 取 "x"/"has"/全部 12 个原型名; 另测: 合法 channel + 原型名作 name, 额外键 ("prototype","length","0","then","toJSON","\u0000","","ZCODE-AGENT"," zcode-agent" 等), 以及 Object.prototype 被污染 (Object.prototype["zcode-evil"]=new Set(["createSession"])) 的场景, 外加一批畸形 header 形状。
输出: 共 420 个组合, 意外 ok=true: 0, 抛异常: 0; 全部返回 {ok:false, replyTo:<id>} (replyTo 恰为传入 id=1)。
正向对照: 9 个合法 call + 4 个合法 event (zcode-agent/zcode-task) 全部 ok:true, 修复未误杀合法调用。
污染场景: Object.prototype["zcode-evil"]=Set 后, [100,1,"zcode-evil","createSession"] 仍 -> {ok:false,...}; Object.hasOwn 把污染的原型 Set 挡在门外。
畸形形状: [] / null / undefined / "x" / 5 / {} / 长度 1 / 长度 5 -> ok:false 且不抛; type 100.5 / 104 -> ok:false; id -1 / 1.5 / NaN / Infinity / null -> ok:false。
观察(非缺陷): [100, 2147483648, "zcode-agent","createSession"] -> {ok:true}。validateClientHeader 只要求 Number.isInteger && >=0, 不限制 id 上界; 见 E 节对 >2^31 id 的后续影响分析。
结论: A1 通过。修复对 12 个原型名 x type{100,102} 完全有效, 且不抛。

### A2. 真实 broker 实测 (子进程, fake server = tests/fixtures/zserver-fake-server.mjs 复制为 <root>/zcode-server.cjs)
做了什么: 用 dist/backend/zserver/broker.js 的 ZServerBroker(socketPath, root) 起独立进程 (uncaughtException/unhandledRejection 均挂钩并 exit 70/71 以便观测崩溃)。原始 socket 客户端对 12 个原型名 x {100,102} = 24 个畸形请求 `[type,id,<protoName>,"x"]` (含 `[100,id,"__proto__","x"]`) 分 6 个连接发送 (每连接 4 个违规, 未触及 MAX_VIOLATIONS_PER_CLIENT=5), 每组后紧跟一个合法 `[100,id,"zcode-task","listTasks"]`。
输出:
- 6 连接 / 24 个 202 / 0 个 id 不匹配 / 0 个 body.name != "BrokerPolicyError" / 0 个连接被提前断开 / 0 个缺失 201 / 0 个 201 body 异常。
- 每个 202 的 header[1] 恰为发送方自己的 id (100..123); 合法请求得到 [201,<own id>] + body "echo:listTasks:[]"。样例首连接帧序: [200] → [202,100]…[202,103] → [201,104]。
- broker 全程存活 (exited=null), stats: clients=0 pending=0 rejected=24; stderr 无 UNCAUGHT/UNHANDLED。
- 第 5 次违规: 同一连接连发 6 个 `[100,5xx,"__proto__","x"]` + 1 个合法帧 → 只收到 4 个 202 (500..503), 第 5 个违规不回复直接 destroy (与 broker.ts:434-437 `violations < MAX_VIOLATIONS_PER_CLIENT` 一致), 第 6、7 帧因 socket.destroyed 被 broker.ts:404 静默丢弃; broker 存活 (rejected 累计 29)。新连接随后正常得到 [201,1]。
结论: A2 通过。原型键修复在真实 broker 上有效: 不崩溃、发送方拿到带自身 id 的 202、同 socket 后续合法请求得 201。
