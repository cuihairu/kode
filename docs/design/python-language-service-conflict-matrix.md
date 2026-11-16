# Python 语言服务职责与冲突矩阵(RUST-148)

日期:2026-11-17
性质:决策记录(活文档)——Kode 与 Pylance/Pyright 等外部 Python 语言服务的职责分工、冲突裁定与禁令核证。以本提交时点的代码审计为据;用户 Pylance 崩溃事件证据(日志)到位后按需修订。

## 0. 职责总纲

- **Pylance/Pyright(外部)**:通用 Python 语义——类型推断、import 解析、通用诊断、通用补全、语义高亮、Python Outline。
- **Kode(本扩展)**:KBEngine 域语义——.def/entities.xml/types.xml 结构面、实体脚本 def 归属语义(角色面/内建属性/cellData/spaceData/持久化)、引擎嵌入模块桩(KBEngine.pyi)、进程拓扑。全部产出 `source: 'kbengine'` + 稳定 `code`。

分工判据:**域数据归属**。KBEngine 域知识(def 注册表/引擎内建表/进程角色)只有 Kode 有;通用 Python 语义只有 Pylance 全保真。Kode 不复制通用语义,Pylance 不可能懂域语义。

## 1. 能力矩阵

| 能力 | Pylance | Kode | 冲突裁定 |
|---|---|---|---|
| 诊断 | 通用类型/导入/语法(source=pylance/pyright) | 域 lint 13+ 族(receiver 段错配/attrNone/roleMisuse/readOnlyWrite/postDestroy/cellData×4/fixedDict/scalarAssign/spaceData/propertyDirection/rpcArgCount 等;source=kbengine+稳定 code) | **不重复**:collection 与 source 分离;Kode 各族 def-语义专属,Pylance 无域数据;族级开关 `kbengine.diagnostics.*` 可独立关。Pylance strict 模式下 None-性检查与 attrNone 理论同指一处缺陷——source/code 不同、结论同向,不属轰炸;如需单边可关对应 kbengine 开关 |
| 补全 | 通用补全 | 键位/上下文接管族(cellData 键宇宙/globalData/spaceData 键/FIXED_DICT 子字段)+ 实体上下文内建属性 + kbemain 入口钩子 + KBEngine./importlib. 显式前缀 | **不轰炸**:全部逐上下文/路径闸(RUST-147 审计实证;entryHooks.ts:91 kbemain 路径形态、非实体不接管、字符串键位才接管),普通 Python 文件零注入;键位上下文 Pylance 无有效项,Kode 接管是补缺不是竞争 |
| 悬停 | 类型/文档悬停 | 域悬停(内建属性面取证/def 归属/序列化表示/机制说明) | **加法合并**:VSCode 多 provider hover 分区呈现,各说各的证据,无覆盖关系 |
| Inlay hints | python.analysis.inlayHints.*(默认关) | def 参数类型/类型推断/callChain/代理属性(def 域) | **不重复**:Pylance 默认关;Kode 面是 def 推导结果,Pylance 开启时两类信息(类型注解 vs 域归属)不同质 |
| SemanticTokens | 全保真语义高亮 | 5 类+2 修饰子集(kbengine.semanticTokens.enabled **默认关**,RUST-144 批 4) | **裁定:默认关保持**。双开时 VSCode 按 provider 优先级逐 token 取舍,Kode 子集在 Pylance 在场时不增信息反添竞争;无 Pylance 场景下用户可手动开(候选:未来按 Pylance 缺席自动启,未实现,如实登记) |
| Outline/breadcrumbs | Python 面(其职责) | 仅 def/entities/types.xml 面(IDE-NAV-005/006) | **不冲突**:语言域不相交(RUST-146 审计) |
| 定义/引用/调用层次 | 通用 Python | def 结构面+实体方法域(Python 方法域收编 Rust,RUST-145 批 1) | **不重复**:Kode 的 Python 定义/引用/CallHierarchy 是 def 归属语义(进程作用域过滤),Pylance 是类型语义;两者结果常同向,Kode 提供域过滤视角 |

## 2. Kode 写入用户配置面清单(干预面,须可关可溯)

| 写入面 | 键 | 触发 | 用户保护 |
|---|---|---|---|
| scripts 根+桩目录 | python.analysis.extraPaths(管理段) | 激活期 silent 链(generators.ts:140)+显式命令 | kbengine.python.extraPathsSync=false 一键全关;管理段记忆(workspaceState)只改自己写的段;用户手填永不动 |
| 桩路径 | python.analysis.stubPath | 同步链(CFG-03) | 用户自设永不覆盖 |
| 嵌入模块噪声压制 | python.analysis.diagnosticSeverityOverrides.reportMissingModuleSource=none | 同步链(CFG-04) | 键级合并;用户已设的 override 永不覆盖,其他键原样 |
| 进程执行环境 | pyrightconfig.json executionEnvironments/stubPath/extraPaths/reportMissingModuleSource(false) | 桩包在盘时同步链(pythonProcessConfig.ts) | pyproject.toml tool.pyright 在场不接管;extends 保留;用户环境冲突保留+播报;只更新与上次生成等值的条目(编辑过的条目归用户);TOML 不被 JSON 隐式覆盖 |

以上均有显示面(pythonLanguageServiceStatus:extraPaths 已写≠语言服务可用的警示)。

## 3. 禁令核证:禁止重复 diagnostics、重复 completion 轰炸

**现状:满足,由构造保证,非靠约定。**

- 诊断重复不可能:每族独立 DiagnosticCollection 与稳定 code;各族测试套件钉 source/code/闸(开关关→零发布,如 featureToggles/configCompletion 对账族)。
- 补全轰炸不可能:上下文闸逐面钉测试(entryHooks.test.ts 路径闸、dataDictKeyCompletion.test.ts:69 非字典接收者不接管、各键位面非键位返回 null 落回既有链契约)。
- SemanticTokens 双开竞争:默认关(§1 裁定),配置面可开。

## 4. 已知风险与未决事项(如实登记,非本矩阵裁定解决)

1. **HEAD pyrightconfig executionEnvironments 分析倍增风险**:每个角色环境 extraPaths 含 scriptsRoot+stubRoot 全树(pythonProcessConfig.ts:42-48),N 角色在场时共享树被重复分析 N 份,Pylance 内存/CPU 随角色数放大。属 HEAD 新面(0.1.2 发布包无此面,2026-10-21 包核实)。候选改进(未实现,需独立批+测试):角色环境 extraPaths 收敛为 角色目录+角色桩+common,靠 stubPath 供桩,消共享树重复。**用户 Pylance 崩溃事件与本风险的关系待日志实证**——0.1.2 无 pyrightconfig 面,崩溃机证据(日志)未到位,本机已卸载两扩展并清理其写入的 liv-ws extraPaths(2026-11-16)。
2. **severity override 写入**是跨工具干预(Pylance 的诊断键被 Kode 改)——有键级保护与可关性,登记为已知干预面。
3. Pylance 缺席场景的 Kode semanticTokens 自动启用:候选未实现。

## 5. 修订记录

- 2026-11-17 首版:代码审计基线(94790af6..f732df03 线);崩溃事件待用户日志,证据到位后修订 §4.1。
