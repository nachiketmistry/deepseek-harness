# Agent Note: edge-verified principal and the browser session it arrives in

Status: implemented

English | [中文](2026-08-30-edge-verified-principal-and-the-browser-session.zh.md)

## Problem

[The principal seam](../../proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.md) says the Worker verifies a Better Auth JWT before it addresses a Durable Object, and names three things that land together: a Cloudflare provider for `ctx.principal`, verification in the `fetch` handler, and `HOST_NAME` becoming `hostObjectName(principal)`.

Shipping those three needed four decisions that note does not make, each of which is only visible once a browser is actually in front of the deployment.

A browser cannot put an `Authorization` header on a WebSocket upgrade, and `dsh-cf-web` streams every session over one. So "the request carries a token" has to mean something a browser sends on every request, including an upgrade and an asset.

The Host still authenticated for itself. `client-connection` mints a signed session cookie from a deployment-wide launch token, and that check runs inside the object. Leaving it there in front of an edge that has already refused everyone else does not add a check: it adds a second credential, one that admits whoever holds it, guarding an object that was reached under one caller's name.

The object boots before it has seen a request. `HostObject`'s tree is built in its constructor, and a socket message delivered after hibernation arrives with no request at all, so a provider that reads the principal out of the current request has nothing to read on either path.

The identity service was unreachable from a browser. Better Auth's `trustedOrigins` decides which origins may start a flow and emits no cross-origin headers, so a sign-in page served from the harness origin never saw a response from the service it signs in against.

## Decision

### The token arrives in a cookie the edge mints

The Worker owns two routes that exist to obtain and give up a principal, and therefore cannot require one. `POST /__dsh/session` takes a token the browser obtained from the identity service, verifies it, and returns it as `dsh-principal` — host-only, `HttpOnly`, `SameSite=Strict`, `Secure` over https, and expiring with the token rather than outliving it. `GET /__dsh/signout` clears that cookie and serves the page that ends the identity session behind it.

A cookie is what a browser sends on every request, which is what an upgrade and an asset need. It is still a bearer token, so `Authorization: Bearer` is accepted too and is what the tests and any non-browser caller use. What it costs is that a cookie is sent cross-site, so the request is CSRF-shaped; the answer is the `/api` Host and Origin fence, which `client-connection` still applies in every mode.

### The Host stops authenticating, explicitly

`client-connection` gains `browserAuth`, a validated choice between `launch-token` — the exchange and signed cookie it already had — and `edge`, which admits every request because the deployment's ingress already refused the rest. `BrowserAuthority` is the interface both answer; `EdgeVerifiedAuthority` is the second implementation, and its `authenticatedUrl` throws, because a URL that admits its holder is exactly what this deployment does not have.

The CF composition names `edge` and no longer names a launch token; a deployment that configures both fails at load rather than choosing one silently. This is a real deployment fact and not a preference: a Durable Object is reachable only through the Worker that holds its binding, and that Worker verifies first.

### The object reads its principal off its own name

`packages/cf/principal-jwt` holds both halves of the Cloudflare role. `PrincipalTokenVerifier` is the edge half: `jose` over a JWKS cached per isolate, with the refresh floor and cache lifetime as validated config, and `exp` required so no session can outlive every revocation the identity service can make. `CfPrincipalResolver` is the provider half, and it answers from `parseHostObjectName(ctx.id.name)` rather than from a request.

The object's name is the durable record of which principal it serves, and unlike a header it survives hibernation and is present in the constructor. It also cannot disagree with the edge: the Worker built that name from the principal it verified, so the object is either named for that principal or was never reached.

`parseHostObjectName` is new in `dsh-principal`, and its correctness rests on the subject union having one variant. A compile-time guard fails in that function when a second variant is added, at the point where the new variant's permanent name segment has to be chosen.

### The identity service answers cross-origin requests

`apps/cf-auth` answers preflights itself and echoes `Access-Control-Allow-Origin` for a caller on its trusted-origin list, with `Access-Control-Allow-Credentials` and `Vary: Origin`. The origin is echoed rather than wildcarded because a credentialed request refuses the wildcard. A preflight carries no credentials and reaches no route, so it is answered before the service is built and before Postgres is touched.

### The sign-in page is the refusal

An unauthenticated navigation is answered `401` with the sign-in page as the body, rather than a redirect to a page that answers `200`. The status stays the fact that the request was refused — which is what the acceptance run asserts — and a person still lands somewhere they can sign in. The page talks to the identity service directly, so this deployment never sees a password; it tries the token route first, so a browser that still holds an identity session is signed back in without being asked for one.

### A Node filesystem call in a core package

Creating a Session called `node:fs`'s `mkdir` directly, so the first chat on Cloudflare failed with `operation not permitted`: the Worker's `node:fs` is a stub, and the deployment's files are in a sandbox container it cannot touch. The seam already owns that operation, and `session-controller` now injects `fs` and calls `ensureDirectory`. The [filesystem-seam fix](../bug-fix/2026-08-30-session-project-directory-through-the-filesystem-seam.md) owns why that was a seam violation rather than a Cloudflare special case.

## What the acceptance runs prove, and what they stand in for

`tests/workerd/edge` runs the shipped edge module in workerd against a real Durable Object namespace, real `idFromName`, and real per-object SQLite, with a Host object that records what it was addressed as instead of booting the harness tree. The assembled Worker is 15 MiB of bundled plugin tree and the pool's runtime exits on loading it, so the object's body is the one substitution, and it is the half [slice three](../../proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.md) owns.

Its tokens come from one key set that publishes the identity service's own keys alongside the run's, so a token that service issued and a token no service would ever issue — expired, rewritten, unsigned — meet the same verifier for the same reasons.

`tests/browser` drives the real thing: `wrangler dev` over the built Worker, the identity service, and two isolated browser contexts. Both accounts write before either absence is asserted, so neither can pass on a sidebar that has not finished loading.

## Alternatives considered

**Keeping the launch token and layering the JWT in front of it.** Rejected: it leaves a deployment-wide credential in the composition whose only remaining purpose is to be handed back to the Host by the Worker that already verified the caller. The check it performs is no longer about who is asking, and a secret that authenticates nobody in particular is worse than no secret, because it still admits whoever finds it.

**Forwarding the verified principal to the object in a header.** Rejected: a hibernated object wakes on `webSocketMessage`, which carries no request, and the tree is built in the constructor, which happens before any request. A header would have to be cached into a mutable slot that the wake path then finds empty. The object's own name is already the record, is immutable, and cannot disagree with the edge.

**Verifying the token inside the Durable Object.** Rejected in the [seam note](../../proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.md) and unchanged here: the object must be addressed before it can run, so a check inside it happens after the tenant was chosen.

**Redirecting an unauthenticated navigation to a sign-in page.** Rejected: the redirect's own `200` is what a person and a test both see, so "reached no object" stops being observable at the status. Serving the page as the refusal's body keeps the status honest and costs nothing a browser notices.

**Storing the token in `localStorage` and sending it as a header.** Rejected: a WebSocket upgrade cannot carry the header, so the stream would need a second scheme, and a token readable by page script is a strictly weaker place to keep one than an `HttpOnly` cookie.

**A CORS proxy on the harness origin, or proxying sign-in through the Worker.** Rejected: proxying sign-in means this deployment handles plaintext passwords, which is the thing a separate identity service exists to avoid. The service answering for itself is the ordinary arrangement and keeps the credential path between the browser and the service that owns it.

**Making `browserAuth` implicit — inferring `edge` from the absence of a launch token.** Rejected: the inference makes a missing credential and a deliberate delegation the same configuration, so a deployment that meant to set a token and did not would silently admit everyone. It is a security choice, so it is stated.

## Consequences

A deployment now has two independently deployable Workers that must agree on one issuer. `apps/cf-web`'s `AUTH_ISSUER` and `AUTH_JWKS_URL` name the service, and `apps/cf-auth`'s `AUTH_TRUSTED_ORIGINS` names the GUI; a mismatch is a deployment that verifies nothing it is given. Neither Worker can detect it at load, because both values are only readable once a request is in flight.

The session cookie is `SameSite=Strict` and host-only, which is right for a deployment reached at one origin and wrong for one whose identity service is cross-site. Locally both run on `localhost`, which is same-site across ports; on `*.workers.dev` the two are cross-site, because `workers.dev` is on the Public Suffix List, and the sign-in page's credentialed fetch would need `SameSite=None` on the identity service's own cookie. Nothing here is deployed, and that is the first thing to check when it is.

An open WebSocket outlives the token that opened it. The edge verifies the upgrade and does not re-verify frames, so a session already streaming continues past `exp` until it reconnects. Shortening that window means re-verifying in the object, which is the arrangement this note rejects; the alternative is a bounded socket lifetime, and nothing needs one yet.

The sign-in page is English only. It is served by the Worker before any object is addressed, so it is outside the client's locale-owned copy and outside `verify-client-ui-i18n`, which scopes to `packages/client` and `apps/web`.

`client-connection` gained a mode, which is surface area on a core package, paid for by keeping the choice explicit and by `EdgeVerifiedAuthority` being nine lines with no configuration of its own.

## Testing

`packages/cf/principal-jwt` unit-tests the verifier against a local key set: a real signature, a rewritten claim, an altered signature, a foreign key, an expired token, an endless token, an unsigned token, another issuer, a mis-scoped audience, both malformed claims, and the refresh floor holding across an unknown `kid`.

`apps/cf-web` `test:workerd` runs the edge acceptance suite described above; `test:browser` runs the two-account browser suite. `pnpm run test:snapshot` covers the claim that no profile without an identity service changed: the shipped `headless` profile replays every recorded session through the real CLI.
