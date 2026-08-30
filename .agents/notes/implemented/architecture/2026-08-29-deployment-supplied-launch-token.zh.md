# Agent Note：由部署提供的启动令牌

Status: implemented

[English](2026-08-29-deployment-supplied-launch-token.md) | 中文

## 问题

浏览器认证覆盖了每一种界面，但它的引导凭据只为其中一种而建。[浏览器启动令牌认证](2026-08-24-browser-token-authentication.zh.md)按 Host 进程生成随机启动令牌，并通过启动该进程的界面交给运维者：`dsh web` 把 URL 打印到运维者正注视的终端。Cloudflare 部署两半皆无。Worker 没有终端，而平台按自身节奏启动与驱逐 Host Durable Object，因此某次启动生成的令牌会在运维者能据此行动之前被替换。

已部署的 GUI 让这一点显形：`web-cf` 每次启动向日志流写一次启动 URL，运维者从那里读取。对着实时部署，从一次冷启动读到的令牌在四分钟后被拒绝，因为该对象已经重启并生成了另一个。index 对每个请求回 401，API 对每次调用回 401，而读日志再打开 URL 的任何次序都不会收敛，因为每次读取都在与下一次重启赛跑。把凭据发布到被持久化的日志流也是放错了地方：Workers Logs 对每个具备日志访问权的账户主体可读，而不只是对执行部署的人。

## 决策

无法把新生成的令牌交到运维者手中的部署，改为提供自己的令牌。`client-connection` 增加 `launchTokenRef` 配置字段，指明一个凭据引用；设置后，Connection 在激活期间经 `ctx.credentials` 解析它，`BrowserAuth` 用该值作为启动令牌而不再生成。未设置时，启动令牌一如既往按进程生成，这正是 loopback CLI 所需，也是现有每个 Node 界面所保留的。

该引用是一项配置输入，因此在加载时失败：不符合凭据引用语法的值，以及提供方解析不到的引用，都会在插件激活期间抛错。已指明自身引导凭据却读不到它的部署，没有别的途径接纳其运维者，因此拒绝启动是把这一点说清楚，而不是提供一个无人能进入的 GUI。短于 32 个字符的所提供令牌会被拒绝，理由与生成的令牌取 32 个随机字节相同：它是一个网络可达部署的全部引导凭据，其长度不是随部署而变的可调项。

Cloudflare 组合设置 `launchTokenRef: DSH_LAUNCH_TOKEN`（`apps/cf-web/scripts/compose.mjs`，可在构建时经 `DSH_CF_LAUNCH_TOKEN_REF` 改名）。`dsh-credentials-secrets` 解析引用时先查 Durable Object 存储、再查同名的 Worker secret，因此 `wrangler secret put DSH_LAUNCH_TOKEN` 就是运维者的全部步骤，而 Models 页面之后可以不经重新部署轮换该值。`web-cf` 不再记录启动 URL：令牌如今活得比 isolate 更久，而运维者已经持有的凭据不属于被持久化的日志流。

当铸造会话 cookie 的那次 index 请求经 HTTPS 抵达时，cookie 带上 `Secure`，该判断读自请求 URL 的 scheme 而非任何转发 header。Fetch 载体提供绝对的 `https:` URL；`node:http` 提供路径，它相对哨兵 `http:` 基址解析，从而让随附 loopback 服务器的 cookie 保持不变。

## 验证

单元覆盖锁定：所提供的令牌就是 `authenticatedUrl` 发布的那个；在换用新进程属主重启后它仍可完成交换；31 个字符的令牌被拒绝；`Secure` 在两个方向上都跟随 index 请求的 scheme。插件级覆盖以 `launchTokenRef` 对着能解析它的凭据存储启动 Connection，并锁定两种加载失败：解析不到的引用，以及不符合引用语法的值。

## 备选方案

**把生成的令牌与 cookie 签名密钥一同持久化。** 这让令牌在重启后存活，却仍把日志流留作读取它的唯一位置，因此运维者依旧从被持久化的日志中得知自己的凭据，首次部署也依旧与首次驱逐赛跑。[启动令牌记录](2026-08-24-browser-token-authentication.zh.md)为 loopback CLI 拒绝了持久令牌，因为在那里它会成为第二个长期凭据；该理由对它所针对的界面依然成立，而部署侧的回答是让运维者拥有该凭据，而不是由进程铸造一个。

**在部署前置 Cloudflare Access。** Zero Trust Access 是平台原生的运维者认证，对共享部署仍是更好的答案。它需要 Connection 中一个校验 JWT 的接缝，以及一个配置了 Access 的 zone，两者都不存在；而且它并不免除 `workers.dev` 部署对引导凭据的需要。它保持开放而非被拒绝。

**在 `web-cf` 内从 `cf` 绑定读取令牌。** 那样这个粘合包会拥有一项由 Connection 执行的认证输入，把一个决策拆到两个包里。Connection 已为 cookie 签名密钥注入 `credentials`，因此该引用在使用令牌的地方解析。

## 后果

Cloudflare 部署如今有一个由运维者设置的持久引导凭据，登录是一次打开 URL，其 cookie 可跨重启与重新部署存活。该凭据是长期的：轮换它意味着更改 secret，而既有 cookie 直到过期前仍然有效，因为 cookie 由独立的持久密钥签名。删除 `client-connection/browser-session` grant 记录并重启，仍是全局会话吊销手段。

升级到本构建却未设置 secret 的部署，会以消息中指明的引用名启动失败。这正是预期的失败：先前的行为是一个对每个请求都回 401 的部署。
