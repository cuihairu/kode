# KSEM-STRUCT-02 FIXED_DICT 子字段传播（键位类型/补全/跳转三面）

**日期**：2026-11-13
**条目**：`todo.md` KSEM-STRUCT-02 [P1]「传播 FIXED_DICT 子字段。验收：支持嵌套字符串下标和引擎实际支持的属性访问；每层 key 提供类型、补全与跳转。」
**范围**：TS 交互三面（补全/跳转/悬停类型）落在高保真面 `CustomTypeInfo`；Rust 侧类型图 `fields` 补齐（STRUCT-01 §4 第 1-3 步）与本条的消费面是同一件事的两侧，本批先落地 IDE 交互面，Rust 侧留给 STRUCT-04/05 的诊断消费面接线时一并兑现（见 §5 分侧处置）。

## 1. 引擎实际支持的属性访问（真源核，定案）

`FixedDict : script::Map`（`fixeddict.h`）暴露的是 **`mp_subscript` / `mp_ass_subscript` + dict 方法**（`keys/values/items/get/update`），**没有 `tp_getattro` 字段直通**——`fixed.<field>` 属性式访问不是引擎面。

因此本条的「引擎实际支持的属性访问」落地为：

| 访问形态 | 引擎 | 本批 |
|---|---|---|
| `fd["key"]` 字符串下标 | `mp_subscript` ✓ | 类型/补全/跳转三面 |
| `fd.get("key")` | dict `get` ✓ | 同面（接收者定型口径） |
| `fd.keys()/values()/items()` | dict 方法 ✓ | 既有面（`resolveFixedDictMember` 字典方法面），不在本批 |
| `fd.<field>` 属性式 | ✗ 无字段直通 | **不接管**（既有 `resolveFixedDictMember` 保持其自身口径，本批不改） |
| `fd[0]` 整数下标 | `Map::subscript` 不接 int ✗ | 诚实落空，不造类型 |
| `arr["k"]` 数组字段字符串键 | 数组无字典下标 ✗ | 链即死，不造 |

## 2. 保真面选型（STRUCT-01 §2 的结论落地）

键名的唯一来源是 types.xml 的 `<Properties>` 子元素标签名（STRUCT-01 §1）。STRUCT-01 盘点的五层里只有 **TS `CustomTypeInfo`（`getTypesXmlCustomTypeInfos`）保字段名 + 内联 `ARRAY<of>` 形状 + 声明序**；Rust 全链（parser `field_refs` → 图 → `SemType`）丢名/伪造名。故本批三面的数据源统一为：

```
EntityMappingManager.resolvePropertyDefinitionInfo  → 根 <Type>（def 属性声明的自定义类型名）
getEntityCustomTypesSnapshot(workspaceRoot)        → CustomTypeInfo[]（字段名/序/内联形状）
pythonTypeStubs.resolveAnnotationTypeWithReason    → 注解文本（builtin 表→自定义注册表→别名链→Any 兜底）
pythonTypeStubs.resolveCustomTypePropertyAnnotation → 字段的 Python 注解（内联数组→FixedArray[X]）
```

新增 `definitionWorkspace.getEntityCustomTypesSnapshot`（与 `resolveEntityFixedDictMember` 同源口径：语义索引快照 + 开档版本陈旧则重建 + `storeTypeRegistrySnapshot`），**不新造第二套解析器**。

## 3. 新增纯核（`src/backend/fixedDictSubscript.ts`，零 vscode 依赖）

| 导出 | 职责 |
|---|---|
| `fixedDictSubscriptContextAt(line, character)` | 行内探测：接收者候选（`self.<prop>` 整形 / 裸标识符；点号中段跳过）→ `parseChainAtomAt` 逐原子前推 → 游标分类 |
| `FixedDictSubscriptChainContext` | `{receiver, receiverStart, segments, cursor, replaceStart}` |
| `resolveFixedDictSubscriptKey(rootTypeName, prefixSegments, key, customTypes)` | 逐层走 `{fd, info}` / `{array, element}` 状态；键未命中=链死，`{container, field:null}`=命中容器但键未知 |
| `fixedDictChainRootType(receiver, lines, lineIndex, resolveSelfPropertyType)` | 接收者定型：`self.<prop>`→locator；裸别名→向上 200 行最近赋值 |

诚实边界（全部实测钉死）：

- **`cursor:'open-key'` 只在空片段成立**：`[` 后已输入表达式（如 `self.pos[x]`）不认领键位——补全只在真开键串位出现；
- **行尾缺右括号的 `self.pos["x"`** 视为闭合原子（链在行尾结束）——用户键入引号尚未闭合前不谎报闭合，闭合后按链尾处理；
- **行注释内位置一律不认领**（`positionInsideLineComment` + 引号跟踪）；
- **深度有界** `FIXED_DICT_CHAIN_MAX_SEGMENTS = 8`——类型图存在环时（`LOOP_A→LOOP_B→LOOP_A`）链必停，实测环上 7 段落到 `LOOP_B` 而非无限；
- **注解 Any（`<Type>` 缺失）→ `annotation: null`**，hover 不显示 `**key:**`，不冒充实类型；
- **接收者定型只认简单赋值 RHS**（`self.<prop>` / 裸名）；链式或调用 RHS 一律不定型——推不出不猜。

## 4. 三面接线（复用既有解析链，不另造推导）

| 面 | 插入位 | 落点 |
|---|---|---|
| **补全** | `provideCompletionItems` 键位派发块，cellCtx 臂之后、Rust-first 闸之前 | 该层容器 `properties` 逐字段 → `CompletionItem(name, Field)`，`detail = <注解> · types.xml:<行>`（Any 省略注解段），`range` 覆盖开引号到光标 |
| **跳转** | `provideDefinitionTracedImpl` 的 cellData-key 臂之后、AUD-072 闸之前 | `types.xml` 字段声明行（0 基 `line-1`），`layers` 记 `fixeddict-key` 层 |
| **悬停类型** | `provideHover` 的 dataDict 判定之后 | `formatFixedDictKeyHover`：`**key: <注解>**` + `FIXED_DICT <容器> 字段声明: types.xml:<行>`；未知键/Any → null（落回常规 hover 链） |

游标位在**字符串字面量内部**，故三臂都必须在跳过字符串的守卫之前（补全在 Rust-first 闸前、悬停在 `provideKnownHover` 兜底前、跳转在 AUD-072 守卫前）。

**开关口径（如实记录，非对称）**：悬停臂在 `kbengine.entity.builtinProperties` 总闸内（与 TYP-ARRAY 自属性注解悬停同款，hover.ts:590）；补全与跳转两面**不设该闸**——与姊妹的 cellData 键位补全/跳转面同口径（`KBEngineCompletionProvider.provideCompletionItems` 的 cellCtx 臂、`provideDefinitionTracedImpl` 的 cellData-key 臂都不查该闸）。默认值为 `true`（`src/languageProviders/shared.ts:53`），故默认路径三面一致；关闭该开关时只有悬停面让位。features.md en/zh 两处对账已按此口径落笔，不笼统写成「三面都受开关控制」。

## 5. 分侧处置（STRUCT-01 §4 的 Rust 步不并入本批）

STRUCT-01 §4 第 1-3 步（`kode-parser` 增 `fields`、`TypeGraph` 并行 `fields`、`SemType` 改真名）是**诊断消费面**的底座——STRUCT-04（缺键/多键/错型）与 STRUCT-05（标量范围）都要它。IDE 交互三面的数据源在 TS `CustomTypeInfo` 已完备，无需等 Rust。故：

- 本批：TS 三面 + 纯核 + 契约测试（`tests/fixedDictSubscript.test.ts`，30 例）；
- STRUCT-04/05 批：Rust `fields` 补齐 + `semantics::query` 新变体，届时 parity golden 增 `fields` 键（STRUCT-01 §4 第 1、4 步）。

## 6. 测试与 prove-red

`tests/fixedDictSubscript.test.ts` 30 例：探测 9（含 `.get`/别名/注释位/表达式误认领/环深度）+ 解析 9（嵌套/内联数组元素 FD/数组下标/未知键/环/Any）+ 接收者定型 3 + **Provider 三面接线 9**（真实 `EntityMappingManager` + 真实 types.xml 磁盘解析）。

夹具坑（记档）：fake vscode 桩的 `findFiles` 默认恒返 `[]`（`tests/fake-vscode/workspaceState.ts:138`），而 `EntityMappingManager` 的定向 `.def` 首解析靠 `findFilesAcrossRoots` 发现 `Avatar.def`——不补桩则 `resolvePropertyDefinitionInfo` 恒 null，三面全静默失效（症状=补全 `[]`/跳转 undefined/hover null）。桩口径照 `tests/entityMappingManager.test.ts:172` 的盘遍历。

prove-red：`git stash push -- src/` 后 5 例接线测试红（25 过 / 5 败），恢复后 30 全绿。

## 7. ANCHORS 锁步

`tests/perfCallChainDoc.test.ts` + `docs/perf/2026-baseline.md` §7 真位重探：hover.ts `provideHover` 299→306；pythonDefinition.ts `provideDefinition` 出处 254→260（HEAD 真位 256，欠账 2 行一并校准）/`provideDefinitionTracedImpl` 308→312/层0 接收者段闸 765→827/首扫超时闸 871→933；completion.ts `PythonCompletionProvider.provideCompletionItems` 766→853。

## 8. 验收对账

- 嵌套字符串下标 ✓：`self.info["pos"]["x"]` 逐层类型/补全/跳转（`POSITION.x: float`）；
- 引擎实际支持的访问 ✓：字符串下标 + `.get("key")` 两面同口径；属性式/整数下标/数组字符串键如实不接管；
- 每层 key 的类型/补全/跳转 ✓：每层按当层容器给注解与声明行，数组元素 FD 同面（`self.bag[0]["x"]`）。

## 9. 门禁

eslint 0 / tsc 0 / unit 全量 / xvfb demo 25 RC=0；本批零 Rust 变更（无 cargo/clippy 面）。