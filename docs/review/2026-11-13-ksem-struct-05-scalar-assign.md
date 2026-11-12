# KSEM-STRUCT-05 def 属性标量赋值范围/结构校验

**日期**：2026-11-13
**条目**：`todo.md` KSEM-STRUCT-05 [P1]「检查标量赋值范围。验收：按引擎 isSameType/编码约束核实整数上下界、字符串/bytes、向量及 None 接受规则;避免仅凭 Python 类型名判断。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 整数上下界 | CELL-08 `SCALAR_FAMILIES` 同源(datatypes.cpp `DataTypes::initialize` 注册表):UINT8..INT64 带宽与符号封闭区间,BigInt 精确边界(2^63-1 不报/2^63 报);负入无符号报范围 |
| 字符串/bytes | STRING/UNICODE 只收字符串字面量;BLOB 只收 bytes 字面量;错类报结构 |
| 向量 | VECTOR2/3/4 序列字面量元数按语法可数,元数不符报结构;元数相符时元素全数值不报、元素含字符串/None/字典报结构、元素含未知表达式不猜 |
| None 接受规则 | None 入引擎标量=结构错配(isSameType 假);None 入 PYTHON 族不查(标量表外,诚实);bool 是 int 子类入整数/浮点不报(CELL-08 同真值) |
| 避免仅凭 Python 类型名判断 | 引擎标量名在**注册表层**裁定:`resolveEngineScalarTypeName` 沿 types.xml `aliasType` 链下钻到引擎标量名(HEALTH→UINT8 同面),不走 pythonTypeStubs 注解链——那是 Python 类型名(int/list),不是引擎标量名;FIXED_DICT/ARRAY/未知/环 → null 不接管 |

## 2. 确定消费点(赋值目标可解析为引擎标量)

- ①`self.<属性> = <整行字面量>`:def `<Type>` 直文/别名链下钻后落标量表;
- ②`self.<属性>["<键>"]… = <整行字面量>`:键链复用 STRUCT-02 `resolveFixedDictSubscriptKey` 单一解析链,末键字段 typeName 进标量表,来源段为容器声明(`types.xml:30` 形);
- ③`self.<属性>[<整数>] = <整行字面量>`:数组根(aliasType==='ARRAY'),元素类型取注册表内联 `of` 节点原文;
- 三形态消息统一附声明来源(`Avatar.def:5` def 直属性 / `types.xml:30` FD 字段与数组元素)。

## 3. 新增纯核(`src/backend/scalarAssignCheck.ts`,零 vscode 依赖)

| 导出 | 职责 |
|---|---|
| `analyzeScalarAssignWrites(text, resolve, customTypes)` | 主扫描:逐行目标匹配 → 引擎类型裁定 → 字面量分类 → 全量裁定 |
| `matchScalarAssignTarget` | LHS 收窄:`self.<属性>` + 括号段列(字符串键/整数下标,段间只容空白);`=` 列用 indexOf 算术定位;RHS 剥注释后取首段 |
| `resolveTargetEngineType` | 三形态分流:根形态/FD 字段链(末键)/数组元素;每属性 resolveCache 免重复 locator 调用;混合链 null |
| `resolveEngineScalarTypeName` | 注册表层标量名裁定:family 直配/别名链逐层下钻(visited 有界环) |
| `scalarAssignFindingToItem` | finding → 纯数据诊断项(code `kbengine.scalarAssign`,Warning) |
| `render*Message` ×2 | 消息模板单一来源(l10nText;中英 bundle 同步登记) |

**引擎真源零新表**:`src/backend/cellDataWriteCheck.ts` 新增导出 `judgeCellDataValueWithRange`——同一 `SCALAR_FAMILIES` 全量裁定(范围面**不豁免**,与 STRUCT-04 用的 `judgeCellDataValueStructure` 恰好互补:构造面豁免范围、本面全量,两面按 RHS 形态天然互斥不重复)。

**实测坑(别再踩)**:别名 face 首版走 `resolveAnnotationTypeWithReason('HEALTH')` 拿到的是 PYTHON 注解('int'),标量表查不到 → 换注册表层 `resolveEngineScalarTypeName` 走 `customTypes` aliasType 链,21/21 转绿。这条就是「避免仅凭 Python 类型名判断」的验收本体。

## 4. 接线(诊断族五件套)

| 件 | 落点 |
|---|---|
| 家族 code + 独立调度 | `src/activate/diagnostics.ts`:`scheduleScalarAssignDiagnostics`(集合 `kbengine-scalar-assign`,Warning;enabled 闸 → 注册表快照空 → 空;def 属性经 `entityMappingManager.resolvePropertyDefinitionInfo` 同契约,source=defFile 基名:行) + `rescheduleScalarAssignForRegistryChange`(types.xml 变更 invalidateAll + 全 .py 重排) |
| package.json 开关 | `kbengine.scalarAssignDiagnostics`(boolean,默认 true) |
| Settings 描述对账 | package.nls.json/zh-cn 中文房屋风格描述(默认值：开启/详见 配置指南#diagnostics);`tests/configMarkdownDescription.test.ts` 9/9 |
| 孤儿开关闸 | `src/lintRuleRegistry.ts` 新 KBE-PY-022 行(toggles 引用开关);`tests/lintRuleRegistry.test.ts` 无孤儿 |
| flush timer | extension.ts 定时器追加 `scalarAssignScheduler.flushQueued()`(CELL-15 教训同形——queued 任务滞留不发布,STRUCT-04 批内自纠的第五件) |

extension.ts 挂四钩:onDidOpen immediate / onDidChange queued / 开关变更 immediate / types.xml 注册表变更重排;def 脏变更随 `retriggerCellDataDiagnosticsForDefChange` 扩展(scalarAssignScheduler.invalidateAll + FD 构造循环尾追加 queued 重排——def 属性跨全部角色目录,不加 cell 角色闸,同 STRUCT-04 口径)。

文档对账:features.md 中英(Settings 表行 + 诊断能力 bullet + 证据行)、guide/features.md 中英镜像 bullet、configuration.md 中英总览表行、kbengine-lint-rules.md 中英(KBE-PY-022 行/area 行)——`tests/docsCommands.test.ts` 双向对账闸绿。

## 5. 诚实边界(全部测试钉死,21/21)

- 混合链(数组元素再取键:`self.bagPos[0]["x"] = …`)不追——链状态机不跨数组段推进,诚实断链(扩展面属后续批);
- 标量字面量赋给 FD 型目标(FD 容器/数组 FD 元素)不猜——容器面错配属 STRUCT-04 族边界,本面不越界;
- dict RHS 跳过(`target.rhsText.startsWith('{')`)——归 STRUCT-04 构造面,按 RHS 形态互斥不重复;
- 数组根上的字符串键(引擎数组键是整数)链死不接管;元素是 FD 的数组元素赋标量不猜;
- 名字/调用 RHS、增强赋值、`==`、属性不可解析 → unknown/断链不猜,绝不据此报错配;
- 向量元素含未知表达式只保元数面,元素面不猜(elements=null)。

## 6. 证据

- 纯核测试:`tests/scalarAssignCheck.test.ts`(21 例:范围/边界/别名链/结构面/bool 放行/向量元数/FD 字段三面/数组元素面/普通形态不接管/item 形状);
- ANCHORS:diagnostics.ts import +6/接口声明 +4 → 打点锚点 162/175→172/185;extension.ts 解构 +3/open +2/change +2/注册表 +2/flush +2/开关 +4 → 415→420、508→517;`tests/perfCallChainDoc.test.ts` 与 `docs/perf/2026-baseline.md` 同批锁步;
- 门禁:eslint 0 / tsc 0 / vitest 全量绿 / xvfb demo 25 RC=0(见提交信息);
- prove-red:`git stash push -u -- src/`(含未跟踪新模块)后测试收集失败(纯核模块缺失,非绿),恢复后 21/21 绿。
