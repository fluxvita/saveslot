# 实验 1：PGlite 持久性 · 结果（macOS，部分）

> 实验的定义、做法与通过标准见 [`../decisions/pre-dev-w0-experiments.md`](../decisions/pre-dev-w0-experiments.md)「实验 1」。本文只报告结果，不改标准。
> 运行日期：2026-11-12。只在一台 macOS 笔记本上跑了能在本机跑的部分；macOS 步骤一由用户用 root 补跑。

## 结论

- **实验 1 没有通过，也还不能判定。** 步骤一（系统调用跟踪）在 macOS 上已经补跑并**满足标准 1**：组 B 每次提交确认前，都对预写日志文件发出了 `F_FULLFSYNC`（见「步骤一 · macOS」）；Linux 上的步骤一还没做。步骤三（断电）需要 Linux 虚拟机和一台台式 Mac，也还没做。按实验规格，缺了步骤三就不能认为通过。
- 第一个产出（组 B 怎么配）已经有了，并有源码出处：PGlite 0.5.16 允许去掉 `-F`，但**光去掉 `-F` 不会让任何同步调用到达宿主**——Node 文件系统后端的 `fsync` 与 `fdatasync` 都是空操作。组 B 因此由 `store-pglite` 自己补上：把 PostgreSQL 的 `fsync()` 接到 Node 的 `fs.fsyncSync`（macOS 上 libuv 把它实现为 `fcntl(F_FULLFSYNC)`）。
- 本机能跑的部分：步骤二（组 B）强杀 1,000 轮、只终止 DB Worker 200 轮、事务进行中强杀 200 轮，检查 1–6 全部通过，已确认提交丢失 0；组 A 的强杀对照 200 轮也全部通过（强杀测不出有没有落盘，这在预期之中）；提交延迟（组 B）p50 4.08 ms、p99 6.79 ms，满足标准 5。
- 这些结果只说明"提交返回前数据已经写出进程、崩溃恢复正确"，**不说明数据真的落到了介质上**。

## 环境

| 项 | 取值 |
|---|---|
| 机器 | Apple M4 Pro，14 核，24 GB；内置 SSD，APFS；笔记本（有电池，不适合做断电） |
| 系统 | macOS 26.7.1（Darwin 25.6.0），系统完整性保护开启；没有 root 权限 |
| Node | 24.14.0（libuv 1.51.0） |
| PGlite | `@electric-sql/pglite` 0.5.16（开工时 npm 上的最新版本），PostgreSQL 18 |
| 布局 | PGlite 实例在 `store-pglite` 的 DB Worker 线程里（与 `02-architecture.md` §7 一致），经 `PgliteBackend` 打开 |
| Bun | 没测 |

## 第一个产出：PGlite 0.5.16 的落盘行为与组 B 的配置

出处中的路径相对于 `node_modules/@electric-sql/pglite/`。`src/…` 是包里 `dist/*.js.map` 内嵌的 TypeScript 源码；`dist/pglite.js` 是 Emscripten 生成的胶水代码（SHA-256 `b4ee8cc358344c9e495a57b4301938178bec1a2c6d6fad10cd600f5f8632b2a0`）。

| # | 事实 | 出处与核实方式 |
|---|---|---|
| 1 | 默认启动参数带 `-F`（关闭 fsync） | `src/pglite.ts`：`defaultStartParams = ['--single', '-F', // turn fsync off …]`；运行时 `pg_settings` 里 `fsync = off`，来源 `command line` |
| 2 | **可以去掉 `-F`**：选项 `startParams` 整体替换默认参数 | `src/pglite.ts`：`startParams: [...(options.startParams \|\| PGlite.defaultStartParams), …]`；不带 `-F` 启动后 `fsync = on` |
| 3 | `wal_sync_method` 默认是 `fdatasync`；可选值只有 `fsync`、`fdatasync`、`open_sync`、`open_datasync`，没有 `fsync_writethrough` | 运行时查 `pg_settings` 的 `setting`、`source`、`enumvals` |
| 4 | Node 文件系统后端是 Emscripten 的 NODEFS，它的 `stream_ops` 没有 `fsync`；胶水里的 `_fd_sync` 是 `return stream.stream_ops?.fsync?.(stream)`，回调不存在时返回 `undefined`，即成功。所以 PostgreSQL 的 `fsync()` **不会到达宿主** | `dist/pglite.js` 中的 `function _fd_sync(fd){…}` 与 `NODEFS={…stream_ops:{…}}` |
| 5 | `fdatasync()` 走 `___syscall_fdatasync`，只校验描述符就返回 0，**不会到达宿主**。默认的 `wal_sync_method = fdatasync` 因此是空操作 | `dist/pglite.js` 中的 `function ___syscall_fdatasync(fd){try{SYSCALLS.getStreamFromFD(fd);return 0}…}` |
| 6 | `open_datasync` 的标志位（musl 的 `O_DSYNC` = 4096）被 NODEFS 映射成宿主的 `O_SYNC`；`open_sync` 的完整标志位映射不了，启动时 PostgreSQL 直接中止 | `dist/pglite.js` 中 `flagsForNodeMap` 的 `4096:flags["O_SYNC"]`；用 `-c wal_sync_method=open_sync` 启动得到 `Aborted()` |
| 7 | `NodeFS` 继承了空的 `syncToFs()`；选项 `relaxedDurability` 只决定是否等待 `syncToFs()`，所以**在 Node 文件系统上没有任何作用**。实验规格里"带宽松持久性选项的对照"在 Node 上没有可比的东西，没有跑 | `src/fs/nodefs.ts`、`src/fs/base.ts`（`async syncToFs(_relaxedDurability?: boolean) {}`）、`src/pglite.ts` 的 `syncToFs()` |
| 8 | 新建数据目录时，initdb 在内存文件系统里跑完，再整体拷进目标目录，期间不做同步 | `src/pglite.ts` 的 `#init`（`pgliteForInitDb.dumpDataDir` → `loadTar`） |
| 9 | 文件改名直接调宿主的 `fs.renameSync`（原子），不先删目标 | `dist/pglite.js` 中 `FS.rename` 与 `NODEFS.node_ops.rename` |
| 10 | Node 24.14 的 `fs.fsyncSync` 在 macOS 上依次尝试 `fcntl(F_FULLFSYNC)`、`fcntl(F_BARRIERFSYNC)`、`fsync()`；`fs.fdatasyncSync` 在 macOS 上走同一个函数；Linux 上分别是 `fsync()`、`fdatasync()` | libuv 1.51.0 `src/unix/fs.c` 的 `uv__fs_fsync`、`uv__fs_fdatasync`（源码层面；实际发出哪一种以步骤一的跟踪为准） |
| 11 | 上游 issue「NodeFS ordered persistence and synchronization extension contract」（electric-sql/pglite #1107，仓库现名 neondatabase/electric-pglite）报告了 4、5、6、7 同样的缺口（针对 0.5.8），截至 2026-11-12 仍开着、没有回复 | `gh issue view 1107` |
| 12 | `amcheck` 随主包发布，作为扩展经 `extensions` 选项加载（`@electric-sql/pglite/contrib/amcheck`） | `dist/amcheck.tar.gz`、`dist/contrib/amcheck.js`；检查 6 实际用了它 |

**组 B 的配置**（`packages/store-pglite/src/durability.ts`，持久性模式 `"host-fsync"`，`store-pglite` 的默认值）：

- 启动参数 = 默认参数去掉 `-F`，再加 `fsync=on`、`wal_sync_method=fsync`、`synchronous_commit=on`、`full_page_writes=on`、`data_sync_retry=off`；打开时读回这些设置，不符就拒绝打开。
- 给 NODEFS 装上 `stream_ops.fsync`：对宿主描述符调 `fs.fsyncSync`；失败时返回 EIO，PostgreSQL 因 `data_sync_retry=off` 而 PANIC。这一处同时覆盖预写日志、检查点时的数据文件与目录。
- 打开时的自检：打开存储时 epoch 加 1 的那次提交，若没有经钩子同步 `pg_wal/` 下的文件，就拒绝打开（`durability_not_applied`）。把钩子临时去掉后，打开确实被拒。
- 新建存储时在临时目录里建好，对其中每个文件与目录做 `fsync`，再改名到位并同步父目录（补上第 8 条）。
- 选 `wal_sync_method=fsync` 而不是 `open_datasync`：后者只覆盖预写日志，检查点对数据文件的 `fsync` 仍是空操作；检查点之后旧日志段被回收，数据页若没真正落盘，断电后就会丢。

**组 A**（`"pglite-default"`）：PGlite 的默认参数与 NODEFS 原样不动，只给实验与测试用。

在 Node 这一层能看到的（不是系统调用跟踪）：组 B 下钩子对 `pg_wal/` 下文件的调用计数，10,000 个事务共 10,004 次，每次提交至少一次；组 A 为 0。单元测试 `backend.test.ts`「passes PostgreSQL's WAL fsync to the host on every commit」固定了这一点。

## 本机跑了什么

命令都在仓库根目录执行（`pnpm install` 之后）；原始结果在 `experiments/out/exp1/`（不入库）。

| 内容 | 命令 |
|---|---|
| 检查程序的自检（每项检查都能在对应的损坏上失败） | `node --conditions=source experiments/exp1/check-selftest.ts` |
| 步骤二：强杀 1,000 轮，组 B | `node --conditions=source experiments/exp1/kill-loop.ts --variant kill --durability host-fsync --rounds 1000 --keep-going` |
| 步骤二变体：只终止 DB Worker，200 轮，组 B | 同上，`--variant worker --rounds 200` |
| 步骤二变体：事务进行中强杀，200 轮，组 B | 同上，`--variant midtx --rounds 200` |
| 对照：强杀 200 轮，组 A | 同上，`--variant kill --durability pglite-default --rounds 200` |
| 提交延迟，组 B 与组 A 各 10,000 个事务 | `node --conditions=source experiments/exp1/latency.ts --durability host-fsync`（及 `pglite-default`） |

负载与检查按实验规格：每个事务往"事件头"表插一行（序号 n、上一行的哈希）、往"内容"表插一行约 1 KB 的内容（带 SHA-256 校验和）、更新"业务"表的一行，然后提交；提交返回后写入进程经 TCP 把 n 报给观察者（另一个进程），等观察者回复后才开始下一个事务。每轮后由单独的检查进程重新打开数据目录并做检查 1–6（检查 6 用 `amcheck` 的 `verify_heapam` 检查 `public` 与 `pg_catalog` 下的全部表、`bt_index_check(…, true)` 检查全部 B 树索引）。四组循环同时跑，各用自己的数据目录。

几处做法上的细节：

- 强杀前的随机等待（0.5–5 s）从写入进程启动时算起，所以有些轮杀在打开阶段（PGlite 启动、崩溃恢复）。存储在第一轮之前先建好：组 B 新建存储要同步数据目录里的每个文件，在负载下可能超过 5 s，杀在建库途中的轮次只会得到"没有存储"（建库是原子的），测不到别的东西。一次早期试跑没有预建，前 31 轮都是这种情况，因此改为预建。
- "事务进行中强杀"：写入进程在事务里写完三张表后、提交前停 100 ms 并打印标记，循环在随机等待之后的第一个标记处立即 `SIGKILL`。
- "只终止 DB Worker"：写入进程收到 `SIGUSR2` 后调用 `terminateWorker()`（直接终止线程，不关闭 PGlite），再在同一进程里重新打开存储，然后退出；之后照常由检查进程检查。

检查程序自检的结果：

```
{"case":"intact","failedOn":[]}
{"case":"confirmed commit missing","failedOn":["lostConfirmed"]}
{"case":"gap in event numbers","failedOn":["gaps","badChain","tablesInconsistent"]}
{"case":"broken hash chain","failedOn":["badChain"]}
{"case":"content checksum mismatch","failedOn":["badChecksum"]}
{"case":"tables disagree","failedOn":["tablesInconsistent"]}
```

`amcheck` 能否报出真实损坏没有做阳性对照（要在页面层面制造损坏）。

## 原始数字

**步骤二**（macOS，四组循环同时跑）

| 循环 | 轮数 | 不通过的轮数 | 已确认提交丢失 | `amcheck` 报错 | 累计确认的事务 | 每轮确认的事务 p50（最小–最大） | 检查进程打开耗时 p50 / p95 / 最大（ms） |
|---|---|---|---|---|---|---|---|
| 强杀，组 B | 1,000 | 0 | 0 | 0 | 486,139 | 451（19–1,169） | 367 / 2,650 / 9,787 |
| 只终止 DB Worker，组 B | 200 | 0 | 0 | 0 | 62,802 | 296（58–645） | 233 / 347 / 443 |
| 事务进行中强杀，组 B | 200 | 0 | 0 | 0 | 4,642 | 26（1–43） | 2,109 / 4,627 / 5,745 |
| 强杀，组 A（对照） | 200 | 0 | 0 | 0 | 649,529 | 3,220（116–7,113） | 368 / 496 / 648 |

- 强杀组 B：1,000 轮都杀在写入阶段；823 轮库里的最大序号比已确认序号大 1（提交了、还没来得及报给观察者），177 轮相等。
- 事务进行中强杀：200 轮都杀在"写完三张表、提交之前"，200 轮里那个未提交的序号都没有出现在库里。
- 只终止 DB Worker：200 轮写入进程都在同一进程里重新打开成功（锁被正确释放）；159 轮库里的最大序号比已确认序号大 1：终止发生时提交已在线程里完成、回复没送到，调用方得到 `worker_failed`——"结果未知"，不是丢失。
- "检查进程打开耗时"含 PGlite 启动与崩溃恢复。组 B 崩溃后的打开明显更慢，见「顺带发现」。

运行经过：第一次完整运行时观察者在被强杀的写入进程重置连接时崩溃（未处理的 `ECONNRESET`），循环中断；第二次运行期间为做反证临时改动了 `store-pglite` 的代码，污染了几轮。两次都已作废，修正后从新的数据目录全部重跑，上表是重跑的结果，期间没有改动任何代码。

**提交延迟**（10,000 个事务，从调用 `store.write(…)` 到它返回，ms）

| 组 | 最小 | p50 | p95 | p99 | 最大 | 平均 | 宿主 `fsync`（预写日志 / 全部） |
|---|---|---|---|---|---|---|---|
| B（`host-fsync`） | 3.60 | 4.08 | 5.65 | 6.79 | 30.0 | 4.35 | 10,004 / 10,005 |
| A（`pglite-default`） | 0.27 | 0.37 | 0.49 | 0.67 | 5.2 | 0.39 | 0 / 0 |

两组分别在空闲时单独跑（不与其他循环同时）。组 B 每次提交多出约 3.7 ms，量级与 SSD 上一次 `F_FULLFSYNC` 相符，但这只是间接迹象，不能代替步骤一。

## 步骤一 · macOS

用户在同一台机器上以 root 运行 `experiments/exp1/step1-trace.sh`，先组 B 后组 A，各 100 个事务（UTC 2026-11-12 09:35:58 与 09:36:23 开始；macOS 26.7.1，Node 24.14.0）。`fs_usage -w -f filesys` 附在写入进程上（组 B pid 99752，组 A pid 464），跟踪里的行全部来自这个 node 进程。

**组 B（`host-fsync`）**：跟踪到 150 次 `fcntl … <FULLFSYNC>`，**没有**普通 `fsync`、`fdatasync` 或 `F_BARRIERFSYNC`，即 libuv 的第一种做法就成功了，没有退到后两种。其中 101 次落在描述符 F=69 上，它就是预写日志段：每次提交都是 `pwrite F=69` → `WrData[S] …/pgdata/pg_wal/000000010000000000000001` → `fcntl F=69 <FULLFSYNC>` → 在 F=90 上写（给观察者的确认）。100 个提交里，每一个的"事务开始到提交返回"窗口内都有一次 F=69 上的 `F_FULLFSYNC`（100/100），也就是在确认之前。其余 49 次里，23 次能从跟踪认出文件：`base/5/` 下的数据文件 10 次，`global/pg_control` 2 次，`pg_logical/` 5 次，`pg_multixact/` 3 次，`pg_xact/` 2 次，`pg_commit_ts` 1 次。另外 26 次的描述符是在跟踪器附上之前打开的，认不出文件；它们分属 26 个描述符，每个只同步一次，时间都在最后一次提交返回之后（17:36:06.119–06.244，最后一次提交在 06.082 返回）。从时间看是关闭时的检查点，但这一点只是推断。

**组 A（`pglite-default`）**：0 次 `F_FULLFSYNC`，0 次 `fsync`、`fdatasync`、`F_BARRIERFSYNC`，也没有同步写（只有 55 次异步的 `WrData[A]`）。0/100 个提交窗口有同步调用。

组 B 跟踪文件第 41–44 行与第 57–60 行（连续两次提交；临时目录换成 `<tmp>`，列间空白有压缩）：

```text
17:36:05.483853  close  F=95  0.000003  node.14135297
17:36:05.483934  pwrite  F=69  B=0x2000  O=0x20000084c000  0.000007  node.14135313
17:36:05.483957  WrData[S]  D=0x090e713e  B=0x4000  /dev/disk3s5  <tmp>/tenant/pgdata/pg_wal/000000010000000000000001  0.000012 W node.14135313
17:36:05.493960  fcntl  F=69  <FULLFSYNC>  0.010017  node.14135313
…
17:36:05.498764  close  F=95  0.000001  node.14135297
17:36:05.498802  pwrite  F=69  B=0x2000  O=0x20000084c000  0.000007  node.14135313
17:36:05.498823  WrData[S]  D=0x090e713e  B=0x4000  /dev/disk3s5  <tmp>/tenant/pgdata/pg_wal/000000010000000000000001  0.000014 W node.14135313
17:36:05.507855  fcntl  F=69  <FULLFSYNC>  0.009050  node.14135313
```

**分析脚本**：`fs_usage` 的 `fcntl` 行不带路径，F=69 又是在跟踪器附上之前打开的，所以第一版 `step1-analyze.ts` 把组 B 报成 `commitsWithWalSyncCall: 0`。现在它按跟踪里的 `open F=<fd> … <路径>` 与"`pwrite`/`write F=<fd>` 之后同一线程紧跟的 `WrData[…] <路径>`"记下描述符对应的路径，`close` 时忘掉；只把 `F_FULLFSYNC`、`F_BARRIERFSYNC`、`fsync`、`fdatasync` 算作同步调用（之前把三次 `fcntl <GETFL>` 也算了进去）。对这两份跟踪重跑的结果：

| 组 | 跟踪里写入进程的行 | 提交 | 窗口内有同步调用 | 窗口内有预写日志的同步调用 | 同步调用（按种类） | 路径未知的同步调用 |
|---|---|---|---|---|---|---|
| B | 2,051 | 100 | 100 | **100** | `F_FULLFSYNC` 150 | 26 |
| A | 1,789 | 100 | 0 | 0 | — | 0 |

路径未知的 26 次就是上面那 26 次，F=69 的 101 次全部认得出来。反证：把组 B 跟踪里的 `WrData` 行删掉再分析，`commitsWithWalSyncCall` 回到 0，说明 100/100 来自描述符与路径的对应，而不是别的巧合。

原始跟踪在 `experiments/out/exp1-step1-macos-{B,A}/`，不进仓库。

## 对照通过标准

| # | 标准 | 状态 |
|---|---|---|
| 1 | 步骤一：组 B 下每次提交确认前都观察到针对预写日志的落盘调用；macOS 上必须是 `F_FULLFSYNC`（或书面接受只到普通 `fsync`） | macOS：**满足**（100/100 个提交在确认前对 `pg_wal/` 发出 `F_FULLFSYNC`，没有退到 `F_BARRIERFSYNC` 或 `fsync`；组 A 0 次）。**Linux 未做** |
| 2 | 步骤二：1,000 轮加两个变体各 200 轮，检查 1–6 全过，已确认提交零丢失 | macOS：**满足**（0 / 1,400 轮不通过，丢失 0）。**Linux 未做** |
| 3 | 步骤三：组 B 下 Linux 100 轮、macOS 真机 20 轮，零丢失 | **未做** |
| 4 | 步骤三的阳性对照：组 A 至少丢一次已确认提交 | **未做** |
| 5 | 组 B 提交延迟 p50 ≤ 20 ms、p99 ≤ 200 ms | macOS：**满足**（4.08 ms / 6.79 ms）。Linux 未做 |

按实验规格，标准 1 不满足时，标准 2、3 即使全过也不算通过。标准 1 现在在 macOS 上满足；Linux 上的标准 1、2、5 与步骤三（标准 3、4）都还没做。**目前实验 1 不通过、未判定。**

## 顺带发现

- **组 B 崩溃后的打开更慢**：组 B 强杀后检查进程的打开耗时 p95 2.6 s、最大 9.8 s，组 A 同样情形 p95 0.5 s。原因推测是 PostgreSQL 在 `fsync=on` 下做崩溃恢复前会同步整个数据目录（`SyncDataDirectory`），而现在每次同步都真正到达宿主；前几百轮与其他循环并发，负载也有影响。没有单独测量，留给实验 2a（重开 p95 ≤ 2 s）和实验 6（冷启动）关注。
- **组 B 新建存储更慢**：建库时对新数据目录逐个文件同步，负载下会超过 5 s（见上文"做法"）。没有单独测量。
- **实验 8 的发现与这里相关**：PGlite 上锁失效后，库里的所有权编号拦不住旧实例，见 [`exp-8-single-writer-lock.md`](exp-8-single-writer-lock.md)「与规格的出入」。

## 要人做的（按顺序）

1. **步骤一，macOS**（本机即可，需要 sudo）——**已完成**，结果见「步骤一 · macOS」：

   ```sh
   experiments/exp1/step1-trace.sh B experiments/out/exp1-step1-macos-B
   experiments/exp1/step1-trace.sh A experiments/out/exp1-step1-macos-A
   ```

   脚本启动观察者与写入进程（100 个事务），在写入进程开始写之前用 `sudo fs_usage -w -f filesys <pid>` 附上去，结束后运行 `step1-analyze.ts`，把每个提交窗口（事务开始到提交返回）里的落盘调用计数写到 `analysis.json`。要记下：组 B 是否每个提交窗口都有 `F_FULLFSYNC`（`fcntl` 命令号 51；`F_BARRIERFSYNC` 是 85）或至少 `fsync`；组 A 是否一次都没有。`fs_usage` 不总是给出文件名，所以要人工翻看 `trace.txt`，确认这些调用落在 `pg_wal/` 下的文件上（对照描述符号）。`fs_usage` 打印 `fcntl` 命令的方式随系统版本不同，分析脚本按"FULLFSYNC"或数字 51 识别，认不出时以原始输出为准。系统完整性保护开启时 `dtruss` 不可用，`fs_usage` 可用（未核实，以实际为准）。
2. **步骤一，Linux**（ext4，x86-64 或 arm64）：同样两条命令。脚本用 `strace -f -ttt -y -e trace=fsync,fdatasync,sync_file_range,msync,open,openat,fcntl` 从头跟踪写入进程，`-y` 解出描述符对应的路径，分析脚本据此判断是否落在 `pg_wal/` 上。预期组 B 每个提交窗口有一次对 `pg_wal/…` 的 `fsync`。
3. **步骤二，Linux**：在同一台 Linux 上跑上面"本机跑了什么"表里的四条循环命令（1,000 + 200 + 200 + 对照 200 轮）与两条延迟命令。
4. **步骤三，Linux 虚拟机**：宿主机上按 `experiments/exp1/power-loop-linux-vm.sh` 文件头的说明准备 libvirt 虚拟机（客户机里检出仓库并 `pnpm install`、宿主到客户机免密 ssh），磁盘缓存模式用 `none`（客户机的刷盘请求以 `fdatasync` 到达宿主文件），把实际模式写进报告；然后

   ```sh
   VM=… GUEST_SSH=… GUEST_REPO=… HOST_ADDR=… DISK_CACHE=none \
     experiments/exp1/power-loop-linux-vm.sh B 100 experiments/out/exp1-power-linux-B
   VM=… GUEST_SSH=… GUEST_REPO=… HOST_ADDR=… DISK_CACHE=none \
     experiments/exp1/power-loop-linux-vm.sh A 100 experiments/out/exp1-power-linux-A
   ```

   每轮在写入开始后 3–30 s 的随机时刻 `virsh destroy`（结束虚拟机进程，不是客户机关机），再启动并在客户机里检查。观察者在宿主机上，每个确认都追加写进 `observer-acks.log` 并 `fsync`。**组 A 必须至少丢一次已确认提交，否则方法无效、结果作废**（标准 4）。
5. **步骤三，台式 Mac 真机断电**（笔记本不行）：观察者放在另一台机器上运行 `node --conditions=source experiments/exp1/observer.ts --host 0.0.0.0 --port 47803 --log acks.log`；被测的 Mac 上每次开机后运行 `OBSERVER=<另一台机器>:47803 experiments/exp1/power-round-macos.sh B <输出目录>`，它先检查上一轮留下的数据，再启动写入进程；等至少 3 s 后拔电源，10 s 后恢复、开机，重复。组 B 20 轮；组 A 也要跑（阳性对照），轮数同组 B。
6. 把以上结果补进本文（新增"Linux""断电"两节），逐条更新"对照通过标准"表。标准 1 若在 macOS 上只看到普通 `fsync`，需要团队书面决定是否接受。

## 与规格的出入

没有发现与 `02-architecture.md` §7 冲突的结果：规格把"打开配置项即可落盘"写成待实验确认的假设，事实是光打开配置项确实不够（第 4、5 条）。实验规格里两处说法需要知会：

- "另跑一组带宽松持久性选项的对照"：PGlite 的 `relaxedDurability` 在 Node 文件系统上没有作用（第 7 条），没有可跑的对照。
- 标准 1 预设"打开 fsync 的配置"由 PGlite 提供；实际上组 B 依赖 `store-pglite` 对 NODEFS 的补丁（给 Emscripten 文件系统对象加 `fsync` 回调）。PGlite 升级时，这个补丁所依赖的内部结构（`Module.NODEFS.stream_ops`、`_fd_sync` 的行为）要重新核对；打开时读回设置与上面的自检会在它失效时拒绝打开，单元测试里的钩子计数也会失败。
