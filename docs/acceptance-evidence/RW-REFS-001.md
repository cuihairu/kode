# RW-REFS-001 真机验收证据（2026-11-26）

命令 `kbengine.findReferencesRW`（READ/WRITE/DELETE 分组引用）真机实跑记录。

## 环境

- 宿主：本机 Linux（headless Xvfb `:99`，1600x1000），VS Code 1.147.0（`.vscode-test` 缓存版）
- 扩展：源码开发宿主加载（extensionDevelopmentPath=仓库根，`out/` 构建自 commit 38658961）
- 工作区：`tests/fixtures/kbengine-demo-assets` 全量拷贝到 `/tmp/rwrefs-demo`，另加两个验收脚本：
  - `scripts/cell/AcceptanceRW.py`：`KBEngine.globalData["RW_HP_MAX"] = 100`（下标写）与 `+= 5`（增强写）与 `= KBEngine.globalData["RW_HP_MAX"]`（读）
  - `scripts/base/AcceptanceRWBase.py`：`del KBEngine.globalData["RW_HP_MAX"]`（删）与一处读
- 驱动：`@vscode/test-electron` runTests + 测试扩展脚本（打开 cell 文件、光标落在第 10 行键 `RW_HP_MAX` 上、`executeCommand('kbengine.findReferencesRW')`），QuickPick 弹出后外层 shell 以 `import -window root` 截屏。

## 截图

| 文件 | 内容 |
| --- | --- |
| `evidence/RW-REFS-001-quickpick.png` | QuickPick 弹出：占位 `RW_HP_MAX — 7 references (write 2 / read 4 / delete 1)`；组序 WRITE (2) → READ (4) → DELETE (1)；两处写点（下标赋值 `= 100`、增强赋值 `+= 5`）行首带 `⇄` 且同时出现在 WRITE 与 READ 两组；每行 `file:line` + detail 代码行摘录 |
| `evidence/RW-REFS-001-jump.png` | 回车选中 WRITE 第一行后：跳到 `scripts/cell/AcceptanceRW.py` 第 4 行（`KBEngine.globalData["RW_HP_MAX"] = 100`），光标落在键上（`preview: false` + selection 跳行） |

## 断言口径

- 三组齐全：WRITE 2 / READ 4 / DELETE 1（⇄ 行在两组各计一次，总数 7 = 2+4+1）
- ⇄ 双列：`= 100`（下标赋值）与 `+= 5`（增强赋值）均带 `⇄` 且双组出现
- 大小写敏感：键原文比较（无归一化，源码钉 + 单测钉）
- 跳转：选中行 `showTextDocument` 带 selection 落到引用行

## 边界（如实记录）

- cellData 键族面需 Rust 核心（`fetchCellDataKeys` 走 kode-server gate）；本次真机工作区未起 kode-server，cellData 臂未在截图内验证。其分类核心（含 cellData 引号内 `keyStart` 的 ⇄ 判定）由 `tests/rwReferences.test.ts` 用真实扫描器输出钉死（第 2 例）。
- 通用符号面（`executeReferenceProvider` + `executeDocumentHighlightProvider` 对齐）依赖已装的 Python 语言服务；本次以 `--disable-extensions` 隔离跑，通用面截图未含。其分类/对齐由单测第 3/8/8b 例覆盖。
