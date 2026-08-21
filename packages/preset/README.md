# preset/ — per-session agent composition

English | [中文](README.zh.md)

An **agent preset** is one list of plugin rows — on disk, a directory holding one `agent.cordis.yml`. Mounting it under an agent's scope context gives that session its own tools and prompt sections while every other live session keeps its own, so one process can run several differently composed agents at once.

| Package | Role | ctx key |
|---|---|---|
| `agent-presets/` | Preset vocabulary, the `AgentPresetSource` Service Definition, and the guarded standing mount over the rows a source supplies | `ctx.agentPresets` |
| `agent-presets-filesystem/` | Filesystem Service Provider of the source: preset directories under trusted and user-authored roots, stat-stamped compositions, copy/remove authoring | `ctx.agentPresetSource` |
| `persona/` | The agent persona as a composable row, so a preset can change identity and not only tools | — |

The presets the deployment ships live in [`apps/cli/config/agent-presets/`](../../apps/cli/config/agent-presets) — one directory each, and that directory listing is the roster. Naming them here too would be a second list to keep in step, and the first one to fall behind.

The composition split this group assumes: registries and cross-session facilities are process singletons and stay in the host composition, while a preset carries what one agent contributes to them. A preset that names a row publishing a process-global service is rejected at mount rather than allowed to collide with the next session.

Design: [the per-session agent-preset note](../../.agents/notes/implemented/architecture/2026-08-03-per-session-agent-presets.md).
