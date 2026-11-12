# 实验 8：单写者锁 · 结果（macOS）

> 实验的定义、做法与通过标准见 [`../decisions/pre-dev-w0-experiments.md`](../decisions/pre-dev-w0-experiments.md)「实验 8」。本文只报告结果，不改标准。
> 运行日期：2026-11-12。只在 macOS 上跑过；**Linux 没有跑**，本文不给出任何 Linux 结论。

## 结论

- 在 macOS 上，**候选 A（操作系统文件锁，经带预编译包的原生扩展）满足标准 1、2、4**；标准 3 在 A 上没有被触发（挂起期间没有人能接手，见下文），所有权编号的拦截另由候选 B 的挂起测试和单元测试验证。
- 候选 A2（Node 内置 SQLite 的独占事务）、C（unix socket）**不满足标准 1**；候选 B（独占创建 + 心跳）满足 1–4，但强杀后重开的时延只是靠把过期阈值调到 750 ms 才压进 1 s，且有固有的竞态与误判接手，不采用。
- `store-pglite` 采用 A（`packages/store-pglite/src/lock.ts`）。
- 一项与规格不符之处：PGlite 上，所有权编号**存在库里**时，失去锁的旧实例读不到新编号（见「与规格的出入」）。实现另加了库外的属主文件。

## 环境

| 项 | 取值 |
|---|---|
| 机器 | Apple M4 Pro，14 核，24 GB；内置 SSD，APFS；笔记本 |
| 系统 | macOS 26.7.1（Darwin 25.6.0），系统完整性保护开启 |
| Node | 24.14.0（libuv 1.51.0，内置 SQLite 3.51.2） |
| PGlite | `@electric-sql/pglite` 0.5.16 |
| 候选 A 的扩展 | `fs-native-extensions` 1.5.3（Apache-2.0）；依赖 `require-addon`、`which-runtime`、`bare-addon-resolve`、`bare-module-resolve`、`bare-semver`，均 Apache-2.0 |
| 测试目录 | 系统临时目录（内置 SSD） |

## 先核实的事实

- **Node 标准库没有 `flock`**：Node 24.14.0 的 `fs` 模块里没有名字含 `lock` 的函数（`Object.keys(require("fs")).filter(k => /lock/i.test(k))` 为空）。"未核实的外部事实"里的这一条成立。
- `fs-native-extensions` 1.5.3 的包里带 `prebuilds/`：darwin-arm64、darwin-x64、linux-arm64、linux-x64、win32-arm64、win32-x64（及 android、ios）；包没有安装脚本，不需要编译工具。没有 musl（Alpine）的预编译包。它在 macOS 上用 `flock(LOCK_EX | LOCK_NB)`（`src/apple.c`），在 Linux 上用 `fcntl(F_OFD_SETLK)`（`src/linux.c`）。两者的锁都属于"打开的文件描述"，同一进程里第二次打开文件再加锁也会被拒；进程死掉时由内核释放。

## 候选

| 候选 | 做法（`experiments/exp8/candidates.ts`） |
|---|---|
| A | `<目录>/saveslot.lock` 上的操作系统文件锁，经 `fs-native-extensions`（即 `store-pglite` 的默认锁） |
| A2（A 的变体，新增） | 不用任何扩展：在 Node 内置的 `node:sqlite` 里对 `saveslot.lock.sqlite` 开一个 `BEGIN EXCLUSIVE` 并一直不提交（SQLite 在 Unix 上用 POSIX `fcntl` 锁） |
| B | 以独占方式创建锁文件，每 200 ms 更新一次修改时间；超过 750 ms 没更新即视为过期，改名移开后再创建 |
| C | 在目录里 `listen` 一个 unix socket；地址被占用时试连接，连不上视为过期，删掉 socket 文件再绑定 |

## 做了什么

全部命令在仓库根目录执行，原始结果在 `experiments/out/exp8/`（不入库）。

| 测试 | 命令 | 规模 |
|---|---|---|
| 竞争（只取锁） | `node --conditions=source experiments/exp8/run.ts contend --candidate <X>` | 每个候选 100 轮 × 10 个进程 = 1,000 次打开尝试；每轮一个新目录；10 个进程就绪后约定同一时刻（100 ms 后）忙等到点再同时尝试；取到锁的进程一直持有到本轮所有进程都报告完 |
| 竞争（完整打开） | 同上加 `--store`，只对 A | 1,000 次 `PgliteBackend.open`（锁 + 建库 / 启动 PGlite + epoch） |
| 强杀 | `run.ts kill --candidate <X>`；A 另加 `--store` | 每个候选 100 轮：持有者就绪 → 另一个已就绪的进程待命 → `SIGKILL` 持有者 → 待命进程每 5 ms 重试一次，记从发出 `SIGKILL` 到成功的时间。`--store` 时持有者是每 20 ms 提交一次的完整写入者，竞争者做完整打开 |
| 挂起 | `run.ts hang --candidate <X>` | 每个候选 1 次：持有者是每 100 ms 提交一行的完整写入者；提交 10 行后 `SIGSTOP` 30 s；期间另一个写入者每 500 ms 尝试打开，打开后每 200 ms 写一行；30 s 后 `SIGCONT`，再观察 3 s；最后用 `amcheck` 检查表 |
| 同进程二次加锁 | `run.ts same-process --candidate <X>` | 每个候选 1 次 |
| 旧实例能否看到新 epoch | `node --conditions=source experiments/exp8/stale-epoch-probe.ts` | 1 次 |

## 原始数字

**竞争**（每个候选 1,000 次尝试）

| 候选 | 恰好一个持有者的轮数 | 两个及以上持有者 | 没有持有者 | 被拒的报错 |
|---|---|---|---|---|
| A | 100 / 100 | 0 | 0 | 900 次全是 `store_locked` |
| A（完整打开） | 100 / 100 | 0 | 0 | 900 次全是 `store_locked` |
| A2 | 97 / 100 | 0 | **3** | 903 次 `store_locked` |
| B | 100 / 100 | 0 | 0 | 900 次 `store_locked` |
| C（修正后） | 99 / 100 | **1（第 5 轮 3 个进程同时持有）** | 0 | 898 次 `store_locked` |

C 第一次跑时有一处实现错误：macOS 上已存在的 socket 路径报 `EEXIST` 而不是 `EADDRINUSE`，代码没有处理，900 次被拒里有 792 次是未处理的 `EEXIST`（100 轮都恰好一个持有者）。修正后重跑的结果是上表一行。

**强杀后重开**（每个候选 100 轮，单位 ms，从发出 `SIGKILL` 到取得锁）

| 候选 | 成功 | 1 s 内 | 最小 | p50 | p95 | p99 | 最大 |
|---|---|---|---|---|---|---|---|
| A | 100 | 100 | 5.3 | 6.6 | 8.7 | 8.9 | 9.2 |
| A（完整打开，含 PGlite 启动与崩溃恢复） | 100 | 100 | 312 | 324 | 397 | 528 | 685 |
| A2 | 100 | 100 | 5.5 | 7.0 | 9.3 | 12.5 | 13.2 |
| B | 100 | 100 | 553 | 658 | 736 | 749 | 751 |
| C | 100 | 100 | 2.1 | 7.7 | 10.4 | 11.3 | 13.5 |

全部候选都不需要人工删文件。B、C 靠代码自动清理过期的锁文件 / socket 文件。

**挂起 30 s**

| 候选 | 挂起期间竞争者被拒次数 | 竞争者是否接手 | 旧持有者恢复后的第一个写事务 | 恢复后旧持有者写入的行 | `amcheck` |
|---|---|---|---|---|---|
| A | 66 | 否 | 正常提交（它仍是持有者） | 28（合法） | 0 处损坏 |
| A2 | 66 | 否 | 正常提交 | 28（合法） | 0 |
| B | 2 | 是：挂起后 1.49 s 打开，epoch 2 | **被拒：`ownership_lost`**，没有写入 | **0** | 0 |
| C | 66 | 否 | 正常提交 | 28（合法） | 0 |

B 一行：旧持有者在挂起前提交了 10 行；接手者此后写了 152 行；旧持有者恢复后第一个写事务在开始时核对属主失败，整个进程放弃这个租户（DB Worker 被直接终止，不做关闭检查点）。

**同进程第二次加锁**：A、A2、B、C 都报 `store_locked`；释放后可再取。

**旧 PGlite 实例能否看到新 epoch**（两个 PGlite 实例同开一个目录，即锁失效后的情形）

```json
{
  "oldInstanceBefore": 1,
  "newInstanceAfterIncrement": 2,
  "oldInstanceAfter": 1,
  "oldInstanceAfterForUpdate": 1,
  "oldInstanceSeesTakeover": false
}
```

旧实例的缓冲池里留着 `meta` 那一页，`SELECT … FOR UPDATE` 也读到旧值。另一个佐证：把 `store-pglite` 里核对属主文件的那一行临时去掉，单元测试"锁失效后旧 store 不能再写"就失败（旧 store 的写入被提交了）。

## 对照通过标准

| # | 标准 | A | A2 | B | C |
|---|---|---|---|---|---|
| 1 | 每次竞争恰好一个成功、其余明确报错；1,000 次里没有两个同时持有 | **满足**（只取锁、完整打开各 1,000 次） | 不满足（3 轮无人取得） | 满足 | **不满足**（1 轮 3 个持有者） |
| 2 | 持有者被强杀后 1 s 内重开，无需人工删除文件 | **满足**（最大 9.2 ms；完整打开最大 685 ms） | 满足 | 满足，但余量只有 250 ms，且取决于自定的 750 ms 阈值 | 满足 |
| 3 | 挂起测试里旧持有者恢复后第一个写事务被所有权编号拦下，没有写入 | **未触发**：挂起期间没有人能接手，旧持有者恢复后仍是合法持有者 | 未触发 | **满足** | 未触发 |
| 4 | 不需要用户机器上的编译工具 | **满足**（预编译包，无安装脚本；musl 无预编译包） | 满足（无扩展） | 满足 | 满足 |

标准 3 对 A 的说明：内核文件锁不会因为持有者被暂停而失效，所以 A 上不会出现"别人接手、旧持有者回来继续写"的情形，没有东西可拦。所有权编号仍然要有：内核锁在锁文件被删掉重建时会失效（新进程锁的是新文件），这时靠每个写事务的属主核对兜底。这条核对路径由 B 的挂起测试和 `packages/store-pglite/src/backend.test.ts` 的"锁失效后旧 store 不能再写"验证。

## 为什么选 A，不选别的

- **A2**：SQLite 的独占锁要先拿共享锁再升级；多个进程同时拿到共享锁后都升级失败，没有人成功（3 / 100 轮）。另外 POSIX `fcntl` 锁有一个陷阱：同一进程里任何代码打开再关闭这个文件，锁就被悄悄释放；在 Node 24.14 上导入 `node:sqlite` 会打印实验特性警告。
- **B**：过期判断天然有两个问题。① 持有者主线程卡住超过阈值（同步计算、长时间垃圾回收、被挂起）就会被误判死亡、被接手；② 两个竞争者同时判定过期时可能都"成功"。PGlite 上被接手意味着两个实例同开一个目录，所有权编号只能拦住旧实例的下一个写事务，拦不住它当时正在进行的写（见「与规格的出入」）。
- **C**：绑定与开始监听之间有窗口，别的进程此时连接被拒、误判过期、删掉 socket 文件再绑定，于是出现多个持有者（实测 1 / 100 轮）。macOS 上 socket 路径还限 104 字节。

## 与规格的出入

1. **所有权编号存在库里，在 PGlite 上发现不了接手。** `02-architecture.md` §7 写的是"每次打开租户时，所有权 epoch 加 1 并记在存储里；每个写事务在锁下核对 epoch"。PGlite 的旧实例读的是自己缓冲池里的页，看不到新实例写的编号（上面的探针）。实现保留了库里的编号与核对（与规格一致，对 PostgreSQL 有效），另在目录里放属主文件 `saveslot.owner`（随机 token、启动时间、epoch），每个写事务开始时和提交前各读一次文件；不一致就放弃租户，直接终止 DB Worker，不做关闭检查点（否则旧实例会把旧页写回新属主的库）。
2. **锁失效后，所有权编号只能拦"下一个"写事务。** 旧实例在被接手那一刻已经在进行的事务，若已向预写日志文件写出内容，会写进新属主正在用的文件。所以在 PGlite 上，真正的防线是"持有者活着就不会丢锁"的内核锁；编号是最后一道。这支持选 A，也说明不宜用会过期的锁（B）。
3. **token 与启动时间写在哪个文件。** §7 写"锁文件写入随机 token 与启动时间"。实现把它们写在单独的属主文件里：锁文件只作内核锁的对象，属主文件用"写临时文件、改名"原子替换，供每个事务读。效果相同，文件不同。

是否改 §7 的措辞由规格负责人决定；本文不改规格。

## 没做的、要人做的

- **Linux 上全部重跑**（标准要求 macOS 与 Linux 各一遍）：在一台 Linux（ext4）机器上，仓库根目录 `pnpm install` 后依次执行

  ```sh
  R="node --conditions=source experiments/exp8/run.ts"
  for c in A A2 B C; do $R contend --candidate $c; $R kill --candidate $c; $R hang --candidate $c; $R same-process --candidate $c; done
  $R contend --candidate A --store; $R kill --candidate A --store
  node --conditions=source experiments/exp8/stale-epoch-probe.ts
  ```

  把 `experiments/out/exp8/*.json` 的数字补进本文新加的"Linux"一节。Linux 上 A 用的是 `F_OFD_SETLK`，需要内核 3.15 起。
- **Bun**：没测。`fs-native-extensions` 在 Bun 下能否加载未核实。
- 锁文件被删后重建这一失效路径只在单元测试里用"不加锁"的替身模拟过，没有在进程级测试里真删文件。
