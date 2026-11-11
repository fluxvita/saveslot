# 06 · 本地优先同步与日志复制

> 调研日期：2026-11-09。范围：ElectricSQL、PowerSync、Zero / Replicache、Turso（embedded replicas / Turso Sync）、Litestream / LiteFS、cr-sqlite、Automerge，以及事件日志复制模式（CouchDB/PouchDB、KurrentDB、Kafka MirrorMaker 2 / 幂等生产者、Durable Streams、Hypercore）。
> 每条事实附出处；GitHub 链接尽量固定到 commit。没有亲自读到原文的标「未核实」。
> 背景约束见 [`../DRAFT.md`](../spec/01-positioning.md)「部署形态与同步」与 [`../data-model.md`](../spec/03-data-model/README.md)「删除」「写入」「冲突处理」。

## 0. 结论先行

1. **没有现成组件能直接当 saveslot 的同步层。** 主流同步引擎（Electric、PowerSync、Zero）都假设「服务端 Postgres 是权威，客户端是缓存」，方向固定；saveslot 要的是「本地或托管都可以当主节点」，并且同步的是**只追加的源数据日志**，不是表状态。它们的形状都对不上 saveslot 的「日志优先 + 主节点可切换」。
2. **值得照搬的是几条协议机制，不是代码**：
   - Replicache/Zero 的「每客户端单调 mutation ID + 服务端 `lastMutationID` 与业务写同事务」（幂等 + 有序）；
   - Kafka / Durable Streams 的「producer id + epoch + seq」（幂等 + 切换主节点时隔离旧写入方）；
   - PowerSync 的「checkpoint + 校验和、本地有待上传写入时不推进 checkpoint」（一致性）；
   - CouchDB 的「两端各存复制检查点，断点续传」；
   - Replicache / Turso Sync 的「回到上次确认状态 → 应用主节点日志 → 重放本地待提交」（rebase）。
3. **saveslot 选单主而不选 CRDT 是对的。** CRDT 只能在字段层面合并值，处理不了 saveslot 真正关心的「语义冲突」（谁的来源更权威、纠错还是变更、待确认）；而且它要保留完整历史，和隐私删除直接冲突。单主的代价是：离线写入在提交前只是「暂定」，必须设计好被拒绝 / 降为候选版本的呈现方式。saveslot 已有的冲突规则正好接住这一点。
4. **墓碑是最容易出错的地方。** CouchDB 的 `_purge` 不会跨库复制，被清除的文档可能从别的副本复活。saveslot 必须让墓碑成为日志里的一等事件，永不压缩掉，并在主节点入口按「内容哈希 / 条目 ID 黑名单」拦截复活。
5. **最大的未决风险是端到端加密和托管主节点之间的矛盾**：托管节点当主节点，就要能读明文才能抽取、算出有模型的数据。需要按 thread 区分「托管可读」和「托管只存密文」（正好对应预留的「归属节点」字段）。

**建议**：自研一个薄的 HTTP 日志同步协议（第 6 节草图），传输层语义尽量对齐 Durable Streams 协议（MIT、带幂等生产者和 epoch 隔离），不引入完整同步引擎。

---

## 1. saveslot 对同步层的要求（从设计文档推出）

| 要求 | 来源 |
|---|---|
| 每用户一个主节点（本地或托管），其他节点复制**日志** | DRAFT.md「多节点」 |
| 离线节点用自己的编号写入，上线后提交 | 同上 |
| 冲突只在「从日志算出有模型的数据」时出现，走预期版本检查、永不阻塞、读时带出 | data-model.md「冲突处理」 |
| 「写入一律先收」：源数据不因核对不过被丢 | data-model.md「来源级别」 |
| 日志串成哈希链，事件只引用内容哈希 | data-model.md「日志防篡改」 |
| 删除是墓碑事件，要传到所有副本且不能复活；内容按条 / 按 thread 加密，删除 = 销毁密钥 + 写墓碑 | data-model.md「删除」 |
| 每条 thread 预留「归属节点」 | DRAFT.md |
| 本地 ↔ 托管双向迁移 | DRAFT.md |
| 本地用 PGlite / SQLite，托管用 PostgreSQL（推定） | 任务背景 |

关键推论：**saveslot 需要同步的单位是「事件」，不是「行」**。行级同步引擎（Electric、PowerSync、Turso Sync）复制的是表的当前状态，saveslot 用的话也只能拿它们来复制日志表本身。这样一来，它们的冲突处理机制就用不上了，因为只追加的日志表不会产生行冲突。

---

## 2. 逐个方案

### 2.1 ElectricSQL（现名 Electric，域名 electric.ax）

**是什么**：从 Postgres 往客户端做**只读方向**的部分复制。复制单位叫 Shape，由「表 + 可选 where + 可选列」定义，定义后不可变；目前只支持单表，可以用子查询过滤，但没有 join（[Shapes 指南](https://electric.ax/docs/guides/shapes)）。传输是普通 HTTP：`offset=-1` 拉全量，之后用 `handle + offset` 长轮询或 SSE；`up-to-date` 控制消息表示已追平；响应带 `cache-control`/`etag`，可以放在 CDN 后面（[HTTP API](https://electric.ax/docs/api/http)）。

**历史教训（和 saveslot 直接相关）**：旧版 Electric 做过 Postgres 间的 active-active 复制，以及嵌入式客户端库同步，保证「本地写入的最终性」。2024 年整体重写为 Electric Next，原因是复杂度太高、bug 面太大；新版明确只做读路径，「本地写入最终性」降级为长期目标（[Electric Next 博客](https://electric.ax/blog/2024/07/17/electric-next)）。现在官网的产品是 Electric Agents / Streams / Sync / Cloud，横幅写着「Electric is joining Neon at Databricks」（[electric.ax](https://electric.ax/)）。

**写路径**：Electric 不做写路径同步，交给应用自己做。官方给了四种模式（[Writes 指南](https://electric.ax/docs/guides/writes)）：
- 在线写：调 API，等同步流把结果带回来；
- 乐观状态：同步流带回结果时丢弃本地暂态；
- 持久化乐观状态：带 `write_id`，失败时只回滚这一条；
- 经由 PGlite：用 `INSTEAD OF` 触发器把写入记进 `changes` 表，后台推送。示例里任一写入被拒就**清空全部本地状态**；文档也承认后台同步让回滚变复杂，「只清除有因果依赖的写入」等策略只被提到、没有实现。
- 排序、幂等：文档不定义。

**删除 / 墓碑**：Shape 日志里有 delete 操作；Shape 失效（schema 变更、复制槽变化、被驱逐）时返回 409 / `must-refetch`，客户端丢弃本地数据重新同步（[Shapes](https://electric.ax/docs/guides/shapes)）。没有「防复活」的概念，因为客户端没有权威写入。

**部分复制**：Shape 就是部分复制。**鉴权**：建议放在应用代理后面，由代理在服务端决定 shape 参数（proxy 模式）；或者签发「绑定具体 shape 的 token」（gatekeeper 模式）；客户端的子集查询只能缩小、不能扩大范围（[Auth 指南](https://electric.ax/docs/guides/auth)）。**E2EE**：无内建支持（文档未提及）。

**规模**：官方基准称单台 Electric 加 CDN 可承载 10 万到 100 万并发用户（写负载 960 事务/分钟）；用优化过的 where 时每个变更 0.17–0.27 ms，写入到客户端延迟约 6 ms；官方注明结果不保证有代表性（[Benchmarks](https://electric.ax/docs/sync/reference/benchmarks)）。

**PGlite 同步插件**：alpha，只能单向从 Electric 同步进 PGlite，「不支持本地写入同步出去，也不支持冲突解决」（[pglite.dev/docs/sync](https://pglite.dev/docs/sync)）。

**许可 / 成熟度**：Apache-2.0，约 1 万 star，活跃（`gh api repos/electric-sql/electric`，HEAD [`3f9809f`](https://github.com/electric-sql/electric/tree/3f9809fb0bd894cb74470d434749673492ad7acf)）。

**对 saveslot**：只能借鉴思路。它的数据源是 Postgres 逻辑复制（未核实 PGlite 能否当 Electric 的源），方向固定为「服务端 Postgres → 客户端」，没法支持「本地当主节点」。可借的是：同步走纯 HTTP、offset 不透明、可以被 CDN 缓存、`must-refetch` 语义。Electric 后来把这套传输层独立成了 **Durable Streams**（见 2.10）。

### 2.2 PowerSync

**是什么**：在 Postgres（以及其他源库）和客户端 SQLite 之间做同步。服务端按 Sync Rules / Sync Streams 把数据切成 bucket，客户端只同步与自己相关的 bucket；参数来自 JWT（`sub` 就是用户 ID）。客户端参数不能用于访问控制（[Sync Rules](https://docs.powersync.com/usage/sync-rules)）。Sync Rules 已经弃用，改为 Sync Streams（同上）。

**写路径**：本地写入进入**阻塞的 FIFO 上传队列**。由应用实现 `uploadData()`，把写入发给**自己的后端 API**，由后端写 Postgres；队首事务在 `complete()` 被调用之前不出队（[Consistency](https://docs.powersync.com/architecture/consistency)）。
- **一致性**：checkpoint 只包含完整提交的事务，客户端拿齐一个 checkpoint 的数据后才整体应用；**上传队列非空时不推进到新的 checkpoint**，所以客户端本地永远不需要自己解决冲突，目标是 causal+ 一致性（同上）。队列清空后，客户端请求 write checkpoint；服务端跟踪源库的 CDC 位置，复制追上后通过 checkpoint 通知客户端（[Protocol](https://docs.powersync.com/architecture/powersync-protocol)）。
- **被拒写入**：官方建议后端在校验失败或冲突时**仍返回 2xx**，否则队列会卡住；服务端状态没变，客户端自然回到服务端状态，等于「自动回滚」。要让用户知道被拒，只能把错误放进响应体，或者写进一张会同步回客户端的表；可选的死信队列可能导致乱序（[Handling write validation errors](https://docs.powersync.com/usage/lifecycle-maintenance/handling-write-validation-errors)）。冲突策略由后端自选：时间戳、版本号、字段级 LWW、业务规则、增量操作、`write_conflicts` 表同步回客户端让用户选、CRDT（[Custom conflict resolution](https://docs.powersync.com/usage/lifecycle-maintenance/handling-update-conflicts/custom-conflict-resolution)）。
- **排序 / 幂等**：队列是 FIFO，保证顺序；服务端幂等要由应用后端自己做（文档未给出机制）。

**删除**：bucket 操作有 `PUT`（等于 `INSERT OR REPLACE`）和 `REMOVE`；一行只有从客户端同步的**所有** bucket 里都被移除，才会在客户端删掉。压缩时旧的更新被替换为可合并的标记项，校验和保持不变；每个 bucket 的校验和是各操作哈希之和，校验不过就丢弃该 bucket 重新同步，校验和不是密码学安全的（[Protocol](https://docs.powersync.com/architecture/powersync-protocol)）。防复活靠「服务端权威」，没有专门机制。

**E2EE**：只有本地库加密（SQLCipher / SQLite3MultipleCiphers、Web 端 ChaCha20）和 TLS；端到端加密需要应用在写入前自己加密，PowerSync 只搬运密文；有社区的 E2EE 聊天示例（[Data encryption](https://docs.powersync.com/client-sdks/advanced/data-encryption)、[E2EE chat 博客](https://powersync.com/blog/building-an-e2ee-chat-app-with-powersync-supabase)，后者未逐字核实）。加密字段显然无法在 Sync Rules 里过滤（推论）。

**规模**：每用户 bucket 数默认上限 1,000（可申请到 10,000）；单行 15 MB；单实例 5 万以上并发客户端；每客户端 100 万行以内表现良好；源库到服务端 2k–4k ops/s（[Performance and limits](https://docs.powersync.com/resources/performance-and-limits)）。

**许可（新变化）**：PowerSync Service 于 **2026-11-03 从 FSL 改为 Apache-2.0**（commit [`574ddbd`](https://github.com/powersync-ja/powersync-service/commit/574ddbd69cc7e305d62f22a3e2ee5d97ff32d209)，「Change license from FSL to Apache-2.0 (#878)」；当前 [LICENSE @ 52aeb3a](https://github.com/powersync-ja/powersync-service/blob/52aeb3adee80b75960db190cfa5ddb7130321182/LICENSE)）。

**对 saveslot**：架构上最接近 saveslot 的「主节点权威 + 离线写入排队」，但方向固定为服务端源库到客户端 SQLite，客户端不能当主节点；本地 PGlite 当主节点、托管当副本的情形不支持。可以借的是「上传队列非空不推进 checkpoint」「校验和 + 失败重同步」「拒绝也返回成功、被拒结果作为数据同步回来」。最后这条正好就是 saveslot 的「冲突是持久状态，读时带出」。

### 2.3 Replicache / Zero（Rocicorp）

**Replicache 模型**（[How it works](https://doc.replicache.dev/concepts/how-it-works)）：
- 客户端调用 mutator 后立即在本地生效，同时记一条持久化的待提交 mutation，**带客户端内单调递增的 mutation ID**；
- push 把待提交 mutation 批量发给服务端，服务端按 ID 顺序**重新执行同名 mutator**（结果可以和客户端不同）；
- pull 带 cookie，返回新 cookie、patch 和 `lastMutationIDChanges`；
- **rebase**：客户端不把 patch 叠在本地改动上，而是回退到上次服务端版本，应用 patch，再重放仍未确认的 mutation，然后原子地展示新状态；
- 「服务端是权威的」，冲突由 mutator 代码自己决定。

**幂等 / 有序的精确规则**（[Push 端点参考](https://doc.replicache.dev/reference/server-push)）：
- `id <= lastMutationID` 的 mutation 忽略（重复提交）；`id > lastMutationID+1` 的也忽略（乱序）；
- `lastMutationID` 的更新**必须和 mutation 的效果在同一事务里**；
- 永久错误：跳过这条 mutation，但仍推进 `lastMutationID`，避免卡死客户端；
- 临时错误：停下、不推进，客户端把服务端当作离线，稍后重试。

pull 的 patch 有 `put` / `del` / `clear`；cookie 失效时用 `clear` 加全量 `put` 重建（[Pull 端点参考](https://doc.replicache.dev/reference/server-pull)）。

**Zero**：Replicache 的后继，查询驱动。自定义 mutator 先在客户端乐观执行；`zero-cache` 把调用记录（名称 + 参数）转发给应用的 mutate 端点，由服务端版本在事务里执行；服务端抛错时这条 mutation 被跳过，客户端的乐观效果被撤销，`.server` 结果为 `type: 'error'`（[Mutators](https://zero.rocicorp.dev/docs/mutators)）。服务端校验 mutation ID 的源码：收到的 ID 小于期望值时抛 `MutationAlreadyProcessedError`，大于时报乱序（`oooMutation`），见 [`process-mutations.ts` L799–824 @ fbdb27e](https://github.com/rocicorp/mono/blob/fbdb27ed5f4ed2b3ae33331ebed5a5033f010dd9/packages/zero-server/src/process-mutations.ts#L799-L824)。**Zero 明确不支持离线写入**：断线、出错、需要重新鉴权这几种状态下写入直接被拒，只在连接建立过程中短暂排队；理由是「没有任何同步引擎或 CRDT 算法能自动解决」离线协作冲突（[Offline](https://zero.rocicorp.dev/docs/offline)）。

**鉴权**：Zero 没有 RLS 式权限系统。读权限靠在服务端给查询加过滤条件，写权限在 mutator 代码里检查；cookie 或 Bearer token 会被转发给应用端点（[Auth](https://zero.rocicorp.dev/docs/auth)）。**E2EE**：不支持（服务端要执行 mutator，必须能读明文，属于推论）。

**许可**：`rocicorp/mono`（含 Zero）为 Apache-2.0（`gh api repos/rocicorp/mono`）；GitHub 上的 `rocicorp/replicache` 仓库已归档（同法查询），Replicache 现状以官网为准（未核实）。

**对 saveslot**：不能直接用（只支持 Postgres 服务端；Zero 不支持离线写入）。但 **Replicache 的 push 规则是 saveslot 离线提交幂等最好的现成规范**，几乎可以逐条照搬。「服务端重新执行 mutator」也对应 saveslot 的「主节点重新检查 expected_version」。

### 2.4 Turso：embedded replicas 与 Turso Sync（libSQL / turso）

**Embedded replicas**：读走本地文件；**写默认直接发到远程主库，不先写本地**；同步单位是 4 KB 的 frame（复制日志），一字节的写入也算一个 frame；写入方能立即看到自己的写入，其他副本要等 `sync()`；同步期间打开本地库可能损坏数据；文档建议新项目改用 Turso Sync（[Embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction)）。

**Turso Sync（离线写）**：
- 读写都在本地，显式 `push()`/`pull()`；push 发送的是**逻辑语句**而不是页（[Sync usage](https://docs.turso.tech/sync/usage)）；
- 冲突策略是「**last push wins**」（[Conflict resolution](https://docs.turso.tech/sync/conflict-resolution)），发布博客说默认按行做逻辑日志，并提供 `transform` 钩子改写待推送的变更（[Introducing databases anywhere with Turso Sync](https://turso.tech/blog/introducing-databases-anywhere-with-turso-sync)，按搜索摘要引用，未逐字核实）；
- 有未推送的本地改动时 pull 的处理：本地回滚到上次同步状态，应用远程变更，再重放本地改动，整个过程原子（[Conflict resolution](https://docs.turso.tech/sync/conflict-resolution)）。这就是 Replicache 式的 rebase。

**删除 / 部分复制 / E2EE**：文档未说明删除和部分复制（未核实）；E2EE 在 Sync 文档中未提及（未核实）。**许可**：libSQL 和 turso 都是 MIT（`gh api`）；Turso Sync 的服务端是 Turso Cloud，能否自托管未核实。

**对 saveslot**：只适用于 SQLite；last-push-wins 和 saveslot 的「永不静默覆盖、冲突是持久状态」冲突；托管侧绑定 Turso Cloud。**不采用**。可以借的是「回滚 → 应用远程 → 重放本地」的原子 rebase 流程。

### 2.5 Litestream / LiteFS（物理 WAL 复制）

**Litestream**：后台进程接管 SQLite 的 checkpoint，用一个长读事务阻止别的进程重启 WAL，把新的 WAL 页**异步**打包成按 TXID 命名的 LTX 文件，传到**单一副本目的地**（对象存储等）；有分层压缩、默认每 24 小时一次快照、默认保留 24 小时；恢复时取最近的快照，再按 TXID 顺序应用 LTX；可选的 `litestream-vfs` 能直接从副本存储只读查询（[How it works](https://litestream.io/how-it-works/)）。Apache-2.0，2026-11-03 发布 v0.5.18（`gh api`）。

**LiteFS**：基于 FUSE 拦截 SQLite 的文件写入，把每个事务改动的页记成 LTX；每个库有 TXID 和滚动校验和；通过 Consul lease 选出主节点，**只有主节点能写**；异步复制，故障切换后如果分叉，用校验和检测出来，再从新主节点拉快照（[How it works](https://docs.fly.io/litefs/how-it-works)）。Fly 文档写着「LiteFS is outside our scope of support… Use with caution」（同上）。

**对 saveslot**：物理页复制**不能承载离线写入**，因为副本是只读的；也不符合「同步日志不同步状态」，页级复制看不到事件和墓碑的语义。对 saveslot 的价值仅限于：(a) 托管侧如果用 SQLite，Litestream 可以做备份 / 灾备；(b) LiteFS 的「lease 选主 + TXID + 滚动校验和发现分叉」可以借来做主节点切换时的分叉检测。**不作为同步组件**。

### 2.6 cr-sqlite（CRDT on SQLite）

**是什么**：SQLite / libSQL 的运行时扩展。`SELECT crsql_as_crr('t')` 把表升级为 CRR（conflict-free replicated relation）；通过虚表 `crsql_changes` 读取和应用变更集，列包括 `table, pk, cid, val, col_version, db_version, site_id, cl, seq`；按主键匹配行、按列用对应 CRDT 语义合并；已支持 LWW、分数索引、observe-remove 集合，计数器和富文本还在做；删除通过 causal length（`cl`）和 delete log 处理（[README @ 43ab94c](https://github.com/vlcn-io/cr-sqlite/blob/43ab94cac537d080aac7cb7628a435c02ee9e268/README.md)）。
- 性能：写入 CRR 比普通表**慢 2.5 倍**，读不变（同上）；
- 当前 v1 只做「无历史 CRDT」，带完整历史的「因果事件日志」模式计划在 v2（同上）；
- 维护情况：最近的提交是 2026-08 的构建修复（`gh api repos/vlcn-io/cr-sqlite/commits`）；作者 Matt Wonlaw 2024 年加入 Rocicorp（[localfirst.fm #10](https://localfirst-fm.vercel.app/10)，按搜索摘要引用，未逐字核实）。功能性开发放缓（推论）。MIT。

**对 saveslot**：PostgreSQL / PGlite 侧没有对应实现，saveslot 的托管侧用不上；LWW 按列合并会**静默选出赢家**，违反 saveslot「冲突是持久状态、读时带出」的原则；只追加的日志本来就不需要 CRDT（日志是 grow-only set，合并就是取并集）。**不采用**。

### 2.7 Automerge（对照）

- 同一属性的并发写入，用**操作 ID**（不是墙钟时间）选出各节点一致的赢家；输掉的值保留在 conflicts 对象里，可用 `getConflicts` 读出；下次对该属性赋值就视为冲突已解决（[Conflicts](https://automerge.org/docs/reference/documents/conflicts/)）。
- 有意保留完整历史；Automerge 3 把内存降低了 10 倍以上（把《白鲸记》粘进文档：Automerge 2 约 700 MB，Automerge 3 约 1.3 MB）（[Automerge 3.0](https://automerge.org/blog/automerge-3/)）。
- 未找到正式的「删除历史」API；cookbook 只提到可以由中心节点要求各节点从某个 change hash 起截断历史（按搜索摘要，未核实）。MIT，活跃。

**对 saveslot**：「输家值保留并可读出」和 saveslot 的「争议标记」形式上相似。但 Automerge 的冲突是**结构性**的（同一键的并发赋值），saveslot 的冲突是**语义性**的（来源级别、核对状态、纠错还是变更），Automerge 无法表达；保留全部历史也和隐私删除冲突。可以借用它的一个概念：读出时同时给「确定的赢家 + 输家列表」。

### 2.8 CouchDB / PouchDB 复制协议

**协议**（[Replication Protocol](https://docs.couchdb.org/en/stable/replication/protocol.html)）：单向，从 Source 到 Target，基于 HTTP/1.1。
- 生成 Replication ID；两端在 `/_local/{id}` 存复制日志（`source_last_seq`、`session_id`、`history`）作为检查点，每批之后写入，失败后从上次成功处续传；
- 读 `_changes?since=…`；用 `_revs_diff` 只找出目标端缺失的 revision；用 `_bulk_docs` 加 `new_edits=false` 原样写入 revision 及其祖先链（`_revisions`）；批内单条失败不影响整批；写检查点前先调 `_ensure_full_commit`。

**冲突**：revision 树可以有多个叶子（冲突版本）；各节点用同一个确定性算法选出「赢家」，输家保留，可查询；解决冲突的方式是把输家叶子标为 `_deleted`（[Conflicts](https://docs.couchdb.org/en/stable/replication/conflicts.html)）。

**删除与复活**：普通删除只是写一个 `_deleted=true` 的新 revision（墓碑），会随复制传播。`_purge` 才真正从 b+tree 抹掉文档，但「**Purge operations are not replicated to other external databases**」，必须在每个库上分别执行（[Database misc API](https://docs.couchdb.org/en/stable/api/database/misc.html)）。由此推论：仍持有旧 revision 的外部副本可以把被 purge 的文档复制回来。

**对 saveslot**：这是「检查点 + 增量 diff + 原样写入」的经典模板，适合每用户的小日志；revision 树对 saveslot 是多余的，因为单主模式下没有合法的并发分支。**最重要的反面教材是 purge 不复制**：saveslot 的隐私删除必须同时满足「墓碑事件能复制」和「内容可以被抹掉」，相当于把 CouchDB 的墓碑和 purge 合在一起：内容销毁靠密钥销毁，墓碑永久保留并复制。

### 2.9 KurrentDB（原 EventStoreDB）、Kafka MirrorMaker 2 与幂等生产者

**KurrentDB**：集群是 leader / follower，写入要多数派确认才返回（2n+1 个节点容忍 n 个故障）；只读副本异步单向复制，不参与选举（[Cluster](https://docs.kurrent.io/server/v24.10/configuration/cluster.html)）。追加的幂等基于「stream + event ID」，重复提交被确认为成功、但不重复写入；用 `ExpectedVersion.Any` 时不保证幂等（[.NET TCP client 21.2 Appending](https://docs.kurrent.io/clients/tcp/dotnet/21.2/appending.html)，按搜索摘要引用，未逐字核实）。
**启示**：对 saveslot 来说是「事件 ID + 预期版本 = 幂等 + 乐观并发」的成熟先例。集群复制是同步多数派复制，不适合离线场景。

**MirrorMaker 2**（[KIP-382](https://cwiki.apache.org/confluence/display/KAFKA/KIP-382%3A+MirrorMaker+2.0)）：
- 远程 topic 命名为 `<源别名>.<topic>`，保留分区和顺序；
- 用 offset-sync topic 记录上下游 offset 映射，用 checkpoint topic 记录消费者组位置；
- 用 heartbeat topic 判断链路是否存活；名字里已带目标别名的 topic 不再复制回去，以此防环；
- **不提供 exactly-once**，offset 无法总是精确换算。

**启示**：(a) 两端位置不同，需要显式的「来源位置 ↔ 本地位置」映射表；(b) 以来源节点为命名空间防止回环，对应 saveslot 的「事件带 origin node」。

### 2.10 Durable Streams（Electric 抽出来的传输协议）

- 每个流一个 URL：`PUT` 创建，`POST` 追加，`GET` 从某个 offset 读（可以长轮询或 SSE 追尾）；offset 不透明但可按字典序排序；某个位置上的字节永不改变；按 offset 寻址，可被 CDN 缓存（[PROTOCOL.md @ 461b402](https://github.com/durable-streams/durable-streams/blob/461b40267aabd644558f9b19dbb9507dd5f691cf/PROTOCOL.md)；[发布博客](https://electric.ax/blog/2025/12/09/announcing-durable-streams)）。
- **Kafka 式幂等生产者**（PROTOCOL.md §5.2.1）：`Producer-Id` + `Producer-Epoch` + `Producer-Seq`，三个必须同时提供。
  - `epoch < 服务端 epoch` → 403（隔离过期的「僵尸」写入方）；
  - 新 epoch 必须从 `seq=0` 开始；
  - `seq <= lastSeq` → 204（重复，按幂等成功处理）；`seq == lastSeq+1` → 接受；跳号 → 409，并返回 `Producer-Expected-Seq`；
  - 另有应用层的 `Stream-Seq` 用于跨重启排序。
- 还支持流的 fork（从某个 offset 分叉，fork 不继承生产者状态）。
- 状态：文档标为 DRAFT 1.0；仓库 MIT，约 1.7k star（`gh api repos/durable-streams/durable-streams`）。博客称已在 Electric Cloud 每天承载数百万次状态变更；参考实现是 Node 服务端加 TS 客户端加一致性测试套件（[发布博客](https://electric.ax/blog/2025/12/09/announcing-durable-streams)）。

**对 saveslot**：**这是和 saveslot 最贴合的现成规范**：只追加、按 offset 续传、幂等追加、epoch 隔离，正好覆盖 saveslot 两个方向的需求（主节点 → 副本的拉取，离线节点 → 主节点的提交）。不足是：它只是字节或 JSON 流，不懂 saveslot 的语义（预期版本、墓碑、哈希链、拒绝 / 候选），这些要在事件载荷和主节点的入口逻辑里自己做。可以选择让 saveslot 的同步端点**兼容 Durable Streams 协议**（自己实现服务端，或直接用它的 TS 客户端），而不是把 saveslot 的日志存进别人的流服务。

### 2.11 Hypercore 与 Keyhive（安全日志与 E2EE 的参照）

- **Hypercore**：单写入方的只追加日志，用签名的 Merkle 树校验；支持稀疏复制（只下载需要的区间）；`truncate` 会递增 `fork` 计数；`clear` 只删除**本地**缓存的块，块之后还能被重新下载（[Hypercore 文档](https://docs.pears.com/building-blocks/hypercore)）。**启示**：「签名 + Merkle 校验 + 按区间稀疏复制」对应 saveslot 的哈希链和按 thread 部分复制；`clear` 可以被重新下载这一点再次说明：**只删本地副本不等于删除**。
- **Keyhive**（Ink & Switch）：给本地优先应用做基于能力的访问控制和 E2EE；BeeKEM 群组密钥协商；同步服务器只看到密文；pre-alpha，未经安全审计，不建议用于生产（[Keyhive notebook](https://www.inkandswitch.com/keyhive/notebook/)）。**启示**：「同步服务器只搬密文」是可行方向，但现成方案还不成熟。

---

## 3. 对比表

| 方案 | 方向 / 拓扑 | 离线写 | 被拒如何呈现 | 删除 / 防复活 | 部分复制 | E2EE | 许可 | saveslot 能直接用？ |
|---|---|---|---|---|---|---|---|---|
| Electric | PG → 客户端，只读 | 应用自理 | 应用自理 | 只有 delete 操作，没有防复活 | Shape（单表 + where） | 无 | Apache-2.0 | 否；借 HTTP / offset / CDN 思路 |
| PowerSync | PG 等 → SQLite；写回经应用 API | FIFO 上传队列 | 建议返回 2xx，被拒结果作为数据同步回来 | REMOVE（从所有 bucket 移除才删）；靠服务端权威 | bucket / Sync Streams | 只有本地加密；E2EE 由应用自加密 | Apache-2.0（2026-11 起） | 否（客户端不能当主）；借 checkpoint / 队列语义 |
| Replicache / Zero | PG 服务端权威 | Replicache 可以；**Zero 不支持** | mutator 抛错 → 跳过并撤销乐观效果，`.server` 返回 error | 服务端权威；patch 有 `del` | 按查询 | 无 | Apache-2.0（mono） | 否；**照搬 push 幂等规则** |
| Turso Sync | 本地 SQLite ↔ Turso Cloud | 可以 | last push wins（静默覆盖） | 未核实 | 未核实 | 未核实 | MIT（引擎） | 否 |
| Litestream / LiteFS | 单写入方页复制 | 不支持 | — | 页级，没有语义 | 无 | 无 | Apache-2.0 | 只用于备份 |
| cr-sqlite | 多主 CRDT | 可以 | 不拒绝，LWW 合并 | causal length / delete log | 无 | 无 | MIT | 否 |
| Automerge | 多主 CRDT 文档 | 可以 | 不拒绝，输家保留 | 历史难删 | 按文档 | 外部方案（Keyhive，pre-alpha） | MIT | 否 |
| CouchDB / PouchDB | 多主，revision 树 | 可以 | 冲突叶子 + 确定性赢家 | `_deleted` 墓碑可复制；**purge 不跨库复制** | filter / 选择性复制 | 无 | Apache-2.0 | 否；借检查点 / diff |
| Durable Streams | 只追加流，HTTP | 生产者自己缓冲 | 403 / 409 / 204 | 流级删除 | 一个 thread 一个流 | 载荷可以是密文 | MIT | **可作为传输规范** |

---

## 4. 为什么单主而不是 CRDT：实话实说的取舍

**单主赢在：**
1. **saveslot 的冲突是语义冲突。** 「权威来源优先；用户明确 > Agent 推断（只认已核对的）；同级保持上一个已确认值；高影响操作进待确认」都需要一个地方**看到全序、执行规则、记录裁决**。CRDT 合并函数必须满足交换律、结合律、幂等，没法实现「进待确认，等人或等期限」这类有状态、带副作用的裁决。Zero 的官方文档就直说离线冲突「没有任何同步引擎或 CRDT 算法能自动解决」（[Zero Offline](https://zero.rocicorp.dev/docs/offline)）。
2. **只追加日志本身就无冲突。** 源数据日志是 grow-only set，复制只需要取并集加去重，不需要 CRDT 的复杂度。冲突只出现在「派生」这一步，单主让派生只在一个地方发生，结果确定、可审计。
3. **隐私删除。** CRDT（尤其 Automerge）依赖保留历史和墓碑；cr-sqlite 的删除记录也是合并语义的一部分。saveslot 要求「内容可抹除、墓碑保留哈希」，在单主下更容易做到。
4. **前车之鉴。** Electric 放弃了 active-active 和本地写入最终性，转为只做读路径（[Electric Next](https://electric.ax/blog/2024/07/17/electric-next)）；Zero 干脆不支持离线写入。

**单主输在（要正视）：**
1. **离线写入在被主节点接受前只是「暂定」。** 主节点一旦把某个 op 降为候选版本，离线节点上看到的派生值就会变。必须让 Agent 和 UI 理解「本地已保存 ≠ 主节点已接受」。
2. **主节点不在线时，其他节点之间无法收敛。** 例如手机和笔记本都离线、主节点是家里的台式机：两边各写各的，要等主节点上线才能合并。CRDT 可以点对点收敛。
3. **切换主节点是一个需要协调的操作**（见 6.7），处理不当会脑裂。CRDT 没有这个问题。
4. **主节点必须能读明文才能派生**，和 E2EE 有张力（见 7）。

结论：对 saveslot 的数据（每用户量级小、写入以追加为主、冲突需要人或规则裁决），单主的代价可以接受；而 CRDT 解决的问题（并发编辑同一字段的自动合并）恰好不是 saveslot 的核心问题。

---

## 5. 事件日志复制模式：对每用户小日志合适的取法

| 模式 | 取 | 不取 |
|---|---|---|
| CouchDB | 两端各存检查点；`since` 增量；先 diff 再传；批内单条失败不影响整批 | revision 树、多主 |
| PowerSync | checkpoint 原子应用；校验和发现不一致后整段重同步；有待提交写入时不推进 | bucket 数上限的设计负担 |
| Replicache / Zero | 每个来源的单调 seq；`lastSeq` 与业务写同事务；永久错误也推进；rebase 三步 | 要求服务端执行任意代码 |
| Kafka / Durable Streams | producer id + epoch + seq；epoch 隔离僵尸写入方；204 表示重复 | 只有字节流语义 |
| MirrorMaker 2 | 来源位置 ↔ 本地位置映射；以来源节点为命名空间防回环 | 只能 at-least-once |
| LiteFS | TXID + 滚动校验和发现分叉；lease 选主 | 页级复制 |
| Hypercore | Merkle / 签名校验；按区间稀疏复制 | 单写入方必须持有私钥 |

每用户日志规模小（推测：万到百万条事件、几十 MB 到几 GB，**未核实，需要按 saveslot 的实际负载估算**），所以：不需要分区和多数派；一条 HTTP 长连接或 SSE 就够；**全量重同步是可以接受的兜底手段**（PowerSync 和 Electric 都把它当常规路径，见 2.1、2.2）。

---

## 6. 建议：saveslot 的复制协议草图

> 目标：每用户一个主节点、支持离线写入、复制日志而不是状态，并且映射到 saveslot 已有的冲突规则。以下是设计草图，不是定稿。

### 6.1 角色与标识

| 标识 | 定义 | 说明 |
|---|---|---|
| `user_id` | 用户 | 复制域 |
| `node_id` | 每个节点安装时生成的随机 ID（如 UUIDv7） | 本地、托管、私有服务器各一个 |
| `primary_epoch` | 整数，每次切换主节点加 1 | 用于隔离旧主节点，相当于 Raft 的 term 或 Durable Streams 的 `Producer-Epoch` |
| `event_id` | `(origin_node_id, origin_seq)` | **事件的永久身份**，离线写入时生成；`origin_seq` 是该节点单调递增的序号（同 Replicache 的 mutation ID） |
| `content_hash` | 内容（密文之前）的**带密钥哈希**，如 HMAC(user_secret, plaintext) | 墓碑和去重都用它；带密钥是为了防止对低熵内容做字典猜测（见 7） |
| `log_pos` | 主节点为接受的事件分配的全局位置（每用户单调） | 只由主节点分配，相当于 PowerSync 的 op_id 或 Durable Streams 的 offset |
| `chain_hash` | `H(prev_chain_hash ‖ event_id ‖ content_hash ‖ log_pos ‖ primary_epoch)` | **权威哈希链只在主节点按 `log_pos` 计算** |
| `idempotency_key` | 现有写入请求字段 | 在 Agent → 节点这一层去重；节点 → 主节点这一层用 `event_id` 去重 |

要点：**不要用链哈希当事件身份。** 离线节点本地也串链（用于本地防篡改），但被主节点接受后，权威链会按 `log_pos` 重新串，就像 git rebase 会换 commit id。所以事件身份必须是与链无关的 `event_id`，本地链头记为 `origin_chain_hash` 留作证据。

### 6.2 事件种类（都在日志里）

- `source`：源数据（证据、对话片段、API 调用请求本身等）。
- `op`：对有模型数据的写入意图，带 `expected_version`、`intent`、`source_level`，引用若干 `source` 的 `event_id`。
- `derivation`：主节点派生、裁决的结果。包括接受、拒绝、候选版本、待确认，以及 LLM 抽取结果（按 data-model.md，重建靠「重放日志里记下的抽取结果」，所以副本**复制派生结果，不在本地重算 LLM**）。
- `tombstone`：隐私删除。带被删事件的 `event_id` 列表、`content_hash` 列表、级联范围，以及「密钥已销毁」声明。
- `control`：主节点切换（handoff）、schema 发布等。

### 6.3 两个方向

**下行（主节点 → 副本）**：副本带上自己的 `last_log_pos` 拉取（长轮询或 SSE）。主节点按 `log_pos` 顺序发事件，每批末尾带 `checkpoint = (log_pos, rolling_checksum, primary_epoch)`。副本整批原子应用（PowerSync 做法）；校验和对不上就从上一个快照重同步（PowerSync / LiteFS 做法）。传输层建议兼容 Durable Streams 的 `GET ?offset=` 语义。

**上行（离线节点 → 主节点）**：节点把本地待提交事件按 `origin_seq` 顺序批量 POST，带上 `(origin_node_id, node_epoch, batch_seq)`。主节点的规则如下（Replicache push 规则加 Durable Streams 生产者规则）：

```
对每个 origin_node_id 持久化 last_origin_seq（与日志追加同事务）
事件 origin_seq <= last_origin_seq → 已处理：返回其原有结果（幂等）
origin_seq == last_origin_seq + 1 → 处理
origin_seq >  last_origin_seq + 1 → 409 + expected_seq（节点从该处重发）
请求里的 primary_epoch < 当前 epoch → 409 + 新主节点地址（见 6.7）
```

### 6.4 主节点如何处理离线事件（映射到冲突规则）

按种类分开处理，这是 saveslot 和一般同步引擎的关键区别：

1. **`source` 事件：总是接受。** 符合「写入一律先收，不因核对不过而拒绝」。唯一例外是**墓碑命中**（见 6.6）。重复内容按 `content_hash` 加 schema 唯一键标为「疑似重复」，不拒绝。
2. **`op` 事件：在主节点按 `log_pos` 顺序重新执行 `expected_version` 检查**（相当于 Replicache「服务端重跑 mutator」）：
   - 版本对得上 → **已保存**，写一条 `derivation(accepted, new_version)`；
   - 版本对不上 → **不阻塞、不丢弃**：按冲突规则 3 算出生效值（权威来源优先；已核对的用户明确 > Agent 推断；同级保持上一个已确认值），把这个 op 记为**候选版本**或**待确认**，写 `derivation(candidate | pending, reason, current_value)`；
   - 违反 schema（比如离线期间 schema 升级了）→ `derivation(rejected, hint)`。它依据的 `source` 仍然保留，并标为「待按新 schema 重新抽取」。
   - 规则：无论结果如何，`last_origin_seq` 都推进（Replicache 的「永久错误也标记为已处理」）；只有主节点内部的临时故障才不推进。
3. **被拒或降级的结果怎么让人知道**：不靠推送（冲突规则 1、2）。
   - `derivation` 事件随下行日志回到原节点，原节点把这些 op 的本地状态从「本地已保存（暂定）」改为对应状态；
   - 下一个读到相关数据的 Agent 会收到「生效值 + 争议标记」；
   - 这正是 PowerSync 推荐的「被拒结果作为数据同步回来」，而且 saveslot 已经把它设计成持久状态。

### 6.5 离线节点本地的 rebase

本地分两层：**已确认层**（主节点日志到 `last_log_pos` 为止，加上派生结果）和**暂定层**（本地待提交事件）。

- 本地读取 = 已确认层 + 暂定层按顺序重放（本地也跑同一套确定性的 op 检查，所以离线时也能给 Agent「已保存（暂定）/ 冲突」的即时反馈）；
- 收到新的下行批次时：丢弃暂定层的派生结果 → 应用新确认的事件 → 移除已被确认的本地事件 → 在新基础上重放剩余暂定事件（Replicache / Turso Sync 做法）；
- 暂定状态必须**在读结果里显式标出**（如 `tentative: true`），否则 Agent 会把暂定值当作已确认值告诉用户；
- 本地**不在暂定层做 LLM 抽取后台任务**，或者把抽取结果也标为暂定，以主节点为准。

### 6.6 墓碑与防复活

1. 隐私删除可以在任何节点发起；在离线节点上它先是暂定墓碑，但**本地立即生效**：立即销毁本地密钥、隐藏内容。
2. 主节点接受墓碑后：执行 data-model.md 里的级联；销毁 thread 或条目密钥；把被删事件的 `content_hash` / `event_id` 写入**墓碑集合**（只存带密钥的哈希）；墓碑事件进日志并复制到所有节点。
3. **入口拦截**：主节点处理任何上行 `source` 时，先查墓碑集合。命中就拒绝，写一条 `derivation(rejected: tombstoned)`，**不存内容**。这样即使离线节点带着旧数据回来，也写不回去。CouchDB purge 不复制、可能复活的问题由此避免。
4. **节点重连的顺序**：先完成下行（至少拉到最新的墓碑），再上行；本地暂定事件如果命中新墓碑，就在本地丢弃，不上传。
5. 墓碑**永不压缩、永不过期**，也不随日志截断而丢失；导出 / 导入时一起迁移。
6. 被删事件在权威哈希链上保留 `content_hash` 作为占位（data-model.md 已有设计），链依然可以校验。

### 6.7 切换主节点（本地 ↔ 托管）

把切换当作日志里的一个控制事件，配合 epoch 隔离（类似 Durable Streams 的 epoch、LiteFS 的 lease、Raft 的 term）：

1. **计划内切换（两边都在线）**：
   - 旧主节点进入只读，不再分配 `log_pos`；
   - 新主节点追平旧主节点的日志到最后一个 `log_pos`，两边核对 checkpoint 校验和；
   - 旧主节点写入 `control(handoff, new_primary=node_id, epoch=n+1, at=log_pos)`，用用户密钥签名；
   - 新主节点从 `epoch n+1` 开始分配位置；
   - 旧主节点降级为普通节点，它之后的写入都走上行流程。
2. **计划外切换（旧主节点丢失或离线，例如笔记本坏了，改用托管）**：用户在新节点上显式发起「接管」，`epoch` 加 1，从新节点已有的最大 `log_pos` 继续。旧主节点如果之后回来：
   - 它的 epoch 已过期，上行请求会被 409 拒绝，并告知新主节点地址；
   - 它在旧 epoch 下、在接管点之后分配过的位置一律作废。这些事件按 `event_id` 当作**离线写入重新提交**（`source` 照收，`op` 重新做版本检查）。
   - 因为事件身份是 `event_id` 而不是 `log_pos`，所以不会丢数据。代价是旧主节点在那段时间里的派生结果会被重新裁决。
3. **导出 / 导入就是从 `log_pos=0` 开始的一次下行**（快照 + 增量），外加墓碑集合和密钥材料（按 7 的方案）。这样「可退出」和「复制」是同一套代码路径。
4. **将来按 thread 设主节点**：把 `log_pos`、`primary_epoch`、`last_origin_seq` 的作用域从「每用户」改为「每用户 × 每归属域」，协议不变。thread 的「归属节点」字段决定它的事件进哪条日志。`home=local` 的 thread 的日志**根本不发给托管节点**，或者只发密文和墓碑。

### 6.8 部分复制

- 复制单位 = thread，或「归属域」（一组 thread）。副本订阅一组 thread，相当于 PowerSync 的 bucket 或 Hypercore 的稀疏区间。
- **墓碑和 `control` 事件必须全量复制到所有节点**，不受订阅范围限制，否则不订阅某个 thread 的节点无法拦截复活。
- 每用户的数据量不大，第一版可以**全量复制**（除去必须留在本地的 thread），把部分复制推迟到归属节点上线时一起做。

### 6.9 鉴权

- 节点间同步使用**节点身份**（每个节点一对密钥，或由用户签发的设备凭证）。它和 data-model.md 中「按连接实例授权」的主体是两个层级：连接实例鉴权管 Agent 对节点；节点身份管节点对节点。
- 主节点只接受用户已登记节点的上行请求；`control(handoff)` 必须由用户密钥签名。
- 托管多租户时，所有同步端点按 `user_id` 隔离；HTTP 层可以学 Electric 的「代理决定范围、客户端只能缩小」。

### 6.10 组件选择

| 层 | 建议 |
|---|---|
| 同步引擎 | **不采用**现成引擎（Electric / PowerSync / Zero / Turso Sync 方向固定，或者语义不符） |
| 传输规范 | **兼容 Durable Streams 协议**（MIT，只追加、按 offset 续传、幂等生产者、epoch 隔离）。可以评估直接使用它的 TS 客户端，服务端自己实现在 saveslot 引擎里（saveslot 的日志本来就在 PG / PGlite 里） |
| 幂等 / rebase 规则 | 照 Replicache push 规范（第 2.3 节）实现 |
| 一致性校验 | 照 PowerSync 的 checkpoint + 滚动校验和 |
| 备份 | 托管 PG 用常规 PITR；本地如果用 SQLite，可选 Litestream 做本机外备份（只当备份，不当同步） |
| CRDT | 不采用；只有将来出现「多人协作编辑同一段文本」类数据时，才考虑在单个字段内部用（如 Automerge），而且只作为 `source` 的载荷 |

工作量估计（推测，未核实）：协议本身约千行量级。真正的成本在主节点入口逻辑（版本检查、墓碑拦截、派生事件）和本地暂定层的 rebase，这两部分无论用不用现成引擎都要自己写。

---

## 7. 开放风险

1. **E2EE 与托管主节点。** 托管当主节点意味着托管节点要能解密才能抽取和派生；这和「内容按条加密、删除 = 销毁密钥」兼容，但和「托管只看到密文」不兼容。可选方案：
   - (a) 托管主节点持有密钥，属于服务端加密，不是 E2EE，需要对用户说明白；
   - (b) 按 thread 区分：`home=local` 的 thread 在托管侧只存密文（盲中继），派生只在本地做；
   - (c) 远期用 Keyhive 这类方案，但它目前是 pre-alpha（[Keyhive](https://www.inkandswitch.com/keyhive/notebook/)）。

   这个决定会影响「托管的价值是全天在线、接得到云端 Agent」能否成立：云端 Agent 读不到密文 thread。
2. **墓碑本身泄露信息。** 墓碑集合里存的哈希，如果用普通哈希，可以对低熵内容（如「体重 72kg」）做字典攻击。必须用带用户密钥的 HMAC；同时要确认哈希链里保留的「内容哈希」用的也是同一种（data-model.md 现在写的是「内容的哈希」，需要明确）。
3. **重新串链和审计。** 离线事件被接受后，权威链和本地链不同。审计时要能证明「本地那条事件就是主节点那条」。需要 `event_id` 加 `origin_chain_hash` 双向可查，同时定义清楚以哪条链为证据。
4. **长期离线和 schema 漂移。** 离线节点按旧 schema 生成的 op 到了主节点可能整体失效。按 6.4 处理时 source 不会丢，但用户会看到一批「待重新抽取」。需要给离线时长或 schema 版本差设上限，并做好呈现。
5. **计划外切换后的重新裁决。** 旧主节点回来后，它在那段时间里的派生结果会被推翻。冲突规则 5（记录读取）能查出哪些任务读过被推翻的版本，但这些读记录本身也需要复制回新主节点（read_log 是否复制，**设计文档未定**）。
6. **主节点离线期间无法收敛。** 本地当主节点、电脑关机时，手机和云端 Agent 只能写暂定事件。如果用户大部分时间都这样用，体验会接近「总在冲突里」。建议默认推荐托管或私有服务器当主节点，本地当主节点作为高级选项（产品决策，非技术结论）。
7. **派生结果不确定。** LLM 抽取不确定，所以副本必须复制派生结果，不能本地重算（6.2）。这会增加日志体积，量级未核实。
8. **生态变动。** Electric 被 Databricks/Neon 收购（[electric.ax 横幅](https://electric.ax/)），Durable Streams 协议仍是 DRAFT；PowerSync 刚改为 Apache-2.0；cr-sqlite 和 LiteFS 处于低维护状态。saveslot 只依赖**协议语义**、不依赖它们的服务，可以把这些风险降到最低。
