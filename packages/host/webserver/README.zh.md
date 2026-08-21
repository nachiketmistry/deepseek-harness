# @deepseek-ai/dsh-host-webserver

[English](README.md) | 中文

web 载体的 Service Definition（默认导出抽象类 `WebServer`，即 `ctx.webServer`）：基于 Fetch 标准分发的 HTTP 与 WebSocket 路由注册表、带原始变换 tap 的结构化 index 注入表，以及接收所有无路由认领请求的唯一兜底席位。Service Provider 继承 `WebServer`，拥有监听器或平台入口，并把每个请求转发给 `fetch(request)`；[`dsh-host-webserver-node`](../webserver-node/README.zh.md) 是发布的 Web 组合所挂载的 `node:http` provider，平台 provider 以同样方式转发其 fetch 入口。`register(route)` 添加一条具名 `exact`/`prefix` HTTP 路由，其处理器为 `(request: Request) => Response | Promise<Response>`；`registerUpgrade(route)` 为精确路径添加一条 WebSocket 路由，可选的 `authorize(request)` 通过返回 HTTP 应答来拒绝握手，`open(request, socket)` 驱动已接受的 socket 直到其关闭。任一表内的重复路径都会抛错，因为路由模式是组合层面的契约，冲突即配置错误；两个方法都返回移除注册的 disposer。`registerFallback(handler)` 注册唯一一个处理无具名路由匹配请求的处理器。第二次注册会抛错；SPA dist 服务器 [`dsh-host-frontend-static`](../frontend-static/README.zh.md) 是发布版的持有者，未注册时 `fetch` 回答 404。index 启动输入是结构化行：`collectIndexInjections()` 每次调用通过一次 `webserver/index-inject` emit 收集一张新的 `IndexInjection` 表，`renderIndex(html)` 先把这些行渲染进 index.html 正文，再按注册顺序应用原始的 `tapIndex(transform)` 变换（`applyIndexTaps(html)`，面向行无法表达的标记的逃生口）；兜底处理器在每次 index 响应时调用 `renderIndex`，静态部署则通过其启动载荷传送同样的行，并用导出的 `renderIndexInjections` 渲染。`address` 读取 provider 绑定的 `{host, port}`（其他插件据此适配的组合期事实，例如目录选择器与 URL 行），对由平台 fetch 入口驱动的 provider 则为 `undefined`。HTTP 匹配顺序固定：先整表精确匹配，再最长前缀，最后兜底处理器；`upgradeRoute(pathname)` 为 provider 的握手精确匹配 WebSocket 路由。注册顺序不带任何面向请求的语义。

请求 URL 的 authority 就是客户端所寻址的（其 `Host`），因此 `/api` 信任围栏从请求头读取它；`request.signal` 在客户端离开时中止，流式响应（SSE）据此得知应当停止。`WebServerSocket` 是每个 provider 都能提供的 WHATWG 子集（`readyState`、`send`、`close`，以及针对 `message`、`close`、`error` 的 `addEventListener`）；在自身重启后恢复 socket 的 provider 会用恢复的 socket 再次调用该路由的 `open`。路由处理器的 rejection 传播到 provider，由其作为单次请求失败应答；Service Definition 从不退出进程。本包不了解任何 harness 概念，也不提供文件：`/api` 路由与下行 WebSocket 由 connection 插件拥有，插件 bundle 与 HMR 事件流由 modules/hmr 插件拥有，dist 服务由兜底持有者负责。本包从不打印；URL 行属于 shell。

## Model Experience

None, as the package is a Web carrier between the browser and the HTTP/WebSocket routes other plugins register; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## 已知限制与待办

- **没有 TLS、认证或 origin 策略** — 载体分发其 provider 接受的一切；部署加固属于 provider 或其前置的反向代理。
- **WebSocket 路由仅支持精确路径** — 一个 socket 只有一个协议持有者，且没有已发布的消费者需要前缀匹配的 socket。
