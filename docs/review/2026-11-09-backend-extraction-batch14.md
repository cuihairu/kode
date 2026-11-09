# TS 后端独立目录抽取 · 批次 14(kode-core/协议族)2026-11-09

续批次 1-13,同式推进。

## 范围(8 件,`git mv` 至 src/backend/)

kbengineProtocol / kodeCoreClient / kodeCoreGate / kodeCoreShadowFaces /
nativeBinary / protocolToolingDetect / fileChangeBypass / sharedFileEvents

选族依据:零 `from 'vscode'` 的 kode-core 客户端/gate/shadow 面、KBEngine
协议常量、文件变更旁路与共享事件协议(共 ~3.1k 行)。**留 src/**:
protocolSchemaSync / hotReload 编排器 / entityMapping(经 `../backend/` 回引
sharedFileEvents)、fileChangeMeta / fileChangeMetaLog(fileChange 族后续批次)。

## 改动面

- import 重基 201 处(本批量大:kbengineProtocol/sharedFileEvents 高频被引),
  UNRESOLVED 恰为既有 13 假阳性零新增。
- 静态路径锚 3 文件 4 处(全量前预扫查+锚文件隔离跑抓获第 5 处):
  fileChangeBypass.test(readRepo ×2,含 kodeCoreGate 互证锁)、
  rstServingStatusDoc(read ×2:gate/faces)、watcherBoundaryDocs(join
  kbengineProtocol.ts)→ 均显式 `src/backend` 段;修后 3 文件 27/27 绿。
- 活文档路径对账 10 处:features.md en+zh 各 5。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0。
- 全量 vitest 一次过零抖动 693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;
  docs:build RC=0。
- **提交 2063b0e7**(2026-11-09 推 main):147 文件 230+/200-,并发会话面零
  牵连(注:提交后违禁项扫描报 1 系检查正则 `configDerive` 前缀误命中
  tests/configDeriveScanRoot.test.ts——该文件不在保护清单,提交内容核验为
  纯批次 14 重基 2 处 import,无违规)。
