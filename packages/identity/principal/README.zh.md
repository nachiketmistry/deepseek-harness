---
description: "The verified-principal seam for maintainers wiring identity into the harness: the principal value, the Cordis service that answers with it, and the Durable Object name derived from it."
kind: "package-reference"
---

# @deepseek-ai/dsh-principal

[English](README.md) | 中文

## 概述

本包说明一个请求以谁的身份行事。principal 是一个组织加上其中的一个 subject，也是每一个随部署而异的存储键所派生自的值。本包只回答这个问题，从不提出它：Service Provider 提供的是上游已经验证过的 principal，而这里没有任何代码做认证、解析令牌或与身份服务通信。本包同时拥有 `hostObjectName`，即构造 principal 所寻址的 Durable Object 名字的唯一位置，因为该名字的每一段都是永久的。

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

为 `ctx.principal` 组合一个 Service Provider，然后在调用方身份决定可触达哪些数据的地方读取 `ctx.principal.current()`。[`dsh-principal-local`](../principal-local/README.zh.md) 是没有身份服务的部署所用的 provider；它以一个配置好的 principal 作答，这正是让 CLI 与 headless 配置成为普通部署、而不是一条独立的单用户代码路径的原因。

### principal 值

```ts
interface Principal {
  readonly org: OrganizationId
  readonly subject: PrincipalSubject
}

type PrincipalSubject =
  | { readonly kind: 'user'; readonly user: UserId }
```

`OrganizationId` 与 `UserId` 是身份服务签发的、带 brand 的不透明标识符。它们绝不是邮箱、显示名或任何人可以更改的值，因为两者都会进入无法重写的永久键。subject 是一个联合，今天只有一个变体：客户端凭据的调用者是没有用户 id 的机器，而日后从裸用户 id 拓宽会破坏每一个消费方。

### 对象名字

```ts
hostObjectName({ org: OrganizationId('org_a'), subject: { kind: 'user', user: UserId('usr_1') } })
// => 'dsh:1:org_a:usr_1'
```

请调用它，而不要自行拼接字符串；它是构造该名字的唯一位置。身份服务的标识符中不可能含有 `:`，因此各段解析无歧义。

<a id="understand-the-implementation"></a>
## 理解实现

`PrincipalResolver` 是挂在单数键 `principal` 上的抽象 Cordis `Service`，只有一个方法 `current()`。它是 resolver 而非 store，因为它定位的是上游已确立的答案，自身不拥有任何生命周期。

有三项决定被冻结进 `hostObjectName`，而每一项都源自 Durable Object 无法改名这一点：`idFromName` 把一个名字映射到一个对象，换一个名字就是另一个对象，且不持有旧对象的任何状态。

- **`dsh:` 前缀** —— 把 principal 寻址的对象与日后可能共用该 class 的任何其他名字区分开。
- **`1:` 版本** —— 按名字寻址的命名空间所拥有的唯一逃生口。`dsh:2:` 命名空间依然会抛弃每一个 `dsh:1:` 对象，因此它把一次事故变成一次刻意的迁移，而不是让名字变得可逆。
- **组织段** —— 从第一次提交起就在场。在用户只属于一个个人组织期间，这一段不改变任何可观察行为；日后再加则要把每个对象重新建键，而那恰恰是部署终于持有值得保留的状态的时刻。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-principal-local`](../principal-local/README.zh.md) —— 没有身份服务的部署所用的 Service Provider。
- [Capability seams](../../../docs/capability-seams.zh.md) —— 本 seam 在 harness 其他可替换能力中的位置。
- [principal seam Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.zh.md) —— 这些标识符为何是这个形状，以及每一个备选方案的代价。

<a id="model-experience"></a>
## 模型体验

无，因为该 seam 拥有的是身份值类型与一个纯名字函数；请求装配从不读取二者。

#### KV Cache 影响

无直接影响；这里没有任何内容进入模型请求，因此本包既不延长也不失效任何已缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有 provider 选择或优先级** —— 每棵树上该 seam 恰好持有一个 `ctx.principal` provider。必须接受多种令牌类型的部署应在其 provider 内部解决，而不是组合两个 provider。
- **名字方案不可迁移** —— `hostObjectName` 可以升版本，但无法重新指向。改动 `HOST_OBJECT_NAME_VERSION` 会遗弃此前版本下寻址的每一个对象，而本包不提供搬迁其内容的路径。
- **subject 联合只有一个变体** —— 没有用户 id 的客户端凭据 subject 已被类型覆盖但尚未实现，因此 `hostObjectName` 还没有对应它的段形状。

<a id="dev-note"></a>
### 开发备注

无。
