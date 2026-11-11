# 参与贡献

完整的说明在 [`docs/zh-CN/guide/12-contributing.md`](docs/zh-CN/guide/12-contributing.md)：代码怎么分包、每种测试防什么、实现顺序、规格怎么读、改设计时同步什么。这里只列提交流程的要点。

## 流程

1. 从主分支拉一个分支。
2. 提合并请求。CI 全绿，并有一人评审通过。
3. squash 合并。

## 约定

- **提交信息**用 conventional commits（`feat(kernel): …`、`fix(cli): …`、`docs(spec): …`）。
- **语言**：提交信息、代码注释、标识符、日志与报错文案一律用英文。文档目前以中文版（`docs/zh-CN/`）为准，公开前补齐英文版，英文版放在 `docs/` 下不带语言标记的位置。
- **每个提交带 `Signed-off-by`**（`git commit -s`）。这是 DCO（Developer Certificate of Origin）：表示你有权按本项目的许可证提交这段内容。本项目不设 CLA。
- **规格先行**。改变行为的改动，在同一个合并请求里改 `docs/zh-CN/spec/`；影响读者理解的，同步改 `docs/zh-CN/guide/`。改事件格式、内核不变量、契约的不兼容改动，先在 `docs/zh-CN/process/decisions/` 提一份决定稿并通过评审，再改规格与代码。
- **不提交**密钥、内部地址、与项目无关的个人信息。
- 本地跑检查：`pnpm check`（类型检查、lint、测试、依赖规则、文档链接、JSON 例子）。CI 跑的是同一组脚本。

## 在哪讨论

- 缺陷与任务：Issues。
- 提问与设计讨论：Discussions。
- 安全问题：用仓库的私密漏洞报告，不要公开提 Issue。

## 许可证

贡献的内容按 [Apache-2.0](LICENSE) 授权。
