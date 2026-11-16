# RUST-171 审计:workspace discovery——KBEngine 工程识别与优先级

- 日期:2026-11-17
- 结论:**审计结案**。四道识别输入(设置/环境变量/约定+有界深扫描/记忆选择)全部在库且各有显式优先级、既有钉与文档;本批新增 3 钉钉死资产根合成序与环境变量分道(`tests/scanRoots.test.ts` 尾节「RUST-171 发现优先级」);**不把九个派生入口统一成单一「workspace 身份」解析器**——各入口在共享原语上按自身关注点组合,统一属行为变更,登记待用户拍板;`kbengine.managedDir` 未入 `package.json` contributions(Settings UI 不可见)登记为候选,不在本批动。

## 四道输入(任务词 → 实现)

| 任务词 | 实现道 | 核心锚 |
|---|---|---|
| 配置 | `kbengine.assetsRoot` / `kbengine.entityDefsPath` / `kbengine.entitiesXmlPath` / `kbengine.binPath` / `kbengine.python.stubDir`(变量展开单源 `renderPathTemplate`) | `src/definitionWorkspace.ts:184-332`、`src/backend/workspacePath.ts` |
| 环境变量 | 按关注点分道:`KBENGINE_ROOT`=引擎源码树(含 `'off'` 显式退出)/`KBENGINE_HOME`=bin 路径回退/`KBENGINE_STUB_DIR`=桩目录/`KBENGINE_WORKSPACE`=调试根/`KBE_ROOT`=引擎运行时 env(扩展构造给子进程) | `src/backend/engineApiMetadata.ts:97,121`、`src/serverManager.ts:445-446,505-517`、`src/pythonStubExport.ts:212-258`、`src/backend/debugConfigBootstrap.ts:38,170-207` |
| 源码结构 | 约定表 `DISCOVERY_CONVENTIONS`(entityDefs/entitiesXml/typesXml/kbeSourceAnchors/configRoots,`*_assets` 首层动态段)+ 引擎装载探针 `<candidate>/res/server/kbengine.xml` + 有界深扫描(深度 7 / 上限 20000,超限宁缺勿猜) | `src/workspaceDiscovery.ts:19-50,61-69,79-101,132-209` |
| 记忆选择 | 多候选时激活期 quick pick 一次,按根持久化 `workspaceState` | `src/workspaceDiscovery.ts:510-598`、`src/activate/utilityCommands.ts:681` |

「这是不是 KBEngine 工程」的门:`src/workspaceGate.ts:22-23` 信号 glob(`**/*.def`/entities.xml/types.xml/alias.xml/kbengine*.xml),fail-open;就绪判据=唯一 entity_defs 根(`src/startEntry.ts:63-78`)。

## 优先级(逐关注点,全部显式)

- **资产根(索引扫描/hover/jump/def 索引共用)**:profile 选定根 > `kbengine.assetsRoot` 设置(目录存在即用,不看探针——`src/scanRoots.ts:81-83` 刻意注释) > 自动发现(约定链探针命中 → 记忆选择 → 唯一深扫描命中,多候选 null 不猜;`src/workspaceDiscovery.ts:427-439`)。本批新钉三例钉死:profile 存在优先/不存在如实落空/`KBENGINE_ROOT`+`KBENGINE_HOME` 即使指向引擎树形状也不入资产根链。
- **def 族**:设置值 > 发现选择/深扫描仅当配置解析路径不存在;entities.xml 优先 def 根父级;`interfaces/`+`components/` 从 def 根派生(`src/definitionWorkspace.ts:184-332`)。
- **服务器启动 configRoot**:profile > 设置(引擎探针验收)> 发现 > 原值;binPath:profile > 设置/默认(CFG-01 三分支)> 探测链 kbe 源根 → 兄弟目录 → `KBENGINE_HOME` → 硬编码绝对路径(`src/serverManager.ts:364-374,379-461`)。
- **引擎源码树(API metadata)**:显式 options > `KBENGINE_ROOT`(非 `'off'`) > `../kbengine` 兄弟;标记=`version.h`|`kbeversion.h`(`src/backend/engineApiMetadata.ts:90-106`);`'off'` → unknown 不伪造版本。
- **桩目录**:设置 > `KBENGINE_STUB_DIR` > `<managedDir>/stubs`(`src/pythonStubExport.ts:212-258`)。
- **messages 四级**:工作区用户副本 → 引擎源根用户副本 → 工作区 defaults → 引擎源根 defaults(独立树取,无同目录要求;`src/workspaceDiscovery.ts:469-500`;文档 `docs/guide/configuration.md:693`)。

## 已有钉(逐链接,不重钉)

约定先于扫描/记忆胜过歧义扫描/记忆失效/`*_assets`/多候选 null(`tests/workspaceDiscovery.test.ts:565-628,:254-330`);发现报告字段与四级 messages(`tests/discoveryReport.test.ts:260-483`);`KBENGINE_ROOT` 树标记与 `'off'` 退出/兄弟目录(`tests/engineTreeProbe.test.ts:31-88`);stubDir 三级(`tests/pythonStubDir.test.ts:55-91`);`KBENGINE_HOME` bin 探测序(`tests/serverManagerGaps.test.ts:197-212`);`${workspaceFolder}` 展开等价(`tests/pathTemplateEquivalence.test.ts`)。

## 缺席清单(诚实边界)

1. **资产根无环境变量道**——分道设计而非遗漏:每个 env 变量只管自己关注点;新钉把「不越道」钉死。
2. **无统一「workspace 身份」解析器**:九个派生入口(启动 configRoot/binPath/扫描根/组件 xml/引擎 defaults/def 族/默认 profile/导入识别/API metadata)各自在共享原语上组合;两套接受判据并存(引擎探针 vs 目录存在,后者 `src/scanRoots.ts:81-83` 注释刻意)。统一=行为变更,登记待用户拍板,不在审计批内重构。
3. **无 `kbengine.defRoot` 设置**:真实键名 `kbengine.entityDefsPath`/`kbengine.entitiesXmlPath`;`types.xml` 无设置(候选链硬编码,报告 facts 该字段恒空串)。
4. **发现面无 KBE-CFG 诊断码**:发现报告用 `ok|ambiguous|missing|informational` × `explicit-config|remembered-choice|convention|deep-scan|derived|fallback|none` 枚举表达;`KBE-CFG-001..006` 是 configContract lint 规则族,两回事。
5. **`kbengine.managedDir` 读而未贡献**:只在 `package.json:188,1051` 以命令出现,Settings UI 不可见——登记候选。
6. **引擎源码树有四个互不咨询的推导面**(API metadata/env/兄弟;`resolveKbeSourceRoot` 工作区锚;`projectImport.identifyEngineRoot`;`detectBinPath` 兄弟+env+硬编码)——各自服务各自关注点,标记文件族不同(`version.h` vs `entitydef.cpp`);同 2,统一属设计变更。
7. `getBinPath` 对 `KBENGINE_HOME` 无 `'off'` 逃生(API metadata 有)——现状如实记录。

## prove-red(两变异两红,cmp 还原)

- 变异 a:去 profile 闸(`src/scanRoots.ts` 活动根判据置 false)→ 新钉「profile 选定根存在 → 优先」红;
- 变异 b:给资产根链塞 env 泄漏道(首判据改读 `KBENGINE_ROOT`)→ 新钉「env 不入资产根链」红;
- cp 备份 + cp 还原 + `cmp` 字节校验,复跑 14/14 绿。
