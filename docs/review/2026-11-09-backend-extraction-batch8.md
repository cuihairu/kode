# TS 后端独立目录抽取 · 批次 8(git 查询族)2026-11-09

续批次 1-7,同式推进。

## 范围(7 件,`git mv` 至 src/backend/)

gitCommitLog / gitHistory / gitQueryGate / gitRangeTimeline / gitRepoLocate /
gitRunner / gitSelectionMap

选族依据:零 `from 'vscode'` 的 git 查询/时间线纯逻辑(共 ~1.7k 行)。
**留 src/ 的 git 面**:gitHistoryDiff / gitHistoryTree(vscode 混合)、
gitRangeHistoryTree / gitHistoryTree 树 UI、gitStatus 相关装配件。

## 改动面

- import 重基 61 处,UNRESOLVED 恰为既有 13 假阳性零新增;族内互引
  (gitQueryGate→gitRunner 等)落位后天然兄弟解析,出向 src 留守件
  (gitHistoryDiff / gitHistoryTree / nlsRuntime / workspacePath)经规则 (a)
  改 `../`。
- 反向面核验:backend 既有 84 件零 git 族引用。
- 活文档路径对账 22 处:features.md en+zh 各 11;余 `src/git*.ts` 为留守
  混合/树件引用,如实保留。
- **动态拼路径锚 1 处(本次预扫查抓获,未进全量)**:gitRunner 源锁测试
  `join(__dirname,'..','src','gitRunner.ts')` → 显式 `src/backend` 段;
  同型扫查全 tests 无其余搬移件动态读(gitHistoryTree/gitHistory/providerNls
  残留皆测试标题与字符串字面量,非路径)。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0。
- 全量 vitest 8389 过 / 1 失败=processTopologyPerf Rust RPC 5s 超时——**满载
  环境因素非本批回归**(并发会话 rustc 构建把 load 打到 93/14 核,spawn+握手
  墙钟破 5s,与 KODE-PERF-005 记录的 load~186 满载同型);load 回落后隔离
  复跑 5/5 绿。demo 25 RC=0(满载下 35s);docs:build RC=0。
- **提交 a00cbdd4**(2026-11-09 推 main):31 文件 103+/70-,并发会话面零牵连。
