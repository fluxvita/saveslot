# saveslot · 断言索引

[English](../../spec/11-claims.md) · 简体中文

> 规格里写成"任何情况下都……"的那些话，各由哪条测试守着。每行一条断言：原文在哪、拿什么比、测试是哪一条、现在成立不成立。没有测试的照实写「无测试」。

规格的规则散在各章里，其中一部分是全称断言："两种顺序得出同一个结论""从空存储重放得到同样的状态"。这份索引不加新规则，只做对照：一条断言写在哪里，什么样的输入能推翻它，这个检验在哪条测试里跑。

这一版覆盖三个子系统：冲突判定、重放的确定性（含两个存储后端）、读取记录与历史，另有跨版本的数据兼容一条。隐私删除与需要重建物理表的迁移的断言之后补。

## 怎么读这张表

- **断言**：规格原文，链回它所在的那一节。原文改了，这一行一起改。
- **预言**：什么输入、比什么、**刻意不比什么**。不比的那一半和比的那一半同样要紧：少写了，测试会因为不相干的原因变红。
- **测试**：文件路径（从仓库根起）和用例名。用例名照源码里写的，`it.each` 的名字保留 `%s`；前面可以带它所在的 `describe` 的名字。
- **状态**：
  - `成立`：有一条性质测试，或一次对全部对象的扫描，在预言写明的范围内守着它。
  - `部分有测试`：只有固定用例，或只覆盖断言的一部分；没覆盖的在预言里写明。
  - `已知不成立`：规格已经把它写成有范围的说法，并列出了范围之外的情形；这一行是其中一种情形，测试照现行规则的结果断言，规则一改它就变红。
  - `无测试`：没有任何测试直接守着它。
- **归属**：这条断言所在的代码。这一行由负责这块代码的人维护。

改规则的合并请求，在同一份里更新它碰到的行。`pnpm check` 里的 `docs:claims`（[`scripts/check-claims.ts`](../../../scripts/check-claims.ts)）核对每一行：有编号、链回了规格、有预言、状态是上面四种之一，指到的测试文件存在、用例名在文件里、没有被跳过。它不判断测试是否通过，那是 `pnpm check` 里测试自己的事。

## 冲突判定

规则在 [`03-data-model/09-references-conflict-sync.md`](03-data-model/09-references-conflict-sync.md#冲突判据)「冲突判据」，不变量是 K8（[`02-architecture.md`](02-architecture.md#内核不变量)）。

| 编号 | 断言 | 预言 | 测试 | 状态 | 归属 |
|---|---|---|---|---|---|
| J1 | 状态类表上两次带同一个 `ver` 的写入，都不传终点、都没有显式指向证据、都没有让所见版本里的变化点消失时：两种顺序要么都判冲突，要么都合并、最终的值相同且都不引出事项（[冲突判据 · 对称](03-data-model/09-references-conflict-sync.md#冲突判据)；[K8](02-architecture.md#内核不变量)；[测试矩阵](02-architecture.md#测试矩阵)「冲突判定对称」「不冲突的并发写入可交换」） | 随机生成：一个基础值，之前可有一次改动，再从同一个版本出发的两次不传终点的写入；两种顺序各判一遍。比是否判冲突；都不冲突时比最终的值（相邻的同值段并起来）。不比每一段的值是哪次写入给出的（两种顺序由不同的写入给出）；被拒绝的（落在无值区间上）和让所见变化点消失的样本在范围之外，不比 | `packages/kernel/src/judge/symmetry.prop.test.ts` › `in either order: both conflict, or both merge into the same values` | 成立 | `kernel/src/judge` |
| J2 | 范围之外 (a)：一方给了显式区间、一方不传终点，起点相同、值相同——两种顺序都合并、都不引出事项，终态不同（[冲突判据 · 对称 (a)](03-data-model/09-references-conflict-sync.md#冲突判据)） | 固定用例：基础 5000；一次写 `[11-01, 11-03) 3000`，一次写"11-01 起 3000"不传终点，带同一个版本。断言两种顺序都没有冲突，以及各自的终态（显式的先到：11-03 之后仍是 5000；不传终点的先到：3000 一直延续）。不断言哪一种终态更对 | `packages/kernel/src/judge/symmetry.test.ts` › `(a) an explicit interval and a default end, the same start and value: both merge, two end states` | 已知不成立 | `kernel/src/judge` |
| J3 | 范围之外 (b)：一方因高影响进了待确认，它不算另一方的 L——一种顺序是后到的一方成为候选，另一种顺序是一方待确认、另一方生效（[冲突判据 · 对称 (b)](03-data-model/09-references-conflict-sync.md#冲突判据)） | 固定用例：一次不传终点的写入，一次抹掉所见版本里两个变化点的显式写入，带同一个版本。断言两种顺序下各项的状态（生效 / 候选 / 待确认）与有没有冲突事项。不比终态的值 | `packages/kernel/src/judge/symmetry.test.ts` › `(b) a write awaiting for high impact is no L: one order a candidate, the other awaiting and in effect` | 已知不成立 | `kernel/src/judge` |
| J4 | 范围之外 (c)：一方的默认终点在所见版本里停在某个挡点上，另一方带 `acknowledge` 抹掉了这个挡点——两种顺序都合并、都不引出事项，终态不同；前一方是佐证时也一样（[冲突判据 · 对称 (c)](03-data-model/09-references-conflict-sync.md#冲突判据)） | 固定用例两条（另一个值的写入、佐证）：断言两种顺序都没有冲突、各项的状态，以及各自的终态。不断言哪一种终态更对 | `packages/kernel/src/judge/symmetry.test.ts` › `(c) %s whose end a later acknowledge erased: both merge, two end states` | 已知不成立 | `kernel/src/judge` |
| J5 | 字段组：W 与 L 都只把组里同一个字段写成同一个值——状态类表上组值相同，不冲突；事件类表、无时间表上不比值，这个冲突单元在 V 之后被改过就冲突（[冲突判据 · 组值](03-data-model/09-references-conflict-sync.md#冲突判据)） | 固定用例，状态类表与事件类表各一条：断言后到一方那一项的状态（生效 / 候选），内核与参考求值器各判一遍、结果相同。无时间表与事件类表走同一行判据，没有单独的用例 | `packages/kernel/src/judge/groups.test.ts` › `W and L both write f2 of a group to the same value on %s`<br>`packages/reference/src/groups.test.ts` › `W and L both write f2 to the same value: on a state table no conflict (the group value is the same); on an event table the unit changed after V is enough` | 部分有测试 | `kernel/src/judge`、`reference` |
| J6 | 写入路径与参考一致：一串写入做完后的线上状态 = 参考求值器在被删集合为空时的重放结果（[测试矩阵](02-architecture.md#测试矩阵)「写入路径与参考一致」） | 随机生成写入、撤销、回退、解决事项的序列，每一步之后比这一行或实体：各字段各时刻的值、给出值的项、无值区间、是否存在。在三层各比一遍：判定的结果、落账前的结算、落进存储之后。不比物理段怎么切 | `packages/kernel/src/judge/reference.prop.test.ts` › `every step leaves the row or entity the reference evaluator gives`<br>`packages/kernel/src/write/settle.prop.test.ts` › `settle gives the row or entity judge's view and the reference evaluator give, step by step`<br>`packages/store-pglite/src/apply-write.prop.test.ts` › `apply on storage gives judge's view and the reference evaluator, step by step and as of each operation` | 成立 | `kernel/src/judge`、`kernel/src/write`、`kernel/src/apply`、`reference` |
| J7 | 永不阻塞：任意写入序列之后，每个有值的（字段，时刻）有且只有一个生效值（[测试矩阵](02-architecture.md#测试矩阵)「永不阻塞」） | 应当比：随机写入序列之后逐（字段，时刻）数生效值的个数。现在只被 J6 间接覆盖（参考求值器的状态按定义是单值的），没有单独的性质 | — | 无测试 | `kernel/src/judge` |
| J8 | 先提交者稳定：过期写入在成为候选的冲突单元上不改变生效值（[测试矩阵](02-architecture.md#测试矩阵)「先提交者稳定」） | 应当比：成为候选的写入前后，该冲突单元在各时刻的生效值相同。现在只被 J6 间接覆盖 | — | 无测试 | `kernel/src/judge` |
| J9 | 只挑不造：任一字段的生效值都等于某次写入给过的值（[测试矩阵](02-architecture.md#测试矩阵)「只挑不造」） | 应当比：随机序列（含合并、回退、解决事项）之后，每个生效值都能在某次写入给过的值里找到 | — | 无测试 | `kernel/src/judge` |
| J10 | 合并不破坏已声明的约束：自动合并出的行满足 schema 的全部约束，含字段组（[测试矩阵](02-architecture.md#测试矩阵)「合并不破坏已声明的约束」） | 应当比：两次并发写入合并之后的行，逐条过 schema 的约束 | — | 无测试 | `kernel/src/judge`、`kernel/src/write` |
| J11 | 争议标记完备且不多标：对未决事项的每个备选，采纳它会改变的读结果必带 `disputed`；采纳任何备选都不变的不带（[测试矩阵](02-architecture.md#测试矩阵)「争议标记完备且不多标」） | 固定用例：一个有争议的字段，读到它时带标记，没读它时不带。断言里的"对每个备选、每个读结果"没有生成器 | `packages/store-pglite/src/query.test.ts` › `marks from open items` › `marks a disputed field, only when the field is read` | 部分有测试 | `kernel/src/read` |
| J12 | 不丢写入：每次被接受的写入的每个字段的每一项恰好处于一种状态——生效过、在未决事项里当候选或提议、被一条有记录的决定关掉、被读过它所在事项的写入取代、无操作（[测试矩阵](02-architecture.md#测试矩阵)「不丢写入」） | 应当比：随机序列之后，逐项数它落在这五种状态里的几种 | — | 无测试 | `kernel/src/judge`、`kernel/src/pending` |

## 重放的确定性

规则在 [`02-architecture.md`](02-architecture.md#日志是唯一事实来源)「日志是唯一事实来源」，不变量是 K7、K12。

| 编号 | 断言 | 预言 | 测试 | 状态 | 归属 |
|---|---|---|---|---|---|
| R1 | 从空存储按顺序把日志交给 `apply`，得到的物化状态与线上逐行一致（[K12](02-architecture.md#内核不变量)；[测试矩阵](02-architecture.md#测试矩阵)「重放对拍」） | 随机序列写完之后，把整份日志重放进一个空存储，比对拍清单里的每张表，逐行逐列；另有一条固定用例经 `log.reconcile` 比，并断言每张该比的表都比了。不比不在对拍清单里的表（读取记录等本地运行状态） | `packages/store-pglite/src/apply-write.prop.test.ts` › `apply on storage gives judge's view and the reference evaluator, step by step and as of each operation`<br>`packages/store-pglite/src/reconcile-log.test.ts` › `finds no mismatch in a log replayed from an empty storage, and lists every compared table` | 成立 | `kernel/src/apply`、`store-pglite` |
| R2 | 同一份日志在两个后端经 `apply` 重放，对拍清单里的表逐行一致（[测试矩阵](02-architecture.md#测试矩阵)「重放对拍」） | 随机历史经写入路径写进一个后端，日志从头重放进另一个后端的空存储，两个方向各一遍；另有固定历史让每张该比的表都有行。比每张表的行（各后端交给内核的值）与列（名字、类型、精度、可否为空）。四张表两边都是空的、比不出东西：`deletions`、`pending_blocks`、`external_keys`、`migrations`，等写它们的功能接入。需要一台 PostgreSQL，只在 `pnpm test:postgres` 里跑，`pnpm check` 里是跳过的 | `packages/test-backend/src/replay-across.prop.test.ts` › `written on PGlite, replayed on PostgreSQL: the compared tables are the same`<br>`packages/test-backend/src/replay-across.prop.test.ts` › `written on PostgreSQL, replayed on PGlite: the compared tables are the same`<br>`packages/test-backend/src/replay-across.prop.test.ts` › `every kind of step, written on PGlite and replayed on PostgreSQL`<br>`packages/test-backend/src/replay-across.prop.test.ts` › `every kind of step, written on PostgreSQL and replayed on PGlite` | 成立 | `test-backend`、`store-pglite`、`store-postgres` |
| R3 | 绕过 `apply` 改业务表必须被对拍发现（[测试矩阵](02-architecture.md#测试矩阵)「只有内核的一致性测试」） | 固定用例：直接改业务表的一个字段、删一行、加一行、改版本表的一格、改内核表，对拍各报出一处，按行与字段指出、不带值。"任何绕过的改动都被发现"没有生成器；不在对拍清单里的表改了不报 | `packages/store-pglite/src/reconcile-log.test.ts` › `finds a business table's field changed past apply, by row and field, without its value`<br>`packages/store-pglite/src/reconcile-log.test.ts` › `finds a business row removed past apply as missing, and one added as extra`<br>`packages/store-pglite/src/reconcile-log.test.ts` › `finds a version table's cell changed past apply, by row and the cell's field`<br>`packages/store-pglite/src/reconcile-log.test.ts` › `finds a kernel table changed past apply; not the catalog's profile` | 部分有测试 | `kernel/src/apply`、`store-pglite` |
| R4 | 内核不读时钟："当前时刻"由调用上下文传入并记进事件，重放只用事件里记下的时刻（[K7](02-architecture.md#内核不变量)） | 扫描内核包里全部非测试源码，读时钟的写法只出现在许可清单列出的位置、次数与清单一致；另断言扫描确实扫到了文件。只看源码里的写法，不在运行时拦截 | `packages/kernel/src/clock-reads.test.ts` › `reads the clock only where the allow-list says, as many times as it says`<br>`packages/kernel/src/clock-reads.test.ts` › `scans the kernel's source (a guard against scanning nothing)` | 成立 | `kernel` |
| R5 | 版本串不认识就停：事件里的编译器版本、白名单版本、规则版本、字面命中核对器版本取到内核不认识的值时，`apply` 停止并报错，不降级求值（[测试矩阵](02-architecture.md#测试矩阵)「版本串不认识就停」） | 固定用例：规则版本、字面命中核对器版本各取一个不认识的值，断言 `apply` 停下并报错。编译器版本与白名单版本没有用例 | `packages/kernel/src/apply/apply.test.ts` › `apply stops, never skips` › `on a ruleset version the kernel does not know`<br>`packages/kernel/src/apply/apply.test.ts` › `apply stops, never skips` › `on a literal checker the kernel does not know (09 §1.6)` | 部分有测试 | `kernel/src/apply` |
| R6 | 裁决确定：同一份日志从空重放，生效值、候选、事项状态逐项相同（[测试矩阵](02-architecture.md#测试矩阵)「裁决确定」） | 每种决定（采纳候选、保持生效值、回到合并基、确认、拒绝等）各一条固定场景，落进存储后把日志重放进空存储，比对拍清单里的表。随机样本里的决定只有固定场景那几种 | `packages/store-pglite/src/apply-write.prop.test.ts` › `each kind of decision reaches storage: one fixed scenario each, each replayed` | 部分有测试 | `kernel/src/apply`、`kernel/src/pending` |
| R7 | 追溯分类稳定：重放同一份日志，每次写入的"是否追溯"与当初一致（[测试矩阵](02-architecture.md#测试矩阵)「追溯分类稳定」） | 应当比：换一个时钟与时区重放同一份日志，逐次写入比"是否追溯"。现在只被 R4 间接覆盖 | — | 无测试 | `kernel/src/write` |
| R8 | 重放后定位结果相同：从空存储重放、在另一个后端重放，每个进了事件的按来源键 op 落到同一行，键索引逐行相同（[测试矩阵](02-architecture.md#测试矩阵)「重放后定位结果相同」） | 应当比：含按来源键写入的历史重放之后的键索引。R2 的历史里还没有这类写入，键索引两边都是空的 | — | 无测试 | `kernel/src/write`、`test-backend` |

## 读取记录与历史

规则在 [`03-data-model/02-integrity-and-records.md`](03-data-model/02-integrity-and-records.md#读取记录read_log)「读取记录」，不变量是 K10。

| 编号 | 断言 | 预言 | 测试 | 状态 | 归属 |
|---|---|---|---|---|---|
| H1 | 读取记录只记版本，不记值，也不记由值算出的哈希；查询条件只记不含用户值的结构指纹（[K10](02-architecture.md#内核不变量)；[读取记录里记什么形状](03-data-model/04-write-and-read.md#读取记录里记什么形状)） | 固定用例：一条带字面量、别名、输出列名的 `sql`，断言记下的指纹里没有其中任何一个、字面量成了占位符。只有 `sql` 的指纹；`query` 的条件、以及"读取记录的任何一列都不含值"没有测试 | `packages/store-pglite/src/sql-read-log.test.ts` › `has a shape that holds no value and no spelling of the caller's` | 部分有测试 | `kernel/src/read`、`kernel/src/audit` |
| H2 | 受限 SQL 按每张基础表记"不少于实际读到的行"：分组、聚合、DISTINCT、ORDER BY、LIMIT 不让记下的行变少（[读取记录里记什么形状](03-data-model/04-write-and-read.md#读取记录里记什么形状)「记多少条」） | 固定用例：同一张表上带分组、HAVING、DISTINCT、LIMIT、ORDER BY 的几条查询，记下的行与不带时相同；带 WHERE 的只记通过 WHERE 的行。"记下的行 ⊇ 结果实际依赖的行"没有生成器 | `packages/store-pglite/src/sql-read-log.test.ts` › `are not fewer for a grouping, HAVING, DISTINCT, LIMIT or ORDER BY: those are not looked at`<br>`packages/store-pglite/src/sql-read-log.test.ts` › `are only the rows that pass the WHERE of the query's level` | 部分有测试 | `kernel/src/read` |
| H3 | 记录时间只追加：之后的写入不改变任何早于它的操作号上的 `as_of` 结果；隐私删除除外（[测试矩阵](02-architecture.md#测试矩阵)「记录时间只追加」） | 随机序列全部写完之后，按每一个更早的操作号读版本表，得到的就是当时那一步的状态。不含隐私删除；比的是版本表，不经 `history` 的接口 | `packages/store-pglite/src/apply-write.prop.test.ts` › `apply on storage gives judge's view and the reference evaluator, step by step and as of each operation` | 成立 | `kernel/src/apply` |
| H4 | 时间片一致：`as_of: S` + `valid_at: T` = 把日志重放到操作号 S、再取 T；S 落在一次写入中间时等同于落在它的操作号（[测试矩阵](02-architecture.md#测试矩阵)「时间片一致」） | 固定用例：经 `history` 按每个操作号读一行，得到当时的值与版本；状态类实体按操作号读各段，再给一个业务时刻取其中一点。"S 落在一次写入中间"没有用例，也没有生成器 | `packages/store-pglite/src/history.test.ts` › `as_of` › `gives the row as of each operation, with its historical version`<br>`packages/store-pglite/src/history.test.ts` › `as_of` › `gives a state entity's segments then, at a point if asked` | 部分有测试 | `kernel/src/read` |
| H5 | 读取记录记下所见状态的位置：`as_of` 的读取记在它的记录点，后续页记在首页的操作号，之后的写入不改变它（[读取记录](03-data-model/02-integrity-and-records.md#读取记录read_log)） | 固定用例：一次 `as_of` 读取之后再写，按这次读取还原得到的仍是它当时看到的状态；后续页在日志前进之后仍记在首页的操作号 | `packages/store-pglite/src/history.test.ts` › `an as_of read is recorded at its record point: {read} of it gives that state`<br>`packages/store-pglite/src/history.test.ts` › `a later query page is recorded at the first page's operation: {read} gives what it saw`<br>`packages/store-pglite/src/history.test.ts` › `later as_of pages keep the first page's record point, however the log moves` | 部分有测试 | `kernel/src/read`、`kernel/src/audit` |
| H6 | 读取记录不进日志：记一次读取不追加事件、不改物化状态（[标识与对象](03-data-model/01-objects.md)「每个租户一条日志」） | 应当比：任意读取前后日志末端与对拍清单里的表不变 | — | 无测试 | `kernel/src/audit` |
| H7 | 影响查询的结构性判据：读取被标 `possibly_affected` ⇔ 它问过的某个（字段，业务时刻）上，值在读取时的版本与现在之间不同（[测试矩阵](02-architecture.md#测试矩阵)「影响查询的结构性判据」） | 应当比：随机的读取与写入序列之后，逐次读取比"被标"与"值确实不同"是否一致，两个方向（多报、漏报）都查 | — | 无测试 | `kernel/src/read` |

## 跨版本的数据兼容

规则在 [`02-architecture.md`](02-architecture.md#格式版本导出导入与恢复)「格式版本、导出、导入与恢复」，决定在 [`data-compatibility.md`](../process/decisions/data-compatibility.md)。

| 编号 | 断言 | 预言 | 测试 | 状态 | 归属 |
|---|---|---|---|---|---|
| C1 | 任何一个发布过的格式（0.1.0 及以后）写下的数据，都能被当前版本打开并升级到当前格式；升级之后由日志得出的表与从空存储重放这条日志的结果一致（[格式版本检查与跨版本的数据兼容](02-architecture.md#格式版本导出导入与恢复)；[K12](02-architecture.md#内核不变量)） | 应当比：对夹具里每个发布过的格式的每一份样本（本机模式、服务器模式），用当前版本打开、升级，读出样本存下时记的固定值，再从空存储重放日志与表对拍。0.1.0 只有格式 5，没有升级可测；升级机制随第一次改格式交付，这一行那时换成样本测试 | — | 无测试 | `kernel/src/store` |
