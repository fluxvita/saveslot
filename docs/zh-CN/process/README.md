# saveslot · 过程材料

设计过程留下的记录，不是方案本身；方案以 [`../spec/`](../spec/README.md) 为准。

| 位置 | 是什么 |
|---|---|
| [`decisions/`](decisions/) | 设计决定及其理由 |
| [`walkthroughs/`](walkthroughs/) | 场景推演 |
| [`experiments/`](experiments/) | 开发前实验的运行结果（做法与通过标准在 `decisions/pre-dev-w0-experiments.md`） |

调研归属决定：[`技术调研公开，竞品与商业研究内部`](decisions/research-ownership.md)。现有技术调研留在主仓库，新材料按类型分流，公开设计不依赖内部调研。

**关于审查报告**：决定稿里提到的审查报告（如"一致性审查 C-3""第二轮核对 R-B1"）是设计阶段的内部审查记录，不在本仓库；每条发现的结论与理由都已写进对应的决定稿，条目号只作标识。

**关于路径**：规格文件原先放在文档根目录，后来移进了 `spec/`。早于这次移动的记录里，以纯文本写的规格路径（如 `09-event-format.md:1310`、`03-data-model/03-deletion.md`）相对于现在的 `docs/zh-CN/spec/` 目录；行号是写记录当时的行号。之后全部文档又整体移进了 `docs/zh-CN/`：早于这次移动的记录里以纯文本写的 `guide/`、`spec/`、`research/`、`process/` 路径，相对于现在的 `docs/zh-CN/`。记录里提到的 `HANDOFF.md`、`DRAFT.md`、`interface.md`、`changelog.md`、`archive/`、`reviews/` 是设计阶段的内部文件或已拆分改名的旧文件，不在本仓库。
