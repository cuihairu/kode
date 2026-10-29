# defAnalyzer 迁移取舍

- 日期:2026-10-29 · 基线:`301f9d4`(IDE-RST-003 收口后)
- 来源:todo IDE-RST-004;范围评审「R2.5 模块边界核对」defAnalyzer 行与修正建议 1/3;现成输入对照 [2026-10-29-r2-index-inventory.md](2026-10-29-r2-index-inventory.md)(§1–3 现成、§4 缺口)。
- 对象:`src/defAnalyzer.ts`(780 行,九类检查:phantom-type / missing-type / duplicate-type-tag / heavy-sync-broadcast / redundant-detail-level / invalid-identifier / method-property-collision / engine-limited-name / inherited-name-collision)+ `kbengine.def.analyze` 命令面(extension.ts:3093:findFilesAcrossRoots → 逐文件 openTextDocument → collectInheritedNames 闭包 → analyzeDefDocument → 报告+诊断)。
- 锁定:tests/rstDefAnalyzerTradeoffDoc.test.ts(章节/数字/缺口点名/结论形态)。

## 1. 输入缺口(相对 R2 Rust 索引)

R2 现成可用的只有:符号视图(Symbol/六类 kind/facet)、Parent 链(entity_chain)、entities.xml 域位(EntityEntry.attributes)、字节级 Span 定位。迁移 defAnalyzer 还缺四类输入,均为 TS 侧私有:

1. **未保存缓冲区**:命令经 `openTextDocument` 逐文件取 VS Code 文档(含打开文档的脏缓冲区状态);R2 索引吃磁盘文本。切到 Rust 需先定未保存缓冲区同步口径(范围评审原话:需先定未保存缓冲区同步和诊断位置对拍口径)。
2. **Interfaces/组件闭包语义**:collectInheritedNames 实现「Parent 链 + Interfaces 混入(传递)+ 组件 def 在 components/ 内解析(defRenamer.resolveLinkPaths 同口径)+ 环截断 + 定义根定位不到返回空面」;R2 的 entity_chain 只有 Parent 链(ChainNode=entity/parent),无 Interfaces、无组件解析。
3. **引擎真值表**:PROPERTY_FLAG_DOMAINS(common.h L19–45 三域位映射)、ENTITY_CLIENT_DATA_FLAGS 客户端可见旗标、幻影类型判定用的内建类型注册面、Python 关键字表——全在 TS 常量面,Rust 无对应。
4. **定位单位**:findings 的 offset/length 是 defParser 的 UTF-16 code unit 偏移(诊断经 document.positionAt 消费);Rust Span 是字节偏移。非 ASCII 语料(中文注释/文案)两者不等,对拍前必须定换算口径。

另有检查语义本体(九类检查的判定逻辑与文案)需整体移植——量大但纯函数,无环境依赖。

## 2. 当前耗时(2026-10-29 本机单轮,合成语料探针)

方法:真实 tmp 工作区(scripts/entity_defs/*.def + entities.xml)驱动 collectInheritedNames 真走根定位+闭包解析(默认 fs 读);analyzeDefDocument 纯函数;预热一轮 JIT 后整批计时。**单轮、合成语料(扁平 UINT32 属性,无嵌套 FIXED_DICT——嵌套语料解析按 head2head 更贵)、不含 VS Code openTextDocument 宿主 IO**;跨机器绝对值禁止比较(PERF-015)。

| 语料 | TOTAL | closure | analyze | findings |
|---|---:|---:|---:|---:|
| S 300 文件×40 属性×8 方法×链深 5 | 824.94 ms | 754.41 ms | 69.93 ms | 11,520 |
| M 1000 文件×40 属性×8 方法×链深 5 | 2325.88 ms | 2159.13 ms | 164.94 ms | 38,400 |
| L 单文件 2000 属性×200 方法 | 5.67 ms | 0.63 ms | 5.03 ms | 0 |
| XL 单文件 8000 属性×400 方法(924 KB) | 16.43 ms | 1.61 ms | 14.82 ms | 0 |

读法:

- **多文件面由闭包主导(91–93%)**:每入口重走祖先链并重复解析祖先 def(跨入口无记忆化);1000 文件语料约 2.3 s。findings 非零是合成链语料退化形态(链上每级全量重声明同名属性,inherited-name-collision 如实触发)。
- **单大文件分析线性**:扁平形状 924 KB≈15 ms,无超线性尾巴;head2head 的 MEGA(20k 属性、嵌套)TS 1127–1288 ms 属另一复杂度形状,不可与本表混读。
- 命令通道为用户触发的批处理,产出报告+诊断集合,不在 hover/跳转等交互路径上(与 PERF-01 的 hover 路径同步阻塞不同类)。

## 3. 位置对拍范围

- 对拍对象:每文件 findings 数组逐条相等——check + severity + name + line(1 基)+ offset(0 基)+ length + message;任何一项不等即 diff。
- 前置:UTF-16 offset ↔ 字节 Span 换算规则定案(§1.4);golden 比较走 pr-012 门 2 式 diff 判定(firstDiffPath 规范比较,键序不敏感)。
- 语料轴:至少覆盖 空/缺 Type/重复 Type/幻影类型/旗标组合/同名冲突(方法-属性、祖先继承)/Python 关键字名/中文注释内嵌(专测换算);每轴单文件+链形态两面。

## 4. 采纳/暂缓结论

**暂缓整体迁移,保留独立批处理候选**(范围评审同判)。依据:

1. 成本面当前不痛:命令触发批通道,本机 1000 文件合成语料单轮 2.3 s,无交互阻塞面;内存峰值为一次性报告语义,不落在用户体感。
2. 输入缺口四处(§1)都要先定口径,其中未保存缓冲区与 UTF-16 换算是硬前置; Interfaces/组件闭包在 Rust 侧尚无对应物。
3. R1 判据(XML 解析内存 9.3×–33.8×)支持的是解析面迁移,不是检查语义迁移;若只换解析腿,闭包主导的多文件成本里解析占比还需先分层计量(本表 closure 未拆 fs 读与解析)。

复评触发条件(任一满足即重开):

- 真实大型语料(嵌套 FIXED_DICT、20k 属性级)上 analyze 或 closure 出现超线性或秒级×10 劣化;
- R2 切流推进到门 2 golden 扩面需要 def 分析面;
- 用户报告分析命令在真实工程中可感卡顿(现场证据,PERF-015 口径)。

若届时采纳,顺序:①UTF-16↔字节口径与未保存缓冲区同步定案 → ②解析腿换 R2 parser(Span→offset 换算,单文件面先对拍) → ③闭包面(Rust 侧补 Interfaces/组件解析+跨入口记忆化) → ④检查语义与真值表移植(最后,量大而纯)。中途任一步对拍不等即停,回到 TS 轨。
