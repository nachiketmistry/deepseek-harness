/**
 * @deepseek-ai/dsh-storage-do — Durable Object SQLite storage backend for the
 * storage hub. Registers as backend `do`; every unit's records share one
 * table keyed by `(unit, tbl, key)`, a units table stamps each unit's format
 * version, and a globals table holds each unit's singleton slot.
 * @module @deepseek-ai/dsh-storage-do
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cf-bindings'
import type { CfSqlStorage } from '@deepseek-ai/dsh-cf-bindings'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { DoKvUnit, type StorageTables } from './unit.ts'

export type { StorageTables } from './unit.ts'

/** Cordis plugin name. */
export const name = 'storage-do'
/** The hub and the platform handle must exist before the backend can register. */
export const inject = ['storage', 'cf']

/** Allowed table prefix: a bare SQL identifier segment that needs no quoting. */
export const TABLE_PREFIX_RE = /^[a-z][a-z0-9_]*$/

/** Plugin configuration. */
export interface Config {
  /** Identifier prefix of the owned tables (`<prefix>_units`, `<prefix>_records`, `<prefix>_globals`). */
  tablePrefix: string
}

/** Config schema. */
export const Config: z<Config> = z.object({
  tablePrefix: z.string().default('storage'),
})

/** Durable Object backend: owns the tables and serves the `kv` facet. */
export class DoStorageBackend implements StorageBackend {
  private readonly open = new Map<string, KvUnit>()
  private readonly tables: StorageTables
  private closed = false

  /**
   * Create the tables when absent.
   * @param sql - the hosting Durable Object's SQLite handle.
   * @param tablePrefix - identifier prefix for the owned tables.
   */
  constructor(private readonly sql: CfSqlStorage, tablePrefix: string) {
    if (!TABLE_PREFIX_RE.test(tablePrefix)) {
      throw new Error(`storage-do: tablePrefix "${tablePrefix}" must match ${String(TABLE_PREFIX_RE)}`)
    }
    this.tables = {
      units: `${tablePrefix}_units`,
      records: `${tablePrefix}_records`,
      globals: `${tablePrefix}_globals`,
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS ${this.tables.units} (
      unit TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS ${this.tables.records} (
      unit TEXT NOT NULL,
      tbl TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (unit, tbl, key)
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS ${this.tables.globals} (
      unit TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`)
  }

  readonly kv: KvFacet = {
    open: (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (this.closed) throw new StorageError('closed', 'do backend is closed')
      validateDescriptor(descriptor)
      if (this.open.has(descriptor.name)) {
        // Double-open is a caller bug, not a medium condition.
        throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
      }
      const unit = new DoKvUnit(this.sql, this.tables, descriptor, () => this.open.delete(descriptor.name))
      this.open.set(descriptor.name, unit)
      return Promise.resolve(unit)
    },
  }

  async close(): Promise<void> {
    this.closed = true
    for (const unit of [...this.open.values()]) {
      await unit.close()
    }
  }
}

function validateDescriptor(descriptor: KvUnitDescriptor): void {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new StorageError('malformed-medium', `invalid table name '${table}' in unit '${descriptor.name}'`)
    }
  }
}

/**
 * Register the `do` backend on the storage hub.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config) {
  const backend = new DoStorageBackend(ctx.cf.storage.sql, config.tablePrefix)
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('do', backend)
    return async () => {
      unregister()
      await backend.close()
    }
  })
  ctx.provide(storageBackendServiceKey('do'), backend)
}
