# TS 后端独立目录抽取 · 批次 28(构建/观测八件)2026-11-10

续批次 1-27,同式推进。

## 范围(8 件,`git mv` 至 src/backend/)

observationIdentity(93)/ observationConnectionState(88)/
buildProblemMatcher(85)/ buildTaskSpec(83)/ generatedSourceMap(77)/
projectTemplate(105)/ launchDependencies(124)/ liveValidationInputs(134,
零 src importer 仅测试消费)

选族依据:零 `from 'vscode'` 的观测身份/连接态/构建问题匹配器/任务
规格/产物源映射/项目模板/launch 依赖/活校验输入面(共 ~790 行)。
**留 src/**:runtimeQueryWebView/buildTaskProvider/extension/
generatedSourceLenses/serverManager/demoGameTemplate/projectCreate/
entityTypeStubs/pythonTypeStubs/generationConfirm(经 `../backend/`
回引);src/test/electron/suite/liveObservation.test.ts(mocha 真机层)
同笔重基。

## 改动面

- import 重基 34 处,UNRESOLVED 恰为既有 13 假阳性零新增;族内
  observationConnectionState→observationIdentity 兄弟解析。
- 零静态文件读锚、零 ANCHORS 面、零 registry 引用;活文档路径对账
  10 处:features.md en+zh 各 5。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动
  693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- 暂存精确清单 31 文件(含 features en+zh),违禁项检查 0。
- **提交 1c09e70c**(2026-11-10 推 main)。
