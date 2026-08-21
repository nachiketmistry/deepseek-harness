# @deepseek-ai/dsh-host-webserver-node

[English](README.md) | 中文

web 载体的 Node Service Provider（默认导出 `NodeWebServer`，配置为 `{host, port}`）：一个在激活时监听的 `node:http` 服务器，按 [`dsh-host-webserver`](../webserver/README.zh.md) 的定义提供 `ctx.webServer`。每个请求经由导出的 `toFetchRequest(req, res)` 变为 Fetch `Request` —— URL 的 authority 是请求的 `Host` 头，正文不缓冲地流式传入，客户端在响应结束前离开时 signal 中止 —— 再由载体的 `fetch` 分发；`writeFetchResponse(response, res)` 带 socket 背压地把正文流式写回。`host` 只接受 `127.0.0.1`（默认姿态）与 `0.0.0.0`（有意的网络暴露）；`address` 读取配置的 host 与监听端口（`port` 为 0 时是操作系统分配的值）。WebSocket 路由通过 `ws` 提供：未注册路径上的升级会销毁 socket，路由 `authorize` 的拒绝在任何握手之前原样写到 socket 上，已接受的握手把 `ws` socket 交给路由的 `open`。

监听失败（EADDRINUSE……）从激活中抛出并带绑定诊断拒绝 Loader 组合；失败的候选 fiber 被 dispose。处理时抛错的 HTTP 请求（兜底持有者对畸形 % 转义调用 `decodeURIComponent`、客户端在正文中途断开）应答 400 —— 响应头已发出时则销毁 socket —— 并记录为 warning；它从不退出进程。升级失败或已升级 socket 的传输错误记录为 warning 并销毁其 socket。dispose 会终止已接受的 WebSocket，启动 `close()` 与 `closeAllConnections()`，销毁每个被跟踪的已升级 socket，并只在 HTTP 服务器与这些 socket 关闭后返回。本服务器只服务浏览器；Electron 通过 `file://` 加载 dist，并经由 IPC 桥承载 fetch。本包从不打印；URL 行属于 shell。

## Model Experience

None, as the package is the Node listener behind the web carrier; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## 已知限制与待办

- **没有 TLS、认证或 origin 策略** — 绑定非回环地址会把服务器暴露给该网络；部署加固（或在前面放一个真正的反向代理）在面向开发者的 v1 中有意不在范围内。
- **socket 选项固定** — 配置只选择绑定 host 与端口，backlog 及其他 socket 设置在部署需要之前保持内部。
