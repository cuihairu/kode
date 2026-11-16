# RUST-237 验收纪要:Engine 兼容(官方支持版本+用户 fork,profile 未知降级)(纯对账)

日期:2026-11-17。本纪要对账 RUST-237(旧 QA-008,主 todo 排队项)的验收口径与交付证据。结论:**两维全有既有面——官方/fork 版本分层归属(KB-VER-002 三档+fork 预设)+未知降级(RUST-009 三轴架构性 PASS 审计+profileHealth/engineApiMetadata 不造假面),整合验收零代码缺口,纯对账收口。**

## 验收维度 → 交付证据映射

| 维度 | 既有面 | 证据 |
| --- | --- | --- |
| 官方支持版本 | KB-VER-002 版本分层归属三档:官方 3.7.3 基线/fork 3.12+ 新增/待取证(pending 如实不猜);版本标注按**当前引擎分支**计算(官方树显「需 fork(fork-3.12 新增)」,fork 树不注,pending 显「版本归属待取证」),hover/补全/桩 docstring 同源;事实源 api-*.md 契约门(KB-VER-001) | `src/kbeModuleIndex.ts:43-522`(engineApiVersionAnnotation);RUST-224 对账(e131b804:版本差异=符号级归属注非全 API diff 矩阵,诚实条款在案);事实源 docs/knowledge/api-baseapp.md 等 deviation 表 |
| 用户 fork | fork- 前缀预设(fork-3.12 等)视为魔改 fork 已含该符号;引擎树探测式消费(双标记+existsSync+`KBENGINE_ROOT=off` 显式关);锚点校准到已提交引擎树(36/36) | kbeModuleIndex fork 分支逻辑;`hook-anchors-vs-engine-tree` 走查记录;桩包 README fork 钉点 28d2117(再生成说明防手改漂移) |
| profile 未知降级 | 三轴架构性 PASS:①backend 非法值回落 ts 安全侧;②kode-server 缺失/崩溃→TS 轨道+有界自动重启+版本门杀进程;③无引擎源码→`unknown` 元数据不造假+兼容性 warning+profile 健康不 throw;activeProfile 未知 ID 拒绝(不落盘不发事件不伪造);profileHealth engineRoot 未记录/不在盘上如实登记(RUST-229 当日六类) | `docs/review/2026-11-15-rust-009-degradation-usability.md`(三轴全谱扫+A1 修复+A2/A3 登记裁定);`src/activeProfile.ts`/`src/projectProfiles.ts`(未知 ID null 语义);`src/profileHealth.ts` |

## 自我验收证据

- RUST-009 审计(2026-11-15)三轴判定与测试网盘点在案;RUST-224(RUST-136 版本面)/RUST-229(profileHealth 六类)当日邻近批对账记录在案。
- profileHealth/hoverGapArms/activeProfile 相关套件当日全量 unit 10659(2113d5f4 门禁)内绿。

## 诚实条款

- 「官方支持版本」的版本面=**符号级归属注**(哪个符号哪个版本引入),非全 API 面 diff 矩阵(RUST-224 诚实条款原样适用);引擎版本设置供给链归 RUST-113 域(RUST-136 余项登记在案)。
- 用户 fork 兼容=fork 树探测+fork- 预设+桩包 fork 钉点;任意魔改 fork 的未登记符号无版本归属=pending 如实,不做冒充。
- 「profile 未知」的降级以 RUST-009 三轴审计交付;profile 数据本身损坏(非法 JSON 等)走 resolve null 如实(未单独立例,审计 A2/A3 登记面覆盖口径)。
