# 实验 9：容量边界 · 运行记录（PGlite，形状 C）

> 实验的定义、做法与停止条件见 [`../decisions/pre-dev-w11-schema-capacity-evals.md`](../decisions/pre-dev-w11-schema-capacity-evals.md) 第 6 项。
> 数值写在规格 [`../../spec/02-architecture.md`](../../spec/02-architecture.md#容量边界与实测数值)「容量边界与实测数值」，本文不重复，只记每组数是在哪个提交上量的。
> 只跑了 PGlite 一侧的形状 C（分钟级的序列）。形状 A、形状 B 与 PostgreSQL 一侧没有跑。

## 两次运行

| 规格里的叫法 | 提交 | 存储格式 | 与发布版本的关系 | 量了什么 |
|---|---|---|---|---|
| 早期版 | `c9d48631` | 4 | 0.1.0 之前的开发版 | 50 万、100 万、500 万、1,000 万行各规模点。1,000 万行点上半表范围 `query` 因内存不足失败，其后的派生表读取、`history` 的 `as_of` 与冷启动没有量 |
| 复核版 | `cc0feb00` | 5 | 0.1.0 之前的开发版，不在任何发布分支上 | 50 万行点重量一遍；没有做整库重放 |

环境两次相同：Apple M4 Pro、24 GiB 内存、macOS 27.2、Node.js 26.13.1、`@electric-sql/pglite` 0.5.16（本机模式，host fsync），同进程直接调用契约操作。

## 这两个提交之后改了什么

规格里标为「0.1.0 之前量的」或写明原因的几处，对应下面的改动。改动之后没有重量。

| 现象 | 原因 | 改动 | 进入的版本 |
|---|---|---|---|
| 建库每批 1,000 行在约 47 万行之后从约 4 秒到约 40 秒 | 本机存储没有计划器的统计信息，落账时读一行的源数据的语句在约 40 万行处改为扫描 `base_sources` 的整个主键 | 这条语句改写，不依赖统计信息 | 0.1.0 |
| 同上 | 同上 | 本机存储自己收集统计信息 | 0.1.1 |
| 写入耗时随表总行数增长 | 拼回执时读本次操作的块的语句扫描整张 `content` | 改为先取本次操作的事件，再按序号走 `content` 的主键 | 0.1.1 |
| 同上 | 派生刷新对整张派生表重算 | 未改 | — |
| `query` 的内存与耗时随命中行数增长、与 `limit` 无关 | 先取出全部匹配行再排序切页 | 未改 | — |

## 脚本

脚本在 [`experiments/exp9/`](../../../../experiments/exp9/)，用法写在各文件开头。上面两次运行用的是这些脚本当时的版本；之后在当前代码上能直接重跑，便于重量和二分查找。

| 文件 | 做什么 |
|---|---|
| `run.ts` | 按形状（A、B、C、C-state）把一个库依次长到各规模点，每个点量一遍 |
| `resume.ts` | 从已经长好的库接着量，不重建 |
| `measure.ts` | 每个规模点的测量项 |
| `shapes.ts` | 各形状的负载 |
| `restart.ts`、`restart-child.ts` | 崩溃后重启耗时与表的个数的关系（`SIGKILL` 后重开，记就绪耗时与 host `fsync` 次数） |
| `lib.ts` | 共用部分 |

```sh
node --conditions=source experiments/exp9/run.ts --shape C --points 500000,1000000 --dir <空目录> --min-free-gib 40
node --conditions=source experiments/exp9/restart.ts --dir <空目录> --tables 0,10,100,1000 --rounds 5
```
