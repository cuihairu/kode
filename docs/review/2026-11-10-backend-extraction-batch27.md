# TS 后端独立目录抽取 · 批次 27(诊断支撑七件)2026-11-10

续批次 1-26,同式推进。

## 范围(7 件,`git mv` 至 src/backend/)

botsControl(276)/ redisKeySpace(119)/ hostVitals(189)/
cpuProfileCapture(137)/ debugAttachGuard(130)/ taskContext(132)/
finalMarksVerdict(123,零 src importer 仅测试消费)

选族依据:零 `from 'vscode'` 的 bots 控制/redis 键空间/宿主体征/CPU
采样/调试附着闸/任务上下文/终验裁决面(共 ~1.1k 行)。**留 src/**:
activate/serverControls/loggingWiring/redisKeyspaceCommand/
databaseManagementWebView/debugConfig/extension(经 `../backend/` 回引)、
nlsRuntime/languageServiceMetrics/projectProfiles;backend 组合面
botsControl→telnetClient、cpuProfileCapture→hostVitals 兄弟化。
src/test/electron/suite/finalMarks.test.ts(mocha 真机层)同笔重基。

## 改动面

- import 重基 24 处,UNRESOLVED 恰为既有 13 假阳性零新增。
- 零静态文件读锚(cpuProfileCapture.test 读采样产物 tmp 文件)、
  零 ANCHORS 面(perfCallChainDoc :140 仅行文提及 botsControl 导入块,
  行数不变);活文档路径对账 8 处:features.md en+zh 各 4。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动
  693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- 暂存精确清单 27 文件(含 features en+zh),违禁项检查 0。
- **提交 4d5733fb**(2026-11-10 推 main)。
