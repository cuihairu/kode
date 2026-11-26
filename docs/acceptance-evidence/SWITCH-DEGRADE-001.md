# SWITCH-DEGRADE-001 真机验收证据（2026-11-26）

base↔cell 快捷键切换（`kbengine.processOwnership.openBase` / `openCell`）修复提交 `6009d289` 的真机实跑记录。前一轮状态机修复（`b6614028`）⑥审查已通过；本轮 `6009d289` 是⑥复核抓出的 BLOCKER（真实编辑器变化不清旧停泊账，手动回到源文件后再按失效）的修复。

## 环境

- 宿主：本机 Linux（headless Xvfb `:98`，1400x900x24），VS Code 1.147.0（`.vscode-test` 缓存版）
- 扩展：源码开发宿主加载（extensionDevelopmentPath=仓库根，`out/` 构建自 commit `6009d289`）
- 工作区：`/tmp/switch-demo`（scripts/base/Hero.py + scripts/cell/Hero.py 同名对）
- 驱动：`@vscode/test-electron` runTests + 测试扩展脚本，直接 `executeCommand` 触发切换，每步后记录 `activeTextEditor.document.fileName` 落 JSON

## 场景 1：连按 10 次交替（rapid10）

`evidence/SWITCH-DEGRADE-001-rapid10.json` —— 120ms 节奏交替按 B/C 共 10 次：

- 10/10 全部落点正确：B→`scripts/base/Hero.py`，C→`scripts/cell/Hero.py`，无漂移、无失效。

## 场景 2：手动返回后再按（⑥ BLOCKER 回归场景）

`evidence/SWITCH-DEGRADE-001-manual-return.json`：

1. `first B`：cell → base ✓
2. 手动 `openTextDocument` 重新打开 cell 标签（模拟用户自己点回源文件）
3. `second B after manual return`：cell → base ✓

修复前此场景第三步报「未找到同名」不跳转（陈旧停泊账未作废）；`6009d289` 加 `onDidChangeActiveTextEditor` 作废账（落点≠刚切换目标即清空）后跳转恢复。

## 单测

`tests/processOwnershipSwitchLens.test.ts` 新增 3 例（均带 prove-red 扰动点）：

- 手动回源后作废账（删监听器→红）
- 链中编辑器变化时续跳以刚打开文件为源（去 openedPath 透传→红）
- latest-wins B→C→B（改 first-wins→红）
