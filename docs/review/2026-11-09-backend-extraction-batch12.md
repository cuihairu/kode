# TS 后端独立目录抽取 · 批次 12(共享工具族)2026-11-09

续批次 1-11,同式推进。

## 范围(9 件,`git mv` 至 src/backend/)

kbengineMetadata / pathIdentity / workspacePath / variableSubstitution /
atomicFileWrite / managedDir / managedDirExclusions / buildCommit /
extensionIdentity

选族依据:零 `from 'vscode'`、零(或仅族内)依赖的共享工具件
(共 ~835 行)。nlsRuntime 留守(vscode.l10n 胶水)。

## 改动面

- import 重基 99 处(本批量大:workspacePath/variableSubstitution 是高频
  引用工具),UNRESOLVED 恰为既有 13 假阳性零新增;跨批次组合面
  backend/hotReloadTransport 的 `../variableSubstitution` 经规则 (c) 收敛为
  兄弟引用(批次 7 预告的 type/value 边落位)。
- 反向面核验:src 留守件 36 个引用点经规则 (a) 改 `../backend/`;tests 25
  文件直引同步。
- 活文档路径对账 10 处:features.md en+zh 各 5;registry/静态锚零引用
  (预检抓获零动态拼路径读)。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0。
- 全量 vitest 8389 过 / 1 失败=hoverDeadlineContext 既有时间预算抖动,隔离
  复跑 10/10 绿;demo 25 RC=0;docs:build RC=0。
- **提交 899f8672**(2026-11-09 推 main):84 文件 122+/92-,并发会话面零牵连。
