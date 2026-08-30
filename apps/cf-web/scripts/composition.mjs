// The web composition's package rows, read from the two bundle patch layers
// so this app never carries a stale copy of the roster, and the disposition of
// every row the CF composition does not mount as written.
//
// One row of the web composition is either mounted on CF unchanged or carries a
// disposition here. A disposition is the single place that decides what the CF
// build does with the row (compose.mjs) and what the parity report says about it
// (parity.mjs), so an excluded row cannot be replaced in the build while the
// report still calls it a gap, or vanish from the product while the report stays
// silent — which is how the skills, Code Mode, and workflow gaps went unnoticed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './workspace-resolver.mjs'

const LAYERS = ['packages/bundle/base/cordis.patch.yml', 'packages/bundle/web-app/cordis.patch.yml']

/**
 * Every `name: '@deepseek-ai/...'` row of the web composition, deduplicated and sorted.
 * @returns {string[]}
 */
export function compositionPackages() {
  const names = new Set()
  for (const layer of LAYERS) {
    const text = readFileSync(join(ROOT, layer), 'utf8')
    for (const match of text.matchAll(/^\s*name:\s*'(@deepseek-ai\/[^']+)'/gm)) names.add(match[1])
  }
  return [...names].sort()
}

/**
 * What the CF build does with one web composition row, and what the product loses by it.
 *
 * - `replaced` — a `packages/cf/*` provider takes over behind the same Service Definition.
 *   `by` returns the substitute composition rows for the deployment; `entry` names a
 *   substitute the Worker entry mounts ahead of the composition instead (`src/worker.ts`),
 *   which is where a provider needing a Durable Object handle or a build-time table lives.
 *   `presets` says what a preset row of the same package does, and is required only once a
 *   preset actually mounts one. `reduced` and `degraded` say where the substitute is not a
 *   like-for-like stand-in, keyed by substitute package: `reduced` entries are cross-checked
 *   against a scan of the provider's source (fidelity.mjs) and fail when they disagree in
 *   either direction, while `degraded` states a platform limit no scan can see.
 * - `not-applicable` — the row contributes nothing to this deployment (dev-only tooling,
 *   another platform, an optional catalog). No capability is lost.
 * - `gap` — the CF deployment does not have the capability. `orphans` names the rows that
 *   stay mounted and depend on it; parity.mjs verifies each is still in the composition, so
 *   the claim cannot rot into a stale note.
 *
 * @typedef {{ member: string, cost: string }} ReducedOperation
 * @typedef {{ kind: 'replaced', reason: string, by: (deployment: Deployment) => object[], entry?: string, presets?: 'replace' | 'drop', reduced?: Record<string, ReducedOperation[]>, degraded?: Record<string, string> }} ReplacedDisposition
 * @typedef {{ kind: 'not-applicable', reason: string }} NotApplicableDisposition
 * @typedef {{ kind: 'gap', reason: string, capability: string, impact: string, orphans: string[], status: 'open' | 'out-of-scope', tracking: string }} GapDisposition
 * @typedef {ReplacedDisposition | NotApplicableDisposition | GapDisposition} CfDisposition
 * @typedef {{ publicHost: string, publicUrl: string, workspaceRoot: string }} Deployment
 */

/** The Agent Note that owns the CF host plan; the tracking home for gaps it did not close. */
const CF_NOTE = '.agents/notes/proposed/architecture/2026-08-21-cloudflare-web-host.md'

/**
 * Every web composition row the CF composition does not mount, by package name.
 * @type {Map<string, CfDisposition>}
 */
export const CF_ROW_DISPOSITIONS = new Map([
  // ── Node providers a packages/cf/* provider replaces behind the same Service Definition ──
  ['@deepseek-ai/dsh-host-webserver-node', {
    kind: 'replaced',
    reason: 'node:http + ws listener',
    // The Durable Object owns the fetch handler and the hibernatable sockets, so the
    // carrier mounts against the platform handle before the composition boots.
    by: () => [],
    entry: '@deepseek-ai/dsh-webserver-cf',
    reduced: {
      '@deepseek-ai/dsh-webserver-cf': [
        { member: 'address', cost: 'No bound host and port: a Worker does not listen. The only consumer in the web composition is the Node web glue, which `web-cf` replaces with the deployment\'s public URL, so nothing reads it here.' },
      ],
    },
  }],
  ['@deepseek-ai/dsh-settings-file', {
    kind: 'replaced',
    reason: 'disk YAML + chokidar',
    by: () => [{ id: 'settings-do', name: '@deepseek-ai/dsh-settings-do' }],
  }],
  ['@deepseek-ai/dsh-credentials-local', {
    kind: 'replaced',
    reason: 'disk .env + chokidar',
    by: () => [{ id: 'credentials-secrets', name: '@deepseek-ai/dsh-credentials-secrets' }],
  }],
  ['@deepseek-ai/dsh-session-persistence-jsonl', {
    kind: 'replaced',
    reason: 'disk JSONL',
    by: () => [{ id: 'session-persistence-do', name: '@deepseek-ai/dsh-session-persistence-do' }],
    reduced: {
      '@deepseek-ai/dsh-session-persistence-do': [
        { member: 'locate', cost: 'One Durable Object database holds every session, so no session has an independent artifact to point at. The api-proxy and `shell-env` expose no session-log path.' },
      ],
    },
  }],
  ['@deepseek-ai/dsh-storage-json', {
    kind: 'replaced',
    reason: 'disk JSON',
    by: () => [{ id: 'storage-do', name: '@deepseek-ai/dsh-storage-do' }],
  }],
  ['@deepseek-ai/dsh-attachment-local', {
    kind: 'replaced',
    reason: 'disk store',
    by: () => [{ id: 'attachment-r2', name: '@deepseek-ai/dsh-attachment-r2' }],
  }],
  ['@deepseek-ai/dsh-spill-local', {
    kind: 'replaced',
    reason: 'OS temp dir',
    by: () => [{ id: 'spill-r2', name: '@deepseek-ai/dsh-spill-r2' }],
  }],
  ['@deepseek-ai/dsh-subprocess-local', {
    kind: 'replaced',
    reason: 'node:child_process',
    by: deployment => [
      { id: 'cf-sandbox', name: '@deepseek-ai/dsh-cf-sandbox', config: { workspaceRoot: deployment.workspaceRoot, gitTokenSecret: 'GH_TOKEN' } },
      { id: 'subprocess-cf-sandbox', name: '@deepseek-ai/dsh-subprocess-cf-sandbox' },
    ],
    degraded: {
      '@deepseek-ai/dsh-subprocess-cf-sandbox': 'Two spawn options throw rather than run: `stdin: \'pipe\'` (the Sandbox SDK exposes no process stdin) and `\'inherit\'` output (a Worker has no parent descriptors). A terminal delivers only SIGINT, to the foreground group.',
    },
  }],
  ['@deepseek-ai/dsh-sandbox-local', {
    kind: 'replaced',
    reason: 'OS sandbox launchers',
    by: () => [{ id: 'sandbox-passthrough', name: '@deepseek-ai/dsh-sandbox-passthrough' }],
    degraded: {
      '@deepseek-ai/dsh-sandbox-passthrough': 'Reports `partial` enforcement through the seam\'s own vocabulary: the container is the whole isolation boundary, and the per-call policy — `read-only` versus `workspace-write`, the workspace root, the session identity — is not enforced inside it. A `read-only` call still permits writes.',
    },
  }],
  ['@deepseek-ai/dsh-fs-sandbox', {
    kind: 'replaced',
    reason: 'local-disk containment provider',
    by: () => [{ id: 'fs-cf-sandbox', name: '@deepseek-ai/dsh-fs-cf-sandbox' }],
  }],
  ['@deepseek-ai/dsh-host-directory-picker-auto', {
    kind: 'replaced',
    reason: 'OS chooser probe',
    // The auto picker mounts a backend and its client surface as a pair; the CF
    // backend is the container browser, so the browse surface is the client half.
    by: () => [
      { id: 'directory-picker-cf', name: '@deepseek-ai/dsh-directory-picker-cf' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ],
  }],
  ['@deepseek-ai/dsh-client-bundle-source-node', {
    kind: 'replaced',
    reason: 'node_modules resolution of client bundles',
    by: () => [],
    entry: '@deepseek-ai/dsh-client-bundle-source-static',
    reduced: {
      '@deepseek-ai/dsh-client-bundle-source-static': [
        { member: 'watchPath', cost: 'Client bundles are baked into the Worker artifact, so no file exists for a rebuild watcher to poll. Client HMR is inert on this deployment; a new bundle arrives only by redeploying.' },
      ],
    },
  }],
  ['@deepseek-ai/dsh-agent-presets-filesystem', {
    kind: 'replaced',
    reason: 'disk preset roots + chokidar',
    by: () => [],
    entry: '@deepseek-ai/dsh-agent-presets-static',
    reduced: {
      '@deepseek-ai/dsh-agent-presets-static': [
        { member: 'authorable', cost: 'The presets are baked into the host artifact at build time and there is nowhere for a locally authored one to go, so the deployment is read-only for presets: the GUI disables duplicating and editing a preset, and a user cannot add one.' },
      ],
    },
  }],
  ['@deepseek-ai/dsh-web-app', {
    kind: 'replaced',
    reason: 'Node glue (browser opener, LAN trust, dist resolution)',
    by: deployment => [{ id: 'web-cf', name: '@deepseek-ai/dsh-web-cf', config: { publicUrl: deployment.publicUrl } }],
  }],

  // ── Rows that contribute nothing to this deployment ──
  ['@deepseek-ai/cordis-plugin-hmr', { kind: 'not-applicable', reason: 'file watching; disabled on web already' }],
  ['@deepseek-ai/dsh-client-hmr', { kind: 'not-applicable', reason: 'stat-polls client bundles on disk; bundles are static on CF' }],
  ['@deepseek-ai/dsh-web-app/startup', { kind: 'not-applicable', reason: 'commander flags of the CLI invocation' }],
  ['@deepseek-ai/dsh-pwsh-sandbox', { kind: 'not-applicable', reason: 'Windows only' }],
  ['@deepseek-ai/dsh-tool-pwsh', { kind: 'not-applicable', reason: 'Windows only' }],
  ['@deepseek-ai/dsh-session-telemetry-otel', { kind: 'not-applicable', reason: 'node exporter transport; disabled by default in the web composition' }],
  ['@deepseek-ai/dsh-llm-pi-ai', { kind: 'not-applicable', reason: 'optional provider catalog; not in the CF composition' }],

  // ── Capabilities the CF deployment does not have ──
  ['@deepseek-ai/dsh-skill-filesystem', {
    kind: 'gap',
    reason: 'disk walker + chokidar',
    capability: 'skills',
    impact: 'Every preset mounts `tool-skill` over a `skills` registry with no provider registered into it, so the model is offered a skill loader whose catalog is always empty.',
    orphans: ['@deepseek-ai/dsh-tool-skill'],
    status: 'open',
    tracking: CF_NOTE,
  }],
  ['@deepseek-ai/dsh-skill-badge', {
    kind: 'gap',
    reason: 'disk asset directory resolved from import.meta.url at module load, which production workerd leaves undefined',
    capability: 'skills',
    impact: 'The skills that ship with the deployment are unavailable even once a discovery provider exists.',
    orphans: ['@deepseek-ai/dsh-tool-skill'],
    status: 'open',
    tracking: CF_NOTE,
  }],
  ['@deepseek-ai/dsh-code-runtime-worker-thread', {
    kind: 'gap',
    reason: 'node:worker_threads',
    capability: 'code-mode',
    impact: 'The `code` preset mounts `tool-presentation`, which waits on `codeRuntime` forever, so the preset whose purpose is Code Mode silently serves native tools instead.',
    orphans: ['@deepseek-ai/dsh-agent-tool-presentation'],
    status: 'out-of-scope',
    tracking: CF_NOTE,
  }],
  ['@deepseek-ai/dsh-workflow-worker-thread', {
    kind: 'gap',
    reason: 'node:worker_threads + node:vm',
    capability: 'workflow',
    impact: 'No workflow engine is mounted, while the host still mounts the workflow run UI.',
    orphans: ['@deepseek-ai/dsh-client-ui-workflow-run'],
    status: 'out-of-scope',
    tracking: CF_NOTE,
  }],
  ['@deepseek-ai/dsh-tool-workflow', {
    kind: 'gap',
    reason: 'consumer of the worker-thread workflow engine',
    capability: 'workflow',
    impact: 'No preset offers the workflow tool.',
    orphans: ['@deepseek-ai/dsh-client-ui-workflow-run'],
    status: 'out-of-scope',
    tracking: CF_NOTE,
  }],
  ['@deepseek-ai/dsh-tool-ralph', {
    kind: 'gap',
    reason: 'consumer of the worker-thread workflow engine',
    capability: 'workflow',
    impact: 'No preset offers the ralph loop tool.',
    orphans: ['@deepseek-ai/dsh-client-ui-workflow-run'],
    status: 'out-of-scope',
    tracking: CF_NOTE,
  }],
  ['@deepseek-ai/dsh-cordis-host-runner', {
    kind: 'gap',
    reason: 'node:vm',
    capability: 'self-modification',
    impact: 'The agent cannot mount, inspect, or modify its own plugin tree at runtime.',
    orphans: [],
    status: 'out-of-scope',
    tracking: CF_NOTE,
  }],
])

/**
 * The shipped agent presets the CF composition does not carry, by preset directory name.
 * parity.mjs fails when a preset directory is neither composed nor listed here.
 * @type {Map<string, { capability: string, reason: string, status: 'open' | 'out-of-scope', tracking: string }>}
 */
export const CF_SKIPPED_PRESETS = new Map([
  ['cordis', {
    capability: 'self-modification',
    reason: 'mounts `cordis-host-runner` (node:vm)',
    status: 'out-of-scope',
    tracking: CF_NOTE,
  }],
  ['minimal', {
    capability: 'minimal-preset',
    reason: 'shadows the filesystem with the bare local-disk provider, which the Worker has no disk for',
    status: 'open',
    tracking: CF_NOTE,
  }],
])

/**
 * Whether the CF composition mounts this package's rows unchanged.
 * @param {string} name Package name of a composition row.
 * @returns {boolean}
 */
export function cfMountsRow(name) {
  return !CF_ROW_DISPOSITIONS.has(name)
}

/**
 * One-line description of a disposition, for the gate 0 report and build diagnostics.
 * @param {string} name Package name carrying the disposition.
 * @returns {string}
 */
export function describeDisposition(name) {
  const disposition = CF_ROW_DISPOSITIONS.get(name)
  if (disposition === undefined) throw new Error(`composition: ${name} has no CF disposition`)
  if (disposition.kind === 'gap') return `GAP (${disposition.capability}, ${disposition.status}) — ${disposition.reason}`
  if (disposition.kind === 'not-applicable') return `not applicable — ${disposition.reason}`
  return `replaced — ${disposition.reason}`
}
