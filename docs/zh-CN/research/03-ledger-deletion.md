# 03 · 防篡改日志、账本数据库与只追加系统里的删除

> 2026-11-09 调研。对象：saveslot 的 change_log 哈希链、read_log、被遗忘权删除、加密粉碎（crypto-shredding）。
> 背景见 [`../DRAFT.md`](../spec/01-positioning.md) 与 [`../data-model.md`](../spec/03-data-model/README.md)「日志防篡改」「删除分两种」两节。
> 每条事实后附来源；GitHub 链接尽量钉到 commit。标「未核实」的是没读到一手原文的。

## 0. 结论先行

1. **没有能直接拿来当组件的现成账本库。** immudb 设计最贴近 saveslot（条目只承诺 value 的哈希，value 可截断），
   但它是 **BSL 1.1**，不是开源许可，且只能以 Go 库嵌入、不能装进 PostgreSQL/PGlite/SQLite；QLDB 已停服；
   Azure SQL ledger 绑死 SQL Server 且**明确不支持删除历史**。saveslot 应该**借思路、自己实现一小层**。
2. **该借的是透明日志（CT / Tessera）那一套**：RFC 6962 Merkle 树 + C2SP signed-note 格式的 checkpoint +
   包含证明 / 一致性证明。这套算法公开、许可宽松（Apache-2.0），数据量在 saveslot 的规模（单租户百万级事件）下几乎没有性能问题。
3. **链上绝不能放明文的无盐哈希。** EDPB 2026-07 定稿的区块链指南明说：无盐 / 无密钥哈希一般不足以保护个人数据；
   加盐或带密钥的哈希在密钥 / 盐销毁后"不应再能关联到原数据"。所以链上承诺应是**密文的哈希**，
   外加（可选）一个**随数据密钥一起销毁的带密钥承诺**。
4. **加密粉碎在法律上是"必要但不充分"。** EDPB 认为加密后的个人数据**仍是个人数据**，删钥后只是"在算法被攻破前不可读"。
   因此 saveslot 的删除应当是：**能物理删的地方物理删（主库、副本、索引、向量、缓存），删不到的地方（备份、离线副本）靠删钥兜底**，
   并用墓碑阻止复活。
5. **最大的工程风险不在链，而在"明文泄漏到链外"**：派生表、change_log 的前后整行、embedding、全文索引、PG 的 WAL/PITR 归档、
   写入请求里的 evidence 摘录、应用日志。哈希链设计对了，这些地方漏了照样删不干净。

---

## 1. immudb

### 怎么工作

- **双结构：线性哈希链 + 只追加 Merkle 树。** 每个事务头算一个累积线性哈希 `Alh = SHA256(txID ‖ prevAlh ‖ innerHash)`，
  `innerHash` 覆盖时间戳、版本、元数据、条目数、条目 Merkle 根 `eH`，以及 `blTxID/blRoot`（之前事务 Alh 构成的
  "binary linking" 只追加哈希树的根）。见
  [`embedded/store/tx.go` L249–L319](https://github.com/codenotary/immudb/blob/bfdce03649f52d575be46f74425fd18eaf4fa69c/embedded/store/tx.go#L249-L319)。
- **只追加哈希树（AHT）沿用 RFC 6962 的域分离前缀**：`LeafPrefix = 0`、`NodePrefix = 1`，见
  [`embedded/ahtree/ahtree.go` L46–L47](https://github.com/codenotary/immudb/blob/bfdce03649f52d575be46f74425fd18eaf4fa69c/embedded/ahtree/ahtree.go#L46-L47)。
- **条目摘要只承诺 value 的哈希，不承诺 value 本身**：`TxEntryDigest_v1_2` 把 `md ‖ key ‖ hVal` 拼起来哈希，`hVal` 是 value 的 SHA-256，见
  [`tx.go` L703–L730](https://github.com/codenotary/immudb/blob/bfdce03649f52d575be46f74425fd18eaf4fa69c/embedded/store/tx.go#L703-L730)。
  这正是 saveslot 设想的"事件只引用内容哈希（像 commit 引用 blob）"。
- **证明**：`LinearProof`（沿 Alh 链）与 `DualProof`（结合 AHT 的包含 + 一致性），见
  [`embedded/store/verification.go` L40、L127](https://github.com/codenotary/immudb/blob/bfdce03649f52d575be46f74425fd18eaf4fa69c/embedded/store/verification.go#L40)。
- **客户端校验**：SDK 本地保存上次见过的状态，通过 `VerifiableGet` 等接口 / SQL 函数 `immudb_verify_row`、`immudb_verify_tx`
  校验，不需要信任服务器（[README](https://github.com/codenotary/immudb/blob/bfdce03649f52d575be46f74425fd18eaf4fa69c/README.md)）。

### 删除 / 过期怎么处理

- **逻辑删除**：KV 元数据有 `deleted` 标记（[`kv_metadata.go` L117](https://github.com/codenotary/immudb/blob/bfdce03649f52d575be46f74425fd18eaf4fa69c/embedded/store/kv_metadata.go#L117)），
  SQL `DELETE` 也只是写一个新版本，旧值仍在历史里。
- **过期**：可给 KV 设 `ExpiresAt`，读到时返回 `ErrExpiredEntry`（[`kv_metadata.go` L140](https://github.com/codenotary/immudb/blob/bfdce03649f52d575be46f74425fd18eaf4fa69c/embedded/store/kv_metadata.go#L140)、
  [`immustore.go` L83](https://github.com/codenotary/immudb/blob/bfdce03649f52d575be46f74425fd18eaf4fa69c/embedded/store/immustore.go#L83)）——这是**读时隐藏，不是物理删除**。
- **物理删除只有"按事务号截断前缀"**：`TruncateUptoTx(minTxID)` 删除 value log 中早于某事务的部分；
  若 value 内嵌在事务里（`embeddedValues`），**截断不删除任何数据**（[`immustore.go` L3632–L3670](https://github.com/codenotary/immudb/blob/bfdce03649f52d575be46f74425fd18eaf4fa69c/embedded/store/immustore.go#L3632-L3670)）。
  文档称保留期功能"只删 value log 的数据，证明和 schema 配置保持完整"（[docs 1.9.6 retention](https://docs.immudb.io/1.9.6/production/retention)，经搜索摘要转述，页面原文未直接读到，**部分未核实**）。
  → **没有"按 key / 按主体删除某一条历史"的能力**，无法满足被遗忘权的定点删除。

### 嵌入性、许可、成熟度

- **许可：Business Source License 1.1**，适用于 "immudb Version 1.9DOM.2 or later"；附加授权允许生产使用，
  但**不得以托管或嵌入方式向第三方提供与 Codenotary 付费版竞争的产品**；4 年后转 Apache 2.0
  （[LICENSE](https://github.com/codenotary/immudb/blob/bfdce03649f52d575be46f74425fd18eaf4fa69c/LICENSE)）。
  BSL 不是 OSI 开源许可（[SPDX BUSL-1.1](https://spdx.org/licenses/BUSL-1.1.html)）。saveslot 作为开源 + 托管多租户产品，正落在这条限制附近。
- **嵌入**：可作为 Go 库进程内运行，也可独立服务；实现 PostgreSQL wire 协议 v3（[README](https://github.com/codenotary/immudb/blob/bfdce03649f52d575be46f74425fd18eaf4fa69c/README.md)）。
  但它是**另一个数据库**，不是 PG 扩展，也进不了 PGlite / SQLite。
- **成熟度**：约 9k stars，最新 release v1.11.2（2026-09-03）（`gh api repos/codenotary/immudb/releases/latest`）。

### 对 saveslot

**不用作组件**（许可 + 嵌入形态 + 无定点物理删除）。**借两点**：①条目只承诺 `hash(value)`，value 存在可单独删除的位置；
②线性链 + 只追加 Merkle 树两手都有，线性链便宜、Merkle 给对数级证明。**反面教训**：immudb 承诺的是明文 value 的裸 SHA-256，
删掉 value 后哈希仍可被字典攻击确认（见 §5）。

---

## 2. 透明日志：CT（RFC 6962/9162）、Trillian / Tessera、Sigstore Rekor

### 怎么工作

- **Merkle 树哈希（RFC 9162 §2.1.1）**：叶 `HASH(0x00 ‖ d)`，内部节点 `HASH(0x01 ‖ left ‖ right)`，按"小于 n 的最大 2 的幂"切分；
  0x00/0x01 前缀用于抵抗第二原像攻击。RFC 9162 取代 RFC 6962（[RFC 9162](https://www.rfc-editor.org/rfc/rfc9162.html)）。
- **包含证明（§2.1.3）**：从叶到根的兄弟节点列表，O(log n)。**一致性证明（§2.1.4）**：证明旧树是新树的前缀（只追加没改历史），
  长度 ≤ ⌈log2 n⌉+1（同上）。
- **树头**：`TreeHeadDataV2` 含时间戳、树大小、根哈希；`SignedTreeHeadDataV2` 加日志 ID 与签名（§4.9–4.10，同上）。
- **C2SP checkpoint**：signed note，正文三行——origin、树大小（十进制）、根哈希（标准 base64）；随后空行与签名行；
  日志 / cosigner **绝不能签两个互不一致的 checkpoint**；推荐 ML-DSA-44 cosignature，亦有 Ed25519 log signature
  （[tlog-checkpoint](https://github.com/C2SP/C2SP/blob/2bc1f467fc41d1f6605d73bd217a481ede0565e0/tlog-checkpoint.md)）。
- **tlog-tiles**：把树切成高度 8（256 个哈希 / 8 KiB）的静态瓦片，`/checkpoint`、`/tile/<L>/<N>`、`/tile/entries/<N>`；
  瓦片不可变可长缓存，checkpoint 只缓存几秒；客户端自己从瓦片算证明，读扩展靠 CDN；还允许"剪枝"——低于某索引的资源可拒绝提供，
  **索引和哈希不变**（[tlog-tiles](https://github.com/C2SP/C2SP/blob/2bc1f467fc41d1f6605d73bd217a481ede0565e0/tlog-tiles.md)）。
  这条"剪枝不改哈希"与 saveslot 的"删内容留哈希"是同构的。

### 实现与状态

| 项目 | 状态 | 许可 | 形态 |
|---|---|---|---|
| Trillian | **维护模式**，不再加新功能，建议新日志用 Tessera；gRPC 服务 + Signer + MySQL/MariaDB（[README @edf1faf](https://github.com/google/trillian/blob/edf1faff855dc603704d75beb3cdbce9f1152049/README.md)） | Apache-2.0 | 独立服务 |
| Tessera | Go **库**，"无需额外服务"；Beta(v0.2.0) 起称生产可用，最新 v1.0.4；后端 GCP / AWS / POSIX；支持 C2SP witness 协议（[README @686ef94](https://github.com/transparency-dev/tessera/blob/686ef945175a7af46a9730d1d8f201caf55ff3d4/README.md)） | Apache-2.0 | 进程内库 |
| Rekor v1 | 基于 Trillian；v2 将改用 tile 日志 + Tessera（[README @dcf9785](https://github.com/sigstore/rekor/blob/dcf9785018dfce522e6a56196bc04b044bce7a02/README.md)） | Apache-2.0 | 服务 |
| Rekor v2 (rekor-tiles) | 社区实例有 99.5% SLO，约每 6 个月轮换分片；最新 v2.4.1（2026-10-30）（[README @da9f212](https://github.com/sigstore/rekor-tiles/blob/da9f2122061bbc12bff93132b8310996bb3ce378/README.md)） | Apache-2.0 | 服务 |
| transparency-dev/merkle | RFC 6962 证明的 Go 参考实现（[repo](https://github.com/transparency-dev/merkle)） | Apache-2.0 | 库 |

**性能边界**：Tessera 各后端"都已测试满足 CT 规模写入"；POSIX 后端约 2,900 写/秒（无 antispam），
e2-micro 免费 VM 上 > 1,500 写/秒（[docs/performance.md @686ef94](https://github.com/transparency-dev/tessera/blob/686ef945175a7af46a9730d1d8f201caf55ff3d4/docs/performance.md)）。
saveslot 单租户的写入量比这低几个数量级，瓶颈不在哈希。

### 对 saveslot

- **不直接用 Tessera**：它是 Go，存储后端是对象存储 / POSIX，不进 PG 事务，也不支持删除条目内容（它的模型是"条目永久公开"）。
  saveslot 需要"写 change_log 与写日志在同一 PG 事务里原子提交"，外挂一个 Go 日志会引入两阶段问题。
- **照搬算法与格式**：RFC 6962 树哈希、包含 / 一致性证明、C2SP checkpoint 文本格式。用 TS 实现几百行即可，
  并可拿 transparency-dev/merkle 的测试向量做交叉验证。将来托管版想对外发布，可直接按 tlog-tiles 输出静态瓦片，
  第三方 witness 也有现成协议。

---

## 3. 托管账本：Amazon QLDB、Azure SQL ledger、PostgreSQL 原生方案

### Amazon QLDB（已停服）

- **设计**：事务先作为 block 追加到 journal 再物化到用户表（[Matt Lewis, AWS Hero](https://dev.to/aws-heroes/redacting-data-in-amazon-qldb-1o06)）；
  journal 块 SHA-256 链 + digest + Merkle 证明（AWS 官方开发者指南页面已下线，此细节**未核实**于一手原文）。
- **删除（redaction）**：`REDACT_REVISION` 只能作用于**非当前**版本；被删版本的 `data` 换成 `dataHash`（Ion hash），
  journal 顺序与元数据不变，所以验证 API 仍可用；异步执行、不可撤销；**对已导出到 S3、已流到 Kinesis 的副本无效**
  （[AWS 文档 REDACT_REVISION](https://docs.aws.amazon.com/zh_tw/qldb/latest/developerguide/ql-stored-procedures.redact_revision.html)、
  [Matt Lewis](https://dev.to/aws-heroes/redacting-data-in-amazon-qldb-1o06)）。
- **停服**：2024-07 停止新客户，2025-07-31 终止支持；**没有正式公告**，靠改文档 + 邮件；AWS 推荐迁到 Aurora PostgreSQL +
  pgAudit + S3，社区指出 Aurora 不提供可验证的不可变历史（[InfoQ](https://www.infoq.com/news/2024/07/aws-kill-qldb)）。
- **教训（对 saveslot）**：
  1. 托管专有账本有平台风险；**可验证性要放在开放格式里**（任何人能用公开算法离线验证），而不是某个服务的 API。
  2. QLDB 的 `dataHash` 正是"删内容留哈希"，但 **Ion hash 是明文内容的确定性哈希**，同样有字典确认风险。
  3. redaction 管不到下游副本——saveslot 必须把墓碑作为**一等事件同步**，而不是只在主库生效。

### Azure SQL / SQL Server ledger

- **设计**：事务内被改的行用 SHA-256 Merkle 树汇成根；多事务再汇成块；块哈希 = H(本块根, 上一块哈希)，形成链；
  最新块哈希即 database digest，可自动存到不可变 Blob 或 Azure Confidential Ledger；`sp_verify_database_ledger` 用 digest 重算校验。
  分"可更新 ledger 表"（带历史表）和"只追加 ledger 表"（[Ledger overview](https://learn.microsoft.com/en-us/sql/relational-databases/security/ledger/ledger-overview)）。
- **删除**：**不支持删除只追加表或历史表里的旧数据；不支持 TRUNCATE**；DROP 列 / 表只是改名隐藏，数据物理保留以供验证；
  计算行哈希时忽略 NULL，以便加可空列不影响旧哈希（[Ledger limitations](https://learn.microsoft.com/en-us/sql/relational-databases/security/ledger/ledger-limits)）。
- **对 saveslot**：与 saveslot 的被遗忘权要求直接冲突，只能借"行→事务→块"三级 Merkle 与"digest 外存"的思路。
  "NULL 不参与哈希以兼容加列"这个细节值得借：saveslot 的 schema 是动态的，**行哈希的规范化编码要对加字段稳定**。

### PostgreSQL 原生

- **pgAudit**：走 PG 标准日志，**尽力而为、非事务性**；崩溃 / 日志盘满可能丢；回滚的语句也会被记；
  **超级用户活动无法可靠审计**；没有任何哈希 / 签名（[pgaudit README @2a73220](https://github.com/pgaudit/pgaudit/blob/2a7322004a90ebb8cf51d929e3dcf79e791b557e/README.md)）。
  PostgreSQL 许可（[LICENSE](https://github.com/pgaudit/pgaudit/blob/2a7322004a90ebb8cf51d929e3dcf79e791b557e/LICENSE)）。→ 合规审计用，不是防篡改证据。
- **触发器哈希链**：常见做法是 BEFORE INSERT 触发器用 pgcrypto 算 `sha256(row ‖ prev_hash)`，用 `pg_advisory_xact_lock` 串行化，
  另写校验函数，如 auditrum（[PyPI](https://pypi.org/project/auditrum/0.5.1/)，**未读源码，未核实**）。
  局限：超级用户可禁用触发器、可整链重算——**没有外部锚点的哈希链只能发现"改了一半"，挡不住"全部重算"**。
- **pg_credereum**（Postgres Pro）：Merklix 树覆盖所有行、客户端签名转换、后台打包块、可把块哈希发布到外部可信存储；
  **README 自称非生产可用**，目标 PG 10，GPL-3.0（[repo](https://github.com/postgrespro/pg_credereum)）。
- **PGlite 有 pgcrypto**（主包内置，[PGlite extensions](https://pglite.dev/extensions/)），所以 SQL 侧算 SHA-256 / HMAC 在本地版可用；
  但 saveslot 要同时支持 SQLite 时，**哈希计算应放应用层**（TS，WebCrypto / node:crypto），不要依赖数据库函数。

---

## 4. 只追加 / 事件溯源系统里的删除

### 加密粉碎（crypto-shredding）

- 模式：敏感属性用每个主体（如每个客户）的独立密钥加密；删除 = 删该密钥，事件库本身不改，副本和备份里的密文同时作废；
  作者提醒：投影 / 消费者如果存了解密后的数据或派生出新的敏感值，模式就失效；并提出"删钥是否等于删数据"的法律疑问
  （[Verraes, Eventsourcing Patterns: Crypto-Shredding](https://verraes.net/2019/05/eventsourcing-patterns-throw-away-the-key/)）。
- 替代：**Forgettable Payload**——事件里只放引用，内容放在可删除的外部存储（同上）。**saveslot 应当两者结合**：内容放可删的 blob 表（主库物理删），
  同时加密（删不到的副本靠删钥）。

### EventStoreDB / KurrentDB

- **软删除**：内部把 `$tb`(TruncateBefore) 设为 Int64 最大值，读返回 404，可继续追加；**硬删除**：追加 `$streamDeleted` 墓碑，
  流永久关闭（410），scavenge 后事件移除、**墓碑保留**；删除后仍**保留一个事件**以记录流存在过与最后版本；
  处理敏感数据建议追加 `StreamDeleted` 并设 `MaxCount=1`（[Kurrent streams 文档](https://docs.kurrent.io/server/v25.0/features/streams.html)）。
- **scavenge**：删除 / 过期事件读流时立刻隐藏，但**在 `$all` 读里仍可见**，直到 scavenge 重写 chunk 才物理移除；
  **每个节点要各自 scavenge**；阈值 > 0 时可能跳过删除事件少的 chunk，文档明确提示这对 GDPR 有影响；scavenge 后只能从备份恢复
  （[Kurrent scavenge 文档](https://docs.kurrent.io/server/v25.0/operations/scavenge.html)）。
- **对 saveslot**：①"逻辑隐藏"和"物理移除"之间有时间窗，删除回执要区分这两个状态；②每个副本都要执行物理清理；
  ③墓碑永久保留、阻止同名复用——对应 saveslot 的"墓碑阻止复活"。

### Kafka 日志压缩

- key + null value 即墓碑；压缩保留每个 key 的最后值；**墓碑本身在 `delete.retention.ms`（默认 24h）后也会被清掉**，
  滞后超过这个时间的消费者会**错过删除标记**；offset 不变、顺序不变（[Kafka 4.2 design · Log Compaction](https://kafka.apache.org/42/design/design/)）。
- **对 saveslot 的直接教训**：如果墓碑会过期，离线超过窗口的副本回来就会把旧数据写回——**saveslot 的墓碑必须永不过期**，
  并且是哈希链上的普通事件（data-model.md 已是这个方向，这里给出反例佐证）。

### GDPR：加密粉碎算不算删除

- **EDPB Guidelines 02/2025 v2.0（2026-07-07 定稿）**，[PDF](https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_202502_blockchain_v2_en.pdf)：
  - ¶51：加密后删除解密密钥，数据"不可读，至少在算法被攻破、解密技术进步、或密钥早已泄漏之前"；
    **"加密的个人数据仍是个人数据"**；若长期保留，"再完美的加密也会被时间超越"。
  - ¶52：只在链上存**加盐或带密钥的哈希**，原数据与密钥 / 长随机盐存在链外；**哈希本身也算个人数据**；
    密钥或盐删除后，哈希"不应再能关联到原数据"（前提是算法未破、密钥 / 盐未泄漏、盐选得够好）；
    **无盐 / 无密钥哈希一般不应被视为足够**。
  - ¶53：完美隐藏的承诺（commitment），删掉原数据与 witness 后"既无法恢复也无法识别"原数据。
  - ¶103–104：被遗忘权必须"by design"满足；链上数据应能在收到删除请求时被有效匿名化；明文、密文、哈希都**不建议**直接放链上，应放链外。
  - ¶63：若需删除部分链，"包括节点或其他方持有的副本"，控制者要有足够的技术与组织措施。
- **ICO（英国）**：备份里无法立即覆盖的数据应"置于不可用（beyond use）"状态（[ICO right to erasure](https://ico.org.uk/for-organisations/guide-to-dp/guide-to-the-uk-gdpr/individual-rights/right-to-erasure)；
  页面 403 未能直接读取，内容来自搜索摘要，**未核实原文**）。
- **对 saveslot 的解读**：saveslot 不是公链，链外存储完全可控，属于 EDPB 推荐的"链上只放证明、数据放链外"的形态。
  稳妥口径是：**主存储物理删除 + 删钥兜底备份 / 离线副本 + 链上只留不可关联的承诺**。单靠删钥、密文永久留在主库，
  在 EDPB 口径下站不住。

### 密钥管理选项

- **信封加密**：数据用数据密钥（DEK）加密，DEK 再用上层密钥加密，最顶层根密钥留在 KMS/HSM 内；
  加密后的 DEK 可与密文放在一起；AWS KMS 内部用 AES-256-GCM（[AWS KMS cryptography essentials](https://docs.aws.amazon.com/kms/latest/developerguide/kms-cryptography.html)）。
- **KMS 删钥**：必须设 7–30 天等待期（默认 30 天），等待期内不可用、可取消；删除后用它加密的数据不可恢复；
  删 CloudHSM 后端的 KMS 密钥**不删 HSM 集群备份里的密钥材料**（[AWS KMS deleting keys](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html)）。
  → 托管版若"每租户一把 KMS 密钥"，删租户的 SLA 至少要覆盖这个等待期。
- **本地 OS 钥匙串**：Node 侧可用 `@napi-rs/keyring`（Rust keyring-rs 的绑定，MIT）（[socket.dev](https://socket.dev/npm/package/@napi-rs/keyring/overview/1.3.0)）；
  keytar 被部分项目称为已弃用（[apify/mcpc PR #7](https://github.com/apify/mcpc/pull/7)，**单方说法，未核实**）。

---

## 5. 哈希链如何与删除共存

| 方案 | 删除后链能否校验 | 删除后是否泄漏 | 评价 |
|---|---|---|---|
| 链上承诺**明文**裸哈希 `H(pt)`（immudb `hVal`、QLDB Ion hash） | 能 | **会**：可枚举候选内容（"5 公里"、手机号、病名）确认 | EDPB ¶52 明说不够；saveslot 的内容多是短文本、低熵字段，**不可用** |
| 承诺**密文**哈希 `H(ct)` | 能（任何持有密文的人可校验，无需密钥） | 不会（密文随机，删钥后无信息） | **推荐主方案**。需注意 AEAD 非"密钥承诺"问题（见下） |
| 带密钥承诺 `HMAC(k_item, pt)`，k 随 DEK 一起删 | 删前可校验明文；删后只剩随机值 | 不会（¶52 条件满足） | **推荐作为补充**：让持钥方能证明"解出的明文就是当初承诺的那个" |
| 全局胡椒 `H(pepper ‖ pt)` | 能 | 胡椒泄漏即全部可字典攻击；胡椒无法按条删除 | 不推荐 |
| 变色龙哈希 / 可编辑区块链 | 能（找到碰撞替换内容） | 取决于实现 | 见下，**不实用** |

- **AEAD 的坑**：AES-GCM 等不是"密钥承诺"的——理论上可构造一份密文在两把不同密钥下解出不同明文
  （"invisible salamanders" 类攻击，**本次未查一手论文，未核实具体出处**）。所以只承诺 `H(ct)` 时，恶意服务端可在不改链的前提下
  换一把 DEK 让用户解出别的内容。缓解：加 `HMAC(DEK派生的承诺键, pt)` 或用带密钥承诺的 AEAD 构造。
- **变色龙哈希**：Ateniese 等（IEEE EuroS&P 2017）用 Krawczyk–Rabin 变色龙哈希，持有陷门者可高效找碰撞以改写区块，
  陷门可由单一可信方持有或在互不信任方之间分布（[ePrint 2016/757](https://eprint.iacr.org/2016/757)）；
  后续文献指出依赖可信陷门持有者，更适合有治理的许可链（[CEUR-WS Vol-3791](https://ceur-ws.org/Vol-3791/paper9.pdf)，未细读）。
  **对 saveslot**：陷门持有者 = 运营方，等于"运营方可以无痕改历史"，恰好抵消防篡改的意义；且需要非标准密码学库、无成熟实现。
  saveslot 的需求只是"删内容留指纹"，**承诺密文 + 删钥 + 物理删除已足够，不需要变色龙哈希**。

---

## 6. 给 saveslot 的建议

### 6.1 哈希链构造

**结构：每租户（workspace）一条全局只追加日志，叶子组成 RFC 6962 Merkle 树；每个事件同时带 `prev_hash`。**

- 不按用户 / 按 thread 各开一条链：thread 是索引，不是链。一条链的好处是全局顺序唯一、一次 checkpoint 覆盖全部、
  副本同步只需比对一个 (size, root)。本地单用户 = 一个租户。
- `prev_hash` 给最便宜的线性校验（离线逐条重放）；Merkle 树给 O(log n) 的包含证明（"这次任务读的版本确实在日志里"）
  和一致性证明（"服务器 / 副本没有改写我上次见过的历史"）。两者同 immudb 的 Alh + AHT 双结构。

**叶子 = 事件头的规范化编码，不含任何内容明文：**

```
event_header = canonical_encode({         // 确定性编码：RFC 8785 JCS 或 deterministic CBOR，二选一并写死
  v: 1, seq, ts, tenant_id,
  kind: source_append | change | read | tombstone | key_event | schema_change,
  actor, task_ref,                         // 尽量用不透明 ID，见 6.6 元数据泄漏
  thread_id?, table?, row_id?, version?,
  content_refs: [{                         // 0..n 个内容承诺，像 git 的 blob 引用
     ct_hash:  SHA-256(envelope_ciphertext),       // 公共可校验
     pt_commit: HMAC-SHA256(K_commit(item), pt),   // 可选；K_commit 由 item DEK 经 HKDF 派生，随 DEK 销毁
     key_id                                        // 指向哪把 item DEK（不是密钥本身）
  }],
  source_links: [leaf_index…],             // 血缘指向更早的叶子，而不是内容
  prev_hash
})
leaf_hash = SHA-256(0x00 ‖ event_header)  // RFC 6962
```

- **change_log 的 before/after 整行也是"内容"**，同样加密后进 blob 表、链上只放 `ct_hash`。否则删除时历史版本里的明文
  无法清除（data-model.md「历史版本一并处理」）。
- **read_log** 维持现设计（只存版本 ID + 哈希），叶子里只放被读版本的 `leaf_index`。
- **墓碑事件**：`kind: tombstone`，列出被删的 `leaf_index` / `key_id`、原因码（如 `erasure_request`）、请求 ID；**不含任何描述被删内容的文字**。
- **规范化编码对加字段稳定**（借 Azure ledger "NULL 不参与哈希"的思路）：缺省字段不编码，新增字段不改变旧事件的字节。
- 哈希计算放应用层（TS），PG / PGlite / SQLite 三端一致；写入时每租户单写者串行化
  （PG：`pg_advisory_xact_lock(tenant)`；SQLite：`BEGIN IMMEDIATE`），叶子写入与业务写入**同一事务提交**。
- 内部节点按 tlog-tiles 的 256 宽瓦片存一张表即可，证明生成不需要读全部叶子。

**Checkpoint 与锚定：**

- 每 N 个事件或 T 秒（如 1000 条 / 60 秒，取先到者）生成一个 C2SP 格式 checkpoint（origin = `saveslot/<tenant_id>`，size，root），
  用租户签名密钥（Ed25519）签名，写入 checkpoints 表。
- **本地版**：签名私钥在 OS 钥匙串；锚定方式按成本递增：①客户端（MCP host / CLI）每次会话缓存最新 checkpoint，
  下次要求一致性证明（TOFU，类似 immudb 客户端状态）；②导出到用户另一个位置（另一台设备、git 仓库、iCloud 文件）；
  ③可选发布到公共 witness / 透明日志。
- **托管版**：签名用 KMS 非对称签名；checkpoint 对租户公开（API + 可选 tlog-tiles 静态端点）；
  **每个租户的客户端必须缓存并校验一致性**，否则运营方可以对不同客户展示不同历史（split-view）；中期接入 C2SP witness cosignature。
- 首版最低可行：①+ 本地签名；witness 留到托管版。

### 6.2 加密粒度与密钥层级

```
Root KEK      本地：OS 钥匙串里的随机 256-bit 密钥（无钥匙串时：口令 → Argon2id）
              托管：每租户一个 KMS key，或每租户 KEK 由全局 KMS key 包裹
  └─ Thread KEK   每个 thread 一把，随机生成，被 Root KEK 包裹，存 keys 表
       └─ Item DEK   每条源数据 / 每个 change_log 内容 blob 一把，随机生成，被 Thread KEK 包裹
            ├─ 加密：XChaCha20-Poly1305 或 AES-256-GCM，AAD = tenant_id ‖ leaf seq ‖ key_id
            └─ K_commit = HKDF(DEK, "saveslot/commit/v1")  → pt_commit
```

- **删一条 = 删 Item DEK；删整个 thread = 删 Thread KEK**（其下所有 Item DEK 的包裹副本随之失效）；删租户 = 删 Root KEK / KMS key。
  不要用"从 thread 密钥 HKDF 派生 item 密钥"，否则无法单条删除。
- **派生数据（有模型的表）**：带个人数据的列用其**主来源 thread 的 Thread KEK** 下的 DEK 加密；多来源值按 data-model.md
  的级联规则在删除时**重算**，而不是指望删钥。embedding / 全文索引属于派生数据，删除时必须重建或删除对应条目。
- **签名密钥与加密密钥分开**；签名密钥不参与任何删除。

### 6.3 删除流程（端到端）

1. **受理**：校验权限，记录删除请求（只记请求 ID、主体 / thread ID、原因码），计算级联集合（按血缘拓扑序，见 data-model.md）。
2. **同一事务内**：写 `tombstone` 事件进链；删除对应 Item DEK / Thread KEK 的包裹副本；删除 blob 表里的密文；
   按级联规则删除或重算派生行；将受影响的 read_log 视图标为"读的是已删除版本"（无需新增描述内容的记录）。
3. **事务后（异步，可重试，有截止时间）**：清内存密钥缓存；删除 / 重建 embedding、全文索引、派生缓存；
   PG 执行 `VACUUM`（必要时针对表），SQLite 开 `secure_delete` 并 checkpoint WAL（**这两项的具体残留行为本次未查一手文档，未核实**）。
4. **副本**：墓碑随日志同步；副本**先应用墓碑再接受任何内容**；同步协议拒绝 `ct_hash` 或 `key_id` 在墓碑集合内的写入（防复活）；
   离线副本上线时先做一致性证明，再拉墓碑，再推本地增量。墓碑**永不过期**（Kafka 反例）。
5. **备份**：
   - 数据备份（含 PITR / WAL 归档）里有密文，靠删钥失效——**前提是 keys 表不能和数据一起被长期备份**。
     keys 表单独备份、保留期 ≤ 删除 SLA（如 30 天），或按纪元轮换 Root KEK、旧纪元在备份保留期满后销毁。
   - 恢复备份时：先从当前日志 / 独立保存的墓碑清单**重放墓碑**，再对外服务。
   - 派生表若存了未加密的个人数据，备份里会有明文——这正是 6.2 要求派生列也加密的原因；做不到的部分按 ICO "beyond use" 口径对用户如实说明保留期。
6. **回执**：返回删除回执 = 包含墓碑的 checkpoint + 墓碑叶子的包含证明 + 状态（`logical`→`physical`→`backups_expired_at`），
   不宣称"已从所有备份删除"，而是给出备份失效日期。

### 6.4 验证 UX

- MCP 工具 / CLI `verify`：返回 `{size, root, signature_ok, consistent_with_last_seen, tombstoned_leaves: N}`，
  人话一句："日志共 12,345 条事件，签名有效，与您上次看到的历史一致；其中 37 条内容已按删除请求移除，指纹仍在链上。"
- `prove(version_id)`：给出某个版本的包含证明，供审计 / 争议时离线核对。
- read_log 查询结果里，读过被删版本的任务显示"读的是已删除版本"（data-model.md 已定）。
- 校验失败要定位到第一条不一致的叶子，并区分"内容 blob 与 ct_hash 不符"（数据损坏 / 篡改）与"树根与 checkpoint 不符"（历史被改写）。

### 6.5 现成组件取舍

| 组件 | 直接用？ | 理由 |
|---|---|---|
| immudb | 否 | BSL 1.1；独立数据库；无定点物理删除 |
| Tessera / Trillian | 否（托管版发布层可再评估） | Go、对象存储、不进 PG 事务、无内容删除 |
| QLDB / Azure ledger | 否 | 停服 / 绑定 SQL Server 且禁止删除历史 |
| pgAudit | 只作运维审计 | 非事务、无完整性保证 |
| pg_credereum | 否 | 自称非生产可用、GPL-3.0、PG 10 |
| RFC 6962 + C2SP checkpoint | **采用格式与算法** | 公开标准、Apache 生态有测试向量 |
| pgcrypto（PGlite 内置） | 可选 | 但为三端一致，哈希放应用层 |
| `@napi-rs/keyring` | 本地版候选 | MIT，跨平台钥匙串（Windows 支持未核实） |

### 6.6 开放风险

1. **法律口径**：EDPB 认为密文与哈希仍是个人数据，删钥只是"在算法被攻破前"不可读；saveslot 的承诺必须满足 ¶52 的条件
   （带密钥、密钥可删），并配合物理删除。具体是否构成 Art.17 意义上的删除，需法务确认。
2. **明文泄漏面**：写入请求里的 `evidence.excerpt`、应用日志、错误上报、LLM 调用缓存、embedding、全文索引、PG WAL / PITR、
   SQLite WAL / 空闲页。每一个都要进删除清单，否则链设计再好也删不干净。
3. **元数据泄漏**：墓碑和事件头里的 thread_id、表名、字段名、时间戳本身可能透露信息（如 thread 名叫"体检-HIV"）。
   事件头只用不透明 ID，可读名称放加密内容里。
4. **密钥丢失 = 数据丢失**：本地钥匙串丢了，全部内容不可读。需要用户可控的恢复密钥（如打印的恢复短语），
   但恢复密钥的存在又与删钥冲突——恢复密钥只能包裹 Root KEK，不能包裹被删的 Thread KEK（被删的包裹副本已不存在）。
5. **keys 表进了长期备份**会让加密粉碎失效（见 6.3-5）；托管版要把 keys 表的备份策略单独设计和审计。
6. **托管运营方可信度**：运营方持有 KMS 权限，理论上可以在删除前复制密钥；只能靠审计日志（KMS CloudTrail）与 split-view 防护缓解，
   无法在密码学上消除。
7. **AEAD 非密钥承诺**：只承诺 `H(ct)` 时存在换钥换明文的可能，需要 `pt_commit` 或承诺型 AEAD。
8. **单写者吞吐**：每租户串行化写入；按 saveslot 的场景预计不是瓶颈，但托管大租户需要实测。
9. **签名密钥泄漏**：可伪造 checkpoint；需要密钥轮换事件（`key_event` 上链）与 witness 交叉签名来限制损失。
10. **长期密码学**：对称 AES-256 / ChaCha20 与 SHA-256 预计长期可用；签名可按 C2SP 推荐迁到 ML-DSA-44（tlog-checkpoint 已给出该类型）。

---

## 附：本次核对用到的源码 / 仓库快照

- codenotary/immudb @ `bfdce03649f52d575be46f74425fd18eaf4fa69c`（BSL 1.1，v1.11.2）
- transparency-dev/tessera @ `686ef945175a7af46a9730d1d8f201caf55ff3d4`（Apache-2.0，v1.0.4）
- google/trillian @ `edf1faff855dc603704d75beb3cdbce9f1152049`（Apache-2.0，维护模式）
- sigstore/rekor @ `dcf9785018dfce522e6a56196bc04b044bce7a02`；sigstore/rekor-tiles @ `da9f2122061bbc12bff93132b8310996bb3ce378`
- pgaudit/pgaudit @ `2a7322004a90ebb8cf51d929e3dcf79e791b557e`（PostgreSQL License）
- C2SP/C2SP @ `2bc1f467fc41d1f6605d73bd217a481ede0565e0`
