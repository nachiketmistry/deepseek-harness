// Run the web GUI locally on workerd, against a local identity service.
//
// The deployment's wrangler.jsonc names the deployed identity service, and a
// local run must not verify against it: its tokens name a different issuer and
// its key set is not the one a local sign-in is signed with. The overrides
// below point the Worker at the service `apps/cf-auth`'s own `pnpm run dev`
// starts, so the two halves of a local sign-in agree on one issuer.
//
// Requires `pnpm run build` first: wrangler.jsonc serves the prebuilt
// dist/worker.js, which this script does not rebuild.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const root = join(import.meta.dirname, '..')
if (!existsSync(join(root, 'dist/worker.js'))) {
  throw new Error('dev: dist/worker.js is missing; run `pnpm --filter @deepseek-ai/dsh-cf-web run build` first')
}

const port = process.env.DSH_CF_WEB_DEV_PORT ?? '8790'
const identity = process.env.DSH_CF_AUTH_DEV_URL ?? 'http://localhost:8788'

// The workspace bin directory is added explicitly so `node scripts/dev.mjs`
// behaves the same as `pnpm run dev`, which is the only form that puts it on
// PATH. Wrangler's own bin file is not a package export, so it cannot be
// resolved directly.
const binDir = join(root, 'node_modules', '.bin')

const child = spawn('wrangler', [
  'dev',
  '--port', port,
  '--var', `AUTH_BASE_URL:${identity}`,
  '--var', `AUTH_JWKS_URL:${identity}/api/auth/jwks`,
  '--var', `AUTH_ISSUER:${identity}`,
  ...process.argv.slice(2),
], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
})
child.on('exit', code => process.exit(code ?? 1))
