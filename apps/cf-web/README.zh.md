# @deepseek-ai/dsh-cf-web

[English](README.md) | 中文

面向 Cloudflare 组装的 dsh web GUI：一个 Worker 提供浏览器外壳，一个 Host Durable Object 托管 harness 插件树，每个用户一个 Sandbox SDK 容器存放会话工作所用的 git 项目。本应用拥有 wrangler 配置、Worker 入口以及宿主树的 workerd bundle；Cloudflare 侧的 Service Provider 位于 `packages/cf/*`。

## Gate 0：workerd 上的 web 宿主树

`pnpm --filter @deepseek-ai/dsh-cf-web run gate0` 通过工作区解析器把 web 组合（`packages/bundle/base` 加 `packages/bundle/web-app`）的每个包行打包到 workerd，并写出 [gate0-imports.md](gate0-imports.md)：每个 Node 内置模块及其导入方，以及相对 10 MiB Worker 上限的压缩后体积，完整树和 CF 目标组合（去掉被 CF 包替换的行）各一份。`pnpm --filter @deepseek-ai/dsh-cf-web run test:workerd` 是运行时的一半：它在 workerd（`nodejs_compat`）内逐个求值 CF 目标组合的每个包模块，任一模块顶层求值抛错即失败。

结果：完整树打包无任何未解析导入（gzip 0.98 MiB）；CF 目标组合 gzip 0.40 MiB，其 108 个包模块全部可在 workerd 下求值。目标组合中的每一处 Node 耦合都发生在调用时（某个 provider 在挂载时触碰磁盘、进程或监听套接字），这正是 `packages/cf/*` 的 Service Provider 在现有 Service Definition 之后所替换的部分。

## 目录结构

- `scripts/workspace-resolver.mjs` 通过各包 `exports` 映射并带 `workerd` 条件，把 `@deepseek-ai/*` 导入解析到已构建的 `lib/`，因此 Worker 消费的是已发布的产物平面，从不消费工作区源码。
- `scripts/composition.mjs` 读取两个 web bundle 层的包行，并为 CF 组合不挂载的每一行声明处置方式：由 Cloudflare Provider 替换、对本部署不适用，或是能力缺口。
- `scripts/parity.mjs` 把这些处置方式与组合器的账目投影为 [composition-parity.md](composition-parity.md)，并在声明过期时失败；`build` 脚本会在打包前运行它，`parity:check` 在签入的报告过期时失败。
- `scripts/gate0.mjs`、`scripts/build-probe.mjs` 与 `tests/workerd/gate0-eval.workerd.ts` 是 gate 0 的两半。
- `scripts/build.mjs` 把 `src/worker.ts` 打包为 `dist/worker.js`；`wrangler.jsonc` 部署这个预构建文件。
- `tests/workerd/*.workerd.ts` 通过 `@cloudflare/vitest-pool-workers`（`vitest.workerd.config.ts`）在 workerd 内运行；仓库的 Node vitest 匹配模式不会命中该后缀。

## 已知限制与待办

[composition-parity.md](composition-parity.md) 是当前清单，由构建实际组合出的内容生成：本部署不挂载哪些 web 行、每一行由哪个 Cloudflare Provider 顶替，以及因此缺失哪些能力。当前的未决缺口是 skills（没有任何 Provider 注册进 `skills` 注册表，因此每个 preset 的 `tool-skill` 提供的目录始终为空）与 `minimal` preset。工作流引擎、Code Mode 的 worker-thread 运行时以及 `dsh-cordis-host-runner` 依赖 `node:worker_threads` 或 `node:vm`，按决策留在 CF 组合之外，而非疏漏。
