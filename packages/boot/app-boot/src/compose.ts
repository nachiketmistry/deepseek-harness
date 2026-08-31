/**
 * File-free composition: mount a literal entry list on a fresh root context
 * through the vendored Loader, resolving every plugin specifier from a module
 * table instead of the filesystem. This is the boot path for a host without a
 * disk profile, such as a platform Worker whose bundle already carries every
 * plugin: rows are the same `EntryOptions` a `cordis.yml` holds, minus `!!js`
 * expressions (a table-resolved tree has no file to interpolate from, and a
 * host that forbids code generation from strings cannot evaluate them).
 * @module @deepseek-ai/dsh-app-boot/compose
 */

import { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { assertEntriesActivated } from './index.ts'

/** Plugin modules by specifier: the complete set a literal composition may name. */
export type ModuleTable = ReadonlyMap<string, unknown>

/**
 * The Loader's module-resolution contract over a static table. Mirrors the
 * browser shell's table-backed loader: the only call the vendored Loader makes
 * is `internal.import`, so the table needs nothing else.
 */
export interface TableModuleLoader {
  /** Discriminant against Node's internal loader shapes (`v1`/`v2`) and the browser's `client`. */
  readonly version: 'table'
  /**
   * Resolve one plugin specifier.
   * @param specifier - the row's `name`.
   * @returns the module namespace the table holds for it.
   * @throws when the table does not hold the specifier; a missing plugin is a composition error.
   */
  import(specifier: string): Promise<unknown>
}

/**
 * Build the table-backed module loader.
 * @param modules - plugin modules by specifier.
 * @returns the loader to install on `ctx.loader.internal`.
 */
export function tableModuleLoader(modules: ModuleTable): TableModuleLoader {
  return {
    version: 'table',
    import(specifier) {
      const module = modules.get(specifier)
      if (module === undefined) {
        return Promise.reject(new Error(`composition names "${specifier}", which the module table does not hold`))
      }
      return Promise.resolve(module)
    },
  }
}

/** Render a load failure with every aggregated member, so a multi-row failure names each row. */
function describeFailure(cause: unknown): string {
  if (cause instanceof AggregateError) {
    return `${cause.message}:\n${cause.errors.map(error => `  - ${describeFailure(error)}`).join('\n')}`
  }
  return cause instanceof Error ? cause.stack ?? cause.message : String(cause)
}

/** Options for {@link bootEntries}. */
export interface BootEntriesOptions {
  /** Plugin modules by specifier; every row `name` must be present. */
  modules: ModuleTable
  /** Host setup run after Loader installation and before any row mounts. */
  prepare?: (ctx: Context) => Promise<void> | void
  /** The base URL rows that read `ctx.baseUrl` see; defaults to a memory scheme with no file behind it. */
  baseUrl?: string
}

/**
 * Mount `rows` on a fresh root context and return it once every row is
 * active. Bare specifiers resolve through the module table; `cordis:group`
 * resolves to the vendored Group so a row may open an `isolate` realm.
 * @param binName - the diagnostic prefix for load-failure errors.
 * @param rows - the literal entry list.
 * @param options - the module table and host setup.
 * @returns the root context once every entry has started.
 * @throws a labelled error after disposing the partial context — `host
 * preparation failed` when `prepare` threw before any row mounted, `plugin
 * tree failed to load` afterwards.
 */
export async function bootEntries(
  binName: string,
  rows: readonly EntryOptions[],
  options: BootEntriesOptions,
): Promise<Context> {
  const ctx = new Context()
  let stage = 'host preparation failed'
  try {
    ctx.baseUrl = options.baseUrl ?? 'memory:/composition/'
    await ctx.plugin(Loader)
    // The Loader's internal contract is Node's loader shape; the table satisfies
    // the one method the Loader calls, as the browser shell's table does.
    ctx.loader.internal = tableModuleLoader(options.modules) as never
    ctx.loader.builtins.group = Group
    await options.prepare?.(ctx)
    stage = 'plugin tree failed to load'
    await ctx.loader.root.update(rows.map(row => structuredClone(row)))
    await ctx.loader.await()
    await assertEntriesActivated(ctx, binName)
    return ctx
  } catch (cause) {
    await ctx.fiber.dispose()
    throw new Error(`${binName}: ${stage}: ${describeFailure(cause)}`, { cause })
  }
}
