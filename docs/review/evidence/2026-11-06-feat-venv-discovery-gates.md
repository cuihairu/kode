# feat/venv-discovery 门禁证据（2026-11-06，PY-ENV 二期收尾）

- 分支：`feat/venv-discovery`（基 `8f41e74`）
- 门禁执行 HEAD：`03421508cf9549006af439b04c5da050473e74b4`（`0342150`）
  - 该 HEAD 之后仅 `todo.md` 台账一笔提交（`fd6e77b`）——无测试/脚本读取 todo.md（`grep -rn "todo.md" tests/ scripts/ src/` 只命中注释引用），故下列数字对 `fd6e77b` 同样成立；本证据文件随后入库。
- 工作区：`~/workspaces/kode-venv`（pnpm，node_modules 在位）

## 1. tsc

```
pnpm exec tsc -p ./ --noEmit
TSC_RC=0
```

首轮曾红 1 条（收尾补齐项）：`src/extension.ts(6381,9): TS2739 — withProgress 返回的 Thenable 缺 catch/finally`，
因 `CreateVenvDeps.runVenvModule` 签名是 `Promise<…>`；`runVenvModule` 改 `async/await` 归一后 0。

## 2. lint（仓内门禁口径 `pnpm run lint` = `eslint src --ext ts`）

```
pnpm run lint           # $ eslint src --ext ts
LINT_RC=0

pnpm exec eslint tests/venvDiscovery.test.ts tests/venvInterpreterPicker.test.ts \
  tests/profileInterpreter.test.ts tests/extension.test.ts tests/perfCallChainDoc.test.ts --ext ts
TESTS_ESLINT_RC=0
```

说明：`pnpm exec eslint src tests` 共 92 处报错，全部来自 `tests/` 下既有用例，且 `tests/` 不在门禁范围
（`lint` 脚本只扫 `src`）；本批触碰的 5 个 tests 文件单独跑均为 0。

## 3. fmt

仓内无格式化器：`package.json` 未把 prettier/其他 formatter 列入 devDependencies，`node_modules/.bin`
无 `prettier`，亦无 `.prettierrc`/`fmt` 脚本，CI 工作流无 format 步骤。样式面由 eslint + tsc 承担；
另对本批改动文件做了样式卫生检查：`grep -nP "[ \t]+$"`（行尾空白）与连续空行检查均 0 命中
（收尾时清理了 extension.ts 装配块尾的多余空行）。

## 4. vitest（预算型隔离 3 轮）

### A 档：默认环境（`pnpm exec vitest run`）

```
Test Files  1 failed | 543 passed (544)
     Tests  3 failed | 6684 passed | 3 skipped (6690)
A_RC=1
Duration 60.48s
```

红文件唯一：`tests/covExtensionCommands.test.ts`（3 例，测试面板 Run 档）。

### B 档：PATH 前置 `/usr/bin`（其 python3.14 自带 pytest 9.1.1）

```
PATH=/usr/bin:/bin:/usr/local/bin:$PATH pnpm exec vitest run
Test Files  544 passed (544)
     Tests  6688 passed | 2 skipped (6690)
B_RC=0
Duration 58.54s
```

→ 代码面全绿。

### 隔离轮次（预算 ≤3 轮，逐轮结论）

| 轮 | 环境 | 命令 | 结果 |
| --- | --- | --- | --- |
| ① | 脏树，隔离单文件，默认环境 | `pnpm exec vitest run tests/covExtensionCommands.test.ts` | `3 failed | 77 passed (80)`，与全量同 3 例 |
| ② | 干净 HEAD `8f41e74`（独立 worktree + 同一 node_modules）同单文件 | 同上 | `3 failed | 77 passed (80)`，**同 3 例**——非本分支引入 |
| ③ | 脏树，PATH 前置 `/usr/bin`（pytest 9.1.1）同单文件 | `PATH=/usr/bin:… vitest run tests/covExtensionCommands.test.ts` | `80 passed (80)` RC=0 |

根因（已坐实，非 flake）：本机 `PATH` 首位 `python3` 是无 pytest 的 Hermes venv
（`python3 -m pytest` → `No module named pytest`），扩展测试面板以该解释器跑 `python -m pytest`，
`pythonTestRunner` 按设计如实报 errored 而不冒充结果，故 3 例断言拿不到 passed/skipped 节点。
换用装有 pytest 的解释器即全绿（轮③ + B 档）。`/home/cui/.local/bin/pytest`（9.1.1）指向另一套
python，不进 `PATH` 首位，故默认环境不受益。

补充：本轮全量下 `hoverDeadlineContext`（负载时序 flake，上一手记录过）未再失败；A/B 两档 skip
数 3/2 的差即「pytest 缺失时跳过的用例」，属同一根因。

## 5. 本批补齐项（红先行 → 绿）

1. **tsc**：`runVenvModule` 的 Thenable/Promise 签名不符（见 §1）。
2. **状态栏环境名 3 例红**：原「`bin|Scripts` 上一级即环境名」把 `/usr/bin/python3` 显示成 `usr`、
   `/opt/py/bin/python` 显示成 `py`；改为「确知是环境才显示环境目录名」——来源 `venv`（工作区扫描
   已验真）或目录名命中 venv 命名名单（`.venv`/`venv`/`.kbenv`），否则退回二进制名。
3. **createVenvFlow 用例夹具自相矛盾**：`verifyTarget` 硬编码 `/ws/.venv`，使「工作区外目标照样
   验真选用」用例永远走不到；夹具改为按落盘目标 + `state.verified` 判定（验不过仍返回 null，
   「验不过绝不选用」用例语义不变）。
4. **docs 失实**：中英 `features.md`、中英 `guide/commands.md` 与 `venvInterpreterPicker.ts` 模块头
   写「完成后重扫描并自动选中」，实现是对目标直接 `verifyVenvDirectory`（不依赖扫描范围）——四处
   措辞改到与代码一致。
5. **中英镜像补齐**：`docs/zh/guide/configuration.md` Python 集成补「解释器解析链」「状态栏与一键
   创建」两段并同步两行设置口径；`docs/zh/guide/commands.md` 补 `selectInterpreter`/`createVenv`
   两小节；extension.ts 装配块尾多余空行清理（fmt 面）。

## 6. 提交清单（逐逻辑，英文）

| hash | subject |
| --- | --- |
| `7c360b3` | feat(venv): add workspace virtual-environment discovery scanner |
| `1a95f5e` | feat(venv): interpreter status bar, QuickPick selection and one-shot creation |
| `0342150` | feat(interpreter): resolve chain prefers verified deep workspace scan |
| `fd6e77b` | docs(todo): reconcile PY-ENV phase 2 ledger with the verified state |
| 本文件 | docs(review): record feat/venv-discovery gate evidence at 0342150 |

推送：`git push origin feat/venv-discovery`（不 force、不开 PR）；推送后的 `origin/feat/venv-discovery`
ref 以 push 后 `git ls-remote` 结果为准（本文件入库时该 ref 尚未包含它自身）。
