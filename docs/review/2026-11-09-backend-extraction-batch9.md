# TS 后端独立目录抽取 · 批次 9(playerDataClone 族)2026-11-09

续批次 1-8,同式推进。

## 范围(5 件,`git mv` 至 src/backend/)

playerDataCloneCommands / playerDataCloneImportGuard / playerDataCloneMysql /
playerDataCloneProfiles / playerDataCloneWire

选族依据:零 `from 'vscode'` 的玩家数据克隆逻辑面(命令参数构建/导入守卫/
MySQL 面/档案/wire,共 ~2.1k 行;playerDataCloneCommands 零 vscode=纯命令
构建非注册)。**留 src/**:databaseWiring(装配)、playerDataCloneRust 已在
backend(批次 3,本批后与族内件天然兄弟)。

## 改动面

- import 重基 59 处,UNRESOLVED 恰为既有 13 假阳性零新增;跨批次组合面
  backend/playerDataCloneRust 的 `../playerDataClone*` 经规则 (c) 收敛为兄弟
  引用(playerDataCloneRust→playerDataCloneProfiles 等),`../backend/
  databaseDrift`→`./databaseDrift`。
- 反向面核验:src 留守件 databaseWiring 经规则 (a) 改 `../backend/`。
- 活文档路径对账 10 处:features.md en+zh 各 5。
- 预扫查:零测试静态锚、零 registry 引用。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量门禁见提交前记录。
