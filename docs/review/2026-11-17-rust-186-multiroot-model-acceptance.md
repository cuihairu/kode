# RUST-186 验收纪要:Multi-workspace 子项目与多资源 root 工程模型 + 显式配置示例对账

日期:2026-11-17。本纪要对账 RUST-186(旧 KBE-016,主 todo 排队项)的验收口径与既有交付证据。结论:**子项目模型、多资源 root 生命周期、显式配置示例均已交付且各有钉;本批为纯对账收口(零代码增量),回退语义与在途文件边界见末节。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| 子项目工程模型 | 项目 profile(IDE-PRJ-001):一条 profile = assets 根 + engine 根 + 显示名 + Python 解释器(IDE-PRJ-004,缺失如实 null);稳定 ID 创建时一次分配(randomUUID)、持久化 workspaceState、改名/改根/换组合身份不漂移、同名两条共存合法;活动 profile(IDE-PRJ-010):按稳定 ID 持久选择,真实切换(新 ID≠旧 ID)恰发一次事件,未知 ID 拒绝,记录被删时选择如实 null 不伪装有效;资产根优先(IDE-PRJ-013):def/python 输出根按所选 profile 解析 | `src/projectProfiles.ts` / `src/activeProfile.ts` / `src/codeGenerator.ts`(IDE-PRJ-013);17 个消费者;`tests/activationProfile/activeProfile/ensureDefaultProfile/generatorProfileSwitch/profileDatabaseConnection/engineProfile` 等 8 个测试文件 |
| 多资源 root 生命周期 | 服务端根注册表(RUST-069-W):WorkspaceSession 唯一根注册表,id 只经 session 发号(化身隔离,id 永不复用),新增/移除经真实 RPC,共享缓存(document-store overlay / hover-engine 符号+语料+def 候选)按登记序扇出清除且回执带每消费面清除数,未知根诚实回 `removed:false` 不抛不猜;`$/kode/workspace/roots` 对账面 | `crates/kode-server/src/root_lifecycle.rs` / `server.rs:420`;`tests/kodeCoreRootLifecycle.test.ts` / `kodeCoreGateRoots.test.ts` / `kodeRootParity.test.ts` |
| 根归属与多根扫描 | TS 共享助手 `getWorkspaceRootForDocument`(definitionWorkspace.ts:167):workspaceFolders 前缀匹配(`folderPath` 精等/带分隔符前缀),无文档上下文回落首根;21 个消费者;`findFilesAcrossRoots` 多根文件扫描;根感知面族:assetsRootScan/pythonRoleRoots/compositionRoots/configDeriveScanRoot/rootConfigGeneration(布局探测按 rootConfigGeneration 键控缓存);多根链钉:debugConfigMultiRoot / processTopologyMultiRoot(KR-AUD-54:三处无参调用审计) | `src/definitionWorkspace.ts`;`tests/definitionWorkspace*.test.ts` 4 文件 + 上述多根测试族 |
| 显式配置文件示例 | configuration 指南(英/中)显式示例:`kbengine.httpRequests` 数组默认含一条禁用热更示例(`POST http://127.0.0.1:8090/hotfix?module_name=<module>`,查询串与 body 双带 `module_name` 的原因写明)、键位 JSON 示例、14 个代码块;projectWizard 显式装配流(引擎路径/profile 向导) | `docs/guide/configuration.md` / `docs/zh/guide/configuration.md`;`src/projectWizard.ts` |

## 本批增量

- 零代码增量:模型与钉均既有(8 个 profile 测试文件、根生命周期测试族、21 助手消费者、KR-AUD-54 审计钉),本批只做验收对账;再造等价钉属仪式性重复。

## 诚实条款

- `workspaceFolders[0]` 首根回退是「**无文档上下文**」的共享回退语义(共享助手自身回落亦然),不是多根建模缺口:有文档/URI 上下文的面走前缀匹配根;纯命令入口(无活跃编辑器)的首根语义在此如实登记,不冒充全根遍历。
- profile 切换是显式用户行为(命令/向导),不存在「按文件位置自动切换 profile」——未实现的面不宣称。
- configuration 指南(英/中)与多个 docs 文件当前有并发会话在途编辑,本批只引用其已提交内容,不做改动。
- 本地引擎树为单根单版本(官方 3.x);多根/多 profile 的组合差异以测试桩与多根 fixture 覆盖(processTopologyMultiRoot 等),未集成真实多引擎根工作区样本。
