# Identity

[English](identity.md) | 中文

一个请求以谁的身份行事，以及由该答案派生出的对象名字。[principal seam](../../packages/identity/principal) 是一条按角色拆分的[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)：Service Definition（[dsh-principal](../../packages/identity/principal)，`ctx.principal`）与 Service Provider（[dsh-principal-local](../../packages/identity/principal-local)，为没有身份服务的部署提供一个配置好的 principal）。该 seam 只回答这个问题，从不提出它：provider 提供的是上游已经验证过的 principal，这里没有任何包做认证、解析令牌或触达身份服务。[principal seam Agent Note](../../.agents/notes/proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.zh.md) 说明这些标识符为何是这个形状。

本组的另一个包 [dsh-anonymous-user-id](../../packages/identity/anonymous-user-id) 回答的是一个不相干的问题：它让离开同一个 harness home 的记录彼此关联，而不识别任何人。它不是 principal，也从不进入任何存储键。

Sources: [`packages/identity/principal/src/types.ts`](../../packages/identity/principal/src/types.ts) and [`packages/identity/principal/src/host-object-name.ts`](../../packages/identity/principal/src/host-object-name.ts).

## The verified principal

`Principal` 把拥有状态的组织与其中行事的 subject 配成一对。两个标识符都带 brand 且不透明，由身份服务签发；它们都不是邮箱或任何人可以更改的值，因为两者都会进入永久键。

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

`PrincipalSubject` 是一个联合，今天只有一个变体。客户端凭据的调用者是没有用户 id 的机器，因此日后从裸用户 id 拓宽会破坏该 seam 的每一个消费方；写成联合现在只花几行。

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

`hostObjectName(principal)` 构造 `dsh:1:<orgId>:<subjectId>`，并且是构造该字符串的唯一位置，因为它的每一段都是永久的。Durable Object 无法改名：`idFromName` 把一个名字映射到一个对象，换一个名字就是另一个对象，且不持有旧对象的任何状态。

`dsh:` 前缀把 principal 寻址的对象与日后可能共用该 class 的任何其他名字区分开。`1:` 段是命名方案的版本，也是按名字寻址的命名空间所拥有的唯一逃生口；`dsh:2:` 命名空间依然会抛弃每一个 `dsh:1:` 对象，因此它把一次事故变成一次刻意的迁移，而不是让名字变得可逆。组织段从第一次提交起就在场：在用户只属于一个个人组织期间它不改变任何可观察行为，而日后再加则要在部署终于持有值得保留的状态的那一刻，把每个对象重新建键。

每个 subject 变体通过一张穷尽映射表而非 switch 贡献自己的段，因此新变体会在必须选定其永久键段的地方编译失败。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
