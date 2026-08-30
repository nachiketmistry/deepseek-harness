---
description: "The Cloudflare principal provider for maintainers deploying the harness behind an identity service: edge token verification against a cached key set, and the object's own verified principal."
kind: "package-reference"
---

# @deepseek-ai/dsh-principal-jwt

[English](README.md) | 中文

## 概述

本包是 [principal 接缝](../../identity/principal/README.zh.md)的 Cloudflare 角色，也是同一套安排的两半。在边缘，`PrincipalTokenVerifier` 对照按 isolate 缓存的密钥集校验身份服务的 JWT，发生在 Worker 寻址任何东西之前。在对象内部，`CfPrincipalResolver` 提供 `ctx.principal`，并以该对象自身名字所记录的 principal 作答。二者不可能分歧，因为 Worker 正是用它所校验的 principal 构建了那个名字。

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

### 在边缘

每个 isolate 构建一个校验器，并用它返回的 principal 寻址对象：

```ts
import { PrincipalTokenVerifier, VerifierConfig } from '@deepseek-ai/dsh-principal-jwt'
import { hostObjectName } from '@deepseek-ai/dsh-principal'

const verifier = new PrincipalTokenVerifier(VerifierConfig({
  jwksUrl: env.AUTH_JWKS_URL,
  issuer: env.AUTH_ISSUER,
}))

const { principal } = await verifier.verify(token)
const object = env.HOST.get(env.HOST.idFromName(hostObjectName(principal)))
```

`jwksUrl` 与 `issuer` 是必填的。没有指名自己所信任的身份服务的部署会直接失败，而不是对着猜来的东西作校验。`refreshFloorSeconds`、`cacheMaxAgeSeconds` 与 `clockToleranceSeconds` 有默认值；`audience` 只有在部署为其 token 划定受众时才填写。

每个 isolate 一个实例是其预期寿命。密钥集缓存及其刷新下限就住在校验器内部，因此每个请求重建一次的校验器会每次都重新拉取身份服务的密钥集，下限也就什么都保护不了。

`verify` 以 principal 与"token 不再被接受的时刻"作答，后者正是基于它建立的会话所能持续的时长。对于畸形、未签名、由该密钥集所不持有的密钥签名、已过期、永不过期、由另一个服务签发，或缺少构建对象名所需的任一声明的 token，它抛出 `PrincipalTokenError`。

### 在对象内部

用对象自身的名字挂载 Provider：

```ts
await root.plugin(CfPrincipalResolver, { objectName: ctx.id.name })
```

`objectName` 是必填的，而没有任何 principal 寻址的名字会在启动时失败。由生成 id 而非 `hostObjectName` 寻址的对象没有可服务的 principal，因而不得运行。

<a id="understand-the-implementation"></a>
## 理解实现

校验发生在边缘，因为对象必须先被寻址才能运行：其内部的检查发生在租户已被选定之后。在 `idFromName` 之前就拒绝，正是让隔离成为结构性事实、而非"检查是否正确"之事的原因。

`verify` 要求 `exp`。没有过期时间的 token 会让会话比身份服务所能作出的每一次吊销活得更久，因为边缘在请求路径上什么也不问那个服务。

签名通过之后，两个声明都会被重新检查。token 是线路输入，而 `org` 与 `sub` 会成为抵达永久 Durable Object 名字的带标识符；其中含有 `:` 的值会使该名字产生歧义。

Provider 读取 `parseHostObjectName(objectName)`，而非请求携带的任何东西。名字不可变，在任何请求存在之前就已存在于构造函数中，并且能挺过休眠——唤醒后送达的 socket 消息不带任何可供读取 principal 的请求。

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-principal`](../../identity/principal/README.zh.md) —— Service Definition、principal 值与对象名。
- [`dsh-principal-local`](../../identity/principal-local/README.zh.md) —— 没有身份服务的部署所用的 Provider。
- [边缘校验 principal 的 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-30-edge-verified-principal-and-the-browser-session.zh.md) —— 为何 token 由 cookie 携带、为何 Host 不再认证，以及这些的代价。

<a id="model-experience"></a>
## 模型体验

无，因为本包回答的是一个请求装配从不读取的身份问题。

#### KV 缓存影响

无直接影响；此处没有任何东西抵达模型请求，因此本包不会延长或失效任何已缓存前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **打开的 socket 比它的 token 活得更久** —— 边缘校验升级请求而不再逐帧校验，因此已在流式传输的会话会越过 `exp` 继续，直到它重连。要约束这一点，要么在对象内部重新校验（该安排已否决），要么给 socket 设定寿命，而目前还没有谁需要。
- **过期之前无法吊销** —— 边缘在每个请求上都不询问身份服务，因此在其背后的会话结束之后，token 在剩余寿命内仍然有效。token 自身的过期时间就是全部边界。
- **只有一套密钥集** —— 必须接受来自多个身份服务的 token 的部署无法在此表达；配置只指名一个 `jwksUrl` 与一个 `issuer`。
- **subject 联合只有一个变体** —— Provider 解析的名字，其 subject 字段只能是用户 id；在新变体的永久名字段被选定之前，第二个变体会在 `parseHostObjectName` 处无法编译。

<a id="dev-note"></a>
### 开发备注

无。
