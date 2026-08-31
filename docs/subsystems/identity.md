# Identity

English | [中文](identity.zh.md)

Who a request acts as, and the object name derived from that answer. The [principal seam](../../packages/identity/principal) is a [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) split across roles: Service Definition ([dsh-principal](../../packages/identity/principal), `ctx.principal`) and Service Provider ([dsh-principal-local](../../packages/identity/principal-local), one configured principal for a deployment with no identity service). The seam answers the question and never asks it: a provider supplies a principal something upstream already verified, and no package here authenticates, parses a token, or reaches an identity service. The [principal seam Agent Note](../../.agents/notes/proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.md) owns why the identifiers are shaped this way.

The group's other package, [dsh-anonymous-user-id](../../packages/identity/anonymous-user-id), answers an unrelated question: it correlates records leaving one harness home without identifying anyone. It is not a principal and never reaches a storage key.

Sources: [`packages/identity/principal/src/types.ts`](../../packages/identity/principal/src/types.ts) and [`packages/identity/principal/src/host-object-name.ts`](../../packages/identity/principal/src/host-object-name.ts).

## The verified principal

`Principal` pairs the organization that owns the state with the subject acting inside it. Both identifiers are branded and opaque, issued by the identity service; neither is an email or any other value a person can change, because both reach permanent keys.

```ts type-equiv
/**
 * One verified caller: the organization that owns the state, and the subject
 * acting inside it. Both identifiers are opaque and issued by the identity
 * service; neither is an email or any other value a person can change, because
 * both reach {@link hostObjectName} and other permanent keys.
 */
interface Principal {
  /** The organization whose state this caller reaches. */
  readonly org: OrganizationId
  /** Who is acting inside that organization. */
  readonly subject: PrincipalSubject
}
```

`PrincipalSubject` is a union with one variant today. A client-credentials caller is a machine with no user id, so widening a bare user id later would break every consumer of the seam; the union costs a few lines now instead.

```ts type-equiv
/**
 * Who a verified request acts as, within its organization. A union rather than
 * a bare user id because a client-credentials caller is a machine with no user,
 * and widening the subject later would break every consumer of the seam.
 */
type PrincipalSubject =
  | { readonly kind: 'user'; readonly user: UserId }
```

## The object name a principal addresses

`hostObjectName(principal)` builds `dsh:1:<orgId>:<subjectId>` and is the only place that string is constructed, because every segment of it is permanent. A Durable Object cannot be renamed: `idFromName` maps a name to an object, and a different name is a different object holding none of the old one's state.

The `dsh:` prefix separates principal-addressed objects from any other name that might later share the class. The `1:` segment is the naming scheme's version, and the only escape hatch a name-addressed namespace has; a `dsh:2:` namespace still abandons every `dsh:1:` object, so it converts an accident into a deliberate migration rather than making the name reversible. The organization segment is present from the first commit: while a user belongs to exactly one personal organization it changes nothing observable, and adding it later re-keys every object at exactly the point the deployment finally holds state worth keeping.

Each subject variant contributes its segment through an exhaustive map rather than a switch, so a new variant fails to compile where its permanent key segment has to be chosen.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxprincipal--principalresolver-abstract-seam"></a>

### `ctx.principal` — `PrincipalResolver` (abstract seam)

Resolves the verified principal for the current request. Implementations locate an answer that something upstream already established; none of them owns the principal's lifetime, and none of them authenticates.

```ts cordis-catalog
/**
 * The principal this request acts as.
 * @returns the verified principal.
 */
abstract current(): Principal
```

Source: [`packages/identity/principal/src/index.ts`](../../packages/identity/principal/src/index.ts)
<!-- END GENERATED cordis-surface -->
