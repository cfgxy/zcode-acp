# sec-a 安全复审报告（快照 b2c943c，只读）

- 快照：/tmp/zacp-snap-b2c943c（dist/ 已构建）
- 约束：不读 ~/.zcode 真实配置；所有实验使用临时 HOME；不改快照；不碰 /mnt/data/Codes/offcial/zcode-acp
- 每项完成后立即追加，无缓冲

### 项1（进行中，分段落盘）isTrustedPinPath 绕过矩阵 — 词法层实测
**做了什么**：在 `HOME=$SB/home`（$SB=/tmp/sec-a-10e7eeaa917e）下，直接 import 快照 `dist/desktop-profile.js`，对 `isTrustedPinPath` 跑 53 个输入，并对其唯一调用者 `isValidEnvValue`（经 `sanitizeDesktopEnv`）复测分层拒绝。脚本：$SB/t1.mjs、t1b.mjs。
**输入/输出（节选，全量见沙箱 t1.out/t1b.out）**：
- (a) `~/.cache/x`、`~/Downloads/evil-rg`、`~/tmp/provider_config.json` → 全部 `true`（有意接受，见下评估）。
- (b) `/tmp/.mount_x/../../evil`→false；`/tmp/.mount_x/%2e%2e/evil`→true（但 `%2e%2e` 对内核是字面目录名：实测 `pct/%2e%2e/../evil/marker`→ENOENT，`pct/../evil/marker`→EXISTS，即**无穿越**）；`/tmp/.mount_x%2f..%2fevil`→false；尾随斜杠 `/tmp/.mount_x/`→true（仅挂载根本身）；双斜杠 `/tmp/.mount_x//bin//rg`、`//tmp/.mount_x/bin`→true（normalize 后仍在根内，无害）；反斜杠 `/tmp/.mount_x\..\evil`→false（`..` 检查同时按 `\` 切分，Linux 上 `\` 是字面字符，属过度拒绝，无害）；NUL：`/tmp/.mount_x/bin\0/../../evil`→false，`/tmp/.mount_x/\0evil` 在 isTrustedPinPath 内为 true 但经 sanitizeDesktopEnv 被 `/[\0\n\r]/` 拒绝（分层成立）；1MB 路径：isTrustedPinPath 本身返回 true（无长度上限），但 sanitizeDesktopEnv 因 MAX_ENV_VALUE_LENGTH=4096 拒绝（4096 通过、4097 拒绝，边界精确）；`/tmp/.mount_/bin`(空后缀)、`/tmp/.mount_x.evil/bin`、`/tmp/.mount_\u0430/bin`(西里尔字母)→false；`/tmp/./.mount_x/bin`→true（normalize 后合法）。
- (c) `${home}-evil/x`、`${home}evil`、`${home}/../x`、`${home}/./../x`、`${home}/a/../../x`、`${home}/..`、`${home}\..\x`→全部 false；`${home}`(无尾斜杠)→false，`${home}//x`→true。`/opt`(无斜杠)、`/optevil/x`、`/usr/../etc/x`、`/opt/../tmp/x`→false。
- **发现（新，低危）退化 HOME**：`os.homedir()` 在 `HOME=/` 或 `HOME=''` 时分别返回 `"/"`、`""`（实测），此时 `homeRoot` 归一为 `/`，`isTrustedPinPath('/etc/passwd')`、`/tmp/evil/rg`、`/root/.ssh/x` 全部返回 **true** —— 校验静默失效（HOME=/ 常见于 `docker run --user <无passwd的uid>`、部分服务账号）。攻击者需控制 bridge 环境或部署本身如此，属纵深防御缺口而非直接利用。建议 fail-closed：`home` 为空/`/`/非绝对时一律拒绝。
- 固定根 `/opt`、`/usr`、`/usr/local`、`/usr/local/bin` 对本 uid(1000) 均 **不可写**（stat 实测 root:root 755）。
**本段结论**：词法层对 (b)(c) 全部构造均无法绕过（PASS）；仅发现"退化 HOME 使校验失效"一处（低危，FAIL-minor）。(a)(d)(e) 的风险评估见下一段（需要端到端证据）。

### 项1（续）(a)(d)(e) 端到端实测：pin 通过校验后真的会被执行
**做了什么**：pin 的危害最大的一个是 `ZCODE_SERVER_RUNTIME_ROOT`——`ZServerConnection.spawn()`（dist/backend/zserver/connection.js:101-115）执行 `${root}/node`，而 `ZServerBackend.spawn`（backend.js:156-160）把 `runtimeEnvWithProfile()` 得到的 pin 原样并入 env。我在沙箱里放一个假 `node`（sh 脚本，只写 marker 后退出）和空 `zcode-server.cjs`，用真实 dist 代码走 `sanitizeDesktopEnv → ZServerConnection.spawn`。脚本 $SB/t1c.mjs（`env -i` + 临时 HOME）。
**输入 → 输出**：
- (a) `pin=$HOME/.cache/evil-root`（普通目录）→ `sanitizeDesktopEnv: ACCEPTED`；marker=`EXECUTED uid=1000 argv0=$HOME/.cache/evil-root/node args=$HOME/.cache/evil-root/zcode-server.cjs`。**攻击者放在 ~/.cache 的二进制被 bridge 执行。**
- (d) `pin=$HOME/link`，`link -> $SB/evil`（home 外）→ ACCEPTED；marker 的 argv0=`$HOME/link/node`，实际运行的是 home 外 `$SB/evil/node`。**isTrustedPinPath 只做词法检查，符号链接把"home 内"的 pin 解析到 home 外，校验被绕过（实测）。** 对照：`pin=/tmp/evil` → REJECTED。
- (e) 在 bwrap 私有 tmpfs 内（`--tmpfs /tmp`，真实 /tmp 事后 `ls` 确认无痕）：同 uid、零特权 `mkdir -p /tmp/.mount_fakeAppImage123/srv`（属主 uid=1000，0755，mountinfo 中 is-mountpoint=NO）→ `pin=/tmp/.mount_fakeAppImage123/srv` ACCEPTED，假 node 被执行。对照：`/tmp/.mount_x/../evil`、挂载根本身不带尾斜杠 `/tmp/.mount_x` → REJECTED。**结论：同 uid 攻击者可以自建目录冒充 AppImage 挂载点（实测），校验无法区分真假挂载。**
- 佐证（本机只读观察，仅看名称/属主/mountinfo，未读内容）：/tmp 下有 18 个 `.mount_*`；仅 2 个是真 fuse 挂载点（fstype=fuse.Obsidian，挂载根属主 uid=0、0755），其余 16 个是崩溃遗留的**普通空目录**（属主 uid=1000，0700，非挂载点）。即"名字像 .mount_* 的普通目录"在真实机器上本来就大量存在。可用的加固判据：pin 所在 `.mount_*` 根必须是 mountinfo 里的 fuse 挂载点（或属主 uid=0）。注意此判据基于 Obsidian 的 AppImage 挂载观察，ZCode 桌面端未在本机验证（UNVERIFIED）。
- `%2e%2e` 实测为字面目录名，不是穿越（见上段）。
**下游 UNVERIFIED**：`ZCODE_RG/BFS/UGREP_BINARY` 与 `ZCODE_*_PROVIDER_CONFIG_FILE` 由真实 zcode server 消费，我没有启动真实 server（会触碰真实凭据），只能依据源码注释与 runtime-model.js:104 的读取点判断；`ZCODE_SERVER_RUNTIME_ROOT` 的执行效果是实测的。另注意：若 bridge 自身 `process.env.ZCODE_SERVER_RUNTIME_ROOT` 已设置（server.js:190），它优先于 profile pin 且不经过 isTrustedPinPath。

### 项1 最终结论 isTrustedPinPath（合并上面两段）
**补充实测**：
- (d2) 校验后改链（validate-then-retarget）：`$HOME/swap -> $SB/benign` 时 `sanitizeDesktopEnv` 通过；随后把 swap 改指 `$SB/evil`（home 外），同一 pin 字符串解析到新目标，pin 值未变（`pin string unchanged = true`）。校验在加载期，解析在 exec 期，两者之间无 realpath/无 fd 固定。
- 更正前段数字：非挂载点的 `.mount_*` 目录共 16 个，其中 15 个 0700、1 个 0755，**全部为空**；2 个真挂载点属主 uid=0。
- **新发现（比路径 pin 更直接的外泄路径）**：URL 类 pin（`ZCODE_BASE_URL`/`ZAI_BUSINESS_BASE_URL`/`ZAI_OAUTH_ORIGIN`）只校验协议/无凭据/无 query，**没有主机白名单**：`https://attacker.example`、`http://127.0.0.1:9` 均 ACCEPT（实测）。用**我自建的假 key**（`FAKE-AUDIT-KEY-NOT-REAL`，临时 HOME 下自建的 config.json）走 `loadDesktopBackendEnv`：子进程 env 同时含 `ZCODE_BASE_URL=https://attacker.example/v1` 与该 ANTHROPIC_API_KEY（实测 `present=true`），且 profile 值优先级最高（server.js:24）。也就是说，`isTrustedPinPath` 注释里声称要防的"凭据外泄到攻击者端点"，在 URL pin 上并未封堵。真实 zcode CLI 是否把 key 发往 `ZCODE_BASE_URL` **UNVERIFIED**（未启动真实 CLI，避免碰真实凭据），仅证明了 bridge 交给子进程的 env 组合。

**风险评估（(a)）**：home 下任意路径被接受是有意的，但在实测里它等价于"执行 home 内任意二进制"（`ZCODE_SERVER_RUNTIME_ROOT` → `${root}/node`，marker 证实以 uid=1000 执行）。~/.cache、~/Downloads、~/tmp 是浏览器/下载器/解压工具/AI agent 的 tool shell 都能写的位置，所以它对"非 profile 文件持有者但能写 home 子目录的低信任进程"不提供任何保护；它只挡住了 home 之外、且不在 /tmp/.mount_*、/opt、/usr 下的 pin。
**"模型内/外"**：SECURITY.md 的 Out of Scope 明写"需要已经在主机上有代码执行的问题"。(a)(d)(e) 与 (d2) 都要求同 uid 已能写文件/建目录，且同 uid 本来就能直接改 ~/.bashrc、profile 文件本身、或直接执行二进制，所以**在项目声明的威胁模型之外**；把它当"纵深防御"评价时，实测结论是：对同 uid 攻击者边际收益≈0，对"profile 文件被篡改但攻击者写不了 home 之外"的场景仍有部分价值。
**判定**：
- (b)(c) 词法绕过：**PASS**（53 个构造无一绕过；`%2e%2e` 实测为字面目录，非穿越；NUL/超长由 sanitizeDesktopEnv 的第二层拦截）。
- (d) 符号链接：**FAIL（可绕过，实测执行了 home 外二进制）**，模型外。
- (e) 冒充 AppImage 挂载点：**FAIL（可冒充，实测执行了假 node）**，模型外。
- 退化 HOME（`HOME=/` 或空）致校验整体失效：**FAIL-minor**。
- URL pin 无主机白名单：**FAIL（修复不完整，与 isTrustedPinPath 注释声称的目标不一致）**，真实外泄链 UNVERIFIED。
**整体：FAIL（修复只封堵了词法层，未封堵符号链接/伪挂载点/URL 三条同类攻击面；均在同 uid 前提下）。**
**建议（最小改动）**：pin 校验时对 `realpath` 后的结果重做前缀判断并在 exec 时使用 realpath 后的路径（避免 TOCTOU）；`.mount_*` 分支要求该根是 mountinfo 中的挂载点或属主 uid=0；`home` 为空/`/`/非绝对时 fail-closed；给 URL pin 加主机白名单（*.bigmodel.cn / *.z.ai）。
复现：$SB=/tmp/sec-a-10e7eeaa917e；t1.mjs、t1b.mjs、t1c.mjs、t1d.mjs、jail-e.sh（结束时会清理，命令见各段"输入"）。

### 项2（进行中，分段落盘）(a) resolvePersonalProviderTarget 的 ENOENT→词法退化
**做了什么**：临时 HOME=$SB/home，自建 `~/.zcode/v2/{config.json,provider_config.json}`（**假 key** `FAKE-AUDIT-KEY-NOT-REAL`，另有一个预存的假 key `OTHER-FAKE-KEY-PRE-EXISTING` 用来区分新旧内容）。直接 import dist/config/personal-provider.js，用 `env={ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: pin}` 调 `resolvePersonalProviderTarget`，再调 `ensurePersonalGlmProvider(target.path, creds)`（默认 atomicWrite）。脚本 $SB/t2lib.mjs、t2a.mjs；"outside"= $SB/outside（代表 ~/.zcode 之外的目录）。
**输入 → 输出**：
- A1：`~/.zcode/linkdir -> $SB/outside`（符号链接**目录**），pin=`~/.zcode/linkdir/provider_config.json`，目标文件不存在 → `resolve` 返回 `{path: <该 pin>}`，**没有 rejectedPin，即词法检查放行（实测）**。随后 `ensure` 返回 `skipped: provider_config.json unreadable (ENOENT…)`，outside 目录为空。→ 放行但**本身不写**，因为写入前必须先成功读到含 `providerRules` 数组的 JSON。
- A2 对照：同一符号链接目录，但目标文件已存在于 outside → realpath 成功、落在 ~/.zcode 外 → `rejectedPin` 被设置，path 回落到默认位置（校验有效）。
- A3：`~/.zcode/dangling.json -> $SB/outside/none.json`（悬空链接文件）→ 放行；`ensure` → skipped(ENOENT)，无写入。
- A4（check-then-use 交错，确定性构造）：先 `resolve`（此时目标不存在→词法放行），再由"攻击者"在 outside 放入合法 provider_config.json，再 `ensure` → 返回 `added`；outside 中出现 `provider_config.json[mode=600, 含新 key + 旧 OTHER key]` 与 `provider_config.json.bak-<ts>[mode=600, 含旧 OTHER key]`。**即：只要赢得一个 check→use 竞态，套餐 key 就被写到 ~/.zcode 之外（实测）。** 竞态的胜率见 (b)。
- A5 词法矩阵：`~/.zcode/../x`、`~/.zcode/sub/../../x`、`~/.zcode-evil/x`、`~/.zcodeX`、`~/.zcode`(目录本身)、`/tmp/evil/x`、`~/.cache/x`、不存在的相对路径 → 全部 rejectedPin；`~/.zcode//v2//x.json` 放行（归一化后仍在内，无害）。
- **附带发现**：pin 为**相对路径且存在**（cwd=$HOME 时 `.zcode/v2/provider_config.json`）→ 放行，且返回的是**未解析的相对路径**（`{"path":".zcode/v2/provider_config.json"}`），后续 read/write 依赖进程 cwd。同一进程内 cwd 不变时无害，属于卫生问题（低）。
- 另：`return { path: pinned }` 返回的是原始 pin 而不是 `resolved`，所以"检查用 realpath、使用用原路径"，每次使用都会重新解析符号链接——这是 TOCTOU 的根因。
**(a) 结论**：词法退化**确实放行符号链接目录**（实测），但单独不构成写入；需要与 (b) 的竞态组合。判定 **FAIL-partial（校验存在可绕过的弱点，利用需竞态 + 目录写权限）**。

### 项2（续）(b) atomicWrite 的 `${path}.tmp-<pid>` 预置符号链接 — 实测：writeFileSync 跟随符号链接
**做了什么**：同样的临时 HOME 与假 key。用 `process.pid`（同进程调用 ensurePersonalGlmProvider，故 pid 已知）预置 `${PIN}.tmp-${pid}`，再调用真实 `ensurePersonalGlmProvider(PIN, CREDS)`（默认 atomicWrite）。脚本 $SB/t2b.mjs。**注意：此组实验使用的是默认路径 `~/.zcode/v2/provider_config.json`，没有任何 pin，因此与 resolvePersonalProviderTarget 的 realpath 校验完全无关。**
**输入 → 输出**：
- B1：`provider_config.json.tmp-<pid>` → 符号链接指向 `$SB/outside/victim`（已存在，mode 0644，内容 `VICTIM-ORIGINAL-CONTENT`）。结果 `status:"added"`；victim 变为 `mode=600`，内容含 `HAS-NEW-KEY HAS-OLD-OTHER-KEY`（原内容被截断覆盖）。即 **writeFileSync 跟随了符号链接（O_TRUNC 写入 victim），随后 chmodSync(tmp,0600) 也跟随并改了 victim 的权限**；最后 `renameSync(tmp, PIN)` 把**符号链接本身**移成了 `provider_config.json`（`SYMLINK->$SB/outside/victim`，lstat mode=777），此后任何读 PIN 的进程（桌面端/后端）都会读到 victim。
- B2：链接指向不存在的 `$SB/outside/created-by-victim` → 该文件被**创建**（mode 600，含新 key + 旧 key），PIN 变成指向它的符号链接。
- B3 对照（无预置）：正常，PIN=regular file 0600，目录里只有 config.json / provider_config.json / `.bak-<ts>`。
- B4：PIN 本身是指向 outside 文件的符号链接（写入时）→ `renameSync` 不跟随目的地符号链接：PIN 被替换为普通文件 0600，outside 的 `real.json` 未被修改（0644、仍是旧内容）。结论：**PIN 为符号链接时写入是安全的；tmp 为符号链接时不安全。**
**影响评估**：
- 效果 = 以受害进程 uid 对**任意路径**做截断覆盖并写入含套餐 key 与其它 provider key 的 JSON，且把目标 chmod 为 0600，并把 PIN 变成指向该路径的符号链接。同 uid 攻击者本来就能直接读 config.json、改任何文件，所以对"纯同 uid"≈无新增能力（模型外）；有意义的场景是**攻击者能写 provider_config.json 所在目录、但不是同一 uid 或不能读 config.json**（例如同 uid 下被沙箱限制、只有该目录写权限的低信任进程；组/其他可写的 ~/.zcode/v2）。目录实际权限我没有查（约束：不触碰真实 ~/.zcode）→ **UNVERIFIED**。
- 可预测性：文件名只含 `process.pid`。pid 可由同 uid 攻击者通过 /proc 轮询 `zcode-acp profile refresh` 进程得到，或对一段 pid 区间喷洒预置（pid_max=4194304，pid 顺序分配）。喷洒可行性的实测见后一段。
**(b) 结论：FAIL**——本轮"realpath 落在 ~/.zcode 内才接受"的修复**没有封堵**这条同类攻击面（符号链接被放在临时文件名而不是 pin 路径上，且默认路径同样受影响）。对照：同仓库 `writeDesktopProfile`（dist/desktop-profile.js:455）已使用 `openSync(tempPath,"wx",0o600)`（O_EXCL，不跟随）和 `${pid}-${Date.now()}`，personal-provider 的 atomicWrite 没有采用同一做法。
**建议**：`openSync(tmp,'wx',0o600)`（O_CREAT|O_EXCL 不跟随符号链接，已存在则失败）+ 随机后缀（`crypto.randomBytes`）+ 对 fd 做 `fchmodSync`；备份同理用 `openSync(bak,'wx',0o600)` 写入而不是 `copyFileSync`。

### 项2（续）(c) 备份文件 `${path}.bak-<Date.now()>` — 最终 0600，但可预置，copyFileSync 跟随符号链接
**做了什么**：同上环境，脚本 $SB/t2c.mjs，真实 `ensurePersonalGlmProvider(PIN, CREDS)`。
**输入 → 输出**：
- C1：源 provider_config.json 为 0644 → 备份最终 `mode=600`，内容为旧 provider_config（含 OTHER key）。
- C2：`umask(0)` 且源为 0666 → 备份仍最终 `mode=600`（chmodSync 生效，不依赖 umask）。**"是否 chmod 0600"：是（最终态）。**
- C3（预置符号链接）：攻击者在 `${PIN}.bak-<t>` 对未来 4000 个毫秒 t 各预置一个符号链接 → 已存在的 victim（0644，内容 `VICTIM-ORIGINAL-CONTENT`）。喷洒 4000 个链接耗时 85 ms（≈21 µs/个，即每秒可覆盖约 4.7 万个毫秒值）。之后调用 ensure：结果 `added`；victim 变为 `mode=600`、内容=**旧 provider_config**（含 OTHER key，说明 `copyFileSync(filePath, backup)` 跟随目的符号链接并截断覆盖；`chmodSync(backup)` 也跟随并改了 victim 的权限）；4000 个链接全部还在，真实备份文件数 0。**"能否被预置"：能，符号链接与普通文件都能（实测）。**
- C4（预置普通文件 0666）：真实备份覆盖了其中一个预置文件（内容=旧配置），最终 0600（写入后被 chmod 收紧）。
**备份命名可预测性**：后缀只是 `Date.now()`（毫秒），攻击者不需要知道 pid，只需要一个略宽于"启动到写入"耗时的时间窗；`profile refresh` 从启动到备份约数十到数百毫秒，喷洒 1000–5000 个即可覆盖（上面 4000 个/85 ms 的实测成本）。备份的**内容**是旧 provider_config（含其它 provider 的 key），所以可覆盖任意路径且写入 secret 内容并 chmod 0600。
**(c) 结论：FAIL（备份可预置且跟随符号链接；最终权限 0600 属 PASS 的那一半）。** 与 (b) 同一根因：`copyFileSync`/`writeFileSync` 不使用 O_EXCL/O_NOFOLLOW。

### 项2（续）(b)(c) 补充证据：strace 系统调用序列（默认路径、无预置、源文件 0644）
**做了什么**：`strace -f -e trace=openat,chmod,fchmod,rename*,symlink,copy_file_range,sendfile` 包住 `node t2d.mjs`（调用真实 `ensurePersonalGlmProvider`），只保留触及 `provider_config.json*` 的行。
**输出**（路径已缩写，pid/ts 为本次运行值）：
- `openat(".../provider_config.json.bak-<ms>", O_WRONLY|O_CREAT, 0100644)` → `chmod(".../provider_config.json.bak-<ms>", 0600)`
- `openat(".../provider_config.json.tmp-<pid>", O_WRONLY|O_CREAT|O_TRUNC, 0600)` → `chmod(tmp, 0600)` → `rename(tmp, ".../provider_config.json")`
**解读**：(1) 两处 open 都**没有 O_EXCL、没有 O_NOFOLLOW** → 与 B1/B2/C3 的"跟随符号链接"实测一致（内核层证据，不靠推理）。(2) 备份文件是按**源文件权限**创建（0100644 = 源 0644）后才 chmod 0600：源为 0644 时存在一个"含其它 provider key 的备份先以 0644 落地、稍后收紧"的短窗口；源本身为 0600 时无此窗口。真实 provider_config.json 的权限我不能读取（约束），→ **UNVERIFIED**。(3) 写 tmp 时 open 用 0600 创建，但对**已存在**的 tmp（预置的普通文件/符号链接目标）mode 参数不生效，靠随后的 `chmod(path)` 收紧——`chmod` 按路径而非 fd，同样跟随符号链接。
