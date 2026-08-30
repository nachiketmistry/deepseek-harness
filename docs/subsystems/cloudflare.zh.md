# Cloudflare Host

[English](cloudflare.md) | 中文

Cloudflare 子系统是 web Host 的平台一半：与 Node 侧组合的同一棵插件树，挂载在一个 Durable Object 内，树所消费的每条 seam 背后都换成 Workers 形态的 Service Provider。[提案决策](../../.agents/notes/proposed/architecture/2026-08-21-cloudflare-web-host.zh.md)记录了该目标必须通过的各道关卡；[Host 传输 seam 决策](../../.agents/notes/implemented/architecture/2026-08-21-web-host-transport-seams.zh.md)记录了在任何东西能挂载之前、必须先变成 seam 的四处耦合。

## 平台句柄

`ctx.cf` 是部署对自身 Worker 环境的句柄：`env` 绑定对象、宿主 Durable Object 的 SQLite 存储、它的 WebSocket accept 与恢复调用，以及 `waitUntil`。其他每个 Cloudflare provider 都通过这一个 service 读取平台，而不是自行闭包捕获 `env`，因此 provider 可针对伪造句柄测试，而 Worker 入口仍是唯一知道运行时自有类型的文件。

`ctx.cfSandbox` 是 shell、文件系统与子进程 provider 共享的容器句柄：每个会话工作区对应一个被寻址的 Sandbox，工具面在其中运行，而非在 Worker isolate 内。Worker 没有进程表也没有可写磁盘，因此调用 shell 的工具是一次容器调用，而不是本地 spawn。

## 平台替换了什么

已发布 web 组合中每一行仅限 Node 的条目，要么被 Workers provider 替换，要么被丢弃，而构建会拒绝任何它没有 disposition 的行。`apps/cf-web/scripts/composition.mjs` 持有那张表；`pnpm --filter @deepseek-ai/dsh-cf-web run parity` 把它投射到 `apps/cf-web/composition-parity.md`，因此该目标失去的能力是一处可见的 diff，而不是靠使用部署才发现的东西。

平台回答的 seam 都是寻常那些：`webServer`（一个自身不持有监听器的 Fetch 载体，因为 socket 归平台所有）、`clientBundleSource` 与 `agentPresetSource`（构建期表，因为产物不携带可扫描的文件系统）、存储、设置、凭据、附件与 spill（Durable Object SQLite 与 R2），以及文件系统、shell、子进程三件套（Sandbox 容器）。

## 削减是声明出来的，不是发现出来的

无法实现某个操作的平台 provider，会在其 disposition 旁声明该削减，并写明部署失去了什么。preset 创作是只读的，因为 preset 被烘焙进产物；客户端 HMR 处于惰性，因为没有文件供重建 watcher 轮询。parity 关卡会让悄悄削减操作却不声明的 provider 失败，这正是让两套组合保持可比的原因。

## 存储版本与升级

存储单元带版本，而每个后端——JSONL、SQLite 以及 Durable Object 那个——都拒绝更旧的已存格式，而不是迁移它。因此，被组合插件的一次 schema 提升，会让其对象仍持有上一版本的部署启动失败。清除它是一次平台操作：先对不携带该 class 的部署应用一次 `deleted_classes` 迁移，再用一次迁移把它重建为空。`apps/cf-web/wrangler.jsonc` 记录了已应用的序列。

## 如何抵达该部署

Host API 要求与 Node 侧相同的浏览器会话，而 index 响应正是用启动 token 换取它的地方。Node 侧按进程生成该 token，并把它打印到启动它的终端；Worker 两者皆无，而平台会随时重启 Durable Object，因此生成的 token 会在运维者读取并使用它之前就被替换。于是由部署自身提供该 token：`connection` 以 `launchTokenRef: DSH_LAUNCH_TOKEN` 组合，经 Cloudflare 凭据存储解析，而该存储会读取同名的 Worker secret。运维者打开一次 `https://<host>/?token=<该 secret>` 并持有 cookie；启动过程从不记录该 token，因为存活期长于 isolate 的凭据不应进入被持久化的日志流。secret 未设置的部署会让启动失败，而不是提供一个无人能进入的 GUI。cookie 的签名密钥在同一存储中持久化，因此会话能跨 isolate 重启存活；由于 index 请求经 HTTPS 抵达，cookie 带上 `Secure`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcf--cfbindings"></a>

### `ctx.cf` — `CfBindings`

The `cf` service. Constructed by the host with the live platform handle; never configured from a row.

```ts cordis-catalog
/**
 * Read one binding by name.
 * @param name - the binding name from the Worker configuration.
 * @returns the binding value; the caller narrows it to the binding type it configured.
 * @throws when the environment has no such binding: a provider configured
 * for a binding the deployment lacks is a misconfiguration.
 */
binding(name: string): unknown

/**
 * Read one secret or plain-text variable by name.
 * @param name - the variable name.
 * @returns the value, or `undefined` when unset.
 */
secret(name: string): string | undefined

/**
 * Keep the object alive until a background promise settles.
 * @param promise - work that outlives the current request.
 */
waitUntil(promise: Promise<unknown>): void
```

Source: [`packages/cf/cf-bindings/src/index.ts`](../../packages/cf/cf-bindings/src/index.ts)

<a id="ctxcfsandbox--cfsandbox"></a>

### `ctx.cfSandbox` — `CfSandbox`

The `cfSandbox` service: one prepared container handle per tree. `ready` resolves once the workspace root exists and git is configured; adapters await it before their first operation.

```ts cordis-catalog
/**
 * Run one command to completion with collected output.
 * @param argv - executable and arguments, no shell.
 * @param options - working directory, environment, and timeout.
 * @returns exit code and decoded output.
 */
async run( argv: readonly [string, ...string[]], options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}, ): Promise<{ exitCode: number; stdout: string; stderr: string }>

/**
 * Record a project's clone origin so a replaced container gets it back.
 * @param path - absolute project directory under the workspace root.
 * @param url - the clone URL.
 */
async rememberProject(path: string, url: string): Promise<void>

/**
 * Clone every remembered project whose directory is missing: the
 * container's disk is ephemeral (sleep, replacement), git is the durable copy.
 * @returns the paths cloned by this call.
 */
async materialize(): Promise<string[]>
```

Source: [`packages/cf/cf-sandbox/src/index.ts`](../../packages/cf/cf-sandbox/src/index.ts)
<!-- END GENERATED cordis-surface -->
