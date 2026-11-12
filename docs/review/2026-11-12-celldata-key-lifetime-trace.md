# KSEM-CELL-09 跟踪脚本附加键（cellData 键全集 + 作用域限存在性判定）

**日期**：2026-11-12
**条目**：`todo.md` KSEM-CELL-09 [P1]「跟踪脚本附加键。验收：区分声明键、内建键、局部已写键和未知键；有显式新增键的合法代码不得误报。」
**前置**：CELL-04 键宇宙（声明键 ∪ 内建 ∪ 脚本已写键，`kbengine.cellDataKeys`）、CELL-06/07 键操作走查（`cellDataKeyOperations`）与伪写点面（`cellDataKeyPseudoOps`）。

## 0. 为什么必须「作用域限」地算存在性

`cellDataKeyPresent` 若按「全文任一处写过这个键就算存在」判定，就会把两类**合法**代码判成缺失：

- **局部作用域写**：`set_attribute` 里 `self.cellData.temp = 1` 之后同作用域 `x = self.cellData.temp`——键只在函数内存在，模块级读它不该因为「函数里写过」就通过；
- **伪写点**：`del self.cellData["a"]` 是删除证据、`self.cellData["a"] = ...` 在无效别名下不算证据——同族问题，本条复用 CELL-07 的「无效别名操作不入列」。

反过来，若按「只在模块顶层写才算」，又会把**闭包内合法新增**的键（回调里 `self.cellData.score = 3` 后同作用域读）误报为缺失。所以正确口径是**最近证据**：自读点向上找**最近**的有效写/删，作用域外沿到最近的 def/class 边界即停。

## 1. 实现：单向上作用域限走查

纯函数，无 vscode / 无引擎依赖（`src/backend/cellDataKeyTracking.ts`）：

```
cellDataKeyPresent(ops, target, text): KeyLifetimeEvidence | null
  = cellDataKeyTracking.findNearestKeyMutation([...validOps, ...pseudo], target, text)
```

- **合并顺序**：有效键操作（CELL-06/07 已剔除无效别名下的写/删）在前，伪写点（`del`/解包删/`clear`）在后——两者在同一次走查里按行序统一比较，`del` 与真实 `del` 同形入列（删除即否定证据）。
- **向上**：从 `target` 行向更早找（更晚的写是「还没发生」，对当前读不构成证据）。
- **作用域限**：越过 `def` / `async def` / `class` 边界即停，返回 `null`（作用域外的写对本作用域读不是证据，不硬造）。
- **别名跳过**：与 CELL-07 `findNearestKeyMutation` 同口径——重绑定后操作的是别的字典，跳过不算证据，继续向更早找。
- 复用 CELL-06 的 `buildPythonCodeMask` / 注释剥离，不在作用域里重复造解析。

## 2. 四键面区分（验收第一句）

| 键面 | 来源 | 本条作用 |
|---|---|---|
| 声明键 | `*.def` 的 properties | 引擎保证存在，存在性判定前已由 `kbengine.cellDataKeys` 宇宙给出 |
| 内建键 | 引擎内建（`__cellData` 等） | 同上，入宇宙 |
| 局部已写键 | 脚本 `self.cellData[k] = ...` | **本条**：仅在其作用域内的读点上算存在 |
| 未知键 | 既非声明也非内建也无处写过 | 保持「未赋值」，不猜 |

**验收第二句（不得误报）**：显式新增键 → `write` 证据，判定存在，不报缺失。新增后同作用域 `get` 不再按必然 KeyError 报（CELL-10 的 get 收口以此为本条的地基）。

## 3. 测试（`tests/cellDataKeyTracking.test.ts`，34 例）

- **存在**：模块级写后读 → `write`；声明键/内建键读 → 经宇宙判定不算缺失；
- **删除**：写后 `del` 再读 → 最近证据是删除，判为否定；`clear()` 伪操作同形；
- **作用域限**：函数内写后**同函数**读 → `write`；同函数外（模块级）读 → `null`（不误报也不漏报）；嵌套 def 边界各自成立；
- **别名**：无效别名下的写不作证据，继续向更早找；重绑定后读不认领被重绑的字典；
- **不硬造**：读点之**后**的写不构成证据（返回 `null`，而不是把「稍后会有」当存在）；
- 伪写点与有效操作**同一次走查**：`del` 与真实删除同形入列的合并路径有专例。

## 4. 门禁

| 门禁 | 结果 |
|---|---|
| `tsc --noEmit` | 0 |
| `npm run lint`（`eslint src --ext ts`） | 0 |
| `npm run test:unit` | 738 文件过 / 1 skip；8952 例过 / 8 skip；RC=0 |
| `xvfb-run -a npm run test:demo:editor` | 25 passing；RC=0 |

prove-red：把 `findNearestKeyMutation` 的作用域边界闸去掉（改成跨 def 继续找）→ 作用域限专例红；恢复后 34/34 绿。

## 5. 未在本条做的面

- **读点作用域归属**：本条只判「读点向上是否有证据」，读点自身在哪个作用域由调用方给的行号决定；
- **CELL-10 错键提示**：本条只产存在性证据，「提示缺失/拼写候选」「开放字典只给低置信建议」「get 不按必然 KeyError 报」属下一条；
- **CELL-11 生命周期**：本条把 `create_cellentity` 的异步确认语义当作「不能据一次异步创建断定已有 Cell」的地基，但状态表核实属下一条。