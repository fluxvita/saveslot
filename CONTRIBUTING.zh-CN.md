# 参与贡献

完整的说明在 [`docs/zh-CN/guide/12-contributing.md`](docs/zh-CN/guide/12-contributing.md)：代码怎么分包、每种测试防什么、实现顺序、规格怎么读、改设计时同步什么。这里只列提交流程的要点。

## 流程

1. 从主分支拉一个分支。没有向仓库推分支的权限时，先 fork，在自己的 fork 里拉分支。
2. 向 `main` 提合并请求（用了 fork 就从 fork 提），按模板填写。合并请求都提到 `main`，给已发布版本的修复也一样：合进 `main` 之后由维护者挑到那个版本的发布分支（`release/0.<小版本>`）。标题用 conventional commits 写法，它就是 squash 之后那个提交的标题；CI 会检查标题（类型限 `feat`、`fix`、`docs`、`test`、`build`、`ci`、`chore`、`refactor`、`perf`、`revert`、`style`，范围用小写）。
3. 分支推上去之后只在末端追加提交：审过的提交保持原样。分支保持线性，不带合并提交：合并请求以 fast-forward 的方式 squash 进 `main`，带合并提交的分支在合并时变基不了。分支只是落后于 `main` 时不用处理，维护者在合并时变基。与 `main` 有冲突，或者叠到最新的 `main` 上 `pnpm check` 不再通过时，由你变基到最新的 `main`，在那个头上跑 `pnpm check`，用 `git push --force-with-lease` 推上去，并在合并请求上写一句（旧头、新头、各处冲突的取法）。已推的分支只在这一种情况下重写。维护者不替作者在分支上解冲突。
4. 合并的条件：合并请求的流水线（快检查：标题、签名、密钥、禁用词）通过；`pnpm check` 在要合并的头上通过（你在推之前跑，把结果贴进描述；维护者视改动的风险在合并前于最终的头上再跑一遍）；评审讨论全部解决，并由一位维护者批准。
5. 由维护者 squash 合并。

## 约定

- **提交信息**用 conventional commits（`feat(kernel): …`、`fix(cli): …`、`docs(spec): …`）。
- **语言**：提交信息、代码注释、标识符、日志与报错文案一律用英文。文档以中文版（`docs/zh-CN/`）为准。规格与讲解另有英文版，放在 `docs/` 下不带语言标记的同名路径（清单见 [`docs/README.md`](docs/README.md)）；`docs/zh-CN/process/` 与 `docs/zh-CN/research/` 的英文版待补。改有英文版的中文文档时，在同一个合并请求里把英文版一起改。每份英文文件在开头写明中文源的路径：`Translated from docs/zh-CN/<同名路径>, updated in the same commit as this file.`，由 `pnpm docs:translations` 检查。中文版之后又改了、英文版没跟上时，在这一行下面加一行说明：`The Chinese edition has changed since: …`。
- **每个提交带 `Signed-off-by`**（`git commit -s`）。这是 DCO（Developer Certificate of Origin）：表示你有权按本项目的许可证提交这段内容。本项目不设 CLA。签名用真实姓名，邮箱与提交作者的邮箱相同；CI 会检查签名与作者是否一致。
- **借助 AI 完成的贡献**：可以用 AI 工具。签名永远由人来加，不由工具加；签名的人对改动负责，如同亲手写的一样：读过、理解，并且有权按本项目的许可证提交。不要在提交信息里加把改动归于 AI 工具的署名行，签名已经说明谁负责。
- **规格先行**。改变行为的改动，在同一个合并请求里改 `docs/zh-CN/spec/`；影响读者理解的，同步改 `docs/zh-CN/guide/`。改事件格式、内核不变量、契约的不兼容改动，先在 `docs/zh-CN/process/decisions/` 提一份决定稿并通过评审，再改规格与代码。
- **调研归属**：技术调研进 `docs/zh-CN/research/`；竞品分析、市场与产品快照、产品定位、收费和商业策略类调研放内部仓库，不进本仓库。混合报告按内容拆分，不留两份同步正文；公开设计依赖的结论必须在本仓库独立成立，不能依赖内部调研。现有技术报告保留原位，公开前标注已被取代的建议与未核实判断，不改写原结论、不删历史。
- **不提交**密钥、内部地址、与项目无关的个人信息。
- **golden 文件**：模型读的一部分文字（MCP 服务的 `instructions`、prompts）固定在测试旁边的 `__golden__/` 目录里。有意改这些文字时，用 `pnpm exec vitest run <测试文件> -u` 更新，与改动一起提交；评审看这些文件的 diff 就是看措辞的变化。设了 `CI`（CI 里就是这样）时，golden 文件不一致或缺失都会让测试失败，不会写出新的。
- 在要推的头上本地跑 `pnpm check`（类型检查、lint、测试、依赖规则、文档链接、JSON 例子），结果贴进合并请求。CI 跑的是同一组脚本，但在合并之后与每晚跑，不在合并请求上跑。主分支变红时优先修。

## 跑测试

- **一次运行的临时目录**：每跑一次测试（`pnpm test`、`pnpm check`、`pnpm exec vitest run …`）会建一个目录 `/tmp/sst-XXXXXX`，并把 `TMPDIR` 指到它里面；测试的 home 与数据目录都建在那里。运行结束时删掉这个目录，测试没删干净的东西会列出来；测试留下没停的进程会被停掉，并让这次运行失败。被强杀的运行留下的，由下一次运行开头清掉。想看失败的测试留下了什么，设 `SAVESLOT_TEST_KEEP_TMP=1`：目录保留并打印路径（进程照样会被停掉），看完自己删。
- **在 PostgreSQL 上跑测试**：`pnpm check` 里的测试跑在 PGlite 上。`pnpm test:postgres` 把内核在真实存储上的测试、连同 PostgreSQL 后端自己的测试，放到一台 PostgreSQL 服务器上跑；没有服务器时，后端自己的测试在 `pnpm check` 里是跳过的。改动涉及存储接口、某个后端或内核发出的 SQL 时跑它：

  ```sh
  SAVESLOT_TEST_POSTGRES_URL=postgres://user[:password]@host[:port]/postgres pnpm test:postgres
  ```

  没设这个变量会立刻失败。脚本名后面的参数原样交给 Vitest（某个文件、`-t <名字>`）。
- **准备本地的 PostgreSQL**：服务器必须是 PostgreSQL 18，URL 里的用户要有建库权限。怎么装都行，比如 Homebrew（`brew install postgresql@18 && brew services start postgresql@18`，URL 用 `postgres://$USER@localhost/postgres`）或容器（`docker run -d -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:18`，URL 用 `postgres://postgres:test@localhost/postgres`）。测试每开一个库就是一个单独的 database，名字形如 `sst_h<机器>_r<运行>_…`；一次运行结束时删掉它建的，同一台机器上被强杀的运行留下的由下一次运行删掉。`<机器>` 是一台机器第一次跑测试时生成的标记，存在 `~/.local/state/saveslot-tests/machine`（设了 `$XDG_STATE_HOME` 时在它下面）；共用一台服务器时靠它分清各台机器的库，所以不要把这个文件拷到别的机器上。请用一台可以随便建删这类 database 的服务器，不要用存着数据的。

## 在哪讨论

- 缺陷、任务与调研：Issues，选对应的模板。
- 提问与设计讨论：Discussions。
- 安全问题：见 [`SECURITY.zh-CN.md`](SECURITY.zh-CN.md)，不要公开提 Issue。

## 许可证

贡献的内容按 [Apache-2.0](LICENSE) 授权。
