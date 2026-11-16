# RUST-224 验收纪要:类型信息 UI 显示 Cell/Base/Client 上下文与版本差异,明确 unknown

日期:2026-11-17。本纪要对账 RUST-224(旧 UI-007,主 todo 排队项)的验收口径与既有交付证据。结论:**角色上下文(四层)、版本差异(KB-VER-002)、unknown 明确化(pending/Any)均有既有面与测试钉,本批为纯对账收口(零代码增量)。**

## 验收口径 → 交付证据映射

| 验收维度 | 交付面 | 证据 |
| --- | --- | --- |
| Cell/Base/Client 上下文(解析) | `compatibleContext`:同名类按 `scripts/<role>/` 角色目录(base/cell/client/bots 四角色)隔离——跨角色同名实体类不互绑,类型解析按光标所在文件的角色取正确实现(角色外文件不受限);基类链/子类查询同口径过滤 | `src/backend/pythonClassIndex.ts:285-295`;`:337/:1459/:1498` 三消费点 |
| Cell/Base/Client 上下文(桩) | 实体类型桩按进程分件:base/cell/bots/client 四组件独立目录(bots 归并 client),实体类 base/cell/client 属性按本实体 MB 收窄,KBEngine 导入带 EntityCall | `src/entityTypeStubs.ts:61,165-168,214-235`;`tests/entityTypeStubs.test.ts:97-101`(MB 收窄钉) |
| Cell/Base/Client 上下文(显示) | 进程归属透镜:目录角色→进程标注(base→baseapp、cell→cellapp)脚本直接可见;cellData 生命周期 hover 注记 base 快照 dict vs cellapp 语义分野(KSEM-CELL-14;Cell 持有判据 KSEM-CELL-11 entity.cell) | `src/backend/processOwnershipLens.ts`+专套件;`src/languageProviders/hover.ts:146-169`;`src/backend/cellDataHover.ts` |
| 版本差异 | KB-VER-002 版本归属注:KBEngine API hover 按当前引擎版本分支标注——符号属 fork(`需 fork(fork-3.12 新增,官方 3.7.3 基线无此符号)`,当前引擎即 fork 则不注);补全 documentation 与桩 docstring 同源标注(与 api-*.md deviation 表同源);引擎版本预设矩阵(官方 3.7.3/3.7.2/3.6.3/2.5.10+fork-3.12)供选择与 isKnownEnginePreset 提示 | `src/kbeModuleIndex.ts:502-522`(engineApiVersionAnnotation);`src/languageProviders/hoverBuilders.ts:200`(hover 挂靠);`src/engineVersion.ts:40-66`(ENGINE_VERSION_PRESETS) |
| 明确 unknown | 三层:①版本归属 `pending` →「版本归属待取证(官方 3.7.3 基线与 fork 3.12 间尚未定案)」如实不猜;②引擎树版本探针 `unknown` 回落(legacy version.h/kbeversion.h 双标记合成,探不到如实 unknown);③类型解析 Any/未解析如实计数(类型预览「typing 覆盖」叶子 `anyCount 处含 Any(未解析)`;解析不出 hover 如实不显示) | `src/kbeModuleIndex.ts:508-512`;`src/backend/engineApiMetadata.ts:108`(UNKNOWN_ENGINE_VALUE)+`:14-15` 双标记;`src/backend/typePreviewModel.ts:126-127` |

## 本批增量

- 零代码增量:三验收维均有既有实现与钉(pythonClassIndex/entityTypeStubs/processOwnershipLens/cellDataHover/kbeModuleIndex/engineVersion 套件),再造属仪式性重复。

## 诚实条款

- 「上下文」以**解析正确性**交付(光标文件角色决定解析到哪个同角色实现),hover 文案上无「当前角色: cell」文字徽标——徽标属展示增强,解析层已保证互不串扰;若需显式徽标,属新展示需求另批。
- 角色判定依据是**目录约定**(`scripts/<role>/`),非运行时进程探测——文件不在角色目录时不做角色隔离(compatibleContext 回落 true),如实宽松。
- 版本差异的粒度是**符号级归属注**(fork-only/pending/baseline),不是全 API 面逐版本 diff 矩阵视图;矩阵事实源在 api-*.md(KB-VER-001 契约门钉住与 catalog 一致),UI 只标注到符号。
