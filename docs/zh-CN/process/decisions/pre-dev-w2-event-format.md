# 开发前工作包 W2 · 事件格式 v1：写格式时新增的决定（2026-11-11）

> 事件格式本身见 [`../../09-event-format.md`](../../spec/09-event-format.md)。本文只记写格式时新增的决定与架构负责人的复核结论。
> 相关决定稿：[`pre-dev-w1-rules.md`](pre-dev-w1-rules.md)、[`pre-dev-w4-architecture.md`](pre-dev-w4-architecture.md)。

## 新增的决定

写事件格式时必须定、而规则文档与决定稿没有写明的选择。原在 `09-event-format.md` 文末，复核后移到这里。

| # | 决定 | 理由 |
|---|---|---|
| N1 | **事件头只留 11 个通用字段**；表、行或实体、意图、派生分区、规则版本、被引用事件的 `seq`、删除 ID 与到期时刻、两个判定版本号全部移进元数据块 `target` / `ctx` | 按"事件头尽量少留"。元数据块不进链，法务结论不利时可以把整行删除的 `target` 块也列进位置列表而不动事件头（§9.2）。现行规格与 W4 汇总把其中几项写在事件头里；W1 决定 17 说两个版本号"可以放事件头"，这里没有放 |
| N2 | 内容块分**元数据块**与**数据块**两种，前者没有来源、第一版不删除 | 让"哪些块在级联范围内"在词表里一眼可见；也是 N1 的落点 |
| N3 | 头事件用"没有 `op` 字段"表示，成员事件带 `op`；同一次操作的事件 `at` 相同 | 操作号要能从事件头直接得出（按记录位置读时整体可见）；缺省字段不编码 |
| N4 | **解析结果记在 `write.base` 的 `fields/<字段ID>` 块里，`write.head` 只记原始传参** | W1 决定 1 说"写入头记字段 → 区间"。解析后的区间是这次贡献的一部分，和值放在同一块里才能一起删、一起被 `carried` 引用；头事件里再记一份是重复 |
| N5 | **`write.base` 不记写入前的值，也不记写入后的整行**，只记本次请求涉及的字段 | 写入前的值是更早事件的副本，每多一份副本，隐私删除就多一处要清；按时刻读走版本表（存值）。状态类表由"区间赋值 + 规范化分段"得出物理段，这一步是确定的，不属于"重跑拆行算法"里要避免的判定（终点解析的结果已经记下） |
| N6 | 状态类表**一个 op 对一个实体记一条** `write.base`，不按段记 | 段是物理实现；删除、冲突、来源都按"字段 × 区间"，不按段 |
| N7 | 字段 ID 直接作 path 的一段（`fields/f3`），不加前缀 | W4 D7 的例子写成 `after/f_12`；字段 ID 本身已是不透明短 ID |
| N8 | 撤回删除、确认删除**不产生 `item.resolved` / `item.created`**，`deletion` 事项完全由 `deletion.*` 得出 | 撤回不绑定事项版本、没有确认记录；再记一条事项事件只是重复 |
| N9 | 编译失败不产生事件 | 与"被拒的写入不产生事件"一致；状态机里的"编译失败"是一次报错 |
| N10 | `compiled` 给出**这一版全部的表**，不只是改动的 | 重放、删除重放、按时刻读只需读一个块就能解释这一版的写入 |
| N11 | 事项的业务时间区间放在数据块 `scope_valid`，不放 `target` | 区间端点是用户说的话，是内容 |
| N12 | `previous`、`current`、`proposed` 都按"字段 × 段"切成多块 | W1 决定 10 的 `{seq, value}` 在状态类表上不够：合并基上的值可以是多段 |
| N13 | 恢复流程里"登记已执行、日志里连确认也没有"的情形，写成一条 `deletion.confirmed`（`origin: "restored_executed"`）紧跟一条 `deletion.executed` | W4 D2 只说"按定义重算，直接物理删除"。删除后的状态必须写在某条事件里，否则重放得不出它 |
| N14 | `item.refreshed` 加 `cause: "entries_deleted"`，用来表达"隐私删除去掉了一个候选而事项仍未决" | 规格说此时事项版本换新，但没有对应的事件 |
| N15 | 导出文件第一行是清单；块的三种状态用 `{"v","sum"}` / `{"removed_by"}` / `{"pending_deletion"}` 包一层 | 块的内容本身可以是任意 JSON，不包一层就分不清内容与占位 |
| N16 | 结果校验和的算法（§5.12）；`confirmation` 的哈希取"被确认条目块的校验和"的哈希 | 规格只说"结果校验和""内容哈希"，没有给算法 |
| N17 | 记录时刻固定为 UTC 毫秒精度；整数上限 2^53 − 1 | JCS 按 JavaScript 的数字规则序列化 |
| N18 | `ver.basis` 加第三个值 `same_request` | W1 决定 13：本请求里新建的行或实体，后面的 op 不需要 `ver` |
| N19 | 证据的"纠错"标注不单独记：由 `write.base` 的 `intent: "correct"` 得出 | 契约把 `correction` 列为 saveslot 标注的证据种类；它不是证据自身的属性 |

## 复核结论（架构负责人）

- N1–N19 全部采纳。
- 三处与决定稿对不上的地方，按事件格式的写法定：全部字段都是无操作的写入不产生 `write.base`（W1 决定 19 优先于决定 4 的字面）；删除 ID、种类、到期时刻放元数据块 `target`，不放事件头（"事件头尽量少留"优先于 W4 的汇总）；解析后的区间记在 `write.base` 的字段块里，`write.head` 只记原始传参（N4 优先于 W1 决定 1 的字面）。
- 原「本文待定项」第 5–8 条已定：
  - 一次删除只针对一个 slot；跨 slot 由调用方分成多次。契约的 `deletion_preview` 对跨 slot 的 `sources` 报 `invalid_argument`（`cross_slot`）。
  - 改 slot 名称或时区走 schema 草稿，不另设事件。
  - `task` 与显式幂等键的来源规则同请求键：那次操作的证据被隐私删除时一起删。
  - 连接实例名称不在级联范围；删除预览的 `not_deleted[]` 里以 `connection_names` 列出。
  - 派生写入的 `reads` 第一版只记到表一级。
- 待定项 1–3（单位词表、默认精度与舍入、默认策略内容）与第 4 条（ID 前缀）另行决定，登记在 `08-open-questions.md`「开发前必须定」。
- "纠错"是由写入意图得出的标注，不是源数据的种类（N19）：契约 `sources` 的 `kind` 去掉 `correction`，改为标注字段。

## 与契约对齐时统一的名字

| 概念 | 统一后的名字 |
|---|---|
| 意图里的系统裁定（第一版不产生） | `applied_by_rule` |
| 区间的写法 | `given` / `now` / `next_change` / `open` / `corrected_span` |
| 字段生效状态 | `applied` / `candidate` / `awaiting` / `corroborated` / `noop` |
| 事项类型的键名 | `type`（事件格式原用 `kind`） |
| 候选的来由 | 键名 `cause`，取值 `stale_write`（保留 `displaced_by_rule`） |
| 候选的指代 | 下标（事项生命周期内不复用） |
| 事项成因码 | `stale_write`、`overwrites_change_point`、`referenced_row`、`undo_includes_later`、`conflict_cleared_by_deletion`、`duplicate_keys`、`schema_change`；`deletion` 事项用 `deletion.confirmed` 的 `origin` |
| 取代原因 | `overwritten`、`schema_switched`、`deleted`、`draft_replaced`、`deletion_cancelled` |
| slot 策略的生效值规则 | 键名 `effective_value_rule` |
| 导出清单 | `saveslot_export`、`tenant_id`、`event_format`、`restore_count`、`after`、`upto`、`events`、`exported_at`、`pending_deletions` |
