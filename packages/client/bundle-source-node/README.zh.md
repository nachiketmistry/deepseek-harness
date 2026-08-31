---
description: "Node Service Provider for the client-bundle source: resolves each Loader row's package through the Loader and node_modules, and serves its built browser bundle and source map from disk."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-bundle-source-node

[English](README.md) | 中文

## 概述

客户端 bundle 来源的 Node Service Provider（默认导出 `NodeClientBundleSource`，按 [`dsh-client-modules`](../modules/README.zh.md) 的定义提供 `ctx.clientBundleSource`）。`resolve(loaderName, baseUrl)` 通过导入该行 Host 侧所用的同一套解析定位 Loader 行挂载的包——运行时具备 Loader internals 时走它，否则退回以树为锚的 `require`——向上找到声明该模块的最近祖先 manifest，并读取其 `dsh.client` 声明与 `exports["./client"]`。`snapshot` 在读取字节前先 stat，因此写入若落在两者之间，基线会比字节更旧，watcher 随之重建；`readSourceMap` 校验 `.map` 同级文件是否为规范的 Source Map v3；`watchPath` 返回 HMR（热模块替换）Node 侧做 stat 轮询的绝对路径。

## 目录

- [使用本包](#使用本包)
- [理解实现](#理解实现)
- [Model Experience](#model-experience)
- [已知限制与待办](#已知限制与待办)
- [开发备注](#开发备注)

---

<a id="使用本包"></a>

## 使用本包

把它挂载在 `@deepseek-ai/dsh-client-modules` 之前——后者注入 `clientBundleSource`，且只通过它读取声明与字节：

```yaml
- id: client-bundle-source
  name: '@deepseek-ai/dsh-client-bundle-source-node'
- id: modules
  name: '@deepseek-ai/dsh-client-modules'
```

没有文件系统的 Host 在同一个 Service Definition 上组合另一个 provider；注册表本身不变。

<a id="理解实现"></a>

## 理解实现

解析不到包根的行——Loader 内置项（`cordis:include`）、子路径条目——以及声明不是 `platform: web` 的包，都返回 `undefined`。注册表在进程内按行缓存该判定，因此插件集合的变化在重启后生效。

未导出 `./client` bundle 或 `dsh.client` 字段畸形的 web 包会从 `resolve` 抛错。bundle 缺失时 `snapshot` 抛出 `MissingClientBundleError`，注册表把它们归并为一条构建说明；其他文件系统失败原样传播。

<a id="model-experience"></a>

## Model Experience

None, as the package only locates and reads browser bundles for the client module system; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

<a id="已知限制与待办"></a>

## 已知限制与待办

- **判定在进程内永久有效** — 注册表不会重新判断某一行是否变成了客户端包，因此向运行中的 Host 安装一个包需要重启。

### 开发备注

这里的解析逻辑原本属于客户端模块注册表，直到 bundle 来源成为 Service Definition。它保持行为不变，因此 Node 部署感知不到变化；这条 seam 的存在，是为了让平台 Host 能改由构建期 manifest 作答。
