---
description: "Node Service Provider for the web carrier: a node:http listener that bridges each request into the Fetch dispatch, streams the response back with backpressure and optional gzip, and owns the WebSocket handshake."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-webserver-node

English | [中文](README.zh.md)

## Summary

The Node Service Provider for the web carrier (default-exported `NodeWebServer`, config `{host, port}`): a `node:http` server that listens on activation and provides `ctx.webServer` as defined by [`dsh-host-webserver`](../webserver/README.md). Each request becomes a Fetch `Request` through the exported `toFetchRequest(req, res)` — the URL authority is the request's `Host` header, the body streams without buffering, and the signal aborts when the client goes away before the response ends — and the carrier's `fetch` dispatches it; `writeFetchResponse(response, res)` streams the body back with socket backpressure. `host` accepts only `127.0.0.1` (default posture) and `0.0.0.0` (deliberate network exposure); `address` reads the configured host and the listening port (the OS-assigned value when `port` is 0). WebSocket routes are served through `ws`: an upgrade on an unregistered path destroys the socket, a route's `authorize` refusal is written raw on the socket before any handshake, and an accepted handshake hands the `ws` socket to the route's `open`.

## Table of Contents

- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

---

<a id="understand-the-implementation"></a>

## Understand the implementation

A listen failure (EADDRINUSE…) throws out of activation and rejects Loader composition with the bind diagnostic; the failed candidate fiber is disposed. An HTTP request whose handling throws (a fallback owner's `decodeURIComponent` on a malformed %-escape, a client dropping mid-body) is answered 400 — or the socket destroyed when headers are already out — and logged as a warning; it never exits the process. An upgrade failure or upgraded-socket transport error is logged as a warning and destroys its socket. Disposal terminates accepted WebSockets, starts `close()` and `closeAllConnections()`, destroys every tracked upgraded socket, and returns only after the HTTP server and those sockets have closed. This server serves browsers only; Electron loads dist over `file://` and carries fetch over an IPC bridge. This package never prints; the URL line belongs to the shell.

## Model Experience

None, as the package is the Node listener behind the web carrier; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No TLS, auth, or origin policy** — binding a non-loopback address exposes the server to that network; deployment hardening (or fronting it with a real reverse proxy) is deliberately out of scope for the dev-facing v1.
- **Socket options are fixed** — config selects the bind host and port, while backlog and other socket settings remain internal until a deployment needs them.

### Dev Note

Response compression lives here rather than in the carrier: gzip is a property of the socket transport, and a platform provider whose edge already compresses composes none of it. The same reasoning puts the `ws` handshake and the node:http↔Fetch bridge in this package.
