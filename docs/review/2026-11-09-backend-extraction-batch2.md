# TS 后端独立目录抽取 · 批次 2(messageTable 族)2026-11-09

续批次 1(docs/review/2026-11-09-backend-extraction-batch1.md),同式推进。

## 范围(6 件,`git mv` 至 src/backend/)

messageTable / messageTableEntity / messageTableEngine / messageTableExport /
messageTablePreview / messageTableRender

选族依据:纯后端(六件均无 `from 'vscode'`);族内闭合(messageTableRender →
messageTable 兄弟引用),外部 importer 仅 extension.ts 一处;依赖的
definitionSemantics / kodeCoreShadowFaces / kbengineMetadata 均留在 src/ 根
(多家共用,kodeCoreShadowFaces 含并发会话在编的 configDerive,不动)。

## 改动面

- import 重基 32 处:extension.ts 4 处 → `./backend/messageTable*`;被挪文件内
  `./definitionSemantics`/`./kodeCoreShadowFaces`/`./kbengineMetadata` → `..` 一层,
  `./backend/defParser`(批次 1 产物)收敛回 `./defParser`;tests 5 文件 9 处 →
  `../src/backend/messageTable*`。
- 活文档路径对账 22 处(features en+zh 16、knowledge.def-flags en+zh 2、
  design.def-pyi-stubs en+zh 4):`src/messageTable*.ts` → `src/backend/messageTable*.ts`。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0。
- 重基脚本 13 条 UNRESOLVED 与批次 1 相同为假阳性(模板串/fixture 字符串,不指向
  搬移集)。
