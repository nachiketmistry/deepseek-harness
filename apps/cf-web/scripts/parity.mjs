// Composition parity: what the Cloudflare deployment runs, measured against the
// web composition it is assembled from, written to composition-parity.md.
//
// The report is a projection of the dispositions in composition.mjs and of the
// ledger the CF transform records while composing (compose.mjs) — the same code
// paths the deployed bundle is built from, not a description of them. A row that
// leaves the product therefore shows up here as a diff, which is what the first
// round of gaps (skills, Code Mode, workflow) did not do.
//
// The generator also fails on a stale claim: a disposition for a row the web
// composition no longer has, a gap naming an orphan that is no longer mounted, a
// skipped preset that no longer exists, or a replacement the composition or the
// Worker entry does not actually mount.
//
// "Mounted" and "implemented" are separate claims, so each substitute is scanned
// for reduced operations (fidelity.mjs) and reconciled against what its
// disposition declares: a provider that stands in for a row without doing its
// work fails the gate until the report says what was lost.
//
// Run: pnpm --filter @deepseek-ai/dsh-cf-web run parity
//      pnpm --filter @deepseek-ai/dsh-cf-web run parity:check   (CI: fails when stale)
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, workspacePackages } from './workspace-resolver.mjs'
import { CF_ROW_DISPOSITIONS, CF_SKIPPED_PRESETS, compositionPackages } from './composition.mjs'
import { deploymentOf, hostComposition, packageNames, presetComposition, webEntries } from './compose.mjs'
import { reconcile, scanProvider } from './fidelity.mjs'

const REPORT = join(ROOT, 'apps/cf-web/composition-parity.md')

/** Every row of an entry list that names a package, groups flattened. */
function namedRows(rows) {
  const out = []
  const walk = (list) => {
    for (const row of list) {
      if (row.group && Array.isArray(row.config)) walk(row.config)
      else if (typeof row.name === 'string') out.push(row)
    }
  }
  walk(rows)
  return out
}

const deployment = deploymentOf()
const web = webEntries()
const host = hostComposition(deployment)
const presets = presetComposition(deployment)
const cfPackages = packageNames([...host.rows, ...Object.values(presets.table).flatMap(p => p.rows)])
const webPackages = new Set(compositionPackages())
const workerEntry = readFileSync(join(ROOT, 'apps/cf-web/src/worker.ts'), 'utf8')
const workspace = workspacePackages()

const problems = []

// Stale dispositions: a row the web composition no longer carries.
for (const name of CF_ROW_DISPOSITIONS.keys()) {
  if (!webPackages.has(name)) problems.push(`disposition for \`${name}\`, which the web composition no longer mounts`)
}

// Stale replacements: the substitute must be mounted, as a row or by the Worker entry.
for (const [name, disposition] of CF_ROW_DISPOSITIONS) {
  if (disposition.kind !== 'replaced') continue
  for (const row of disposition.by(deployment)) {
    if (!cfPackages.has(row.name)) problems.push(`\`${name}\` is declared replaced by \`${row.name}\`, which the CF composition does not mount`)
  }
  if (disposition.entry !== undefined && !workerEntry.includes(disposition.entry)) {
    problems.push(`\`${name}\` is declared replaced by \`${disposition.entry}\` in the Worker entry, which src/worker.ts does not import`)
  }
  if (disposition.by(deployment).length === 0 && disposition.entry === undefined) {
    problems.push(`\`${name}\` is declared replaced but names no substitute; a row that is simply dropped is a gap`)
  }
}

// Stale orphan claims: a gap's dependents must still be mounted, or the gap costs less than it says.
for (const [name, disposition] of CF_ROW_DISPOSITIONS) {
  if (disposition.kind !== 'gap') continue
  for (const orphan of disposition.orphans) {
    if (!cfPackages.has(orphan)) problems.push(`the \`${name}\` gap names \`${orphan}\` as still mounted, but the CF composition does not mount it`)
  }
}

// Stale preset skips: the preset directory must still exist and still be an agent composition.
const presetRoot = join(ROOT, 'apps/cli/config/agent-presets')
for (const id of CF_SKIPPED_PRESETS.keys()) {
  try {
    readFileSync(join(presetRoot, id, 'agent.cordis.yml'), 'utf8')
  } catch {
    problems.push(`preset \`${id}\` is declared skipped, but apps/cli/config/agent-presets/${id}/agent.cordis.yml does not exist`)
  }
}

// Provider fidelity: every substitute a replacement names, scanned and reconciled
// against the reductions its disposition declares.
const fidelity = []
for (const [name, disposition] of CF_ROW_DISPOSITIONS) {
  if (disposition.kind !== 'replaced') continue
  const substitutes = [...disposition.by(deployment).map(row => row.name), ...(disposition.entry === undefined ? [] : [disposition.entry])]
  for (const substitute of substitutes) {
    const dir = workspace.get(substitute)
    if (dir === undefined) {
      problems.push(`\`${name}\` names \`${substitute}\` as its substitute, which is not a workspace package`)
      continue
    }
    const scan = scanProvider(dir)
    const declared = disposition.reduced?.[substitute] ?? []
    problems.push(...reconcile(substitute, scan, declared))
    fidelity.push({ replaces: name, substitute, scan, declared, degraded: disposition.degraded?.[substitute] })
  }
}
for (const [name, disposition] of CF_ROW_DISPOSITIONS) {
  if (disposition.kind !== 'replaced') continue
  const substitutes = new Set([...disposition.by(deployment).map(row => row.name), ...(disposition.entry === undefined ? [] : [disposition.entry])])
  for (const declared of [...Object.keys(disposition.reduced ?? {}), ...Object.keys(disposition.degraded ?? {})]) {
    if (!substitutes.has(declared)) problems.push(`\`${name}\` declares reductions for \`${declared}\`, which is not one of its substitutes`)
  }
}

if (problems.length > 0) {
  console.error('parity: the CF dispositions no longer describe the composition:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

/** Gap rows and skipped presets grouped by the capability they belong to. */
function capabilities() {
  const table = new Map()
  const bucket = (capability) => {
    if (!table.has(capability)) table.set(capability, { rows: [], presets: [], statuses: new Set(), tracking: new Set() })
    return table.get(capability)
  }
  for (const [name, disposition] of CF_ROW_DISPOSITIONS) {
    if (disposition.kind !== 'gap') continue
    const entry = bucket(disposition.capability)
    entry.rows.push({ name, ...disposition })
    entry.statuses.add(disposition.status)
    entry.tracking.add(disposition.tracking)
  }
  for (const [id, skip] of CF_SKIPPED_PRESETS) {
    const entry = bucket(skip.capability)
    entry.presets.push({ id, ...skip })
    entry.statuses.add(skip.status)
    entry.tracking.add(skip.tracking)
  }
  return table
}

const gaps = capabilities()
const openGaps = [...gaps].filter(([, entry]) => entry.statuses.has('open'))
const webNamed = namedRows(web)
const hostNamed = namedRows(host.rows)
const droppedOnHost = host.ledger.filter(record => record.kind !== 'replaced')
const link = path => `[\`${path.split('/').pop()}\`](${'../../' + path})`

const lines = [
  '# Composition parity — Cloudflare against the web app',
  '',
  'Generated by `scripts/parity.mjs` from the dispositions in `scripts/composition.mjs` and the ledger `scripts/compose.mjs` records while composing the deployed bundle. Regenerate with `pnpm --filter @deepseek-ai/dsh-cf-web run parity`; `parity:check` fails when this file is out of date.',
  '',
  'What it shows: every row of the web composition the Cloudflare build does not mount, whether a `packages/cf/*` provider takes its place, and which capabilities the deployment therefore does not have. What it does not show: whether a mounted provider works — that is what the workerd gate (`gate0-imports.md`) and the deployment tests cover.',
  '',
  '## Summary',
  '',
  '| | web app | Cloudflare |',
  '|---|---|---|',
  `| composition rows naming a package | ${webNamed.length} | ${hostNamed.length} |`,
  `| distinct packages (host rows and presets) | ${webPackages.size} | ${cfPackages.size} |`,
  `| agent presets | ${Object.keys(presets.table).length + presets.skipped.length} | ${Object.keys(presets.table).length} |`,
  '',
  `${[...gaps.keys()].length} capability gaps, ${openGaps.length} of them open. ${host.ledger.filter(r => r.kind === 'replaced').length} host rows are replaced by a Cloudflare provider and ${host.ledger.filter(r => r.kind === 'not-applicable').length} do not apply to this deployment. Of the ${fidelity.length} substitute providers, ${fidelity.filter(entry => entry.scan.tests === 0).length} have no test suite and ${fidelity.filter(entry => entry.declared.length > 0 || entry.degraded !== undefined).length} are not like-for-like stand-ins.`,
  '',
  '## Capability gaps',
  '',
  'A gap is a capability the web app has and this deployment does not. `still mounted` names rows that remain in the composition and depend on the missing one: each is a surface the user or the model can still reach, which does nothing.',
  '',
  '| capability | status | missing | still mounted | what the deployment loses | tracking |',
  '|---|---|---|---|---|---|',
]

for (const [capability, entry] of gaps) {
  const status = entry.statuses.has('open') ? 'open' : 'out of scope'
  const missing = [
    ...entry.rows.map(row => `\`${row.name.replace('@deepseek-ai/', '')}\``),
    ...entry.presets.map(preset => `preset \`${preset.id}\``),
  ].join('<br>')
  const orphans = [...new Set(entry.rows.flatMap(row => row.orphans))]
    .map(name => `\`${name.replace('@deepseek-ai/', '')}\``).join('<br>') || '—'
  const impact = [...new Set([...entry.rows.map(row => row.impact), ...entry.presets.map(preset => `The \`${preset.id}\` preset cannot ship: it ${preset.reason}.`)])].join(' ')
  const tracking = [...entry.tracking].map(link).join('<br>')
  lines.push(`| **${capability}** | ${status} | ${missing} | ${orphans} | ${impact} | ${tracking} |`)
}

lines.push(
  '',
  '## Provider fidelity',
  '',
  'A replacement claims a Cloudflare provider stands in for a Node one. This section is the second claim: that the provider does the work. `reduced` operations are found by scanning the provider\'s source for a method body that is one unconditional `throw`, an empty body, or a single `return` of an absent value, and each must be declared in `scripts/composition.mjs` — an undeclared one fails this generator. `degraded` is a platform limit no scan can see and is declared, not derived; read it as a claim under review, not a verified one.',
  '',
  `\`tests\` counts the provider's own spec files. ${fidelity.filter(entry => entry.scan.tests === 0).length} of ${fidelity.length} substitutes have none, and \`pnpm run test:coverage\` — per-file 100% over \`packages/*/*/src\`, with no exemption for \`packages/cf\` — rejects every one of their source files today. Until those suites exist, "replaced" in the table above means mounted and bundled, not exercised.`,
  '',
  '| provider | replaces | tests | reduced or degraded |',
  '|---|---|---|---|',
)

for (const entry of fidelity) {
  const notes = [
    ...entry.declared.map(reduction => `\`${reduction.member}\` — ${reduction.cost}`),
    ...(entry.degraded === undefined ? [] : [`declared: ${entry.degraded}`]),
  ].join('<br><br>') || '—'
  lines.push(`| \`${entry.substitute.replace('@deepseek-ai/', '')}\` | \`${entry.replaces.replace('@deepseek-ai/', '')}\` | ${entry.scan.tests === 0 ? '**none**' : entry.scan.tests} | ${notes} |`)
}

lines.push(
  '',
  '## Host plane, row by row',
  '',
  'Every web composition row the Cloudflare build does not mount as written.',
  '',
  '| row | disposition | detail |',
  '|---|---|---|',
)

for (const record of host.ledger) {
  const disposition = CF_ROW_DISPOSITIONS.get(record.name)
  const detail = disposition.kind === 'replaced'
    ? `${disposition.reason} → ${[...disposition.by(deployment).map(row => `\`${row.name.replace('@deepseek-ai/', '')}\``), ...(disposition.entry === undefined ? [] : [`\`${disposition.entry.replace('@deepseek-ai/', '')}\` (Worker entry)`])].join(', ')}`
    : disposition.reason
  const kind = disposition.kind === 'gap' ? `**gap** (${disposition.capability})` : disposition.kind === 'replaced' ? 'replaced' : 'not applicable'
  lines.push(`| \`${record.name.replace('@deepseek-ai/', '')}\` | ${kind} | ${detail} |`)
}

lines.push(
  '',
  '## Agent presets',
  '',
  'Preset rows are composed per preset, so a row dropped here is a tool or capability that preset\'s agent does not get. A preset that mounts a row replaced on the host plane must say so in its disposition; the build fails otherwise.',
  '',
  '| preset | rows on web | rows on Cloudflare | dropped |',
  '|---|---|---|---|',
)

for (const [id, preset] of Object.entries(presets.table)) {
  const dropped = presets.ledger.filter(record => record.plane === `preset:${id}`)
  const mounted = namedRows(preset.rows).length
  lines.push(`| \`${id}\` | ${mounted + dropped.length} | ${mounted} | ${dropped.map(record => `\`${record.name.replace('@deepseek-ai/', '')}\` (${record.kind === 'gap' ? '**gap**' : 'n/a'})`).join('<br>') || '—'} |`)
}

for (const id of presets.skipped) {
  const skip = CF_SKIPPED_PRESETS.get(id)
  lines.push(`| \`${id}\` | — | **not shipped** | ${skip.reason} |`)
}

lines.push('')

const report = lines.join('\n')
if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(REPORT, 'utf8')
  } catch {
    // Absent report: reported as stale below, same as a differing one.
  }
  if (current !== report) {
    console.error('parity: composition-parity.md is out of date; run `pnpm --filter @deepseek-ai/dsh-cf-web run parity`')
    process.exit(1)
  }
  console.log('parity: composition-parity.md is up to date')
} else {
  writeFileSync(REPORT, report)
  console.log(`parity: ${gaps.size} capability gaps (${openGaps.length} open), ${host.ledger.length} host rows disposed, ${presets.ledger.length} preset rows disposed`)
}
