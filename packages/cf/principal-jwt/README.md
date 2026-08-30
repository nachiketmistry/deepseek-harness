---
description: "The Cloudflare principal provider for maintainers deploying the harness behind an identity service: edge token verification against a cached key set, and the object's own verified principal."
kind: "package-reference"
---

# @deepseek-ai/dsh-principal-jwt

English | [中文](README.zh.md)

## Summary

This package is the Cloudflare role of the [principal seam](../../identity/principal/README.md), and it is two halves of one arrangement. At the edge, `PrincipalTokenVerifier` checks the identity service's JWT against a key set cached for the isolate, before the Worker addresses anything. Inside the object, `CfPrincipalResolver` provides `ctx.principal` and answers with the principal that object's own name records. The two cannot disagree, because the Worker built the name from the principal it verified.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### At the edge

Build one verifier per isolate and address the object with the principal it returns:

```ts
import { PrincipalTokenVerifier, VerifierConfig } from '@deepseek-ai/dsh-principal-jwt'
import { hostObjectName } from '@deepseek-ai/dsh-principal'

const verifier = new PrincipalTokenVerifier(VerifierConfig({
  jwksUrl: env.AUTH_JWKS_URL,
  issuer: env.AUTH_ISSUER,
}))

const { principal } = await verifier.verify(token)
const object = env.HOST.get(env.HOST.idFromName(hostObjectName(principal)))
```

`jwksUrl` and `issuer` are required. A deployment that has not named the identity service it trusts fails rather than verifying against something it guessed. `refreshFloorSeconds`, `cacheMaxAgeSeconds`, and `clockToleranceSeconds` are defaulted; `audience` is omitted unless the deployment scopes its tokens.

One instance per isolate is the intended lifetime. The key-set cache and its refresh floor live inside the verifier, so one rebuilt per request refetches the identity service's key set every time and the floor protects nothing.

`verify` answers with the principal and the moment the token stops being accepted, which is what a session built on it may last. It throws `PrincipalTokenError` for a token that is malformed, unsigned, signed by a key the set does not hold, expired, endless, issued by another service, or missing either claim the object name is built from.

### Inside the object

Mount the provider with the object's own name:

```ts
await root.plugin(CfPrincipalResolver, { objectName: ctx.id.name })
```

`objectName` is required, and a name no principal addresses fails at boot. An object addressed by a generated id rather than by `hostObjectName` has no principal to serve and must not run.

<a id="understand-the-implementation"></a>
## Understand the implementation

Verification happens at the edge because an object must be addressed before it can run: a check inside it happens after the tenant was already chosen. Refusing before `idFromName` is what makes isolation structural rather than a matter of the check being correct.

`verify` requires `exp`. A token with no expiry would let a session outlive every revocation the identity service can make, because the edge asks that service nothing on the request path.

Both claims are re-checked after the signature verifies. A token is wire input, and `org` and `sub` become branded identifiers that reach a permanent Durable Object name, where a value holding `:` would make the name ambiguous.

The provider reads `parseHostObjectName(objectName)` rather than anything a request carries. The name is immutable, is present in the constructor before any request exists, and survives hibernation — a socket message delivered after a wake carries no request to read a principal from.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-principal`](../../identity/principal/README.md) — the Service Definition, the principal value, and the object name.
- [`dsh-principal-local`](../../identity/principal-local/README.md) — the provider for a deployment with no identity service.
- [The edge-verified principal Agent Note](../../../.agents/notes/implemented/architecture/2026-08-30-edge-verified-principal-and-the-browser-session.md) — why the token arrives in a cookie, why the Host stops authenticating, and what that costs.

<a id="model-experience"></a>
## Model Experience

None, as this package answers an identity question that request assembly never reads.

#### KV Cache effect

No direct effect; nothing here reaches a model request, so no cached prefix is extended or invalidated by this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **An open socket outlives its token** — the edge verifies an upgrade and does not re-verify frames, so a session already streaming continues past `exp` until it reconnects. Bounding that means either re-verifying inside the object, which the arrangement rejects, or a socket lifetime, which nothing needs yet.
- **No revocation before expiry** — the edge asks the identity service nothing per request, so a token stays good for its remaining lifetime after the session behind it ends. The token's own expiry is the whole bound.
- **One key set** — a deployment that must accept tokens from more than one identity service cannot express that here; the config names exactly one `jwksUrl` and one `issuer`.
- **The subject union has one variant** — the provider parses a name whose subject segment can only be a user id, and a second variant fails to compile in `parseHostObjectName` until its permanent name segment is chosen.

<a id="dev-note"></a>
### Dev Note

None.
