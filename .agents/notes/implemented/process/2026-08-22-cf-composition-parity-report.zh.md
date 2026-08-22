# Agent Note: Cloudflare 部署的组合对等报告

Status: implemented

[English](2026-08-22-cf-composition-parity-report.md) | 中文

## Problem

Cloudflare web host 就是 web 组合减去无法在 workerd 上运行的行，再加上顶替它们的 `packages/cf/*` Provider。第一版装配把这个减法表达为一个从包名到散文原因的 `Map`，外加一张独立的替换行表，并且只作用于 host 平面：preset 行走的是同一个 transform，却带着空的替换表，因此任何指向被排除包的 preset 行都会被丢弃 —— 没有替代、没有报错、也没有记录。

于是部署带着缺失的能力上线，而没有任何东西说出这一点。两个随发的 preset 都在一个没有任何 Provider 注册进去的 `skills` 注册表之上挂载 `tool-skill`，因此模型拿到的加载器目录永远是空的。`code` preset 挂载了 `tool-presentation`，它会永远等待 `codeRuntime`，于是这个为 Code Mode 而存在的 preset 提供的是原生工具。host 挂载了 workflow 运行 UI，背后却没有工作流引擎。这些都是靠手工阅读生成出的组合才发现的，而这不是任何人默认能拿到的信号。

## Decision

一处声明同时决定构建如何处置一行，以及报告如何描述它。`apps/cf-web/scripts/composition.mjs` 为 CF 构建不按原样挂载的每一个 web 组合行给出一种处置方式：`replaced`（连同替代行，或由 Worker 入口在组合之前挂载的替代物）、`not-applicable`（仅开发期的工具、其他平台、可选目录），或 `gap`（本部署不具备的能力，并列出仍然挂载、依赖它的行）。`CF_SKIPPED_PRESETS` 对不随发的 preset 目录做同样的事。

`compose.mjs` 在两个平面上应用这些处置方式，并把每一个被处置的行记入账目。若某个 preset 行的包在 host 平面上是被替换的，除非其处置方式说明 preset 该怎么做，否则构建失败：host 平面的替换在 preset 内部并不自动成立 —— 在那里，单例 Provider 的第二份副本会在 boot 时抛错。

`scripts/parity.mjs` 把处置方式与账目投影为 [composition-parity.md](../../../../apps/cf-web/composition-parity.md) —— 能力缺口及其状态与失依赖方、逐行的 host 平面、以及各 preset 相对 web 应用的行数。`build` 脚本会运行它，因此报告跟踪的是被部署的那个 bundle；`parity:check` 在签入文件过期时失败。

生成器拒绝写出自己无法担保的报告。以下情况一律失败：为 web 组合已不再携带的行保留处置方式、缺口声称某个组合已不再挂载的失依赖方、组合与 `src/worker.ts` 都没有挂载的替换、没有指名任何替代物的 `replaced` 处置方式，以及目录已消失的 skipped preset。

## Alternatives considered

- **在 README 或 Agent Note 里手写一份清单** —— 否决：它要列出的事实，恰恰是已经从 README 漂移掉的那些 —— 在 Host Durable Object 落地之后，README 仍把 `src/worker.ts` 描述为占位。一份由构建之外维护、而非由构建维护的清单，其腐坏速度与它所跟踪之物相同。
- **只要存在缺口就让构建失败** —— 否决：Code Mode、工作流引擎与 `cordis-host-runner` 需要 `node:worker_threads` 或 `node:vm`，按决策不在范围内。无法表达"已知且已接受"的门禁会被关掉，而关掉门禁正是未知缺口藏身于已知缺口之中的原因。这个区分由 `status` 承担，失败的则是过期声明检查。
- **推导失依赖方而非声明它们** —— 暂时否决：模块层级的 `inject` 可以从已构建的包中读出，但这里真正要紧的损失是注册表式接缝（`skills` 有注册表却无注册项）以及插件体内部的惰性 `ctx.inject`，二者都不是静态读取能报告的。声明依赖方并校验每一个仍被挂载，在不推断关系的前提下给出同等的防腐保护。

## Consequences

一项能力离开 Cloudflare 部署，如今是签入报告里的一处 diff，而不是靠戳运行中的应用才发现的东西，并且两个平面由同一套规则变换。代价是一份需要维护的声明：从 CF 组合中排除一个新行，在写出其处置方式之前不会构建通过；而一个缺口必须写明它的代价以及仍有什么依赖它。

该报告是生成物而非译文：与 `gate0-imports.md` 一样，它没有中文对照。

它在撰写时记录的未决缺口是 skills 与 `minimal` preset；工作流引擎、Code Mode 与自我修改被记为超出范围，由 [Cloudflare web host 提案](../../proposed/architecture/2026-08-21-cloudflare-web-host.zh.md)跟踪。
