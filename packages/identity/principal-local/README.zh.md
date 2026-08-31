---
description: "The single-principal provider for maintainers running the harness without an identity service: one configured organization and user for every request."
kind: "package-reference"
---

# @deepseek-ai/dsh-principal-local

[English](README.md) | 中文

## 概述

本包正是"没有身份服务的部署"在 harness 内部呈现的样子。它提供 `ctx.principal`，并以同一个配置好的组织与用户回答每一个请求，因此 CLI 与 headless 配置拥有真实的 principal，下游也无需就"身份是否存在"分支。由该 principal 派生出的键，与多 principal 部署所写的形状完全相同，这正是让单用户不成为一条独立代码路径的原因。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在部署恰好只有一个调用者的场合组合它：

```yaml
- principal-local:
    org: org_local
    user: usr_local
```

两个字段都是必填。它们没有默认值，是因为它们会落进永久的对象键与存储键，而尚未做出选择的部署必须在加载时失败，而不是悄悄采用一个别的部署也会挑中的共享名字。

<a id="understand-the-implementation"></a>
## 理解实现

`LocalPrincipalResolver` 继承 [`PrincipalResolver`](../principal/README.zh.md)，在构造函数中构建一个冻结的 `Principal`，`current()` 对每个请求都返回它。这里没有按请求的工作、没有缓存，也没有超出插件自身的生命周期：配置值就是全部状态。

subject 始终是 `user` 变体。没有身份服务的部署，键盘前坐的是人而不是机器调用者，因此其他变体在此不可达。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-principal`](../principal/README.zh.md) —— Service Definition、principal 值与 `hostObjectName`。
- [principal seam Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.zh.md) —— 单 principal 部署为何被建模为一个 provider，而不是被建模为 principal 缺失。

<a id="model-experience"></a>
## 模型体验

无，因为该 provider 回答的身份问题，请求装配从不读取。

#### KV Cache 影响

无直接影响；这里没有任何内容进入模型请求，因此本包既不延长也不失效任何已缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **principal 在加载时固定** —— 更改它意味着重新加载插件。运行中的树内无法切换 principal，这是刻意为之：到那时由它派生的存储键已经在使用了。
- **不做身份服务校验** —— 配置的标识符照单全收。没有任何代码检查它们是否对应真实的组织或用户，因此一个拼写错误会产出一个可用的部署，寻址一个别人永远不会寻址的对象。

<a id="dev-note"></a>
### 开发备注

无。
