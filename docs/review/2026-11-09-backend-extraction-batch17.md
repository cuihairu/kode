# TS 后端独立目录抽取 · 批次 17(fileChange 元数据对)2026-11-09

续批次 1-16,同式推进。fileChange 族收尾(族首两件 fileChangeBypass /
sharedFileEvents 已批次 14 入 backend)。

## 范围(2 件,`git mv` 至 src/backend/)

fileChangeMeta / fileChangeMetaLog

选族依据:零 `from 'vscode'` 的文件变更元数据/日志格式化(共 ~462 行)。
**留 src/**:hotReload 编排器(经 `../backend/` 回引)、navigationLog
(fileChangeMetaLog 出向)。

## 改动面

- import 重基 26 处,UNRESOLVED 恰为既有 13 假阳性零新增;族内
  fileChangeMetaLog→fileChangeMeta 兄弟解析。
- **环境事项**:会话重启后 /tmp 清空,重基脚本与假阳性基线文件丢失——
  脚本按既有规则重建(动态 MOVED 集,规则 a/b/c 与 vi.mock 面全同),
  首跑 UNRESOLVED 输出与批次 7 基线逐行一致(13 项同文件同行),重建有效性
  即证。
- 零静态锚、零动态拼路径读、零 features 引用(预检)。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动 693 文件 /
  8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- **提交 fb0a810f** + **事故与修复 79df6e0c**:暂存清单的 `^wt/` 排除式锚定
  到行首(porcelain 行首是状态码)永不匹配,6 个 wt/ 嵌入仓库 gitlink 混入
  fb0a810f 并推出;`git rm -r --cached wt/` 以 79df6e0c 修复推出,树净
  (git ls-files 零 wt/)。根因两层:①排除式锚定错误(此前批次均未锚定);
  ②流程破坏——提交前违禁项检查报 6 非零仍继续提交。铁律入账:**违禁项
  计数非 0 必须停下核查,绝不带病提交**。wt/ 工作目录本身未动,仅索引记录
  移除。
