# 决定：事项区间逐段记，`flags` 表随之换列，格式版本号不变

> 2026-11-15 决定。改的是事件格式 v1 与存储格式 v1 里已有的定义，不兼容；两个格式的版本号都不变。

## 1. 改了什么

1. **事件格式**：事项的 `scope_valid` 从单个区间 `{"from", "to", "deps"}` 改成逐段给出 `{"spans": [{"from", "to"}, …], "deps"}`。只有这一种形状，一段时也是长度为 1 的 `spans`；各段按起点升序、互不相交也不相接、粒度一致，开口只能在最后一段（[`../../spec/09-event-format.md`](../../spec/09-event-format.md) §5.8）。
2. **存储格式**：`flags` 表的 `valid_from`、`valid_to` 两列换成一列 `spans`，存事项区间各段的 JCS（[`../../spec/02-architecture.md`](../../spec/02-architecture.md) §8）。
3. **契约**：`ItemTarget` 与数据标记 `disputed`、`awaiting` 的 `valid?: Interval` 换成 `spans?: Interval[]`（[`../../spec/04-contract-types.md`](../../spec/04-contract-types.md)）。
4. 标记、"改到"的判断、执行都按各段走，不再取外包。

## 2. 为什么

- **事项区间可以是不相连的几段。** 并入只发生在区间相交的候选之间，但并入之后的并集、一个候选自己被切开的几段，都可能不相连。
- **外包会把没争议的段算进来。** 用外包记，中间那段明明没有候选，却会被标成有争议、被当成"改到"、在执行时被写到。按段记，标记与执行都只落在真有候选或提议的地方。

## 3. 为什么不升版本号

还没有发布过任何数据目录或日志：不存在按旧形状写下、需要读回或迁移的数据。现在升版本号只会多一个从来没被用过的旧版本要永久支持。格式第一次随发布固定之后，同类改动按版本规则走。

## 4. 落在哪里

- 规格：09 §5.8（`scope_valid`、各处"事项区间"）、02-architecture §8 `flags`、04-contract §6「事项的目标」、04-contract-types `ItemTarget` 与 `Marks`、03-data-model/01-objects「目标与合并」。
- 实现：`contract-core` 的 `ScopeValid` 形状检查；`kernel` 的 `pending` 写出 `spans`、`apply` 把它落进 `flags.spans`、存储格式 v1 的 `flags` 建表语句。
