# Cloudflare host

English | [中文](cloudflare.zh.md)

The Cloudflare subsystem is the platform half of the web Host: the same plugin tree the Node surface composes, mounted inside a Durable Object with Workers-shaped Service Providers behind every seam the tree consumes. The [proposed decision](../../.agents/notes/proposed/architecture/2026-08-21-cloudflare-web-host.md) records the gates this target had to clear; the [host transport seams decision](../../.agents/notes/implemented/architecture/2026-08-21-web-host-transport-seams.md) records the four couplings that had to become seams before any of it could mount.

## Platform handle

`ctx.cf` is the deployment's handle on its own Worker environment: the `env` bindings object, the hosting Durable Object's SQLite storage, its WebSocket accept and recovery calls, and `waitUntil`. Every other Cloudflare provider reads the platform through this one service rather than closing over `env` itself, so a provider is testable against a fake handle and the Worker entry stays the only file that knows the runtime's own types.

`ctx.cfSandbox` is the container handle the shell, filesystem, and subprocess providers share: one addressed Sandbox per session workspace, with the tool surface running inside it rather than in the Worker isolate. The Worker has no process table and no writable disk, so a tool that shells out is a container call, not a local spawn.

## What the platform replaces

Every Node-only row in the shipped web composition is either replaced by a Workers provider or dropped, and the build refuses a row it has no disposition for. `apps/cf-web/scripts/composition.mjs` holds that table; `pnpm --filter @deepseek-ai/dsh-cf-web run parity` projects it into `apps/cf-web/composition-parity.md`, so a capability this target loses is a visible diff rather than something discovered by using the deployment.

The seams the platform answers are the ordinary ones: `webServer` (a Fetch carrier with no listener of its own, since the platform owns the socket), `clientBundleSource` and `agentPresetSource` (build-time tables, because the artifact carries no filesystem to scan), storage, settings, credentials, attachments, and spill (Durable Object SQLite and R2), and the filesystem, shell, and subprocess trio (the Sandbox container).

## Reductions are declared, not discovered

A platform provider that cannot implement an operation declares the reduction beside its disposition, naming what the deployment loses. Preset authoring is read-only because presets are baked into the artifact; client HMR is inert because no file exists for a rebuild watcher to poll. The parity gate fails a provider that quietly reduces an operation without saying so, which is what keeps the two compositions comparable.

## Storage versions and upgrades

Storage units are versioned, and every backend — JSONL, SQLite, and the Durable Object one — rejects an older stored format rather than migrating it. A schema bump in a composed plugin therefore fails the boot of a deployment whose object still holds the previous version. Clearing it is a platform operation: a `deleted_classes` migration applied against a deploy that carries no such class, followed by a migration that recreates it empty. `apps/cf-web/wrangler.jsonc` records the sequence that has been applied.

## Reaching the deployment

The Host API requires the same browser session the Node surface requires, and the index response is where a launch token is exchanged for it. The Node surface generates that token per process and prints it to the terminal it was started from; a Worker has neither, and the platform restarts the Durable Object whenever it likes, so a generated token would be replaced before an operator could read and use one. The deployment therefore supplies the token itself: `connection` is composed with `launchTokenRef: DSH_LAUNCH_TOKEN`, resolved through the Cloudflare credential store, which reads the Worker secret of that name. An operator opens `https://<host>/?token=<that secret>` once and holds the cookie; the boot never logs the token, because a credential that outlives the isolate does not belong in a persisted log stream. A deployment whose secret is unset fails its boot rather than serving a GUI nobody can enter. The cookie's signing secret is durable in the same store, so sessions survive isolate restarts, and the cookie carries `Secure` because the index request arrives over HTTPS.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
