/**
 * The source's composition read: rows parsed in the loader dialect, a stamp
 * that is the file's stat identity, and a base URL beside the file.
 */

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { beforeEach, describe, expect, it } from 'vitest'
import FilesystemAgentPresetSource, { COMPOSITION_FILE } from '@deepseek-ai/dsh-agent-presets-filesystem'

let root: string
let source: FilesystemAgentPresetSource

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-preset-source-'))
  const ctx = new Context()
  await ctx.plugin(Loader)
  await ctx.plugin(FilesystemAgentPresetSource, { roots: [{ path: root, trust: 'user' }], includeUserRoot: false })
  source = ctx.agentPresetSource as FilesystemAgentPresetSource
})

/** Seed one preset directory and return the preset as discovery reports it. */
async function seeded(id: string, composition: string): Promise<AgentPreset> {
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, COMPOSITION_FILE), composition)
  const preset = (await source.list()).find(candidate => candidate.id === id)
  if (preset === undefined) throw new Error(`seeded preset ${id} was not listed`)
  return preset
}

describe('reading a composition', () => {
  it('hands back the rows, the file stamp, and the directory as base URL', async () => {
    const preset = await seeded('plain', '- id: x\n  name: some-plugin\n  config:\n    value: !!js "1 + 1"\n')

    const composition = await source.composition(preset)

    // The loader dialect is preserved: a `!!js` scalar is an expression node
    // for the Loader to evaluate in the row's own context, not a string.
    expect(composition.rows).toEqual([{ id: 'x', name: 'some-plugin', config: { value: { __jsExpr: '1 + 1' } } }])
    expect(composition.baseUrl).toBe(pathToFileURL(join(root, 'plain')).href + '/')
    expect(composition.stamp).toBe(await source.stamp(preset))
  })

  it('stamps by modification time and size', async () => {
    const preset = await seeded('stamped', '[]\n')
    const before = await source.stamp(preset)

    await writeFile(preset.path, '- id: x\n  name: p\n')

    const after = await source.stamp(preset)
    expect(after).not.toBe(before)
    const { mtimeMs, size } = await stat(preset.path)
    expect(after).toBe(`${String(mtimeMs)}:${String(size)}`)
  })

  it('notices a same-size edit within one mtime tick only through its size, so it pins both', async () => {
    const preset = await seeded('tick', '- id: a\n  name: p\n')
    const { mtime } = await stat(preset.path)

    // A rewrite that lands inside the same mtime tick leaves mtime alone; the
    // size is the tiebreak that still tells the two states apart.
    await writeFile(preset.path, '- id: ab\n  name: p\n')
    await utimes(preset.path, mtime, mtime)

    expect(await source.stamp(preset)).toBe(`${String(mtime.getTime())}:${String('- id: ab\n  name: p\n'.length)}`)
  })

  it('refuses a composition that is not a top-level list', async () => {
    const preset = await seeded('not-a-list', 'rows: nope\n')

    await expect(source.composition(preset)).rejects.toThrow(/must be a top-level list of plugin rows/)
  })

  it('answers an undefined stamp and a rejected read for a missing file', async () => {
    const preset = await seeded('gone', '[]\n')
    await rm(preset.path)

    expect(await source.stamp(preset)).toBeUndefined()
    await expect(source.composition(preset)).rejects.toThrow(/ENOENT/)
  })

  it('reads the text exactly as stored', async () => {
    const text = '# kept comment\n- id: x\n  name: p\n'
    const preset = await seeded('verbatim', text)

    expect(await source.read(preset)).toBe(text)
  })
})
