# Agent Note: a Session's project directory goes through the filesystem seam

Status: implemented

[English](2026-08-30-session-project-directory-through-the-filesystem-seam.md) | 中文

## 问题

创建 Session 时会确保其项目目录存在，而 `session-controller` 用的是从 `node:fs/promises` 导入的 `mkdir`。

这个调用恰好只在一种部署中是正确的：文件就在运行 harness 的那台主机上。凡是 `fs` 接缝指向别处的地方它都是错的，而在 Cloudflare 上它直接失败——Worker 的 `node:fs` 是一个桩，部署的文件位于 Worker 无法抵达的 sandbox 容器中。在 Cloudflare 网页 GUI 中开启对话的每一次尝试都以 `failed to ensure project directory "/workspace/…": operation not permitted` 失败，那是桩在拒绝，而不是任何人能在配置里修好的权限问题。

没有任何东西捕获到它。接缝的全部意义在于调用方不知道由哪个后端作答，而一次直接导入悄悄地把这条路径从中一次性地为所有部署摘了出去。组合平价账本记录 Cloudflare 构建丢弃的行，它记录不了它所保留的行内部的一次 Node 调用。

## 决定

`ApiSessionAgentController` 调用 `this.ctx.fs.ensureDirectory(cwd)`，`SessionController` 注入 `fs`。该操作本就属于接缝，没有为它新增任何东西。

注入而非取用 `ctx.get('fs')` 是有意为之。项目目录无法创建的 Session 不是 Session，因此组合了本控制器却没有文件系统 Provider 的部署，应当在激活时失败，而不是在第一次对话时失败。每一个组合了该控制器的配置都已经组合了 Provider：`packages/bundle/base` 挂载 `fs-sandbox`，Cloudflare 构建把那一行替换为 `fs-cf-sandbox`，`sdk-minimal` 挂载 `fs-local`。

两个手工搭建上下文的套件现在挂载真实的 `LocalFileSystem` 而非替身。这些用例就项目目录所断言的东西——在普通文件之下创建会失败、竞态创建会被共享——是主机文件系统的行为，而一个回答 `undefined` 的桩会把它们变成对桩的测试。

`list.ts` 仍然导入 `node:fs` 的 `stat`，用于会话日志自身磁盘位置上的 cold-blank 探测。那条路径只有当会话持久化报告存在物理制品时才会抵达，而 Durable Object 后端不会，因此它被留在原处，而不是被投机性地推广。

## 备选方案

**`ctx.get('fs')` 加 `node:fs` 兜底。** 已否决：那是运行路径内部的隐藏默认值，仓库的"包边界上显式优于隐式"规则将其排除在外；而且它恰好保留了正在被修复的那种失败——忘记配置 Provider 的部署，会继续悄悄写到运行 harness 的那台主机上，而不是写到它的文件真正所在之处。

**在控制器里加一个 Cloudflare 专用分支。** 已否决：控制器无权知道自己身处哪个平台，而这个分支将不得不在下一次 `node:fs` 调用处重复出现，而不是被那道本就存在的接缝消除。

**给接缝新增 `ensureDirectory`。** 无此必要：`FileSystem.ensureDirectory` 早已存在，且语义正是此处所需——这也正是那次直接导入属于违规而非空缺的原因。

**保持原样，并从 Cloudflare 组合中丢弃 Session 创建那一行。** 已否决：开启对话就是产品本身，因此那一行丢不得；而平价账本条目会在一处只需两行修复的地方记下一个能力缺口。

## 影响

`session-controller` 现在等待 `fs`，因此既不提供 Provider 也不提供该服务的手工上下文会停滞，而非抵达断言。那是预期的失败，且它在激活时响亮地发生，而不是安静到有人开启对话为止。

Cloudflare 部署现在能创建 Session，这正是让[浏览器验收运行](../architecture/2026-08-30-edge-verified-principal-and-the-browser-session.zh.md)成为可能的前提；也正是那次运行让本问题浮出水面。

包内仍留有一处 `node:fs` 导入，已于上文指明。`packages/` 中任何在非 Node 部署会执行的路径上取用 `node:fs` 的地方都有同样的缺陷，而今天没有任何门禁覆盖它。
