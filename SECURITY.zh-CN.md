# 安全政策

[English](SECURITY.md) · 简体中文

## 报告漏洞

安全问题请通过仓库的私密漏洞报告提交（GitHub 上：**Security** 标签页 → **Report a vulnerability**）。不要为漏洞公开提 Issue、发起讨论或提合并请求。

请写明发现了什么、怎么复现、受影响的版本或提交，以及你预计的影响。我们会确认收到报告，修复期间告知进展；除非你不愿署名，修复公告里会致谢。

## 支持的版本

saveslot 处在 1.0 之前，安全修复只进最新的发布版本。

## 范围

saveslot 防什么、不防什么，见 [`docs/zh-CN/spec/02-architecture.md`](docs/zh-CN/spec/02-architecture.md) 第 10 节的信任边界。例如本机模式下能直接读写数据目录的程序在边界之外，这是写明的行为，不算漏洞。
