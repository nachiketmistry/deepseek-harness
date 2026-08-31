// Compile the Better Auth migration for this deployment's exact options into
// `migrations/0001-init.sql`, so the schema the service needs is a reviewable
// committed artifact rather than something a CLI applies in place.
//
// Reads DATABASE_URL (Neon direct, not Hyperdrive and not the pooler): the
// compiler inspects the live database to diff what is already there.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMigrations } from 'better-auth/db/migration'
import { authOptions } from '../src/auth.ts'

const connectionString = process.env.DATABASE_URL
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error('schema: DATABASE_URL must be the direct Neon connection string')
}

const options = authOptions({
  connectionString,
  // Schema generation never signs or redirects; these only have to be present.
  secret: 'schema-generation-only',
  baseUrl: 'https://schema.invalid',
  trustedOrigins: [],
  google: { clientId: 'schema-generation-only', clientSecret: 'schema-generation-only' },
}, {})

const { compileMigrations, toBeCreated, toBeAdded, unsafeChanges } = await getMigrations(options)
const sql = await compileMigrations()

const out = join(import.meta.dirname, '..', 'migrations', '0001-init.sql')
writeFileSync(out, sql.endsWith('\n') ? sql : `${sql}\n`, 'utf8')

console.log(`tables to create: ${toBeCreated.map(t => t.table).join(', ') || '(none)'}`)
console.log(`columns to add:   ${toBeAdded.map(t => t.table).join(', ') || '(none)'}`)
if (unsafeChanges.length > 0) console.log(`unsafe: ${unsafeChanges.join('; ')}`)
console.log(`wrote ${out} (${sql.length} bytes)`)
