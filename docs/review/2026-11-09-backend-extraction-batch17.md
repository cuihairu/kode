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

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量门禁见提交前记录。
