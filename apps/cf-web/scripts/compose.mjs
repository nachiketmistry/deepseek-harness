// Compose the CF host composition at build time: the web composition's two
// patch layers through the harness's own composer, then the CF transform —
// drop the Node providers the CF packages replace, mount the CF providers in
// their place, restate every `!!js` config as a literal — into a rows JSON
// the Worker boots with `bootEntries`. Same treatment for the shipped agent
// presets. Anything still carrying a `!!js` expression fails the build.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { ROOT, workspacePackages, readPackage } from './workspace-resolver.mjs'
import { CF_EXCLUDED_ROWS } from './composition.mjs'

const packages = workspacePackages()
const appBoot = await import(join(packages.get('@deepseek-ai/dsh-app-boot'), 'lib/index.js'))
const include = await import(join(packages.get('@deepseek-ai/cordis-plugin-include'), 'lib/index.js'))

/** The deployment values the CF composition is parameterized by. */
export function deploymentOf(env = process.env) {
  const publicHost = env.DSH_CF_PUBLIC_HOST ?? 'dsh-cf-web.shytiger.workers.dev'
  return { publicHost, publicUrl: `https://${publicHost}`, workspaceRoot: '/workspace' }
}

/** Provider rows replacing excluded rows, keyed by the excluded package name. */
function replacements(deployment) {
  return new Map([
    ['@deepseek-ai/dsh-settings-file', [{ id: 'settings-do', name: '@deepseek-ai/dsh-settings-do' }]],
    ['@deepseek-ai/dsh-credentials-local', [{ id: 'credentials-secrets', name: '@deepseek-ai/dsh-credentials-secrets' }]],
    ['@deepseek-ai/dsh-session-persistence-jsonl', [{ id: 'session-persistence-do', name: '@deepseek-ai/dsh-session-persistence-do' }]],
    ['@deepseek-ai/dsh-attachment-local', [{ id: 'attachment-r2', name: '@deepseek-ai/dsh-attachment-r2' }]],
    ['@deepseek-ai/dsh-subprocess-local', [
      { id: 'cf-sandbox', name: '@deepseek-ai/dsh-cf-sandbox', config: { workspaceRoot: deployment.workspaceRoot, gitTokenSecret: 'GH_TOKEN' } },
      { id: 'subprocess-cf-sandbox', name: '@deepseek-ai/dsh-subprocess-cf-sandbox' },
    ]],
    ['@deepseek-ai/dsh-sandbox-local', [{ id: 'sandbox-passthrough', name: '@deepseek-ai/dsh-sandbox-passthrough' }]],
    ['@deepseek-ai/dsh-spill-local', [{ id: 'spill-r2', name: '@deepseek-ai/dsh-spill-r2' }]],
    ['@deepseek-ai/dsh-fs-sandbox', [{ id: 'fs-cf-sandbox', name: '@deepseek-ai/dsh-fs-cf-sandbox' }]],
    ['@deepseek-ai/dsh-storage-json', [{ id: 'storage-do', name: '@deepseek-ai/dsh-storage-do' }]],
    // The auto picker mounts a backend and its client surface as a pair; the CF
    // backend is the container browser, so the browse surface is the client half.
    ['@deepseek-ai/dsh-host-directory-picker-auto', [
      { id: 'directory-picker-cf', name: '@deepseek-ai/dsh-directory-picker-cf' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ]],
    ['@deepseek-ai/dsh-web-app', [{ id: 'web-cf', name: '@deepseek-ai/dsh-web-cf', config: { publicUrl: deployment.publicUrl } }]],
  ])
}

/** Literal configs for rows whose web values are `!!js` expressions or Node-specific. */
function overrides(deployment) {
  return new Map([
    ['sandbox-policy', { mode: 'workspace-write', workspaceRoot: deployment.workspaceRoot }],
    ['approval', { policy: 'ask' }],
    ['tools', {}],
    // The Node web runtime's bind-derived trust list becomes the deployment's public host; the
    // row no longer waits for the `webRuntime` service that derived it.
    ['connection', { trustedHosts: [deployment.publicHost], privilegedHosts: [deployment.publicHost] }],
    ['storage-domain', { backend: 'do' }],
    ['api-gateway', { nativeOpen: false, cwd: deployment.workspaceRoot, home: deployment.workspaceRoot }],
  ])
}

/** Build-time values for the `!!js` expressions the shipped files carry. */
const KNOWN_EXPRESSIONS = new Map([
  ["process.platform === 'win32'", false],
  ["process.platform !== 'win32'", true],
])

function literalize(value, where) {
  if (Array.isArray(value)) return value.map((item, i) => literalize(item, `${where}[${i}]`))
  if (value !== null && typeof value === 'object') {
    if ('__jsExpr' in value && Object.keys(value).length === 1) {
      const expr = value.__jsExpr
      if (!KNOWN_EXPRESSIONS.has(expr)) throw new Error(`compose: ${where} carries a !!js expression the CF build cannot evaluate: ${expr}`)
      return KNOWN_EXPRESSIONS.get(expr)
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, literalize(v, `${where}.${k}`)]))
  }
  return value
}

/** Apply the CF transform to one entry list (recursing into groups). */
function transform(rows, deployment, { replace, override }) {
  const out = []
  for (const row of rows) {
    if (row.group && Array.isArray(row.config)) {
      out.push({ ...row, config: transform(row.config, deployment, { replace, override }) })
      continue
    }
    if (row.name !== undefined && CF_EXCLUDED_ROWS.has(row.name)) {
      for (const replacement of replace.get(row.name) ?? []) out.push(structuredClone(replacement))
      continue
    }
    const next = { ...row }
    if (override.has(row.id)) next.config = structuredClone(override.get(row.id))
    if (row.id === 'connection') delete next.inject
    out.push(next)
  }
  return out.map((row, i) => literalize(row, row.id ?? `row#${i}`))
}

/** The host composition rows. */
export function hostRows(deployment) {
  const layers = ['packages/bundle/base/cordis.patch.yml', 'packages/bundle/web-app/cordis.patch.yml']
    .map(file => appBoot.loadOverlayPatches('cf-web', join(ROOT, file)))
  const rows = appBoot.composeEntries(layers, message => { throw new Error(`compose: ${message}`) })
  return transform(rows, deployment, { replace: replacements(deployment), override: overrides(deployment) })
}

/** The shipped presets that run on CF, composed into literal rows. */
export function presetTable(deployment) {
  const root = join(ROOT, 'apps/cli/config/agent-presets')
  const table = {}
  for (const id of readdirSync(root).sort()) {
    const dir = join(root, id)
    if (!existsSync(join(dir, 'agent.cordis.yml'))) continue
    // cordis mounts cordis-host-runner (node:vm); minimal shadows the filesystem with the bare local disk provider.
    if (id === 'cordis' || id === 'minimal') continue
    const meta = yaml.load(readFileSync(join(dir, 'preset.yml'), 'utf8')) ?? {}
    const source = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
    const rows = yaml.load(source, { schema: include.entryListSchema }) ?? []
    table[id] = {
      ...(meta.name === undefined ? {} : { name: meta.name }),
      ...(meta.description === undefined ? {} : { description: meta.description }),
      ...(meta.order === undefined ? {} : { order: meta.order }),
      rows: transform(rows, deployment, { replace: new Map(), override: new Map() }),
      source,
    }
  }
  return table
}

/** Every package name a composition (host rows plus preset rows) mounts. */
export function packageNames(rows) {
  const names = new Set()
  const walk = (list) => {
    for (const row of list) {
      if (typeof row.name === 'string' && row.name.startsWith('@deepseek-ai/')) names.add(row.name)
      if (row.group && Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(rows)
  return names
}

/** Web client packages among `names`: their `dsh.client` declaration and built client bundle path. */
export function clientBundles(names) {
  const out = new Map()
  for (const name of names) {
    const root = /^(@deepseek-ai\/[^/]+)/.exec(name)[1]
    const dir = packages.get(root)
    if (dir === undefined) continue
    const pkg = readPackage(dir)
    const decl = pkg.dsh?.client
    if (decl?.platform !== 'web') continue
    const client = pkg.exports?.['./client']
    const rel = typeof client === 'string' ? client : client?.default
    if (typeof rel !== 'string') throw new Error(`compose: ${root} declares dsh.client but exports no ./client bundle`)
    const { platform: _platform, ...description } = decl
    out.set(root, { description: { ...description, external: description.external ?? [], immediately: description.immediately === true }, path: join(dir, rel) })
  }
  return out
}

/** Packages among `names` exporting a host-face typert artifact (`./typert`). */
export function typertArtifacts(names) {
  const out = []
  for (const name of names) {
    const root = /^(@deepseek-ai\/[^/]+)/.exec(name)[1]
    const dir = packages.get(root)
    if (dir === undefined) continue
    if (readPackage(dir).exports?.['./typert'] !== undefined) out.push(root)
  }
  return [...new Set(out)].sort()
}
