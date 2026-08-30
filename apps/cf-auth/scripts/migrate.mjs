// Apply `migrations/0001-init.sql` to the database named by DATABASE_URL, in
// one transaction. Separate from generation on purpose: the SQL is reviewed and
// committed first, then applied, so nothing reaches the database unread.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'

const connectionString = process.env.DATABASE_URL
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error('migrate: DATABASE_URL must be the direct Neon connection string')
}

const file = join(import.meta.dirname, '..', 'migrations', '0001-init.sql')
const sql = readFileSync(file, 'utf8')
const client = new Client({ connectionString })
await client.connect()
try {
  await client.query('begin')
  await client.query(sql)
  await client.query('commit')
  console.log(`applied ${file}`)
} catch (error) {
  await client.query('rollback')
  throw error
} finally {
  await client.end()
}
