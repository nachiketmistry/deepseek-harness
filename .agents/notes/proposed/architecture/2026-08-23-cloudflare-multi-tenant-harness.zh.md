# Agent Note: Cloudflare 上的多租户 harness

Status: proposed

[English](2026-08-23-cloudflare-multi-tenant-harness.md) | 中文

## Problem

[Cloudflare web host](2026-08-21-cloudflare-web-host.zh.md) 把产品搬上了 Workers，并把认证与多租户明确排除在范围之外，而部署也字面地体现了这一点：一个名为 `default` 的 Host Durable Object、一个名为 `default` 的 Sandbox 容器、以部署级 Worker secret 形式存在的 Provider 凭据，以及 harness 中根本不存在的 principal。`SessionHeader` 记录 `id`、`createdAt`、`cwd` 与血缘，却没有 owner。唯一被称作 user id 的值是 `dsh-anonymous-user-id`，一个以 `$DSH_HOME` 为作用域、且刻意不从任何可识别来源派生的遥测 UUID。

同样不存在的是认证。`dsh-client-connection` 把 `trustedHosts` 记录为 DNS 重绑定围栏，"明确不是认证"，并在真正的认证层出现之前，把特权配置平面钉死在 loopback 上。CF 组合用公开主机覆盖了 `privilegedHosts`，于是设置变更、凭据侦察、preset 管理，以及会让 Worker 向调用者选定的 URL 发起 GET 并回报结果的 `llm.discoverModels`，任何知道主机名的人都能触达。

还有两个事实决定了形态，而不只是约束它。Cloudflare 上的容器磁盘是易失的：休眠后的实例会以镜像为准带着全新磁盘重启，而平台还会在不规律的时间点因宿主机重启而停止实例。因此当前这个单一 sandbox 在每次空闲之后就已经丢失了 git 检出 —— 也就是说，部署早已在遵循易失工作区模式，只是从未选择过它。此外，产品打算出售模型容量而非接受客户自带的 Provider key，这从设计中移除了按租户存放凭据的需求，取而代之的是计量与配额义务。

## Proposal

### 身份与租户

身份被委托给自托管的 Better Auth 服务，绝不在 harness 内建模。Neon 上的 Managed Better Auth 只开放了一个插件子集，其中不含 Teams 与企业 SSO，而这两者本产品都需要，因此该服务作为我们自己的部署运行在 Neon Postgres 之上，并启用 organization、teams 与 SSO 插件。

租户层级是 organization、team、user、session。**organization 是隔离边界，user 是协调原子，而 team 是一种授予** —— 一种让若干人访问同一批项目与 preset 的方式，绝不是一个独立的数据世界。因此 team 成员关系只影响授权，绝不出现在存储键中：换了 team 的用户不能因此丢掉自己的会话。

Better Auth 在 session 上记录一个活跃 organization，而一个用户可以属于多个。于是被校验的 principal 是一个二元组 `(orgId, userId)`，并携带该用户的角色与 team 授予。只按 user 作键，会把一个人的两个 organization 并成一个世界，这是本设计中最可能出现的租户缺陷。

### principal 接缝

认证成为 core 中的一个能力接缝，而非 Cloudflare 的关切。Service Definition 暴露当前请求已校验的 principal。Node Service Provider 以一个固定的本地 principal 作答，因此 CLI 与 headless profile 在完全没有网络身份的情况下照常工作；单用户不再是一条独立代码路径，而是一个只有一个 principal 的部署。Cloudflare Service Provider 则校验 Better Auth 的 JWT。

校验发生在 Worker 的 `fetch` handler 中，针对按 isolate 缓存、刷新下限为五到十分钟的 JWKS。Durable Object 从不认证：它收到的是已经校验过的 principal，并据此推导自身身份，这正是让隔离成为结构性而非劝告性的原因。这也让认证服务不在请求热路径上 —— 休眠的认证容器只会让登录变慢，绝不会让产品变慢。

`dsh-client-connection` 今天按主机来把守特权配置平面。该关卡改为按 principal 与角色把守，CF 组合也不再覆盖 `privilegedHosts`。

### 拓扑

一个 Durable Object 类承载 harness 树，以 `org:user` 寻址。这遵循 Cloudflare 自己的规则 —— 围绕协调原子来建模 Durable Object，并把全局单例点名为反模式。organization 级的 Durable Object 被否决：它会把每位成员的会话都压在同一把单线程锁后面。

不存在第二个 Durable Object 类。organization 共享的 harness 状态 —— team 作用域的 preset 库、项目清单 —— 与治理它的 organization 数据一同放在 Postgres，因为它以读为主，不需要单写者。

每个 `org:user:session` 一个 sandbox，任务完成即销毁。该标识符承载信任边界，这正是 Sandbox SDK 所述的"每用户或每信任边界一个 sandbox"：sandbox 内部的 session 共享文件系统与进程空间，不是安全边界。生命周期是易失的，因为平台不允许别的可能。显式 `destroy()` 优于空闲超时：它立刻释放 `max_instances` 名额，也不再为闲置容量付费。

由于容器可能在任务中途停止，harness 必须能在一次运行的任何时点从 git 重建工作区，且该路径要被测试而非假定。未提交的工作是暴露的边缘：只有当 agent 提交得足够频繁，"git 是持久化故事"才成立。

### 数据权威

Postgres 对"谁存在、谁属于何处、他们被欠了什么"具有权威。它持有 Better Auth 的表、GitHub 安装记录、用量账本，以及 organization 共享的 harness 配置。

Durable Object 对"用户做了什么"具有权威：他们的会话日志、storage、settings 与附件元数据。它只存放不透明的 `orgId` 与 `userId` 引用，绝不反范式化姓名、邮箱或角色 —— 这些在 Postgres 中会变，随后就会过期。因此在 Postgres 中删除用户或 organization，需要一条 harness 侧的删除路径，因为没有任何东西会自行通知 Durable Object。

R2 持有附件与 spill。容器文件系统不持有任何持久之物。

### 凭据

产品不接受客户的模型 key，因此不存在按租户存放的 Provider 凭据。

GitHub 访问使用 GitHub App。Installation access token 以 app 身份行事，有效期一小时；user access token 以某个人的身份行事，有效期八小时并附带六个月的 refresh token，且携带 **app 权限与该用户自身访问权的交集**。该交集就是"agent 只能触达这个人能触达的东西"的强制手段，且由 GitHub 而非 harness 来强制。任何由人触发的动作都使用其 user token，于是吊销立即生效，仓库审计线索也指向这个人；installation token 仅保留给真正无人参与的工作。

因此需要存储的东西很少：app 私钥、installation id，以及用户的 refresh token。access token 按操作现铸，从不落盘。refresh token 以信封加密静态存储，数据密钥由 Secrets Store 中的根密钥包裹，于是根密钥轮换的代价是一次重新包裹，而非全量重新加密。

这改变了 sandbox 的约定。`cf-sandbox` 在准备阶段把 `GH_TOKEN` 落成容器环境变量，它在请求结束后仍然存在，且该容器内每个进程都可读。取而代之的是按 git 操作现铸的 token，理想情况下经由一个回调取值的 git credential helper，而非常驻环境变量。

根密钥 —— GitHub App 私钥、信封根密钥、Cloudflare email API token、Better Auth 签名材料 —— 放在 Secrets Store：那是一个账户级、上限 100 条的密钥存储，明确不是按租户的保险库。

### 模型访问与计费

所有模型流量都经由使用 Unified Billing 的 AI Gateway。Cloudflare 以零加价透传 Provider 的推理定价，并对购买额度收取 5% 的固定费用，因此成本基线是 Provider 标价加 5%，透明定价是一个站得住的论断而非口号。

默认模型是托管在 Workers AI 上的 DeepSeek V4 Pro 与 V4 Flash：可用额度计费、支持函数调用与思考模式，并具备 1,048,576 token 的上下文窗口。访问它们走 OpenAI 兼容的 HTTP 端点而非 `env.AI.run()` binding：LLM adapter 本就按请求解析 `baseURL` 与凭据引用，因此 HTTP 让所有部署共用一个 Provider，并把 Cloudflare 的差异变成一个配置值。模型选型由对候选者运行 snapshot 与 e2e 套件来定，而不是看能力表。

每个请求以 AI Gateway 自定义元数据携带 `org_id` 与 `user_id`，在五条上限之内。以这些维度并按 **Split by value** 设定的 spend limit，无需自建配额服务即可让每个 organization 获得独立预算；额度耗尽时经由 Dynamic Route 转向更便宜的模型，而不是返回 429，于是长任务是降级而非猝死。

AI Gateway 是强制点，不是记录系统。它的成本追踪是尽力而为的估算，spend limit 是最终一致的，而并行 subagent 必然会冲过头。计费账本归我们所有，放在 Postgres，以 organization、user、session 为键，由会话事件上的 `TokenUsage` 投影而来 —— 它本就区分 input、output、cache-read 与 cache-write token —— 并按月与 Cloudflare 对账。缓存输入的价格约为新鲜输入的 3%，因此套餐内含额度必须按缓存命中的会话来定量。

按套餐分层的模型访问在 harness 侧以"不提供该模型"来强制，并在 gateway 上再强制一次。只在 gateway 强制会通过错误码泄露套餐结构。

### 认证服务

Better Auth 运行在一个 Cloudflare Container 中，位于它自己的 Worker 之后，与 `dsh-cf-web` 分离，因此认证部署与 harness 部署互不影响，harness 打包也只需携带 `jose`。容器是必需而非偏好：SSO 插件的 SAML 一半依赖 samlify，它不太可能在 workerd 上运行；容器同时提供走 TCP 的原生 Postgres，请求路径上无需 Hyperdrive。

该服务是无状态的。包括 JWKS 私钥在内的全部状态都在 Postgres，实例以 `getRandom` 在固定池中路由，镜像处理 `SIGTERM` —— 因为平台会在宿主机重启时停止实例，并给出十五分钟的排空窗口。区域放置固定在靠近 Neon 项目处，因为每个认证请求都是一次数据库往返。

事务性邮件 —— 验证、magic link 与 organization 邀请 —— 使用 Cloudflare Email Sending REST API，因为 binding 属于 Worker 侧、容器中不可用。REST 的字段名与 binding 不同（`from.address`、`reply_to`），只对 429 与 500 重试，且发信域名必须在首次发送前完成接入并配置 SPF、DKIM 与 DMARC。

### harness 变更清单

`SessionHeader` 增加 owner。principal 接缝连同其两个 Provider 加入 core。`dsh-client-connection` 改为按 principal 与角色把守而非按主机。persistence、storage、settings、附件、spill 与 workspace 按 principal 作键。`cf-sandbox` 改用按会话的标识符、显式销毁与按操作的凭据。DeepSeek adapter 的解析步骤增加 AI Gateway 元数据请求头，其 user-id 请求头改为真正的 principal 而非遥测 UUID。以上每一项都会作为一条处置方式落在 [composition-parity.md](../../../../apps/cf-web/composition-parity.md) 中，于是易手的能力始终可见。

## Alternatives considered

- **Neon 上的 Managed Better Auth** —— 否决：托管插件子集未启用 Teams，也未列出企业 SSO，而两者都是必需。之后再迁移会重新铸造 JWKS 密钥并使每个活跃会话失效；而恰恰在需要这些缺失插件的地方，托管服务的价值最低。
- **在 harness 内建模租户** —— 否决：在 `packages/` 中建模 organization、team 或角色，等于重复认证层已经拥有的东西，并注定分叉。harness 消费一个已校验的 principal，并只存放不透明标识符。
- **把会话数据放进 Postgres 并用行级安全** —— 否决：会话日志是以追加为主、单写者、带可休眠 WebSocket 的事件流，这正是 Durable Object 的用途，也正是 `session-persistence-do` 的实现。一旦 Worker 在选择 Durable Object 之前就确立了 principal，行级安全便无所增益。用于跨会话报表的 Neon 投影，仍可留在既有的 `session-query` 接缝之后。
- **自带模型 key** —— 作为产品决策否决：它把成本与配额转移给客户，代价是一座按租户的凭据保险库，而透明定价模型两者都不需要。
- **长期存在的按用户 sandbox** —— 否决，因为平台并不提供。所有容器磁盘都是易失的，休眠实例会从镜像重启，因此按用户的 sandbox 只是一个稳定名字，其后的工作区无论如何都要重建。按会话命名让真实的生命周期变得显式。
- **每个 organization 一个额外的 Durable Object 类** —— 否决：organization 共享的 harness 状态以读为主、无需单写者，而成员关系归 Postgres 所有。单一类避免了同一批事实出现第二个权威。

## Acceptance criteria

没有有效 token 的请求触达不到任何 harness 界面，特权配置平面在没有相应角色时不可达。包含同一用户的两个 organization 解析到不同的 Durable Object 与不同的 sandbox，且彼此读不到对方的会话。被移出 organization 的用户在一个 token 生命周期内失去访问。CLI 与 headless profile 在没有认证服务的情况下原样运行。任务中途被杀死的 sandbox 会在下一轮从 git 重建。每个模型请求都出现在 Postgres 账本中，并归属到某个 organization、user 与 session，且月度总额与 Cloudflare 的计费对得上。`pnpm --filter @deepseek-ai/dsh-cf-web run parity:check` 通过，且每个易手的接缝都带有处置方式。

## Risks

以额度计费的前沿模型速率限制是按账户、按模型的，为所有租户共享，并被并行 subagent 扇出放大；这是第一堵扩展墙，而且不是按客户计的。出售容量使试用滥用成为直接的财务攻击，而 spend limit 是最终一致的，因此试用预算需要为突发冲过头留出余量，试用 organization 的 subagent 扇出可能需要设限。额度余额可能变为负数，Cloudflare 会向在案的支付方式扣款，因此 gateway 级的总上限是一项责任控制而非可有可无的功能。

每次 Durable Object 唤醒都要启动一棵插件树，意味着启动成本随活跃用户数增长，而这在超过一个用户时尚未验证。Workers AI 上的 DeepSeek V4 是否匹配 harness 的工具调用行为，是一个必须由 snapshot 套件在其成为默认之前回答的经验问题。AI Gateway 会记录 prompt 与响应，对编码 agent 而言那就是由 Cloudflare 持有的客户源码；保留策略可配置，而这个选择属于第一次安全评审之内，而非之后。
