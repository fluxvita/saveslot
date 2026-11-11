# 推演 1：跑步记录（事件类表 + 派生表）

> 2026-11-09。按 `HANDOFF.md`「推演任务」，只依据当前的 [`DRAFT.md`](../../spec/01-positioning.md)、[`02-architecture.md`](../../spec/02-architecture.md)、
> [`data-model.md`](../../spec/03-data-model/README.md)、`interface.md`（已于 2026-11-10 拆为 [`04-contract.md`](../../spec/04-contract.md) 与 [`05-surfaces.md`](../../spec/05-surfaces.md)）。目标：检验核心（内核 + 服务层 + 契约）能不能让跑步数据在多次会话、
> 多个 Agent、schema 演进、删除、导出重放之后仍然**保得住、说得清、算得对**；同时检验只靠文档能不能推下去。
> 文中 `→ Qn` 指向文末问题清单。**本文只列问题，不改设计文档。**

## 设定

- **部署**：第 0–7 步是本地 saveslot 服务（PGlite，单机）；第 8 步导出到云服务（PostgreSQL）重放。
- **主体**（用户会话经 CLI 签发连接实例）：
  - 用户 `U`（用户会话）。
  - Agent A = `MacBook · Claude Code`，scope `saveslot.read saveslot.write saveslot.schema saveslot.delete`。
  - Agent B = `MacBook · Codex`，scope `saveslot.read saveslot.write`。
  （interface 的例子用 `iPhone · Codex`；第一版本地部署是单机，第二个 Agent 放在同一台机器上 → Q22。）
- **日期**：2026 年。W45 = 11-02（周一）至 11-08（周日）。slot 时区 `Asia/Shanghai`。
- **记号**：`#n` = 日志 `seq`；`rd_n` = read_log 里的一次读取；`s_Rn` = 源数据；`r1…r4` = runs 的行；`pi_n` = 待处理事项。
- **表头**（HANDOFF 规定的六列）：做了什么 | 调用 | (a) 追加的日志事件 | (b) `apply` 改的物化状态 | (c) 本地运行状态 | 回执 / 之后读到什么。

## 第 0 步：建 slot（11-01，用户与 A）

用户经 CLI 签发两个连接实例，再让 A 建 `health` slot。A 提交的草稿就是 data-model「例：新建 slot（v1 草稿）」的原文（runs + weekly_mileage）。

```yaml
saveslot_schema_draft:
  document: { slot: health, base_version: null, timezone: Asia/Shanghai, tables: [runs, weekly_mileage] }  # 全文见 data-model
  task: a-s0
```

| 做了什么 | 调用 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|---|
| 签发连接实例 | `POST /v1/connections` ×2（用户会话） | #1 主体登记 U？ #2 登记 A（scope）#3 登记 B | 主体登记表 | 控制面：两个令牌的哈希（不在租户存储） | 令牌写进两个客户端的 MCP 配置 |
| 提交草稿 | `saveslot_schema_draft` | #4 草稿提交（文档全文）#5 编译结果（编译后的定义；回填 `sl_h`、`t1`/f1–f4、`t2`/`r1`）| 草稿与编译结果（目录里还不可见） | — | 编译回执（同 data-model 例） |
| 要不要确认 | — | #6 事项产生 `pi_1` schema_change？ | 事项当前状态 | — | 文档没写新建 slot 是自动生效还是须确认；slot 还不存在，也就没有 slot 策略 → Q11 |
| 确认、切换 | `saveslot_resolve pi_1 confirm` | #7 事项解决（确认记录：A、编译结果哈希、`seq` 6）#8 迁移开始（`system`）#9 切换到 v1（`system`）| 物理表 `t_t1_v1`、`t_t2_v1`、版本表 `t1__ver`、计数表、当前版本指针 health→v1、数据目录 | — | `已切换 · health schema v1` |

**对照 K**：K2——#1 的 actor 是谁？租户里第一个主体由谁登记、第一条事件的 `prev_hash` 是什么，文档没写（→ Q11）。K6、K3 其余满足。

## 第 1 步：第一次记录（11-03 21:05，A 会话 1）

用户：「今天跑了 15 公里，腿很沉」。

```json
{ "tool": "saveslot_write", "sv": 1, "task": "a-s1",
  "evidence": [{ "kind": "user_message", "text": "今天跑了 15 公里，腿很沉" }],
  "ops": [{ "intent": "insert", "table": "health.runs",
            "set": { "date": "2026-11-03", "distance": { "value": "15", "unit": "km" }, "feeling": "腿很沉" } }] }
```

| 做了什么 | 调用 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|---|
| 查目录 | `saveslot_catalog level=table runs` | — | — | 目录读取不入 read_log（不是行版本） | runs 的字段与单位 |
| 写入 | `saveslot_write`（上） | #10 源数据 `s_R1`（带 salt）#11 逻辑写入头（insert、**请求键哈希**、疑似重复 = 无、统计异常 = ?）#12 基础写入 r1（前 ∅ / 后整行，带 salt；字段级来源 f1–f4 ← `s_R1`；级别 user_stated）#13 派生写入 W45（`r1` v1、分区 2026-11-02、读集位置 12、结果承诺）| `t_t1_v1` 加 r1；`t1__ver` 加一版；`t_t2_v1` 加 W45 = 15 km / 1 次；base_sources、derived_reads；计数表；请求键索引；全文索引加 `s_R1` | 写事务开头把 A 的读取缓冲落盘 | `已保存 · health v1 · #12`；r1 `ver=v(r1,#12)`；派生：W45 — → 15 km |

**对照 K**：
- K4 满足。K5 满足（同一事务）。K13：请求键哈希写进了 #11——它是对"连接实例 + task + 规范化请求"求的哈希，请求里含证据原文，**没有加 salt** → 第 7 步出问题（Q1）。
- **核对状态**：「跑了 15 公里」字面包含 15 和"公里"，按 data-model 应标"已核对"（还要一张 公里↔km 的同义表）。但 data-model 说核对状态由"saveslot 后台核对后更新"，
  architecture §3 的 (a) 事件表与 (b) 清单里都没有它；它会影响第 5 步冲突裁决的结果 → Q6。
- **统计异常**：首次记录，冷启动怎么判没有定义（architecture §14.1 的已知缺口，在这里复现，→ Q21）。

## 第 2 步：第二次记录（11-05 07:30，A 会话 2）

用户：「今天 6 公里，状态不错」。调用同第 1 步，`task: a-s2`。

| 做了什么 | 调用 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|---|
| 写入 | `saveslot_write` insert r2 {11-05, 6 km, feeling "状态不错"} | #14 `s_R2` #15 头 #16 基础写入 r2 #17 派生写入 W45 | `t_t1_v1` 加 r2；W45 = 21 km / 2 次 | — | `已保存 · #16`；W45 15 → 21 km |

跨会话没有问题：A 不需要记得上次写过什么，saveslot 里都有。

## 第 2b 步：重复记录（11-05 20:10，A 会话 3）

用户在新会话里又说：「11-03 跑了 15 公里」。A 没有先查，直接写入（最差宿主的常见行为）。

| 做了什么 | 调用 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|---|
| 写入 | `saveslot_write` insert r3 {11-03, 15 km}，`task: a-s3` | #18 `s_R2b` #19 头（疑似重复命中 r1，判定结果记在事件里）#20 基础写入 r3 #21 派生写入 W45 #22 事项产生 `pi_2` flagged（目标 r3，原因"疑似与 r1 重复（同为 11-03、15 km）"——原因文字是内容） | r3 生效；W45 = 36 km / 3 次；`flagged` 标记；事项 | — | `已保存 · #20`；`pending[]: pi_2 已标记`；W45 21 → 36 km |

- 幂等不介入（不同 task、超出 10 分钟窗口），由 `duplicate_keys` 发现——与 interface「幂等」一致。
- 回执的 `status` 是 `saved` 还是 `pending`？interface 规定 `pending` 只指"进了待确认或记为冲突候选"，`flagged` 两者都不是，应为 `saved` + `pending[]`。可以推出来，但值得在回执表里写明（并入 Q9）。
- A 告诉用户"可能重复了"，用户没回应，会话结束。事项不过期，留到下一步。

## 第 3 步：另一个 Agent 读周跑量，并处理重复（11-06 08:00，B 会话 1）

用户问 B：「这周跑了多少？」

| 做了什么 | 调用 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|---|
| 发现数据 | `saveslot_catalog` | — | — | — | health · v1 · runs、weekly_mileage（派生 · 只读） |
| 读周跑量 | `saveslot_query table=weekly_mileage where week_start=2026-11-02`，`task: b-s1` | — | — | `rd_1`：B 读 W45 @#21 | `W45 · 36 km · 3 次`；提示：`health slot 有 1 个待处理事项（saveslot_pending 可查看）`。**W45 本身没有任何标记**，B 看不出 36 里有一条疑似重复 → Q7 |
| 看事项 | `saveslot_pending` | — | — | — | `pi_2 已标记 · runs r3 · 疑似与 r1 重复` |
| 用户：「对，后来那条是重复的，删掉」 | `saveslot_resolve pi_2 decision=revoke` | #23 源数据？（`saveslot_resolve` 没有 `evidence` 参数，撤销 r3 这次基础写入的来源是什么？）#24 事项解决（确认记录：B、事项内容哈希、`seq` 22）#25 头 #26 基础写入 r3 撤销 #27 派生写入 W45 | r3 撤销；W45 = 21 km / 2 次；`flagged` 清除 | — | `已处理 · pi_2`；W45 36 → 21 km |

**对照 K**：
- K11 满足（显式解决、绑定内容、记下解决者）。
- K4：由事项解决触发的基础写入必须有源数据。interface 只对 `saveslot_write` 规定了"没带证据就把请求存为 `api_call`"，`saveslot_resolve` 没写，用户那句"后来那条是重复的"也无处可放 → Q10。
- **`rd_1` 读到的 36 本来就是错的**（r3 根本不该存在），但撤销不触发纠错影响查询 → B 之后不会收到 `possibly_affected` → Q8。

## 第 4 步：纠错（11-06 08:12，B 会话 2）

用户：「11-03 那次是 5 公里。」B 不知道 r1 的行 ID，先看 W45 由哪几行构成。

| 做了什么 | 调用 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|---|
| 找行 | `saveslot_history table=weekly_mileage week_start=2026-11-02 mode=composition`，`task: b-s2` | — | — | 记不记 read_log？记成"逐行读"还是"聚合读"？文档没写 → Q12 | `W45 21 km = r1 (11-03, 15 km) + r2 (11-05, 6 km)`——拿到了行 ID，有没有 `ver` 没写 |
| 不带 `ver` 纠错 | `saveslot_write correct r1 set distance=5 km`（无 `ver`） | — | — | — | 按"组合视图不算逐行读"推：`read_first`："请先用 saveslot_query 读取该行"。若组合视图算逐行读，则用它兜底——两种都说得通 → Q12 |
| 逐行读 | `saveslot_query runs where date=2026-11-03` | — | — | `rd_2`：B 读 r1 @#12 | `r1 ver=v(r1,#12) · 2026-11-03 · 15 km` |
| 纠错 | 见下 | #28 `s_R3`（saveslot 标注 correction）#29 头（correct）#30 基础写入 r1 distance 15 → 5（字段级来源 f2 ← `s_R3`）#31 派生写入 W45 | r1 = 5 km；`corrected`；W45 = 11 km；纠错影响结果 | `possibly_affected`（由 read_log 算出，(c) 类） | `已保存 · #30`；派生 W45 21 → 11 km；`之前有 2 次读取用了旧值` |

```json
{ "tool": "saveslot_write", "sv": 1, "task": "b-s2",
  "evidence": [{ "kind": "user_message", "text": "11-03 那次是 5 公里" }],
  "ops": [{ "intent": "correct", "table": "runs", "row": "r1", "ver": "v(r1,#12)",
            "set": { "distance": { "value": "5", "unit": "km" } } }] }
```

**纠错影响查询**：被纠正的版本 = r1 @#12 → 下游派生写入 #13、#17、#21、#27 → read_log 匹配：
- `rd_1`（B 读 W45 @#21）——正确命中。
- `rd_2`（B 刚才为了定位这一行读的 r1 @#12）——也命中。这是纠错者自己为了纠错做的读取，算作"用了错误版本"是噪声 → Q13。

**对照 K**：K8 不涉及；K10 满足（写事务开头落盘了 `rd_2`，兜底能看到）。`possibly_affected` 是 (c) 类（architecture §3 写了"丢了从零开始"），但 `flags` 模块的标记清单里没有它，存在哪不清楚 → Q20。

## 第 5 步：两个 Agent 并发改同一行（11-07 21:00）

用户在 A 那边说：「11-05 那次用了 32 分钟，其实挺累的。」几乎同时在 B 那边说：「11-05 那次距离其实是 6.2，感觉挺轻松。」

| 做了什么 | 调用 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|---|
| A 读 | `saveslot_query runs where date=2026-11-05`，`task: a-s4` | — | — | `rd_3`：A 读 r2 @#16 | `r2 ver=v(r2,#16) · 6 km · 状态不错` |
| B 读 | 同上，`task: b-s3` | — | — | `rd_4`：B 读 r2 @#16 | 同上 |
| A 先写 | `saveslot_write update r2 {duration: 32 min, feeling: "其实挺累"} ver=v(r2,#16)` | #32 `s_R4` #33 头 #34 基础写入 r2 | r2 = {6 km, 32 min, 其实挺累}（规则不依赖 duration / feeling，无派生写入） | — | `已保存 · #34` |
| B 后写（`ver` 已过期） | `saveslot_write correct r2 {distance: 6.2 km, feeling: "挺轻松"} ver=v(r2,#16)` | #35 `s_R5` #36 头（distance 合并、feeling 记候选）#37 基础写入 r2 distance 6 → 6.2 #38 事项产生 `pi_3` conflict（当前"其实挺累" / 候选"挺轻松"，候选是内容）#39 派生写入 W45 | r2.distance = 6.2；`disputed`；W45 = 11.2 km | — | 见下 |

B 的回执应当说清"distance 已生效、feeling 未生效"。但 interface 的回执里"本操作是否已生效"是**每个 op 一个布尔值**，`status` 也只有整体的 `saved` / `pending`；
一个 op 一半合并、一半冲突时表达不了。K8 写的是"同字段记候选、不相交字段合并"（按字段拆），interface 写的是"本次改的字段与之后的写入不相交才自动合并"（按 op 整体），两处说法不一致 → Q9。

**生效值**：两边都是 `user_message`、都字面"已核对" → 同级 → "保持上一个已确认值"。普通写入没有"已确认"的概念，这里只能理解为"当前值（其实挺累）"→ Q14。

**B 这次 distance 是纠错**，纠错影响查询的起点是"同一行的上一版" = #34（A 的写入，distance 6）。但 `rd_3`、`rd_4` 读的是 #16（distance 同样是 6），
派生写入 #17–#31 用的也都是 6——它们全都用了错值，却都不在"#34 往下游"的范围里，漏报 → Q5。

| 做了什么 | 调用 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|---|
| 11-08 09:00，A 新会话读 | `saveslot_query runs`，`task: a-s5` | — | — | `rd_5` | `r2 … 其实挺累 ⚠ 有争议（pi_3）` |
| 用户："挺累是对的" | `saveslot_resolve pi_3 keep_effective` | #40 事项解决（确认记录） | `disputed` 清除 | — | `已处理`；不需要新写入 |

## 第 6 步：schema 变更——把 `feeling` 拆成两个字段（11-08 10:00，A 会话 6）

v2：删 `feeling`（f4），新增 `body_feeling`（text，身体感受）与 `mood`（enum good / ok / bad），都从 `feeling` 与源数据原文重新抽取。

```json
{ "tool": "saveslot_schema_draft", "task": "a-s6", "document": {
  "slot": "health", "base_version": 1,
  "tables": [{ "name": "runs", "id": "t1", "kind": "base", "description": "每次跑步一行",
    "time": { "type": "event", "field": "date" },
    "fields": [
      { "id": "f1", "name": "date", "type": "date", "required": true, "description": "跑步当天" },
      { "id": "f2", "name": "distance", "type": "quantity", "unit": "km", "required": true, "min": 0, "description": "距离" },
      { "id": "f3", "name": "duration", "type": "quantity", "unit": "min", "min": 0, "description": "用时" },
      { "name": "body_feeling", "type": "text", "description": "身体感受，用户原话",
        "reextract": { "from": ["feeling"], "instructions": "从原 feeling 与原文中摘出身体感受；没提就留空" } },
      { "name": "mood", "type": "enum", "values": ["good", "ok", "bad"], "description": "跑后心情",
        "reextract": { "from": ["feeling"], "instructions": "按原话判断心情；判断不了用 ambiguous" } } ],
    "drop_fields": ["feeling"] }] } }
```

| 做了什么 | 调用 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|---|
| 取完整文档 | `saveslot_catalog level=schema slot=health` | — | — | — | 文档，`base_version: 1` |
| 提交草稿 | `saveslot_schema_draft`（上） | #41 草稿 #42 编译结果（f5、f6；changes：删 f4 = 破坏性，f5/f6 = 重新抽取）#43 事项 `pi_4` schema_change | 草稿状态 | — | 预览："需重新抽取 2 行 / 3 次写入"。r3 已撤销，算不算在内？→ Q16 |
| 用户同意 | `saveslot_resolve pi_4 confirm` | #44 解决 #45 迁移开始（作业 `jb_1`：`it_1` = r1 [#12]，`it_2` = r2 [#16, #34]） | 新建 `t_t1_v2`，经 `apply` 把 date / distance / duration 重放进去 | 后台任务进度 | `迁移中`；旧版照常可读可写 |
| A 领取 | `saveslot_extract_claim` | — | — | 租约 `ls_1` | 两个工作项（格式同 interface 例） |
| **迁移中，B 带 `sv=1` 新增一条** | `saveslot_write sv=1 insert r4 {11-08, 8 km, feeling "很爽"}`，`task: b-s4` | #46 `s_R6` #47 头 #48 基础写入 r4 #49 派生写入 W45 | v1：r4；W45 = 19.2 km；作业追加 `it_3` | — | `已保存`；`warnings`：迁移中，feeling 的新写入已追加抽取工作项 |
| A 提交 | `saveslot_extract_submit`：#12 → {body "腿很沉", mood null}；#16 → {body null, mood good}；#34 → {body "挺累", mood bad} | #50 抽取结果（内容含"腿很沉"等原话） | `t_t1_v2` 的 f5 / f6 | 租约 | 已接受 2 项；还有 1 项可领 |
| A 再领、再交 `it_3` | #48 → {body null, mood good} | #51 抽取结果 | 同上 | — | 作业完成 |
| 差异清单 | — | #52 事项 `pi_5` migration_diff（r1 / r2 / r4 旧值 → 新值，都是内容） | 事项 | — | A 把清单给用户看 |
| 用户全部接受 | `saveslot_resolve pi_5 accept_all` | #53 解决 #54 切换到 v2（`system`） | 指针 health → v2；v1 的 runs 表退役 | — | `已切换 · health schema v2` |
| 切换后，B 仍带 `sv=1` 改 feeling | `saveslot_write sv=1 update r4 {feeling "其实一般"}` | — | — | — | `schema_incompatible`："runs.feeling 自 v2 起已删除，拆为 body_feeling 与 mood，请重读"——正确 |
| B 重读后改写 | `saveslot_write sv=2 update r4 {mood: ok}`，证据"其实一般" | #55–#57 | r4.mood = ok | — | `已保存` |

检查点：
- **翻译的语义**：一条写入的翻译里没出现的字段，是"不变"还是"置空"？#34 只碰了 feeling，翻译时 A 必须给出 body 与 mood 两个值，才能不让 mood 停在 #16 的 good。文档只说"每条翻译只能给新值"→ Q15。
- **用整行重放新版**：`apply` 只用事件里的前后整行。#37（B 的 distance 合并）的后整行是 v1 形状、含 f4；构建 v2 时它必须只带走"改动的字段"，否则会把 f5 / f6 冲掉或无从填起。可以推出来，但 architecture 里 `apply`"只用前后整行"的说法要补一句 → Q15。
- **被拒的写入怎么去重**：interface 说"由确定性校验得出的拒绝"也去重，但 K13 的请求键索引是 (b) 类、由事件算出，被拒的写入不产生事件 → Q19。
- 迁移期间追加工作项、切换后拒绝旧版写入、切换后取代涉及被改字段的事项——都按文档走通。

## 第 7 步：隐私删除一句话（11-09 20:00，A 会话 7）

用户：「把我 11-03 说'腿很沉'那句话彻底删掉。」

| 做了什么 | 调用 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|---|
| 找源数据 | `saveslot_sources mode=search q=腿很沉` | — | — | `rd_6`：A 读源数据（只记查询指纹） | `s_R1`「今天跑了 15 公里，腿很沉」 |
| 预览 | `saveslot_sources mode=delete_preview delete={kind: privacy, sources:[s_R1]}` | — | — | 删除确认句柄 `dc_1`（10 分钟） | 见下 |
| 用户确认 | `saveslot_delete confirm=dc_1` | #58 删除已确认（目标、影响清单、到期 11-10 20:05、确认记录）#59 事项 `pi_6` deletion #60 派生写入 W45？ | r1 在 v1、v2、版本表里都读不到；`s_R1` 读不到；全文索引隐藏；W45 = 14.2 km？ | — | 每处的状态：逻辑删除 → 物理删除 11-10 20:05 → 备份失效日期 |

**级联范围**（按 data-model「删除」逐项推，括号里是文档有没有覆盖）：

| 位置 | 内容 | 处理 | 文档覆盖？ |
|---|---|---|---|
| r1 整行 | 插入它的 #12 来源全是 `s_R1` | 整行删除，即使 distance 后来由 `s_R3` 改过 | ✓（data-model 的 runs#1 例） |
| `s_R3`「11-03 那次是 5 公里」 | 纠错源数据 | 保留，标"纠错目标已删除" | ✓ |
| r1 的历史版本 #12、#30 | 前后整行含日期、"腿很沉" | 清内容与 salt，留承诺 | ✓ |
| 退役的 `t_t1_v1` 里的 r1 | 整行 | 必须删 | ✗ 级联与 `apply` 的物理清除都没提退役版本表 → Q2 |
| `t_t1_v2` 里的 r1 | 整行 | 删 | ✓ |
| #50 抽取结果里 #12 的翻译 | "腿很沉" | 必须删 | ✗ 翻译结果没写成"内容"、也没挂到 `s_R1` 的来源上 → Q2 |
| `pi_5` 差异清单里 r1 那一项 | 旧值 / 新值"腿很沉" | 必须删 | ✗ 事项的提议值是内容（architecture 写了），但它来自哪条源数据没记，级联找不到 → Q2 |
| `pi_2` 的原因文字 | "同为 11-03、15 km"（r1 的值） | 必须删 | ✗ 同上 |
| 数据目录的"取值示例" | 可能含"腿很沉" | 重算 | ✗ 明文残留清单里没有 → Q2 |
| #11 的请求键哈希 | 对含证据原文的请求求的、不带 salt 的哈希 | 永远留在链上 | ✗ **拿"今天跑了 15 公里，腿很沉"去算一遍就能确认删的是这句话**，违反"删除后承诺无法被猜测比对" → Q1 |
| W45 | 依赖 r1 | 重算为 r2 6.2 + r4 8 = 14.2 km | ✓；但宽限期内（逻辑删除）要不要就重算、撤回时再算回来，没写 → Q17 |
| r3（撤销的重复行，来源 `s_R2b`） | 也是"11-03、15 km" | 不动——来源不同 | ✓（这也正是用户可能意想不到的地方，预览里要列出"未受影响的同类记录"吗？不列也说得过去） |

**产品层面的一点**：用户想删的是"腿很沉"这句话，结果连 11-03 这次跑步也一起没了——尽管 `s_R3`"11-03 那次是 5 公里"独立证明了这次跑步存在。
规则本身说得通（行的存在来自插入它的来源），预览会写明；但 Agent 只能二选一：整行删，或者不删。要不要提示"先用 `s_R3` 重新记一条再删"由 Agent 决定 → Q23。

## 第 8 步：宽限期内导出，在云端重放（11-09 21:00，用户 CLI）

| 做了什么 | 调用 | (a) | (b) | (c) | 回执 / 之后读到 |
|---|---|---|---|---|---|
| 导出 | `GET /v1/export`（用户会话） | — | — | — | 文件含 #1–#60。**`s_R1` 还在宽限期，原文仍在文件里**；文件在 saveslot 之外，到期删除管不到它 → Q4 |
| 在云端建租户、导入 | ？ | — | — | — | interface 只有导出，没有导入的端点 / CLI；谁创建云端租户、导入前是否先 `verify`、事件格式版本不认识时怎么办，都没写 → Q4 |
| 云端重放 | 内核 `apply` #1–#60 | （同一份日志） | 云端 (b) 与本地逐行一致：r1 读不到、W45 = 14.2、`pi_6` 仍在宽限期、`pi_2` / `pi_3` / `pi_5` 已解决 | read_log 全部没了；所有权 epoch = 1 | A、B 须在云端重新签发凭证；新凭证对应原来的主体 ID 还是新的连接实例？→ Q4 |
| 8a：在云端撤回删除 | A：`saveslot_resolve pi_6 cancel` | 云端 #61 撤回 | 云端 r1 复活，W45 = 19.2 | — | **本地那份还在，到 20:05 照样物理删除** → 两份日志从 #61 起分叉，没有"迁出后冻结源租户"的说法 → Q4 |
| 8b：不撤回，等到期 | — | 云端 #61 到期物理删除（`system`）| r1 内容、salt 物理删除 | — | 前提是 20:05 之后云端租户被打开过。云服务闲置即关、本地服务可能没在跑——**物理删除要等下一次有人访问**，可能拖很久 → Q3 |

还有两点：
- 若导出发生在**到期之后**，日志里 #10、#12、#30 的内容已被物理删除，而墓碑在更后面。重放到 #12 时 `apply` 怎么知道"这条内容已被后面的墓碑删除"？要有明确的"内容已移除"标记，重放时跳过 → Q18。
- 退役表保留多久还没定。如果按时间清理、又不记事件，那"从空存储重放 = 线上状态"在退役表上就对不上 → Q18。

## 场景结论

**换一个会话**：保得住、说得清、算得对。所有状态都在 saveslot 里，A 的三次会话之间不需要任何记忆；疑似重复、冲突在下一个会话里随读取带出。

**换一个 Agent**：**大体能做到，有三处缺口**。
- B 能接手 A 留下的事项。
- 但 B 读到的派生值不带基础行上的标记（Q7）。
- 撤销不会告诉之前读到错误聚合值的人（Q8）。
- 纠错影响漏掉"更早、同样错"的版本（Q5）。

**导出重放之后**：
- **当前状态与历史**：保得住、算得对（第 8 步逐项核对过，靠 K12 的三类划分）。读取历史按设计不随行。
- **删除的保证**：**目前不成立**。
  - 永久日志里留着可以拿猜测值比对的请求键哈希（Q1）。
  - 翻译结果、事项内容、退役表里的内容没纳入级联（Q2）。
  - 物理删除要等租户下一次被打开（Q3）。
  - 宽限期内的导出文件带着原文（Q4）。
- **迁移本身**：还推不完整——没有导入的入口，也没有"迁出后源租户怎么办"的规定（Q4）。

**只靠文档能不能推下去**：第 0 步（建 slot、创世事件）、第 4 步（什么算逐行读）、第 5 步（部分合并）、第 6 步（翻译语义）、第 8 步（导入）需要自己补规则才能往下走，其余都能直接按文档推出。

## 问题清单

**P0**：会破坏核心承诺，而且第一版事件格式定死后改不了。**P1**：核心承诺有缺口，或者文档推不下去。**P2**：需要澄清的细则。

| # | 级别 | 在哪一步 | 问题 | 违反了什么 | 建议 |
|---|---|---|---|---|---|
| Q1 | P0 | 1、7 | 逻辑写入头里的请求键是对"连接实例 + task + 规范化请求（含证据原文）"求的哈希，不带 salt，永久留在链上；隐私删除后，拿猜测的原话算一遍就能确认删的是什么 | data-model「叶子只放事件头……删除后承诺无法被猜测比对」；K1 / K11 | 请求键不进事件头：作为内容随事件存（可删除），请求键索引 (b) 由它建；或改用租户密钥做 HMAC，删除时清掉受影响写入的键。事件格式定死前就要定 |
| Q2 | P0 | 6、7 | 隐私删除的级联只覆盖源数据、基础写入（含历史版本）、派生缓存；**抽取翻译结果、`migration_diff` 的新旧值、`flagged` / `conflict` 事项的原因与候选值、退役版本表、数据目录的取值示例**都含有来自被删源数据的内容，既没有挂到来源上，也不在明文残留清单里 | data-model「删除」级联与明文残留清单；K11 | 规定"凡是由某条源数据派生出的内容都要记来源"：翻译结果的字段级来源 = 原写入的来源；事项内容记它引用了哪些行版本 / 源数据；`apply` 的物理清除覆盖所有版本的物理表；目录概况列入残留清单 |
| Q3 | P1 | 8b | 宽限期到期的物理删除只在"打开存储时补跑"和进程常驻时执行；云服务闲置租户会被关掉，本地服务可能没在跑，删除会无限期停在逻辑删除 | DRAFT「删除 24 小时内可撤回、到期物理删除」；法律时限 | 云服务：控制面维护"到期索引"（只存租户与到期时刻，不存内容），调度器按时打开租户执行；本地：回执与 App 如实说明"saveslot 服务下次启动时执行"。记入 DRAFT「删除的法律口径」 |
| Q4 | P1 | 8 | 导出 / 迁移不完整：① 没有导入的端点、CLI 与流程（建租户、先 `verify`、格式版本检查）；② 宽限期内导出的文件含原文；③ 导出导入后两份租户都活着、会分叉，没有"迁出后冻结源租户"；④ 凭证重签后对应原主体还是新连接实例 | DRAFT「数据可在本地与托管之间双向迁移」；architecture §8 | 定义"迁移" = 导出 → 导入 → 源租户冻结（只读，记一条控制事件）；导出默认把宽限期内的内容替换为"待删除"占位并提示（可选包含）；补 `POST /v1/import` 与 CLI；凭证重签映射到原主体 ID |
| Q5 | P1 | 5 | 纠错影响查询的起点只取"同一行的上一版"；同一字段的错值往往跨多个版本（#16、#34 的 distance 都是 6），更早版本的读取与派生写入漏报 | data-model「纠错影响查询」；说得清 | 起点改为"该字段最近一次取得被纠正值的那次写入起，到纠错前的所有版本"（按字段回溯），再往下游走 |
| Q6 | P1 | 1、5 | 核对状态会影响冲突裁决，却由"后台核对后更新"；它不在 (a) 事件表、也不在 (b) 清单里，重放后可能不同 | K3、K12 | 第一版只有字面核对，改为写入时同步判定、记进基础写入事件（与疑似重复同样处理）；将来后台模型核对产生"核对结果"事件 |
| Q7 | P1 | 3 | `flagged` / `disputed` / `awaiting` 都标在基础行上，派生行读不到；B 拿到 36 km 时看不出其中有一条疑似重复 | interface「文本里必须出现的标记」；DRAFT「冲突……读取时带出」 | 派生行带汇总标记："本值的输入里有 1 行已标记 / 有争议"（由分区读集算出，与 `saveslot_sql` 的汇总标记同一套逻辑） |
| Q8 | P1 | 3 | 撤销（含由 `flagged` 事项触发的撤销）不触发纠错影响查询，但"这条不该存在"意味着之前包含它的读取都是错的 | data-model「纠错影响查询」只认纠错 | 撤销按纠错同等对待（或在 `revoke` 上区分"本来就不该存在"与"从现在起不算"） |
| Q9 | P1 | 2b、5 | 一个 op 部分字段合并、部分字段冲突时，回执表达不了（"是否已生效"是每个 op 一个布尔值）；K8（按字段拆）与 interface `saveslot_write`（按 op 整体判断不相交）说法不一致；`flagged` 时 `status` 取什么没写明 | K8；interface「回执」 | 统一为按字段：回执 `ops[]` 每个字段给出 已生效 / 候选（`pi_…`）；`status` 只要有候选就是 `pending`；回执表补一行 `flagged` 时为 `saved` + `pending[]` |
| Q10 | P1 | 3 | `saveslot_resolve` 会触发基础写入（`revoke`、`take_candidate`、`migration_diff` 的 `set`），但没有 `evidence` 参数，这次写入的源数据是什么没规定；用户的话无处可放 | K4 | `saveslot_resolve` 加可选 `evidence`；不带时把解决请求（含 `note`）存为 `api_call` 源数据；写入 interface |
| Q11 | P2 | 0 | 创世没定义：第一条事件的 `prev_hash`、第一个主体由谁登记（K2 要求 actor 已登记）、新建 slot 是否须确认、slot 的初始策略是代码里的常量还是一条事件 | K1、K2、K12 | 定一条"租户创世"事件（带租户 ID、格式版本、用户主体）；建 slot 时把初始策略全文作为事件写入；新建 slot（无数据）默认自动生效 |
| Q12 | P2 | 4 | 什么算"逐行读"没定义：`saveslot_history` 的组合视图、`saveslot_sql` 选出的行有没有行 ID 与 `ver`、算不算兜底 | interface「`ver` 兜底」 | 明确只有 `saveslot_query` 与 `saveslot_history timeline` 给 `ver`、算逐行读；组合视图给行 ID 不给 `ver`，提示用 `saveslot_query` 读 |
| Q13 | P2 | 4 | 纠错者为定位那一行做的读取（同一连接实例、同一 task、纠错之前）也被算成"用了错误版本" | 说得清（噪声） | 纠错影响结果排除"纠错写入所依据的那次读取"（`ver` 对应的读取，或兜底用的那次） |
| Q14 | P2 | 5 | 冲突裁决的"同级则保持上一个已确认值"——普通写入没有"已确认"概念 | data-model「冲突处理」第 3 条 | 改写为"同级则保持当前值（先提交者）" |
| Q15 | P2 | 6 | 抽取翻译里没出现的字段是"不变"还是"置空"没定义；`apply`"只用前后整行"与构建新版时只带走改动字段的需要要对齐 | interface「工作项」；architecture `apply` | 翻译必须给出该簇涉及的全部新字段（缺省报校验错误）；`apply` 构建新版时按"改动的字段"重放 |
| Q16 | P2 | 6 | 已撤销的行要不要重新抽取、进不进差异清单；逻辑表名改写时排除已撤销行也只写在 `saveslot_query` 的 `include_revoked` 上，规则与受限 SQL 没写 | data-model「schema 版本演进」「派生规则」 | 写明逻辑表 = 当前版本里未撤销的行（规则与 SQL 都是）；已撤销的行照常翻译（历史要能按时刻读），不进差异清单 |
| Q17 | P2 | 7、8a | 宽限期内（逻辑删除）派生值要不要先重算、撤回时再重算回来，没写 | K5 | 确认删除时生成派生写入（数据读不到，派生就不该再含它），撤回时再生成一次 |
| Q18 | P2 | 8 | ① 到期后导出的日志里，被删内容所在的事件早于墓碑，`apply` 重放时怎么识别；② 退役表若按时间清理、不记事件，重放对拍对不上 | K12 | ① 物理删除时在原事件的内容位置留"已由 #n 移除"标记，`apply` 据此跳过；② 退役表的清理也作为事件，或在对拍范围里排除退役表 |
| Q19 | P2 | 6 | interface 说"由确定性校验得出的拒绝"也去重，但被拒的写入不产生事件，K13 的请求键索引管不到 | K13 与 interface「幂等」 | 拒绝的去重放在服务层缓存（(c) 类，丢了无害），写明 |
| Q20 | P2 | 4 | `possibly_affected` 是 (c) 类，但存在哪个模块没写（`flags` 的标记清单里没有它） | architecture §4 | 归到 `audit`，写进模块表 |
| Q21 | P2 | 1 | 统计异常没定义（已知缺口 architecture §14.1，这里复现） | — | 已在待定，不重复 |
| Q22 | P2 | 设定 | interface 的例子用 `iPhone · Codex`，第一版本地部署是单机；远程访问私有服务器又是"第一天就做"——第一版"本地"是否允许其他设备经网络访问没说清 | DRAFT「部署形态」 | 写明第一版本地 = 本机访问；跨设备用云服务；例子改成同机的两个 Agent |
| Q23 | P2 | 7 | 隐私删除一句话会连带删掉另有来源佐证的事实（11-03 这次跑步），用户只能二选一 | 产品体验 | 预览里写明"这一行的存在只来自这句话；另有 `s_R3` 提到它"，由 Agent 决定是否先重新记录；不改内核规则 |

## 处理状态

> 注（2026-11-10）：interface.md 已拆为 [`04-contract.md`](../../spec/04-contract.md)（契约）与 [`05-surfaces.md`](../../spec/05-surfaces.md)（MCP、HTTP），内核规则搬回 data-model；下表里的 interface「…」指当时的 interface.md，各节的新位置见 `HANDOFF.md`「第五轮修订」的对照表。

2026-11-09 合并修订进设计文档。"按建议"指按上表的建议处理；其余是与用户定下的决定。

| # | 处理 | 落在哪 |
|---|---|---|
| Q1 | 已定：请求键不进事件头，作为内容随逻辑写入头存（带 salt），该写入的证据被删时一起删；请求键索引 (b) 由它重建。边角情况写明：写入后 10 分钟内被隐私删除、又恰好重发原请求时会重新写入一条 | architecture K1、K13、(a) 事件表；data-model「防篡改」「删除」「写入请求」；interface「幂等」 |
| Q2 | 已定：凡由源数据派生出的内容都记来源、纳入级联——请求键、翻译结果、事项内容、退役表、回退值、目录概况；明文残留清单同步补上 | architecture K11、(a)/(b) 表、`apply`、`delete`；data-model「删除」清单；interface 抽取作业 |
| Q3 | 已定：云服务由控制面的删除到期索引驱动，到期主动打开租户执行；本地下次启动时执行，如实告知 | architecture §5 控制面、§7；data-model「删除」；interface `saveslot_delete`、`delete_preview` |
| Q4 | 已定：第一版只做导出；宽限期内的内容默认换成占位（`include_pending_deletion` 可包含）；导入、冻结源租户、凭证映射随多节点放到后续 | architecture §5、§8；interface `GET /v1/export` |
| Q5 | 按建议：起点按字段回溯到"该字段取得错值起的各版本"；状态类表按字段 + 区间 | data-model「纠错影响查询」 |
| Q6 | 按建议：字面核对在写入时判定、记进基础写入事件；将来模型核对产生单独事件 | architecture (a) 表、`write`；data-model「来源级别」 |
| Q7 | 按建议：派生行按分区读集带基础行的汇总标记 | data-model「拿得快」；architecture `flags` / `read`；interface 标记表 |
| Q8 | 已定：撤销一行也触发影响查询（含由 `flagged` 事项触发的），措辞"所含的一条记录已被撤销" | data-model「纠错影响查询」；interface `saveslot_write`、`saveslot_resolve`、标记表 |
| Q9 | 按建议：按字段判断合并与冲突；回执逐字段给结果；有候选就是 `pending`；`flagged` 时 `saved` + `pending[]` | architecture K8；data-model「冲突处理」；interface `saveslot_write` 回执与例子 |
| Q10 | 按建议：`saveslot_resolve` 加可选 `evidence`，不带则解决请求（含 `note`）存为 `api_call` | data-model「每次写入都有源数据」；interface `saveslot_resolve`、证据表 |
| Q11 | 按建议：定义租户创世事件；建 slot 时初始策略写成事件；新建 slot 编译通过即生效 | architecture K1、K2、(a) 表；data-model「编号」「slot 包含什么」；interface `saveslot_schema_draft` |
| Q12 | 按建议：只有 `saveslot_query` 与 `saveslot_history` 的 `timeline` / `as_of` 算逐行读、给 `ver`；`composition` 只给行 ID | data-model「写入请求」；interface `saveslot_query`、`saveslot_history` |
| Q13 | 按建议：影响查询排除纠错写入所依据的那次读取 | data-model「纠错影响查询」；interface 回执 `affected_reads` |
| Q14 | 按建议：同级保持当前值（先提交者） | data-model「冲突处理」 |
| Q15 | 按建议：翻译必须给全该簇的新字段（缺则校验错误）；构建新版时按改动的字段回放 | architecture `apply`；data-model「物理做法」；interface 抽取作业 |
| Q16 | 按建议：逻辑表 = 当前版本里未撤销的行（查询、SQL、规则一致）；已撤销的行照常翻译、不进差异清单 | data-model「拿得快」「物理做法」；interface `saveslot_query`、`saveslot_sql`、抽取作业 |
| Q17 | 按建议：删除确认时生成派生写入，撤回时再生成一次 | architecture (a) 表；data-model「删除」；interface `saveslot_delete` |
| Q18 | 按建议：① 物理删除后原事件内容位置留"已由 #n 移除"标记，`apply` 跳过；② 退役表清理写成事件（取建议的第一种，不把退役表排除出对拍） | architecture §3、`apply`、`maintenance`；data-model「防篡改」「物理做法」；DRAFT 待定 |
| Q19 | 按建议：被拒写入的去重放在服务层进程内缓存，丢了无害 | architecture §3、§5；interface「幂等」 |
| Q20 | 按建议：`possibly_affected` 归 `audit`，列入 (c) 类 | architecture (c) 表、模块表 |
| Q21 | 不处理（已在待定） | — |
| Q22 | 按建议：第一版本地 = 本机访问，跨设备用云服务；例子改成同一台 MacBook 上的两个 Agent | architecture §1；DRAFT「部署形态」；interface 开头与例子 |
| Q23 | 已定（随 Q30）：行的存在改为**按必填字段判断**——每个必填字段都还有来源就保留、只清空只来自被删来源的非必填字段；同值佐证追加来源；预览逐行写明 | data-model「删除」；interface `delete_preview` |
