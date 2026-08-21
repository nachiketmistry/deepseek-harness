// Bundle src/worker.ts for workerd into dist/worker.js. Workspace packages
// come from their built lib/ (workspace-resolver.mjs); node:* and cloudflare:*
// stay external for wrangler's nodejs_compat layer.
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { ROOT, workspaceResolver } from './workspace-resolver.mjs'

await esbuild.build({
  entryPoints: [fileURLToPath(new URL('../src/worker.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/worker.js', import.meta.url)),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'import', 'default'],
  external: ['node:*', 'cloudflare:*'],
  loader: { '.sql': 'text', '.css': 'text' },
  sourcemap: true,
  logLevel: 'warning',
  absWorkingDir: ROOT,
  plugins: [workspaceResolver()],
})
