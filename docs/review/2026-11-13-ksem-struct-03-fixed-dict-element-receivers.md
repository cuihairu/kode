# KSEM-STRUCT-03 ARRAY 元素类型传播（元素接收者定型）

**日期**：2026-11-13
**条目**：`todo.md` KSEM-STRUCT-03 [P1]「传播 ARRAY 元素类型。验收：下标/迭代变量/可确定容器操作继承元素结构；非法下标类型和动态操作保留合理边界。」

## 1. 验收逐项落点（探测先行,非猜）

STRUCT-02 已落地 `self.bag[0]["x"]` 内联链（数组状态在解析链内随下标原子推进）。本条验收三形态的实测差距:

| 验收形态 | 探测结果（本批前） | 本批 |
|---|---|---|
| ③ 下标继承元素结构 | `self.bag[0]["x"]` 内联链已通（STRUCT-02） | 保持,补测试钉 |
| ① 迭代变量继承 | `for pos in self.bag:` 后 `pos["x"]` → null（三面全哑） | **新面**:for 目标定型取元素注解 |
| ② 下标 RHS 别名 | `d = self.bag[0]` 后 `d["x"]` → null | **新面**:下标链 RHS 定型 |

既有的 TYP-ARRAY 面（`typeInlayHints.ts` collectSelfPropertyElementHints + `selfPropertyTypeInference` resolveSelfPropertyAnnotation）早已覆盖 for 目标/下标局部变量的**元素标量** hover/inlay;本批点亮的是经这些接收者的 **FD 链三面**（键补全/键跳转/键悬停）,不重复 inlay 面。

## 2. 引擎真值（定案边界）

- 数组整数下标 → 元素;**切片 → 同元素数组**（`d = self.bag[0:2]` 后 `d[0]["x"]` 仍成立）;
- 数组上字符串键 = 非法（引擎 `Map::subscript` 不接 str）→ 链死;
- FD 上整数下标 = 非法 → 链死;
- **FixedDict 迭代产出键字符串** → for 目标定型为 str,不认领 FD 键面;
- 动态形态诚实落空:`.values()`、任意调用 RHS、算术 RHS、`enumerate` 元组目标 → 推不出不猜;
- 裸 `[A-Za-z_]\w*` 注解根进数组状态:`FixedArray[POSITION]`/`list[POSITION]` 原文根直接入链。

## 3. 新增纯核（`src/backend/fixedDictSubscript.ts` 扩展,零 vscode 依赖）

| 导出 | 职责 |
|---|---|
| `matchBracket(text, open)` | 引号感知的 `[`→`]` 配对（未闭合 -1） |
| `classifySubscriptContent(content)` | 顶层引号感知 `:`→切片;整体单引号串→键;空→null;否则整数下标 |
| `parseSubscriptChain(expr)` | `base[a][b]` 全纯链解析（base 仅 `self.<prop>` 或裸名;杂质即 null） |
| `takeArrayElementAnnotation(annotation)` | `FixedArray[X]`/`list[X]` → X（嵌套剥一层;非数组/元素 Any → null） |
| `annotateRootText(raw, customTypes)` | 数组原文直通;其余 `resolveAnnotationTypeWithReason` 注解化 |
| `resolveRootExprFromRhs(...)` | RHS 定型:`self.<prop>`→locator（旧契约）;裸名→递归（深度+1）;下标链→逐原子归约（**customTypes 缺省时整臂停用**——4 参旧调用行为不变） |
| `fixedDictChainRootType(..., customTypes?)` | 第 5 参选参闸:缺省=旧行为;有注册表时向上扫描对每行**先查赋值后查 for 目标**,最近绑定胜出 |

绑定扫描口径:回看 `FIXED_DICT_CHAIN_ALIAS_LOOKBACK_LINES = 200` 行、别名深度 ≤2、同接收者先近后远。

**坑（实测抓出）**:for 分支直接对 `resolveRootExprFromRhs` 结果取元素——简单 `self.<prop>` 形态按旧契约返回 def-Type 文本（`POS_BAG`）而非注解（`FixedArray[POSITION]`）,`takeArrayElementAnnotation('POS_BAG')` 必 null。修正=customTypes 在场时先 `annotateRootText` 归一（幂等,已是注解形态则原样过）再取元素。

## 4. 三面接线（每面注册表前移,供定型消费）

| 面 | 接线 | 真位漂移 |
|---|---|---|
| 补全 | `provideFixedDictKeyCompletions`:`customTypes` 前移为第 5 参定型入参,解析复用同快照 | `PythonCompletionProvider.provideCompletionItems` 853→855 |
| 跳转 | fdKeyHit 臂:同上（顺带删除后位重复 snapshot 行） | provideDefinition 260 / tracedImpl 312 不变;层0 闸 827→829;首扫超时闸 933→935 |
| 悬停 | `resolveFixedDictKeyHover`:同上 | provideHover 306 不变（接线在入口之后的 helper 内） |

ANCHORS 与 `docs/perf/2026-baseline.md` 锁步（`tests/perfCallChainDoc.test.ts` 4/4 绿）。

## 5. 诚实边界（全部测试钉死,38/38）

- FD 上整数下标 → 无键;数组上字符串键 → 无键;
- 调用 RHS/算术 RHS/`.values()`/`enumerate` 元组目标/`.name` 后缀杂质/未闭合括号 → 链死不造;
- FD 迭代目标（键字符串）不认领 FD 键面;
- **无注册表（4 参旧调用）新形态一律 null**——向后兼容钉死;
- 解析器注解根:空前缀链首键（`d["x"]` on raw `FixedArray[POSITION]`）→ null（数组根无键层,只有 `[i]` 后才落元素）,`[indexSeg]` 前缀 → 容器=元素注解。

**遗留边界（记录,不冒充）**:FIXED_DICT 字符串键 RHS 别名（`d = self.info["pos"]` 后 `d["x"]`）暂未追踪——FD 根的 RHS 别名定型需键层归约,与数组元素路径不同族,留给后续批。

## 6. 证据

- 纯核+Provider 测试:`tests/fixedDictSubscript.test.ts`（38 例,其中 STRUCT-03 新增 5 例:下标 RHS/迭代目标/非法与动态/无注册表兼容/解析器注解根 + Provider 补全与跳转悬停面）;
- prove-red:`git stash push -- src/` 后 5 新例全红（旧码 5 failed | 33 passed）,恢复后 38/38 绿;
- ANCHORS:`tests/perfCallChainDoc.test.ts` 4/4;baseline ledger STRUCT-03 节同批更新。
