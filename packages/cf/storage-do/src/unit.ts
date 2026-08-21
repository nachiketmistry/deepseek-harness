/**
 * One opened Durable Object KV unit. The rows are authoritative; every call
 * is one synchronous statement, so it is atomic and durable once the
 * returned promise resolves.
 * @module @deepseek-ai/dsh-storage-do/src/unit
 */

import type { CfSqlStorage } from '@deepseek-ai/dsh-cf-bindings'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'

/** The three owned table names. */
export interface StorageTables {
  readonly units: string
  readonly records: string
  readonly globals: string
}

/** A unit over the shared tables; the version stamp is written at open. */
export class DoKvUnit implements KvUnit {
  private closed = false

  /**
   * Open the unit: stamp its version when first seen, reject a foreign stamp.
   * @param sql - the hosting Durable Object's SQLite handle.
   * @param tables - the backend's owned table names.
   * @param descriptor - static identity and shape of the unit.
   * @param onClose - backend callback releasing the unit's open slot.
   */
  constructor(
    private readonly sql: CfSqlStorage,
    private readonly tables: StorageTables,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
  ) {
    const stamped = sql.exec<{ version: number }>(
      `SELECT version FROM ${tables.units} WHERE unit = ?`,
      descriptor.name,
    ).toArray()[0]
    if (stamped === undefined) {
      sql.exec(`INSERT INTO ${tables.units} (unit, version) VALUES (?, ?)`, descriptor.name, descriptor.version)
    } else if (stamped.version !== descriptor.version) {
      throw new StorageError(
        'version-mismatch',
        `unit '${descriptor.name}': stored version ${String(stamped.version)} != expected ${String(descriptor.version)}`,
      )
    }
  }

  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const table of this.descriptor.tables) tables[table] = {}
    const rows = this.sql.exec<{ tbl: string; key: string; value: string }>(
      `SELECT tbl, key, value FROM ${this.tables.records} WHERE unit = ?`,
      this.descriptor.name,
    ).toArray()
    for (const row of rows) {
      const records = tables[row.tbl]
      if (records === undefined) {
        throw new StorageError('malformed-medium', `unit '${this.descriptor.name}': stored table '${row.tbl}' is not declared`)
      }
      records[row.key] = this.parse(row.value, `${row.tbl}/${row.key}`)
    }
    const globalRow = this.sql.exec<{ value: string }>(
      `SELECT value FROM ${this.tables.globals} WHERE unit = ?`,
      this.descriptor.name,
    ).toArray()[0]
    const global = globalRow === undefined ? null : this.parse(globalRow.value, 'global')
    return Promise.resolve({ tables, global })
  }

  putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    this.assertTable(table)
    this.sql.exec(
      `INSERT INTO ${this.tables.records} (unit, tbl, key, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (unit, tbl, key) DO UPDATE SET value = excluded.value`,
      this.descriptor.name,
      table,
      key,
      JSON.stringify(value),
    )
    return Promise.resolve()
  }

  deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    this.assertTable(table)
    this.sql.exec(
      `DELETE FROM ${this.tables.records} WHERE unit = ? AND tbl = ? AND key = ?`,
      this.descriptor.name,
      table,
      key,
    )
    return Promise.resolve()
  }

  setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    this.sql.exec(
      `INSERT INTO ${this.tables.globals} (unit, value) VALUES (?, ?)
       ON CONFLICT (unit) DO UPDATE SET value = excluded.value`,
      this.descriptor.name,
      JSON.stringify(value),
    )
    return Promise.resolve()
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.onClose()
    }
    return Promise.resolve()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
    }
  }

  private assertTable(table: string): void {
    if (!this.descriptor.tables.includes(table)) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
  }

  private parse(text: string, at: string): unknown {
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new StorageError('malformed-medium', `unit '${this.descriptor.name}': ${at} is not valid JSON`, { cause: error })
    }
  }
}
