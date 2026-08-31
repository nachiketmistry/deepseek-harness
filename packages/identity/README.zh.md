---
description: "identity 包组：一个请求以谁的身份行事，以及由遥测、反馈与 DeepSeek 提供方请求共享的匿名按 harness home 关联 id。"
kind: "package-group"
---

# identity/ — 共享身份

[English](README.md) | 中文

## 概述

identity 组回答两个彼此独立的问题。principal seam 说明一个请求以谁的身份行事，这是每一个按调用者划分的存储键所派生自的值；匿名 id 则给一个 harness home 一个关联值，供遥测、反馈与 DeepSeek 请求附加到各自的记录上，而无需识别用户身份。本页是组的映射，各包 README 负责细节。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`anonymous-user-id`](anonymous-user-id/README.zh.md) | 让每个 harness home 拥有一个匿名 id，遥测、反馈与 DeepSeek 请求把它附加到记录上，使来自同一安装的记录无需识别用户即可被辨认 |
| [`principal`](principal/README.zh.md) | 说明一个请求以谁的身份行事，并拥有由该 principal 派生的 Durable Object 名字 |
| [`principal-local`](principal-local/README.zh.md) | 以一个配置好的 principal 作答，供没有身份服务的部署使用 |

<a id="related-documentation"></a>
## 相关文档

- [Identity 子系统](../../docs/subsystems/identity.zh.md) —— principal seam、其类型，以及对象名字方案。
- [会话遥测子系统](../../docs/subsystems/session-telemetry.zh.md)——在导出中携带该 id 的遥测功能。
- [dsh-llm-deepseek](../llm/llm-deepseek/README.zh.md)——在请求中携带该 id 的 DeepSeek 提供方。
- [dsh-command-feedback](../feedback/command-feedback/README.zh.md)——在确认文本中点名该匿名安装的反馈命令。

<a id="dev-note"></a>
## 开发备注

无。
