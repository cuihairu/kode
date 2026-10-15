# TODO

> 完成项一行证据（commit + 测试数）；未完成项一句需求。版本号冻结 0.1.0，发版由用户手动触发。

## 未完成

- [ ] 发布到 VSCode Marketplace（仅用户手动执行：先在 package.json 提交目标版本号，再手动触发 Publish to Marketplace 工作流并填同一版本号；不打版本号 tag、不建正式 Release。发布准备已完成，见已完成「Marketplace 发布准备」）
- [ ] P2 G4 客户端实体/SDK 多语言生成（来源:盘点 G4;向导骨架已有,语言种类 C#/TS/C++/GDScript 等用户点名单再排）
- [ ] P3 G7 生成器形态扩展（newProxy/newSpace/newComponent/newFixedDict 等向导;来源:盘点 G7;实体向导已有,其余按需）
- [ ] P3 G8 性能剖析（TICK/CPROFILE/PYPROFILE/EVENT/NETWORK;来源:盘点 G8;Nex X 走 KBE Nex 3.x 管理协议,本仓面向经典 kbengine 协议可用性未证,不排期直到用户点名）
- [ ] P3 G9 Space Viewer / Watcher 查询面板（来源:盘点 G9;同 G8 依赖引擎管理协议,监控面板已有 machine 基础状态,逐批点火前先证协议）
- [ ] 不排期 G10 Robots 管理 / 插件市场 / 工作区初始化（来源:盘点 G10;超出工程内开发工具定位,用户点名再评估）

> 2026-10-16 巡检复核（PATROL1016）:六项 open 全部为「触发条件未到 / 已裁决搁置 / 外部阻塞」,逐条复核解锁条件均仍成立,无重开项。①Marketplace:publish.yml 完好（仅 workflow_dispatch、版本号输入须与 package.json 一致、publisher=hairucui 校验）,version 仍冻结 0.1.0,解锁=用户给版本号并手动触发。②G4:等用户点名 SDK 语言清单,未收到点名。③G7:生成器其余形态按需,未收到需求点名。④G8:经典 kbengine 引擎仓（只读）核对仅见进程内 pyprofile handler（kbe/src/lib/pyscript/pyprofile_handler.cpp）与内部定时器枚举,无 TICK/EVENT/NETWORK 网络管理协议面,Nex X 的 KBE Nex 3.x 协议对经典引擎不可用,「不排期直到用户点名」维持。⑤G9:同 G8,协议前置未变。⑥G10:超出工程内开发工具定位的裁决维持,等用户点名再评估。
- [x] 批134 types.xml 表结构形态悬停 + 类型引用反扫 CodeLens — `3f02b50`（+2 测试文件 31 例（10 索引/形态契约 + 9 悬停 + 12 镜链），全套 1945 用例绿，coverage 100%×4（8732 stmts/5273 branches/1485 funcs/8496 lines）；`declaredType` 从属性/FD 键/数组元素三个解析点把原始 `<Type>` 文本带到列上，反扫落点直接取 schema 快照单一实现；`getTypeStorageShape` 形态数据 + `describeTypeStorageShape` 措辞（builtin 主表单列附列型、FIXED_DICT 平铺、ARRAY 子表递归一层、未解析明说装载失败、别名环 seen 短路）；悬停 `getCustomTypeHover` 声明行追加落库形态段（implementedBy 值除外）；`TypesXmlCodeLensProvider` 一条使用一枚镜（`Hero.itemId → tbl_Hero.sm_itemId`）点击走 `kbengine.database.open` 定位列，超 10 折叠 `+N 处落库未列出` 计数镜，无引用不出镜，watcher 挂 `**/*.def`/`**/types.xml`/`**/entities.xml` 失效重扫；**批133 遗遗留关闭**：引擎源码坐实 `xml.cpp:121-128` getValStr 只认文本、`datatype.cpp:1658-1712` of 取文本、`datatypes.cpp:105-169` 条目指引读首子文本，demo fixture 三处 `<of>` 写法不合引擎语义是 fixture 错不是解析器错，已修为规范形态并补 sm_value 元素列/skillSlots 子表断言；**fixture 打包修复**：components/.gitignore、interfaces/.gitignore、user_type/.gitignore 三个空目录占位模板把 Inventory.def、ROLE.def、SKILL_SLOT_DATA.py、POSITION_DATA.py 排除在版本库外（65 vs 台账 76 文件，fresh checkout 测试必挂），删占位并补录；extension.test CodeLens 注册 1→2、终配 watcher 探针改样式集合记录；来源:用户「那么能不能在type.xml 中展示表结构呢?」+ 拍板「形态 + 引用反扫 CodeLens（推荐）」）
- [x] 批135 代码侧属性标记反向跳转 — `2a7c78b`（+1 测试文件 16 例 + defAnalyzer 域位 4 例 + manager 解析面 5 例，全套 1972 用例绿，coverage 100%×4（8779 stmts/5293 branches/1499 funcs/8540 lines）；字面需求不可行——Python 脚本无类型名可写，落地为可行等价：`.py` 实体脚本 `self.<属性>` 访问处一行 CodeLens `属性 · <[槽名.]属性> · <Type> · <可见域> · Persistent?`，点击回 def 声明行；`propertyFlagDomainList` 与属性判重同源同表（common.h 旗标真值），域位定序 base → cell → client 不依赖 Set 迭代序；解析走 `resolvePropertyDefinitionInfo`（与属性 F12 同一索引同口径，新增 `PropertyDefinitionInfo` 带 Type 直文本/可见域/持久化，`<Persistent>` 缺省视作非持久），同一属性多处访问按（根段,完整路径）键只解析一次但每处访问都出镜（读者停在任意行都看得到标记）；组件槽属性标 `healthPack.regen` 形态、接口继承属性按 ALL_CLIENTS 出 cell|client、恒等锁 CodeLens 注册 2→3；只认 `self.<属性路径>` 形态与 F12 一致，`self.get('属性')`/`self.set('属性', 值)` 引擎 API 形态不在识别范围（module docstring 明示）；来源:用户「从types.xml 可以跳转到具体的代码，但从代码上没有类似的 type 的标记反向跳转」）

## 已完成

- [x] P2 G6 原始日志 ERROR 扫描视图 — 批137（`src/logErrorScan.ts` +1 测试文件 21 例（签名归一 2 + 可扫名 1 + 单文件聚合 2 + 目标收集 3 + 整批扫描 2 + real deps 1 + 面板 7 + 命令 3）+ extension 装配 1 例，全套 2070 用例绿，coverage 100%×4，mocha 11 绿；`kbengine.logs.scanErrors` 选文件/文件夹（一层 `.log`/`.txt`/`.out`，按名排序、fsPath 去重），行过 LogParser 后 ERROR/CRITICAL 按「组件+归一签名」（数字折 N/空白压缩/截 160）聚合计数，面板给计数/级别/组件/签名/最近时间，点击行开源文件定位首见行，「重新扫描」按上一批文件重跑；时间只认行内带时间戳的格式，非标准行记 null 显示 `—`；单文件 64MB 上限与读取失败记 readError 不中断其余；与日志面板同解析器，不依赖 logger 协议；来源:盘点 G6 + 巡检推进单 R1016D）
- [x] P2 G5 自动热重载 — 批136 G5（`src/hotReload.ts` +1 测试文件 15 例（默认值与畸形回落 4 + 去抖触发器 5 + 装配 6）+ quickActionManager runByName 5 例 + extension 装配 1 例，全套 2048 用例绿，coverage 100%×4（9015 stmts/5406 branches/1559 funcs/8769 lines），mocha 11 绿；`kbengine.hotReload.{enabled=false,actionName,globs,debounceMs}` 门控默认关防误触，开启才按 globs 各建一个 watcher（@types/vscode 只收单个 GlobPattern）、变更/创建/删除三通道事件经注入计时器去抖合并，配置变更监听联动拆建、subscriptions 只挂一条复合 disposable 随激活拆除；触发经 `QuickActionManager.runByName` 复用白名单三后端，跳过确认框、按名找不到只落 OUTPUT 通道流水不弹窗、空名字直接返回，执行照常写「上次执行」记忆供 Explorer ▶ 指向；配置容忍式读取（类型错/负去抖/剔空 globs 一律回落默认，不中断装配）；来源:盘点 G5 + 巡检推进单 R1016A）
- [x] P1 G3 `.kbengine/debug.json` JSON Schema 校验 — 批136 G3（`src/debugJsonSchema.ts` 构建 schema + `package.json` 新增 `contributes.jsonValidation`（fileMatches `**/.kbengine/debug.json`，264 行内联对象）+1 测试文件 9 例（清单贡献 3 + 结构 4 + 解析器对拍 2），全套 2027 用例绿，coverage 100%×4（8937 stmts/5367 branches/1535 funcs/8693 lines），mocha 11 绿；整份文件编辑器内直接标红（调试段 defaultTelnetHost/telnetPort 默认、元件段 telnet* + telnetEnableCommands 数组 + pathMappings localRoot/remoteRoot 必填、顶层 version+debug 必填、quickActions 三后端 anyOf 各自必填），VS Code JSON 扩展承担校验零运行时代码；`quickActionConfig.ts` 导出 `HTTP_METHODS`/`QUICK_ACTION_TYPES` 作 schema 枚举真源，清单内联对象与 TS 构建产物由测试深等锁定防漂移，且锁死 schema 不落独立文件；校验只作提示，解析器逐条剔除与类型回落规则不变；来源:盘点 G3 + 巡检持续推进单）
- [x] P1 G2 KBEngine Python API 存根导出 — 批136 G2（`src/pythonStubExport.ts` +1 测试文件 14 例：路径/同源内容 5 + 装配 9，+pythonExtraPaths 4 例（extraManaged 计划 1 + stub 目录并入 3），全套 2018 用例绿，coverage 100%×4（8924 stmts/5367 branches/1531 funcs/8682 lines），mocha 11 绿；`kbeModuleIndex` 抽共享发射器 `emitKbeStubBody`（虚拟桩文档字节不变），`buildKbeStubExportContent` 头部生成物口径（自动生成/重导出覆盖/建议 gitignore）；导出 `.kbengine/stubs/KBEngine.pyi`：内容一致零写、陈旧或读不到重写、目录不可写告警续行、`kbengine.python.stubExport` 默认开可关、激活期静默自动一次、`kbengine.python.exportStubs` 手动入口导出后链同步；G1 接线扩 extraManaged：导出开且文件在盘才并入存根目录；来源:盘点 G2 + 巡检持续推进单）
- [x] P1 G1 Python 生态 extraPaths 接线 — 批136（`src/pythonExtraPaths.ts` +1 测试文件 20 例：规范化/根发现/差量计划 14 + 装配 6，全套 2000 用例绿，coverage 100%×4（8867 stmts/5337 branches/1519 funcs/8625 lines），mocha 11 绿；scripts 根按 entityMapping 同口径三条前缀 + 批129 一级 `*_assets` 约定发现，只收磁盘存在项；WorkspaceFolder 级写 `python.analysis.extraPaths`，只管理自己那一段——上次写入集记 workspaceState、再同步先剔除，用户手填路径永不被动；无变化不写、无可发现根静默；激活期自动同步一次全程零提示，`kbengine.python.syncExtraPaths` 手动重跑播报结果，`kbengine.python.extraPathsSync` 默认开可关；激活期提示污染装配测试两例暴露设计缺陷→改静默约定，来源:盘点 G1 + 巡检推进单）
- [x] Marketplace 发布准备 — esbuild 单文件 bundle 打包链（mysql2/vendor 内联进 out/extension.js，vsce 锁 3.9.1 + `--no-dependencies` 绕开 pnpm 布局 ELSPROBLEMS，`.vscodeignore` 重写收紧）+ galleryBanner（logo 实取色：`#1296DB`、主题 dark）+ `publish.yml` 手动发版工作流（仅 workflow_dispatch 带版本号输入，输入须与 package.json 一致，publisher 非 `hairucui` 直接失败，compile/test/lint 门禁红则不发，凭据仅 `VSCE_PAT` secret 无明文）— 本地打包 15 文件 626.03 KB（`vsce ls` 审计恰 13 项载荷），vitest 1945 + mocha 11 绿，coverage 100%×4
- [x] CI 修复（run 38695297696 ENOENT demo fixtures）— 根因非 Node 24 亦非竞态：CI 跑在 `5c3a383`，该树没有 Inventory.def/ROLE.def/SKILL_SLOT_DATA.py/POSITION_DATA.py（components/、interfaces/、user_type/ 三个占位 `.gitignore` 把夹具排除在版本库外），补录已随批134 `3f02b50` 落地；本单叠加夹具目录改 `fs.mkdtempSync` 独立临时目录（`tests/kbengineDemoAssets.test.ts` beforeAll）防固定路径互抢 — 本地 v24.21.0 连跑 2 次 vitest 1945 + mocha 11 全绿 0 skip，coverage 100%×4
- [x] CI 修复（run 38705702432 / 38708536666 安装步失败）— `ERR_PNPM_IGNORED_BUILDS`：新增 `@vscode/vsce` 带进 keytar（原生凭据库）与 @vscode/vsce-sign（签名器），pnpm 12 对未放行安装脚本直接报错，CI 在 `安装依赖` 步即红（本地 `pnpm add` 只告警故未暴露）；`pnpm-workspace.yaml` 的 `allowBuilds` 补放行两包，vsix 签名与发布凭据链可用
- [x] logo 换新（用户直接提供素材）— `resources/logo.svg` 用户矢量源落仓（蓝底 K 镂空 `#1296DB`），PNG 按同一素材栅格化 512×512 换入 resources/logo.png；vsce 禁 SVG 作 icon（`SVGs can't be used as icons`）故 PNG 走清单图标、SVG 留源；package.json 图标/活动栏接线不动；galleryBanner 配色改 `#1296DB`（logo 取色口径）；icon.test.ts 补矢量源在位/品牌色/banner 取色三锁，打包防漏锁 CRITICAL_ASSETS 补 logo.svg — vsix 16 文件 633.88 KB
- [x] 批124 def 图形化架构流程图 — `1e93f24`（+2 测试文件 62 例，全套 1743 用例绿，coverage 100%×4；webview 内 client→base/cell 方法调用与属性自动同步，边语义按 Flags 位带引擎出处与成员声明回跳，未 Exposed 方法单列，导出 Markdown/SVG/PNG）

- [x] Marketplace 截图准备 — 6 张实机截图落 `docs/screenshots/`，README 双语引用 — commit `8c3ffec`（截图批）/ `b683108`（README 引用）
- [x] KBENGINE_SOURCE_AUDIT_PLAN 13 个功能块逐块复核 — 块4 检查项 9 项补记 `8252760`；块8 文本形态 Parent 收口 `f76bdca`（纯函数 8 例 + 锁定用例）；块12 日志定案 b 不支持（计划文档块 12 已记）；其余 10 块已对照无漂移
- [x] 导航与配置在途派单 4 条 — 默认开启 `dbd65c5`、逐字段重写与 telnet 纠错 `00f2cf3`、导航四档收口 `3b45b67`
- [x] 批116 继承链跨文件同名检查 — `8252760`（+7 用例）
- [x] 批117 Interfaces 装载语义对齐 — `c1d8ba4`
- [x] 批118 导航布局补齐（bots/单数 interface/平铺/角色目录嵌套）— `353b837`、`8fa4b07`
- [x] 批119 依赖图继承边认文本形态 Parent — `f76bdca`（纯函数 8 例 + 锁定用例）
- [x] 批120 Persistent 属性悬停展示数据库落点 — `e96a586`
- [x] 批121 片段生成去公共缩进改 tabSize 列语义 — `6a89ecc`（+6 用例）
- [x] 批122 数据库模拟 — `b683108`（+2 测试文件，全套 1517 用例绿，coverage 100%×4）
- [x] 批123 网络包结构生成 — `e428848`（+1 测试文件 65 例，全套 1632 用例绿，coverage 100%×4；全仿真装配:属性/方法/组件槽/aliasID/types.xml 五路占号与冲突文案逐条对齐引擎，机读 JSON + 人读 Markdown 双产出）
- [x] 批125 配置自动发现与精简 — `b683108`（+1 测试文件，配置对照表入 configuration.md，干净工作区零配置可用核心功能）
- [x] 批126 RPC 方法标记 CodeLens — `b683108`（+1 测试文件 28 例，全套 1517 用例绿，coverage 100%×4）
- [x] 文档-源码一致性审计 23 项修复 — 见 `docs/审计-文档一致性.md`（超前 5 / 滞后 7 / 不符 11）
- [x] 批127 发现与定位失败可见 — `3f36eae`（+1 测试文件 24 例，全套 1548 用例绿，coverage 100%×4；`Show Discovery Report` 命令 + 激活自动报告，报告整段可复制回传）
- [x] 批128 `kbengine.configPath` 补约定发现 — `9ef2c58`（探针验收 + 约定/记忆/深扫描兜底，telnet 与最终配置视图同步受益；全套 1566 用例绿，coverage 100%×4）
- [x] 批129 发现与定位:引擎消息表双名与资产根 *_assets 约定 — `5f240f6`（+13 用例，全套 1885 用例绿，coverage 100%×4；深扫描收 `messages_fixed_defaults.xml`、四级优先级对齐引擎装载序 kbemain.h:71-74（工作区用户副本→源码根用户副本→工作区缺省→源码根缺省，两树独立不要求同目录）、纯资产工作区两份皆无标 informational 不计问题（仅源码根在而两份皆缺才报）、资产根约定链收一级 `*_assets` 目录如 flyff_assets（探针验收不变）；来源:用户报告纯资产工程 3 项问题误报 + messages_fixed_defaults 不被识别 + assets/xxx_assets 应进自动扫描）

- [x] 批131 assetsRoot 改名与 implementedBy 分段着色 — `2a4ab88`、`e9326cd`（+2 用例，全套 1887 用例绿，coverage 100%×4；`kbengine.configPath`→`kbengine.assetsRoot`（键/读取/测试 mock/报告标签与补救/三份指南+设计稿全量同步，默认 `${workspaceFolder}/server`→`""` 让未配置不再被伪装成显式配置，已配用户需重填）；implementedBy 值分段着色（点号前逐段=模块段 namespace scope 紫 #C678DD，紧贴闭标签段=符号段 variable.other 蓝 #61AFEF，裸值整段落符号段，分段对齐引擎 datatype.cpp loadImplModule 模块路径.实现对象 装载语义；来源:用户「3 都执行」+ 定名勘误 assetsRoot 复数）

- [x] 批132 官方模板测试验证工程 + 嵌套资产根脚本候选修复 — `6100888`（+1 测试文件 23 例 + 2 例分支直测 + 1 例无参入口，全套 1912 用例绿，coverage 100%×4（8584 stmts/5184 branches/1458 funcs/8356 lines，47 源文件全覆盖）；`tests/fixtures/kbengine-demo-assets` = 官方 SDK Python 模板逐字快照 63 文件 + 其上补 Avatar/Monster def、interfaces/ROLE.def、components/Inventory.def、含 implementedBy 的 types.xml、user_type 实现模块与各角色脚本，共 76 文件；`tests/kbengineDemoAssets.test.ts` 在「打开资产根上层」的工作区形态下一次走穿发现→13 例定义导航→implementedBy 双向→RPC CodeLens 接口混入→数据库 schema（实体表/组件表/数组子表）→配置合并→静默红线；产品修复：getPythonCandidates 只拼三条工作区相对脚本根，嵌套资产根（`<repo>/<xxx>_assets`，官方模板形态）全 miss 致 pythonOwnerFiles 恒空、RPC CodeLens 与 Python→def 反向跳转整链静默失效，新增 getPythonScriptRoots 以 owner def 位置反推 scripts 根追加在既有候选之后（扁平布局顺序不变，嵌套只增补）；来源:用户「最好创建一个相对完整的测试验证的模板项目,kbengine 的模板里有的」）
- [x] 批132 补 数据库表结构入口不静默 — `6100888`（同上 commit；`kbengine.database.open` 命令面板无参直开经 resolveActiveDefEntityName 取活动 .def 推断实体、与 simulate 同口径，无活动 .def 弹「请先打开一个实体 .def 文件」而非命令体直接 return；唯一 UI 入口实为活动栏 KBEngine Explorer → Entities → 展开实体 → Database 分组，包级 menus 未给四条 database 命令任何挂点；入口说明补进 docs/guide/commands.md；来源:用户「我根本不知道哪里开启 数据库表功能没有」）
- [x] 批133 数据库表结构文档友好化 — `cdf302e`（+契约化 locate 断言与引擎列注解/兜底注解/路径显示/字段行识别四组用例，全套 1916 用例绿，coverage 100%×4（8638 stmts/5210 branches/1469 funcs/8403 lines）；中文标签渲染：头部概览+「读图方式」图例、每表 `表类型`/`定义来源`/`父表：`、字段分引擎列（固定语义逐列注解）/属性列两组、属性列行尾 `← 文件:行 <属性>` 标 def 落点、空属性列表照实提示；`locateDatabaseSchemaLine` 弃手写行数镜像改解析渲染文本（TABLE 锚点+字段行识别导出为 `databaseSchemaFieldLineName`，与 `findDatabaseSchemaFieldAtPosition` 同源），TABLE 行与三行 SQL 逐字不动（F12 与粘贴依赖）；TESTING.md 批133 段登记遗留：ARRAY 标量元素 `sm_value` 列是否落库未从引擎源码坐实（`<of><Type> X </Type></of>` 规范写法经 `getScalarChildValue` 取不到，后续批定案）；来源:用户「看到database了，但这展示能在友好点吗，这都是啥啊」）

- [x] 快速执行动作（顶部按钮 / 配置驱动）——`bbf2cf9`（+4 测试文件 80 例，全套 1823 用例绿，coverage 100%×4；配置落 `.kbengine/debug.json` 顶层 `quickActions`，三类后端 `command`/`script`/`http` 白名单，路径走 `${workspaceFolder}`/`${env:}` 变量且未知变量报错中止，按钮挂 Servers 视图标题栏 + def/Python/XML 编辑器标题栏，首装扫一层 `.bat` 只收启停与导表两类多选登记并记忆取消）
  - 巡检复查修补 `c2a0c1a`（+1 用例，全套 1872 用例绿，coverage 100%×4）：后台脚本改等 `spawn` 事件再报「已启动」（起不来如实报错，不谎报）、回包恢复 4000 字符截顶、极简装配上下文缺 `workspaceState` 时首装扫描按首次运行处理
  - 动机：像 VSCode debug 界面那样，顶部能一键执行常用动作
  - 已点名的三类动作：① KBEngine 自带热更新 ② **自研的 HTTP 本地版本热更新** ③ 本地开服的 bat 脚本
  - 验收（本阶段）：需求边界先分析清楚并落档——动作种类清单、配置归属、按钮位置、变量替换与作用域、错误处理与日志去向；经用户拍板后再进实现
  - **用户 2026-10-14 已拍的五点**：
    1. **配置驱动动作注册**（方案 A）——动作由配置定义，不硬编码进 `contributes.commands`，加新动作不改代码、不重打包
    2. **配置跟 KBEngine 工程走**，不跟编辑器走——动作是 KBEngine 工程属性（换人/换机随工程携带），落点复用既有 `kbengine_debug.json` 那套配置
    3. **路径绝不写死**——每人打开的目录不同，必须支持变量替换（`${workspaceFolder}` / `${env:XXX}` 等）
    4. **按钮要能出现在面板上**——侧边栏 view 标题栏与编辑器右上角两处都要能挂
    5. **首次安装自动扫描 `.bat` 自动生成配置**——装完即有用，不要求用户手写配置
    6. **本地脚本范围已明确**（用户 2026-10-14）：基本就是**启停服务器**与**导配置表**两类，扫描与配置模型按这两类设计，不做泛化
  - 待补需求（原「未拍」）→ **四项已代决（巡检，2026-10-15，依用户 2026-10-14 授权；用户可推翻后回滚）**：扫描按建议（一层 .bat+词表+路径类别去重+仅无动作时提示确认+取消记忆）；确认后写入（quick pick 多选）；破坏性动作默认弹确认；失败输出走 OUTPUT 通道+弹窗不落文件
  - 实现方案已落档（待用户确认后开工）：数据结构/接口/目录结构/执行流程/测试计划见 `docs/design/quick-actions-and-db-hint.md` 1.8-1.11，批次 B/C 简案见 4.1-4.2；**用户 2026-10-15 已拍板开工**，追加安全边界：script 只执行配置里显式声明的脚本、http 只发配置里写死的 URL，执行期不拼接运行时参数
  - 现状核对：已是 VSCode 扩展；已注册 32 个命令（含 `kbengine.quickActions.show`、`kbengine.server.start/stop/restart/showLogs`、`database.simulate` 等）；已有 `src/debugConfig.ts`（`KBEngineDebugConfig`/`ComponentDebugConfig`/`DebugConfigFile`）；已有 1 个侧边栏 view + `view/title` 菜单 4 项

- [x] 需求：types.xml 着色增强（来源：用户 2026-10-14）— `8201a1c`（+1 测试文件 8 例，全套 1664 用例绿，coverage 100%×4；结论：types.xml 无独立 grammar、默认由 XML 插件接管 → 注入语法路线：package.json 贡献点 `injectTo:["text.xml"]` + 语法文件自带 `injectionSelector: "L:text.xml - (comment, string)"`（与 VS Code 自带 markdown-math/jsdoc 注入同机制），语义色不进注释与属性值、不抢类型定义标签；五 scope：内置 `support.type.kbengine.builtin` / 自定义引用 `entity.name.type.kbengine.custom` / ARRAY `keyword.other.kbengine.array` / FIXED_DICT `keyword.other.kbengine.fixed-dict` / implementedBy `variable.other.kbengine.implementedby`；KBEngine Dark 主题新增 5 条 tokenColors，五类两两可区分（真实 Registry+主题 tokenizeLine2 实测），Dark+/Light+ 下内置与自定义折叠为该主题标准类型色、两指令折叠为标准关键字色——scope 语义仍在，如实报告；验证为临时工作区 fixture 走查，真实 types.xml 在用户本机待实测）
  - 前提：types.xml **默认由 XML 插件接管**着色
  - 要求：在 XML 基础之上叠加 **KBEngine 语义着色**——
    1. **KBEngine 自带类型**着色（内置类型有别于普通 XML 文本）
    2. **用户自定义类型**也着色（能与内置类型区分开）
    3. **特殊指令 `ARRAY` 与 `FIXED_DICT` 需要特殊颜色**（显著区别于其它 token）
  - 实现提示：本仓已有 `grammars` 贡献点与自定义主题，先核对 types.xml 当前是**走 XML 语法还是已有独立 grammar**；若已有独立 grammar 则在其中加 token 与 scope，若依赖 XML 插件则用**注入语法（injection grammar）**叠加，避免与 XML 插件冲突
  - 验收：内置类型 / 自定义类型 / ARRAY / FIXED_DICT 四类在真实 types.xml 中颜色可区分；主题切换后仍可区分（用语义 scope 而非硬编码色值）

- [x] 缺陷：types.xml 跨文件引用跳转不精确 + 无反向跳转（来源：用户 2026-10-14）— `ed3cd2f`（+1 测试文件 14 例，全套 1656 用例绿，coverage 100%×4；正向 implementedBy 值落符号定义行（class/def/赋值三形态，引擎 datatype.cpp loadImplModule L2331-2357 两段语义），符号解析不到才回落首行；反向 Python 符号（定义名或任意引用处）跳回 types.xml 的 implementedBy 行 + 悬停提示引用方与落点；验证为临时工作区 fixture 走查，真实 types.xml 在用户本机待实测）
  - 现象一：`implementedBy` 引用形如 **`SKILL_SLOT_DATA.weapon_skill_slot_list_inst`**，其中 **`SKILL_SLOT_DATA` 是文件名或模块名**——**现在没有正确跳到具体的行**（只落到页面/文件，没落到那一行）
  - 现象二：**跳转只有正向没有反向**——跳过去之后回不来
  - 验收：`MODULE.symbol` 形式的引用要能解析并**跳到定义所在的具体行**；**支持反向跳转**（如转到定义 / 转到引用），**采用与既有方案一致的「提示 + 点击跳转」形态**，不另起一套交互
  - 提示：本仓已有跨文件跳转能力，先核对**符号解析是在哪一层做的**（是否只按文件名匹配而没解析模块内符号），复用既有跳转与提示机制

- [x] 缺陷：telnet 连接后窗口无法输入（来源：用户 2026-10-14）— `b2394ba`（+3 测试文件 10 例，全套 1642 用例绿，coverage 100%×4；根因两处：① 密码流握手后引擎五条 IAC 协商命令的字面 '\0' 终止字节缀在提示符后（telnet_handler.cpp L884-900），`looksLikePrompt` 匹配不到结尾 → 状态卡 awaiting-password → sendCommand 全拒；python 层提示符 `[x@python ~] >>> ` 空格形态此前只靠宽松备选兜底；② UI 侧每次下行输出整页重建 webview，输入框焦点+草稿全丢——已改 postMessage 增量渲染 + Ctrl+]/Ctrl+D 断开 + telnet 树标题栏断开按钮；真 TCP 引擎忠实协议验证 5/5：密码上行、命令上行、回显/响应下行、:quit 恒拒）
  - 现象：通过 telnet 连上（KBEngine 侧）后，**窗口无法输入**
  - 验收：先复现并给出根因 file:line（重点怀疑：终端/输入焦点未落到连接后的会话、输入框被禁用或未绑定到该会话、PTY/流未接管输入、连接成功后 UI 状态机没切到"已连接"分支）；修复后在真实连接下验证可正常输入命令并收到回显
  - 提示：本仓已有 logs 那组命令（`kbengine.logs.connect/disconnect/clear`），若 telnet 走的是同一套会话/终端组件，先核对**连接成功后输入通道是否被接管**，别另起一套终端实现
  - **配套需求：telnet 退出快捷键**（用户 2026-10-14）：支持 **`Ctrl+]`**（telnet 标准转义符）与 **`Ctrl+D`** 退出 telnet，并**在顶部同时给出对应入口**（快捷键 + 顶部菜单/按钮），不要只靠快捷键——用户需要在顶部能看到并点击

- [x] 属性 → 虚拟数据库表设计跳转与 SQL 生成（来源：用户 2026-10-14）
  - [x] 提示批（拍板 1-8 中的实现面）— `745d254`（悬停完整 `` `db`.`tbl`.`col` `` 全名 + 引擎 DDL 片段 + 具体限制数值：整数 MySQL 区间/varchar 缺省 255（entity_table_mysql.cpp:1829-1833）；连接要素读引擎配置 `<dbmgr><databaseInterfaces><default>`（端口 0→3306，db_interface_mysql.cpp:166-167；密码不读，encrypt=true 为 RSA 密文；按工作区+binPath 缓存，kbengine*.xml/配置变更失效）；schema 视图加 `Database:` 行 + 每表一行带库表前缀反引号转义的可粘贴 SELECT；ARRAY 悬停说明子表去向与 parentID 关联、跳转落子表行；修 locateDatabaseSchemaLine 子表字段行差一行（parent 注记未计入）；全套 1681 用例绿，coverage 100%×4）
  - [x] 真实表结构反向校验（漂移对比）— `b7eda34`（用户 2026-10-15 拍板走 mysql2 npm 依赖；新增 `src/databaseDrift.ts` + 命令 `kbengine.database.checkDrift`：报缺表/缺列/多列/型别不符/残留表，报告进 OUTPUT「KBEngine 数据库漂移」；连接要素读引擎配置不新增设置项（`<encrypt>false</encrypt>` 明文密码才读，密文不解读）；只读双保险=语句白名单 SELECT/SHOW/DESCRIBE/EXPLAIN（拒写语句/多语句/注释伪装）+ 建连即 `SET SESSION TRANSACTION READ ONLY`；连不上/读表失败一律降级「未校验」不报错；+2 测试文件 38 例，全套 1871 用例绿，coverage 100%×4）
  - [x] SQL 模板覆盖 + 自定义库表前缀 — `29b80fe`（schema 视图每表三行 SQL：全列 SELECT、`SQL(属性列)` 只列 def 属性落成的列剔引擎结构列、子表 `SQL(子表 JOIN)` 按 parentID LEFT JOIN 父表；ARRAY/组件悬停同给 JOIN 语句；新增 `kbengine.db.tablePrefix`（缺省空=引擎默认 `tbl_`）表名与模板同源替换；行号定位改为与渲染同源，不再各写一份；全套 1832 用例绿，coverage 100%×4）
  - 背景与拍板原文见 `docs/design/quick-actions-and-db-hint.md` 第二节

