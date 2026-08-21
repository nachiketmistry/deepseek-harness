/**
 * File-free composition: literal rows mount through the real vendored Loader
 * with plugins resolved from a module table, so a host without a disk profile
 * boots the same way a `cordis.yml` does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { bootEntries, tableModuleLoader } from '../src/index.ts'

class Counter extends Service {
  static Config = z.object({ label: z.string().required() })
  readonly started: string[] = []
  constructor(ctx: Context, public config: { label: string }) {
    super(ctx, 'counter')
  }
}

const consumer = {
  name: 'consumer',
  inject: ['counter'],
  apply(ctx: Context) {
    ctx.counter.started.push('consumer')
  },
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    counter: Counter
  }
}

let booted: Context | undefined

afterEach(async () => {
  await booted?.fiber.dispose()
  booted = undefined
})

describe('tableModuleLoader', () => {
  it('resolves held specifiers and rejects absent ones', async () => {
    const loader = tableModuleLoader(new Map([['a', consumer]]))
    expect(loader.version).toBe('table')
    await expect(loader.import('a')).resolves.toBe(consumer)
    await expect(loader.import('b')).rejects.toThrow('composition names "b", which the module table does not hold')
  })
})

describe('bootEntries', () => {
  const rows: EntryOptions[] = [
    { id: 'counter', name: 'test:counter', config: { label: 'one' } },
    { id: 'consumer', name: 'test:consumer' },
  ]
  const modules = new Map<string, unknown>([
    ['test:counter', Counter],
    ['test:consumer', consumer],
  ])

  it('mounts literal rows through the Loader with table-resolved plugins', async () => {
    booted = await bootEntries('test', rows, { modules, baseUrl: 'memory:/tree/' })
    expect(booted.baseUrl).toBe('memory:/tree/')
    expect(booted.counter.config.label).toBe('one')
    expect(booted.counter.started).toEqual(['consumer'])
    expect([...booted.loader.entries()].map(entry => entry.options.id)).toEqual(['counter', 'consumer'])
    expect(booted.loader.builtins.group).toBeDefined()
  })

  it('opens an isolate realm through the cordis:group builtin', async () => {
    const grouped: EntryOptions[] = [
      {
        id: 'realm',
        name: 'cordis:group',
        group: true,
        isolate: { counter: true },
        config: [
          { id: 'counter', name: 'test:counter', config: { label: 'inner' } },
          { id: 'consumer', name: 'test:consumer' },
        ],
      },
    ]
    booted = await bootEntries('test', grouped, { modules })
    expect(booted.get('counter')).toBeUndefined()
    const inner = [...booted.loader.entries()].find(entry => entry.options.id === 'consumer')?.fiber?.ctx.get('counter')
    expect(inner?.config.label).toBe('inner')
  })

  it('runs prepare before any row mounts and labels its failure', async () => {
    const order: string[] = []
    booted = await bootEntries('test', rows, {
      modules,
      prepare: (ctx) => {
        order.push(`prepare:${String([...ctx.loader.entries()].length)}`)
      },
    })
    expect(order).toEqual(['prepare:0'])
    await expect(bootEntries('test', rows, {
      modules,
      prepare: () => { throw new Error('no host') },
    })).rejects.toThrow('test: host preparation failed: no host')
    await expect(bootEntries('test', rows, {
      modules,
      prepare: () => { throw 'plain' },
    })).rejects.toThrow('test: host preparation failed: plain')
  })

  it('disposes the partial tree and labels a row failure', async () => {
    await expect(bootEntries('test', rows, { modules: new Map([['test:counter', Counter]]) }))
      .rejects.toThrow(/test: plugin tree failed to load: .*test:consumer/)
  })

  it('does not let the tree mutate the caller rows', async () => {
    const copy = structuredClone(rows)
    booted = await bootEntries('test', copy, { modules })
    expect(copy).toEqual(rows)
  })
})
