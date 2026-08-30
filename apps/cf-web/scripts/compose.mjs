// Compose the CF host composition at build time: the web composition's two
// patch layers through the harness's own composer, then the CF transform —
// apply each row's disposition (composition.mjs), restate every `!!js` config
// as a literal — into a rows JSON the Worker boots with `bootEntries`. Same
// treatment for the shipped agent presets. A row with no disposition, a `!!js`
// expression the build cannot evaluate, or a preset row whose disposition does
// not say what a preset should do all fail the build.
//
// Every dropped row is recorded in a ledger rather than vanishing: parity.mjs
// projects it into composition-parity.md, so a lost capability is a visible
// diff instead of something noticed by poking at the deployment.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { ROOT, workspacePackages, readPackage } from './workspace-resolver.mjs'
import { CF_ROW_DISPOSITIONS, CF_SKIPPED_PRESETS } from './composition.mjs'

const packages = workspacePackages()
const appBoot = await import(join(packages.get('@deepseek-ai/dsh-app-boot'), 'lib/index.js'))
const include = await import(join(packages.get('@deepseek-ai/cordis-plugin-include'), 'lib/index.js'))

/** The deployment values the CF composition is parameterized by. */
export function deploymentOf(env = process.env) {
  const publicHost = env.DSH_CF_PUBLIC_HOST ?? 'dsh-cf-web.shytiger.workers.dev'
  return {
    publicHost,
    publicUrl: env.DSH_CF_PUBLIC_URL ?? `https://${publicHost}`,
    workspaceRoot: '/workspace',
  }
}

/** Literal configs for rows whose web values are `!!js` expressions or Node-specific. */
function overrides(deployment) {
  return new Map([
    ['sandbox-policy', { mode: 'workspace-write', workspaceRoot: deployment.workspaceRoot }],
    ['approval', { policy: 'ask' }],
    ['tools', {}],
    // The Node web runtime's bind-derived trust list becomes the deployment's public host; the
    // row no longer waits for the `webRuntime` service that derived it.
    // The Worker verifies the identity service's token before it addresses this
    // object, and nothing can reach the object by another path, so the Host
    // authenticates nothing of its own. Its Host and Origin fence still runs.
    ['connection', {
      trustedHosts: [deployment.publicHost],
      browserAuth: 'edge',
    }],
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

/**
 * Apply the CF transform to one entry list (recursing into groups).
 * @param {object[]} rows Entry rows of one plane.
 * @param {object} deployment The deployment the rows are composed for.
 * @param {{ plane: string, override: Map<string, object>, ledger: object[] }} context
 *   `plane` is `'host'` or `'preset:<id>'` and labels every ledger record; `override` replaces a
 *   row's config by row id; `ledger` collects one record per row the transform did not keep.
 * @returns {object[]} The transformed rows.
 */
function transform(rows, deployment, context) {
  const { plane, override, ledger } = context
  const out = []
  for (const row of rows) {
    if (row.group && Array.isArray(row.config)) {
      out.push({ ...row, config: transform(row.config, deployment, context) })
      continue
    }
    const disposition = row.name === undefined ? undefined : CF_ROW_DISPOSITIONS.get(row.name)
    if (disposition !== undefined) {
      out.push(...structuredClone(substitutes(row.name, disposition, deployment, plane)))
      ledger.push({ plane, name: row.name, id: row.id, kind: disposition.kind })
      continue
    }
    const next = { ...row }
    if (override.has(row.id)) next.config = structuredClone(override.get(row.id))
    if (row.id === 'connection') delete next.inject
    out.push(next)
  }
  return out.map((row, i) => literalize(row, row.id ?? `row#${i}`))
}

/**
 * The rows that stand in for one disposed row on `plane`, empty when the capability is
 * dropped or the substitute is mounted by the Worker entry instead of by a row.
 * @param {string} name Package name of the disposed row.
 * @param {object} disposition Its entry in `CF_ROW_DISPOSITIONS`.
 * @param {object} deployment The deployment the rows are composed for.
 * @param {string} plane `'host'` or `'preset:<id>'`.
 * @returns {object[]}
 */
function substitutes(name, disposition, deployment, plane) {
  if (disposition.kind !== 'replaced') return []
  if (plane === 'host') return disposition.by(deployment)
  // A host-plane replacement is not automatically right inside a preset: a preset mounting the
  // same package may want the CF provider or may want nothing, and mounting a second copy of a
  // singleton provider throws at boot. The author decides once, in the disposition.
  if (disposition.presets === undefined) {
    throw new Error(`compose: ${plane} mounts ${name}, whose disposition replaces it on the host plane but does not say what a preset row should do; add \`presets: 'replace' | 'drop'\` in composition.mjs`)
  }
  return disposition.presets === 'replace' ? disposition.by(deployment) : []
}

/**
 * The web composition's entry rows, before the CF transform: the baseline every parity
 * comparison is made against.
 * @returns {object[]}
 */
export function webEntries() {
  const layers = ['packages/bundle/base/cordis.patch.yml', 'packages/bundle/web-app/cordis.patch.yml']
    .map(file => appBoot.loadOverlayPatches('cf-web', join(ROOT, file)))
  return appBoot.composeEntries(layers, message => { throw new Error(`compose: ${message}`) })
}

/**
 * The host composition rows and the ledger of what the CF transform removed from them.
 * @param {object} deployment The deployment the rows are composed for.
 * @returns {{ rows: object[], ledger: object[] }}
 */
export function hostComposition(deployment) {
  const composed = webEntries()
  const ledger = []
  const rows = transform(composed, deployment, { plane: 'host', override: overrides(deployment), ledger })
  return { rows, ledger }
}

/** The host composition rows. */
export function hostRows(deployment) {
  return hostComposition(deployment).rows
}

/**
 * The shipped presets, composed into literal rows: each preset directory that carries an agent
 * composition either ships or is declared in `CF_SKIPPED_PRESETS`.
 * @param {object} deployment The deployment the rows are composed for.
 * @returns {{ table: Record<string, object>, skipped: string[], ledger: object[] }}
 */
export function presetComposition(deployment) {
  // The shipped set is the filesystem source's own bundled root; the launcher
  // no longer patches a directory beside the app.
  const root = join(ROOT, 'packages/preset/agent-presets-filesystem/presets')
  const table = {}
  const skipped = []
  const ledger = []
  for (const id of readdirSync(root).sort()) {
    const dir = join(root, id)
    if (!existsSync(join(dir, 'agent.cordis.yml'))) continue
    if (CF_SKIPPED_PRESETS.has(id)) {
      skipped.push(id)
      continue
    }
    const meta = yaml.load(readFileSync(join(dir, 'preset.yml'), 'utf8')) ?? {}
    const source = readFileSync(join(dir, 'agent.cordis.yml'), 'utf8')
    const rows = yaml.load(source, { schema: include.entryListSchema }) ?? []
    table[id] = {
      ...(meta.name === undefined ? {} : { name: meta.name }),
      ...(meta.description === undefined ? {} : { description: meta.description }),
      ...(meta.order === undefined ? {} : { order: meta.order }),
      rows: transform(rows, deployment, { plane: `preset:${id}`, override: new Map(), ledger }),
      source,
    }
  }
  return { table, skipped, ledger }
}

/** The shipped presets that run on CF, composed into literal rows. */
export function presetTable(deployment) {
  return presetComposition(deployment).table
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
    const { platform: _platform, ...declaration } = decl
    out.set(root, {
      declaration: { ...declaration, external: declaration.external ?? [], immediately: declaration.immediately === true },
      path: join(dir, rel),
    })
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
