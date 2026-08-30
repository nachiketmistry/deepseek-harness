---
description: "Browser-host wire layer for the web GUI: Remote RPC, event-stream delivery with reconnect, exact Fetch routes, the /api HTTP bridge, and the browser-trust fence."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

## Summary

The package carries browser-to-Host Remote calls, exact Fetch responses, and connection generations. The Client plugin mounts `ctx.connection` with current-page loopback state, a generic RPC carrier, the active generation and its Host facts, and the registration point for one generation source. A generation becomes visible when its source reports ready; source completion, failure, withdrawal, or an explicit stop clears it before `ConnectionController` reconnects with backoff.

## Table of Contents

- [Use this package](#use-this-package)
- [Browser authentication and request trust](#browser-authentication-and-request-trust)
- [Connection generation](#connection-generation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The browser uses HTTP POST for Remote unary calls. API Gateway owns the `/api/remote.mux` WebSocket and its logical streams; in-process compositions provide equivalent Remote streams through `connection.rpc.open` without opening a WebSocket. The Host half owns the sole `/api` route, Fetch bridge, browser authentication, Host/Origin checks, and exact `GET`/`HEAD` route registry. Typert Gateway claims generated Remote endpoints, feature packages register non-JSON responses such as Session-log downloads, and unclaimed requests return 404. Loopback hostname classification remains package-internal to the browser-facing Client state.

-----

<a id="browser-authentication-and-request-trust"></a>
## Browser authentication and request trust

Who authenticates a browser request is a `browserAuth` choice, and it is a deployment fact rather than a preference. `launch-token`, the default, means this Host does it, through everything described below. `edge` means the deployment's ingress already did and this Host is reachable by no other path: a Durable Object behind a Worker that verifies an identity service's token before it addresses anything is the case it exists for. Under `edge` every request is admitted, `authenticatedUrl` throws because no URL admits its holder, and naming a `launchTokenRef` as well fails plugin load rather than silently choosing one. The `/api` Host and Origin fence below applies in both modes, and is what answers CSRF for a credential a browser sends on every request.

The rest of this section describes `launch-token`. Every Host RPC method and WebSocket stream requires one browser session; there is no method-specific loopback tier. Each process mints a random launch token, unless `launchTokenRef` names a credential reference holding the deployment's own token, which a surface with no terminal to print a generated one to sets instead; a named reference that resolves to nothing fails plugin load, and a token under 32 characters is refused. `dsh-web-app` prints and opens the ordinary root URL with `?token=...`; `frontend-static` delegates root and index requests to `ctx.connection.authorizeIndex`, which accepts that token only on `GET /`, writes an authority-bound signed cookie, and redirects to clean `/`. The cookie carries `Secure` when the index request arrived over HTTPS. A missing, expired, malformed, or wrong-authority cookie returns 401 before RPC dispatch. Static assets remain public. The HTTP carrier accepts no query token outside the root exchange and no Authorization-header token.

The cookie signing secret is the owner-scoped `client-connection/browser-session` grant record in `ctx.credentials`. The local provider persists it in `$DSH_HOME/.credentials.yaml`; `BrowserAuth` loads or creates the record during Connection activation and retains the secret in memory, so request authentication is synchronous. Deleting or replacing the record takes effect on the next Connection activation. Cookies carry an absolute issue/expiry interval, defaulting to 30 days through `cookieMaxAgeDays`, and bind the normalized hostname plus port in both their deterministic name and signed payload. They are host-only, `Path=/`, `HttpOnly`, and `SameSite=Strict`; they omit `Secure` when the index request arrived over plain HTTP, which is what the shipped loopback server serves.

Before authentication, every request still passes `src/api-request-trust.ts`. Its `Host` must be loopback or match a `trustedHosts` entry: exact on `host:port`, any port on port-less entries, both sides WHATWG-normalized. An attached `Origin` must equal that Host and `sec-fetch-site: cross-site` is refused. Malformed configured authorities fail plugin load. These checks defend DNS rebinding and cross-site browser requests; they never establish identity. A failed Host/Origin check returns 403, while a trusted but unauthenticated request returns 401. `dsh web --host 0.0.0.0` remains unsupported. Decision records: [browser request trust](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md) and [browser token authentication](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md).

<a id="connection-generation"></a>
## Connection generation

API Gateway Client registers the internal `$events` logical stream as the sole generation source, independently of whether any `$on` listener exists. The Host attaches all incremental listeners in the API Remotes source factory, then sends one `{ type: 'ready', clientId, host: { home } }` item before events. `ConnectionController` publishes that generation and calls `onConnected` only after the ready item arrives, so baseline acquisition cannot race ahead of incremental observation.

An ended `$events` stream, a Remote stream error, a non-ready opening item, or a malformed event item invalidates the current generation. The controller immediately withdraws the generation, publishes `reconnecting`, and reopens `$events` after backoff. Gateway mux reconnects the physical WebSocket; Connection generation reopens the logical stream and establishes the next baseline starting point.

<a id="model-experience"></a>
## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The `/api` bridge buffers each request body in memory** — `maxRequestBodyBytes` (default 300 MiB, sized for the default 200 MiB aggregate image limit after base64 expansion plus envelope headroom) is therefore also the per-request resident bound; a streaming body path would be needed to lower it without shrinking the image limits.
- **The browser cookie is marked `Secure` only per exchange** — the attribute follows the scheme of the index request that minted the cookie, so an authority reached over both HTTP and HTTPS can hold a cookie that a later plaintext request carries in the clear.
- **There is no logout operation** — clearing the browser cookie ends one browser session; deleting the owner credential record and restarting `dsh` revokes every session.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
