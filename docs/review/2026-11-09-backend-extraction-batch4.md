# TS 后端独立目录抽取 · 批次 4(database 纯逻辑族)2026-11-09

续批次 1-3,同式推进。

## 范围(11 件,`git mv` 至 src/backend/)

databaseSchemaCore / databaseSchemaTypeStorage / databaseColumnSource /
databasePreviewColumnSource / databaseDrift / databaseDriftEvidence /
databaseQueryLifecycle / databaseSchemaSource / databaseSchemaImpact /
databaseConnectionRegistry / databaseTablePreview

选族依据:零 `from 'vscode'` 的 database 纯逻辑件。**留 src/ 的 database 面**:
databaseSchema(vscode 混合)、databaseWiring / databaseSchemaPresentation /
databaseSimulator / databaseManagementWebView(Html)/ *Command / *Integration
(装配与命令胶水)。

## 改动面

- import 重基 76 处(89 计 - 13 既有假阳性):src 侧 25 处(databaseSchema /
  databaseWiring / *Command / *Integration / playerDataCloneMysql /
  profileDatabaseConnection / entityFlowWebView / playerDataPanel /
  databaseManagementWebView 等),tests 侧 23 文件 51 处。
- **跨批次组合修正 1 处 + 工具规则补强**:批次 3 挪入的
  `src/backend/databaseSchemaRust.ts` 引 `../databaseSchemaCore`,本批
  databaseSchemaCore 也挪入后该说明符失效——修为兄弟 `./databaseSchemaCore`;
  重基脚本补规则(c):backend 内文件的失效说明符,其目标 basename 属搬移集
  即改写为兄弟引用(跨批次组合面,防再踩)。
- 活文档路径对账 36 处(features en+zh):`src/<name>.ts` → `src/backend/<name>.ts`。
- 依赖面 defParser(同层收敛 `./defParser`)/ definitionWorkspace /
  databaseSchema / serverConfigMerge / pathIdentity / kbengineMetadata /
  sharedFileSnapshot 均留 src/ 根。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0。
- **结构契约测试路径锚修正 2 文件 3 处(全量套件抓获)**:
  databaseSchemaSeam(core 模块路径锚 + databaseSchema 应引
  `./backend/databaseSchemaCore` 的单一事实源断言)、databaseSchemaPureNode
  (传递闭包走查入口路径锚);修后 2 文件 6/6 绿。R2-F24 的 Node 隔离契约
  本身不变——闭包走查对新位置照常逮到 adapter 侧 vscode、core 侧零 vscode。
- 全量 vitest 修正后 exit 0;demo / docs 见提交前记录。
