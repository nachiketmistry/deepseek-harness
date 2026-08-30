---
description: "The verified-principal seam for maintainers wiring identity into the harness: the principal value, the Cordis service that answers with it, and the Durable Object name derived from it."
kind: "package-reference"
---

# @deepseek-ai/dsh-principal

English | [中文](README.zh.md)

## Summary

This package says who a request acts as. A principal is an organization plus a subject inside it, and it is the value every deployment-specific storage key is derived from. The package answers the question and never asks it: a Service Provider supplies a principal that something upstream already verified, and nothing here authenticates, parses a token, or talks to an identity service. It also owns `hostObjectName`, the single place the Durable Object name a principal addresses is built, because every segment of that name is permanent.

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

Compose a Service Provider for `ctx.principal`, then read `ctx.principal.current()` wherever the caller's identity decides what data is reached. [`dsh-principal-local`](../principal-local/README.md) is the provider for a deployment with no identity service; it answers with one configured principal, which is what makes the CLI and headless profiles ordinary deployments rather than a separate single-user code path.

### The principal

```ts
interface Principal {
  readonly org: OrganizationId
  readonly subject: PrincipalSubject
}

type PrincipalSubject =
  | { readonly kind: 'user'; readonly user: UserId }
```

`OrganizationId` and `UserId` are branded opaque identifiers issued by the identity service. They are never an email, a display name, or anything else a person can change, because both reach permanent keys that cannot be rewritten. The subject is a union with one variant today: a client-credentials caller is a machine with no user id, and widening a bare user id later would break every consumer.

### The object name

```ts
hostObjectName({ org: OrganizationId('org_a'), subject: { kind: 'user', user: UserId('usr_1') } })
// => 'dsh:1:org_a:usr_1'
```

Call this rather than assembling the string; it is the only place the name is built. Identity-service identifiers cannot contain `:`, so the segments parse unambiguously.

`parseHostObjectName` reads one back. A Durable Object addressed by `hostObjectName` recovers its own principal from its own identity rather than from anything a request claims, which is what the Cloudflare provider does; a name from another namespace throws rather than resolving to a principal this build can serve.

<a id="understand-the-implementation"></a>
## Understand the implementation

`PrincipalResolver` is an abstract Cordis `Service` on the singular key `principal`, with one method, `current()`. It is a resolver rather than a store because it locates an answer established upstream and owns no lifetime of its own.

Three decisions are frozen into `hostObjectName`, and each is there because a Durable Object cannot be renamed: `idFromName` maps a name to an object, and a different name is a different object holding none of the old one's state.

- **`dsh:` prefix** — separates principal-addressed objects from any other name that might later share the class.
- **`1:` version** — the only escape hatch a name-addressed namespace has. A `dsh:2:` namespace still abandons every `dsh:1:` object, so this converts an accident into a deliberate migration rather than making the name reversible.
- **The organization segment** — present from the first commit. While a user belongs to exactly one personal organization the segment changes nothing observable; adding it later re-keys every object, at exactly the point the deployment finally holds state worth keeping.

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-principal-local`](../principal-local/README.md) — the Service Provider for deployments with no identity service.
- [Capability seams](../../../docs/capability-seams.md) — where this seam sits among the harness's other swappable capabilities.
- [The principal seam Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.md) — why the identifiers are shaped this way and what each alternative cost.

<a id="model-experience"></a>
## Model Experience

None, as this seam owns identity value types and one pure name function; request assembly never reads either.

#### KV Cache effect

No direct effect; nothing here reaches a model request, so no cached prefix is extended or invalidated by this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No provider selection or precedence** — the seam holds exactly one `ctx.principal` provider per tree. A deployment that must accept several token kinds resolves that inside its provider, not by composing two.
- **The name scheme is not migratable** — `hostObjectName` can be versioned but not re-pointed. Changing `HOST_OBJECT_NAME_VERSION` orphans every object addressed under the previous value, and this package supplies no path to move their contents.
- **The subject union has one variant** — a client-credentials subject with no user id is typed for but not implemented, so `hostObjectName` has no segment shape for it yet.

<a id="dev-note"></a>
### Dev Note

None.
