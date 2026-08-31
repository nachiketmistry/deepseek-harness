// Gate 0 runtime probe: bundle every CF-target package row as its own
// workerd module so tests/workerd/gate0-eval.workerd.ts can evaluate each
// one in isolation and report which top-level module evaluations fail.
import * as esbuild from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, workspaceResolver } from './workspace-resolver.mjs'
import { cfMountsRow, compositionPackages } from './composition.mjs'

const OUT = fileURLToPath(new URL('../dist/probe', import.meta.url))
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
// vitest-pool-workers' module fallback resolves the nearest package.json of an imported built file.
writeFileSync(join(OUT, '..', 'package.json'), '{ "type": "module" }\n')
const names = compositionPackages().filter(cfMountsRow)
const entries = names.map((name, i) => ({ name, file: `m${i}` }))
await esbuild.build({
  entryPoints: entries.map(({ name, file }) => ({ in: name, out: file })),
  outdir: OUT,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import', 'default'],
  external: ['node:*', 'cloudflare:*'],
  loader: { '.sql': 'text', '.node': 'empty', '.css': 'text' },
  logLevel: 'warning',
  absWorkingDir: ROOT,
  plugins: [workspaceResolver(), {
    // Entry points are bare package names; esbuild needs a resolveDir for them.
    name: 'entry-resolve-dir',
    setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\//, namespace: 'file' }, (args) => {
        if (args.kind !== 'entry-point') return undefined
        return build.resolve(args.path, { kind: 'import-statement', resolveDir: ROOT })
      })
    },
  }],
})
writeFileSync(join(OUT, 'index.js'), [
  '/** package name -> lazy import of its isolated workerd bundle. */',
  'export const probes = {',
  ...entries.map(({ name, file }) => `  ${JSON.stringify(name)}: () => import('./${file}.js'),`),
  '}',
  '',
].join('\n'))
writeFileSync(join(OUT, 'index.d.ts'), '/** package name -> lazy import of its isolated workerd bundle. */\nexport declare const probes: Record<string, () => Promise<unknown>>\n')
console.log(`probe: ${entries.length} bundles in ${OUT}`)
