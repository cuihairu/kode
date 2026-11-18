# 配置开关效果

所有「开启后看得见效果」的扩展配置项,由自动截图流水线(`scripts/config-switch-gifs/`)驱动真实 VS Code(Xvfb + 打包扩展)逐个先关后开各截一张,ffmpeg 缝成动态图。流水线可重跑,兼作配置效果回归测试——开关效果失效时前后帧完全一致,流水线直接报红。没有静态画面的开关列在文末手工验证清单,不配图不编造。

本页由生成器产出:`python3 scripts/config-switch-gifs/render_docs.py`

> 本页由 `switches.json` + `manifest.json` 生成,请勿手改。

## 诊断

### 实时语法检查总开关 (`kbengine.enableDiagnostics`)

关闭后 .def 文件不再做实时语法检查，错误行红色波浪线与问题面板条目全部消失

| 关闭 | 开启 |
| --- | --- |
| ![实时语法检查总开关 off](/config-switch-gifs/enable-diagnostics-off.png) | ![实时语法检查总开关 on](/config-switch-gifs/enable-diagnostics-on.png) |

*动态图:* ![实时语法检查总开关](/config-switch-gifs/enable-diagnostics.gif)

### 重复定义检查 (`kbengine.diagnostics.checkDuplicateDefinitions`)

开启后同一 .def 中重复声明的属性/方法被标 Warning（重复定义）

| 关闭 | 开启 |
| --- | --- |
| ![重复定义检查 off](/config-switch-gifs/check-duplicate-definitions-off.png) | ![重复定义检查 on](/config-switch-gifs/check-duplicate-definitions-on.png) |

*动态图:* ![重复定义检查](/config-switch-gifs/check-duplicate-definitions.gif)

### .def 结构化校验 (`kbengine.enableStructureDiagnostics`)

重复定义、标签位置、缺失字段等结构问题被标 Warning/Error

| 关闭 | 开启 |
| --- | --- |
| ![.def 结构化校验 off](/config-switch-gifs/enable-structure-diagnostics-off.png) | ![.def 结构化校验 on](/config-switch-gifs/enable-structure-diagnostics-on.png) |

*动态图:* ![.def 结构化校验](/config-switch-gifs/enable-structure-diagnostics.gif)

## 悬停

### 悬停标签说明 (`kbengine.hover.showTagDocs`)

悬停 &lt;Flags&gt;/&lt;Type&gt; 等 .def 标签时弹出标签含义说明卡片

| 关闭 | 开启 |
| --- | --- |
| ![悬停标签说明 off](/config-switch-gifs/hover-show-tag-docs-off.png) | ![悬停标签说明 on](/config-switch-gifs/hover-show-tag-docs-on.png) |

*动态图:* ![悬停标签说明](/config-switch-gifs/hover-show-tag-docs.gif)

### 悬停取值说明 (`kbengine.hover.showValueDocs`)

悬停 BASE_AND_CLIENT 等枚举取值时弹出该值的适用范围说明

| 关闭 | 开启 |
| --- | --- |
| ![悬停取值说明 off](/config-switch-gifs/hover-show-value-docs-off.png) | ![悬停取值说明 on](/config-switch-gifs/hover-show-value-docs-on.png) |

*动态图:* ![悬停取值说明](/config-switch-gifs/hover-show-value-docs.gif)

### 悬停实现反链 (`kbengine.hover.implementedBy`)

悬停 def 方法名时显示脚本实现位置（Implemented-By 反链，文件:行）

| 关闭 | 开启 |
| --- | --- |
| ![悬停实现反链 off](/config-switch-gifs/hover-implemented-by-off.png) | ![悬停实现反链 on](/config-switch-gifs/hover-implemented-by-on.png) |

*动态图:* ![悬停实现反链](/config-switch-gifs/hover-implemented-by.gif)

## CodeLens

### RPC 方法 CodeLens (`kbengine.codeLens.rpc`)

Python 实体脚本中 def 声明方法的实现行上方出现 RPC 标记 CodeLens

| 关闭 | 开启 |
| --- | --- |
| ![RPC 方法 CodeLens off](/config-switch-gifs/codelens-rpc-off.png) | ![RPC 方法 CodeLens on](/config-switch-gifs/codelens-rpc-on.png) |

*动态图:* ![RPC 方法 CodeLens](/config-switch-gifs/codelens-rpc.gif)

### types.xml 落库镜链 CodeLens (`kbengine.codeLens.typesXml`)

types.xml 类型声明行上方出现落库镜链 CodeLens（引用反扫）

| 关闭 | 开启 |
| --- | --- |
| ![types.xml 落库镜链 CodeLens off](/config-switch-gifs/codelens-types-xml-off.png) | ![types.xml 落库镜链 CodeLens on](/config-switch-gifs/codelens-types-xml-on.png) |

*动态图:* ![types.xml 落库镜链 CodeLens](/config-switch-gifs/codelens-types-xml.gif)

### 事件回调 CodeLens (`kbengine.codeLens.eventCallbacks`)

Python 脚本事件回调函数上方显示事件回调/监听数标记

| 关闭 | 开启 |
| --- | --- |
| ![事件回调 CodeLens off](/config-switch-gifs/codelens-event-callbacks-off.png) | ![事件回调 CodeLens on](/config-switch-gifs/codelens-event-callbacks-on.png) |

*动态图:* ![事件回调 CodeLens](/config-switch-gifs/codelens-event-callbacks.gif)

### 属性标记 CodeLens (`kbengine.codeLens.property`)

Python 脚本 self.&lt;属性&gt; 访问处上方显示属性标记 CodeLens

| 关闭 | 开启 |
| --- | --- |
| ![属性标记 CodeLens off](/config-switch-gifs/codelens-property-off.png) | ![属性标记 CodeLens on](/config-switch-gifs/codelens-property-on.png) |

*动态图:* ![属性标记 CodeLens](/config-switch-gifs/codelens-property.gif)

## 内联提示

### 属性类型内联提示 (`kbengine.inlayHints.typeData`)

Python 脚本 self.&lt;属性&gt; 访问处内联显示 def 声明的 types.xml 数据类型

| 关闭 | 开启 |
| --- | --- |
| ![属性类型内联提示 off](/config-switch-gifs/inlay-type-data-off.png) | ![属性类型内联提示 on](/config-switch-gifs/inlay-type-data-on.png) |

*动态图:* ![属性类型内联提示](/config-switch-gifs/inlay-type-data.gif)

### def 形参内联提示 (`kbengine.inlayHints.defParams`)

Entity 脚本区块内 def 定义的未标注形参后内联显示 def 声明的参数类型

| 关闭 | 开启 |
| --- | --- |
| ![def 形参内联提示 off](/config-switch-gifs/inlay-def-params-off.png) | ![def 形参内联提示 on](/config-switch-gifs/inlay-def-params-on.png) |

*动态图:* ![def 形参内联提示](/config-switch-gifs/inlay-def-params.gif)

### 内建属性类型内联提示 (`kbengine.python.builtinTypeInlayHints`)

self.&lt;内建属性&gt;（如 self.id）访问处内联显示 : &lt;type&gt;

| 关闭 | 开启 |
| --- | --- |
| ![内建属性类型内联提示 off](/config-switch-gifs/builtin-type-inlay-hints-off.png) | ![内建属性类型内联提示 on](/config-switch-gifs/builtin-type-inlay-hints-on.png) |

*动态图:* ![内建属性类型内联提示](/config-switch-gifs/builtin-type-inlay-hints.gif)

## 面板

### 调用链面板初始视图 (`kbengine.python.callChainView`)

Show Call Chain 面板以 mermaid 关系图（graph）或纯文本（text）打开

| text | graph |
| --- | --- |
| ![调用链面板初始视图 off](/config-switch-gifs/call-chain-view-text.png) | ![调用链面板初始视图 on](/config-switch-gifs/call-chain-view-graph.png) |

*动态图:* ![调用链面板初始视图](/config-switch-gifs/call-chain-view.gif)

### 激活即开最终配置视图 (`kbengine.showFinalConfigOnOpen`)

开启时扩展激活即在后台预览标签打开最终配置合成视图（binPath 推导 defaults 路径，定位不到静默跳过）；关闭时不自动打开

| 关闭 | 开启 |
| --- | --- |
| ![激活即开最终配置视图 off](/config-switch-gifs/show-final-config-on-open-off.png) | ![激活即开最终配置视图 on](/config-switch-gifs/show-final-config-on-open-on.png) |

*动态图:* ![激活即开最终配置视图](/config-switch-gifs/show-final-config-on-open.gif)

### 调用链入口提示 (`kbengine.python.callChainHints`)

方法入口上方显示 Call Chain 提示；关闭后 Show Call Chain 也不生成预览

| 关闭 | 开启 |
| --- | --- |
| ![调用链入口提示 off](/config-switch-gifs/python-call-chain-hints-off.png) | ![调用链入口提示 on](/config-switch-gifs/python-call-chain-hints-on.png) |

*动态图:* ![调用链入口提示](/config-switch-gifs/python-call-chain-hints.gif)

## 手工验证清单

这些开关没有单一静态截图面:效果是行为性的(写文件/接线工具链/闸门在面板动作里)或只在交互过程中可见。按下表效果说明手工验证;上方截图有意不含它们。

| 配置项 | 效果 |
| --- | --- |
| `kbengine.runtimeQuery.enabled` | 关闭时面板可打开,但面板内流开关(toggle)报「流被禁用」;开启后流开关可用 |
| `kbengine.hover.showSymbolDocs` | 悬停自定义属性名/方法名时显示摘要信息 |
| `kbengine.hover.typeStorage` | 悬停 types.xml 自定义类型时显示落库表/列/类型存储信息 |
| `kbengine.hover.eventStats` | 悬停事件常量时显示注册与监听统计（事件回调反链） |
| `kbengine.hover.serverConfig` | 悬停 kbengine.xml 服务配置项时显示取值与说明 |
| `kbengine.hover.startupScript` | 悬停 .sh/.bat 启动脚本里的 KBEngine 启动参数与环境变量时显示说明 |
| `kbengine.hover.returnTypeInference` | 悬停局部变量时按函数返回注解推导类型 |
| `kbengine.hover.entityRegistration` | 悬停实体类名时显示 entities.xml 注册信息（Utype/清单位置） |
| `kbengine.hover.defChain` | 悬停 def 属性/方法时显示声明链（文件与区块来源） |
| `kbengine.autoRefreshFinalConfig` | 引擎配置文件变更后最终配置视图自动重算刷新 |
| `kbengine.generator.generatePython` | 实体生成向导是否同时产出 Python 实体文件 |
| `kbengine.generator.registerInEntitiesXml` | 生成后是否在 entities.xml 自动注册实体条目 |
| `kbengine.entity.methodStubBody` | 一键生成实现骨架时方法体为 pass 或 raise NotImplementedError |
| `kbengine.jsoncAssociation` | 激活时把 **/.kbengine/debug.json 关联为 jsonc 写入工作区设置 |
| `kbengine.python.extraPathsSync` | 自动把 KBEngine scripts 根写入 python.analysis.extraPaths |
| `kbengine.webviewConsoleLogs` | 日志面板页面 console 与未捕获异常写入日志面板（内部行为） |
