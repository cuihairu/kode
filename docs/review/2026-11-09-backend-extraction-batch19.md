# TS 后端独立目录抽取 · 批次 19(venv 探测对)2026-11-09

续批次 1-18,同式推进。

## 范围(2 件,`git mv` 至 src/backend/)

venvDiscovery / venvInterpreterPicker

选族依据:零 `from 'vscode'` 的 venv 扫描/校验与解释器选择流程
(共 ~500 行)。**留 src/**:profileInterpreter / quickActionConfig /
nlsRuntime(经 `../backend/` 回引)、命令与装配面
(activate/utilityCommands 经 `../backend/` 回引)。

## 改动面

- import 重基 10 处,UNRESOLVED 恰为既有 13 假阳性零新增;族内
  venvInterpreterPicker→venvDiscovery 兄弟解析,出向留守件
  (profileInterpreter)与命令面(utilityCommands 2 处)、测试
  (venvDiscovery/venvInterpreterPicker/quickPickNls)改 `backend/` 段。
- 零静态锚、零动态拼路径读(预检;grep 余留仅测试名字符串与冻结
  纪实文档);活文档路径对账 6 处:features.md en+zh 各 3。

## 验收

- `pnpm compile`(tsc)0 / `pnpm lint` 0;全量 vitest 一次过零抖动
  693 文件 / 8390 过 4 skip RC=0;demo 25 RC=0;docs:build RC=0。
- 暂存按精确文件清单逐个 add,违禁项检查 0(批次 17 事故后严格化;
  utilityCommands/profileInterpreter diff 逐行核验仅含本批重基行,
  未牵连并发会话面)。
- **提交 dda3a758**(2026-11-09 推 main)。
