# 决定：移除空 slot，加事件类型 `slot.removed`

> 2026-11-19 决定。给事件格式 v1 的事件类型封闭列表加一种类型；事件格式与存储格式的版本号都不变。

## 1. 改了什么

1. **新操作 `slots.remove`**：移除一个空的 slot。只给用户会话，MCP 不提供。**只按 `slot_id` 移除，不收名字**：名字可以重用（第 4 节），按名字的移除一旦被重发、或被脚本发了两次，就会删掉后来同名新建的那个 slot。HTTP 是 `DELETE /v1/slots/{slot}`，这里只收 `sl_…`，给的是名字时报 `invalid_argument` 并指路；CLI 是 `saveslot slot remove <名字>`，先把名字解析成 `slot_id`，在确认屏上显示它，再按 `slot_id` 发。不收 `Idempotency-Key`：同一个 `slot_id` 再移除一次，返回第一次的结果。
2. **新事件类型 `slot.removed`**：头事件，actor 是用户，带 `slot`；`target` 是 `{slot_id, name, sv}`（移除时的名字与当前版本）。
3. **"空"的判法**（第 3 节）：在同一个写事务里按日志判、落账。不空的拒绝，错误是 `invalid_argument`、reason `slot_not_empty`、param `slot`，说明里写明有记录的 slot 的删除留到以后的版本；只因结构变更事项未结而拒绝时，`details` 给出这个原因与事项 ID。
4. **apply**：删 `slots` 行、这个 slot 的 `catalog` 与 `counts` 行，DROP 它的物理表（基础表、`__ver` 表与索引、派生表）。DROP 不影响别的 slot：派生规则与 `ref` 字段都不跨 slot（[`../../spec/03-data-model/11-restricted-sql.md`](../../spec/03-data-model/11-restricted-sql.md)，指向别的 slot 报 `cross_slot_ref`），别的 slot 的表与规则不依赖这些表。保留 `schema_versions`、建它那次操作的请求键（第 4 节）、读取记录（`read_log`、`read_log_rows`、`last_read`）与 `principals`。
5. **有记录的 slot 整个删除不在这里**：仍按 positioning 里规划的 `deletion_preview` → `delete` 那条路，留到以后。

## 2. 为什么

- **每个用户 slot 有上限（100 个），但没有办法腾出名额。** 试建、建错名字、建了没用的 slot 永远占着一个位置。
- **只做"空的"，是因为空 slot 的移除不碰任何记录。** 没有源数据、没有表数据、没有事项，就没有"删掉的东西还被谁引用"的问题，也不用定数据删除的规则（那是 deletion 要解决的）。
- **为什么是一个事件，而不是直接改表。** 存储里的行都要能从日志重建（09 §5.12）；不记事件，重建会把 slot 原样建回来。

## 3. 什么算"有数据"

按带 `slot` 的事件类型逐个列。列表之外、以后新加的事件类型，**默认算有数据**：判不清时偏向不让移除。实现上写成"不算有数据的类型"白名单，新类型自然落到"有数据"一侧。

| 事件类型 | 算有数据吗 | 说明 |
|---|---|---|
| `slot.policy_set` | 不算 | 策略，不是记录 |
| `schema.draft_submitted` / `compiled` / `confirmed` / `rejected` / `superseded` | 不算 | 结构的提议与确认 |
| `schema.migration_started` / `switched` / `migration_failed` | 不算 | 切版本本身不是记录；带回填（`backfill`）的只在表里有行时出现，那时已经有 `write.base` |
| `source.recorded` | 算 | 源数据 |
| `write.head` / `write.base` / `write.derived` | 算 | 表数据；一次写入里的操作全被拒或全是 noop，也算（不去区分） |
| `item.created` / `merged` / `refreshed` / `superseded` / `resolved`，事项类型是 `schema_change` | 不算，但**事项未结时不让移除** | 结构变更的待确认事项不是记录；还开着时移除会留下一个指向不存在 slot 的事项，拒绝，reason 同为 `slot_not_empty`，`details` 给出原因（有未结的结构变更事项）与事项 ID，调用方知道先去处理哪个 |
| `item.*`，其他事项类型（冲突、待确认写入、标记） | 算 | 只由写入产生 |
| `deletion.confirmed` / `cancelled` / `executed` | 算 | 只在有记录时出现；执行过的删除也留着痕迹，不当作空 |
| `premise.changed` | 算 | 只由写入产生 |
| 以后新加的类型 | 算 | 默认 |

不带 `slot` 的事件与这里无关：

- **凭证相关**（`principal.registered` / `renamed` / `revoked`）不带 `slot`，不影响判空。连接的范围列着这个 slot 不阻止移除（第 5 节）。
- **读取记录不是事件**：它落在本机表 `read_log` / `read_log_rows` / `last_read` 里，不进日志，不影响判空；移除后保留（第 5 节）。

## 4. 为什么保留 `schema_versions`；名字与 ID 能不能重用

- **表号不复用。** 新建 slot 时表号按 `schema_versions` 里已有的最大号往后排；删掉它们，后建的表会拿到日志里已经用过的表号，按表号建的索引列与重建都会把两张表混在一起。
- **`slot_id` 不重用。** `slot_id` 是随机的；新建时与 `schema_versions` 里出现过的查重，碰上就重取。日志里这个 slot 的事件永远指向它，不会指到后来的 slot。
- **名字可以重用。** 名字只在现存的 slot 之间唯一。用同一个名字新建的 slot 是另一个 slot（另一个 `slot_id`）：旧的连接范围、读取记录不会指到它。也因此移除只认 `slot_id`（第 1 节）。
- **建它那次操作的请求键保留。** K13（[`../../spec/02-architecture.md`](../../spec/02-architecture.md)）：窗口内重发返回原结果。移除之后再重发那次 `schema_draft`，得到的是原回执（一个已不存在的 slot），不会再建出一个；删掉这个键，迟到的重发就会把一个没人要的 slot 再建出来。

## 5. 为什么不改 `principals`，以及别处留着的引用

- **apply 不改 `principals`。** `principals` 只由 `principal.*` 事件决定；让 `slot.removed` 改它，重建时一张表就由两类事件共同决定。连接范围里留着已移除的 `slot_id`，读和鉴权时滤掉。
- **"范围为空"与"不限 slot"是两种表示，滤掉之后不会混。** `principals.slots` 为 NULL 是不限 slot；是数组（哪怕为空）就是限定在这些 slot。范围只剩这一个 slot 的连接，移除后看到的是空数组：什么都看不到、写入被拒；用同一个名字新建的 slot 它也看不到（ID 不同）。
- **读取记录保留。** 列读取记录时，查不到名字的显示原始 `slot_id`；按名字过滤一个已移除的 slot，给 `not_found`。

## 6. 旧版本读到它会怎样

和别的新类型一样：旧版本的严格解析不认这个类型，报 `unsupported`，apply 停在这个事件上，不跳过。事件格式 v1 的正式冻结点在第一次对外发布本机模式之前，在那之前加类型不升版本号。要紧的情形是较旧的程序读到已经含有 `slot.removed` 的日志：它停在这个事件上，不会跳过它、把已移除的 slot 当作还在。

## 7. 落在哪里

- 规格：09（§5.4 旁加 `slot.removed`、§5.11、§5.12、§6.1）、04-contract（§17 管理操作；删去"整个 slot 删除第一版不做"）、04-contract-types（`slots.remove` 的参数与结果、`slot_not_empty`）、05-surfaces（HTTP 端点、已知限制）、06-cli（`slot remove`、满额时的指路句）、03-data-model/01-objects（名字与 ID 的重用）、03-data-model/07-schema-evolution（与表级 `never_written` 并排写清"空"的口径）、01-positioning、07-scope-v1。
- 实现：`contract-core` 的事件类型、头规则与形状检查；`kernel` 的操作、判空、apply 与读时过滤；`service` / `server` 的路由与只给用户会话；`cli` 的命令与确认屏。
