# Agent Note: Cloudflare 部署的组合对等报告

Status: implemented

[English](2026-08-22-cf-composition-parity-report.md) | 中文

## Problem

Cloudflare web host 就是 web 组合减去无法在 workerd 上运行的行，再加上顶替它们的 `packages/cf/*` Provider。第一版装配把这个减法表达为一个从包名到散文原因的 `Map`，外加一张独立的替换行表，并且只作用于 host 平面：preset 行走的是同一个 transform，却带着空的替换表，因此任何指向被排除包的 preset 行都会被丢弃 —— 没有替代、没有报错、也没有记录。

况且，一份"挂载了什么"的报告本来就只回答了一半问题。一个替代物可以被挂载、被打包、在 workerd 上求值通过，同时从每个方法抛错，或在 Service Definition 承诺给出值的地方什么也不返回，而组合本身分辨不出差别。

于是部署带着缺失的能力上线，而没有任何东西说出这一点。两个随发的 preset 都在一个没有任何 Provider 注册进去的 `skills` 注册表之上挂载 `tool-skill`，因此模型拿到的加载器目录永远是空的。`code` preset 挂载了 `tool-presentation`，它会永远等待 `codeRuntime`，于是这个为 Code Mode 而存在的 preset 提供的是原生工具。host 挂载了 workflow 运行 UI，背后却没有工作流引擎。这些都是靠手工阅读生成出的组合才发现的，而这不是任何人默认能拿到的信号。

## Decision

一处声明同时决定构建如何处置一行，以及报告如何描述它。`apps/cf-web/scripts/composition.mjs` 为 CF 构建不按原样挂载的每一个 web 组合行给出一种处置方式：`replaced`（连同替代行，或由 Worker 入口在组合之前挂载的替代物）、`not-applicable`（仅开发期的工具、其他平台、可选目录），或 `gap`（本部署不具备的能力，并列出仍然挂载、依赖它的行）。`CF_SKIPPED_PRESETS` 对不随发的 preset 目录做同样的事。

`compose.mjs` 在两个平面上应用这些处置方式，并把每一个被处置的行记入账目。若某个 preset 行的包在 host 平面上是被替换的，除非其处置方式说明 preset 该怎么做，否则构建失败：host 平面的替换在 preset 内部并不自动成立 —— 在那里，单例 Provider 的第二份副本会在 boot 时抛错。

`scripts/parity.mjs` 把处置方式与账目投影为 [composition-parity.md](../../../../apps/cf-web/composition-parity.md) —— 能力缺口及其状态与失依赖方、逐行的 host 平面、以及各 preset 相对 web 应用的行数。`build` 脚本会运行它，因此报告跟踪的是被部署的那个 bundle；`parity:check` 在签入文件过期时失败。

`scripts/fidelity.mjs` 回答另一半。它扫描每个替代物自身的源码，找出方法体为单条无条件 `throw`、空方法体，或单条返回缺省值的 `return`，`parity.mjs` 再把这些发现与指名该替代物的处置方式上的 `reduced` 清单对账：未声明的发现，以及源码已不再成立的声明，两个方向都会失败。`degraded` 陈述扫描看不到的平台限制 —— Sandbox SDK 不暴露进程 stdin、passthrough sandbox 报告 `partial` 强制等级 —— 报告会把它标注为声明而非推导，以免被当作已验证。

只认缺省值字面量：一个能力 getter 回答 `true`，声明的是本部署具备该能力，而这正是 Service Definition 索要的答案形状。从真实工作里返回 `true` 的桩，是被接受的盲区。

测试数量只报告、不强制。`pnpm run test:coverage` 才是拥有这项事实的门禁 —— 对 `packages/*/*/src` 逐文件 100%，且没有为 `packages/cf` 开豁免 —— 让两道门禁断言同一件事只会削弱其中一道。

生成器拒绝写出自己无法担保的报告。以下情况一律失败：为 web 组合已不再携带的行保留处置方式、缺口声称某个组合已不再挂载的失依赖方、组合与 `src/worker.ts` 都没有挂载的替换、没有指名任何替代物的 `replaced` 处置方式，以及目录已消失的 skipped preset。

## Alternatives considered

- **在 README 或 Agent Note 里手写一份清单** —— 否决：它要列出的事实，恰恰是已经从 README 漂移掉的那些 —— 在 Host Durable Object 落地之后，README 仍把 `src/worker.ts` 描述为占位。一份由构建之外维护、而非由构建维护的清单，其腐坏速度与它所跟踪之物相同。
- **只要存在缺口就让构建失败** —— 否决：Code Mode、工作流引擎与 `cordis-host-runner` 需要 `node:worker_threads` 或 `node:vm`，按决策不在范围内。无法表达"已知且已接受"的门禁会被关掉，而关掉门禁正是未知缺口藏身于已知缺口之中的原因。这个区分由 `status` 承担，失败的则是过期声明检查。
- **对没有测试的 Provider 直接让构建失败** —— 否决：`test:coverage` 已经对每一个 `packages/cf/*` 源文件失败，第二道断言同一件事的门禁，正是会被开豁免的那一道。对等报告陈述数量，并指向真正强制它的门禁。
- **推导失依赖方而非声明它们** —— 暂时否决：模块层级的 `inject` 可以从已构建的包中读出，但这里真正要紧的损失是注册表式接缝（`skills` 有注册表却无注册项）以及插件体内部的惰性 `ctx.inject`，二者都不是静态读取能报告的。声明依赖方并校验每一个仍被挂载，在不推断关系的前提下给出同等的防腐保护。

## Consequences

一项能力离开 Cloudflare 部署，如今是签入报告里的一处 diff，而不是靠戳运行中的应用才发现的东西，并且两个平面由同一套规则变换。代价是一份需要维护的声明：从 CF 组合中排除一个新行，在写出其处置方式之前不会构建通过；而一个缺口必须写明它的代价以及仍有什么依赖它。

该报告是生成物而非译文：与 `gate0-imports.md` 一样，它没有中文对照。

撰写时 fidelity 扫描记录了四处削减 —— Worker 载体没有绑定地址、没有可定位的独立会话产物、没有可写入的 preset 位置，以及 Sandbox SDK 的 stdin 与信号限制 —— 其中用户真正会遇到的是 preset 只读：本部署的 GUI 无法复制或编辑 preset。它同时记录了 16 个替代物中有 15 个没有测试套件。

它在撰写时记录的未决缺口是 skills 与 `minimal` preset；工作流引擎、Code Mode 与自我修改被记为超出范围，由 [Cloudflare web host 提案](../../proposed/architecture/2026-08-21-cloudflare-web-host.zh.md)跟踪。
