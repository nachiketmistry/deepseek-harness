# Agent Note: web host transport seams (carrier, bundle source, file-free composition, preset source)

Status: implemented

English | [中文](2026-08-21-web-host-transport-seams.zh.md)

## Problem

The web GUI host tree was bound to Node at four points that had nothing to do with what the tree does: `dsh-host-webserver` was itself a `node:http` listener whose route handlers took `IncomingMessage`/`ServerResponse`, so every route owner (connection, modules, hmr, frontend-static) was Node-shaped and the downlink WebSockets rode `ws` inside the connection plugin; `dsh-client-modules` resolved client bundles by walking `node_modules` with `createRequire`; the only boot path composed a tree from a disk profile through `Include` over a `cordis.yml`; and `dsh-agent-presets` discovered presets as directories and mounted one by plugging an `Include` over its composition file, keying standing generations on the file's stat. Two module-load facts compounded this on a platform host: `dsh-llm` read its version through `createRequire(import.meta.url)`, which has no file URL on workerd, and the vendored Loader compiled its `!!js` evaluator with `new Function` at import, which production workerd refuses. Gate 0 of the [Cloudflare web host series](../../proposed/architecture/2026-08-21-cloudflare-web-host.md) showed these were the only structural couplings.

## Decision

**The web carrier is a Service Definition dispatched over the Fetch standard.** `dsh-host-webserver` keeps `ctx.webServer` and the registries, but `WebServer` is abstract: `register(route)` takes `(request: Request) => Response | Promise<Response>` handlers, `fetch(request)` dispatches exact → longest prefix → fallback → 404, `registerUpgrade(route)` takes `{ path, authorize?(request), open(request, socket) }` over `WebServerSocket` (the WHATWG subset `readyState`/`send`/`close`/`addEventListener`), and `address` reports the bound `{host, port}` or `undefined` for a platform-driven provider. `dsh-host-webserver-node` is the Node Service Provider: it listens, builds the `Request` from `node:http` (the URL authority is the `Host` header, the body streams, the signal aborts on client departure), streams the `Response` back with backpressure, answers per-request failures with 400, and owns the `ws` handshake. The connection plugin's downlink pump therefore drives `WebServerSocket` and its body cap is a Fetch-level `withBodyLimit` wrapper; `frontend-static`, `modules`, and `hmr` return `Response`s (the HMR event stream is a `ReadableStream` SSE body ended by `request.signal`).

**Client bundles come from a Service Definition.** `dsh-client-modules` defines `ClientBundleSource` (`ctx.clientBundleSource`: `describe`, `read`, `readSourceMap`, `locate`) and the registry reads declarations and bytes only through it; the bundle rev is an FNV-1a hash of the bytes. `dsh-client-bundle-source-node` is the Node provider that resolves `package.json` through `node_modules` from `ctx.baseUrl`; a platform provider answers from a build-time manifest.

**A tree can be composed without a disk profile.** `dsh-app-boot` exports `bootEntries(binName, rows, { modules, prepare, baseUrl })`: it mounts the vendored Loader, installs a table-backed `internal` module loader (`tableModuleLoader`, the same `internal.import` contract the browser shell already supplies), registers the `cordis:group` builtin, and mounts literal `EntryOptions` rows on the Loader's in-memory root. Rows carry no `!!js`; a table miss or a row failure rejects with the same labelled diagnostics as `boot()`.

**Presets come from a Service Definition and mount as rows.** `dsh-agent-presets` defines `AgentPresetSource` (`ctx.agentPresetSource`: `list`, `stamp`, `composition`, `read`, `authorable`, `copy`, `remove`); the registry keys standing generations on the source's opaque stamp and mounts a preset by plugging an in-memory `EntryTree` over the rows the source returned, resolving bare specifiers from the harness base and relative ones from the composition's `baseUrl`. `dsh-agent-presets-filesystem` is the provider holding directory discovery, metadata, authoring, and the stat stamp; the shipped Web composition mounts it as the `agent-preset-source` row and `apps/cli` patches the shipped root onto that row.

**Module-load portability.** `dsh-llm` and `dsh-session-telemetry-otel` read their version through a JSON import of their own `./package.json` export, which the bundle inlines; the vendored Loader compiles its expression evaluator on first use (vendor modification 19), so a host that forbids code generation from strings can import the Loader and mount literal rows.

## Alternatives considered

- **Keep Node-shaped route handlers and add a CF adapter that fakes `IncomingMessage`/`ServerResponse`** — rejected: the Node streams API is the coupling; every other route owner would keep writing to it, and the fake would have to reproduce backpressure and close semantics that the Fetch types already standardize.
- **A separate WebSocket downlink Service Definition** — rejected: the downlink's only transport need is an accepted socket to pump frames into, which the carrier's `WebSocketRoute.open` already hands over; a service with one internal caller is the smell `packages/AGENTS.md` names. A provider that recovers hibernated sockets re-invokes `open`.
- **A build-time manifest for Node too** — rejected for this change: the Node provider keeps today's resolution so nothing changes for Node users; the Service Definition is what lets the platform host bring its manifest.
- **Evaluate `!!js` rows on the platform host** — impossible: production workerd refuses code generation from strings. Literal rows are the only composition a platform host can mount, which is why `bootEntries` takes rows, not a file.

## Consequences

- `dsh-host-webserver` no longer depends on `node:http` or schemastery; `ws` moves to the Node provider. A composition that mounted `@deepseek-ai/dsh-host-webserver` mounts `@deepseek-ai/dsh-host-webserver-node`, and a consumer that read `webServer.host`/`port` reads `webServer.address` and fails loud when it is undefined.
- The `/api` request body is still buffered up to `maxRequestBodyBytes`, now by `withBodyLimit` in the connection plugin rather than by the carrier.
- `dsh-client-modules` injects `clientBundleSource`; the Web composition mounts the Node provider row ahead of `modules`.
- `dsh-agent-presets` injects `agentPresetSource` and its config is `{ default }`; roots and the user root are the filesystem provider's config.
- The Cloudflare host composes literal rows for the CF target composition in `apps/cf-web`; bundle and preset rows there are a second source beside the YAML layers and must stay consistent by review.
