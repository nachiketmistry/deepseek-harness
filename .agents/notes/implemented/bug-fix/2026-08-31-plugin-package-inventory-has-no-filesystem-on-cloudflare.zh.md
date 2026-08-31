# Agent Note: the plugin package inventory has no filesystem to read on Cloudflare

Status: implemented

[English](2026-08-31-plugin-package-inventory-has-no-filesystem-on-cloudflare.md) | 中文

## 问题

Cloudflare 网页 GUI 中的每一次模型轮次都以 `REQUEST_EXTENSION`、`DeepSeek request extension preparation failed` 失败，请求根本没有抵达 provider。

`plugin-package-inventory-deepseek` 为官方 DeepSeek 请求贡献 `dsh_plugin_packages`，它把每个活跃的 Loader 条目解析到拥有它的那个包，做法是读取该包的 `package.json`。它经由 `createRequire(anchor).resolve.paths(name)` 与 `existsSync` 找到那个文件，而这两者都要求这些包在磁盘上铺开。Worker 没有文件系统：部署是一个打包产物，`node:fs` 是一个桩，而 harness 的各个包只以打包模块的形式存在。解析器在第一个活跃条目上就找不到 manifest，于是抛错，而不是报出一份它已知不完整的清单。

这次抛错发生在每个请求上，因此它不是组合能够察觉的加载期失败。那一行打包正常，插件树激活正常，部署在除了"它就是产品"的那一点之外，处处健康：人可以登录、创建工作区、开启对话，而轮次在第一个请求上失败。

## 决定

`CF_ROW_DISPOSITIONS` 将该行记为 `plugin-package-inventory` 能力缺口。Cloudflare 构建不再挂载它，本部署发出的官方请求不携带 `dsh_plugin_packages` 字段。

记为缺口而非替换，因为这就是整个能力本身，而不是它的某个后端。该扩展报告的是"哪些包装配了这个请求"，组合中没有别的东西需要它，因此移除这一行恰好从一个线路请求中移除一个字段，且不遗留任何孤儿。

它属于 disposition，而不属于 `compose.mjs` 里的一次 `enabled: false` 配置覆盖。`composition.mjs` 是决定构建如何处置每一行的唯一场所，而 `parity.mjs` 会在报告与构建不一致时失败；一次配置覆盖会把该字段从产品中摘掉，而报告仍然宣称该能力存在。

## 备选方案

**在构建期生成一份静态清单。** 已延期，也是关闭该缺口的正确做法：CF 构建本就已解析全部 130 个 host 行与两棵 preset 树，因此该扩展所报告的包身份在 Worker 运行之前就已知；仓库对这一类问题也已经这样作答过——`dsh-typert-artifacts-static`、`dsh-agent-presets-static` 与 `dsh-client-bundle-source-static`。它是一个带生成数据的包，而不是两行 disposition，因而不必与这次失败的修复同时落地。

**在插件内部捕获解析失败，只报告它能解析出的那些包。** 已否决：一份静默的部分清单，是发给 API 的一个错误答案，而不是一个缺席的答案，且调用方无法分辨二者。什么都不报是诚实的，报一部分不是。

**让 `barePackageManifest` 退回到用条目名、不带版本。** 出于同样理由否决，且更糟：一个捏造的身份在线路上与真实身份无法区分。

**保持挂载，接受失败的轮次。** 已否决：轮次就是产品。

## 影响

Cloudflare 部署发出的官方 DeepSeek 请求不带 `dsh_plugin_packages`。任何下游读取该字段的东西，会把本部署看作运行着更老 harness 的部署，而不是一个清单为空的部署。

`composition-parity.md` 中的开放缺口由两个变为三个。另外两个损失的是人能看见其缺失的能力；这一个损失的是只有 API 会读的一个字段，这正是它直到有人对着真实 provider 跑一次轮次才被发现的原因。

没有任何门禁阻止一个插件被挂载到它的运行时无法作答之处。`gate0` 证明 CF 组合中的每个模块都能在 workerd 中求值，而这一个确实能——它是在稍后、在一个请求上抛错的，且只在发生模型轮次时。失败被推迟到请求路径上的行，今天不被任何门禁覆盖。
