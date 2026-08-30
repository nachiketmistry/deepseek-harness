# Agent Note: edge-verified principal and the browser session it arrives in

Status: implemented

[English](2026-08-30-edge-verified-principal-and-the-browser-session.md) | 中文

## 问题

[principal 接缝](../../proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.zh.md)规定：Worker 在寻址 Durable Object 之前先校验 Better Auth JWT，并指明三件事一同落地——`ctx.principal` 的 Cloudflare Service Provider、`fetch` 处理器中的校验，以及把 `HOST_NAME` 换成 `hostObjectName(principal)`。

要让这三件事真正发货，还需要四个该笔记没有作出的决定，而每一个都只有当浏览器真正站在部署面前时才会显现。

浏览器无法给 WebSocket 升级请求加上 `Authorization` 头，而 `dsh-cf-web` 的每个会话都经由这样一条流。因此"请求携带 token"必须意味着浏览器在每一个请求上都会发送的东西，升级请求与静态资源请求也包括在内。

Host 仍在为自己做认证。`client-connection` 用一个部署级的启动 token 铸出已签名的会话 cookie，而这项检查发生在对象内部。当边缘已经拒绝了其他所有人之后，把它留在前面并不增加一道检查：它增加的是第二份凭据——一份谁持有谁就能进入的凭据——守着一个已经以某位调用者之名被抵达的对象。

对象在见到任何请求之前就已启动。`HostObject` 的插件树在其构造函数中建立，而休眠之后送达的 socket 消息根本不带请求，因此"从当前请求中读取 principal"的 Provider 在这两条路径上都无从读起。

身份服务对浏览器不可达。Better Auth 的 `trustedOrigins` 决定哪些来源可以发起流程，却不产出任何跨源响应头，于是从 harness 来源提供的登录页，从来看不到它所要登录的那个服务的响应。

## 决定

### token 由边缘铸成的 cookie 携带

Worker 拥有两条路由，它们的存在正是为了取得与交出 principal，因此不能要求已有 principal。`POST /__dsh/session` 接收浏览器从身份服务取得的 token，校验它，并作为 `dsh-principal` 返还——host-only、`HttpOnly`、`SameSite=Strict`、在 https 上带 `Secure`，且与 token 同时过期而非比它活得更久。`GET /__dsh/signout` 清除该 cookie，并提供结束其背后身份会话的页面。

cookie 正是浏览器在每个请求上都会发送的东西，也正是升级请求与静态资源所需要的。它依然是一份 bearer token，因此 `Authorization: Bearer` 同样被接受，测试与任何非浏览器调用者用的就是它。代价在于 cookie 会跨站发送，请求因而具备 CSRF 的形状；答案是 `/api` 的 Host 与 Origin 围栏，`client-connection` 在每种模式下都仍然施加它。

### Host 显式地不再认证

`client-connection` 新增 `browserAuth`，在两者之间作出经过校验的选择：`launch-token`——它原有的换取流程与已签名 cookie——以及 `edge`，后者放行每一个请求，因为部署的入口已经拒绝了其余的。`BrowserAuthority` 是二者共同回答的接口；`EdgeVerifiedAuthority` 是第二个实现，它的 `authenticatedUrl` 抛错，因为"一条谁持有谁就能进入的 URL"恰恰是这种部署所没有的。

CF 组合声明 `edge`，不再声明启动 token；同时配置两者的部署会在加载时失败，而不是悄悄选一个。这是真实的部署事实而非偏好：Durable Object 只能经由持有其绑定的那个 Worker 抵达，而那个 Worker 先行校验。

### 对象从自己的名字读出 principal

`packages/cf/principal-jwt` 持有 Cloudflare 角色的两半。`PrincipalTokenVerifier` 是边缘的一半：`jose` 之上是按 isolate 缓存的 JWKS，刷新下限与缓存寿命都是经过校验的配置，并且要求 `exp`，使任何会话都无法比身份服务所能作出的每一次吊销活得更久。`CfPrincipalResolver` 是 Provider 的一半，它从 `parseHostObjectName(ctx.id.name)` 而非从请求中作答。

对象的名字是"它服务于哪个 principal"的持久记录，而与请求头不同，它能挺过休眠，也在构造函数中就已存在。它同样不可能与边缘产生分歧：Worker 正是用它所校验的那个 principal 构建了这个名字，因此对象要么以该 principal 命名，要么根本不曾被抵达。

`parseHostObjectName` 是 `dsh-principal` 中的新增，其正确性依赖于 subject 联合只有一个变体。当第二个变体被加入时，一个编译期守卫会在该函数中失败——恰好是新变体的永久名字段必须被选定的地方。

### 身份服务回答跨源请求

`apps/cf-auth` 自行回答预检，并为其可信来源清单上的调用者回显 `Access-Control-Allow-Origin`，附以 `Access-Control-Allow-Credentials` 与 `Vary: Origin`。回显来源而非通配，因为携带凭据的请求拒绝通配符。预检不携带凭据也不抵达任何路由，因此在服务被构建之前、在 Postgres 被触及之前就已作答。

### 登录页就是那次拒绝

未认证的导航以 `401` 作答，登录页即是响应体，而不是重定向到一个以 `200` 作答的页面。状态码因而保持"该请求被拒绝"这一事实——这正是验收运行所断言的——而人依然落在一个可以登录的地方。该页面直接与身份服务对话，因此本部署从不经手密码；它先尝试 token 路由，于是仍持有身份会话的浏览器无需再被索要密码即可重新登录。

### 核心包中的一次 Node 文件系统调用

创建 Session 直接调用了 `node:fs` 的 `mkdir`，于是 Cloudflare 上的第一次对话以 `operation not permitted` 失败：Worker 的 `node:fs` 是一个桩，而部署的文件位于它无法触及的 sandbox 容器中。该操作本就属于接缝，`session-controller` 现在注入 `fs` 并调用 `ensureDirectory`。[文件系统接缝修复](../bug-fix/2026-08-30-session-project-directory-through-the-filesystem-seam.zh.md)记录了为何那是一次接缝违规而非 Cloudflare 特例。

## 验收运行证明了什么，又替代了什么

`tests/workerd/edge` 在 workerd 中运行发货的边缘模块，面对真实的 Durable Object 命名空间、真实的 `idFromName` 与真实的按对象 SQLite，而 Host 对象记录自己被以何名寻址，不再启动 harness 插件树。组装后的 Worker 是 15 MiB 的打包插件树，池的运行时在加载它时会退出，因此对象的主体是唯一的替代物，而那一半正是[第三片](../../proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.zh.md)所拥有的。

它的 token 来自同一套密钥集，其中同时发布身份服务自己的密钥与本次运行的密钥，于是该服务签发的 token，与任何服务都不会签发的 token——过期的、被改写的、未签名的——面对同一个校验器，出于同样的理由被接受或拒绝。

`tests/browser` 驱动的是真东西：`wrangler dev` 之上是构建好的 Worker、身份服务，以及两个互相隔离的浏览器上下文。两个账户都先写入，然后才断言任一缺席，因此没有哪条断言能在尚未加载完的侧边栏上侥幸通过。

## 备选方案

**保留启动 token，把 JWT 叠在它前面。** 已否决：这会在组合中留下一份部署级凭据，而它仅剩的用途，是被那个已经校验过调用者的 Worker 递还给 Host。它所执行的检查不再关乎"谁在询问"，而一份谁也不特指的密钥比没有密钥更糟，因为它仍然放行任何捡到它的人。

**把已校验的 principal 通过请求头转发给对象。** 已否决：休眠的对象在 `webSocketMessage` 上醒来，那里没有请求；而插件树在构造函数中建立，那发生在任何请求之前。请求头将不得不被缓存进一个可变槽位，而唤醒路径随后会发现它是空的。对象自己的名字本就是那份记录，它不可变，也不可能与边缘分歧。

**在 Durable Object 内部校验 token。** 在[接缝笔记](../../proposed/architecture/2026-08-29-principal-seam-and-per-principal-addressing.zh.md)中已否决，此处不变：对象必须先被寻址才能运行，因此其内部的检查发生在租户已被选定之后。

**把未认证的导航重定向到登录页。** 已否决：重定向自身的 `200` 才是人与测试共同看到的东西，于是"未抵达任何对象"在状态码上不再可观测。把页面作为拒绝的响应体，既保持状态码诚实，也不付出浏览器会察觉的代价。

**把 token 存入 `localStorage` 并作为请求头发送。** 已否决：WebSocket 升级无法携带该请求头，流因而需要第二套方案；而页面脚本可读的 token，比 `HttpOnly` cookie 是严格更弱的存放之处。

**在 harness 来源上做 CORS 代理，或让 Worker 代理登录。** 已否决：代理登录意味着本部署经手明文密码，而这正是独立身份服务存在的意义所在。服务为自己作答是通行的安排，也把凭据路径留在浏览器与拥有它的那个服务之间。

**让 `browserAuth` 隐式化——由启动 token 的缺席推断出 `edge`。** 已否决：这一推断把"漏配凭据"与"有意委托"变成同一份配置，于是本打算设置 token 却没设置的部署会悄悄放行所有人。这是一个安全选择，所以它被明说。

## 影响

一次部署现在有两个可独立发布的 Worker，且必须就同一个 issuer 达成一致。`apps/cf-web` 的 `AUTH_ISSUER` 与 `AUTH_JWKS_URL` 指名该服务，`apps/cf-auth` 的 `AUTH_TRUSTED_ORIGINS` 指名 GUI；不匹配的结果，是一个对递给它的东西什么也校验不了的部署。两个 Worker 都无法在加载时察觉，因为这两个值都只有在请求进行中才可读。

会话 cookie 是 `SameSite=Strict` 且 host-only，这对以单一来源被抵达的部署是对的，对身份服务跨站的部署则是错的。本地两者都跑在 `localhost` 上，跨端口属同站；而在 `*.workers.dev` 上二者跨站，因为 `workers.dev` 位于 Public Suffix List 上，登录页携带凭据的 fetch 将需要身份服务自身 cookie 上的 `SameSite=None`。目前没有任何东西被部署，而这将是部署时第一件要检查的事。

打开的 WebSocket 比开启它的 token 活得更久。边缘校验升级请求而不再逐帧校验，因此已在流式传输的会话会越过 `exp` 继续，直到它重连为止。缩短那个窗口意味着在对象内部重新校验,而这正是本笔记所否决的安排；另一条路是有界的 socket 寿命，而目前还没有谁需要它。

登录页只有英文。它由 Worker 在任何对象被寻址之前提供，因此位于客户端 locale 所有的文案之外，也位于 `verify-client-ui-i18n` 之外——后者的范围是 `packages/client` 与 `apps/web`。

`client-connection` 多了一个模式，这是核心包上的表面积，其代价由"把选择保持显式"与"`EdgeVerifiedAuthority` 只有九行且没有自己的配置"来偿付。

## 测试

`packages/cf/principal-jwt` 用本地密钥集对校验器做单元测试：真实签名、被改写的声明、被篡改的签名、外来密钥、过期 token、永不过期的 token、未签名 token、另一个 issuer、错配的 audience、两种畸形声明，以及刷新下限在未知 `kid` 面前的坚守。

`apps/cf-web` 的 `test:workerd` 运行上文所述的边缘验收套件；`test:browser` 运行双账户浏览器套件。`pnpm run test:snapshot` 覆盖"没有身份服务的配置一律未变"这一主张：发货的 `headless` 配置通过真实 CLI 重放每一个录制会话。
