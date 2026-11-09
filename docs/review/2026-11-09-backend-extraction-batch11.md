# TS 后端独立目录抽取 · 批次 11(engine 元数据族)2026-11-09

续批次 1-10,同式推进。

## 范围(3 件,`git mv` 至 src/backend/)

engineVersionDetect / engineApiMetadata / engineCompatibility

选族依据:零 `from 'vscode'` 的引擎版本探测/API 符元/兼容性判定
(共 ~380 行)。**留 src/**:engineVersion(vscode 混合)、kbeModuleIndex
(并发会话在编,engineApiMetadata 经 `../` 回引)。

## 改动面

- import 重基 29 处,UNRESOLVED 恰为既有 13 假阳性零新增;族内
  engineCompatibility→engineApiMetadata 兄弟解析,出向留守件
  (engineVersion / kbeModuleIndex)改 `../`。
- 反向面核验:tests 零 `../src/` 直引(0 文件),backend 零反向引用。
- 活文档路径对账 8 处:features.md en+zh 各 4;registry/测试锚零引用。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0。
- 全量 vitest 8389 过 / 1 失败=debugConfigAttach 既有真 ps 抖动,隔离复跑
  23/23 绿;demo 25 RC=0;docs:build RC=0。
- **提交 0cfb5142**(2026-11-09 推 main):19 文件 46+/20-,并发会话面零牵连。
