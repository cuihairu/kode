# KSEM-STRUCT-08 对齐类型桩与编辑器结果

**日期**:2026-11-13
**条目**:`todo.md` KSEM-STRUCT-08 [P1]「对齐类型桩与编辑器结果。验收:相同语义的快照生成一致的类型桩和编辑器提示,循环别名、未知类型、不同根的同名类型等边界一致处理。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 相同语义的快照生成一致的类型桩和编辑器提示 | 真缺陷=同名去重三套判据打架:提取层 `[...types, ...aliases]` 不去重 → 存根 plan 先见保留、交互链 `buildResolutionContext`(名序 Map)后见覆盖、实体桩 context Map 后见覆盖、`.find` 面先见——同一快照两答案。修法=提取层单点去重 `dedupeCustomTypesByName`(引擎口径:types.xml 先见保留、alias.xml 靠后作废、单文件内文档序先见),三个消费方共用一份,存根与补全/悬停/跳转必然同条 |
| 循环别名等边界一致 | 共享解析链既有口径本就同源(禁第二套,2026-10-30 定案),本批补 parity 钉子:CY_A↔CY_B 桩整链跳过随「环」原因 / 交互 Any+「环」原因——同一引擎依据 |
| 未知类型 | 两向一致钉子:GHOST 桩 Any / 交互 Any+「未在 types.xml/alias.xml 解析到」 |
| 不同根的同名类型 | groupCustomTypesByModule 按镜像目录分件:不同目录同名各发射独立 kbe_types 分件,互不吞噬(钉子) |

## 2. 引擎真值

- datatypes.cpp `addDataType`:同名类型重复注册被拒——先注册者生效;加载序 types.xml 先、alias.xml 后 → alias 同名条目作废;
- types.xml 单文件内重复声明:同文件注册序=文档序,先见保留;
- 一个 workspaceRoot 恰有一份 types.xml + 一份 alias.xml(layout.typesXmlPath 单路径),不存在多文件竞争。

## 3. 改动面(零新诊断族/零新开关)

| 文件 | 改动 |
|---|---|
| `src/definitionWorkspace.ts` | 新导出 `dedupeCustomTypesByName`(canonical 序=alias 靠后+名字序;kept+duplicates 两向);`getCustomTypeInfos` 返回 `kept`(旧尾部 `.sort` 移除,kept 已名序) |
| `src/pythonTypeStubs.ts` | `buildPythonTypeStubPlan` 内联去重循环换 `dedupeCustomTypesByName`,duplicates 映射为 skip 项(原因=与胜者 出处:行 同名,引擎拒绝重复注册);`buildResolutionContext` 名序 Map 后见覆盖 → 同 helper 的 kept |
| `src/entityTypeStubs.ts` | `buildEntityTypeStubPlan` context 表换同 helper(旧:无序 Map 后见覆盖) |

## 4. 诚实边界(测试钉死)

- `.find` 直查面(stub plan 内 aliasType/implementedBy 查找)吃 kept 序,与 plan 主表天然一致——不另设判据;
- 去重只在同名内裁决:不同名的 alias/type 条目顺序保持 canonical 序(alias 靠后+名序),桩发射序随 kept,与旧行为在无重名语料上逐字节同;
- 交互链 `resolveAnnotationTypeWithReason` 消费 getCustomTypeInfos 输出,链内 `.find` 先见=kept 首条=plan 胜者,无第二套判据引入;
- 循环/未知/跨根三边界是既有共享链行为,本批只加 parity 钉,不改语义。

## 5. 证据

- 一致性套件:`tests/pythonTypeStubs.test.ts` 新 describe 5 例(DUP_LIST 双文件同名→桩 str+交互 str+原因 null;属性面同 str;循环 CY_A↔CY_B 两向环原因;GHOST 两向 Any;跨镜像目录同名两分件无 skip);
- 提取层:`tests/definitionWorkspaceBranches.test.ts` 新 describe(types.xml+alias.xml FOO 同名→FOO 取 types.xml STRING;types.xml 内 TWICE 文档序先见 1 条;ONLY_TYPES/ONLY_ALIAS canonical 序断言);
- prove-red:`git stash push -- src/` 后 3 例红(2 文件),恢复 98/98 绿;
- ANCHORS:STRUCT-08 触及文件(definitionWorkspace/pythonTypeStubs/entityTypeStubs)均无锚点,零锁步;
- 门禁:eslint 0 / tsc 0 / vitest 747 文件 9163+8skip 全绿 / xvfb demo 25 RC=0。
