// Run the auth service locally on workerd, against a throwaway Neon branch.
//
// Two things `wrangler dev` cannot read for itself. Hyperdrive has no local
// pool, so the driver needs a direct connection string, and wrangler takes it
// only from `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` in its
// own environment, not from a Worker binding. Keeping that value in `.dev.vars`
// with the rest means one gitignored file holds every local credential.
//
// Never point this at the deployment's database: Better Auth encrypts JWKS
// private keys with the signing secret, so a local secret would leave rows the
// deployment cannot decrypt. See the README.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const root = join(import.meta.dirname, '..')
const varsFile = join(root, '.dev.vars')
if (!existsSync(varsFile)) {
  throw new Error('dev: .dev.vars is missing; copy .dev.vars.example and fill it in')
}
process.loadEnvFile(varsFile)

const connectionString = process.env.DSH_CF_AUTH_DEV_DATABASE_URL
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error('dev: .dev.vars must set DSH_CF_AUTH_DEV_DATABASE_URL to a throwaway Neon branch')
}

// Names the Worker reads through a Secrets Store binding. A binding declared
// in wrangler.jsonc resolves against the LOCAL store during `wrangler dev`,
// which starts empty and is not populated by `.dev.vars`, so each value is
// mirrored into it before the server starts. `.get()` throws on a missing
// secret, so a half-seeded store fails every request rather than one route.
const SECRETS = ['BETTER_AUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']

/**
 * Read the account Secrets Store id out of wrangler.jsonc.
 *
 * Only whole-line comments are stripped, which is all this file uses; a `//`
 * inside a string, as in every URL it holds, is left alone.
 */
function secretsStoreId() {
  const source = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
  const stripped = source.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n')
  const [entry] = JSON.parse(stripped).secrets_store_secrets
  return entry.store_id
}

/** Put one value in the local store, whether or not a previous run left it there. */
function mirrorSecret(storeId, name, value) {
  const args = [storeId, '--name', name, '--value', value, '--scopes', 'workers']
  const run = action => spawnSync('wrangler', ['secrets-store', 'secret', action, ...args], {
    cwd: root, encoding: 'utf8', env: childEnv,
  })
  const created = run('create')
  if (created.status === 0) return
  const updated = run('update')
  if (updated.status === 0) return
  throw new Error(
    `dev: could not put ${name} in the local secrets store.`
    + `\ncreate: ${created.stderr ?? ''}${created.stdout ?? ''}`
    + `\nupdate: ${updated.stderr ?? ''}${updated.stdout ?? ''}`,
  )
}

const port = process.env.DSH_CF_AUTH_DEV_PORT ?? '8788'
// The workspace bin directory is added explicitly so `node scripts/dev.mjs`
// behaves the same as `pnpm run dev`, which is the only form that puts it on
// PATH. Wrangler's own bin file is not a package export, so it cannot be
// resolved directly.
const binDir = join(root, 'node_modules', '.bin')
const childEnv = {
  ...process.env,
  PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: connectionString,
}

const storeId = secretsStoreId()
for (const name of SECRETS) {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`dev: .dev.vars must set ${name}; see .dev.vars.example`)
  }
  mirrorSecret(storeId, name, value)
}

const child = spawn('wrangler', ['dev', '--port', port, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: childEnv,
})
child.on('exit', code => process.exit(code ?? 1))
