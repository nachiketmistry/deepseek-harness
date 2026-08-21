# dsh-agent-presets

English | [中文](README.zh.md)

Per-preset agent composition. A **preset** is one list of plugin rows (an `agent.cordis.yml` on disk, or an entry in a bundled table); the roster mounts it ONCE per process under a standing scope, and each session that names it joins by having its agent scope key parented to the mount's (`dsh-scope`'s parent chain). The mount's tools, prompt sections, and projection units exist exactly once and cover every joined agent — its plugins key their state by Session/Agent, so sessions stay apart inside one shared instance — and a host reader with no agent at all (a cold transcript read) resolves the same standing registrations by preset id.

This package is the **Service Definition and Consumer** half of the agent-preset source seam: it owns the preset vocabulary, the `AgentPresetSource` contract, and the guarded standing mount over rows the source hands it. Where presets come from is the composed **Service Provider**'s business — [`dsh-agent-presets-filesystem`](../agent-presets-filesystem/README.md) discovers preset directories under configured roots and is what every shipped composition mounts; a host without a disk supplies presets from a bundled table instead. The registry requires a source: it injects `agentPresetSource`, so a composition that mounts `agent-presets` mounts a source row before it.

The mechanism is two seams. Entry contexts chain to the context a subtree was plugged into, and both [`dsh-tools`](../../core/tools/README.md) and [`dsh-system-prompt`](../../core/system-prompt/README.md) file registrations into the calling context's scope layer — so the standing mount's contributions land in the PRESET's layer. What carries them to each session is `dsh-scope`'s parent chain: an agent's views resolve `agent → preset → global` (nearest shadowing farthest), and the mount's listeners are admitted for every agent parented under it while a sibling preset's stay deaf.

## Service Definition: `AgentPresetSource` (ctx key: `agentPresetSource`)

Where one deployment's presets come from and how they are authored. A provider extends the abstract class and implements:

- `list(): Promise<AgentPreset[]>` Every preset the source supplies, in display order, broken ones included with their `broken` reason. Unmemoized by contract: each call reflects the source's current state.
- `stamp(preset): Promise<string | undefined>` Opaque identity of the preset's current composition; a changed value starts a new standing generation for sessions created afterwards, and `undefined` (the composition cannot be read) serves the generation already mounted.
- `composition(preset): Promise<PresetComposition>` The rows to mount — raw Loader entry options with `!!js` expression nodes preserved — the stamp they were read under, and the `baseUrl` relative row specifiers resolve against (absent when the source has no files). Rejects when the composition cannot be read or is not a list of rows; a first mount that hits that rejection fails with `PresetMountError`.
- `read(preset): Promise<string>` The composition's source text, for the authoring read.
- `authorable: boolean` Whether `copy`/`remove` can succeed for some preset.
- `copy(source, id, name?)` / `remove(preset)` The two authoring writes; `copy` may throw `InvalidPresetIdError`, `PresetExistsError`, or `PresetNotWritableError`, all declared here so every consumer reports a source's refusal the same way.

`AgentPreset.path` is the source-owned locator: the filesystem source stores the composition file's absolute path, and a host that opens preset documents uses its directory; another source may use a non-file locator, and the host then reports `opened: false` with it rather than treating it as a directory. `PRESET_ID` (`[a-z0-9][a-z0-9-]*`) is the id vocabulary every source shares, because a source may turn the id into a path segment.

## Registry: `AgentPresets` (ctx key: `agentPresets`)

The roster is unmemoized: `list()` and `resolve()` ask the source on every call, so a preset authored while the process runs is visible immediately and a deleted one disappears from the next read. The source owns preset **health**: a preset whose composition is missing or unloadable is listed with a `broken` reason rather than skipped, and every mounting path refuses it up front with that reason.

- `ctx.agentPresets.defaultId: string` The preset id mounted when a caller names none.
- `ctx.agentPresets.list(): Promise<AgentPreset[]>` Every preset the source currently supplies; broken presets included, each carrying its reason.
- `ctx.agentPresets.resolve(id?): Promise<AgentPreset>` One preset by id, defaulting to `defaultId`. Throws naming the available ids when the source supplies none under it. A broken preset resolves — deleting, reading, and reporting one all need the row.
- `ctx.agentPresets.mount(agentCtx, id?): Promise<AgentPreset>` Compose one agent from a preset — ensure its standing mount (single-flight) and parent the agent's scope key to it — returning the preset for the caller to record. Refuses a broken preset up front with its source-reported reason, so every unloadable shape fails the same way before the loader is involved.
- `ctx.agentPresets.composeFrom(agentCtx, parentCtx): string | undefined` Join one agent to the standing composition another already runs on, returning the preset id joined — `undefined` when the parent joined none, which is the rosterless deployment and not an error. A bind rather than a mount, so it is synchronous and has no composition failure mode; it still rejects a caller error (an unscoped context, or an agent that already joined).
- `ctx.agentPresets.composedPreset(agentCtx): string | undefined` The preset one LIVE agent runs on, read from its scope chain rather than from its session — the only answer available for an agent whose durable header is still being built.
- `ctx.agentPresets.recompose(agentCtx, id): Promise<AgentPreset>` Re-link one agent to a different preset's standing composition. Valid only while the agent has produced nothing — **the caller owns that check**; the new mount is ensured before the link moves, so a failure leaves the agent as it was. Refuses a broken preset like `mount()`.
- `ctx.agentPresets.standingKeyFor(id?): Promise<ScopeKey>` The standing scope key a host reader with no agent (a cold transcript read) resolves preset registrations in; ensures the mount without starting an agent, session, or turn. Refuses a broken preset like `mount()`.
- `ctx.agentPresets.authorable: boolean` The source's answer to whether a preset can be created at all.
- `ctx.agentPresets.read(id): Promise<string>` One preset's composition text, exactly as stored.
- `ctx.agentPresets.copy(from, id, name?): Promise<void>` Create a locally authored preset by copying an existing one whole — the only authoring write. No composition text crosses this seam, so a copy is exactly as loadable as its source. The registry refuses an id the source already supplies (a user preset named like a shipped one would be shadowed by it) before the source's own occupancy check runs; the rest of the refusals and the copy itself are the source's.
- `ctx.agentPresets.remove(id): Promise<void>` Delete a locally authored preset; joined sessions keep their standing mount. Clears the user default when it named the preset just deleted: storing a default that does not exist yet is deliberate, but one this call removed will never be supplied again and would fail every session created without an explicit pick.

`AgentPreset` carries `id`, `trust` (`system` or `user`, from the location it was supplied from), `path` (the source-owned locator), optional display `name`/`description`/`order`, and — only when the preset cannot compose a session — `broken` (one human-readable reason, shown verbatim on roster surfaces).

### Where to call `mount()`

The agent factory's `setup(agentCtx)` hook is the one supported call site. Only there is the join installed while the agent is still unpublished, so a rejected composition rolls the whole creation back rather than leaving a half-composed session. The standing subtree is owned by the roster service's own fiber — deliberately its UNTRACED context, because a subtree minted from a traced `this.ctx` resolves every service through the caller's shadow fiber instead of each entry's own inject store — so it survives every agent and unwinds only with the whole tree. Each generation records the source stamp its rows were read under: a session that finds the stamp stale starts the next generation, while every session already joined keeps the one it runs on — the composition a running session joined outlives its source changing or disappearing underneath it, and editing the source is the only composition editor, so the stamp is what carries an edit to later sessions.

### Composing a child agent

A subagent's child joins its parent's standing composition through `composeFrom()`, never through `mount()`. Every model-facing row lives on the agent plane, so the tool registry's global layer is empty and a child that joins nothing reaches the model with no tools at all and none of its parent's prompt sections.

Re-mounting the parent's preset by id would differ from the bind in two ways that both matter. A composition file edited since the parent started would hand the child a DIFFERENT generation than the one its parent's history was produced under, and a preset deleted since would fail the child outright while its parent keeps running. The bind is also synchronous, which is what lets the in-process subagent drivers use it at all — they compose their children inside a synchronous creation window.

The child records the joined id on its own durable header ([`dsh-subagent`](../../subagent/subagent/README.md)), so a cold read of the child's history rebuilds the composition it actually ran under rather than the deployment default.

### Which preset a session runs

The creation header names the preset a session STARTED with; `resolveSessionPreset(session)` names the one it RUNS. They differ whenever a blank session switched, so every reconstruction path — the summary a picker reads, a resume, a fork — resolves rather than reading the header.

The header stays frozen because it is a creation fact. A switch is an `agent-preset/selected` session event appended after the swap commits, which is what the model-visible ⟺ logged rule requires: the preset decides the tool schemas and prompt sections the model sees, so it has to be reconstructable from the log. The service re-emits that committed fact as the non-scoped cordis event `agent-preset/selected(sessionId, agentPreset)` declared by the client-safe `./types` export, allowing remote consumers to invalidate session-derived state without importing Host runtime types. Reading the header alone would rebuild a switched session under the composition it was created with, replaying history the new tool set cannot act on — the exact hazard the blank-only lock exists to prevent.

### Switching a blank agent

`recompose()` unmounts the installed subtree and mounts the new one, because two compositions cannot coexist — both would register the same tool names into one layer. A failed mount restores the previous composition rather than leaving the agent with nothing, and an unknown id is rejected before anything is torn down.

The restriction to a produced-nothing agent is a product rule, not a mechanical one: swapping tools mid-conversation would leave logged tool calls the new composition cannot make. The gateway enforces it at the wire ([`dsh-apiproxy`](../../host/apiproxy/README.md) answers `agent-preset-locked`), which is where session history is in hand.

## Authoring

Authoring is copy-only. A new preset is a whole copy of an existing one; the inputs are two ids the registry resolves against its source plus an optional display name, so no caller ever supplies composition text and a copy grants nothing the roster did not already carry. The registry refuses an id the source already supplies — shipped ones included, since a user preset named like a shipped one would be shadowed by it — and hands everything else to the source: id containment (`PRESET_ID`), occupancy at the writable location, the copy itself, and what `remove()` may delete. The filesystem source's rules are on [its README](../agent-presets-filesystem/README.md#authoring).

### How a preset's rows mount

The source hands the registry parsed rows, and the mount plugs them as an in-memory Loader entry tree under the standing scope — the same tree for every source, with one file-specific fact carried along: the `baseUrl` relative specifiers resolve against. The rows are cloned per mount, because the Loader stores each row's options by identity and writes into them (`disabled`, generated ids); a source handing out one shared row set never sees one generation's state in the next.

A row's **package name** resolves from the host composition, not from the preset's base. The Loader normally resolves an entry against its own tree's `baseUrl`; a locally authored preset lives under the user's home, where Node's upward `node_modules` walk never reaches the harness, so every `@deepseek-ai/dsh-*` row would fail to import. The mount records the host base before plugging the subtree and sends bare specifiers there.

A **relative** path resolves from the composition's `baseUrl` — for a preset directory, the directory itself — so a preset's own plugin files and skill directories travel with it. A source with no files supplies no `baseUrl`, and a relative row cannot resolve there.

An **absolute** filesystem path keeps its own location. The mount converts it to a `file:` URL before ESM import so POSIX paths and Windows drive-letter or UNC paths use a specifier Node accepts.

## Config

| Field | Default | Meaning |
|---|---|---|
| `default` | required | Preset id mounted when a caller names none |

Where presets live is the source row's config ([filesystem source](../agent-presets-filesystem/README.md#config)). The shipped Web composition mounts the filesystem source directly before this row; `apps/cli` patches the shipped root onto that source row at boot.

### The default preset is a user setting

When a settings provider is composed, this plugin registers the `agent-presets` namespace with `config.default` as its composition base, so the user document layers over the deployment's engineering default:

```yaml
agent-presets:
  default: minimal
```

The value is read per resolution rather than snapshotted, so a hot-reloaded document takes effect on the next session created and every running session stays on the preset it was composed from. Clearing the user field re-inherits the composition default. A default naming a preset the source does not supply is stored without complaint and fails at the next `resolve()` — the roster is live, so a name absent now may exist by the time a session asks for it.

## What a mount rejects

A directly-plugged subtree is absent from `ctx.loader.entries()`, so no boot audit covers it. `mount()` therefore proves the result usable itself, and rejects three things.

**An unscoped target.** Mounting into a context that carries no agent scope would register the preset's tools globally, for every agent in the process.

**A row that never became usable.** The loader already rejects a row whose module failed to import or whose plugin threw; what remains is a row still waiting for a service the composition never supplies, which the audit names.

**A row that published a service into the root realm.** Such a service is process-global, so the second preset publishing the same name collides with the first, and a host reader would resolve one preset's instance for every session. A preset that genuinely owns a service puts it behind an `isolate` realm — entry-local realms keep two presets' same-named services apart exactly as they once kept two sessions' apart — or the service belongs in the host composition instead.

The package invariant re-checks that last rule on every service notification, because a row that publishes from a timer or an asynchronous continuation would escape the one-shot audit.

## A composition is an input, never a persistence target

The Loader writes a tree back through `EntryTree.write()` whenever it decides the config changed, and a row disposing its own fiber is enough to decide that: the entry is marked `disabled` and the tree is written. A file-backed tree would burn one session's runtime state into a file every session shares — comments stripped by the YAML round trip, and a `writeFile` rejection inside a `setTimeout` for a read-only shipped preset.

The mounted subtree is in-memory and its `write()` is a no-op. Nothing in this package writes a composition; authoring one is the source's explicit operation.

## Trust

Presets are compositions, so a preset is exactly as privileged as the plugins it names. A `user` preset — authored by a person or by an agent — carries the same trust as shell access; the `trust` field exists so consumers can present that difference, not to enforce it.

## Model Experience

Indirectly, through the plugins a standing composition registers, which own every tool schema and prompt section the preset makes visible to the agents joined to it.

#### KV Cache effect

Prefix-stable for the life of an agent: a composition is installed once, before the agent is published and therefore before its first request, and is never re-read while the agent runs. Choosing a different preset for a new session establishes a different prefix for that session alone and cannot invalidate reuse for any session already running.

## Known Limitations and Deferred Work

- **A preset cannot be changed once a session has produced anything** — `recompose` re-links a BLANK session's parent scope to another standing mount, and only a blank one: switching a composition that already ran would strand tools the model has called. Changing the default affects only sessions created afterwards.
- **A generation is keyed on the source stamp alone** — the stamp is the source's identity for the composition rows; an edit to a skill file or asset beside them reaches new sessions only once the stamp itself changes or the process restarts.
- **A superseded generation is never reclaimed** — sessions already joined keep the generation they run on, and the roster holds no join count that could tell when the last one left, so the whole subtree stays mounted until the process ends. The cost is per generation rather than per session, but it is not free: `dsh-skill-filesystem` watches its roots by default, so each edit-then-create cycle adds a live watcher set. Bounded by how often compositions are edited — which the settings-page authoring flow makes a per-save event rather than a per-deploy one. Reclaiming one needs a joined-agent count on the standing mount; see the `TODO` at `ensureStanding`.
- **A copy is never mounted to validate** — it is a whole copy of its source, so a source broken at the source yields a copy exactly as broken; the source's health check marks both rows on the next roster read rather than deferring the failure to a session start.
- **Health is the source's shape check, not a mount** — a source proves the composition is a list of rows it can read, not that every row's module resolves or activates; a row naming an absent package still fails at the first session, which rolls the creation back.
- **A copy is a snapshot that drifts** — upgrading the deployment does not update copies of shipped presets, and there is no patch semantics at this layer to express "standard plus one change" (that is the bundle layer's `cordis.patch.yml`); the shipped set itself accepts the same cost — `cordis` and `code` are full copies of `standard` — so the whole assembly stays readable in one file.
- **A source with no files cannot mount relative rows** — `PresetComposition.baseUrl` is what a `./plugin.js` row resolves against, so a bundled-table source supplies package names or absolute locations only.
