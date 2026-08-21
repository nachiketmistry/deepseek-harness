# dsh-agent-presets-filesystem

English | [中文](README.zh.md)

The **filesystem Service Provider** of the agent-preset source seam ([`dsh-agent-presets`](../agent-presets/README.md) owns the `AgentPresetSource` Service Definition and the registry that consumes it). A preset is a directory holding one `agent.cordis.yml`, optionally beside a `preset.yml` with display text; the directory name is the preset id. Loading this plugin populates `ctx.agentPresetSource`, which the roster row injects.

```yaml
- id: agent-preset-source
  name: '@deepseek-ai/dsh-agent-presets-filesystem'
  config:
    includeUserRoot: true
- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: standard
```

## Service Provider: `FilesystemAgentPresetSource` (ctx key: `agentPresetSource`)

- `list()` Scans every root in precedence order, earlier root winning a duplicate id. Discovery is unmemoized — every call re-reads the roots — so a preset authored while the process runs is visible immediately and a deleted one disappears from the next read. Discovery also owns preset **health**: a directory whose composition is missing or unloadable (unparsable YAML — checked with the loader's own dialect, `!!js` included — or not a list of named plugin rows) is listed with a `broken` reason rather than skipped, because a skipped directory would still occupy its id on disk while every surface shows nothing to delete. A directory whose name is not a usable preset id (`[a-z0-9][a-z0-9-]*`) is skipped outright: no copy could ever claim it.
- `stamp(preset)` The composition file's `mtimeMs:size`, or `undefined` when the file cannot be statted. Size is the tiebreak for an edit that lands within one mtime tick.
- `composition(preset)` Stats the file FIRST, then reads and parses it in the loader dialect (`entryListSchema`, so `!!js` scalars stay expression nodes); an edit racing the read therefore leaves the stamp stale rather than silently current. Rejects when the document is not a top-level list. The returned `baseUrl` is the preset directory, so a relative row (`./plugin.js`) and a skill directory travel with the preset.
- `read(preset)` The file's text exactly as stored.
- `authorable` Whether any scanned root has `user` trust.
- `copy(source, id, name?)` / `remove(preset)` The whole-directory authoring writes described under [Authoring](#authoring).
- `roots: readonly PresetRoot[]` The roots this source scans — every configured root in order, then the derived harness-home root unless `includeUserRoot` is false. Resolved once, when the service is constructed: a root set that changed between a `list()` and the `copy()` acting on its answer would author into a directory the caller never saw.

`AgentPreset.path` is the absolute path of the preset's composition file; the preset directory is its parent, which is what the Web host opens for a locally authored preset.

The module also exports the pieces a host or test composes directly: `COMPOSITION_FILE`, `METADATA_FILE`, `USER_PRESET_DIR`, `discoverPresets`, `scanRoot`, `readPresetMetadata`, `renderPresetMetadata`, `writableRoot`, `readComposition`, `copyComposition`, and `deleteComposition`.

## Config

| Field | Default | Meaning |
|---|---|---|
| `roots` | `[]` | Scanned directories in precedence order; each supplies `path` (a leading `~` expands) and `trust` (defaults to `user`) |
| `includeUserRoot` | `true` | Append `<dshHome>/.agent-presets` as a `user` root, after every configured root |

An absent root supplies no presets rather than failing: the user root does not exist until the first locally authored preset, and naming a default no root supplies already fails loud at the registry's resolution.

### The writable root is this package's, the shipped root is the app's

`<dshHome>/.agent-presets` is where a person's own presets live, the way `<dshHome>/skills` is where their own skills live ([`dsh-skill-filesystem`](../../skill/skill-filesystem/README.md)), so the source derives it rather than waiting for a deployment to remember it — a launcher that configures nothing still finds and authors presets. It is appended AFTER every configured root, which keeps an earlier root winning a duplicate id: a shipped `standard` still shadows a home directory that claimed the name, and the registry refuses that id rather than landing a preset nothing would resolve.

`includeUserRoot: false` supplies presets from `roots` alone. A deployment that confines presets to its own directories needs it, and so does any test pinning an exact roster — otherwise the machine's real `<dshHome>` decides what the roster contains.

The SHIPPED root stays an assembly fact: it sits beside the installed app's own config, a path only that app can resolve, and `apps/cli` patches it onto this row at boot.

## Authoring

A new preset is a whole-directory copy of an existing one — composition, metadata, skill directories, assets — landed under the first `user` root. `copy()` refuses two things before anything lands:

- **An id that is not `[a-z0-9][a-z0-9-]*`.** The id becomes a directory name, so containment is a property of the id itself rather than of a path check after the fact — `../escape`, `a/b`, and an absolute path are all rejected as ids.
- **A directory occupying the name on disk**, whether or not discovery lists it as a preset. A copy never overwrites. Discovery lists such a directory as a broken preset, so the refusal's way out — delete it — is on the same page that reported it. (The registry refuses an id any root supplies before this check runs.)

A failed copy rolls its half-made directory back rather than leaving one discovery cannot see. The copied tree is re-tightened to owner-only (`0o600` files keeping their owner-execute bit, `0o700` directories), symlinks are dereferenced so the copy is self-contained, and the root is created on first copy — a deployment configuring a user root that does not exist yet is the normal first-run state. The copied `preset.yml` is rewritten: the source's description is kept for the author to edit in place, but its name and roster `order` are dropped — a copy presenting itself identically to its source, or sorted into the shipped set's declared order, would make the roster stop distinguishing them.

`remove()` refuses a preset that ships with the deployment (`system` trust) and a `user` preset that does not live under the FIRST `user` root; the shipped set is the known-good compositions copies start from.

### Display metadata

A preset may publish display text in an optional `preset.yml` beside its composition:

```yaml
name: 极简模式
description: 仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。
order: 1
```

It carries display text ONLY. `id` is the directory name and `trust` comes from the root the preset was discovered under, so neither is writable here — otherwise a locally authored preset could name itself into the shipped set. It is a separate file because the composition is a top-level list of plugin rows: YAML cannot carry sibling keys beside it, and a fake metadata row would hand the Loader something to load. `order` sorts a preset within its group; presets that declare none sort after those that do, then by id.

Every read failure degrades to no metadata — absent, malformed, wrongly typed, or blank all mean the same thing, and a picker falls back to the id. Presentation is not capability: a preset with a broken name still mounts.

## Model Experience

Indirectly, through [`dsh-agent-presets`](../agent-presets/README.md), whose standing mount installs the rows this source reads; those plugins own every tool schema and prompt section a preset makes visible.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **A preset outside the writable root is discoverable but not deletable** — `remove()` refuses anything that does not live under the FIRST `user` root, so a deployment that configures its own writable root while leaving `includeUserRoot` on lists the harness-home presets, mounts them, and then answers "it does not live under the writable preset root" for every delete. The source carries one writable root by design; a deployment that wants only its own sets `includeUserRoot: false`.
- **The stamp is the composition file alone** — `agent.cordis.yml` changing starts a new generation in the registry, an edit to a skill file or asset beside it does not; those reach new sessions only once the composition file itself moves or the process restarts.
- **Health is a shape check, not a mount** — discovery proves the composition parses in the loader dialect and holds named rows, not that every row's module resolves or activates; a row naming an absent package still fails at the first session, which rolls the creation back.
- **Root scans are not watched** — every read hits the filesystem instead, which keeps the roster fresh but puts one `readdir` per root plus one read-and-parse per preset on each `list()`.
