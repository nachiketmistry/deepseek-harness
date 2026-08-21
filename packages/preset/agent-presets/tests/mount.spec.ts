import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AgentPresets, {
  leakedServices, livePresetMounts, mountPreset, PresetMountError, serviceForAgent,
} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { fixturePreset, MemoryPresetSource, toolPreset, type MemoryPreset } from './memory-source.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Published by the `isolated` fixture preset behind an entry-local realm. */
    fixtureIsolatedSvc: { label: string }
  }
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const SYSTEM = join(FIXTURES, 'system')
const USER = join(FIXTURES, 'user')
const CONTRIBUTE = join(FIXTURES, 'plugins', 'contribute.js')

/** The committed fixture presets as one in-memory table, first root winning `standard`. */
function fixtureTable(): Omit<MemoryPreset, 'stamp'>[] {
  return [
    fixturePreset(SYSTEM, 'standard', 'system'),
    fixturePreset(SYSTEM, 'minimal', 'system'),
    ...['broken', 'isolated', 'late', 'leaky', 'pending', 'two-broken'].map(id => fixturePreset(USER, id, 'user')),
    { id: 'not-a-preset', trust: 'user', rows: [], broken: 'the composition file agent.cordis.yml is missing — the directory still occupies the id; delete it or restore the file' },
  ]
}

/**
 * A composition carrying the registries a preset contributes to, plus the
 * preset roster over an in-memory source.
 * @param entries - the source table, defaulting to the fixture presets.
 * @param defaultId - the composition default.
 * @returns the booted context.
 */
async function harness(entries: Omit<MemoryPreset, 'stamp'>[] = fixtureTable(), defaultId = 'standard'): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MemoryPresetSource, { entries })
  await ctx.plugin(AgentPresets, { default: defaultId })
  return ctx
}

/** The memory source behind a harness, for edits and deletions mid-test. */
const sourceOf = (ctx: Context): MemoryPresetSource => ctx.agentPresetSource as MemoryPresetSource

/** Create one agent composed from `presetId`, exactly as a factory `setup` would. */
async function agentOn(ctx: Context, id: string, presetId?: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, presetId),
  })
  return handle.agent
}

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

/** Every service registration in the runtime, regardless of which realm holds it. */
function providedServiceNames(ctx: Context): string[] {
  const store = ctx.reflect.store
  return Object.getOwnPropertySymbols(store)
    .map(key => store[key]?.name)
    .filter((name): name is string => name !== undefined)
}

/** Whether the root realm maps `name` to a live registration. */
function rootResolves(ctx: Context, name: string): boolean {
  const key = ctx.root[Context.isolate][name]
  return key !== undefined && ctx.reflect.store[key] !== undefined
}

let ctx: Context
beforeEach(async () => {
  ctx = await harness()
})

describe('composing an agent from a preset', () => {
  it('hands an absolute plugin path to Node as a file URL', async () => {
    const scoped = await harness([toolPreset('absolute', CONTRIBUTE, 'absolute')], 'absolute')
    const imported = vi.spyOn(scoped.loader.internal!, 'import')

    await agentOn(scoped, 'sess-absolute-plugin')

    expect(imported).toHaveBeenCalledWith(pathToFileURL(CONTRIBUTE).href, expect.any(String), {})
  })

  it('resolves a relative row specifier against the composition base the source named', async () => {
    // The fixture rows name `../../plugins/contribute.js`, which only resolves
    // beside the preset's own files — the base URL travels with the rows.
    const scoped = await harness()
    const imported = vi.spyOn(scoped.loader.internal!, 'import')

    await agentOn(scoped, 'sess-relative-plugin', 'minimal')

    expect(imported).toHaveBeenCalledWith('../../plugins/contribute.js', pathToFileURL(join(SYSTEM, 'minimal')).href + '/', {})
  })

  it('mounts rows with no base URL, as a file-free source supplies them', async () => {
    const scoped = await harness([{ id: 'bare', trust: 'system', rows: [{ id: 'only', name: CONTRIBUTE, config: { tool: 'bare' } }] }], 'bare')

    const agent = await agentOn(scoped, 'sess-no-base')

    expect(toolNames(scoped, agent)).toEqual(['bare'])
  })

  it('mounts a clone of the source rows, so the Loader never mutates the source', async () => {
    const rows = [{ id: 'only', name: CONTRIBUTE, config: { tool: 'cloned' } }]
    const pristine = structuredClone(rows)
    const scoped = await harness([{ id: 'cloned', trust: 'system', rows }], 'cloned')

    await agentOn(scoped, 'sess-cloned')

    // The Loader stores each row's options by identity and writes into them;
    // a source handing out one shared row set must not see that state.
    expect(rows).toEqual(pristine)
  })

  it('gives each session only its own preset\'s tools', async () => {
    const alpha = await agentOn(ctx, 'sess-alpha', 'standard')
    const beta = await agentOn(ctx, 'sess-beta', 'minimal')

    expect(toolNames(ctx, alpha)).toEqual(['alpha'])
    expect(toolNames(ctx, beta)).toEqual(['beta'])
    expect(toolNames(ctx)).toEqual([])
  })

  it('scopes prompt sections and assembled schemas to the same session', async () => {
    const alpha = await agentOn(ctx, 'sess-alpha', 'standard')
    const beta = await agentOn(ctx, 'sess-beta', 'minimal')

    const alphaPrompt = await ctx.systemPrompt.assemble(assembleContextFor(alpha))
    const betaPrompt = await ctx.systemPrompt.assemble(assembleContextFor(beta))

    expect(alphaPrompt.sections.map(section => section.name)).toContain('preset:alpha')
    expect(alphaPrompt.sections.map(section => section.name)).not.toContain('preset:beta')
    expect(betaPrompt.sections.map(section => section.name)).toContain('preset:beta')
    expect(alphaPrompt.tools.map(schema => schema.name)).toEqual(['alpha'])
  })

  it('mounts the default preset when the caller names none', async () => {
    const agent = await agentOn(ctx, 'sess-default')

    expect(toolNames(ctx, agent)).toEqual(['alpha'])
  })

  it('lets two sessions share one preset without colliding', async () => {
    const first = await agentOn(ctx, 'sess-first', 'standard')
    const second = await agentOn(ctx, 'sess-second', 'standard')

    expect(toolNames(ctx, first)).toEqual(['alpha'])
    expect(toolNames(ctx, second)).toEqual(['alpha'])
  })

  it('unwinds one session\'s composition without touching another\'s', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-gone'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    const survivor = await agentOn(ctx, 'sess-stays', 'minimal')
    expect(toolNames(ctx, handle.agent)).toEqual(['alpha'])

    await handle.dispose()

    expect(ctx.agents.get(SessionId('sess-gone'))).toBeUndefined()
    expect(toolNames(ctx, survivor)).toEqual(['beta'])
    expect(toolNames(ctx)).toEqual([])
  })
})

describe('composing a child agent from its parent', () => {
  /** Create one agent joined to `parent`'s composition, as a child creation window does. */
  async function childOf(ctx: Context, id: string, parent: Agent): Promise<Agent> {
    const handle = await ctx.agents.create({
      sessionId: SessionId(id),
      setup: (childCtx: Context) => void ctx.agentPresets.composeFrom(childCtx, parent.ctx),
    })
    return handle.agent
  }

  it('gives the child its parent\'s tools and prompt sections', async () => {
    const parent = await agentOn(ctx, 'sess-parent', 'standard')

    const child = await childOf(ctx, 'sess-child', parent)

    expect(toolNames(ctx, child)).toEqual(['alpha'])
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(child))
    expect(prompt.sections.map(section => section.name)).toContain('preset:alpha')
  })

  it('joins the parent\'s own generation rather than remounting its preset', async () => {
    const parent = await agentOn(ctx, 'sess-shared', 'standard')
    const before = livePresetMounts().length

    await childOf(ctx, 'sess-shared-child', parent)

    // A remount would compose a second copy of every row in the preset; the
    // child must run on the plugin instances its parent already runs on.
    expect(livePresetMounts()).toHaveLength(before)
  })

  it('keeps the child composed after its parent is disposed', async () => {
    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('sess-dying-parent'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    const child = await childOf(ctx, 'sess-orphan', parentHandle.agent)

    await parentHandle.dispose()

    // Standing mounts outlive the agents that joined them, so a child outliving
    // its parent — a background subagent — keeps the composition it started on.
    expect(toolNames(ctx, child)).toEqual(['alpha'])
  })

  it('reports the preset id the child joined, for the durable header', async () => {
    const parent = await agentOn(ctx, 'sess-named', 'minimal')

    const child = await childOf(ctx, 'sess-named-child', parent)

    expect(ctx.agentPresets.composedPreset(parent.ctx)).toBe('minimal')
    expect(ctx.agentPresets.composedPreset(child.ctx)).toBe('minimal')
  })

  it('composes nothing when the parent joined no preset', async () => {
    // The rosterless deployment: model-facing rows sit in the host composition
    // and the child already resolves them through the registry's global layer.
    const bare = (await ctx.agents.create({ sessionId: SessionId('sess-bare-parent') })).agent

    const child = await childOf(ctx, 'sess-bare-child', bare)

    expect(ctx.agentPresets.composedPreset(bare.ctx)).toBeUndefined()
    expect(ctx.agentPresets.composeFrom(child.ctx, bare.ctx)).toBeUndefined()
    expect(toolNames(ctx, child)).toEqual([])
  })

  it('refuses to compose an unscoped context', async () => {
    const parent = await agentOn(ctx, 'sess-unscoped-parent', 'standard')

    expect(() => ctx.agentPresets.composeFrom(ctx, parent.ctx)).toThrow(/unscoped context/)
  })
})

describe('rejecting a composition that cannot be used', () => {
  it('refuses to mount into a context that carries no agent scope', async () => {
    await expect(ctx.agentPresets.mount(ctx, 'standard'))
      .rejects.toThrow(/unscoped context/)
  })

  it('rolls the whole agent back when a row fails to load', async () => {
    await expect(agentOn(ctx, 'sess-broken', 'broken')).rejects.toThrow(/failed to mount/)

    expect(ctx.agents.get(SessionId('sess-broken'))).toBeUndefined()
    expect(toolNames(ctx)).toEqual([])
  })

  it('names every failed row, not just the count', async () => {
    // The Loader folds several failed rows into one AggregateError whose own
    // message names none of them; unflattened, the operator is told only that
    // "loader entries failed to apply" and has nothing to act on.
    await expect(agentOn(ctx, 'sess-two-broken', 'two-broken'))
      .rejects.toThrow(/first-missing[\s\S]*second-missing/)
  })

  it('names the unresolved service when a row never activates', async () => {
    await expect(agentOn(ctx, 'sess-pending', 'pending'))
      .rejects.toThrow(/waiting for serviceThatDoesNotExist/)
  })

  it('rejects a row that publishes a process-global service', async () => {
    await expect(agentOn(ctx, 'sess-leaky', 'leaky'))
      .rejects.toThrow(/process-global service\(s\) \[aaaFixtureLeakedSvc, zzzFixtureLeakedSvc\]/)

    // The rejected subtree is fully unwound, so its registrations are gone from
    // the store rather than merely unreachable.
    expect(providedServiceNames(ctx)).not.toContain('aaaFixtureLeakedSvc')
    expect(providedServiceNames(ctx)).not.toContain('zzzFixtureLeakedSvc')
  })

  it('accepts the same provider behind an isolate realm', async () => {
    const agent = await agentOn(ctx, 'sess-isolated', 'isolated')

    expect(agent.id).toBe(SessionId('sess-isolated'))
    // The provider ran, but under a realm-private symbol the root cannot reach.
    expect(providedServiceNames(ctx)).toContain('fixtureIsolatedSvc')
    expect(rootResolves(ctx, 'fixtureIsolatedSvc')).toBe(false)
  })

  it('addresses the standing instance of a realm-private service through either agent', async () => {
    const first = await agentOn(ctx, 'sess-reach-a', 'isolated')
    const second = await agentOn(ctx, 'sess-reach-b', 'isolated')

    // The realm keeps the service out of every host context, so a caller
    // holding the agent is how a request from OUTSIDE the session reads the
    // instance it is about.
    expect(rootResolves(ctx, 'fixtureIsolatedSvc')).toBe(false)
    const mine = ctx.agentPresets.serviceFor(first, 'fixtureIsolatedSvc')
    const theirs = ctx.agentPresets.serviceFor(second, 'fixtureIsolatedSvc')
    expect(mine).toBeDefined()
    // ONE composition per preset: both agents joined the same standing mount,
    // so they address the same instance — sessions stay apart inside it by
    // the plugin's own Session/Agent keying, not by instance count.
    expect(theirs).toBe(mine)
  })

  it('answers undefined for a service the agent\'s preset does not mount', async () => {
    // The isolated preset's standing instance exists in the same runtime, so
    // the lookup finds the NAME and must still refuse it: the instance lives
    // under another mount's fiber, not this agent's composition.
    await agentOn(ctx, 'sess-reach-other', 'isolated')
    const agent = await agentOn(ctx, 'sess-reach-none', 'standard')

    expect(ctx.agentPresets.serviceFor(agent, 'fixtureIsolatedSvc')).toBeUndefined()
  })

  it('answers undefined for an agent outside the scope machinery', async () => {
    // Unscoped, scoped-but-unparented, and parented to a key no live mount
    // owns are the three ways a context can fail to name a standing mount;
    // each is an answer, not a throw, because the caller asked a question.
    expect(serviceForAgent(ctx, { ctx }, 'fixtureIsolatedSvc')).toBeUndefined()
    const loner = createScope(ctx, { test: 'loner' })
    expect(serviceForAgent(ctx, { ctx: loner.ctx }, 'fixtureIsolatedSvc')).toBeUndefined()
    const orphan = createScope(ctx, { test: 'orphan' })
    bindScopeParent(scopeOf(orphan.ctx)!, { agentPreset: 'never-mounted' })
    expect(serviceForAgent(ctx, { ctx: orphan.ctx }, 'fixtureIsolatedSvc')).toBeUndefined()
  })

  it('refuses to mount a preset directly into an unscoped context', async () => {
    // The service's own mount() guards this before delegating; the exported
    // function is callable on its own, so the boundary holds there too.
    const preset = await ctx.agentPresets.resolve('standard')
    const composition = await ctx.agentPresetSource.composition(preset)

    await expect(mountPreset(ctx, preset, composition)).rejects.toThrow(/unscoped context/)
  })

  it('reports the known ids when a preset is unknown', async () => {
    await expect(ctx.agentPresets.resolve('nope'))
      .rejects.toThrow(/preset "nope" not found \(available: .*standard/)
  })
})

describe('the preset roster', () => {
  it('lists every preset the source supplies, broken ones included', async () => {
    const listed = await ctx.agentPresets.list()

    // `not-a-preset` is the fixture ghost: no composition, listed broken.
    expect(listed.map(preset => preset.id).sort())
      .toEqual(['broken', 'isolated', 'late', 'leaky', 'minimal', 'not-a-preset', 'pending', 'standard', 'two-broken'])
    expect(listed.find(preset => preset.id === 'standard')?.trust).toBe('system')
    expect(listed.find(preset => preset.id === 'not-a-preset')?.broken).toMatch(/is missing/)
  })

  it('reads, copies, and removes through the source', async () => {
    await ctx.agentPresets.copy('standard', 'mine', '我的模式')

    expect(await ctx.agentPresets.read('mine')).toBe(await ctx.agentPresets.read('standard'))
    expect((await ctx.agentPresets.list()).find(preset => preset.id === 'mine')).toMatchObject({ trust: 'user', name: '我的模式' })
    expect(ctx.agentPresets.authorable).toBe(true)

    await ctx.agentPresets.remove('mine')

    expect((await ctx.agentPresets.list()).some(preset => preset.id === 'mine')).toBe(false)
  })

  it('refuses a copy under an id the source already supplies', async () => {
    // The roster check is the registry's own: the source's occupancy check
    // only sees its writable location, while a shipped id shadows it.
    await expect(ctx.agentPresets.copy('standard', 'minimal')).rejects.toThrow(/already exists/)
  })

  it('reports authoring as unavailable when the source has nowhere to write', async () => {
    const readOnly = new Context()
    await readOnly.plugin(Loader)
    await readOnly.plugin(MemoryPresetSource, { entries: [fixturePreset(SYSTEM, 'standard', 'system')], writable: false })
    await readOnly.plugin(AgentPresets, { default: 'standard' })

    expect(readOnly.agentPresets.authorable).toBe(false)
    await expect(readOnly.agentPresets.copy('standard', 'mine')).rejects.toThrow(/read-only/)
  })

  it('exposes the configured default id', () => {
    expect(ctx.agentPresets.defaultId).toBe('standard')
  })
})

describe('composing from a broken preset', () => {
  /** A roster whose only preset the source reports broken with `reason`. */
  async function rosterWith(reason: string): Promise<Context> {
    return await harness([{ id: 'damaged', trust: 'user', rows: [], broken: reason }], 'damaged')
  }

  it('refuses the mount up front with the source-reported reason', async () => {
    const scoped = await rosterWith('the composition is not valid YAML: bad indentation')

    // The refusal happens before the loader ever sees the rows, so every
    // unloadable shape gets the same early PresetMountError — and a rejected
    // setup rolls the whole agent creation back.
    await expect(agentOn(scoped, 'sess-broken', 'damaged')).rejects.toThrow(PresetMountError)
    await expect(agentOn(scoped, 'sess-broken-2', 'damaged')).rejects.toThrow(/not valid YAML/)
    expect(livePresetMounts().filter(mount => mount.presetId === 'damaged')).toHaveLength(0)
  })

  it('refuses the standing key a cold reader would mount by', async () => {
    const scoped = await rosterWith('the composition must be a top-level list of plugin rows')

    await expect(scoped.agentPresets.standingKeyFor('damaged'))
      .rejects.toThrow(/top-level list of plugin rows/)
  })

  it('still resolves the broken row for the surfaces that manage it', async () => {
    const scoped = await rosterWith('the composition is not valid YAML: bad indentation')

    // Deleting and reporting need the row; only composing refuses it.
    expect((await scoped.agentPresets.resolve('damaged')).broken).toMatch(/not valid YAML/)
  })
})

describe('a roster with nothing in it', () => {
  it('says so instead of naming an empty list of candidates', async () => {
    const bare = new Context()
    await bare.plugin(Loader)
    await bare.plugin(MemoryPresetSource, { entries: [] })
    await bare.plugin(AgentPresets, { default: 'standard' })

    await expect(bare.agentPresets.resolve())
      .rejects.toThrow(/preset "standard" not found \(available: none\)/)
  })
})

describe('a composition is an input, never a persistence target', () => {
  it('survives a row that disposes itself, which makes the Loader persist a tree', async () => {
    const rows = [
      { id: 'tool-kept', name: CONTRIBUTE, config: { tool: 'kept' } },
      { id: 'goes-away', name: join(FIXTURES, 'plugins', 'self-dispose.js') },
    ]
    const pristine = structuredClone(rows)
    const scoped = await harness([{ id: 'self-disposing', trust: 'user', rows }], 'self-disposing')
    const updates: string[] = []
    scoped.on('loader/config-update', () => { updates.push('config-update') })

    await scoped.agents.create({
      sessionId: SessionId('sess-self-dispose'),
      setup: async (agentCtx: Context) => void await scoped.agentPresets.mount(agentCtx),
    })
    await (globalThis as { __SELF_DISPOSED__?: Promise<unknown> }).__SELF_DISPOSED__
    // Slack past the deterministic signal above, not a race the number has to
    // win. The write rides the Loader's fiber-unload listener, which stamps
    // `disabled: true` and calls `write()` in the same synchronous step; once
    // the self-dispose has settled, a regression has already written. Polling
    // would not help — the assertion is an ABSENCE, and no amount of waiting
    // proves one — so the wait only has to clear settlement.
    await new Promise(resolve => setTimeout(resolve, 50))

    // A persisting tree would announce the write and the Loader would have
    // stamped `disabled: true` onto the dying row; the source's rows are
    // untouched because the mount cloned them, and nothing was announced
    // because `write()` is a no-op.
    expect(updates).toEqual([])
    expect(rows).toEqual(pristine)
  })
})

describe('attributing a service to a subtree', () => {
  it('attributes nothing to a subtree that is already torn down', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-torn'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    const [mount] = livePresetMounts().filter(entry => entry.presetId === 'standard')
    expect(mount).toBeDefined()

    await handle.dispose()

    // A disposed subtree owns nothing, so it can never be blamed for a service
    // some other subtree published under the same name afterwards.
    expect(leakedServices(ctx, mount!.fiber)).toEqual([])
  })
})

describe('replacing a composition', () => {
  it('publishes a committed preset selection for remote consumers', async () => {
    const agent = await agentOn(ctx, 'sess-selected', 'standard')
    const selected: Array<[SessionId, string]> = []
    ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
      selected.push([sessionId, agentPreset])
    })

    agent.session.append('agent-preset/selected', { agentPreset: 'minimal' })
    // Any other durable record is not a selection and is not forwarded.
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(selected).toEqual([[SessionId('sess-selected'), 'minimal']])
  })

  it('swaps the agent\'s tools without touching another session', async () => {
    const keeper = await agentOn(ctx, 'sess-keeper', 'standard')
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-swap'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    expect(toolNames(ctx, handle.agent)).toEqual(['alpha'])

    await ctx.agentPresets.recompose(handle.agent.ctx, 'minimal')

    expect(toolNames(ctx, handle.agent)).toEqual(['beta'])
    expect(toolNames(ctx, keeper)).toEqual(['alpha'])
    expect(toolNames(ctx)).toEqual([])
  })

  it('leaves the agent on its previous composition when the new one is unknown', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-unknown'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })

    await expect(ctx.agentPresets.recompose(handle.agent.ctx, 'nope'))
      .rejects.toThrow(/not found/)

    // Resolution happens before any teardown, so an unknown id is a no-op.
    expect(toolNames(ctx, handle.agent)).toEqual(['alpha'])
  })

  it('restores the previous composition when the new one fails to mount', async () => {
    const handle = await ctx.agents.create({
      sessionId: SessionId('sess-restore'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })

    await expect(ctx.agentPresets.recompose(handle.agent.ctx, 'broken'))
      .rejects.toThrow(/failed to mount/)

    // The swap is unmount-then-mount, so a failure must put the old one back
    // rather than leave the agent with no tools at all.
    expect(toolNames(ctx, handle.agent)).toEqual(['alpha'])
  })

  it('names an agent that was published without joining any preset', async () => {
    const ctx = await harness()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn

    await ctx.agents.create({ sessionId: SessionId('sess-unjoined-warn') })
    // Advisory, not fatal: a synchronous `agent/created` throw would veto
    // publication, and creating an agent outside the roster stays legal.
    expect(warnings.filter(line => line.includes('sess-unjoined-warn'))).toHaveLength(1)
    expect(warnings.at(-1)).toMatch(/without joining an agent preset/)

    warnings.length = 0
    await agentOn(ctx, 'sess-joined-quiet', 'minimal')
    expect(warnings).toEqual([])
  })

  it('warns even when the source supplies nothing, because a mounted roster is a roster', async () => {
    // A rosterless deployment is one that does not mount this plugin at all;
    // a source is a required injection, so there is no opt-out underneath it.
    const empty = await harness([])
    const warnings: string[] = []
    empty.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof empty.logger.warn

    await empty.agents.create({ sessionId: SessionId('sess-empty-source') })

    expect(warnings.at(-1)).toMatch(/without joining an agent preset/)
  })

  it('composes an agent that had nothing installed', async () => {
    // An agent created without a preset has no binding to re-link, so the
    // switch is its first bind — exactly a mount — and once bound only the
    // roster's kept binding can move it again.
    const handle = await ctx.agents.create({ sessionId: SessionId('sess-bare') })

    await ctx.agentPresets.recompose(handle.agent.ctx, 'minimal')

    expect(toolNames(ctx, handle.agent)).toEqual(['beta'])
  })

  it('refuses a bare agent\'s broken composition without restoring anything', async () => {
    const handle = await ctx.agents.create({ sessionId: SessionId('sess-bare-broken') })

    await expect(ctx.agentPresets.recompose(handle.agent.ctx, 'broken'))
      .rejects.toThrow(/failed to mount/)

    // Nothing was installed, so there is nothing to put back.
    expect(toolNames(ctx, handle.agent)).toEqual([])
  })

  it('keeps the agent on its standing composition when a switch fails, even with the source deleted', async () => {
    const scoped = await harness([
      toolPreset('first', CONTRIBUTE, 'only'),
      { id: 'broken', trust: 'user', rows: [{ id: 'nope', name: './does-not-exist.js' }], baseUrl: pathToFileURL(FIXTURES).href + '/' },
    ], 'first')
    const handle = await scoped.agents.create({
      sessionId: SessionId('sess-restore-gone'),
      setup: async (agentCtx: Context) => void await scoped.agentPresets.mount(agentCtx, 'first'),
    })

    // The roster is live: the composition the agent came from can be gone
    // from the SOURCE by the time a switch fails. The standing mount is not
    // the source entry — it outlives deletion, so there is nothing to "restore".
    sourceOf(scoped).table.delete('first')

    await expect(scoped.agentPresets.recompose(handle.agent.ctx, 'broken'))
      .rejects.toThrow(/failed to mount/)

    // The failed switch left the agent EXACTLY as it was: the new standing
    // mount is ensured before the parent link moves, so a rejection never
    // strips the old composition.
    expect(toolNames(scoped, handle.agent)).toEqual(['only'])
  })

  it('refuses an unscoped context', async () => {
    await expect(ctx.agentPresets.recompose(ctx, 'minimal'))
      .rejects.toThrow(/unscoped context/)
  })
})

describe('editing a composition at its source', () => {
  /** One-row composition whose single tool is named `tool`. */
  const rowFor = (tool: string) => [{ id: 'only', name: CONTRIBUTE, config: { tool } }]

  /**
   * A context over a source holding one editable preset. The id is per-test
   * because `livePresetMounts()` is a process-global registry.
   */
  async function editable(id: string): Promise<{ scoped: Context; edit: (tool: string) => void }> {
    const scoped = await harness([{ id, trust: 'user', rows: rowFor('before') }], id)
    return { scoped, edit: (tool: string) => { sourceOf(scoped).edit(id, rowFor(tool)) } }
  }

  it('starts a new generation for later sessions while joined ones keep theirs', async () => {
    const { scoped, edit } = await editable('edited')
    const first = await agentOn(scoped, 'sess-gen-first', 'edited')
    expect(toolNames(scoped, first)).toEqual(['before'])

    // Editing the source is the only composition editor (authoring is
    // copy/delete), so the standing mount notices the stamp changing on its own.
    edit('afterwards')

    const second = await agentOn(scoped, 'sess-gen-second', 'edited')
    expect(toolNames(scoped, second)).toEqual(['afterwards'])
    // The joined session keeps the generation it runs on.
    expect(toolNames(scoped, first)).toEqual(['before'])
  })

  it('gives two sessions racing the refreshed file one shared new generation', async () => {
    const { scoped, edit } = await editable('raced')
    await agentOn(scoped, 'sess-race-seed', 'raced')

    edit('afterwards')

    // Whichever racer swaps the pointer first, the other must join it rather
    // than fork a third generation off the same edit.
    const [left, right] = await Promise.all([
      agentOn(scoped, 'sess-race-left', 'raced'),
      agentOn(scoped, 'sess-race-right', 'raced'),
    ])
    expect(toolNames(scoped, left)).toEqual(['afterwards'])
    expect(toolNames(scoped, right)).toEqual(['afterwards'])
    expect(livePresetMounts().filter(mount => mount.presetId === 'raced')).toHaveLength(2)
  })

  it('keeps a newer generation pointer when a stale refresh loses the swap race', async () => {
    const { scoped, edit } = await editable('guarded-refresh')
    const preset = await scoped.agentPresets.resolve('guarded-refresh')
    await agentOn(scoped, 'sess-guarded-refresh-seed', 'guarded-refresh')
    const service = scoped.agentPresets as unknown as {
      standing: Map<string, Promise<{ key: unknown; scope: unknown; stamp: string }>>
      ensureStanding(current: typeof preset): Promise<unknown>
    }
    const stalePromise = service.standing.get(preset.id)!
    const stale = await stalePromise
    edit('afterwards')
    const newer = { ...stale, stamp: (await scoped.agentPresetSource.stamp(preset))! }
    const newerPromise = Promise.resolve(newer)

    // `await pending` yields before the guarded delete, letting the winning
    // refresher replace the pointer deterministically instead of by timing.
    const refresh = service.ensureStanding(preset)
    service.standing.set(preset.id, newerPromise)

    expect(await refresh).toBe(newer)
    expect(service.standing.get(preset.id)).toBe(newerPromise)
  })

  it('hands a host reader the standing key without starting an agent', async () => {
    const { scoped } = await editable('cold-read')

    const key = await scoped.agentPresets.standingKeyFor('cold-read')

    // The mount exists for the reader; no agent, session, or turn started.
    expect(key).toEqual({ agentPreset: 'cold-read' })
    expect(livePresetMounts().filter(mount => mount.presetId === 'cold-read')).toHaveLength(1)
    expect(scoped.agents.get(SessionId('cold-read'))).toBeUndefined()
    // A second reader resolves the same generation, not a new mount.
    expect(await scoped.agentPresets.standingKeyFor('cold-read')).toBe(key)
  })

  it('refuses to mount a generation whose composition the source cannot read', async () => {
    const { scoped } = await editable('unstampable')
    const preset = await scoped.agentPresets.resolve('unstampable')
    sourceOf(scoped).table.get('unstampable')!.unreadable = true

    // A source that lists the preset but cannot read its composition must
    // fail the first mount, not leave an unstamped generation that no later
    // edit could ever refresh — and the failure names the source's reason.
    await expect(agentOn(scoped, 'sess-unstampable', 'unstampable')).rejects.toThrow(PresetMountError)
    await expect(agentOn(scoped, 'sess-unstampable-2', 'unstampable')).rejects.toThrow(/cannot be read/)
    expect(livePresetMounts().filter(mount => mount.presetId === preset.id)).toHaveLength(0)
  })

  it('keeps serving the mounted generation when the source cannot stamp it', async () => {
    const { scoped } = await editable('stale')
    await agentOn(scoped, 'sess-stale-served', 'stale')
    expect(livePresetMounts().filter(mount => mount.presetId === 'stale')).toHaveLength(1)

    sourceOf(scoped).table.get('stale')!.stamp = undefined

    // A mount must survive its composition disappearing underneath it: the
    // next session is served the standing generation rather than failed over
    // a stamp the source can no longer read.
    const again = await agentOn(scoped, 'sess-stale-again', 'stale')

    expect(toolNames(scoped, again)).toEqual(['before'])
    expect(livePresetMounts().filter(mount => mount.presetId === 'stale')).toHaveLength(1)
  })
})
