/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the filesystem source row and the roster row, the
 * roster composes a scoped agent context from a preset directory on disk, a
 * later session sees an edited composition file as a new standing generation,
 * and a preset whose file breaks fails its mount with `PresetMountError`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets, { livePresetMounts, PresetMountError } from '@deepseek-ai/dsh-agent-presets'
import FilesystemAgentPresetSource, { COMPOSITION_FILE } from '@deepseek-ai/dsh-agent-presets-filesystem'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const CONTRIBUTE = join(FIXTURES, 'plugins', 'contribute.js')
const SOURCE = '@deepseek-ai/dsh-agent-presets-filesystem'
const ROSTER = '@deepseek-ai/dsh-agent-presets'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  root = undefined
})

/** One-row composition whose single tool is named `tool`, naming the fixture plugin by a relative path. */
const rowFor = (tool: string): string => `- id: only\n  name: ./contribute.js\n  config:\n    tool: ${tool}\n`

/**
 * Write a preset directory plus a two-row cordis.yml (source, then roster),
 * then boot it through the real Loader over the host registries.
 * @param presetId - the preset directory to seed.
 * @returns the booted context and the seeded composition file path.
 */
async function loadComposition(presetId: string): Promise<{ ctx: Context; presetFile: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-agent-presets-composition-'))
  const presetsRoot = join(root, 'presets')
  const presetDir = join(presetsRoot, presetId)
  await mkdir(presetDir, { recursive: true })
  // The plugin sits beside the composition so the relative row specifier
  // resolves from the base URL the source names, not from the harness.
  await writeFile(join(presetDir, 'contribute.js'), `export * from ${JSON.stringify(pathToFileURL(CONTRIBUTE).href)}\n`)
  const presetFile = join(presetDir, COMPOSITION_FILE)
  await writeFile(presetFile, rowFor('before'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: agent-preset-source',
    `  name: '${SOURCE}'`,
    '  config:',
    '    roots:',
    `      - path: ${JSON.stringify(presetsRoot)}`,
    '        trust: user',
    '    includeUserRoot: false',
    '- id: agent-presets',
    `  name: '${ROSTER}'`,
    '  config:',
    `    default: ${presetId}`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  await context.plugin(LlmRuntime)
  await context.plugin(SessionStore)
  await context.plugin(SystemPrompt, { persona: '' })
  await context.plugin(ToolRuntime)
  await context.plugin(AgentRegistry)
  await context.plugin(AgentLoop, { agents: [] })
  const modules = new Map<string, unknown>([
    [SOURCE, FilesystemAgentPresetSource],
    [ROSTER, AgentPresets],
  ])
  // The Loader resolves bare package names through this table and relative
  // preset rows through Node, against the base URL the mount hands it.
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string, base: string) {
      if (modules.has(specifier)) return modules.get(specifier)
      if (specifier.startsWith('.')) return await import(new URL(specifier, base).href) as unknown
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { ctx: context, presetFile }
}

/** Create one agent composed from the roster default, exactly as a factory `setup` would. */
async function agentOn(ctx: Context, id: string): Promise<string[]> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx),
  })
  return ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()
}

describe('the shipped preset rows booted through the Loader', () => {
  it('composes an agent from a preset directory and refreshes the generation on an edit', async () => {
    const { ctx, presetFile } = await loadComposition('edited-on-disk')
    expect([...ctx.loader.entries()].map(entry => entry.options.id)).toContain('agent-preset-source')
    expect([...ctx.loader.entries()].map(entry => entry.options.id)).toContain('agent-presets')
    expect(ctx.agentPresets.authorable).toBe(true)

    expect(await agentOn(ctx, 'sess-first')).toEqual(['before'])
    expect(livePresetMounts().filter(mount => mount.presetId === 'edited-on-disk')).toHaveLength(1)

    // The file is the composition editor: its stat stamp is what the source
    // reports, so the next session mounts the edited rows as a new generation
    // while the first session keeps the one it joined.
    await writeFile(presetFile, rowFor('afterwards'))

    expect(await agentOn(ctx, 'sess-second')).toEqual(['afterwards'])
    expect(livePresetMounts().filter(mount => mount.presetId === 'edited-on-disk')).toHaveLength(2)
    expect(ctx.tools.schemas(ctx.agents.get(SessionId('sess-first'))).map(schema => schema.name)).toEqual(['before'])
  })

  it('fails a mount with PresetMountError once the file breaks', async () => {
    const { ctx, presetFile } = await loadComposition('breaks-on-disk')
    await writeFile(presetFile, 'rows: not-a-list\n')

    // Discovery reports the broken file first, so the refusal carries the
    // source's reason and the creation rolls back.
    await expect(agentOn(ctx, 'sess-broken')).rejects.toThrow(PresetMountError)
    await expect(agentOn(ctx, 'sess-broken-2')).rejects.toThrow(/top-level list of plugin rows/)
    expect(ctx.agents.get(SessionId('sess-broken'))).toBeUndefined()
    expect(livePresetMounts().filter(mount => mount.presetId === 'breaks-on-disk')).toHaveLength(0)
  })
})
