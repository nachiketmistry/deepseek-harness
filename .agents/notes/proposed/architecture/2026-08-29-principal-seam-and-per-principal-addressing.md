# Agent Note: principal seam and per-principal Durable Object addressing

Status: proposed

English | [中文](2026-08-29-principal-seam-and-per-principal-addressing.zh.md)

## Problem

[The multi-tenant harness note](2026-08-23-cloudflare-multi-tenant-harness.md) is the standing authority for tenancy on Cloudflare, and two of its premises no longer describe the tree.

Browser authentication landed the day after it was written: every Host RPC method, Remote call, and WebSocket stream on `dsh-cf-web` now requires a signed browser session, minted by exchanging a launch token at the index. That token is a single deployment-wide credential, so authentication answers "may this request in" and says nothing about who is asking. `privilegedHosts` is now a dead key: nothing in `packages/` reads it, and `apps/cf-web/scripts/compose.mjs` still passes the public host into it, which schemastery drops silently.

What remains true is the part that matters. `HOST_NAME` in `apps/cf-web/src/worker.ts` is the literal string `default`, so `env.HOST.idFromName(HOST_NAME)` hands every caller the same Durable Object, the same SQLite database, the same settings document, the same R2 attachment and spill prefixes, and the same Sandbox container. `SessionHeader` in `packages/core/session/src/types.ts` records `version`, `id`, `createdAt`, `cwd`, and lineage, and no owner. The only user id in the harness is `dsh-anonymous-user-id`, a telemetry UUID scoped to `$DSH_HOME` and deliberately derived from nothing identifying.

Isolation is therefore not weak, it is absent, and the cost of introducing it rises with every session the deployment stores. The identifiers a Durable Object is addressed by cannot be renamed: `idFromName` maps a name to an object, and a different name is a different object with none of the old one's state. `HostObject` holds nothing today that anyone wants back, which is the only reason these identifiers are still free to choose.

## Proposal

### What this note supersedes

The 2026-08-23 note keeps ownership of the tenancy hierarchy, the data-authority split between Postgres and the Durable Object, GitHub App credentials, metering, and AI Gateway. Four of its statements are replaced here:

- **Authentication is missing.** It is not. The browser session is real, and this note replaces the deployment-wide launch token rather than filling a vacuum.
- **The auth service runs in a Cloudflare Container.** It runs on a Worker. Nothing in the first cut needs a Node runtime; the SAML half of the SSO plugin, which was the reason for a container, is out of the first cut.
- **The plugin set is organization, teams, and SSO.** It is `organization` and `jwt`. `teams` is deferred and `sso` is deferred with it.
- **The privileged configuration plane is gated by principal and role.** Roles are out of the first cut. `privilegedHosts` is deleted rather than re-gated, because the key is already dead.

### The principal seam

Identity becomes a capability seam, complete in all three roles, and the harness never models tenancy itself.

`packages/identity/principal` owns the Service Definition: a Cordis service exposing the verified principal for the current request. `packages/identity/principal-local` is the Node Service Provider and answers with one fixed principal, so the CLI and headless profiles keep working with no network identity present at all; single-user stops being a separate code path and becomes a deployment with exactly one principal. `packages/cf/principal-jwt` is the Cloudflare Service Provider and answers with the principal the Worker verified for this request.

The principal is a pair of an organization and a subject, and the subject is a discriminated union from the first commit:

```ts
export interface Principal {
  readonly org: OrganizationId
  readonly subject: PrincipalSubject
}

export type PrincipalSubject =
  | { readonly kind: 'user'; readonly user: UserId }
```

Only the `user` variant exists now. Client-credentials callers are machines with no user id, and typing the subject as a union costs a few lines today against a breaking change to a core service later. `OrganizationId` and `UserId` are `Branded` opaque ids, never bare strings, because they cross the Worker-to-Durable-Object boundary and land in permanent keys.

### The object name

The Durable Object is addressed by

```
dsh:1:<orgId>:<userId>
```

built by a pure `hostObjectName(principal)` exported from the Service Definition package, so the Worker and every test compute the same string from one implementation.

Three decisions are frozen into that string, and each is chosen because it cannot be revisited. The `dsh:1:` prefix is a version segment: an object cannot be renamed, but a deliberate `dsh:2:` namespace is an escape hatch that a bare name does not have, and the prefix keeps principal-addressed objects distinguishable from any later object in the same class. The organization id is present from day one, because keying by user alone and adding organizations later re-keys every object; while every user has exactly one personal organization the segment costs nothing and buys the whole tenancy story. Both segments are Better Auth's opaque ids, never an email or any other value a person can change; Better Auth ids are `[A-Za-z0-9_-]`, so `:` cannot appear inside a segment and the name parses unambiguously.

### Verification at the edge

The Worker's `fetch` handler verifies a Better Auth JWT before any object is addressed, against a JWKS set fetched from the auth service and cached per isolate behind a refresh floor. A request that does not verify is refused there and reaches no harness surface. Only then is `idFromName` called, which is what makes isolation structural: the object cannot serve the wrong tenant because it was never addressed for them.

The refresh floor and the JWKS URL are validated `Config` fields on the CF provider, not constants, because they vary by deployment. The Durable Object never authenticates; it receives an already-verified principal. This also keeps the auth service off the request path, so a cold auth deploy costs a slow sign-in and never a slow session.

### The authentication service

`apps/cf-auth` is a new product assembly beside `apps/cf-web`, with its own `wrangler.jsonc`, its own deploy script, and a Hyperdrive binding to Neon Postgres over `node-postgres`. `pnpm-workspace.yaml` reserves `apps/*` for assemblies over the package tier, and an independently deployable Worker is one; a separate deploy is also what keeps an auth rollout and a harness rollout from being the same event.

Better Auth runs there with `organization` and `jwt` and nothing else. `organization` is present only because the object name needs a real organization id, and `jwt` because edge verification needs JWKS. Sign-in is Google for people and email plus password so tests can create accounts over the server API without a browser. Email verification is off and there is no password-reset flow, which is what keeps a mailer and its SPF, DKIM, and DMARC records out of the first cut. Account linking is on with Google trusted for verified emails, because a person who signs up by password and later presses Continue with Google would otherwise receive a second user id, a second personal organization, and a different Durable Object holding none of their sessions; merging afterwards is not a database update but a move of one object's contents into another. A personal organization is created at signup, so every user has an organization id from their first session.

Postgres holds the JWKS private keys, which is what makes the service's runtime host a movable decision: the Worker-to-Container move that SAML would require re-mints nothing and invalidates no live session.

### The session owner

`SessionHeader` gains a required `owner` carrying the principal, and `SESSION_FORMAT_VERSION` moves from `0` to `1`.

Required rather than optional, because an optional owner makes "a session with no owner" a permanent valid state that every consumer must then interpret. The bump is what makes an existing ownerless log fail at load instead of loading as unowned, which is the same fail-closed choice the [session event vocabulary](../../implemented/simplification/2026-08-25-fail-closed-session-event-vocabulary.md) makes for event types. The repository's pre-release stance permits it, and it stops being permitted the moment a deployment holds sessions someone wants to open again.

### Rollout

The work lands in three slices, so the deployment is never half-keyed and no slice carries a value the next one deletes.

The first slice adds `packages/identity/principal` and `packages/identity/principal-local`, and deletes `privilegedHosts` from `apps/cf-web/scripts/compose.mjs`. It has shipped.

The second slice adds `packages/cf/principal-jwt`, moves verification into the Worker's `fetch` handler, and moves `apps/cf-web/src/worker.ts` from `HOST_NAME` to `hostObjectName(principal)`. Those three are one change rather than three: until a provider verifies a token, the Worker has nowhere honest to obtain a principal, and splitting them would introduce a deployment-configured principal that the next commit deletes. It has shipped, and it carried four things this note does not name, because none of them is visible until a browser is in front of the deployment: the browser sign-in path and the cookie the verified token arrives in, an explicit `browserAuth` choice on `client-connection` that replaces the launch token rather than layering on it, cross-origin headers on the identity service, and a Cloudflare provider that reads its principal off its object's own name rather than off a request. [The edge-verified principal note](../../implemented/architecture/2026-08-30-edge-verified-principal-and-the-browser-session.md) owns those decisions and what they cost.

The third slice keys storage, settings, attachments, and spill by the same principal, adds the `SessionHeader` owner with its version bump, and moves `cf-sandbox` to per-session identifiers.

## Alternatives considered

**A bare `org:user` object name.** Rejected: it is the shortest correct string and it is also the one with no escape hatch. A name-addressed namespace cannot be renamed, so the only recovery from a naming mistake is a second namespace, and a version segment is what makes that a decision rather than a collision. The prefix costs six characters once.

**Keying the object by user alone, adding organizations later.** Rejected: it re-keys every object at the moment the product acquires its first real tenant, which is the moment there is finally state worth keeping. While every user has one personal organization the two schemes are behaviorally identical, so the org segment is free exactly until it is not.

**An email or another human-readable id in the object name.** Rejected: everything in the name is permanent, and an email is a value a person changes. Opaque ids are the only kind that can be in a key that cannot be rewritten.

**An optional `owner`, with `SESSION_FORMAT_VERSION` left at `0`.** Rejected: it is additive and non-breaking, and it buys that by making an unowned session legal forever. Every reader would then need a rule for an absent owner, and the safe rule for a tenancy field is to refuse the log, which is what the bump does directly.

**Deferring the `owner` to a later change entirely.** Rejected as a false saving: the header is durable, so the door closes on the first stored session, and the second slice is where the owner has to exist anyway for storage keys to mean anything.

**Verifying the token inside the Durable Object.** Rejected: the object must be addressed before it can run, so a check inside it happens after the tenant was already chosen. Isolation would then rest on the check being correct rather than on the wrong object never being reached.

**Forwarding the browser session cookie to the object instead of a JWT.** Rejected: the cookie is opaque to the edge, so verifying it means a call to the auth service on every request, which puts a sleeping auth deployment on the product's request path. A JWT verified against cached JWKS costs no network round trip.

**Better Auth in a Cloudflare Container, as the 2026-08-23 note proposed.** Rejected for the first cut: the container was required by the SSO plugin's SAML half, which depends on samlify and is unlikely to run on workerd. Nothing in `organization` plus `jwt` needs a Node runtime, and because the JWKS private keys live in Postgres the move to a container later re-mints nothing.

**Managed Better Auth on Neon.** Rejected, as in the 2026-08-23 note: the managed plugin subset excludes what the product eventually needs, and migrating off it later re-mints JWKS keys and invalidates every live session.

**`packages/cf/auth-worker` instead of `apps/cf-auth`.** Rejected: it would be the only entry under `packages/` with its own wrangler deploy. The tier boundary is that `packages/*/*` are plugins and libraries and `apps/*` are deployables, and the auth service is a deployable.

**A separate repository for the auth service.** Rejected: the JWT contract is shared between the two Workers, and a split repository makes one contract change two pull requests with no gate holding them together.

**Modelling organizations, users, and roles inside `packages/`.** Rejected, as in the 2026-08-23 note: it duplicates what the auth layer owns and guarantees divergence. The harness consumes a verified principal and stores opaque identifiers.

## Acceptance criteria

The CLI and headless profiles run unchanged with no authentication service present, answering from the Node provider's fixed local principal. Two distinct principals resolve to two different Durable Objects, and the same principal resolves to the same one across requests. A request carrying no valid token reaches no harness surface, and is refused in the Worker before any object is addressed. `hostObjectName` produces `dsh:1:<orgId>:<userId>` and is the only place that string is built. `privilegedHosts` appears nowhere in the repository. Once the second slice lands, a session log written by one principal is unreadable by another, and a stored log without an owner is refused at load rather than loaded as unowned. `pnpm --filter @deepseek-ai/dsh-cf-web run parity:check` passes with every seam that changed hands carrying a disposition.

## Risks

Booting the harness plugin tree happens on every Durable Object wake, and that cost is measured only for one object. With one object per active principal it is untested, and it is the first thing to profile once addressing changes.

Account linking is a configuration setting on a service this repository does not yet deploy, so nothing in the tree enforces it. Until the auth service exists, the guarantee that one human is one user id rests on the deployment being configured correctly rather than on a gate, and a single real signup made before it is switched on is not recoverable by a database update.

The version segment in the object name buys an escape hatch and does not remove the underlying constraint: a `dsh:2:` namespace still abandons every `dsh:1:` object. It converts an accident into a deliberate migration, which is worth the six characters and is not the same as reversibility.

The `SESSION_FORMAT_VERSION` bump refuses every session log written before it, including those on developer machines. That is what the pre-release stance permits, and it is a real cost paid by anyone mid-task when the change lands.
