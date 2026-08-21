// Build the Worker: compose the CF rows and presets, embed the browser
// roster's client bundles and the module table, stage the frontend dist as
// Workers Assets, then bundle src/worker.ts for workerd into dist/worker.js.
// Workspace packages come from their built lib/ (workspace-resolver.mjs).
import * as esbuild from 'esbuild'
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, workspaceResolver, workspacePackages } from './workspace-resolver.mjs'
import { clientBundles, deploymentOf, hostRows, packageNames, presetTable, typertArtifacts } from './compose.mjs'

const APP = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(APP, 'dist')
const GEN = join(DIST, 'generated')
rmSync(GEN, { recursive: true, force: true })
rmSync(join(DIST, 'assets'), { recursive: true, force: true })
mkdirSync(join(GEN, 'client'), { recursive: true })

const deployment = deploymentOf()
const rows = hostRows(deployment)
const presets = presetTable(deployment)
writeFileSync(join(GEN, 'composition.json'), JSON.stringify({ deployment, rows }, null, 2))
writeFileSync(join(GEN, 'presets.json'), JSON.stringify(presets, null, 2))

// Module table: every plugin specifier the host rows or a preset names.
const names = packageNames([...rows, ...Object.values(presets).flatMap(p => p.rows)])
const sorted = [...names].sort()
writeFileSync(join(GEN, 'modules.js'), [
  ...sorted.map((name, i) => `import * as m${i} from ${JSON.stringify(name)}`),
  '/** Plugin modules by specifier. */',
  'export const modules = new Map([',
  ...sorted.map((name, i) => `  [${JSON.stringify(name)}, m${i}],`),
  '])',
  '',
].join('\n'))
writeFileSync(join(GEN, 'modules.d.ts'), 'export declare const modules: ReadonlyMap<string, unknown>\n')

// Typert artifact table: every composed package's host-face type contribution.
const typert = typertArtifacts(names)
writeFileSync(join(GEN, 'typert-table.js'), [
  ...typert.map((name, i) => `import * as t${i} from ${JSON.stringify(`${name}/typert`)}`),
  '/** Typert artifact modules by package name. */',
  'export const typertTable = new Map([',
  ...typert.map((name, i) => `  [${JSON.stringify(name)}, t${i}],`),
  '])',
  '',
].join('\n'))
writeFileSync(join(GEN, 'typert-table.d.ts'), 'export declare const typertTable: ReadonlyMap<string, Record<string, unknown>>\n')

// Client bundle table: each web client package's built bundle, embedded as text.
const bundles = clientBundles(names)
const entries = [...bundles].map(([name, bundle], i) => ({ name, bundle, file: `c${i}.clientjs` }))
for (const { bundle, file } of entries) {
  cpSync(bundle.path, join(GEN, 'client', file))
  if (existsSync(`${bundle.path}.map`)) cpSync(`${bundle.path}.map`, join(GEN, 'client', `${file}.map.txt`))
}
writeFileSync(join(GEN, 'client-table.js'), [
  ...entries.map(({ file }, i) => `import c${i} from './client/${file}'`),
  ...entries.filter(({ file }) => existsSync(join(GEN, 'client', `${file}.map.txt`))).map(({ file }, i) => `import s${i} from './client/${file}.map.txt'`),
  '/** Client bundles by package name. */',
  'export const clientTable = new Map([',
  ...entries.map(({ name, bundle, file }, i) => `  [${JSON.stringify(name)}, { description: ${JSON.stringify(bundle.description)}, code: c${i}${existsSync(join(GEN, 'client', `${file}.map.txt`)) ? `, map: s${i}` : ''} }],`),
  '])',
  '',
].join('\n'))
writeFileSync(join(GEN, 'client-table.d.ts'), "import type { StaticClientBundleTable } from '@deepseek-ai/dsh-client-bundle-source-static'\nexport declare const clientTable: StaticClientBundleTable\n")

// Frontend dist as Workers Assets.
const frontend = join(workspacePackages().get('@deepseek-ai/dsh-web-frontend'), 'dist')
if (!existsSync(join(frontend, 'index.html'))) throw new Error(`build: frontend dist missing at ${frontend}; run pnpm run build`)
cpSync(frontend, join(DIST, 'assets'), { recursive: true })

const result = await esbuild.build({
  entryPoints: [join(APP, 'src/worker.ts')],
  outfile: join(DIST, 'worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import', 'default'],
  external: ['node:*', 'cloudflare:*'],
  loader: { '.sql': 'text', '.css': 'text', '.clientjs': 'text', '.txt': 'text', '.node': 'empty' },
  sourcemap: true,
  logLevel: 'warning',
  metafile: true,
  absWorkingDir: ROOT,
  plugins: [workspaceResolver()],
})
const bytes = Object.values(result.metafile.outputs).find(o => o.entryPoint)?.bytes ?? 0
console.log(`build: ${rows.length} host rows, ${Object.keys(presets).length} presets, ${sorted.length} modules, ${typert.length} typert artifacts, ${entries.length} client bundles, worker ${(bytes / 1048576).toFixed(2)} MiB`)
