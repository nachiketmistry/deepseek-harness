// The web composition's package rows, read from the two bundle patch layers
// so this app never carries a stale copy of the roster.
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
 * Rows the CF composition does not mount, with the reason: each is either a
 * Node-only provider that a `packages/cf/*` provider replaces behind the same
 * Service Definition, or a surface outside the CF scope.
 * @type {Map<string, string>}
 */
export const CF_EXCLUDED_ROWS = new Map([
  ['@deepseek-ai/cordis-plugin-hmr', 'disabled on web already; file watching'],
  ['@deepseek-ai/dsh-web-app', 'Node glue (browser opener, LAN trust, dist resolution); replaced by the cf-web glue plugin'],
  ['@deepseek-ai/dsh-web-app/startup', 'commander flags of the CLI invocation'],
  ['@deepseek-ai/dsh-host-webserver', 'node:http listener; replaced by webserver-cf'],
  ['@deepseek-ai/dsh-host-directory-picker-auto', 'OS chooser probe; replaced by directory-picker-cf'],
  ['@deepseek-ai/dsh-code-runtime-worker-thread', 'node:worker_threads; out of scope'],
  ['@deepseek-ai/dsh-cordis-host-runner', 'node:vm; out of scope'],
  ['@deepseek-ai/dsh-workflow-worker-thread', 'node:worker_threads; out of scope'],
  ['@deepseek-ai/dsh-tool-workflow', 'consumer of the worker-thread workflow engine; out of scope'],
  ['@deepseek-ai/dsh-tool-ralph', 'consumer of the worker-thread workflow engine; out of scope'],
  ['@deepseek-ai/dsh-subprocess-local', 'node:child_process; replaced by subprocess-cf-sandbox'],
  ['@deepseek-ai/dsh-sandbox-local', 'OS sandbox launchers; replaced by sandbox-passthrough'],
  ['@deepseek-ai/dsh-fs-sandbox', 'local-disk containment provider; replaced by fs-cf-sandbox'],
  ['@deepseek-ai/dsh-pwsh-sandbox', 'Windows only'],
  ['@deepseek-ai/dsh-tool-pwsh', 'Windows only'],
  ['@deepseek-ai/dsh-session-persistence-jsonl', 'disk JSONL; replaced by persistence-do'],
  ['@deepseek-ai/dsh-session-query-sqlite', 'node:sqlite; openAt never on web already'],
  ['@deepseek-ai/dsh-storage-json', 'disk JSON; replaced by storage-do'],
  ['@deepseek-ai/dsh-settings-file', 'disk YAML + chokidar; replaced by settings-do'],
  ['@deepseek-ai/dsh-credentials-local', 'disk .env + chokidar; replaced by credentials-secrets'],
  ['@deepseek-ai/dsh-attachment-local', 'disk store; replaced by attachment-r2'],
  ['@deepseek-ai/dsh-spill-local', 'OS temp dir; replaced by spill-r2'],
  ['@deepseek-ai/dsh-skill-filesystem', 'disk walker; replaced by the skill provider over ctx.fs'],
  ['@deepseek-ai/dsh-client-hmr', 'stat-polls client bundles on disk; bundles are static on CF'],
  ['@deepseek-ai/dsh-session-telemetry-otel', 'node exporter transport; DISABLED by default and out of scope'],
  ['@deepseek-ai/dsh-llm-pi-ai', 'optional provider catalog; not in the CF composition'],
])
