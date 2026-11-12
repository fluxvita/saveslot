# 推演 5：营养记录（Agent 手记 + 连接器同步 + 依据）

> 依据的文档：规格 [`01-objects.md`](../../spec/03-data-model/01-objects.md)、[`02-integrity-and-records.md`](../../spec/03-data-model/02-integrity-and-records.md)、[`03-deletion.md`](../../spec/03-data-model/03-deletion.md)（含「回掉的权威定义」的伪代码）、[`04-write-and-read.md`](../../spec/03-data-model/04-write-and-read.md)、[`05-time.md`](../../spec/03-data-model/05-time.md)、[`06-derived.md`](../../spec/03-data-model/06-derived.md)、[`07-schema-evolution.md`](../../spec/03-data-model/07-schema-evolution.md)、[`09-references-conflict-sync.md`](../../spec/03-data-model/09-references-conflict-sync.md)「冲突处理」、[`04-contract.md`](../../spec/04-contract.md)、[`09-event-format.md`](../../spec/09-event-format.md) 的相关小节、[`02-architecture.md`](../../spec/02-architecture.md) §3 的 K1–K14。
> 检验的对象是两份**尚未落进规格**的决定稿：[`pre-dev-w8-connector-access.md`](../decisions/pre-dev-w8-connector-access.md)（下称 W8；重点是 §2 凭证限定到 slot、§3 来源键 `external_key`）与 [`pre-dev-w9-basis.md`](../decisions/pre-dev-w9-basis.md)（下称 W9；写入的依据 `basis`）。
> 文中 `→ Nn` 指向文末问题清单。**本文只列问题，不改规格与决定稿，不替设计做决定**；问题清单里的"倾向"只是推演者的意见。

## 设定

- **部署**：服务器模式，单节点。连接器是 saveslot 之外的程序，经 HTTP 写入（W8 §1）。
- **主体**：用户 `U`（用户会话）；Agent A = `ci_A…`，scope `saveslot.read saveslot.write saveslot.schema saveslot.delete`，slot 范围"全部"；连接器 K = `ci_K…`（名字"某饮食 App · 连接器"），scope `saveslot.read saveslot.write`，slot 范围只有 `nutrition`。
- **日期**：2026 年，slot 时区 `Asia/Shanghai`。第 1 步在 11-09，第 2–5 步在 11-10，第 6–7 步在 11-11，第 8–11 步在 11-12 之后。
- **记号**：`#n` = 日志 `seq`，序号是示意；一次操作的头事件的 `#n` 是操作号。`s_…` = 源数据；`r_M…` = `meals` 的行，`r_I…` = Agent 手记的明细行，`r_X…` = 连接器同步的明细行，`r_P…` = 计划行，`e_T` = 每日目标的实体；`pi_…` = 事项；`p_…` = 派生行的 `partition_id`；`v70.0` = 版本标记。都是简写标签，不是真实标识的写法。
- **表头**沿用前几次推演：做了什么 | 调用 | (a) 追加的日志事件 | (b) `apply` 改的物化状态 | (c) 本地运行状态 | 回执 / 之后读到什么。每步末尾的"核对"一行对照 K1–K14，只写与这一步有关的几条；汇总见「核对汇总」。
- **并排对照**：涉及撤销、隐私删除、`undo` 的步骤，给出"参考语义的结果"（按「删除结果的定义」或「回掉的权威定义」的伪代码求）与"按文档规则逐条推出的结果"，不一致即记入问题清单。
- **租户里另有一个 slot `ledger`**（记账，表 `expenses`），占用 #2–#19，只在第 10 步用到。

## schema

slot `nutrition`，v1。完整的 schema 文档（草稿，`base_version: null`）：

```json
{
  "slot": "nutrition", "base_version": null, "timezone": "Asia/Shanghai",
  "tables": [
    {
      "name": "meals", "kind": "base", "description": "每餐一行",
      "time": { "type": "event", "field": "date" },
      "fields": [
        { "name": "date", "type": "date", "required": true, "description": "用餐当天（slot 时区的自然日）" },
        { "name": "meal_type", "type": "enum", "values": ["breakfast", "lunch", "dinner", "snack"], "required": true, "description": "餐别" },
        { "name": "eaten_at", "type": "zoned_datetime", "description": "用餐时刻，知道才填" },
        { "name": "note", "type": "text", "description": "备注，用户原话" }
      ]
    },
    {
      "name": "meal_items", "kind": "base", "description": "一餐里的食材明细，每种食物一行",
      "time": { "type": "event", "field": "date" },
      "external_key": ["origin", "external_id"],
      "duplicate_keys": [["date", "food", "amount"]],
      "fields": [
        { "name": "meal", "type": "ref", "ref": { "table": "meals", "target": "row" }, "description": "属于哪一餐；连接器同步来的明细没有这一项" },
        { "name": "date", "type": "date", "required": true, "description": "食用当天" },
        { "name": "food", "type": "text", "required": true, "description": "食物名" },
        { "name": "amount", "type": "quantity", "unit": "g", "required": true, "min": 0, "description": "份量" },
        { "name": "energy", "type": "quantity", "unit": "kcal", "required": true, "min": 0, "description": "能量" },
        { "name": "protein", "type": "quantity", "unit": "g", "min": 0, "description": "蛋白质" },
        { "name": "origin", "type": "enum", "values": ["diet_app"], "description": "记录来自哪个外部系统；手记的行为空" },
        { "name": "external_id", "type": "text", "description": "记录在来源系统里的标识；手记的行为空" }
      ]
    },
    {
      "name": "daily_targets", "kind": "base", "description": "每日能量与蛋白质目标，随时间变化",
      "time": { "type": "state", "granularity": "date" },
      "fields": [
        { "name": "energy", "type": "quantity", "unit": "kcal", "required": true, "min": 0, "description": "每日能量目标" },
        { "name": "protein", "type": "quantity", "unit": "g", "required": true, "min": 0, "description": "每日蛋白质目标" }
      ]
    },
    {
      "name": "meal_plans", "kind": "base", "description": "按天的饮食计划，由 Agent 依据每日目标写出",
      "time": { "type": "event", "field": "date" },
      "fields": [
        { "name": "date", "type": "date", "required": true, "description": "计划的那一天" },
        { "name": "energy_budget", "type": "quantity", "unit": "kcal", "required": true, "min": 0, "description": "当天计划摄入的能量" },
        { "name": "protein_budget", "type": "quantity", "unit": "g", "min": 0, "description": "当天计划摄入的蛋白质" },
        { "name": "outline", "type": "text", "description": "三餐安排" }
      ]
    },
    {
      "name": "daily_totals", "kind": "derived", "description": "每日合计",
      "rule": {
        "sql": "SELECT date AS day, sum(energy) AS energy_total, sum(protein) AS protein_total, count(DISTINCT meal) AS meal_count FROM meal_items GROUP BY 1",
        "time_dependency": "bucketed"
      },
      "fields": [
        { "name": "day", "description": "哪一天" },
        { "name": "energy_total", "description": "当天能量合计" },
        { "name": "protein_total", "description": "当天蛋白质合计" },
        { "name": "meal_count", "description": "当天有记录的餐数（明细指向的不同的一餐）" }
      ]
    }
  ]
}
```

编译回填的 ID：`meals` = `t1`（`date` f1、`meal_type` f2、`eaten_at` f3、`note` f4）；`meal_items` = `t2`（`meal` f1、`date` f2、`food` f3、`amount` f4、`energy` f5、`protein` f6、`origin` f7、`external_id` f8）；`daily_targets` = `t3`（`energy` f1、`protein` f2）；`meal_plans` = `t4`（`date` f1、`energy_budget` f2、`protein_budget` f3、`outline` f4）；`daily_totals` = `t5`，规则 `r1`，重算范围按 `day` 分组。

设计这份 schema 时就遇到的三处：

- **明细表本来没有自己的时间，却必须是事件类表。** 明细的"哪一天"由它所属的一餐决定；但 W8 3.2 规定来源键只能声明在事件类表上，事件类表又必须有 `time.field`。所以 `meal_items` 自带一个 `date`，与 `meals.date` 重复：改一餐的日期时明细不跟着变（`ref` 不级联），两处要各改一次。→ N1
- **连接器写不了"一餐"。** `meals` 没有来源键（本场景只给明细表声明），连接器若每次同步都 `insert` 一餐就会重复新增；即使给 `meals` 也声明来源键，同一请求里明细要用临时名引用按来源键**命中的**一餐也写不出来（W8 3.7 表末行）。本场景里连接器同步的明细不填 `meal`，于是 `meal_count` 不计入它们。→ N2
- **规则写法有两处规格没给出依据。** `count(DISTINCT meal)`（对 `ref` 字段去重计数）是否在白名单里；以及若想按 `meals.eaten_at` 所在的自然日分组，受限 SQL 里"把 `zoned_datetime` 按 slot 时区取日"怎么写——07-schema-evolution「改动分类」提到有这类规则，但没有写法。本文为绕开后者给两张表都设了 `date` 字段。→ N3

### 起始数据（第 1 步之后、第 2 步之前，11-09）

| 操作 | 谁 | 内容 | 结果 |
|---|---|---|---|
| #30 | A | `insert` `daily_targets`：`energy` 2000 kcal、`protein` 100 g，不传区间（起点 = 现在，终点 `next_change`，之后没有挡点）。证据 `s_T`「每天 2000 大卡、蛋白质 100 克」 | `e_T`：`[11-09, ∞)` 2000 / 100，`v30.0` |
| #34 | A | 一次请求：`insert` 晚饭 `r_M0`（11-09，`dinner`），两条明细 `r_I4`（三文鱼，120 g，250 kcal，24 g）、`r_I5`（糙米饭，150 g，165 kcal，3.9 g）。证据 `s_0` | 三行 `v34.0`；派生写入 #39：`p_0`（11-09）415 kcal · 27.9 g · 1 餐 |


---

## 第 1 步：建 slot 与 schema，签发两个连接实例（11-09）

前提：租户创世 #1；A 由用户会话在 #2 登记（`principal.registered`，scope 四项，元数据块里没有 `slots` 键 = 全部）；`ledger` 由 A 在 #3–#19 建好并有数据。

| 做了什么 | 调用 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|---|
| A 建 slot | `schema_draft`，上面的文档，`base_version: null` | #20 `schema.draft_submitted`（头）· #21 `schema.compiled`（`compiled` 里 `t2` 带 `external_key: ["f7", "f8"]`）· #22 `schema.confirmed` · #23 `slot.policy_set`（默认策略全文）· #24 `schema.switched` | 目录：slot `nutrition` = `sl_N…`，sv 1；五张表的物理表 `t_t1_v1` … `t_t5_v1`；`external_keys` 键索引（W8 3.8）为空；`partitions` 为空 | — | `outcome: applied`，`changes: [create_slot]`。键有两个字段，不给 `single_field_external_key`；规则分组键是 `date`，不是自由文本，不给分组键提醒 |
| 用户签发连接器凭证 | `saveslot connect http --name "某饮食 App · 连接器" --slots nutrition`（用户会话，scope 取默认 `saveslot.read saveslot.write`） | #25 `principal.registered`，`actor` = 用户主体：`{"principal": "ci_K…", "kind": "connection", "scopes": ["saveslot.read","saveslot.write"], "slots": ["sl_N…"], "via": "token"}` | `principals` 加一行，slot 范围 = [`sl_N…`] | 控制面只存 `slt_…` 令牌的哈希 → `ci_K…`，不另存范围（W8 2.5） | 令牌明文只返回一次。`GET /v1/slots` 用 K 的令牌只列出 `nutrition` |

- **先后不能反**：W8 2.5 要求 `slots` 里的每个 slot 在签发时已存在，所以连接器的凭证只能在 #24 之后签发；建 slot 只能由 A（范围"全部"、有 `saveslot.schema`）或用户会话做（W8 2.4）。
- `principal.registered` 是租户级事件，事件头没有 `slot`；`slots` 只含不透明的 slot ID，放在元数据块里，与 `scopes` 同块。slot 名 `nutrition` 只出现在 schema 的内容里。
- A 的 slot 范围是"全部"：之后用户再建的 slot 自动纳入；K 的范围是列表：不纳入（W8 2.4）。

**核对**：K1 事件头里没有 slot 名、令牌或任何由内容算出的值 ✓；K2 #25 的 `actor` 是已登记的用户主体，K 从 #25 起是已登记主体 ✓；K6 sv 1 不可变，字段 ID 回填 ✓；K12 `principals` 的 slot 范围由 #25 重放得出，控制面不另存一份 ✓。

## 第 2 步：Agent 记一餐（11-10 12:40）

用户："午饭吃了鸡胸肉 100 克、西兰花 200 克、米饭 150 克。"A 按常见营养数据算出能量与蛋白质。

```json
{ "sv": 1, "task": "log_lunch",
  "evidence": [
    { "kind": "user_message", "text": "午饭吃了鸡胸肉 100 克、西兰花 200 克、米饭 150 克" },
    { "kind": "agent_note", "text": "按常见营养数据估算：鸡胸肉 100 g 165 kcal、蛋白质 31 g；西兰花 200 g 68 kcal、5.6 g；米饭 150 g 174 kcal、3.9 g" } ],
  "ops": [
    { "intent": "insert", "table": "meals", "as": "m1",
      "set": { "date": "2026-11-10", "meal_type": "lunch", "eaten_at": "2026-11-10T12:30:00+08:00" },
      "evidence_by_field": { "date": [0], "meal_type": [0], "eaten_at": [0] } },
    { "intent": "insert", "table": "meal_items",
      "set": { "meal": "@m1", "date": "2026-11-10", "food": "鸡胸肉", "amount": { "value": "100", "unit": "g" },
               "energy": { "value": "165", "unit": "kcal" }, "protein": { "value": "31", "unit": "g" } },
      "evidence_by_field": { "meal": [0], "date": [0], "food": [0], "amount": [0], "energy": [1], "protein": [1] } },
    { "intent": "insert", "table": "meal_items", "set": { "meal": "@m1", "food": "西兰花", "amount": "200 g", "energy": "68 kcal", "protein": "5.6 g", "date": "2026-11-10" }, "evidence_by_field": "（同上）" },
    { "intent": "insert", "table": "meal_items", "set": { "meal": "@m1", "food": "米饭", "amount": "150 g", "energy": "174 kcal", "protein": "3.9 g", "date": "2026-11-10" }, "evidence_by_field": "（同上）" } ] }
```

（后两个 op 为节省篇幅写成简写，真实请求与第一个 op 同形。）

| 做了什么 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|
| 一次请求，4 个 op | #40 `write.head`：请求键与内容指纹、`task`、`now` = 11-10 12:40、`today` = 11-10；`ops/0/refs` = `{"as": "m1"}`；各 op 的原始传参 · #41 `source.recorded` `s_1`（用户原话）· #42 `source.recorded` `s_1n`（agent_note）· #43 `write.base` `r_M1`（三个字段 `applied`，来源 `s_1`）· #44–#46 `write.base` `r_I1`、`r_I2`、`r_I3`（六个字段 `applied`；`meal` 的值是解析后的 `r_M1`；`meal`、`date`、`food`、`amount` ← `s_1`，`energy`、`protein` ← `s_1n`；字面命中：`amount` 对 `s_1` 命中（"100 克"）、`energy` / `protein` 对 `s_1n` 命中）· #47 `write.derived`：`p_1`（11-10）首次出现，`key` 块 `{"values": ["2026-11-10"]}`，`checksum` | 四行进业务表与版本表，`ver` 都是 `v40.0`；`base_sources` 按字段记；`daily_totals` 新增一行 `p_1`：`energy_total` 407 kcal、`protein_total` 40.5 g、`meal_count` 1；`partitions` 登记 `p_1`；`derived_reads`：#47 → (`t2`, `p_1`, `read_pos` #46) | 请求键查重表；`audit` 记"本次按名字引用了哪些字段" | `status: saved`，`seq: 40`；`r_M1`、`r_I1`–`r_I3` 的行 ID 与 `v40.0`；`derived: [{daily_totals, day 2026-11-10, energy_total: — → 407 kcal, …}]` |

- **每日合计怎么刷新**：规则是按 `day` 的分组聚合，重算范围 = 被改行改前、改后值所落的分组（06-derived「刷新范围与写入准入」）。三条新行都落在 11-10，只重算这一组，在同一事务里完成（K5）。`meal_count` 用 `count(DISTINCT meal)`：三条明细指向同一个 `r_M1`，计 1。
- **同一请求里的临时名**：第 0 个 op 用 `as: "m1"` 登记，后面三个 op 的 `meal` 写 `"@m1"`；`ref` 的目标校验（判定顺序第 5 步）看得到前面 op 新建的行（04-write-and-read「同一请求里的多个 op」）。临时名记在 `ops/0/refs` 的数据块里，来源是这个 op 的全部证据（事件格式 5.7）。
- **疑似重复**：`meal_items` 里还没有同为（11-10，鸡胸肉，100 g）的行，不命中。
- **能量是 Agent 算的**：用户原话里没有 kcal。把 `energy` / `protein` 映射到 agent_note 那段，是为了之后删用户原话时不至于"多删"或"少删"能量值（见第 11 步）。没给映射时，四个字段同时依赖两段证据（"且"），回执会给 `warnings` 提醒。
- **之后读到什么**：13:00 A 在另一个任务 `daily_summary` 里 `query daily_totals`（11-10）与 `query meal_items`（11-10）→ `rd_1`：`p_1@#47`；`r_I1@40`、`r_I2@40`、`r_I3@40`，业务时间条件记为入口时刻。A 告诉用户"今天到目前 407 大卡、蛋白质 40.5 克"。

**核对**：K1 事件头里没有请求键、临时名或分组键 ✓（它们都在内容区）；K3 业务表、派生表、`partitions` 的改动都对应 #43–#47 ✓；K4 每个基础写入都有字段级来源 ✓；K5 派生同事务刷新 ✓；K13 请求键与结果同事务记下 ✓。

## 第 3 步：改一条明细的份量（11-10 15:00）

用户："鸡胸肉其实是 150 克，不是 100 克。"

**意图怎么选**：原来的值本来就记错了，不是"之后变了"，所以是 `correct`（04-write-and-read「写入请求」："值本来就记错了必须用纠错"）。用 `update` 的后果：事件类表上的 `update` 不触发纠错影响查询，读过 100 克那一版的读取不会被标记。能量与蛋白质要跟着改：saveslot 不会按份量重算基础表的值，这是 Agent 的事。

```json
{ "sv": 1, "task": "fix_amount",
  "evidence": [ { "kind": "user_message", "text": "鸡胸肉其实是 150 克，不是 100 克" },
                { "kind": "agent_note", "text": "按 150 g 重算：247.5 kcal、蛋白质 46.5 g" } ],
  "ops": [ { "intent": "correct", "table": "meal_items", "row": "r_I1…", "ver": "v40.0",
             "set": { "amount": "150 g", "energy": "247.5 kcal", "protein": "46.5 g" },
             "evidence_by_field": { "amount": [0], "energy": [1], "protein": [1] } } ] }
```

| 做了什么 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|
| 纠错 | #50 `write.head` · #51 `s_2` · #52 `s_2n` · #53 `write.base` `r_I1`：`f4` 150 g、`f5` 247.5 kcal、`f6` 46.5 g，都是 `applied`，意图 `correct` · #54 `write.derived` `p_1`（没有 `key` 块：映射已在 #47 登记过） | `r_I1` = 150 g · 247.5 kcal · 46.5 g，`v50.0`；`p_1` = 489.5 kcal · 56.0 g · 1 餐，派生行版本 #50 | 读取审计：纠错影响查询的结果存为标记 | `status: saved`；`derived: [{day 2026-11-10, energy_total: 407 → 489.5 kcal, protein_total: 40.5 → 56.0 g}]`；`affected_reads: {correct: 1, …}` |

**纠错影响查询怎么走**（02-integrity-and-records「纠错影响查询」）：被纠正的版本 = `r_I1` 上这三个字段最近一次取得旧值的写入 #40 起、到 #50 之前的全部版本，即 `r_I1@40`；往下游走 `derived_reads` 得 #47 的 `p_1`；再用 read_log 匹配。

| 之前的读取 | 读到什么 | 第一版会不会被标 | 原因 |
|---|---|---|---|
| `rd_1` 里的 `r_I1@40`（逐行读） | 100 g · 165 kcal | 会：下次 A 在任务 `daily_summary` 里读到 `r_I1` 时带 `possibly_affected`（`correct`，"你曾读到的值已被纠正"） | 纠错者自己的定位读取只排除"同一连接实例 + 同一 `task`"（本次 `task` 是 `fix_amount`）；`rd_1` 的任务不同，不排除 |
| `rd_1` 里的 `p_1@47`（读派生值） | 407 kcal | **不会** | 第一版的纠错影响查询不覆盖对派生值的读取（architecture §3 第一版对 K10 的收窄；scope 3.5）。读过每日合计的那一方，下次只会读到 489.5、`ver` 换成 `v50.0`，没有任何"你上次读到的合计已不成立"的提示 → N4 |
| K | 没读过 | — | — |

- 之后谁读 `daily_totals`（11-10）：489.5 kcal · 56.0 g · 1 餐；`input_marks` 为空（纠错不产生事项标记）。按 `history` 的 `changes` 才能看出"#50 改过"。

**核对**：K7 `now` 记在 #50 头里 ✓；K8 `ver` 是当前版本，没有冲突判定 ✓；K10 read_log 只有版本号，标记存在 (c) 类 ✓（但对派生值的读取第一版不覆盖，是已声明的收窄）；K5 ✓。

## 第 4 步：删一顿饭（撤销）（11-10 16:00）

用户："今天午饭那条记错了，删掉吧。"这是"数据错了"，A 用撤销（`revoke`），不用隐私删除（03-deletion「删除的种类」）。

### 4a 只撤销"一餐"这一行

```json
{ "sv": 1, "evidence": [{ "kind": "user_message", "text": "今天午饭那条记错了，删掉吧" }],
  "ops": [{ "intent": "revoke", "table": "meals", "row": "r_M1…", "ver": "v40.0" }] }
```

| (a) | (b) | (c) | 回执 |
|---|---|---|---|
| #60 `write.head` · #61 `s_3`（撤销的证据，只是操作来源）· #62 `write.base` `r_M1`：`existence` 一项，状态 `awaiting` · #63 `item.created` `pi_1`（`awaiting_confirmation`，成因 ②；影响 = 仍引用它的行 `r_I1`、`r_I2`、`r_I3`） | 业务表、版本表不动；`r_M1` 带 `awaiting` 标记；没有派生写入 | — | `status: pending`；`pending: [{pi_1, item_ver: iv_…}]`，附三条引用方。`r_M1` 的 `ver` 仍是 `v40.0` |

- 判定顺序走到第 6 步：撤销一行、该行仍被其他行 `ref` 引用 → 高影响 ②，"一律进待确认"（05-time「高影响写入」）。"仍被引用"数的是当前版本里未撤销的行，`r_I1`–`r_I3` 都是。
- **如果之后有人确认 `pi_1`**：`r_M1` 撤销生效，三条明细不动、保留 `meal = r_M1`，读取时带 `dangling_ref`（目标已撤销）。`daily_totals` 的 11-10 仍是 489.5 kcal，**`meal_count` 仍是 1**：派生规则读的逻辑表是"未撤销的行"，但明细没有被撤销，它们的 `meal` 值仍指着那一餐。schema 作者要想让餐数不数已撤销的餐，得把规则写成关联 `meals`；规格没有提醒"按 `ref` 计数会数到已撤销的目标" → N8。
- 本推演里 `pi_1` 不确认，接着走 4b。回执里给出了 `pi_1` 的全部内容，所以 A 算"读到了"`pi_1` 的当前事项版本（01-objects「事项 ID 与事项版本」第 ② 种）。

### 4b 同一个请求里先撤销三条明细、再撤销这一餐

A 已有四行的 `ver`：`r_I1` 的 `v50.0` 来自第 3 步自己的写入回执，其余三行的 `v40.0` 来自第 2 步的回执（"写入方自己的写入回执里已生效的 `ver`"算逐行读，可兜底；这里显式带上）。哪几条明细属于这一餐，A 从第 2 步的回执就知道；不知道时先 `query meal_items where meal = r_M1`。

```json
{ "sv": 1, "evidence": [{ "kind": "user_message", "text": "连明细一起删掉" }],
  "ops": [
    { "intent": "revoke", "table": "meal_items", "row": "r_I1…", "ver": "v50.0" },
    { "intent": "revoke", "table": "meal_items", "row": "r_I2…", "ver": "v40.0" },
    { "intent": "revoke", "table": "meal_items", "row": "r_I3…", "ver": "v40.0" },
    { "intent": "revoke", "table": "meals", "row": "r_M1…", "ver": "v40.0" } ] }
```

**严格按规格文字判第 3 个 op（撤销一餐）**：

| 规格文字 | 出处 | 对第 3 个 op 意味着什么 |
|---|---|---|
| "op 按请求里的顺序执行，后面的 op 看得到前面 op 的结果" | 04-write-and-read「同一请求里的多个 op」；contract 5.1 | 第 3 个 op 执行时，三条明细已被本请求撤销 |
| "各 op 独立判定：一个 op 成了候选，不影响同请求里其他 op 生效" | 同上 | 说的是一个 op 的**结果**不连累别的 op 生效与否，不是说判定时看不到前面 op 的结果。前三个 op 都生效了，不涉及这一句 |
| "高影响 ② 怎么数'仍被引用'：当前版本里未撤销的行，其 `ref` 字段的生效值指向目标" | 04-write-and-read「引用字段」 | 关键在"当前版本"指什么 |
| "所见版本……同一请求里后面的 op 再叠加本请求前面 op 的结果" | 05-time「高影响写入」（只为 ① 写了这句）；同值基准同样写了"叠加本请求前面 op 的结果"（04-write-and-read） | ② 没有对应的明文 |

两种读法：

| 读法 | "当前版本"= | 第 3 个 op | 结果 |
|---|---|---|---|
| 甲 | 叠加了本请求前面 op 结果的状态（与"后面的 op 看得到前面 op 的结果"一致，也与 ① 和同值的写法一致） | 引用方 0 行 → 不属高影响 → 生效 | 一次完成，不进待确认 |
| 乙 | 请求开始时已提交的状态（字面上"当前版本"常指库里已提交的版本；对已存在的行，各 op 带的 `ver` 也被定义为"请求开始时所见的版本"） | 引用方 3 行 → 进待确认 | 明细已撤销、一餐待确认；要再 `resolve confirm` 一次 |

**按甲（推演者倾向，理由是"后面的 op 看得到前面 op 的结果"是对整个判定顺序说的，② 不应例外）走下去**：

| (a) | (b) | 回执 |
|---|---|---|
| #70 `write.head` · #71 `s_4`（操作来源）· #72–#74 `write.base` `r_I1`–`r_I3`：`existence` 撤销 `applied` · #75 `write.base` `r_M1`：`existence` 撤销 `applied` · #76 `item.superseded` `pi_1`（写入方 A 读过它的当前版本，又改到了它的目标 → 已被取代）· #77 `write.derived` `p_1`：`emptied: true` | 四行都撤销，`ver` 都换成 `v70.0`；11-10 这一组没有未撤销的行，`daily_totals` 删除 `p_1` 这一行；`partitions` 里 `p_1` 的映射仍在（#47 的 `key` 块没被删） | `status: saved`；`superseded: [pi_1]`；`derived: [{day 2026-11-10, emptied}]`；`affected_reads: {revoke: …}`：`rd_1` 读过三条明细，下次带 `possibly_affected`（"你曾读到的值所含的一条记录已被撤销"） |

- 反过来排（先撤销一餐、再撤销明细）：第 0 个 op 看到 3 条引用方 → 待确认；后面三个 op 生效。之后 `pi_1'` 的影响里那三条引用方都已撤销，但规格只写了"别的行新增或去掉对该行的 `ref` 时……刷新影响"，引用方**被撤销**算不算"去掉"没写；即使刷新到空，"引用方全部去掉后事项仍然保留、影响为空，照常等人确认"。所以同样的四个 op，顺序不同就差一次 `resolve`。→ N5
- **Agent 一共要几次调用**：按甲，只走 4b 是 **1 次 `write`**（不知道明细的行 ID 时再加 1 次 `query`）。本推演先走了 4a，所以实际是 4a 的 `write` + 4b 的 `write` 共 2 次（`pi_1` 不需要单独 `resolve`：被 4b 取代）。按乙是 `write` + 读事项详情 + `resolve confirm` = 3 次。

**并排**：

| | 参考语义（用户的意思：这顿饭与它的明细都不该存在） | 按文档规则逐条推（读法甲） | 按读法乙 |
|---|---|---|---|
| `r_M1` | 已撤销 | 已撤销（#75） | 待确认，仍在 |
| `r_I1`–`r_I3` | 已撤销 | 已撤销 | 已撤销 |
| 11-10 合计 | 没有这一行 | `p_1` 删除 | `p_1` 删除 |
| 未决事项 | 无 | 无（`pi_1` 已被取代） | 一个 `awaiting_confirmation`，影响为空或仍列着已撤销的三行 |

读法甲与参考一致；读法乙多出一个"影响为空也要确认"的事项。

### 4c `undo` 这次撤销（11-10 16:10）

用户："刚才删错了，午饭是对的，恢复。"`undo` 按行 / 实体作用（"撤回写入号 n 对这一行 / 实体的全部改动"），四行就是四个 op，放在一个请求里：

```json
{ "evidence": [{ "kind": "user_message", "text": "刚才删错了，午饭是对的，恢复" }],
  "ops": [ { "table": "meals", "row": "r_M1…", "revert": { "undo": 70 } },
           { "table": "meal_items", "row": "r_I1…", "revert": { "undo": 70 } },
           { "table": "meal_items", "row": "r_I2…", "revert": { "undo": 70 } },
           { "table": "meal_items", "row": "r_I3…", "revert": { "undo": 70 } } ] }
```

- 意图省略：第 n 次写入是撤销时默认 `correct`。`undo` 不做 `ver` 冲突判定；不是高影响（撤回撤销不是 ①；② 只管撤销；没有 `include_later`，不是 ④）。
- 已撤销的行不可写（`revoked`）——这一条拦的是变更与纠错；`undo` 一次撤销是规格明列"可以"的情形。
- 写回的是"存在"，不写 `ref` 字段，所以不重做 `ref` 的目标校验；先恢复哪一行都一样。

**对照伪代码（以 `r_M1` 为例，明细三行同形）**：R = [(#75, 存在, 0)]；pos = 操作 70 之前；n = 80。

| 步 | 求得 |
|---|---|
| 1 | R' = R；在 = [#75 的撤销]（生效） |
| 2 | `undo`：域 = ⊤ |
| 3 | 盖住：找 70 < 操作号 < 80、不在 R' 里、取代"撤销"的生效项（恢复存在或填值）——没有。范围 = ⊤ |
| 4 | 这次回掉生效 |
| 5 | 登记：#75 在 ⊤ 内已被操作 80 回掉 |
| 6 | "存在"：S = 操作 70 之前该处是否在一次生效、未被回掉的撤销之内。#62（4a）是 `awaiting`、后被取代，从未生效，不算 → S 是"存在" → 写回"恢复存在" |
| 7 | 写回项生效 |
| 8 | 依赖：#75 |

| (a) | (b) | 回执 |
|---|---|---|
| #80 `write.head` · #81 `s_5` · #82–#85 `write.base` 四行，各一项"恢复存在"`applied`，`revert` 块 = `[(#7x, existence, 0)]` · #86 `write.derived` `p_1`（11-10 又有了行） | 四行恢复，字段值照旧（`r_I1` 仍是 150 g · 247.5 kcal · 46.5 g，#53 的贡献不受影响）；`ver` 都换成 `v80.0`；`daily_totals` 11-10 = 489.5 kcal · 56.0 g · 1 餐 | `status: saved`；`affected_reads`：按 `correct` 查读过撤销后状态的读取（没有）；`rd_1` 上因 #70 打的 `possibly_affected` 按"值恢复后撤掉标记"撤掉——第 3 步因纠错打的那一条仍在（份量仍是 150 g，`rd_1` 读到的 100 g 没有恢复） |

**并排**：参考语义（撤回撤销 = 回到 #70 之前）是四行都在、值同 #53 之后；伪代码求得相同 ✓。

- `p_1` 在 #77 被清空、在 #86 又有了行：规格只写了"分组因**删除**变空、宽限期内同一分组键又有了行时，沿用原 `partition_id` 并重新登记映射"；因**撤销**变空、之后又有了行时，是沿用 `p_1`（映射 #47 仍在）还是当作"首次出现"另分配，没有写。本文按沿用 `p_1`、不再写 `key` 块理解 → N7

**核对**：K1 ✓；K4 撤销与 `undo` 都有源数据（操作来源）✓；K5 两次都同事务刷新派生 ✓；K8 不涉及（`ver` 都是当前的）；K11 不涉及；K14 `pi_1` 没被确认，而是按"读过之后改到目标"被取代，未执行它的提议 ✓。

## 第 5 步：改目标，依据跟着变（11-10）

### 5a 此前：依据旧目标写三天计划（11-10 18:00）

A 先读目标：`query daily_targets`，不传时间 → 返回当前段 `[11-09, ∞)` 2000 kcal / 100 g，`ver` = `v30.0`；read_log 记 `rd_2`：`e_T@30`，业务时间条件 = 入口时刻（`date` 粒度记为 11-10 这一天）。

```json
{ "sv": 1, "task": "plan",
  "evidence": [ { "kind": "user_message", "text": "按我的目标排一下接下来三天吃什么" },
                { "kind": "agent_note", "text": "三天计划：每天 2000 大卡、蛋白质 100 克，三餐安排如下……" } ],
  "ops": [
    { "intent": "insert", "table": "meal_plans",
      "set": { "date": "2026-11-11", "energy_budget": "2000 kcal", "protein_budget": "100 g", "outline": "早：燕麦鸡蛋；午：……" },
      "basis": [{ "table": "daily_targets", "entity": "e_T…", "fields": ["energy", "protein"], "ver": "v30.0" }] },
    { "intent": "insert", "table": "meal_plans", "set": { "date": "2026-11-12", "…": "…" }, "basis": "（同上）" },
    { "intent": "insert", "table": "meal_plans", "set": { "date": "2026-11-13", "…": "…" }, "basis": "（同上）" } ] }
```

| (a) | (b) | 回执 |
|---|---|---|
| #88 `write.head`：`ops/0..2/basis/0` 各一块（元）`{"table": "t3", "entity": "e_T…", "fields": ["f1", "f2"], "ver": {"op": 30, "restore_count": 0, "basis": "explicit"}, "scope": "from_now", "state": "current"}`；没有 `basis_valid`（没给时间）；没有 `basis_covers`（新行）· #89 `s_P` · #90 `s_Pn` · #91–#93 `write.base` `r_P1`（11-11）、`r_P2`（11-12）、`r_P3`（11-13） | 三行 `v88.0`；`basis_decls` 三行 (88, 0, 0)、(88, 1, 0)、(88, 2, 0)：目标 `e_T`、字段 [`f1`, `f2`]、所见 30、范围 `from_now` = [11-10 18:00 起, ∞)、状态"没变"；`basis_edges`：#91–#93 的各项 → 各自 op 的声明 | `status: saved`；每个 op 的 `basis: [{…, state: "current"}]` |

**默认范围在这里合不合理**：W9 3.3 规定状态类表的依据不给时间时，范围 = 从声明那次操作的入口时刻起一直延续。三条计划各自只依据**自己那一天**的目标，默认范围却让每一条都依据"今天起的全部将来"。

| 之后的目标改动 | 按默认范围 | 按 `valid_at: 计划那一天` |
|---|---|---|
| 11-11 起改（本步） | 三条都标 ✓ | 三条都标 ✓ |
| 11-13 起改 | 三条都标（11-11、11-12 两条是错报） | 只标 11-13 那条 |
| 12-01 起改（计划早已过去） | **三条都标**；以后每改一次目标，所有历史计划都再被标一次 | 都不标 |

最后一行说明默认范围的错报会随时间累积：声明是写入时定下的，范围的终点是 ∞，计划行过了那一天也还"依据"着全部将来；被标之后只能逐行重申或改写才能消掉。另外，`date` 粒度的表上，"从入口时刻起"与按日的区间怎么对齐（取入口时刻所在的那一天，还是第二天），W9 没写 → N9。下面按默认范围推（本步的改动两种范围结果相同）。

### 5b 用户把能量目标改成 1800，从明天起（11-10 21:00）

```json
{ "sv": 1, "evidence": [{ "kind": "user_message", "text": "从明天起每天能量目标改成 1800" }],
  "ops": [{ "intent": "update", "table": "daily_targets", "entity": "e_T…", "ver": "v30.0",
            "valid_from": "2026-11-11", "set": { "energy": "1800 kcal" } }] }
```

- 终点不传 → `next_change`：`energy` 在 11-11 之后没有挡点 → 一直延续。解析结果 `[11-11, ∞)`。`protein` 不在 `set` 里，不动。
- 高影响 ①：所见版本里 `energy` 的变化点只有 11-09（无值 ↔ 有值）；这次写入新造出 11-11 一个变化点，没有抹掉已有的 → 不是高影响，直接生效。

| (a) | (b) | (c) | 回执 |
|---|---|---|---|
| #95 `write.head`（原始传参：起点 `2026-11-11`、终点 `next_change`；`now` 11-10 21:00）· #96 `s_T2` · #97 `write.base` `e_T`：`f1` 一项 `[11-11, ∞)` 1800 `applied`，区间块记"解析时用到的别的贡献"（无挡点）· #98 **`basis.changed`**：`targets/0` = `{"table": "t3", "entity": "e_T…", "by_event": 97, "changed": [{"op": 88, "i": 0, "j": 0, "reason": "plan_changed"}, {"op": 88, "i": 1, "j": 0, "reason": "plan_changed"}, {"op": 88, "i": 2, "j": 0, "reason": "plan_changed"}]}` | `e_T`：`[11-09, 11-11)` 2000 / 100、`[11-11, ∞)` 1800 / 100，`ver` = `v95.0`；`basis_decls` 三条转"已变"、原因 `plan_changed`、`since` 95；三条计划的业务表、版本表、`ver` 都不动 | 影响查询：值变化的是 (`energy`, `[11-11, ∞)`)；`rd_2` 记的业务时间条件是 11-10 这一天，与之不相交 → **`rd_2` 不受影响** | `status: saved`；`basis_affected: {count: 3, restored: 0, by_reason: {plan_changed: 3}, rows: [r_P1, r_P2, r_P3]}`；没有 `affected_reads` |

- **检测**（W9 8.3）：这次操作让 (`e_T`, `f1`, `[11-11, ∞)`) 的值变了；按目标 `e_T` 找状态"没变"、字段含 `f1`、范围与 `[11-11, ∞)` 相交的声明：三条，转"已变"。原因：状态类表"原因相同"，变化区间整段不早于"现在"（11-10 21:00）→ `plan_changed`。这一步不读历史值。
- **标记何时出现**：#95 提交的那一刻。目标在 11-11 才生效，但 11-11 的计划行此刻就已带标记——这正是 W9 把默认范围定为"从现在起"而不是读取记录那种"一个点"的理由。对照：读过目标的 `rd_2` 因为只记了 11-10 这一点，没有 `possibly_affected`。两套机制在同一次改动上给出了不同的答案，是有意的（W9 5.2）。
- **谁能看到**：任何读 `meal_plans` 的连接实例。A、K（`nutrition` 在 K 的范围内）读 `r_P1` 都带：

```json
"marks": { "basis_changed": [{ "basis": { "table": "nutrition.daily_targets", "entity": "e_T…" },
  "basis_fields": ["energy", "protein"], "seen": "v30.0", "reason": "plan_changed", "since": 95,
  "fields": ["date", "energy_budget", "protein_budget", "outline"],
  "declared": { "seq": 88, "actor": { "kind": "connection", "id": "ci_A…" } } }] }
```

  MCP 文本：`⚠ 依据已变：daily_targets e_T… 的 energy、protein（声明时所见 v30.0）在 #95 改了之后的安排；涉及本行 date、energy_budget、protein_budget、outline`。
- 依赖行的 `ver` 不变（W9 6.1）：别的 Agent 手里的 `v88.0` 仍可用于写入。

### 5c Agent 改写两天、重申一天（11-10 21:30）

A 重读目标。**不传时间的 `query` 只返回当前段 `[11-09, 11-11)` 2000**，看不到 1800；A 要按标记里的"改了之后的安排"另带 `valid_during: ["2026-11-11", null]` 才读到 `[11-11, ∞)` 1800。工具描述应当说明这一点（标记文本本身已给出操作号）。实体的 `ver` 是 `v95.0`。

用户："11 号、12 号按 1800 排；13 号有聚餐，就按 2000 不变。"另外 A 让 11 号的计划多补蛋白质，参照的是 11-10 午饭那条鸡胸肉明细，所以 11 号那条多声明一条依据（第 11 步要用到）。A 读过 `r_I1`（`v80.0`）。

```json
{ "sv": 1, "task": "plan",
  "evidence": [ { "kind": "user_message", "text": "11 号、12 号按 1800 排；13 号有聚餐，就按 2000 不变" } ],
  "ops": [
    { "intent": "update", "table": "meal_plans", "row": "r_P1…", "ver": "v88.0",
      "set": { "energy_budget": "1800 kcal", "outline": "早：燕麦鸡蛋；午：鸡胸肉 150 克……" },
      "basis": [ { "table": "daily_targets", "entity": "e_T…", "fields": ["energy", "protein"], "ver": "v95.0" },
                 { "table": "meal_items", "row": "r_I1…", "fields": ["protein"], "ver": "v80.0" } ] },
    { "intent": "update", "table": "meal_plans", "row": "r_P2…", "ver": "v88.0",
      "set": { "energy_budget": "1800 kcal", "outline": "……" },
      "basis": [ { "table": "daily_targets", "entity": "e_T…", "fields": ["energy", "protein"], "ver": "v95.0" } ] },
    { "intent": "update", "table": "meal_plans", "row": "r_P3…", "ver": "v88.0",
      "basis": [ { "table": "daily_targets", "entity": "e_T…", "fields": ["energy", "protein"], "ver": "v95.0" } ] } ] }
```

| (a) | (b) | 回执 |
|---|---|---|
| #100 `write.head`：`ops/0/basis/0`、`ops/0/basis/1`、`ops/1/basis/0`、`ops/2/basis/0`（都 `state: current`）；`ops/0/basis_covers` = #91 的 `f1`（`date`）、`f3`（`protein_budget`）；`ops/1/basis_covers` = #92 的 `f1`、`f3`；`ops/2/basis_covers` = #93 的 `f1`–`f4` 四项 · #101 `s_P2` · #102 `write.base` `r_P1`（`f2` 1800、`f4` 新文本 `applied`）· #103 `write.base` `r_P2`（同形）。第 2 个 op 没有 `write.base`。没有 `basis.changed`（这次操作没改任何依据目标的值） | `r_P1`、`r_P2` 的 `ver` 换成 `v100.0`；`r_P3` 仍是 `v88.0`；`basis_decls` 加 (100, 0, 0)、(100, 0, 1)、(100, 1, 0)、(100, 2, 0)；`basis_edges`：#102、#103 的新项 → 本 op 的声明；#91–#93 被覆盖的各项对目标 `e_T` 的有效声明改指 (100, i, 0)；(100, 0, 1) 只覆盖 `r_P1` 的出处项对目标 `r_I1` 的边 | `status: saved`；`ops[2].fields: {}`、`basis_covered: 4` |

- **三条的标记怎么消**：`r_P1` 当前值的出处项是 #91/`f1`、#102/`f2`、#91/`f3`、#102/`f4`，对目标 `e_T` 的有效声明都是 (100, 0, 0)，状态"没变" → 没有标记。`r_P2` 同理。`r_P3` 是**重申**（不带 `set` 的 `update`）：四项的有效声明都换成 (100, 2, 0)，行的值与 `ver` 不动 → 没有标记。旧声明 (88, *, 0) 留在 `basis_decls` 里、状态仍是"已变"，但已不是任何当前出处项的有效声明，不再维护。
- **重申要不要带 `ver`**：带了 `v88.0`；它只覆盖"所见版本上就已生效、现在仍生效"的项。
- **`r_P3` 按 2000 重申、目标已是 1800**：saveslot 不判断它成不成立，只记"A 在看过 `v95.0` 之后说它仍成立"。
- 之后谁读 `meal_plans`：三行都没有标记；`detail: "detailed"` 时每行列出当前的全部声明。

**并排（本步没有撤销、隐私删除或 `undo`，只核对标记的判定）**：W9 的"不变式"——状态"没变"的声明，其范围上现在的值等于所见的值——在 #100 之后对 (100, *, *) 成立：`e_T` 在 `[11-10 21:30, ∞)` 上的值与 `v95.0` 相同；`r_I1` 的 `protein` 与 `v80.0` 相同 ✓。

**核对**：K3 标记的变化只经 #98 的 `basis.changed` 由 `apply` 落账，读时现算只读 (b) 类 ✓；K7 原因的划分用 #95 头里的 `now`，重放不读时钟 ✓；K8 #95 的 `ver` 是当前的；#100 带 `v88.0`，是三行当前的 `ver` ✓；K10 `rd_2` 只有版本号与业务时间条件 ✓；K12 `basis_decls`、`basis_edges` 全由 #88、#98、#100 的元数据块重建 ✓。

## 第 6 步：连接器首次同步 60 条历史明细（11-11 02:00）

某饮食 App 里有 60 条明细（10-12 至 11-10），其中 11-09 晚饭的两条与 11-10 午饭的三条，用户当时在 App 里也记过一遍，与 A 手记的 `r_I4`、`r_I5`、`r_I1`–`r_I3` 在（`date`, `food`, `amount`）上相同（App 里鸡胸肉同样是 150 g）。连接器每页取 20 条，分三批写入，**不带证据**，不填 `meal`。

每个 op 的写法（W8 3.3）：

```json
{ "intent": "update", "table": "meal_items",
  "external_key": { "origin": "diet_app", "external_id": "d-1105-2" },
  "set": { "date": "2026-11-05", "food": "燕麦", "amount": "50 g", "energy": "190 kcal", "protein": "6.5 g" } }
```

| 批 | 操作号 | (a) | (b) | 回执 |
|---|---|---|---|---|
| 1（10-12 至 10-24） | #110 | `write.head`（20 个 op 的 `target` 都带 `by_external_key: true`、`created: true`，各 op 的原始传参含键值）· 20 条 `source.recorded`（`api_call`，每个 op 一条，只含该 op）· 20 条 `write.base`（键字段 `f7`、`f8` 与其余字段都是 `applied`）· 每个新出现的日子一条 `write.derived`（首次出现，带 `key` 块） | 20 行 `r_X1`–`r_X20`，`ver` = `v110.0`；`external_keys` 加 20 条（状态"在"）；`daily_totals` 加这些日子的行 | `status: saved`；`external_key_summary: {created: 20, updated: 0, unchanged: 0, pending: 0, skipped: 0}` |
| 2（10-25 至 11-04） | #160 | 同形 | `r_X21`–`r_X40`，`v160.0` | 同上 |
| 3（11-05 至 11-10） | #210 | 同形，另有 5 条 `item.created`（`flagged`）：`pi_2`–`pi_6` | `r_X41`–`r_X60`，`v210.0`；11-09 的 `p_0`、11-10 的 `p_1` 重算 | `status: saved`；`created: 20`；`pending: [pi_2 … pi_6]`；`warnings` 无 |

- **分批**：60 个 op 的准入估算很小（每天的分区只有几行），一次交完也不会 `too_large`；分三批是连接器按自己的分页做的。三批之间互不依赖：中途失败重跑时，已建的行按来源键命中，内容没变的是 `unchanged`，不会重复新增（W8 1 第 6 条）。若一批在幂等窗口内原样重发，命中请求键，`replayed: true`。
- **`duplicate_keys` 起作用**：按来源键新增的行照常判疑似重复（W8 3.7）。第 3 批里 `r_X56`–`r_X60` 各与一条手记行在（`date`, `food`, `amount`）上同值 → 写入照常生效，每行一个 `flagged` 事项，列出命中的手记行与命中的键组。前 55 条不命中。
  - 这只在三项**一字不差**时成立。`food` 是 `text`，同值是 NFC 后逐码点相同：App 写"白米饭"、A 写"米饭"，或 App 记 151 g，就不命中，重复的那一餐会被静默算两次。
- **每日合计**：11-09 = 415 + 415 = 830 kcal；11-10 = 489.5 + 489.5 = 979 kcal、112.0 g；`meal_count` 仍分别是 1（连接器的行 `meal` 为空，`count(DISTINCT meal)` 不计空值）。读 `daily_totals` 时，这两天带派生行的汇总标记：`input_marks: {flagged: 2}` / `{flagged: 3}`（"本值的输入里有 3 行已标记"）。
- **用户看到几个待处理事项**：5 个，都是 `flagged`（另有 0 个冲突、0 个待确认）。
- **怎么处理这 5 个都有代价**：`keep` 是让同一餐算两次；`revoke` 连接器那一行，以后同步命中已撤销的行被跳过，App 里这条记录之后的修改再也进不来；`revoke` 手记那一行，失去"属于哪一餐"。最自然的做法——把来源键挂到手记那一行上、合并成一行——第一版做不到（W8 3.2："没有来源键的行不能事后补上键"）→ N11。本推演里用户暂不处理，5 个事项保持未决。

**核对**：K1 键值只在数据块里，`by_external_key` 是布尔 ✓；K4 每个有贡献的 op 一条 `api_call` ✓；K5 ✓；K12 定位结果（行 ID）记在 `write.head` 的 `target` 里，`apply` 不定位 ✓；K13 三批各有请求键 ✓。

### 第 6、7 步之间发生的事（11-11 白天）

| 操作号 | 谁 | 做了什么 | 结果 |
|---|---|---|---|
| #250 | A | 用户："10-15 那条燕麦记错了，删掉。"`revoke` `r_X10`（`v110.0`），没人引用它 | `r_X10` 已撤销，`v250.0`；10-15 的合计重算 |
| #252 | A | 用户："10-18 的酸奶其实是 100 克，不是 80 克。"`correct` `r_X12`：`amount` 100 g、`energy` 按比例改（`v110.0`）。下文称这条"只在本地改过" | `r_X12` `v252.0` |
| #254 | A | 用户："10-26 那份牛排能量记成 280 吧，App 里写多了。"`correct` `r_X21`：`energy` 300 → 280 kcal（`v160.0`） | `r_X21` `v254.0` |
| #256 | A | 用户："10-30 那条记录（某个私人聚会的菜）彻底删掉。"`deletion_preview {kind: privacy, sources: [s_X30]}`（`r_X30` 只有 #160 里它自己那条 `api_call` 一个来源）→ `dc_1`；`delete confirm=dc_1` | #256 `deletion.confirmed`（`pi_7`，宽限期到 11-12 14:00）· `write.derived` 10-30 重算；`external_keys` 里 `r_X30` 的条目转"占位"（记 `pi_7`）。预览写明"`r_X30` 整行删除"，并给 `external_key_resync` 提醒（W8 3.6） |
| — | App 侧 | 用户在 App 里改了 `r_X40`（11-04 鸡蛋，能量 140 → 150）、`r_X41`（11-05 燕麦，蛋白质 6.5 → 7.0）、`r_X21`（能量 300 → 320）；`r_X12`、`r_X10`、`r_X30` 在 App 里没动 | — |

## 第 7 步：第二次同步同样的 60 条（11-11 20:00，`pi_7` 的宽限期内）

连接器照样分三批（#270、#272、#274），每条记录交来 App 里的当前值。逐条按 W8 3.4 的三方比较（基线值 = 该字段最近一项同步贡献的值；基线位置 = 该冲突单元上最近一项已生效的同步贡献的操作号）：

| 行 | 上次交来（基线值） | 当前生效值 | 这次交来 | 基线位置之后改过这个字段的操作 | 结果 | 落账 |
|---|---|---|---|---|---|---|
| `r_X40` energy | 140 | 140 | 150 | 无（基线位置 #160） | `updated`：150 生效 | `api_call` 一条；`write.base`：`f5` 150 `applied`，键字段 `f7`、`f8` `corroborated`；11-04 合计重算 |
| `r_X41` protein | 6.5 | 6.5 | 7.0 | 无（#210） | `updated` | 同上，11-05 合计重算 |
| `r_X12` amount / energy | 80 g / 原值 | 100 g / 新值 | 80 g / 原值 | — | `unchanged`：与基线值相同 → 无操作。**本地的纠正不被盖回去** | 只有 `write.head` 里的 `target` 与 `noop`；不存 `api_call`；`ver` 不变 |
| `r_X21` energy | 300 | 280 | 320 | #254（A 的纠正） | `pending`：320 成为候选；冲突事项 `pi_8`（目标（`r_X21`, `f5`），候选所带的 `ver` = 基线位置 #160） | `api_call` 一条；`write.base`：`f5` 320 `candidate`，键字段 `corroborated`；`item.created pi_8`。生效值仍是 280，没有派生写入 |
| `r_X10` | — | 已撤销 | 原值 | — | `skipped`（`revoked`，`revoked_by: 250`） | `write.head` 里只有 `target`（`skipped: "revoked"`）；什么都不落 |
| `r_X30` | — | 已在删除里 | 原值 | — | `skipped`（`pending_deletion`，`deletion: pi_7`） | 同上（`skipped: "pending_deletion"`）；键仍被占位，**不重新新增** |
| 其余 54 条 | 同 | 同 | 同 | — | `unchanged` | 同 `r_X12` |

三批合计：`external_key_summary: {created: 0, updated: 2, unchanged: 55, pending: 1, skipped: 2}`；含候选的那一批 `status: pending`，另两批 `saved`；`warnings: external_key_skipped`（列出被跳过的 op 下标）。日志里：3 条 `write.head`、3 条 `api_call`、3 条 `write.base`、1 条 `item.created`、2 条 `write.derived`。

- **`r_X21` 的冲突事项由连接器的写入引出**，连接器不会处理它。它要等用户经 A 处理（第 9 步）。之后再同步 320：基线值已是 320（候选也是同步贡献）→ `unchanged`，同一个候选不会每次再并入一遍。
- **用户此时看到的待处理事项**：5 个 `flagged`（第 6 步）+ 1 个 `conflict`（`pi_8`）+ 1 个 `deletion`（`pi_7`，宽限期内可撤回）= 7 个。
- **被跳过的 op 的内容去了哪**：`skipped` 与 `unchanged` 的 op 在任何块里都不留值（W8 3.8）。但这三批的请求键与内容指纹是"按规范化后的请求内容"算的哈希，请求内容里有全部 60 条记录的值——**包括已列入删除的 `r_X30`**。请求键的来源是"该操作的全部证据"，而这三批只有 3 条 `api_call`；`r_X30` 那一条的内容进了一个与 `s_X30` 无关、只随别的行的 `api_call` 删除的哈希。若某一批 20 条全部 `unchanged`，这一批**没有任何源数据**，它的请求键按「由源数据派生出的内容」"操作没有任何源数据时没有来源，不在级联范围"，永远不会被清除。事件格式 9.5 写的已知边界是"同一次请求原样带回的值、随那次请求自己的证据删除"；这里是另一回事：每次同步都把全部记录的内容重新哈希一遍，其中可以包括已经确认删除的那一条 → N12

**核对**：K8 按来源键的写入所见版本 = 基线位置，判据不变；`r_X21` 两种到达顺序（A 的纠正先到 / 同步先到）都得出"一边生效、另一边成为候选"✓；K11 宽限期内 `r_X30` 不因同步复活 ✓；**K11 / K1 的"由内容算出的值随内容删除"在请求键上不成立**（N12）；K14 `pi_8` 未经处理不执行 ✓。

## 第 8 步：宽限期结束后的第三次同步（11-12 20:00）

| 操作号 | (a) | (b) |
|---|---|---|
| #290（11-12 14:00） | `deletion.executed`（墓碑，`actor: system`，`trigger: deletion_expiry`）：`s_X30` 原文、#160 头里 op 的原始传参（含键值）、`r_X30` 各字段的值块、10-30 那次派生写入的 `checksum` 等位置一并物理删除 | `external_keys` 里 `r_X30` 的占位条目去掉；`pi_7` 已解决（"已执行"） |

第三次同步（#300、#302、#304），60 条都按 App 里的当前值交来：

| 行 | 结果 |
|---|---|
| 原 `r_X30` 那条记录（`d-1030-1`） | 键索引里没有这个键 → `created`：**新增一行 `r_X61`**，值与被删的那行相同；照常过疑似重复——当前表里没有与它同值的行，不命中 |
| `r_X10` | `skipped`（`revoked`） |
| `r_X21` | 交来 320，基线值 320 → `unchanged`（`pi_8` 仍未决） |
| `r_X40`、`r_X41` | 交来 150 / 7.0，与基线值相同 → `unchanged` |
| 其余 | `unchanged` |

汇总：`{created: 1, updated: 0, unchanged: 58, pending: 0, skipped: 1}`，`status: saved`。

**预览与回执怎么提示**：

| 时刻 | 提示 |
|---|---|
| 删除预览、删除回执（#256） | `external_key_resync`："这些行来自外部系统；删除后若连接器再次同步同一条记录，它会重新出现。要彻底忘掉，先在来源系统里删除，或让连接器停止同步它。" |
| 第二次同步（宽限期内） | 给连接器的回执：`skipped: pending_deletion`，附删除 ID |
| 第三次同步 | **没有任何提示**：对 saveslot 来说这就是一条从没见过的新记录（"删除后不可比对"，W8 3.6）。回执只是 `created: 1`；用户这边没有事项、没有标记 |

**并排**：

| | 参考语义（假如 `s_X30` 从未存在过） | 按 W8 推出 |
|---|---|---|
| 删除后、到期前 | 没有 `r_X30`；同步不应写入 | 没有 `r_X30`；同步被跳过 ✓ |
| 到期后再同步 | 定义只约束"日志里的源数据"，不约束外部系统：一条新的同步写入就是一条新的源数据，产生一行是定义允许的 | 新增 `r_X61` ✓（与定义一致） |
| 用户的期望（"彻底删掉"） | — | 一天后它回来了，没人被告知 → N13 |

**核对**：K1 墓碑只有位置与原因码 ✓；K11 墓碑与删除登记不存键值，所以无法拦截 ✓（这正是 N13 的原因）；K12 `external_keys` 由 #290 去掉占位、由 #300 的结果加回新条目 ✓。

## 第 9 步：处理"两边都改了"的冲突，然后 `undo` 这次处理（11-13）

起点：`r_X21` 的 `energy`（`f5`）上，#160 连接器创建时 300（同步贡献，生效）→ #254 A 纠正为 280（生效）→ #272 连接器交来 320（同步贡献，候选）。`pi_8`：生效值 280，候选 320（所带 `ver` = `v160.0`），合并基 = `v160.0`，`take_previous` 会回到 300。

两个基线（W8 3.4），此刻：

| 基线 | 定义 | 值 |
|---|---|---|
| 基线值 | 这个字段上最近一项同步贡献的值（不论生效、佐证、候选、待确认） | 320（#272 的候选） |
| 基线位置 | 这个冲突单元上最近一项**已生效**的同步贡献所在的操作号 | #160（#272 在 `f5` 上是候选；它给键字段的佐证在 `f7`、`f8` 两个冲突单元上，不算） |

### 9a 主线：用户选保留本地值（`keep_effective`）

A 读 `pi_8` 详情（拿到 `item_ver`），用户说"按我改的 280"：

| (a) | (b) | 回执 |
|---|---|---|
| #320 `item.resolved`（头；`decision: keep_effective`；确认记录的内容哈希在内容区）· #321 `source.recorded` `s_9`（用户那句话，操作来源） | `pi_8` 已解决；`r_X21` 不动（280，`v254.0`）；`disputed` 标记撤掉 | `resolved`；没有写入、没有派生写入 |

基线：基线值仍是 320，基线位置仍是 #160（`keep_effective` 不触发写入）。下次同步交来 320 → `unchanged`；交来 330 → 候选、新冲突（W8 3.4 表的倒数第二、最后一行）✓。

**然后 `undo` 这次处理**：`revert: {undo: 320}` 作用于 `r_X21`。按 04-write-and-read「撤回某次写入」的表，可撤回的是"由 `resolve` 触发的写入"；`keep_effective` 不触发写入，#320 在 `r_X21` 上没有任何基础写入，所以是"不是这一行 / 实体的写入"或"没有可撤回的改动"，报 `invalid_argument`（`not_this_target`），不产生事件。**用户"撤回这次处理、回到还没决定的时候"没有任何办法做到**：事项已关闭（`item_closed`），候选 320 不会再出现在任何事项里；A 只能手动写一次 320（普通写入，不是同步贡献，基线不变）→ N14。

伪代码在这里没有输入：没有回掉发生。为了检验伪代码与两个基线，下面推另外两种处理方式，各接一个 `undo`（两条都是从 9a 之前分出去的分支，与主线不同时成立）。

### 9b 分支：`take_candidate` 后 `undo`

**#320' `take_candidate`**：由解决触发的写入，头事件是 `item.resolved`；`write.base` `r_X21`：`f5` 320 `applied`，值来源 = 对 #272 那一项贡献的引用（`carried`）。`ver` → `v320.0`，10-26 合计重算。W8 3.4 明文：采纳时搬运出的那一项是同步贡献 → 基线值 320、基线位置 #320'。

**#330 `undo` #320'**（意图省略：由 `resolve` 触发的写入沿用被执行的那次写入的意图，即 #272 的 `update`）：

| 步 | 求得 |
|---|---|
| 输入 | R = [(#320' 的 `write.base`, `f5`, 0)]；pos = 操作 320' 之前；n = 330 |
| 1 | R' = R；在 = [#320' 的搬运项]（生效） |
| 2 | 域 = ⊤ |
| 3 | 盖住：320' < 操作号 < 330 之间没有改 `f5` 的生效项 → 范围 = ⊤ |
| 4 | 生效 |
| 5 | 登记：#320' 的项在 ⊤ 内已被 330 回掉 |
| 6 | S = 操作 320' 之前 `f5` 上最后一个生效、未被登记回掉的项 = #254 的 280 → 写回 280，值来源 = 对 #254 那一项的引用 |
| 7 | 写回项生效 |

结果 `energy` = 280，`v330.0`。参考（回到采纳之前的值）= 280 ✓。

基线：

| 基线 | 按 W8 的文字 | 说明 |
|---|---|---|
| 基线值 | 320 | #320' 的搬运项仍是同步贡献（W8 3.7："被回掉的项仍是同步贡献，基线值不变"） |
| 基线位置 | **#320' 还是 #160？** | #320' 的项在事件里是 `applied`，但"被回掉的项是否生效以回退记录为准"——它已被 #330 登记为回掉。"已生效的同步贡献"算不算它，W8 没写（W8 §10 自己列出了这个问题） |

下一次同步：交来 320 → 两种读法都是 `unchanged`（与基线值相同），280 保持 ✓；交来 330 → 位置取 #320' 时 #330 在其后，取 #160 时 #254、#320'、#330 在其后，**都是候选**。这一分支上两种读法看不出差别，但参考求值器要一个确定的定义 → N15。

### 9c 分支：`take_previous` 后 `undo`

**#320'' `take_previous`**：

| 步 | 求得 |
|---|---|
| 输入 | R = 合并基 #160 之后、解决之前在 `f5` 上生效过的全部项 = [(#254, `f5`, 0)]（候选 #272 不在其中）；pos = 截至操作 160；n = 320''；K = [#272 的候选项] |
| 1 | R' = R；在 = [#254 的项] |
| 2 | 域 = K 里没被删的项的区间之并 = ⊤ |
| 3 | 254 < 操作号 < 320'' 之间、不在 R' 里、改 `f5` 的生效项：没有 → 范围 = ⊤ |
| 4 | 生效 |
| 5 | 登记：#254 的项在 ⊤ 内已被 320'' 回掉 |
| 6 | S = 截至 160 的 `f5` = #160 的 300 → 写回 300，值来源 = 对 #160 那一项（连接器的同步贡献）的引用 |
| 7 | 写回项生效，不参加同值重算 |

意图：回退记录里 `seq` 最大的一项所在 `write.base` 的意图 = #254 的 `correct` → 触发纠错影响查询。结果 300，`v320.0`。

基线：W8 只规定了"采纳候选时搬运出的那一项"算同步贡献，`take_previous` 写回的项**搬运的也是一项同步贡献**（#160），算不算没写（W8 §10 的倾向是"不算"）。两种读法下一次同步的结果**不同**：

| 读法 | 基线值 | 基线位置 | 下次同步交来 320（App 没再改） |
|---|---|---|---|
| 不算（W8 §10 的倾向） | 320（#272） | #160 | `unchanged`：保持 300 ✓ 用户"回到冲突前"的决定被尊重 |
| 算 | 300（#320'' 的写回项） | #320'' | 320 ≠ 300，基线位置之后没人改过 → **320 直接生效**：用户刚刚拒绝过的那个值在下一次同步时被写上，没有任何事项 |

→ N15（这里是看得到后果的一处）。

**#330 `undo` #320''**（"回掉的目标本身是一次回掉：按普通写入处理"）：

| 步 | 求得 |
|---|---|
| 输入 | R = [(#320'' 的写回项, `f5`, 0)]；pos = 操作 320'' 之前；n = 330 |
| 1–3 | 在 = [#320'' 的写回项]；范围 = ⊤ |
| 5 | 登记：#320'' 的写回项已被 330 回掉；#254 被 320'' 登记的回掉**不动** |
| 6 | S = 操作 320'' 之前 `f5` 上最后一个生效、且没有被操作号小于 320'' 的回掉登记过的项。#254 被 320'' 登记过，但 320'' 不小于 320''，这次登记不算 → S = #254 的 280 → 写回 280，引用 #254 |

结果 280。`pi_8` 保持已解决。

**并排（9b、9c 的 `undo`）**：

| | 参考语义（用户的意思：撤回这次处理，回到"冲突未决、生效 280、候选 320"） | 按文档推出 |
|---|---|---|
| `energy` 的值 | 280 | 280 ✓ |
| 冲突事项 | 未决，候选 320 仍可采纳 | `pi_8` 保持已解决；候选 320 不在任何未决事项里 ✗ |
| 下一次同步交来 320 | 应当仍在争议里 | 基线值 320 → `unchanged`：320 再也不会出现，除非 App 里又改了这条 |

伪代码算出的值与参考一致；不一致的是事项：`undo` 一次解决不会重开事项，而来源键的基线又让同步不再把候选交回来，于是候选永久消失 → N14。

## 第 10 步：连接器的凭证越界（11-13）

K 的 slot 范围只有 `nutrition`，scope 只有读写。都是被拒的请求，不产生事件；读取被拒也不记 read_log。

| 调用 | 结果 | 依据 |
|---|---|---|
| `query`，`table: "ledger.expenses"` | `unknown_table`（`name: "ledger.expenses"`），`nearest` 只从 `nutrition` 的名字里取（没有相近的 → 空数组） | W8 2.2 |
| `query`，`table: "expenses"`（只写表名） | 同上。名字解析只在可见范围内做，不会因为范围外有一张 `expenses` 而报歧义或解析过去 | W8 2.2 |
| `sql`：`SELECT sum(amount) FROM expenses` | `sql_rejected`（`unknown_name`） | W8 2.3 |
| `history`，目标是 `ledger` 里某一行的行 ID（表写 `meal_items`） | `not_found`，与行 ID 不存在相同 | W8 2.2 |
| `pending` 查 `ledger` 里某个事项的 ID；`sources` 带 `slot: "ledger"` | `not_found`；`not_found`（`slot`） | W8 2.2 |
| `write`：`insert` 到 `ledger.expenses` | `unknown_table`；整个请求不生效 | W8 2.3 |
| `schema_draft` 新建 slot `sleep` | `insufficient_scope`。**`required_scope` 给哪个没定**：K 本来就没有 `saveslot.schema`（contract 第 12 节），同时又是限定范围的凭证（W8 2.4 规定报 `required_scope: "all_slots"`）。两者都成立时报哪个、能不能两个都列，W8 没写 → N17 | contract 第 12 节；W8 2.3、2.4 |
| `schema_draft` 改 `nutrition` | `insufficient_scope`（`required_scope: "saveslot.schema"`） | contract 第 12 节 |
| `GET /v1/slots` | 只有 `nutrition` | W8 2.7 |

**核对**：K2 被拒的请求不产生事件，没有 actor 问题 ✓；K10 被拒的读取不记 ✓；可见范围不改变判定（W8 2.3 末条）✓。范围外的名字没有出现在任何报错与候选里 ✓。

## 第 11 步：隐私删除第 2 步那一餐的源数据（11-13 22:00）

用户："把我说 11-10 午饭吃了什么的那句话删掉。"被删集合 = {`s_1`}。此刻 11-10 的状态：手记的 `r_M1`、`r_I1`–`r_I3`（#80 恢复后，`r_I1` 的份量与能量来自 #53）；连接器的副本 `r_X58`–`r_X60`（`flagged` 事项 `pi_4`–`pi_6` 未决，各列出一条手记行）；计划 `r_P1` 在 #100 声明过依据 `r_I1` 的 `protein`。

**重放**（03-deletion「重放规则」）：① 找受影响的行——`s_1` 是 #43 的 `date`、`meal_type`、`eaten_at` 与 #44–#46 的 `meal`、`date`、`food`、`amount` 的值来源；② 去掉这些贡献；③ 把这四行的全部写入按 `seq` 重放。

| 行 | 去掉之后还剩的贡献 | 存在吗（每个必填字段至少一项仍在的贡献） | 结果 |
|---|---|---|---|
| `r_M1` | 无（#75 撤销、#80 恢复存在是"存在"上的决定，不是字段贡献） | `date`、`meal_type` 都没有 | 整行删除 |
| `r_I1` | `amount`、`energy`、`protein` ← #53（`s_2`、`s_2n`） | `date`、`food` 没有 | 整行删除 |
| `r_I2`、`r_I3` | `energy`、`protein` ← #44 的 `s_1n` 那一部分 | `date`、`food`、`amount` 没有 | 整行删除 |

**删除预览**（A，`deletion_preview {kind: privacy, sources: [s_1]}` → `dc_2`）列出：

| 项 | 内容 |
|---|---|
| 总量 | 删除 1 条源数据；影响 4 行（整行删除 4）；重算 1 个派生值（`daily_totals` 11-10） |
| 逐行结果与依据 | "`r_I1` 整行删除：`date`、`food` 只来自这句话；`s_2` 的纠错只给了 `amount`、`energy`、`protein`。可先用其他证据（`source_ref` + `evidence_by_field`）佐证缺的字段再删。""`r_I2` / `r_I3` 整行删除：`date`、`food`、`amount` 只来自这句话；同一次写入里另有 `s_1n`，它只给了 `energy`、`protein`。""`r_M1` 整行删除：全部字段只来自这句话。" |
| 仍引用被删行的行 | 无（引用 `r_M1` 的三条明细也被整行删除） |
| 因删除被取代的事项 | `pi_4`–`pi_6`（被比中的手记行被整行删除） |
| 依据将被改动的行（W9 10.2 的预告） | `meal_plans` `r_P1`：声明过依据 `meal_items r_I1` 的 `protein` |
| 原本未生效、将会生效的写入 / 将转为待确认的写入 | 无 |
| 不会删除 | schema 里的说明与枚举值；`s_1n`、`s_2`、`s_2n` 这几条源数据本身（不在被删集合里）；保留的元数据（事件头、`ops/<i>/basis/<j>` 等元数据块）；连接实例名称 |

A 照预览确认：`delete confirm=dc_2`。

| (a) | (b) | (c) |
|---|---|---|
| #340 `deletion.confirmed`：结果 = 四行整行删除、新的 `daily_totals` 结果、被取代的事项、到期时刻（11-14 22:00）、位置列表（`s_1` 原文；#40 头里的请求键与内容指纹、`task`、`ops/0/refs` 临时名、四个 op 里来源含 `s_1` 的原始传参；#43–#46 里对应字段的值块与字面命中记录；#62 / `pi_1` 里引用 `r_M1` 版本的影响条目；`pi_4`–`pi_6` 的判定依据；读集含这些贡献的各次派生写入的 `checksum`；`dc_2` 的影响摘要哈希）· #341–#343 `item.superseded` `pi_4`–`pi_6`（原因码 `deleted`）· #344 `basis.changed`：`targets/0` = `{"table": "t2", "row": "r_I1…", "by_event": 340, "changed": [{"op": 100, "i": 0, "j": 1, "reason": "deleted"}]}` · #345 `write.derived` `p_1` | 四行从业务表、版本表的当前视图里读不到；`s_1` 读不到；全文索引隐藏；`daily_totals` 11-10：979 → **489.5 kcal**、112.0 → **56.0 g**、`meal_count` 1 → **0**（剩下的都是连接器那三条，`meal` 为空）；`p_1` 的映射不清除（`r_X58`–`r_X60` 仍带 11-10 这个键值）；`basis_decls` (100, 0, 1) 转"已变"，原因 `deleted`，`since` 340；`deletion` 事项 `pi_9` | 删除到期索引写入控制面（先于租户事务）；`rd_1` 的 `possibly_affected` 只撤不增 |

**各处变成什么**：

| 对象 | 参考语义（假如 `s_1` 从未存在过） | 按文档规则逐条推出 |
|---|---|---|
| 一餐 `r_M1` | #40 的插入没有贡献，这一行从未存在；#70 的撤销、#80 的恢复是人的决定，照记录，但作用在一行不存在的行上 | 整行删除 ✓ |
| 明细 `r_I1`–`r_I3` | 同上；`r_I1` 只剩一次纠错给的份量与能量，撑不起一行 | 整行删除 ✓；`s_2`、`s_2n`、`s_1n` 作为源数据保留，它们产生的数据为空 |
| 连接器的副本 `r_X58`–`r_X60` | 来源是 App 的 `api_call`，与 `s_1` 不相交，不动 | 不动 ✓；与手记行之间的唯一联系（`flagged` 事项）被取代、判定依据清除 |
| 每日合计 11-10 | 只剩副本：489.5 kcal · 56.0 g · 0 餐 | 同 ✓ |
| 计划 `r_P1` | 删除不沿依据传播，值不变（W9 5.4） | 值不变 ✓；带标记：`⚠ 依据已变：meal_items r_I1… 的 protein（声明时所见 v80.0）在 #340 被删除；涉及本行 date、energy_budget、protein_budget、outline`。这是 W9 有意偏离"只撤不增"之处 |
| 计划 `r_P2`、`r_P3` | 没有依据 `r_I1` | 不动、不标 ✓ |

**之后标记怎么消**：W9 §15 第 6 条说"不再依赖某一行时，重申一次即可消掉标记"。逐条试：

| 做法 | 结果 |
|---|---|
| 重申 `r_P1`，`basis` 只写 `e_T` | 新声明只取代（出处项, `e_T`）上的边；（出处项, `r_I1`）上的有效声明仍是 (100, 0, 1)，状态"已变" → **标记还在** |
| 重申 `r_P1`，`basis` 写 `r_I1` | 依据指向已被隐私删除的行 → `not_found`（W9 10.3），被拒 |
| 改写 `r_P1` 的 `energy_budget`、`outline` 并带新依据 | 这两项的出处项换成新的、不再被 (100, 0, 1) 覆盖；但 `date`、`protein_budget` 的出处项仍是 #91 的项 → 标记还在，`fields` 变成 [`date`, `protein_budget`] |
| 再把 `date`、`protein_budget` 原样写一遍 | 与所见版本同值 → 无操作，不产生出处项；显式指证据 → 佐证，佐证项加入出处项，但 #91 的项仍是当前值的出处项 → 标记还在 |
| 撤销 `r_P1` 再新增一条同样的计划 | 标记消失（旧行不在逻辑表里），代价是行 ID 换了、历史断开 |

即：依据目标被隐私删除之后，依赖行上的这条标记**只能靠改掉每一个被覆盖字段的值或撤销整行才能消掉**，`date` 这样的必填字段改不了值 → N16。

- **预览没提的**：`s_1n` 与 `s_2n` 是 A 对这顿饭的转述（"鸡胸肉 100 g 165 kcal……"），删除 `s_1` 之后它们仍在，内容上就是用户想删的那顿饭；`s_2` 是用户的另一句话（"鸡胸肉其实是 150 克"）。规格把它们算作"作为源数据保留，产生的数据为空"，预览的"不会删除"里不单列这类"删除后将不再支撑任何数据的源数据"→ N6

**核对**：K1 #340 事件头 = 类型、actor A、删除 ID、所引用事件的 `seq`，没有内容 ✓；#344 全是元数据 ✓；K3 ✓；K5 `p_1` 同事务重算 ✓；K11 结果与参考语义一致；`flagged` 事项按"被比中的行被整行删除"取代；`possibly_affected` 只撤不增 ✓；K12 结果写进 #340，`apply` 照做，标记的变化写进 #344 ✓。

---

## 核对汇总

✓ = 这一步涉及、成立；⚠ = 涉及、有问题（见问题号）；空 = 这一步不涉及。

| K | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| K1 事件头无内容、只追加 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ⚠ N12 | ✓ | ✓ | | ✓ |
| K2 actor 已登记 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓（墓碑记 `system`） | ✓ | ✓ | ✓ |
| K3 物化状态只经 `apply` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ |
| K4 每次基础写入都有源数据 | | ✓ | ✓ | ✓ | ✓（重申没有基础写入，仍存 `api_call`） | ✓ | ✓（无贡献的 op 不存，W8 有意收窄） | ✓ | ✓ | | ✓ |
| K5 派生同事务刷新 | | ✓ | ✓ | ✓ ⚠ N7、N8 | | ✓ | ✓ | ✓ | ✓ | | ✓ |
| K6 schema 不可变 | ✓ | | | | | | | | | | |
| K7 内核不读时钟 | | ✓ | ✓ | | ✓ | | | | | | |
| K8 版本对不上不覆盖、顺序无关 | | | ✓ | ⚠ N5（同请求内 op 的顺序改变结果） | ✓ | | ✓ | | ✓ | ✓ | |
| K9 受限 SQL 白名单 | ⚠ N3 | | | | | | | | | ✓ | |
| K10 read_log 只记版本 | | ✓ | ✓ ⚠ N4（派生读取第一版不覆盖） | ✓ | ✓ | | | | | ✓ | ✓ |
| K11 隐私删除按参考语义 | | | | | | | ✓ ⚠ N12 | ✓ ⚠ N13 | | | ✓ ⚠ N16 |
| K12 重放一致 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ⚠ N15（定义未定，参考求值器无法实现） | | ✓ |
| K13 恰好一次 | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ |
| K14 确认绑定内容 | | | | ✓ | | ✓ | ✓ | | ⚠ N14 | | ✓ |

## 问题清单

**阻断**：落规格前必须定，否则事件格式或核心承诺有缺口。**需改**：规则写得含糊或互相矛盾，推下去结果不唯一或不合理。**可选**：说明不足、提醒不够，不影响结果的唯一性。

| # | 严重程度 | 针对 | 在哪一步 | 问题 | 读法与后果 | 倾向 |
|---|---|---|---|---|---|---|
| N12 | 阻断 | W8 §3.8；规格 事件格式 9.5、03-deletion「由源数据派生出的内容」 | 7 | 同步请求的请求键与内容指纹按全部请求内容算哈希，里面有 `unchanged`、`skipped` 的 op 的值；W8 又规定这些 op 不存 `api_call`。于是：① 一批全部 `unchanged` 的请求**没有任何源数据**，它的请求键"不在级联范围"，永远不清除；② 已确认删除的 `r_X30` 的内容，在宽限期内又被下一次同步哈希进一个新的请求键，这个键只随别的行的 `api_call` 删除 | 甲：照现文，接受为已知边界的扩大——每次同步都把全部记录重新哈希一遍，"删除后不可比对"对来源键表基本不成立。乙：按来源键的请求，请求键只对**有贡献的 op** 规范化（或按 op 分别算键）。丙：给 `unchanged` / `skipped` 的 op 也存一条最小的 `api_call`，让请求键有来源 | 乙：既不让日志随同步次数膨胀，也让请求键的来源与内容一致。要在事件格式 v1 冻结前定 |
| N5 | 需改 | 规格 04-write-and-read「引用字段」「同一请求里的多个 op」；05-time「高影响写入」 | 4b | 高影响 ② 数"仍被引用"用的是"当前版本里未撤销的行"，没说是否叠加本请求前面 op 的结果（① 与同值都明文写了叠加）。另外"别的行新增或去掉对该行的 `ref` 时刷新影响"没说引用方**被撤销**算不算"去掉" | 甲（叠加）：先撤明细再撤一餐，一次完成；反过来排要多一次 `resolve`。乙（不叠加）：两种顺序都要多一次 `resolve`，事项的影响列着已撤销的引用方或为空，仍要人确认 | 甲，并写明"引用方被撤销视同去掉引用、刷新影响"；同时说明 op 顺序会影响结果（与 K8 的"顺序无关"不冲突：那条说的是两次请求） |
| N9 | 需改 | W9 §3.3、§15 第 10 条 | 5a | 状态类表上不给时间的依据，范围是"从入口时刻起一直延续"。按天的计划只依据自己那一天的目标：之后任何一次将来生效的目标改动都会标出全部计划行，包括早已过去的那些，错报随时间累积。另外 `date` 粒度上"从入口时刻起"与按日的区间怎么对齐没有写 | 甲：维持默认，靠工具描述引导写 `valid_at`。乙：默认改成"所见版本里覆盖入口时刻的那一段"（到下一个变化点为止）。丙：依赖行是事件类表时，默认取依赖行自己的业务日期 | 甲 + 写明对齐规则（取入口时刻在 slot 时区下的那一天）；评测 10a 加一个"按天计划"的变体检验 Agent 会不会写 `valid_at` |
| N14 | 需改 | 规格 01-objects「各处理方式的执行语义」、04-write-and-read「撤回某次写入」；W8 §3.4 | 9 | ① `keep_effective` 不触发写入，`undo` 它报 `not_this_target`：用户"撤回这次处理"没有任何办法。② `take_candidate` / `take_previous` 可以 `undo`，值回到处理前，但事项保持已解决，候选不再出现在任何未决事项里。③ 叠加来源键的基线：基线值已是候选的值，之后同步交来同样的值是 `unchanged`，候选永久消失 | 甲：照现文，"撤回处理"只回值、不重开事项。乙：`undo` 一次由解决触发的写入时，把事项恢复为未决（事项版本换新）。丙：另设"重开事项"的处理方式，`keep_effective` 也能用 | 乙或丙；至少要在回执里写明"候选 320 不会再被提出" |
| N15 | 需改 | W8 §3.4、§3.7、§10 | 9b、9c | "同步贡献"与"已生效的同步贡献"对两类项没有定义：已被登记回掉的同步贡献算不算"已生效"（基线位置）；`take_previous` 写回的项搬运的是一项同步贡献，算不算同步贡献（基线值与位置） | 9b 两种读法下一次同步结果相同；9c 不同：算的话，用户刚选了"回到冲突前（300）"，下一次同步就把他拒绝过的 320 直接写上、没有事项；不算的话保持 300 | 被回掉的项不算"已生效"（与"是否生效以回退记录为准"一致）；`take_previous` 写回的项不算同步贡献（W8 §10 的倾向）。两条都写进参考求值器 |
| N16 | 需改 | W9 §6.3、§10.3、§15 第 6 条 | 11 | 依据目标被隐私删除后，依赖行上的标记消不掉：重申只取代同一依据目标上的边；指向已删除的行被 `not_found` 拒绝；没有"去掉一条依据"的写法；原样重写字段是无操作或佐证，不换出处项。只有改掉每个被覆盖字段的值或撤销整行才能消掉，必填的 `date` 改不了 | 甲：依据目标已被删除时，允许重申里省略它、视为放弃这条依据。乙：加"去掉一条依据"的写法（W9 已说是纯增量）。丙：依据目标整行删除时，标记在依赖行被下一次带 `basis` 的写入触及后自动消失 | 乙；W9 §15 第 6 条"重申一次即可消掉"的说法要改 |
| N2 | 需改 | W8 §3.7 末行、§10 | schema、6 | 父子两张表都由连接器同步时，同一请求里用临时名引用按来源键**命中**的父行写不出来；本场景只好让同步来的明细不填 `meal`，`meal_count` 不计入它们 | 甲：第一版限制，连接器分两次请求（先父后子，第二次用回执里的行 ID）。乙：让 `as` 在命中时也绑定到命中的行 | 乙；否则营养、记账这类"单据 + 明细"的连接器每批都要两次调用 |
| N11 | 需改 | W8 §3.2、§3.7 | 6 | 手记的行与同步来的行是同一件事时，只能 `keep`（算两次）、撤销同步行（之后来源的修改再也进不来）、或撤销手记行（失去 `meal` 关联）；不能把来源键挂到手记那一行上。`duplicate_keys` 又要求文本一字不差，名字略有差别就静默算两次 | 甲：第一版接受。乙：允许对没有来源键的行按"有则不改、无则补上"的方式补键（键索引里没有这个键时） | 乙（W8 不允许补键的理由是"有历史的字段当键"，这里补的是从未有过值的键字段，不受那条理由约束）；至少在 `flagged` 事项的详情里说明三种处理的后果 |
| N1 | 可选 | W8 §3.2、§8 第 22 条 | schema | 来源键只能声明在事件类表上，事件类表必须有 `time.field`；明细本来随所属的一餐取日期，这里只好重复一个 `date`，两处要各改各的 | 开放给无时间表后，明细可做成无时间表、派生规则关联 `meals` 取日期 | 随 W8 §8 第 22 条一并定 |
| N3 | 可选 | 规格 06-derived「L1 受限 SQL」 | schema | 规则里 `count(DISTINCT meal)`（对 `ref` 字段去重计数）是否在白名单内没写；"把 `zoned_datetime` 按 slot 时区取日"的写法规格提到有这类规则却没给出 | — | 在 06-derived 给出白名单的聚合函数清单与取日的写法 |
| N4 | 可选 | 规格 architecture §3 第一版收窄、07-scope-v1 3.5；W9 §3.4 | 3 | 份量被纠正后，读过每日合计的读取在第一版收不到任何提示，依据也不能指向派生行 | 已声明的第一版收窄 | 讲解里点明"读过合计的一方要靠 `changes` 自己查" |
| N6 | 可选 | 规格 03-deletion「预览与回执要写明的内容」 | 11 | 删掉用户原话后，同一次写入的 agent_note（是对同一顿饭的转述）与后来的纠错原话仍作为源数据保留、不再支撑任何数据；预览的"不会删除"不单列这类源数据，用户不知道还有别处留着这顿饭的内容 | — | 预览加一项"删除后将不再支撑任何数据的源数据"，供调用方决定是否一并删除 |
| N7 | 可选 | 规格 01-objects「行身份」、06-derived | 4c | 分组因**撤销**变空、之后又有了行时，沿用原 `partition_id` 还是另分配，规格只为"因删除变空"写了规则 | 沿用：映射仍在，读取记录能接上；另分配：读过旧分区的读取与新分区对不上 | 沿用，与删除一致 |
| N8 | 可选 | 规格 04-write-and-read「引用字段」、06-derived | 4a | 派生规则按 `ref` 计数时会数到已撤销的目标（明细未撤销、仍指着已撤销的一餐） | — | schema 编译回执或讲解里提醒：要排除已撤销的目标，规则须关联目标表 |
| N10 | 可选 | W9 §6.2、§10.4 | 5c | 标记说"在 #95 改了之后的安排"，但不传时间的读取只返回当前段，Agent 看不到新值，要另带 `valid_during` | — | 工具描述里写明：原因是 `plan_changed` / `retroactive` 时按时间段读依据 |
| N13 | 可选 | W8 §3.6 | 8 | 物理删除之后，连接器再次同步会把同一条记录作为新行写回，此时没有任何提示，只在删除时提醒过一次 | 在"删除后不可比对"之下无法识别（W8 已论证） | 删除回执与 `deletion` 事项到期时再提醒一次"来源系统里仍有这条记录"；讲解写明 |
| N17 | 可选 | W8 §2.4；规格 contract 第 12 节 | 10 | 既没有 `saveslot.schema`、又是限定范围的凭证去建 slot，`insufficient_scope` 的 `required_scope` 给哪一个没定 | 给 `saveslot.schema`：调用方以为补了 scope 就能建；给 `all_slots`：同理反之 | 都列出，或按"先 scope 后范围"写死 |

## 没有核对到的范围

- **schema 迁移**：[`08-schema-migration.md`](../../spec/03-data-model/08-schema-migration.md) 没有读；来源键、依据在迁移中与切换时的行为（W8 3.10、W9 §5.5）没有推。
- **类型与单位**：[`10-types-and-units.md`](../../spec/03-data-model/10-types-and-units.md) 没有读。文中"克"被单位同义表认作 `g`、`247.5` 不被舍入、`text` 同值是逐码点比较，都是按别处的引用推定的。
- **事件格式**只读了 4.2、4.4、4.5、5.7 的 `write.head` 与 `write.derived` 两段；5.8 事项、5.9 删除事件的逐块形状、`basis.changed` 与删除事件的先后，按 W8、W9 的文字推，没有逐块对照。
- **契约类型**（[`04-contract-types.md`](../../spec/04-contract-types.md)）、**外化面**（[`05-surfaces.md`](../../spec/05-surfaces.md)）只查了临时名一处；回执的 JSON 形状、MCP 文本渲染没有核对。
- **两个连接器进程并发同步同一张表**没有推：W8 说同一租户写入串行、定位结果记在事件里，但两批里同一个新键先后到达时第二批的结果（`created` 还是 `unchanged`）只按"后到者看到先到者"推定。
- **撤回删除**（`deletion` 的 `cancel`）没有推：第 7 步的 `pi_7` 若在宽限期内撤回，键索引转回"在"、`skipped` 过的那次同步不重放（W8 3.9），这一路没有逐步算。第 11 步删除后的撤回与依据标记的"比得了才撤"也没有推。
- **恢复备份**与 `external_keys`、`basis_decls` 的重建没有推。
- **写入准入的数值**没有估：第 6 步"60 条不会 `too_large`"是按"每天只有几行"的直觉说的，阈值见 06-derived，数值待实验。
- **评测**（[`10-evals.md`](../../spec/10-evals.md)）、讲解章节、调研材料没有读。
- **W8 §5 导入、§4 外部权威**与本场景无关，没有涉及。
