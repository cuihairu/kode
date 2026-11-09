# TS 后端独立目录抽取 · 批次 10(serverConfig 解析族)2026-11-09

续批次 1-9,同式推进。

## 范围(3 件,`git mv` 至 src/backend/)

serverConfigAnnotations / serverConfigCatalog / serverConfigCommentText

选族依据:零 `from 'vscode'`、零外部依赖的服务器配置解析三件(注释文/目录/
注解,共 ~674 行)。**留 src/**:serverConfigMerge(vscode 混合,经 `../`
回引三件)、serverConfigResolve(并发会话在编,不动)、serverCommandTarget
等装配面。

## 改动面

- import 重基 19 处,UNRESOLVED 恰为既有 13 假阳性零新增;serverConfigMerge
  的族内引用经规则 (a) 改 `../backend/`。
- 反向面核验:backend 既有 96 件零 serverConfig 解析族引用。
- 活文档/features/registry/测试静态锚:零引用面,无需对账。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动
  693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
