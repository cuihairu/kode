# KSEM-STRUCT-04 FIXED_DICT 构造点校验（缺键/多键/字段值结构错配）

**日期**：2026-11-13
**条目**：`todo.md` KSEM-STRUCT-04 [P1]「检查固定字典构造。验收：在确定的结构消费点诊断缺键、多键、错误字段类型；开放普通 dict 不套封闭约束。」

## 1. 验收逐项落点

| 验收句 | 本批落点 |
|---|---|
| 确定的结构消费点 | 赋值目标可解析为 FD 容器才接管:①`self.<属性> = {…}`(def 属性 <Type> 是 FD 别名);②`self.<属性>["<键>"]… = {…}`(键链复用 STRUCT-02 `resolveFixedDictSubscriptKey` 单一解析链,末键落 FD 字段) |
| 缺键 | 键全字面量且无 `{**展开}`/动态键(宇宙封闭)→ 声明集 − 字面量键,报在开括号位 |
| 多键 | 字面量键不在声明集 → 报在键段;**宇宙开放也照报**(展开带不回一个字面量多键) |
| 错误字段类型 | 内置标量字段的整段字面量值按 CELL-08 同一引擎标量真源裁结构错配,报在值段 |
| 开放普通 dict | 裸名目标/属性不可解析/标量·数组·非 FD 目标/增强赋值/`==` 比较/调用与构造 RHS/未闭合字面量 → 空集,一律不套封闭约束 |

## 2. 引擎真值与判定口径

- FIXED_DICT 是封闭字典:字段集在 types.xml `<Properties>` 声明序封闭(fixeddict.h `pyscript::Map`,STRUCT-01/02 盘点锚定),脚本侧以 dict 字面量构造后赋给 FD 型目标——这就是「构造点」的确定消费形态;
- 缺键只在键宇宙封闭时可判:段里出现 `**x` 裸展开(无冒号段)、动态键(变量/f 字串/bytes 键/残缺)→ 宇宙开放,缺键不报(展开可能携带旧值),多键照报;
- 字段值结构面**零新表**:复用 CELL-08 `cellDataWriteCheck.ts` 的标量族真源(新增导出 `cellDataScalarFamilyLabel`/`judgeCellDataValueStructure`/`CellDataValueLiteral`),字段的引擎类型取 `CustomTypePropertyInfo.typeName`(types.xml 原文 <Type>,非 Python 注解);范围面(如 `uid=300` 越 UINT8)显式归还 KSEM-STRUCT-05,本面不重复报;
- 值非整段字面量(名字/调用/残缺)→ unknown 不猜,绝不据此报错配(误报=0 优先)。

## 3. 新增纯核(`src/backend/fixedDictConstructCheck.ts`,零 vscode 依赖)

| 导出 | 职责 |
|---|---|
| `analyzeFixedDictConstructWrites(text, resolve, customTypes)` | 主扫描:目标形态匹配 → 跨行花括号配对 → 对切分 → 三面判定 |
| `matchDictBraces` | `{`→`}` 跨行配对(引号/转义/行注释感知,注释原位抹空保偏移;三引号态跨行连续;窗口 100 行,未闭 → 整点不猜) |
| `parseDictPairs` | 顶层逗号切分 + 首个顶层冒号分键值(引号/嵌套深度感知);返回 `{pairs, openUniverse}` |
| `matchConstructTarget` | LHS 收窄:`self.<属性>` + 全 `["<名>"]` 形括号列(零个=根形态);整数/切片/点链/增强赋值/`==` → null |
| `fixedDictConstructFindingToItem` | finding → 纯数据诊断项(code `kbengine.fixedDictConstruct`,Warning) |
| `render*Message` ×3 | 消息模板单一来源(l10nText;中英 bundle 同步登记) |

**实现坑(实测抓出)**:
1. 引号态早退——串态分支扫到串内首字符后未等闭引号就退出串态,闭引号被当新串起点吞掉后续冒号,键全部解析失败(missing 报成 "x, y, z" 整串);三处扫描器(配对/逗号切分/冒号查找)同病同修:**只有 `ch === quote` 才退出串态**;
2. `indexToPos` 首行漏加开括号绝对列(joined 从 `{` 起步,row 0 要加 `startColumn`);
3. `** 展开`段无冒号,首轮 `colonAt < 0 → continue` 静默漏置开放标记 → `parseDictPairs` 重构为返回 `openUniverse`;
4. `keyPart.indexOf(keyTrim)` 已含键前空白,再叠加 `keyFirstCol` 会双计 +1;
5. 赋值号定位不能走惰性组 `match[3]`(会把 `=` 前尾随空白漏出组外),用 `lineText.indexOf('=', 缩进+'self.'.length+prop 长)` 算术定位。

## 4. 接线(诊断族四件套)

| 件 | 落点 |
|---|---|
| 家族 code + 独立调度 | `src/activate/diagnostics.ts`:`scheduleFixedDictConstructDiagnostics`(集合 `kbengine-fixeddict-construct`,Warning;enabled 闸 → 注册表快照空 → 空;def 属性类型经 `entityMappingManager.resolvePropertyDefinitionInfo` locator 同契约) + `rescheduleFixedDictConstructForRegistryChange`(types.xml 变更 invalidateAll + 全 .py 重排) |
| package.json 开关 | `kbengine.fixedDictConstructDiagnostics`(boolean,默认 true) |
| Settings 描述对账 | package.nls.json/zh-cn 中文房屋风格描述(默认值：开启/详见 配置指南#diagnostics);`tests/configMarkdownDescription.test.ts` 9/9 |
| 孤儿开关闸 | `src/lintRuleRegistry.ts` 新 KBE-PY-021 行(toggles 引用开关);`tests/lintRuleRegistry.test.ts` 无孤儿 |

extension.ts 挂四钩:onDidOpen immediate / onDidChange queued / 开关变更 immediate / types.xml 注册表变更重排;def 脏变更随 `retriggerCellDataDiagnosticsForDefChange` 扩展重触发(invalidateAll + 全 .py 第二循环——FD 属性跨全部角色目录,不加 cellScriptRoleAndEntity 闸);flush timer 追加 `fixedDictConstructScheduler.flushQueued()`(CELL-15 教训同形——queued 任务滞留不发布)。

文档对账:features.md 中英(Settings 表行 + 诊断能力 bullet + 证据行)、guide/features.md 中英镜像 bullet、configuration.md 中英总览表行、kbengine-lint-rules.md 中英(KBE-PY-021 行/area 行)——`tests/docsCommands.test.ts` 双向对账闸绿。

## 5. 诚实边界(全部测试钉死,27/27)

- 嵌套 dict 字面量不下钻:`self.info = {"pos": {"x": "bad", …}}` 顶层键集照判,内层字段值不裁(深层面属后续批);
- 嵌套链面:`self.info["pos"] = {…}` 接管(键链解到 FD 字段),`self.info["label"] = {…}`(深层标量)与 `self.info["bogus"] = {…}`(链中未知键)诚实断链;
- 值分类落 unknown 的退化不误报(lambda 顶层冒号会误分对,值分类 unknown → 不猜);
- 未闭合字面量整点不猜;重复字面量键 Map 去重;窗口内多构造点互不串扰、字面量行整体消费;
- 标量目标/数组目标(`self.bound2 = {…}` on UINT8、`self.bag = [{…}]` 的元素 dict)不接管——数组元素构造面若要做,属 STRUCT-05 后续面;
- 范围面不报(`uid: 300` 越 UINT8 界不报,归 STRUCT-05)。

## 6. 证据

- 纯核测试:`tests/fixedDictConstructCheck.test.ts`(27 例:缺键/多键/宇宙开放/值结构/普通 dict 不接管/多行位置/item 形状);
- ANCHORS:extension.ts 接线 5 处插入致锚点位移,`tests/perfCallChainDoc.test.ts` 与 `docs/perf/2026-baseline.md` 同批锁步(见 baseline STRUCT-04 节);
- 门禁:eslint 0 / tsc 0 / vitest 全量绿 / xvfb demo 25 RC=0(见提交信息);
- prove-red:`git stash push -u -- src/` 后测试收集失败(纯核模块缺失,非绿),恢复后 27/27 绿。
