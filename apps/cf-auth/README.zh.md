# @deepseek-ai/dsh-cf-auth

[English](README.md) | 中文

dsh 身份服务：运行在 Cloudflare Worker 上的 Better Auth，背后是经 Hyperdrive 连接的 Neon Postgres。它回答调用者是谁，并签发 [dsh-cf-web](../cf-web/README.zh.md) 在其边缘验证的 JWT。它刻意是一个独立部署，这样认证发布与 harness 发布永远不是同一件事，冷启动的认证部署代价也只是一次缓慢的登录，而不是一次缓慢的会话。

设计以及那些无法重来的决定记录在 [principal seam Agent Note](../../.agents/notes/proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.zh.md) 中。

## What it runs

两个 Better Auth 插件，别无其他。`organization` 之所以在场，是因为 harness 按组织与用户寻址其 Durable Object，因此没有组织的用户没有可触达的对象。`jwt` 之所以在场，是因为 harness 依据 JWKS 验证，而不是每个请求都调用本服务。

登录方式是给人用的 Google，以及邮箱加密码，好让测试无需浏览器即可经服务端 API 创建账号。邮箱验证关闭，也没有密码重置流程，这正是把邮件发送方及其 SPF、DKIM、DMARC 记录挡在本部署之外的原因；两种登录方式都无需它。账号关联开启，并把 Google 视为已验证邮箱的可信来源，因此无论按下哪个按钮，一个人都只保有一个用户 id。

每位用户在注册时获得一个个人组织，由 `user.create.after` 钩子以显式 `userId` 创建，因为此时用户还没有可据以行事的会话。

## The token the edge reads

JWT 携带 harness 使用的恰好两个声明：`sub` 是用户 id，`org` 是组织 id，两者都是身份服务的不透明 id。harness 由它们构造 `dsh:1:<org>:<sub>` 并寻址一个 Durable Object，因此缺少任一声明的令牌都是边缘无法据以行事的。

`org` 在签名令牌时解析，而不是从会话的 `activeOrganizationId` 读取。注册会在个人组织存在之前约一秒创建会话，于是会话创建钩子找不到成员关系，把该列留为 null；由它签发的令牌将不指名任何组织。一旦用户有可选的活动组织，所选的活动组织仍然优先。若某个用户不属于任何组织，本服务会拒绝签发令牌，而不是交出一个边缘随后会拒绝的令牌，这样故障由造成它的服务来报告。

## 从另一个来源的浏览器抵达它

harness 网页 GUI 由自己的来源提供，并对着本服务登录，这使登录流程成为一个携带凭据的跨源请求。Better Auth 的 `trustedOrigins` 决定哪些来源可以发起流程，自身不产出任何跨源响应头，因此本 Worker 亲自回答这些检查：它自行回应预检，并为 `AUTH_TRUSTED_ORIGINS` 清单上的调用者回显 `Access-Control-Allow-Origin`，附以 `Access-Control-Allow-Credentials` 与 `Vary: Origin`。回显来源而非通配，因为携带凭据的请求拒绝通配符。

不在 `AUTH_TRUSTED_ORIGINS` 中的来源得不到任何响应头，于是浏览器会在页面看到之前丢弃响应。当登录页一片空白而其控制台报告 CORS 拒绝时，要找的正是这个故障。

## Schema

`migrations/0001-init.sql` 由本应用自己的 `authOptions` 生成，因此 schema 与运行中的服务不会发生漂移；它先被提交与评审，然后才被应用，而不是由 CLI 就地推送。

```sh
DATABASE_URL="<neon direct url>" pnpm run schema    # regenerate from authOptions
DATABASE_URL="<neon direct url>" pnpm run migrate   # apply the reviewed file
```

两者的 `DATABASE_URL` 都是 Neon 的**直连**连接串。生成与迁移都从 Node 运行，不得经由 Hyperdrive——后者的存在是为了服务 Worker。

## Local development

`pnpm run dev` 在 workerd 上以 `http://localhost:8788` 提供该 Worker，`pnpm run seed` 创建固定账号 `alice@dev.invalid` 与 `bob@dev.invalid`，并打印各自的 `org`、`sub` 和一个可用令牌。播种是幂等的：已存在的账号会被登录而不是重建，因此 principal 在重启之间保持稳定，可当作固定装置使用。两个脚本都读取 `.dev.vars`，该文件已被 gitignore；复制 `.dev.vars.example` 并填写即可。

请把 `DSH_CF_AUTH_DEV_DATABASE_URL` 指向一个用完即弃的 Neon 分支，绝不要指向部署所用的数据库，原因见 Bindings 一节：以本地密钥签名会留下部署无法解密的 `jwks` 行。

有两件事 `wrangler dev` 无法自行推断，均由 `pnpm run dev` 处理。Secrets Store 绑定解析到的本地存储起初为空，且 `.dev.vars` 并不会填充它，因此每个值都在服务器启动前被镜像进去。Hyperdrive 没有本地连接池，因此数据库连接串以 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` 传入，wrangler 从自身环境读取它，而不是从绑定读取。

Google 客户端的值只需存在即可，因为该 Worker 在服务任何路由之前都会读取全部三个密钥；Google 流程本身需要已注册的重定向 URI，本地不作演练。播种会发送 `Origin` 头——浏览器始终发送而 Node 的 `fetch` 从不发送——因此它会像真实客户端一样接受 `trustedOrigins` 的检查。

## Bindings

`HYPERDRIVE` 指向 Neon 的直连端点，而不是其 pooler：Hyperdrive 自己维护区域连接池，把它叠在 Neon 的 PgBouncer 上等于给池再套一个池。Postgres 驱动需要 `nodejs_compat`，因为 Hyperdrive 经由 `node:net` 讲 TCP。

签名材料与 Google 客户端存放在账户级 Secrets Store，而非每个 Worker 各自的 secret，这样认证服务重新部署不会重新铸造它们，第二个服务也能读取同一批值。JWKS 私钥存放在 Postgres 中，这正是本服务的运行时宿主成为可移动决定的原因：如果 SSO 插件的 SAML 那一半日后迫使迁往 Container，不会重新铸造任何密钥，也不会作废任何在用会话。

这些存储的私钥是**用 `BETTER_AUTH_SECRET` 加密的**，因此数据库与该 secret 是一个整体。只有 secret 一并迁移，换宿主才是免费的；轮换 secret 会抛弃每一个既有密钥；而 `jwks` 行由另一个 secret 签出的数据库，会让每一次令牌请求都以 `Failed to decrypt private key` 失败。任何曾指向测试 secret 的数据库，都必须在真实部署签名任何东西之前清空其 `jwks` 行。

## Known Limitations and Deferred Work

- **没有邮件发送方** —— 邮箱验证、密码重置与组织邀请都需要它，而它们都缺席。`invitation` 表存在只是因为 organization 插件创建了它；没有任何代码向其写入。
- **不强制角色** —— organization 插件自带默认角色，而每个个人组织的成员都是 `owner`。目前没有任何代码读取该角色。
- **teams 被推迟** —— 不创建任何 teams 表。若日后启用，任何代码都不得按 team 建储存键：更换 team 的用户不得因此丢失其会话。
- **实践中每位用户一个组织** —— 用户恰好属于一个个人组织，且没有创建或加入另一个的流程。因此 `org` 声明今天对每位用户是稳定的，harness 依赖这一点。
- **e2e 套件不做类型检查** —— `tsconfig.json` 是 workerd 程序，只覆盖 `src`；而 `tests/principal-token.e2e.ts` 属于 Node，并触达 Worker 程序刻意看不到的 workspace 包。它靠运行来验证，而不是靠 `pnpm run typecheck`。
- **cookie 尚未为跨站做好准备** —— Better Auth 的会话 cookie 是 `SameSite=Lax`，浏览器只有在两者同站时才会从另一个来源把它发给本服务。对 `localhost` 上的两个端口成立；对两个 `*.workers.dev` 子域不成立，因为 `workers.dev` 位于 Public Suffix List 上。跨站部署需要先在此处改为 `SameSite=None`，其登录页才能工作。
- **没有账号删除路径** —— 在 Postgres 中删除用户不会告知 harness，而 harness 的 Durable Object 正以由这些已不存在的 id 派生的名字持有该用户的会话。
