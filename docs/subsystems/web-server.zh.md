# HTTP 服务器

[English](web-server.md) | 中文

[dsh-host-webserver](../../packages/host/webserver) 是 GUI 宿主的 web 载体 Service Definition：提供 `ctx.webServer` 的抽象类 `WebServer`，包含按 Fetch 标准分发的具名路由注册表、WebSocket 路由注册表、index.html 注入行与转换回调，以及一个可由插件认领的回退处理器。Service Provider 继承它并拥有监听器：[dsh-host-webserver-node](../../packages/host/webserver-node) 绑定 `node:http` 并通过 `ws` 接受 WebSocket；平台 provider 转发自己的 fetch 入口。该载体不属于 agent loop（智能体循环），也不是工具意义上的能力 seam；它不了解任何 harness 概念。其他插件负责注册所有功能路由，包括 `/api` 路由、插件 bundle 和 HMR（热模块替换）事件流（[分层说明](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.zh.md)）。它只服务浏览器：Electron 通过 `file://` 加载已构建文件，并经 IPC 桥接发送 fetch 请求，不使用本服务器。

源码：[`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## 路由

```ts type-equiv
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'
```

```ts type-equiv
/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Produces the complete or streaming response. */
  handler: WebRequestHandler
}
```

匹配顺序固定：先查 exact 表，再取最长匹配前缀，再落到已注册的回退，最后 404。注册顺序不携带任何面向请求的语义：具名路由在组合上互不相交，任何未被具名路由认领的请求都由回退席位应答；席位只有一个所有者，第二次注册会抛出异常。发布的 Web 组合用 [`dsh-host-frontend-static`](../../packages/host/frontend-static/src/index.ts) 认领席位，即遵循固定语义的 SPA dist 服务器：非 GET/HEAD 返回 405，越出 dist 根目录的遍历返回 403，可读的 index 在 dist 根目录和配置的 index 路径渲染，现有文件直接提供，缺失或不是文件的目标返回空的 404，未知扩展名按 octet-stream 发送。

## WebSocket 路由

```ts type-equiv
/** One exact-path WebSocket route registration. */
interface WebSocketRoute {
  /** Absolute pathname, no trailing slash. */
  path: string
  /**
   * Decide before the handshake. A returned response refuses the upgrade and
   * is delivered as the plain HTTP answer; `undefined` accepts it.
   * @param request - the upgrade request.
   */
  authorize?: (request: Request) => Response | undefined
  /**
   * Drive one accepted socket until it closes. A provider that recovers
   * sockets after its own restart (hibernation) calls this again with the
   * recovered socket and the request it was accepted for.
   * @param request - the upgrade request.
   * @param socket - the accepted server-side socket.
   */
  open: (request: Request, socket: WebServerSocket) => void | Promise<void>
}
```

`WebServerSocket` 是每个 provider 都能提供的 WHATWG `WebSocket` 子集（`readyState`、`send`、`close`，以及针对 `message`、`close`、`error` 的 `addEventListener`）；Node 的 `ws` socket 与平台服务端 socket 都在结构上满足它，因此 connection 插件的下行链路无需了解 provider 即可泵送帧。

## Provider 配置

Node provider 监听一个地址：

```ts type-equiv
/** Provider config: the listen address. */
interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
}
```

`host` 只接受 `127.0.0.1`（默认姿态）和 `0.0.0.0`（刻意的网络暴露）；没有 TLS、认证或 origin 策略，因此绑定到非回环地址会把服务器暴露给该网络。dist 位置是认领席位的前端插件的组装事实。

## 服务

`WebServer`（`ctx.webServer`）通过 `fetch(request)` 分发：Node provider 在激活时立即监听，监听失败（EADDRINUSE 等）会使初始化被拒绝，启动进程据此报告失败的 fiber。`register(route)` 添加一条具名路由并返回其 disposer；重复的 `(kind, path)` 抛出异常，因为路由模式是组合层约定，冲突即配置错误。`collectIndexInjections()` 经一次 `webserver/index-inject` emit 收集结构化 `IndexInjection` 行，`renderIndex(html)` 把它们渲染进成功的根路径和配置 index 响应，随后再按注册顺序应用原始的 `tapIndex(transform)` 逃生口转换；[dsh-client-modules](../../packages/client/modules) 以启动 manifest（元数据清单）行回应该事件。`address` 读取 provider 绑定的 host 与端口，包括 Node 配置的 `port` 为 0 时操作系统分配的端口，对平台驱动的 provider 则为 `undefined`。

请求 URL 的 authority 就是客户端所寻址的地址，`request.signal` 在客户端离开时中止，因此流式处理器（SSE，Server-Sent Events）在中止时结束其正文。处理过程中抛出异常的请求（畸形的 % 转义撞上 `decodeURIComponent`、客户端在请求体中途断开）由 Node provider 记录为警告并应答 400（响应头已发出时则销毁 socket），绝不导致进程退出。Node 的 dispose（资源释放）把 `close()` 与 `closeAllConnections()` 配对使用并终止已接受的 WebSocket，因为处理器可能保持响应打开，而这类连接永远不会自行结束；没有强制关闭，拆卸就会挂起。这些包从不打印输出：URL 行归 shell 所有。逐包运维细节留在 [Service Definition README](../../packages/host/webserver/README.zh.md) 与 [Node provider README](../../packages/host/webserver-node/README.zh.md) 中。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxwebserver--webserver"></a>

### `ctx.webServer` — `WebServer`

The browser HTTP carrier service. Activation listens immediately. Route registration order does not affect requests because configured named routes must be distinct, and the fallback handler answers anything not yet claimed during startup with 404 until its owner registers. A listen failure rejects initialization, and the boot process reports the failed fiber.

```ts cordis-catalog
/**
 * Register a named route. Duplicate (kind, path) throws — route patterns are
 * a composition-level contract, so a collision is a misconfiguration.
 * @param route - kind, path, and the owning handler.
 * @returns the disposer removing the route.
 */
register(route: WebRoute): () => void

/**
 * Register an exact-path HTTP upgrade route. Duplicate paths throw because
 * one socket can have only one protocol owner.
 * @param route - pathname and handler owning negotiation plus socket use.
 * @returns the disposer removing the route.
 */
registerUpgrade(route: WebUpgradeRoute): () => void

/**
 * Claim the fallback seat: the handler answering every request no named
 * route matches (the SPA dist server in the shipped Web composition). One
 * owner only — a second registration throws, because two fallbacks cannot
 * compose.
 * @param handler - owns the full response lifecycle of unmatched requests.
 * @returns the disposer releasing the seat.
 */
registerFallback(handler: WebRoute['handler']): () => void

/**
 * Register a raw-HTML index transform, the escape hatch for markup no
 * {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
 * registration order after rendering the structured rows.
 * @param transform - pure html-to-html function.
 * @returns the disposer removing the transform.
 */
tapIndex(transform: (html: string) => string): () => void

/**
 * Run an index.html body through the registered taps in registration order
 * — called by the fallback owner on every index response it renders.
 * @param html - the raw index.html body.
 * @returns the transformed body.
 */
applyIndexTaps(html: string): string

/**
 * Gather the structured injection table: one `webserver/index-inject` emit,
 * every subscriber pushes its current rows. Fresh per call, so subscribers
 * read live state (module graph, theme preference) at emit time.
 * @returns rows in subscriber activation order.
 */
collectIndexInjections(): IndexInjection[]

/**
 * Render one index.html body: the structured injection table first, then
 * the raw `tapIndex` transforms over the result.
 * @param html - the raw index.html body.
 * @returns the transformed body.
 */
renderIndex(html: string): string
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

<a id="webserver-events"></a>

### `webserver/*` events

<a id="webserverindex-inject--emit"></a>

#### `webserver/index-inject` — emit

Collect the structured index injection table. Emitted on every index render and every worker boot-payload request; listeners push their current rows, so a row's data is read fresh at emit time.

```ts cordis-catalog
/**
 * Collect the structured index injection table. Emitted on every index
 * render and every worker boot-payload request; listeners push their
 * current rows, so a row's data is read fresh at emit time.
 * @param table - Mutable row table; listeners append in activation order.
 * @mode emit
 */
'webserver/index-inject'(table: IndexInjection[]): void
```

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)
<!-- END GENERATED cordis-surface -->
