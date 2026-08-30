# Agent Note：web 宿主传输接缝（载体、bundle 来源、无文件组合、preset 来源）

Status: implemented

[English](2026-08-21-web-host-transport-seams.md) | 中文

## 问题

web GUI 宿主树在四处被绑定到 Node，而这些点与该树所做的事毫无关系：`dsh-host-webserver` 自身就是一个 `node:http` 监听器，其路由处理器接受 `IncomingMessage`/`ServerResponse`，因此每个路由拥有者（connection、modules、hmr、frontend-static）都是 Node 形状的，而下行 WebSocket 在 connection 插件内跑在 `ws` 上；`dsh-client-modules` 用 `createRequire` 遍历 `node_modules` 来解析客户端 bundle；唯一的启动路径经 `Include` 从磁盘 profile 的 `cordis.yml` 组合出一棵树；`dsh-agent-presets` 把 preset 当作目录发现，并通过在其组合文件上插入一个 `Include` 来挂载，把长驻的 generation 键控在该文件的 stat 上。两项模块加载事实在平台宿主上叠加了这一问题：`dsh-llm` 经 `createRequire(import.meta.url)` 读取自身版本，而在 workerd 上它没有文件 URL；被 vendored 的 Loader 在导入时用 `new Function` 编译其 `!!js` 求值器，而生产 workerd 拒绝这样做。[Cloudflare web 宿主系列](../../proposed/architecture/2026-08-21-cloudflare-web-host.zh.md)的 Gate 0 表明这些是仅有的结构性耦合。

## 决策

**web 载体是一个按 Fetch 标准分发的 Service Definition。** `dsh-host-webserver` 保留 `ctx.webServer` 与各注册表，但 `WebServer` 是抽象的：`register(route)` 接受 `(request: Request) => Response | Promise<Response>` 处理器，`fetch(request)` 按精确 → 最长前缀 → fallback → 404 分发，`registerUpgrade(route)` 接受 `{ path, authorize?(request), open(request, socket) }` 并作用于 `WebServerSocket`（WHATWG 子集 `readyState`/`send`/`close`/`addEventListener`），而 `address` 报告已绑定的 `{host, port}`，对由平台驱动的 provider 则为 `undefined`。`dsh-host-webserver-node` 是 Node 侧的 Service Provider：它监听、从 `node:http` 构建 `Request`（URL authority 取自 `Host` header，body 流式传输，客户端离开时 signal abort）、带背压地把 `Response` 流回、以 400 回应单次请求的失败，并拥有 `ws` 握手。因此 connection 插件的下行泵驱动 `WebServerSocket`，其 body 上限成为 Fetch 层的 `withBodyLimit` 包装；`frontend-static`、`modules` 与 `hmr` 返回 `Response`（HMR 事件流是一个由 `request.signal` 结束的 `ReadableStream` SSE body）。

**客户端 bundle 来自一个 Service Definition。** `dsh-client-modules` 定义 `ClientBundleSource`（`ctx.clientBundleSource`：`describe`、`read`、`readSourceMap`、`locate`），注册表只经它读取声明与字节；bundle 的 rev 是字节的 FNV-1a 哈希。`dsh-client-bundle-source-node` 是 Node provider，从 `ctx.baseUrl` 出发经 `node_modules` 解析 `package.json`；平台 provider 则从构建期清单作答。

**一棵树可以不经磁盘 profile 组合出来。** `dsh-app-boot` 导出 `bootEntries(binName, rows, { modules, prepare, baseUrl })`：它挂载被 vendored 的 Loader，安装一个由表支撑的 `internal` 模块加载器（`tableModuleLoader`，与浏览器外壳已提供的 `internal.import` 契约相同），注册 `cordis:group` 内置项，并把字面量 `EntryOptions` 行挂到 Loader 的内存根上。这些行不携带 `!!js`；表未命中或某行失败会以与 `boot()` 相同的带标签诊断被拒绝。

**preset 来自一个 Service Definition，并作为行挂载。** `dsh-agent-presets` 定义 `AgentPresetSource`（`ctx.agentPresetSource`：`list`、`stamp`、`composition`、`read`、`authorable`、`copy`、`remove`）；注册表把长驻 generation 键控在来源的不透明 stamp 上，并通过在来源返回的行上插入一棵内存 `EntryTree` 来挂载 preset，裸说明符从 harness 基址解析，相对说明符从该组合的 `baseUrl` 解析。`dsh-agent-presets-filesystem` 是持有目录发现、元数据、创作与 stat stamp 的 provider；已发布的 Web 组合把它作为 `agent-preset-source` 行挂载，而 `apps/cli` 把已发布的根 patch 到该行上。

**模块加载的可移植性。** `dsh-llm` 与 `dsh-session-telemetry-otel` 通过导入自身 `./package.json` 导出的 JSON 读取版本，bundle 会将其内联；被 vendored 的 Loader 在首次使用时才编译其表达式求值器（vendor 修改 19），因此禁止由字符串生成代码的宿主也能导入 Loader 并挂载字面量行。

## 备选方案

- **保留 Node 形状的路由处理器，并加一个伪造 `IncomingMessage`/`ServerResponse` 的 CF 适配器**——已拒绝：耦合正是 Node streams API；其他每个路由拥有者都会继续对它写入，而该伪造件还得复现 Fetch 类型已经标准化的背压与关闭语义。
- **单独的 WebSocket 下行 Service Definition**——已拒绝：下行对传输的唯一需求是一个可往里泵帧的已接受套接字，而载体的 `WebSocketRoute.open` 已经交出了它；只有一个内部调用者的 service 正是 `packages/AGENTS.md` 点名的坏味道。恢复休眠套接字的 provider 会重新调用 `open`。
- **Node 侧也用构建期清单**——本次变更中已拒绝：Node provider 保留今天的解析方式，因此 Node 用户一切照旧；Service Definition 才是让平台宿主带上自己清单的东西。
- **在平台宿主上求值 `!!js` 行**——不可能：生产 workerd 拒绝由字符串生成代码。字面量行是平台宿主唯一能挂载的组合，这正是 `bootEntries` 接受行而非文件的原因。

## 后果

- `dsh-host-webserver` 不再依赖 `node:http` 或 schemastery；`ws` 移到 Node provider。原先挂载 `@deepseek-ai/dsh-host-webserver` 的组合改为挂载 `@deepseek-ai/dsh-host-webserver-node`，而读取 `webServer.host`/`port` 的消费者改读 `webServer.address`，并在其为 undefined 时大声失败。
- `/api` 请求 body 仍按 `maxRequestBodyBytes` 缓冲，如今由 connection 插件中的 `withBodyLimit` 完成，而不再由载体完成。
- `dsh-client-modules` 注入 `clientBundleSource`；Web 组合把 Node provider 行挂在 `modules` 之前。
- `dsh-agent-presets` 注入 `agentPresetSource`，其配置为 `{ default }`；各个根与用户根是文件系统 provider 的配置。
- Cloudflare 宿主在 `apps/cf-web` 中为 CF 目标组合出字面量行；那里的 bundle 与 preset 行是 YAML 层之外的第二处来源，必须靠评审保持一致。
