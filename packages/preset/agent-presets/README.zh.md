# dsh-agent-presets

[English](README.md) | 中文

按 preset 组装 agent（智能体）。**preset** 是一份插件行列表（磁盘上的一份 `agent.cordis.yml`，或内置表中的一项）；roster 在整个进程内只把它挂载一次（常驻 scope），命名它的每个会话通过把自己 agent 的 scope key 认父到该挂载（`dsh-scope` 的父链）来加入。挂载的工具、提示词段落与投影单元只存在一份，覆盖所有已加入的 agent——其插件本就按 Session/Agent 分键存状态，会话在共享实例内互不串扰——而完全没有 agent 的宿主读取方（冷读记录）也能按 preset id 解析到同一份常驻注册。

本包是 agent-preset 来源 seam 的 **Service Definition 与 Consumer** 一半：它拥有 preset 词汇、`AgentPresetSource` 契约，以及对来源交来的行做受保护常驻挂载的机制。preset 从哪里来是所组装的 **Service Provider** 的事——[`dsh-agent-presets-filesystem`](../agent-presets-filesystem/README.zh.md) 在已配置的根目录下发现 preset 目录，是所有随附组装都挂载的提供方；没有磁盘的宿主则从内置表提供 preset。注册表要求必须有来源：它注入 `agentPresetSource`，因此挂载 `agent-presets` 的组装要先挂载一行来源。

其机制是两条 seam。entry 上下文沿原型链连到子树被挂载时所在的上下文，而 [`dsh-tools`](../../core/tools/README.zh.md) 与 [`dsh-system-prompt`](../../core/system-prompt/README.zh.md) 本就按调用方上下文的 scope 分层归档注册——因此常驻挂载的贡献落在 **preset 的分层**里。把它们送达每个会话的是 `dsh-scope` 的父链：agent 的视图按 `agent → preset → global` 解析（近者遮蔽远者），挂载的监听器对认父到它的每个 agent 放行，而兄弟 preset 的监听器保持失聪。

## Service Definition：`AgentPresetSource`（ctx 键：`agentPresetSource`）

一个部署的 preset 从哪里来、如何创作。提供方继承该抽象类并实现：

- `list(): Promise<AgentPreset[]>` 该来源提供的全部 preset，按展示顺序排列，损坏的也在其中并携带 `broken` 原因。契约上不做缓存：每次调用都反映来源的当前状态。
- `stamp(preset): Promise<string | undefined>` 该 preset 当前组装的不透明身份；值变化即为此后创建的会话开启新的常驻代际，`undefined`（组装无法读取）则继续提供已挂载的代际。
- `composition(preset): Promise<PresetComposition>` 要挂载的各行——原始 Loader entry 选项，保留 `!!js` 表达式节点——读取时所处的 stamp，以及相对行标识符据以解析的 `baseUrl`（来源没有文件时缺省）。组装无法读取或不是行列表时 reject；首次挂载遇到这种 reject 会以 `PresetMountError` 失败。
- `read(preset): Promise<string>` 组装的源文本，供创作时读取。
- `authorable: boolean` `copy`/`remove` 是否可能对某个 preset 成功。
- `copy(source, id, name?)` / `remove(preset)` 两种创作写入；`copy` 可能抛出 `InvalidPresetIdError`、`PresetExistsError` 或 `PresetNotWritableError`，三者都在本包声明，因此所有消费方以同一方式报告来源的拒绝。

`AgentPreset.path` 是来源自有的定位符：文件系统来源存放组装文件的绝对路径，打开 preset 文档的宿主使用其目录；其他来源可以使用非文件定位符，宿主此时会连同该定位符回答 `opened: false`，而不是把它当作目录。`PRESET_ID`（`[a-z0-9][a-z0-9-]*`）是所有来源共用的 id 词汇，因为来源可能把 id 变成路径片段。

## 注册表：`AgentPresets`（ctx 键：`agentPresets`）

roster 不做缓存：`list()` 与 `resolve()` 每次调用都询问来源，因此进程运行期间新写的 preset 立即可见，被删除的 preset 也会在下一次读取时消失。来源负责 preset 的**健康**：组装缺失或不可加载的 preset 会作为携带 `broken` 原因的行列出而不是被跳过，每条挂载路径都直接以该原因拒绝它。

- `ctx.agentPresets.defaultId: string` 调用方未指定时挂载的 preset id。
- `ctx.agentPresets.list(): Promise<AgentPreset[]>` 来源当前提供的全部 preset；损坏的 preset 也在其中，各自携带原因。
- `ctx.agentPresets.resolve(id?): Promise<AgentPreset>` 按 id 取一个 preset，缺省取 `defaultId`。来源不提供该 id 时抛错，并列出可用 id。损坏的 preset 照样解析——删除、读取与上报都需要这一行。
- `ctx.agentPresets.mount(agentCtx, id?): Promise<AgentPreset>` 用一个 preset 组装一个 agent——确保其常驻挂载（并发去重）并把 agent 的 scope key 认父到它——返回该 preset 供调用方记录。对损坏的 preset 直接以来源记下的原因拒绝，所以每种不可加载的形态都在加载器介入之前以同一方式失败。
- `ctx.agentPresets.composeFrom(agentCtx, parentCtx): string | undefined` 让一个 agent 加入另一个 agent 已在运行的常驻组装，返回所加入的 preset id——父方未加入任何 preset 时返回 `undefined`，那是无 roster 的部署，不是错误。这是认父而非挂载，因此同步、且自身没有组装失败模式；调用方用错（上下文无 scope、agent 已加入过）仍会拒绝。
- `ctx.agentPresets.composedPreset(agentCtx): string | undefined` 某个**活着的** agent 正在运行的 preset，从其 scope 链读取而不是从其会话读取——对于持久化 header 尚在构建中的 agent，这是唯一能拿到的答案。
- `ctx.agentPresets.recompose(agentCtx, id): Promise<AgentPreset>` 把一个 agent 重链到另一个 preset 的常驻组装。仅在该 agent 尚无任何产出时合法——**由调用方负责该检查**；新挂载在链移动之前确保完成，失败时 agent 原封不动。与 `mount()` 一样拒绝损坏的 preset。
- `ctx.agentPresets.standingKeyFor(id?): Promise<ScopeKey>` 没有 agent 的宿主读取方（冷读记录）解析 preset 注册所用的常驻 scope key；确保挂载而不启动任何 agent、会话或轮次。与 `mount()` 一样拒绝损坏的 preset。
- `ctx.agentPresets.authorable: boolean` 来源对「preset 是否可创建」的回答。
- `ctx.agentPresets.read(id): Promise<string>` 某个 preset 的组装文本，与存储内容逐字一致。
- `ctx.agentPresets.copy(from, id, name?): Promise<void>` 通过整体复制一个既有 preset 来创建本地创作的 preset——唯一的创作写入。组装文本不经过这道接缝，因此副本与其来源同等可加载。注册表先拒绝来源已提供的 id（与随附 preset 同名的用户 preset 只会被它遮蔽），然后才轮到来源自己的占用检查；其余拒绝与复制本身都由来源负责。
- `ctx.agentPresets.remove(id): Promise<void>` 删除一个本地创作的 preset；已加入的会话保留其常驻挂载。若用户默认值恰好指向刚删除的 preset 则一并清除：存一个尚不存在的默认值是刻意的，但本次删除的这个再也不会有人提供，留着会让所有未显式指定的新会话无法启动。

`AgentPreset` 携带 `id`、`trust`（`system` 或 `user`，取自提供它的位置）、`path`（来源自有的定位符）、可选的展示用 `name`/`description`/`order`，以及——仅当该 preset 无法组装会话时——`broken`（一条人类可读的原因，名单界面原样展示）。

### 应在何处调用 `mount()`

agent 工厂的 `setup(agentCtx)` 钩子是唯一受支持的调用点。只有在那里，认父是在 agent 尚未发布时完成的，因此组装被拒绝会让整次创建回滚，而不会留下一个组装到一半的会话。常驻子树归 roster 服务自己的 fiber 所有——刻意用其未追踪的上下文，因为从被追踪的 `this.ctx` 派生的子树会经调用方的 shadow fiber 解析一切服务、无视各 entry 自己的 inject store——所以它比任何 agent 都活得久，只随整棵树卸载。每个代际记录其各行读取时所处的来源 stamp：发现 stamp 过期的会话会开启下一个代际，而所有已加入的会话保持各自正在运行的那个——正在运行的会话所加入的组装在其来源被修改或删除后继续存活；编辑来源是唯一的组装编辑器，stamp 正是把编辑送达后续会话的机制。

### 组装子 agent

subagent 的子 agent 通过 `composeFrom()` 加入其父方的常驻组装，绝不走 `mount()`。所有面向模型的行都在 agent 平面，工具注册表的全局层是空的，因此没有加入任何组装的子 agent 抵达模型时既没有任何工具，也没有父方的任何提示段。

按 id 重新挂载父方的 preset 与认父有两处差别，且两处都要紧。父方启动后被编辑过的组装文件会把与父方历史所产出时**不同**的一个代际交给子 agent；而此后被删除的 preset 会让子 agent 直接失败，尽管其父方仍在正常运行。认父还是同步的，这正是进程内 subagent 驱动能够使用它的前提——它们在同步的创建窗口里组装子 agent。

子 agent 会把所加入的 id 记在自己的持久化 header 上（见 [`dsh-subagent`](../../subagent/subagent/README.zh.md)），因此冷读子 agent 的历史时重建的是它实际运行过的组装，而不是部署默认值。

### 会话实际运行的是哪个 preset

创建头部记录的是会话**以什么开始**，`resolveSessionPreset(session)` 给出的才是它**实际运行的**。空白会话一旦切换过，两者就不同，因此所有重建路径——选择器读取的摘要、resume、fork——都走解析，而非直接读头部。

头部保持冻结，因为它是创建期事实。切换以 `agent-preset/selected` 会话事件记录，在替换提交之后追加；这正是 model-visible ⟺ logged 规则的要求：preset 决定模型看到的工具 schema 与提示词段落，因此必须能从日志重建。服务会把这项已提交事实重新发为不带 scope 的 cordis 事件 `agent-preset/selected(sessionId, agentPreset)`，其声明位于 client-safe 的 `./types` 出口，使远端消费方无需导入 Host 运行时类型即可让会话派生状态失效。只读头部会让切换过的会话按创建时的组装重建，从而重放新工具集无法执行的历史——这正是「仅空白可切」那道锁要防的危险。

### 切换空白 agent

`recompose()` 先卸载已装入的子树、再装入新的，因为两份组装无法共存——它们会把相同的工具名注册进同一个层。挂载失败会恢复先前的组装，而不是让 agent 一无所有；未知 id 则在任何东西被拆除之前就被拒绝。

"仅限尚未产出任何内容的 agent"是一条产品规则而非机制约束：在对话进行中调换工具，会留下新组装无法执行的、已被记录的工具调用。该规则由网关在传输层执行（[`dsh-apiproxy`](../../host/apiproxy/README.zh.md) 返回 `agent-preset-locked`），因为会话历史在那里才拿得到。

## 创作

创作即复制。新 preset 是某个既有 preset 的整体副本；输入只有两个由注册表对照来源解析的 id 加一个可选显示名，因此调用方从不提供组装文本，一次复制不会授予 roster 尚未携带的任何能力。注册表拒绝来源已提供的 id——含随附 preset，因为与随附 preset 同名的用户 preset 只会被它遮蔽——其余全部交给来源：id 约束（`PRESET_ID`）、可写位置的占用、复制本身，以及 `remove()` 可以删除什么。文件系统来源的规则见[其 README](../agent-presets-filesystem/README.zh.md#创作)。

### preset 的各行如何挂载

来源把解析好的行交给注册表，挂载把它们作为内存中的 Loader entry 树插入常驻 scope——对所有来源都是同一棵树，只随行携带一个与文件相关的事实：相对标识符据以解析的 `baseUrl`。每次挂载都克隆这些行，因为 Loader 按身份存放每一行的选项并向其中写入（`disabled`、生成的 id）；交出同一份行集合的来源永远不会看到上一个代际的状态。

行的**包名**从宿主组装解析，而非从 preset 的基址解析。Loader 通常按 entry 所属树的 `baseUrl` 解析；本地创作的 preset 位于用户主目录之下，Node 向上查找 `node_modules` 永远够不到 harness，因此每一个 `@deepseek-ai/dsh-*` 行都会导入失败。挂载在插入子树之前先记录宿主的基址，并把裸标识符送往那里。

**相对**路径从组装的 `baseUrl` 解析——对 preset 目录而言就是该目录本身——因此 preset 自带的插件文件与 skill 目录会随它一同迁移。没有文件的来源不提供 `baseUrl`，相对行在那里无法解析。

**绝对**文件系统路径则保留其自身位置。挂载会先将它转换为 `file:` URL 再交给 ESM 导入，从而使 POSIX 路径和 Windows 盘符或 UNC 路径都采用 Node 能够接受的说明符。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `default` | 必填 | 调用方未指定时挂载的 preset id |

preset 存放在哪里是来源行的配置（[文件系统来源](../agent-presets-filesystem/README.zh.md#配置)）。随附的 Web 组装在本行之前直接挂载文件系统来源；`apps/cli` 在启动时把随附根目录打到那一行来源上。

### 默认 preset 是一项用户设置

当组装中存在 settings 提供方时，本插件会注册 `agent-presets` 命名空间，并以 `config.default` 作为其组装 base，因此用户文档会层叠覆盖部署方的工程默认值：

```yaml
agent-presets:
  default: minimal
```

该值在每次解析时读取而非快照，因此热重载的文档对**此后创建**的会话生效，而每个运行中的会话仍停留在它当初据以组装的 preset 上。清空用户字段即重新继承组装默认值。若默认值指向来源不提供的 preset，写入时不会报错，而在下一次 `resolve()` 时失败——名单是活的，此刻不存在的名字，等到某个会话真正索取时可能已经存在。

## 挂载会拒绝什么

直接挂载的子树不会出现在 `ctx.loader.entries()` 中，因此没有任何启动审计能覆盖它。`mount()` 因此自行校验结果可用，并拒绝三种情况。

**目标上下文没有 scope。** 挂载到不带 agent scope 的上下文，会把该 preset 的工具注册成全局的，作用于进程内每一个 agent。

**某一行始终未进入可用状态。** 模块导入失败或插件抛错的行，loader 已经会拒绝；剩下的情况是某一行仍在等待该组装从未提供的服务，审计会指名这种情况。

**某一行把服务发布进了根 realm。** 这类服务是进程级全局的，因此第二个发布同名服务的 preset 会与第一个相撞，宿主读取方也会把某一个 preset 的实例当成所有会话的。确实需要自带服务的 preset，应把它放在 `isolate` realm 之后——entry 本地 realm 让两个 preset 的同名服务互不相干，正如它从前隔开两个会话——否则该服务应改放进宿主组装。

最后一条规则由本包的运行时不变量在每次服务通知时复查，因为从定时器或异步续体中发布的行会绕过一次性审计。

## 组装是输入，不是持久化目标

只要 Loader 认为配置变了，它就会通过 `EntryTree.write()` 把树写回——而一个行释放自己的 fiber 就足以让它这么认为：该 entry 被标记 `disabled`，随即触发写回。文件支持的树会把一个会话的运行时状态烧进所有会话共享的文件里：YAML 往返会抹掉注释，而对随附的只读 preset，`writeFile` 还会在 `setTimeout` 内抛出无人接管的 rejection。

被挂载的子树位于内存中，其 `write()` 是空操作。本包不写任何组装；创作组装是来源的显式操作。

## 信任

preset 就是组装，因此一个 preset 的权限恰好等于它所引用的插件。`user` preset——无论由人还是由 agent 写出——与 shell 访问权限同级；`trust` 字段的存在是为了让消费方呈现这一差异，而不是用来强制隔离。

## 模型体验

Indirectly, through the plugins a standing composition registers, which own every tool schema and prompt section the preset makes visible to the agents joined to it.

#### KV Cache effect

在一个 agent 的整个生命周期内保持前缀稳定：组装只装入一次，发生在 agent 发布之前、因而也在它的首个请求之前，且在 agent 运行期间不再重新读取。为新会话选择不同的 preset，只会为该会话建立不同的前缀，无法让任何已在运行的会话失去缓存复用。

## 已知限制与暂缓事项

- **会话一旦产出内容便无法更换 preset** —— `recompose` 把**空白**会话的父作用域重链到另一个常驻挂载，且仅限空白会话：切换已运行过的组装会抽走模型已调用的工具。更改默认值只影响此后创建的会话。
- **代际只以来源 stamp 为键** —— stamp 是来源对组装各行的身份标识；旁边 skill 文件或资产的编辑要等 stamp 本身变化或进程重启才达到新会话。
- **被替代的代际永不回收** —— 已加入的会话保持其运行所在的代际，而名单没有加入计数可以判断最后一个何时离开，因此整棵子树一直挂到进程结束。代价按代际计而非按会话计，但并非为零：`dsh-skill-filesystem` 默认监听自己的根目录，因此每一轮「编辑后建会话」都会新增一套活的 watcher。上限取决于组装被编辑的频率——而设置页的编写流程把这件事从「每次部署」变成了「每次保存」。要回收就需要给常驻挂载加上已加入 agent 的计数；见 `ensureStanding` 处的 `TODO`。
- **副本从不被实际挂载以校验** —— 它是来源的整体副本，因此在来源处已坏的 preset 会产出同样损坏的副本；来源的健康检查会在下一次读取名单时把两行都标出来，而不是把失败推迟到会话启动。
- **健康是来源的形状检查，不是挂载** —— 来源只证明组装是它能读取的行列表，不证明每一行的模块都能解析并激活；引用不存在的包的行仍在第一个会话处失败，并回滚该会话的创建。
- **副本是会漂移的快照** —— 升级部署不会更新随附 preset 的副本，本层也没有表达「standard 加一处改动」的 patch 语义（那是 bundle 层 `cordis.patch.yml` 的能力）；随附集合自己也接受同样的代价——`cordis` 与 `code` 就是 `standard` 的完整副本——换来整份组装在一个文件里可读。
- **没有文件的来源无法挂载相对行** —— `PresetComposition.baseUrl` 是 `./plugin.js` 这类行据以解析的基址，因此内置表来源只能提供包名或绝对位置。
