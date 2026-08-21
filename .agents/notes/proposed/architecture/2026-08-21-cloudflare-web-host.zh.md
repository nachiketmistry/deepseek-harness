# Agent Note: the web GUI host tree on Cloudflare

Status: proposed

[English](2026-08-21-cloudflare-web-host.md) | 中文

## Problem

web GUI 目前只能作为 Node 进程运行：`apps/cli` 从磁盘 profile 组装插件树，`dsh-host-webserver` 在 `node:http` 上监听，`dsh-client-connection` 通过 `ws` 升级 WebSocket，`dsh-client-modules` 扫描 `node_modules` 寻找客户端 bundle，而每个持久化或执行类 provider（JSONL 持久化、JSON 存储、设置与凭据文件、附件、spill、本地文件系统、本地子进程、操作系统沙箱、操作系统目录选择器）都触碰宿主机器。cordis-cf-poc 的阶段 1 到 4b 已证明 agent（智能体）spine、复用 harness 编解码器的 DO-SQLite 持久化以及 facet 托管的工具可在 workerd 上零改动运行；要在 Cloudflare 上托管完整产品，剩下的是宿主与 web 层：一个提供浏览器外壳的 Worker、每个部署一个承载插件树的 Host Durable Object、每个用户一个存放 git 项目的 Sandbox SDK 容器。

## Proposal

分五个 pull request 在 Cloudflare 上组装 web GUI，每个在其边界处以草稿 PR 提交：

1. **Gate 0**（`apps/cf-web`）：把 web 组合打包到 workerd，并在 workerd 内求值 CF 目标组合的每个包模块。已交付：完整树打包无任何未解析导入，gzip 0.98 MiB；CF 目标组合（108 个包行）gzip 0.40 MiB，所有模块均可求值。没有结构性阻塞：每处 Node 耦合都发生在调用时。
2. **在现有包中抽取 seam**：为 web 服务器定义一个 Service Definition，即基于现有 `ctx.webServer` 路由注册表的 fetch 处理器（Node 监听器成为其中一个 Service Provider）；为 WebSocket 下行链路定义一个 Service Definition（`ws` 升级路径成为其中一个 Service Provider）；用构建期 manifest（元数据清单）替换 `dsh-client-modules` 中 `node_modules` 扫描的客户端 bundle 来源 Service Definition；不读取磁盘 profile 的免文件组合路径与 agent preset 来源。vendored 的 Loader 在浏览器中已经基于模块表运行；CF 宿主基于构建期模块表与字面量（无 `!!js`）行运行它。
3. **cwd 经由 `ctx.fs`**：工作区 realpath 与 mkdir 以及 `session.create` 的 cwd 解析都经由文件系统 Service Definition；`process.cwd()` 默认值从 `sandbox-policy`、`fs-sandbox`、`apiproxy`、`agent-instructions` 与 `file-reference-local` 中移除。
4. **`packages/cf/*`**：在现有 Service Definition 之后的 Service Provider：`webserver-cf`（可休眠 WebSocket）、`assets-cf`、`persistence-do`（PoC 移植）、`storage-do`、`settings-do`、`credentials-secrets`、`attachment-r2`、`spill-r2`、`fs-cf-sandbox`、`subprocess-cf-sandbox`、`sandbox-passthrough`、`directory-picker-cf`（浏览 `/workspace` 并克隆 git URL），以及基于 `ctx.fs` 的 skill provider。
5. **`apps/cf-web`**：Worker、Host Durable Object、Sandbox 绑定与 wrangler 配置，部署到 workers.dev。

已定决策：单用户，除受信任主机围栏外不做认证；每用户一个沙箱，项目是 `/workspace/<name>` 下的目录；创建工作区即克隆一个 git URL，私有仓库通过来自 Worker secrets 的 GitHub token 在沙箱中物化为 `GH_TOKEN` 加 git 配置；项目文件的持久性由 git 承担；采用 Sandbox SDK `@next` 线（argv `exec`、进程句柄、无进程 stdin、`setEnvVars`），而非 E2B；UI bundle 保持不动。范围之外：认证与多租户、worker-thread 工作流引擎与 Code Mode 运行时、`dsh-cordis-host-runner`、R2 备份。

## Alternatives considered

- **把宿主包 fork 成 CF 变体** — 否决：seam 设计的意义就是一次 provider 替换即可迁移整个产品；fork `apiproxy`、`connection` 或 `modules` 会在之后每次变更时分叉。Gate 0 表明 Node 耦合位于 provider 与三个狭窄的宿主 seam 中，这正是第 2 步要抽取的内容。
- **在容器内以 Node 运行 web 应用** — 否决：这会放弃 Durable Object 持久化、可休眠套接字以及 PoC 已证明的按唤醒 reconcile，并保留一个平台会令其闲置退出的长驻进程。
- **Sandbox SDK 稳定线（`exec(string)`、会话、stdin）** — 否决：预览版移除了会话与进程 stdin，子进程 Service Provider 必须围绕这一点设计（仅 argv，`{ data }` stdin 经由沙箱文件）；以稳定线为目标会在 1.0 时再移植一次。

## Acceptance criteria

在已部署的 workers.dev URL 上：GUI 启动；"克隆 git URL"创建一个项目；该项目上的会话跑完一个轮次，其中模型编辑一个文件并通过普通 bash 工具执行 `git commit` 与 `git push`，提交在远端可见；会话日志在真实的 Durable Object 驱逐后仍然存在；无密钥的 `text-turn` 快照经由 Host Durable Object 回放结果完全一致。

## Risks

- 随产品发布的 preset 与 bundle 层中的 `!!js` 行无法在 workerd 上求值；CF 组合提供字面量行，因此 preset 与 bundle 行有了第二个来源，必须保持一致。
- Sandbox SDK 预览版没有进程 stdin；需要 `stdin: 'pipe'` 的消费者（LSP、外部子代理 provider）不在 CF 组合内。
- Sandbox SDK 预览版会在稳定的沙箱 id 之后替换容器；进程句柄无法跨越这种替换，因此跨容器替换的 bash 轮次会失败并重新开始，而不是恢复。
