# 参与贡献

完整的说明在 [`docs/zh-CN/guide/12-contributing.md`](docs/zh-CN/guide/12-contributing.md)：代码怎么分包、每种测试防什么、实现顺序、规格怎么读、改设计时同步什么。这里只列提交流程的要点。搭环境、跑检查、做第一个改动，照 [`docs/zh-CN/development.md`](docs/zh-CN/development.md) 走。

## 流程

1. 从主分支拉一个分支。没有向仓库推分支的权限时，先 fork，在自己的 fork 里拉分支。
2. 向 `main` 提拉取请求（用了 fork 就从 fork 提），按模板填写。拉取请求都提到 `main`，给已发布版本的修复也一样：合进 `main` 之后由维护者挑到那个版本的发布分支（`release/0.<小版本>`）。标题用 conventional commits 写法，它就是 squash 之后那个提交的标题；CI 会检查标题（类型限 `feat`、`fix`、`docs`、`test`、`build`、`ci`、`chore`、`refactor`、`perf`、`revert`、`style`，范围用小写）。描述里写明改了什么、为什么改、有意没做什么、实际跑了哪些检查；对应某个 Issue 时在描述里写 `Closes #<号>`（标题、分支名与提交信息里不写）。把拉取请求指派给自己，打上合适的标签（`bug`、`enhancement`、`documentation`、`spec`、`research`）。还不能评审时开成草稿，可以评审了再转为就绪。
3. 分支推上去之后只在末端追加提交：审过的提交保持原样。分支保持线性，不带合并提交。分支只是落后于 `main` 时不用处理，它原样 squash 进 `main`。与 `main` 有冲突，或者叠到最新的 `main` 上 `pnpm check` 不再通过时，由你变基到最新的 `main`，在那个头上跑 `pnpm check`，用 `git push --force-with-lease` 推上去，并在拉取请求上写一句（旧头、新头、各处冲突的取法）。已推的分支只在这一种情况下重写。维护者不替作者在分支上解冲突。
4. 评审讨论逐条回复：改了的说明改在哪个提交，不同意的说明理由。讨论由提出的评审者标为已解决，作者不自己标。每次推送之后在拉取请求上用一两句话说明改了什么。批准之后再推送，批准会被撤销，拉取请求重新评审。
5. 检查失败了先读日志，不靠重跑让它通过：是自己的改动就修；认为与自己的改动无关时，在拉取请求上说明，并原样贴出失败的测试、种子与断言。
6. 合并的条件：CI 在拉取请求上跑的检查全部通过（标题、签名、密钥、禁用词，以及 `pnpm check`）；评审讨论全部解决；由作者之外的一位维护者批准。
7. 由维护者 squash 合并，`main` 上的提交带着拉取请求的标题与编号。不要合并自己的拉取请求，也不要向 `main` 或发布分支推送：两者都会被拒绝。

## 约定

- **提交信息**用 conventional commits（`feat(kernel): …`、`fix(cli): …`、`docs(spec): …`）。
- **语言**：提交信息、代码注释、标识符、日志与报错文案一律用英文。规格与讲解有中文、英文两个版本，语义对齐：中文版在 `docs/zh-CN/`，英文版在 `docs/` 下不带语言标记的同名路径（清单见 [`docs/README.md`](docs/README.md)）；`docs/zh-CN/process/` 与 `docs/zh-CN/research/` 只有中文版，英文版不排期。两个版本在同一个拉取请求里一起改；两者不一致算缺陷，请提 Issue。每份文件在开头有一行链到另一个版本：英文文件是 `English · [简体中文](<路径>)`，中文文件是 `[English](<路径>) · 简体中文`，由 `pnpm docs:translations` 检查。一个版本改了、另一个没能在同一个拉取请求里跟上时，在另一个版本的这一行下面加一行说明：英文文件写 `The Chinese edition has changed since: …`，中文文件写 `英文版此后有改动：…`。英文文档里链接有英文版的页面时链英文版；链到它的中文版，同一个检查会失败。
- **每个提交带 `Signed-off-by`**（`git commit -s`）。这是 DCO（Developer Certificate of Origin）：表示你有权按本项目的许可证提交这段内容。本项目不设 CLA。签名用真实姓名，邮箱与提交作者的邮箱相同；CI 会检查签名与作者是否一致。
- **借助 AI 完成的贡献**：可以用 AI 工具。签名永远由人来加，不由工具加；签名的人对改动负责，如同亲手写的一样：读过、理解，并且有权按本项目的许可证提交。不要在提交信息里加把改动归于 AI 工具的署名行，签名已经说明谁负责。
- **规格先行**。改变行为的改动，在同一个拉取请求里改规格（`docs/zh-CN/spec/` 与 `docs/spec/`）；影响读者理解的，同步改讲解（`docs/zh-CN/guide/` 与 `docs/guide/`）。改事件格式、内核不变量、契约的不兼容改动，先在 `docs/zh-CN/process/decisions/` 提一份决定稿并通过评审，再改规格与代码。
- **规格引用**。代码注释引用规格时写文件和 `«»` 里的标题，照中文版原文写，如 `05-time «挡点»`。标题指那个文件里的一个章节标题、一条加粗条目或一行表格的名字。引用正文用普通引号，不用 `«»`，引号里只写那个文件里逐字有的话。`pnpm docs:spec-refs` 检查每一处引用，不检查引号里的话。
- **调研归属**：技术调研进 `docs/zh-CN/research/`；竞品分析、市场与产品快照、产品定位、收费和商业策略类调研放内部仓库，不进本仓库。混合报告按内容拆分，不留两份同步正文；公开设计依赖的结论必须在本仓库独立成立，不能依赖内部调研。现有技术报告保留原位，公开前标注已被取代的建议与未核实判断，不改写原结论、不删历史。
- **不提交**密钥、内部地址、与项目无关的个人信息。
- **golden 文件**：模型读的一部分文字（MCP 服务的 `instructions`、prompts）固定在测试旁边的 `__golden__/` 目录里。有意改这些文字时，用 `pnpm exec vitest run <测试文件> -u` 更新，与改动一起提交；评审看这些文件的 diff 就是看措辞的变化。设了 `CI`（CI 里就是这样）时，golden 文件不一致或缺失都会让测试失败，不会写出新的。
- 推之前本地跑 `pnpm check`（类型检查、lint、测试、依赖规则、文档链接、JSON 例子、两个版本互相链接的那一行、断言索引、代码里的规格引用、合并冲突标记）。CI 在每个拉取请求上跑同一组脚本；合并之后与每晚在 `main` 上再跑，另加 Node 26 LTS 和 PostgreSQL 上的测试。性质测试长跑每晚单独跑，发现失败的测试各开一个 issue。`main` 变红时优先修。

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

公开之前，项目的 Issue 与改动记在一台内部服务器上。迁到 GitHub（2026-11-26）之后那边只读：Issue、讨论和补丁都到这里来，补丁以向 `main` 的拉取请求提交。

## 许可证

贡献的内容按 [Apache-2.0](LICENSE) 授权。
