# 参考插件功能差距盘点

> 2026-10-15。用户令:「先不要发了,先把其他参考的插件的功能看下,是否都实现了,没有实现就等全部实现了再说」。
> 本文只做对比与借鉴登记,不含实现;实现按「实施排序」逐批点火。
> **对比必须有出处**:所有参考插件的功能均来自其 Marketplace 清单(vsix 内 `package.json`)与 README/USAGE 原文读取(2026-10-15 下载),不凭记忆;安装量取自 Marketplace Gallery API `extensionquery` 统计项。
> KBEngine Nex X 为**专有软件(保留所有权利)**——只读清单与公开文档,其分发源码一律不读、不抄、不参考实现细节。

## 一、参考插件清单

| 插件 | 版本 | 安装量 | 更新 | 许可 | 链接 |
| --- | --- | --- | --- | --- | --- |
| KBEngine Nex X | 2.0.0 | 28 | 2026-08-14 | 专有(保留所有权利) | <https://marketplace.visualstudio.com/items?itemName=KBEngineLab.kbengine-nex-x> |
| Rojo - Roblox Studio Sync | 2.1.2 | 275,530 | 2022-08-25 | MPL-2.0 | <https://marketplace.visualstudio.com/items?itemName=evaera.vscode-rojo> |
| Roblox LSP | 1.6.8 | 122,242 | 2024-07-05 | MIT | <https://marketplace.visualstudio.com/items?itemName=Nightrains.robloxlsp> |
| Godot .NET Tools | 0.5.1 | 27,877 | 2023-11-21 | MIT | <https://marketplace.visualstudio.com/items?itemName=woberg.godot-dotnet-tools> |

选样口径:用户点名 KBEngine Nex X(唯一直接同类);Marketplace `kbengine`/`kbengine3`/`kb3`/`kbe` 标签检索仅命中 Nex X 一件,其余按「游戏引擎工程工具」同类补三件——Rojo(引擎同步/运行集成)、Roblox LSP(引擎脚本语言支持)、Godot .NET Tools(工程文件/调试配置生成)。`neikeq.godot-csharp-vscode`(591,853 安装,Godot C# 调试器)与 `ms-python.python`(241,252,451 安装)作为维度佐证引用,不进主表。

## 二、功能对比表

kode 状态口径:**已实现**给 `file:line` 证据;**未实现**进第三节缺口清单;**本仓更强**如实说明。

| 维度 | kode(本仓) | KBEngine Nex X | Rojo | Roblox LSP | Godot .NET Tools |
| --- | --- | --- | --- | --- | --- |
| 语法高亮 | 已实现:`package.json:77-112` 贡献 `kbengine-def` 语言 + 语法 + `text.xml` 注入(types.xml 五类语义着色,批131 implementedBy 分段);主题 `syntaxes/kbengine-color-theme.json` | 无 languages/grammars 贡献(清单证实) | — | Luau 语法(`lua.tmLanguage.json`)+ semanticTokenScopes | — |
| 补全 | 已实现:`src/languageProviders.ts:275`(.def 实体/属性/方法)、`:3159`(Python `self.<属性>` 按 def 映射 + `kbe.`/`KBEngine.` 模块符号,引擎源码索引) | 靠内置各 app 的 `KBEngine.py` 提示文件(resources/py/tips/*) | — | LSP 全量补全(README 功能表) | — |
| 悬停 | 已实现:`src/languageProviders.ts:375`(def 属性悬停含库表全名/DDL/数值限制)、`src/serverConfigHover.ts:151`(kbengine*.xml 配置悬停) | 未见独立悬停面(清单无对应注册) | — | LSP hover | — |
| 跳转定义/引用 | 已实现:`src/languageProviders.ts:506`(def→def)、`:2680`(Python self.属性→def 声明,批135 反向 CodeLens `:2859`)、`:2961`(types.xml 反扫 CodeLens,批134)、implementedBy 双向(批119)、`:3011` Call Hierarchy、`:3097` Rename | def XML 补全与跳转(README) | — | LSP goto definition / find all references / rename | — |
| 诊断 | 已实现:`src/extension.ts:245-281`(kbengine 诊断集合)+ `kbengine.def.analyze` 静态分析落问题列表 | 未见诊断贡献 | — | LSP diagnostics(工作区/单文件,配置面十级粒度) | — |
| 调试 | 已实现(Python 附加):`src/debugConfig.ts:307` 写 `.vscode/launch.json`(connect 模式经进程选择器附加,telnet 开调试);`contributes.debuggers` 无(不自带调试器,复用 ms-python) | 无 debuggers 贡献 | — | — | 生成 launch.json 三配置(Launch/Launch Editor/Attach)+ dotnet 构建任务(README) |
| 命令面板/入口 | 已实现:36 条命令(`package.json` contributes.commands);活动栏容器 4 视图(entityExplorer/serverControl/telnetStatus/config);状态栏;2 组键位 | 17 条命令(清单) | 1 条命令(单一菜单,README 明言 V2 起收拢) | 0 条命令(LSP 无命令面) | 1 条命令 |
| 代码片段 | 已实现:3 份片段表(kbengine-def/xml/python,`package.json:113-122`)+ `kbengine.snippets.generateFromSelection`(选区生成,批121) | 无 snippets 贡献 | — | — | — |
| 模板/代码生成 | 已实现:`src/codeGenerator.ts:103` 实体向导(def + 可选 Python + entities.xml 登记) | newEntity/newProxy/newSpace/newComponent/newFixedDict/generateStubs 六条生成命令(清单) | — | — | 生成 launch.json/tasks.json/ruleset.xml 三件套(README) |
| 实体/DB 工具 | 已实现:实体浏览器(`src/explorerProviders.ts`)、数据库 schema 虚拟文档(`src/databaseSchema.ts:172`,批133 中文图例)、模拟器(`src/databaseSimulator.ts:746`)、漂移校验(`src/databaseDrift.ts`,只读白名单+READ ONLY 双保险)、依赖图/流程图 webview | 客户端实体生成、SDK 生成(README) | — | — | — |
| 日志查看 | 已实现:`src/logCollector.ts:24` + `src/logWebView.ts`(`kbengine.logs.*` 五命令,等级过滤 LogFilter 已有) | 实时日志 + 等级过滤 + 原始日志 ERROR 扫描(USAGE.md) | — | — | — |
| 运行/启动集成 | 已实现:serverControl 视图列进程 pid/状态(`src/explorerProviders.ts:1166-1195`)、`kbengine.server.start/stop/restart/showLogs`、快速执行动作三后端 command/script/http + Explorer 顶栏 ▶/▾(批136) | 服务器启停/pkill/热重载(手动 + 文件监视自动)、robots(USAGE.md) | rojo serve 起停 + Studio 实时同步 + 工具链自动安装(Aftman)(README) | — | 生成构建/调试配置间接支撑 |
| 配置校验/发现 | 已实现:配置自动发现四级优先级(批127/128/129,发现报告命令)+ 最终合并配置视图(`src/serverConfigMerge.ts:351-366`) | 工作区初始化、路径映射(USAGE.md) | `jsonValidation` 校验 `*.project.json`(清单) | — | — |
| 性能剖析 | **未实现**(缺口 G8) | TICK/CPROFILE/PYPROFILE/EVENT/NETWORK(USAGE.md,KBE Nex 3.x 二进制管理协议) | — | — | — |
| 热重载(自动) | **未实现**(缺口 G5;手动热更可经 quickActions http/script 后端) | 文件监视自动热重载(USAGE.md) | 保存即同步(rojo serve 常驻) | — | — |
| Python extraPaths 接线 | 已实现(批136,`src/pythonExtraPaths.ts`:scripts 根按 entityMapping 同口径 + 一级 `*_assets` 约定发现,写 WorkspaceFolder 级 `python.analysis.extraPaths`,只管理自己那一段,`kbengine.python.syncExtraPaths` 手动重跑 + 激活期自动一次,`kbengine.python.extraPathsSync` 默认开可关;批136 G2 落地后存根目录 `.kbengine/stubs` 在导出开且文件在盘时并入管理段) | 按 base/cell 动态 extraPaths(USAGE.md) | — | — | — |
| KBEngine API 存根(.pyi) | 已实现(批136 G2,`src/pythonStubExport.ts`:符号索引(与补全/悬停/跳转同源)导出 `.kbengine/stubs/KBEngine.pyi` 真文件,内容一致零写、陈旧重写,`kbengine.python.exportStubs` 手动入口 + 激活期自动一次,`kbengine.python.stubExport` 默认开可关;虚拟桩文档 Python 扩展看不见,真文件配合 G1 extraPaths 才解析 `import KBEngine`) | generateStubs + 内置提示文件 resources/py/tips/*(清单) | — | — | — |
| 配置文件 Schema 校验 | **未实现**(缺口 G3) | — | `jsonValidation` 对工程文件 | — | — |

「本仓更强」如实说明:kode 的 def/types.xml 语义面(注入着色、形态悬停、反扫 CodeLens)、数据库工具三件套(schema/模拟/漂移)、静态分析与发现报告,参考四件均无对应面;Rojo 的工具链自动安装与 Roblox LSP 的完整 LSP(独立语言服务器)属其生态定位, kode 不照搬。

## 三、缺口清单(未实现 → todo)

| 编号 | 缺口 | 来源 | 优先级 | 备注 |
| --- | --- | --- | --- | --- |
| G1 | `python.analysis.extraPaths` 自动接线(按 `getPythonScriptRoots` 反推的 scripts 根 + 引擎源码根写入 Python 扩展配置) | Nex X | **P1** | **已实现**(批136,`src/pythonExtraPaths.ts`):scripts 根同口径发现 + 一级 `*_assets` 约定,WorkspaceFolder 级写入,只管理自己那一段;G2 完成前 `import KBEngine` 的解析还取决于工程里有无 KBEngine.py |
| G2 | KBEngine Python API 存根导出(从 `src/kbeModuleIndex.ts` 签名索引导出 `.pyi`,配合 G1) | Nex X(generateStubs + 内置提示文件) | **P1** | **已实现**(批136 G2,`src/pythonStubExport.ts`):符号索引同源导出 `.kbengine/stubs/KBEngine.pyi`,与 G1 接线配合解析 `import KBEngine`;自研生成未抄 Nex X 文件 |
| G3 | `.kbengine/debug.json` JSON Schema 校验(`contributes.jsonValidation`) | Rojo(`*.project.json` 同法) | **P1** | quickActions 配置错误直接在编辑器标红;schema 与 `quickActionConfig.ts` 解析规则同源 |
| G4 | 客户端实体/SDK 多语言生成(C#/TS/C++/GDScript 模板) | Nex X | **P2** | 向导骨架已有;语言种类等用户点名单再排 |
| G5 | 自动热重载(文件保存/监视 → 触发指定 quick action) | Nex X(文件监视自动热更) | **P2** | 配置门控默认关,防误触;复用 quickActions 白名单后端 |
| G6 | 原始日志 ERROR 扫描视图(原始日志文件里的 ERROR 行聚合计数) | Nex X | **P2** | logWebView 已有等级过滤,此为增量面 |
| G7 | 生成器形态扩展(newProxy/newSpace/newComponent/newFixedDict 等向导) | Nex X(六条生成命令) | **P3** | 实体向导已有,其余形态按需 |
| G8 | 性能剖析(TICK/CPROFILE/PYPROFILE/EVENT/NETWORK) | Nex X | **P3(待证)** | Nex X 走 KBE Nex 3.x 管理协议;本仓面向经典 kbengine,协议可用性未证,不排期直到用户点名 |
| G9 | Space Viewer / Watcher 查询面板(spaces 与 cell 实体地图) | Nex X | **P3(待证)** | 同上依赖引擎管理协议;监控面板已有 machine 基础状态 |
| G10 | Robots 管理 / 插件市场 / 工作区初始化 | Nex X | **不排期** | 超出开发工具范围(外置生态/脚手架),kode 定位为工程内工具;如用户点名再评估 |

## 四、实施排序

1. **G1 + G2 + G3(同一批,P1)**:Python 生态接线两件 + 配置校验一件,互相独立但都是小增量、高感知;G1/G2 让「装了 Python 扩展的用户」立即获得 KBEngine API 补全,G3 让 quickActions 配置错误前置暴露。**G1/G2 已落地(批136)**,G3 待做。
2. **G5(P2)**:自动热重载,依赖 quickActions 既有白名单,配置门控。
3. **G6(P2)**:日志 ERROR 扫描,复用 logWebView。
4. **G4(P2,等点名)**:多语言 SDK 生成,语言清单须用户拍板。
5. **G7/G8/G9(P3)**:形态扩展与协议依赖项,逐批点火前先证协议。
6. **G10**:不排期。

## 五、来源与取证方式

- Marketplace Gallery API:`POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery`(filterType 8 `Microsoft.VisualStudio.Code` + filterType 10 `Publisher.Name` / filterType 2 Tag),flags 914;安装量取 `statistics[install]`。
- 各插件 vsix 经 Gallery 资产地址(`{publisher}.gallerycdn.vsassets.io/extensions/{publisher}/{name}/{version}/{timestamp}/Microsoft.VisualStudio.Services.VSIXPackage`)下载,只读 `extension/package.json` 与 README/CHANGELOG/USAGE 文本。
- KBEngine Nex X 专有许可声明见其 README;本盘点未读其任何分发源码。
- kode 侧证据均为本仓 `file:line`,以 2026-10-15 main(9a69ab5)为准。
