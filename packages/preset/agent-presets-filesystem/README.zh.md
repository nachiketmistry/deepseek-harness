# dsh-agent-presets-filesystem

[English](README.md) | 中文

agent-preset 来源 seam 的**文件系统 Service Provider**（[`dsh-agent-presets`](../agent-presets/README.zh.md) 拥有 `AgentPresetSource` Service Definition 以及消费它的注册表）。一个 preset 是一个目录，其中放置一份 `agent.cordis.yml`，可选地在旁边放一份带展示文本的 `preset.yml`；目录名即 preset id。加载本插件会提供 `ctx.agentPresetSource`，roster 行注入它。

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

## Service Provider：`FilesystemAgentPresetSource`（ctx 键：`agentPresetSource`）

- `list()` 按优先级依次扫描每个根目录，id 重复时靠前的根目录胜出。发现过程不做缓存——每次调用都重新读取各个根目录——因此进程运行期间新写的 preset 立即可见，被删除的 preset 也会在下一次读取时消失。发现过程同时负责 preset 的**健康**：组装文件缺失或不可加载（YAML 无法解析——用加载器自己的方言检查，含 `!!js`——或不是由具名插件行组成的列表）的目录会作为携带 `broken` 原因的行列出而不是被跳过，因为被跳过的目录仍在磁盘上占着它的 id，而各个界面却没有任何可删的东西。目录名不是可用 preset id（`[a-z0-9][a-z0-9-]*`）的目录才被直接跳过：复制永远不可能占用那种名字。
- `stamp(preset)` 组装文件的 `mtimeMs:size`；文件无法 stat 时为 `undefined`。大小是同一 mtime 刻度内落地的编辑的决胜依据。
- `composition(preset)` **先** stat 文件，再以加载器方言（`entryListSchema`，因此 `!!js` 标量保持为表达式节点）读取并解析；与读取竞争的编辑因此只会让 stamp 过期，而不会悄悄被当作当前状态。文档不是顶层列表时 reject。返回的 `baseUrl` 是 preset 目录，因此相对行（`./plugin.js`）与 skill 目录会随 preset 一同迁移。
- `read(preset)` 文件文本，与存储内容逐字一致。
- `authorable` 所扫描的根目录中是否有任一具备 `user` 信任级别。
- `copy(source, id, name?)` / `remove(preset)` [创作](#创作)一节描述的整目录创作写入。
- `roots: readonly PresetRoot[]` 本来源实际扫描的根目录——全部已配置根目录按序在前，随后是推导出的 harness home 根目录（除非 `includeUserRoot` 为 false）。在服务构造时解析一次：若根目录集合在一次 `list()` 与依据其答案执行的 `copy()` 之间发生变化，写入的将是调用方从未见过的目录。

`AgentPreset.path` 是该 preset 组装文件的绝对路径；preset 目录是其父目录，Web 宿主为本地创作的 preset 打开的正是它。

模块还导出宿主或测试直接组合的部件：`COMPOSITION_FILE`、`METADATA_FILE`、`USER_PRESET_DIR`、`discoverPresets`、`scanRoot`、`readPresetMetadata`、`renderPresetMetadata`、`writableRoot`、`readComposition`、`copyComposition` 与 `deleteComposition`。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `roots` | `[]` | 按优先级排列的扫描目录；每项提供 `path`（开头的 `~` 会展开）与 `trust`（默认为 `user`） |
| `includeUserRoot` | `true` | 在全部已配置根目录之后，追加 `<dshHome>/.agent-presets` 作为 `user` 根目录 |

根目录不存在时视为不提供任何 preset，而非失败：用户根目录在写出第一个本地 preset 之前并不存在，而指定了没有任何根目录提供的默认值，在注册表解析时本就会明确报错。

### 可写根目录属于本包，随附根目录属于 app

`<dshHome>/.agent-presets` 是个人自有 preset 的所在，正如 `<dshHome>/skills` 是其自有 skill 的所在（[`dsh-skill-filesystem`](../../skill/skill-filesystem/README.zh.md)），因此来源自行推导它，而不等某个部署记得配置——一个什么都没配的启动器同样能发现并创作 preset。它追加在全部已配置根目录**之后**，从而保持靠前的根目录赢得重复 id：随附的 `standard` 仍然遮蔽一个占用该名字的家目录目录，而注册表会拒绝该 id，不会落下一个无人解析得到的 preset。

`includeUserRoot: false` 使来源只提供 `roots` 中的 preset。把 preset 限制在自有目录内的部署需要它，任何钉住确切 roster 的测试同样需要——否则将由这台机器真实的 `<dshHome>` 决定 roster 的内容。

随附根目录仍然是装配事实：它位于已安装 app 自身配置的旁边，那个路径只有该 app 能解析，`apps/cli` 在启动时把它打到本行上。

## 创作

新 preset 是某个既有 preset 的整目录副本——组装、元数据、skill 目录、附带资产——落在首个 `user` 根目录之下。`copy()` 在任何内容落盘之前拒绝两种情况：

- **不符合 `[a-z0-9][a-z0-9-]*` 的 id。** id 会成为目录名，因此约束是 id 自身的性质，而非事后再做一次路径检查——`../escape`、`a/b` 与绝对路径都作为 id 被拒绝。
- **磁盘上占着该名字的目录**，无论发现过程是否把它列为 preset。复制从不覆写。发现过程会把这样的目录列为损坏的 preset，所以这条拒绝的出路——删掉它——就在报告它的同一页面上。（注册表在此检查之前已拒绝任一根目录提供的 id。）

复制失败会回滚做到一半的目录，而不是留下一个发现过程看不见的目录。复制出的目录树被收紧为仅属主可用（文件 `0o600` 并保留属主执行位，目录 `0o700`），符号链接被解引用以保证副本自包含，且根目录在首次复制时创建——部署配置了尚不存在的用户根目录，正是首次运行的正常状态。复制出的 `preset.yml` 会被重写：保留来源的描述供作者就地编辑，但丢弃其名称与 roster `order`——副本若与来源呈现得一模一样、或按随附集合声明的顺序排序，roster 就不再能区分它们。

`remove()` 拒绝随部署提供的 preset（`system` 信任级别），也拒绝不在**第一个** `user` 根目录之下的 `user` preset；随附集合正是副本的已知良好起点。

### 展示用元信息

preset 可以在组装文件旁的可选 `preset.yml` 里发布展示文本：

```yaml
name: 极简模式
description: 仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。
order: 1
```

它**只**承载展示文本。`id` 是目录名，`trust` 取自 preset 被发现时所在的根目录，两者都不可写在这里——否则本地创作的 preset 就能把自己命名进随附集合。之所以是独立文件：组装是插件行的顶层列表，YAML 无法在其旁携带同级键，而伪造一个元信息行等于递给 Loader 一个要加载的东西。`order` 决定 preset 在其分组内的位置；未声明的 preset 排在已声明的之后，再按 id 排序。

任何读取失败都退化为「没有元信息」——缺失、格式错误、类型不对、内容为空，含义相同，选择器回退到 id。展示不是能力：名字坏掉的 preset 依然能挂载。

## 模型体验

Indirectly, through [`dsh-agent-presets`](../agent-presets/README.zh.md), whose standing mount installs the rows this source reads; those plugins own every tool schema and prompt section a preset makes visible.

#### KV Cache effect

不直接使缓存失效；请求前缀的任何变化由上述消费方负责。

## 已知限制与暂缓事项

- **位于可写根目录之外的 preset 可被发现却无法删除** —— `remove()` 拒绝任何不在**第一个** `user` 根目录下的 preset，因此一个既配置了自有可写根、又保留 `includeUserRoot` 的部署，会列出并挂载 harness home 下的 preset，却对每次删除回答「它不在可写 preset 根目录之下」。来源按设计只有一个可写根；只想要自有根的部署应设置 `includeUserRoot: false`。
- **stamp 只以组装文件为准** —— `agent.cordis.yml` 的变化会在注册表中开启新代际，旁边 skill 文件或资产的编辑则不会；那些编辑要等组装文件本身变动或进程重启才达到新会话。
- **健康是形状检查，不是挂载** —— 发现过程只证明组装能以加载器方言解析、由具名行组成，不证明每一行的模块都能解析并激活；引用不存在的包的行仍在第一个会话处失败，并回滚该会话的创建。
- **根目录扫描不做监听** —— 每次读取都实际访问文件系统，这让名单保持新鲜，但每次 `list()` 会对每个根目录产生一次 `readdir`，并对每个 preset 产生一次读取与解析。
