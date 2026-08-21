# @deepseek-ai/dsh-client-bundle-source-node

[English](README.md) | 中文

客户端 bundle 来源的 Node Service Provider（默认导出 `NodeClientBundleSource`，按 [`dsh-client-modules`](../modules/README.zh.md) 的定义提供 `ctx.clientBundleSource`）。它从配置树锚点 `ctx.baseUrl`（即 `cordis.yml` 所在目录，其包把每个被组合的插件都声明为依赖；provider 自身的 URL 在 pnpm 隔离的 `node_modules` 下会找不到兄弟包）经 `node_modules` 把包名解析到其 `package.json`，读取 `dsh.client` 声明与 `exports["./client"]`，并从磁盘提供构建后的 bundle 及其 `.map` 同级文件。判定在进程内永久有效：不是可解析包根的名字（Loader 内置项、子路径行）或声明不是 `platform: web` 的包，`describe` 返回 `undefined` 并保持不变，因此插件集合的变化在重启后生效。未导出 `./client` bundle 或声明字段畸形的 web 包会从 `describe` 抛错；bundle 文件缺失时 `read` 抛出 `MissingClientBundleError`（注册表把它们归并为一条构建说明），其他文件系统失败原样传播。`locate` 返回 bundle 的绝对路径，供 HMR（热模块替换）的 Node 侧做 stat 轮询。`ctx.baseUrl` 未设置时构造函数抛错。

## Model Experience

None, as the package only locates and reads browser bundles for the client module system; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## 已知限制与待办

- **每个进程一个锚点** — 每个包都从 `ctx.baseUrl` 解析；若组合的行分布在多个无关的 `node_modules` 树下，需要按行锚定的 provider。
