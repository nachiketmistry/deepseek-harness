# Agent Note: principal seam and per-principal Durable Object addressing

Status: proposed

[English](2026-08-29-principal-seam-and-per-principal-addressing.md) | 中文

## Problem

[多租户 harness 笔记](2026-08-23-cloudflare-multi-tenant-harness.zh.md)是 Cloudflare 上租户模型的现行权威，而其中两条前提已不再描述当前代码树。

浏览器认证在该笔记写下的第二天落地：`dsh-cf-web` 上每一个 Host RPC 方法、Remote 调用和 WebSocket 流，现在都要求一个已签名的浏览器会话，由在首页用启动令牌兑换而来。该令牌是整个部署共用的单一凭据，因此认证回答的是"这个请求能否进入"，而对"谁在发问"只字未提。`privilegedHosts` 现在是一个死键：`packages/` 中已无任何代码读它，而 `apps/cf-web/scripts/compose.mjs` 仍把公开主机传进去，被 schemastery 静默丢弃。

仍然成立的正是要紧的那部分。`apps/cf-web/src/worker.ts` 中的 `HOST_NAME` 是字面量字符串 `default`，于是 `env.HOST.idFromName(HOST_NAME)` 把同一个 Durable Object、同一个 SQLite 数据库、同一份设置文档、同一批 R2 附件与溢出前缀、以及同一个 Sandbox 容器交给每一位调用者。`packages/core/session/src/types.ts` 中的 `SessionHeader` 记录 `version`、`id`、`createdAt`、`cwd` 与血缘，唯独没有归属者。harness 中唯一的用户 id 是 `dsh-anonymous-user-id`，一个作用域限于 `$DSH_HOME`、且刻意不由任何可识别来源派生的遥测 UUID。

因此隔离不是薄弱，而是不存在，而引入隔离的代价随部署存下的每一个会话上升。Durable Object 被寻址所用的标识符无法改名：`idFromName` 把一个名字映射到一个对象，换一个名字就是另一个对象，且不带旧对象的任何状态。`HostObject` 今天并不持有任何人想要回来的东西，这是这些标识符仍可自由选定的唯一原因。

## Proposal

### What this note supersedes

2026-08-23 笔记仍然拥有租户层级、Postgres 与 Durable Object 之间的数据权威划分、GitHub App 凭据、计量与 AI Gateway。其中四条陈述在此被替换：

- **认证缺失。** 并非如此。浏览器会话是真实存在的，本笔记替换的是整部署共用的启动令牌，而不是填补一处空白。
- **认证服务运行在 Cloudflare Container 中。** 它运行在 Worker 上。第一版中没有任何部分需要 Node 运行时；当初要求容器的理由是 SSO 插件的 SAML 那一半，而它不在第一版之内。
- **插件集是 organization、teams 与 SSO。** 实际是 `organization` 与 `jwt`。`teams` 推迟，`sso` 随之推迟。
- **特权配置平面按 principal 与角色把守。** 角色不在第一版之内。`privilegedHosts` 是被删除而非改为按新维度把守，因为该键本就已经死了。

### The principal seam

身份成为一条能力 seam，三种角色齐备，而 harness 自身从不建模租户。

`packages/identity/principal` 拥有 Service Definition：一个 Cordis 服务，暴露当前请求的已验证 principal。`packages/identity/principal-local` 是 Node Service Provider，回答一个固定的 principal，因此 CLI 与 headless 配置在完全没有网络身份的情况下照常工作；单用户不再是一条独立代码路径，而是恰好只有一个 principal 的部署。`packages/cf/principal-jwt` 是 Cloudflare Service Provider，回答 Worker 为本次请求验证出的 principal。

principal 是一个组织与一个 subject 的组合，而 subject 从第一次提交起就是可辨别联合：

```ts
export interface Principal {
  readonly org: OrganizationId
  readonly subject: PrincipalSubject
}

export type PrincipalSubject =
  | { readonly kind: 'user'; readonly user: UserId }
```

目前只有 `user` 这一变体。客户端凭据的调用者是没有用户 id 的机器，而把 subject 写成联合，今天只花几行，换掉的是日后对一个核心服务的破坏性变更。`OrganizationId` 与 `UserId` 是 `Branded` 的不透明 id，绝不是裸 `string`，因为它们跨越 Worker 到 Durable Object 的边界，并落进永久性的键里。

### The object name

Durable Object 由下述名字寻址

```
dsh:1:<orgId>:<userId>
```

由 Service Definition 包导出的纯函数 `hostObjectName(principal)` 构造，因此 Worker 与每一个测试都从同一份实现算出同一个字符串。

有三项决定被冻结进这个字符串，且每一项之所以这样选，都是因为它无法重来。`dsh:1:` 前缀是一个版本段：对象无法改名，但一个刻意启用的 `dsh:2:` 命名空间是裸名字所没有的逃生口，而该前缀也让 principal 寻址的对象与同一 class 下日后任何对象保持可区分。组织 id 从第一天起就在场，因为只按用户建键、日后再加组织，会把每一个对象重新建键；在每位用户恰好只有一个个人组织期间，这一段不花任何代价，却买下整个租户故事。两段都是 Better Auth 的不透明 id，绝不是邮箱或任何人可以更改的值；Better Auth 的 id 取值为 `[A-Za-z0-9_-]`，因此 `:` 不可能出现在段内，名字的解析无歧义。

### Verification at the edge

Worker 的 `fetch` 处理器在寻址任何对象之前验证 Better Auth JWT，验证依据是从认证服务取得、按 isolate 缓存并受刷新下限约束的 JWKS 集合。验证不通过的请求就在那里被拒，触达不到任何 harness 表面。只有到那时才调用 `idFromName`，这正是隔离之所以是结构性的：对象不可能服务错误的租户，因为它压根没有为对方被寻址过。

刷新下限与 JWKS URL 是 CF provider 上经校验的 `Config` 字段，而非常量，因为它们随部署而异。Durable Object 从不认证；它接收的是一个已经验证过的 principal。这也让认证服务留在请求路径之外，于是一次冷启动的认证部署代价是一次缓慢的登录，而绝不是一次缓慢的会话。

### The authentication service

`apps/cf-auth` 是 `apps/cf-web` 旁边一个新的产品装配体，拥有自己的 `wrangler.jsonc`、自己的部署脚本，以及一条经 `node-postgres` 连到 Neon Postgres 的 Hyperdrive 绑定。`pnpm-workspace.yaml` 把 `apps/*` 保留给包层之上的装配体，而一个可独立部署的 Worker 正是其一；独立部署也正是让认证发布与 harness 发布不成为同一件事的原因。

Better Auth 在那里带着 `organization` 与 `jwt` 运行，别无其他。`organization` 之所以在场，只因为对象名字需要一个真实的组织 id；`jwt` 之所以在场，是因为边缘验证需要 JWKS。登录方式是给人用的 Google，以及邮箱加密码，好让测试无需浏览器即可经服务端 API 创建账号。邮箱验证关闭，也没有密码重置流程，这正是把邮件发送方及其 SPF、DKIM、DMARC 记录挡在第一版之外的原因。账号关联开启，并把 Google 视为已验证邮箱的可信来源，因为一个先用密码注册、随后按下 Continue with Google 的人，否则会拿到第二个用户 id、第二个个人组织，以及一个不含其任何会话的另一个 Durable Object；事后合并不是一次数据库更新，而是把一个对象的内容搬进另一个对象。注册时创建个人组织，于是每位用户从第一个会话起就拥有组织 id。

Postgres 持有 JWKS 私钥，这正是该服务的运行时宿主成为可移动决定的原因：SAML 日后要求的 Worker 到 Container 迁移不会重新铸造任何密钥，也不会作废任何在用会话。

### The session owner

`SessionHeader` 增加一个必填的 `owner` 承载 principal，`SESSION_FORMAT_VERSION` 由 `0` 变为 `1`。

选必填而非可选，是因为可选的归属者会让"没有归属者的会话"成为一种永久合法状态，而后每一个消费方都必须去解释它。版本递增正是让既有的无归属者日志在加载时失败、而不是被当作无归属者加载，这与[会话事件词汇表](../../implemented/simplification/2026-08-25-fail-closed-session-event-vocabulary.zh.md)对事件类型所作的失败即关闭选择相同。仓库的预发布立场允许这样做，而一旦某个部署持有别人还想再打开的会话，这种做法就不再被允许。

### Rollout

工作分三片落地，让部署不会处在建了一半键的状态，也让任何一片都不承载下一片会删掉的值。

第一片加入 `packages/identity/principal` 与 `packages/identity/principal-local`，并从 `apps/cf-web/scripts/compose.mjs` 删除 `privilegedHosts`。

第二片加入 `packages/cf/principal-jwt`，把验证移进 Worker 的 `fetch` 处理器，并把 `apps/cf-web/src/worker.ts` 由 `HOST_NAME` 改为 `hostObjectName(principal)`。这三件事是一次变更而不是三次：在 provider 验证出令牌之前，Worker 无处诚实地取得 principal，而拆开它们会引入一个下一次提交就要删除的、由部署配置的 principal。

第三片把存储、设置、附件与溢出按同一个 principal 建键，加入带版本递增的 `SessionHeader` 归属者，并把 `cf-sandbox` 改为按会话的标识符。

## Alternatives considered

**裸 `org:user` 对象名。** 否决：它是最短的正确字符串，同时也是没有逃生口的那个。按名字寻址的命名空间无法改名，因此命名失误的唯一补救就是第二个命名空间，而版本段正是让那件事成为一个决定而不是一次碰撞的东西。前缀只需一次性付出六个字符。

**只按用户为对象建键，日后再加组织。** 否决：它会在产品拿到第一个真实租户的那一刻把每个对象重新建键，而那一刻恰恰是终于有值得保留的状态的时刻。在每位用户只有一个个人组织期间，两套方案的行为完全一致，所以组织段一直是免费的，直到它不再免费。

**在对象名里放邮箱或另一个人类可读 id。** 否决：名字里的一切都是永久的，而邮箱是人会更改的值。不透明 id 是唯一适合放进无法重写的键里的那一类。

**可选的 `owner`，`SESSION_FORMAT_VERSION` 保持 `0`。** 否决：它是增量式且不破坏兼容的，而换来这一点的代价是让无归属者会话永远合法。之后每个读取方都需要一条针对缺失归属者的规则，而对一个租户字段来说，安全的规则就是拒绝该日志，这正是版本递增直接做到的事。

**把 `owner` 整体推迟到后续变更。** 否决为虚假的节省：文件头是持久的，因此门在第一个存下的会话时就关上了，而第二片本来就必须让归属者存在，存储键才有意义。

**在 Durable Object 内部验证令牌。** 否决：对象必须先被寻址才能运行，因此在其内部做的检查发生在租户已被选定之后。届时隔离将取决于该检查正确，而不是取决于错误的对象根本触达不到。

**把浏览器会话 cookie 转发给对象，而不是 JWT。** 否决：cookie 对边缘是不透明的，因此验证它意味着每个请求都要调用一次认证服务，这会把一个休眠的认证部署放上产品的请求路径。用缓存的 JWKS 验证 JWT 不需要任何网络往返。

**把 Better Auth 放进 Cloudflare Container，如 2026-08-23 笔记所提议。** 在第一版中否决：容器是被 SSO 插件的 SAML 那一半所要求的，而它依赖 samlify，不大可能在 workerd 上运行。`organization` 加 `jwt` 中没有任何部分需要 Node 运行时，而由于 JWKS 私钥存在 Postgres 中，日后迁往容器不会重新铸造任何密钥。

**Neon 上的托管 Better Auth。** 否决，与 2026-08-23 笔记一致：托管的插件子集不含产品最终需要的功能，而日后迁离它会重新铸造 JWKS 密钥并作废每一个在用会话。

**用 `packages/cf/auth-worker` 而不是 `apps/cf-auth`。** 否决：它会成为 `packages/` 下唯一一个拥有自己 wrangler 部署的条目。层级边界在于 `packages/*/*` 是插件与库，`apps/*` 是可部署物，而认证服务是可部署物。

**为认证服务单开一个仓库。** 否决：JWT 契约由两个 Worker 共享，而拆分仓库会让一次契约变更变成两个 pull request，且没有任何门禁把它们绑在一起。

**在 `packages/` 内部建模组织、用户与角色。** 否决，与 2026-08-23 笔记一致：这会重复认证层已经拥有的东西，并保证两者发散。harness 消费一个已验证的 principal，并存储不透明标识符。

## Acceptance criteria

CLI 与 headless 配置在没有认证服务的情况下照常运行，由 Node provider 的固定本地 principal 作答。两个不同的 principal 解析到两个不同的 Durable Object，而同一个 principal 跨请求解析到同一个。不带有效令牌的请求触达不到任何 harness 表面，并在寻址任何对象之前就在 Worker 中被拒。`hostObjectName` 产出 `dsh:1:<orgId>:<userId>`，且是唯一构造该字符串的地方。`privilegedHosts` 在仓库中任何位置都不再出现。第二片落地之后，由一个 principal 写下的会话日志对另一个 principal 不可读，而一份没有归属者的存量日志在加载时被拒绝，而不是被当作无归属者加载。`pnpm --filter @deepseek-ai/dsh-cf-web run parity:check` 通过，且每一条易手的 seam 都带着一条处置记录。

## Risks

harness 插件树在每一次 Durable Object 唤醒时都要启动，而这项代价只在单个对象上被测量过。在每个活跃 principal 一个对象的情况下它未经测试，也是寻址方式改变之后第一件要做性能剖析的事。

账号关联是本仓库尚未部署的一个服务上的配置项，因此代码树中没有任何东西强制它。在认证服务存在之前，"一个人对应一个用户 id"这条保证依赖的是部署被正确配置，而不是某道门禁；在它被打开之前发生的哪怕一次真实注册，都无法靠一次数据库更新挽回。

对象名里的版本段买到的是逃生口，并不消除底层约束：一个 `dsh:2:` 命名空间依然会抛弃每一个 `dsh:1:` 对象。它把一次事故变成一次刻意的迁移，这值得那六个字符，但与可逆并不是一回事。

`SESSION_FORMAT_VERSION` 的递增会拒绝在此之前写下的每一份会话日志，包括开发者机器上的那些。这正是预发布立场所允许的，也是变更落地时任何人在工作途中要付出的真实代价。
