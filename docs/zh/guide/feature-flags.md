# 配置开关：开关前后实测对照

每个 `kbengine.*` 开关都改变真实界面行为。本页给每个开关配**真实开关前后截图**：流水线在 Xvfb 内起一个装好 kode 扩展的真的 VS Code 实例（从打包 VSIX 安装），对 KBEngine demo 工作区逐态改写工作区设置里的这一个开关，每态重启扩展宿主，摆出该开关效果可见的界面姿态（编辑器/悬停/命令面板），再用 ffmpeg 把两张真实截图缝成动图。

全流程脚本化、可重跑，无手工画图：

```bash
python3 scripts/config-switch-gifs/generate.py --list           # 开关清单
python3 scripts/config-switch-gifs/generate.py --all            # 抓全部可截图开关
python3 scripts/config-switch-gifs/generate.py --switch inlay-type-data
```

前置：`Xvfb`、`xdotool`、ImageMagick `import`、`ffmpeg`、VS Code CLI 与打包好的 VSIX（见 `scripts/config-switch-gifs/generate.py`）。截图在 `/tmp` 一次性工作区进行，仓库只新增 `docs/public/config-switch-gifs/` 下的 PNG/GIF 与 `manifest.json`。

## 诊断

### 实时语法检查总开关 — `kbengine.enableDiagnostics`

关闭后 `.def` 文件不再做实时语法检查，错误行红色波浪线与问题面板条目全部消失。

![enable-diagnostics](/config-switch-gifs/enable-diagnostics.gif)（[关](/config-switch-gifs/enable-diagnostics-off.png) / [开](/config-switch-gifs/enable-diagnostics-on.png)）

### 重复定义检查 — `kbengine.diagnostics.checkDuplicateDefinitions`

开启后同一 `.def` 中重复声明的属性被标 Warning（重复定义）。

![check-duplicate-definitions](/config-switch-gifs/check-duplicate-definitions.gif)（[关](/config-switch-gifs/check-duplicate-definitions-off.png) / [开](/config-switch-gifs/check-duplicate-definitions-on.png)）

## 悬停

### 悬停标签说明 — `kbengine.hover.showTagDocs`

开启后悬停 `<Flags>`/`<Type>` 等 `.def` 标签弹出标签含义说明卡片。

![hover-show-tag-docs](/config-switch-gifs/hover-show-tag-docs.gif)（[关](/config-switch-gifs/hover-show-tag-docs-off.png) / [开](/config-switch-gifs/hover-show-tag-docs-on.png)）

### 悬停取值说明 — `kbengine.hover.showValueDocs`

开启后悬停 `BASE_AND_CLIENT` 等枚举取值弹出该值的适用范围说明。

![hover-show-value-docs](/config-switch-gifs/hover-show-value-docs.gif)（[关](/config-switch-gifs/hover-show-value-docs-off.png) / [开](/config-switch-gifs/hover-show-value-docs-on.png)）

### 悬停实现反链 — `kbengine.hover.implementedBy`

开启后悬停 def 方法名显示脚本实现位置（Implemented-By 反链，文件:行）。

![hover-implemented-by](/config-switch-gifs/hover-implemented-by.gif)（[关](/config-switch-gifs/hover-implemented-by-off.png) / [开](/config-switch-gifs/hover-implemented-by-on.png)）

## CodeLens

### RPC 方法 CodeLens — `kbengine.codeLens.rpc`

开启后 Python 实体脚本中 def 声明方法的实现行上方出现 RPC 标记 CodeLens。

![codelens-rpc](/config-switch-gifs/codelens-rpc.gif)（[关](/config-switch-gifs/codelens-rpc-off.png) / [开](/config-switch-gifs/codelens-rpc-on.png)）

### types.xml 落库镜链 CodeLens — `kbengine.codeLens.typesXml`

开启后 types.xml 类型声明行上方出现落库镜链 CodeLens（引用反扫）。

![codelens-types-xml](/config-switch-gifs/codelens-types-xml.gif)（[关](/config-switch-gifs/codelens-types-xml-off.png) / [开](/config-switch-gifs/codelens-types-xml-on.png)）

## 内联提示

### 属性类型内联提示 — `kbengine.inlayHints.typeData`

开启后 Python 脚本 `self.<属性>` 访问处内联显示 def 声明的 types.xml 数据类型。

![inlay-type-data](/config-switch-gifs/inlay-type-data.gif)（[关](/config-switch-gifs/inlay-type-data-off.png) / [开](/config-switch-gifs/inlay-type-data-on.png)）

### def 形参内联提示 — `kbengine.inlayHints.defParams`

开启后 Entity 脚本区块内 def 定义的未标注形参后内联显示 def 声明的参数类型。

![inlay-def-params](/config-switch-gifs/inlay-def-params.gif)（[关](/config-switch-gifs/inlay-def-params-off.png) / [开](/config-switch-gifs/inlay-def-params-on.png)）

## 热更新

### 热更新总开关 — `kbengine.hotReload.enabled`

关闭时状态栏热更项为「未开启: kbengine.hotReload.enabled=false」（watch-off 图标）；开启并给出 globs 后进入就绪态（保存 `.py` 即发默认热更请求）。请看底部状态栏。

![hot-reload-enabled](/config-switch-gifs/hot-reload-enabled.gif)（[关](/config-switch-gifs/hot-reload-enabled-off.png) / [开](/config-switch-gifs/hot-reload-enabled-on.png)）

## 面板

### 调用链面板初始视图 — `kbengine.python.callChainView`

`text` → `graph`：Show Call Chain 面板以 mermaid 关系图或纯文本打开。

![call-chain-view](/config-switch-gifs/call-chain-view.gif)（[text](/config-switch-gifs/call-chain-view-text.png) / [graph](/config-switch-gifs/call-chain-view-graph.png)）

## 已截图开关汇总

| 设置项 | 开关 | 状态 | 效果 |
| --- | --- | --- | --- |
| `kbengine.enableDiagnostics` | 实时语法检查总开关 | `false` → `true` | 关闭后 `.def` 文件不再做实时语法检查，错误行红色波浪线与问题面板条目全部消失 |
| `kbengine.diagnostics.checkDuplicateDefinitions` | 重复定义检查 | `false` → `true` | 开启后同一 `.def` 中重复声明的属性/方法被标 Warning（重复定义） |
| `kbengine.hover.showTagDocs` | 悬停标签说明 | `false` → `true` | 悬停 `<Flags>`/`<Type>` 等 `.def` 标签时弹出标签含义说明卡片 |
| `kbengine.hover.showValueDocs` | 悬停取值说明 | `false` → `true` | 悬停 `BASE_AND_CLIENT` 等枚举取值时弹出该值的适用范围说明 |
| `kbengine.hover.implementedBy` | 悬停实现反链 | `false` → `true` | 悬停 def 方法名时显示脚本实现位置（Implemented-By 反链，文件:行） |
| `kbengine.codeLens.rpc` | RPC 方法 CodeLens | `false` → `true` | Python 实体脚本中 def 声明方法的实现行上方出现 RPC 标记 CodeLens |
| `kbengine.codeLens.typesXml` | types.xml 落库镜链 CodeLens | `false` → `true` | types.xml 类型声明行上方出现落库镜链 CodeLens（引用反扫） |
| `kbengine.inlayHints.typeData` | 属性类型内联提示 | `false` → `true` | Python 脚本 `self.<属性>` 访问处内联显示 def 声明的 types.xml 数据类型 |
| `kbengine.inlayHints.defParams` | def 形参内联提示 | `false` → `true` | Entity 脚本区块内 def 定义的未标注形参后内联显示 def 声明的参数类型 |
| `kbengine.hotReload.enabled` | 热更新总开关 | `false` → `true` | 关闭时状态栏热更项为「未开启」（watch-off）；开启并给出 globs 后进入就绪态（保存 `.py` 即发默认热更请求） |
| `kbengine.python.callChainView` | 调用链面板初始视图 | `text` → `graph` | Show Call Chain 面板以 mermaid 关系图（graph）或纯文本（text）打开 |

## 手动截图开关

以下开关真实存在，但效果不以无头可截的界面状态呈现（需驱动生成向导、截图中途改文件触发，或效果落在设置文件差异而非像素）。此处仅文字说明；流水线在 `scripts/config-switch-gifs/switches.json` 里标 `capture: false`，重跑时如实跳过。

| 设置项 | 开关 | 状态 | 效果 |
| --- | --- | --- | --- |
| `kbengine.hover.showSymbolDocs` | 悬停符号摘要 | `false` → `true` | 悬停自定义属性名/方法名时显示摘要信息 |
| `kbengine.hover.typeStorage` | 悬停类型存储信息 | `false` → `true` | 悬停 types.xml 自定义类型时显示落库表/列/类型存储信息 |
| `kbengine.hover.eventStats` | 悬停事件统计 | `false` → `true` | 悬停事件常量时显示注册与监听统计（事件回调反链） |
| `kbengine.hover.serverConfig` | 悬停服务配置项 | `false` → `true` | 悬停 kbengine.xml 服务配置项时显示取值与说明 |
| `kbengine.hover.startupScript` | 悬停启动参数 | `false` → `true` | 悬停 `.sh`/`.bat` 启动脚本里的 KBEngine 启动参数与环境变量时显示说明 |
| `kbengine.hover.returnTypeInference` | 悬停返回类型推导 | `false` → `true` | 悬停局部变量时按函数返回注解推导类型 |
| `kbengine.hover.entityRegistration` | 悬停实体注册信息 | `false` → `true` | 悬停实体类名时显示 entities.xml 注册信息（Utype/清单位置） |
| `kbengine.hover.defChain` | 悬停声明链 | `false` → `true` | 悬停 def 属性/方法时显示声明链（文件与区块来源） |
| `kbengine.codeLens.eventCallbacks` | 事件回调 CodeLens | `false` → `true` | Python 脚本事件回调函数上方显示事件回调/监听数标记 |
| `kbengine.codeLens.property` | 属性标记 CodeLens | `false` → `true` | Python 脚本 `self.<属性>` 访问处上方显示属性标记 CodeLens |
| `kbengine.python.builtinTypeInlayHints` | 内建属性类型内联提示 | `false` → `true` | `self.<内建属性>`（如 `self.id`）访问处内联显示 `: <type>` |
| `kbengine.enableStructureDiagnostics` | `.def` 结构化校验 | `false` → `true` | 重复定义、标签位置、缺失字段等结构问题被标 Warning/Error |
| `kbengine.autoRefreshFinalConfig` | 最终配置自动刷新 | `false` → `true` | 引擎配置文件变更后最终配置视图自动重算刷新 |
| `kbengine.generator.generatePython` | 生成器：Python 文件 | `false` → `true` | 实体生成向导是否同时产出 Python 实体文件 |
| `kbengine.generator.registerInEntitiesXml` | 生成器：entities.xml 注册 | `false` → `true` | 生成后是否在 entities.xml 自动注册实体条目 |
| `kbengine.entity.methodStubBody` | 实现骨架方法体 | `pass` → `raise` | 一键生成实现骨架时方法体为 `pass` 或 `raise NotImplementedError` |
| `kbengine.python.callChainHints` | 调用链入口提示 | `false` → `true` | 方法入口上方显示 Call Chain 提示；关闭后 Show Call Chain 也不生成预览 |
| `kbengine.jsoncAssociation` | debug.json 关联 jsonc | `false` → `true` | 激活时把 `**/.kbengine/debug.json` 关联为 jsonc 写入工作区设置 |
| `kbengine.python.extraPathsSync` | extraPaths 自动接线 | `false` → `true` | 自动把 KBEngine scripts 根写入 python.analysis.extraPaths |
| `kbengine.webviewConsoleLogs` | 面板 console 采集 | `false` → `true` | 日志面板页面 console 与未捕获异常写入日志面板（内部行为） |
| `kbengine.hotReload.tempEdit.enabled` | 热更临时编辑 | `false` → `true` | 开启后一键热更流程会走「临时修改→reloadScript→自动还原」路径（默认关，防误触） |
| `kbengine.debug.debugpyInject` | debugpy 注入 | `false` → `true` | 开启时启动调试会话会把 debugpy 注入目标进程并上调试状态板；关闭则不注入 |
| `kbengine.debug.autoDebugpy` | 自动 debugpy | `false` → `true` | 开启后调试启动自动寻找/拉起 debugpy 监听并等待接入（默认关） |
| `kbengine.runtimeQuery.enabled` | Runtime Queries 面板 | `false` → `true` | 面板本身始终可打开；关闭时面板内查询/结果流报「请启用 kbengine.runtimeQuery.enabled」，开启后查询可用 |
| `kbengine.showFinalConfigOnOpen` | 自动打开最终配置视图 | `false` → `true` | 开启后打开引擎默认配置文件会尝试自动并排打开最终配置视图（需可运行的引擎 bin 完成最终配置计算；纯工作区无引擎时自动打开不触发） |
