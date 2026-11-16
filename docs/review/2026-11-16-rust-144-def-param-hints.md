# RUST-144 批 1 验收纪实:defParamInlayHints 决策核下沉 Rust(def_param_hints.rs)

日期:2026-11-16。todo 行:RUST-144(InlayHints (RPC 参数名/类型) 与 SemanticTokens;本批=定义点 def 形参类型 inlay 决策核+golden 双向门禁;批 2=SemanticTokens 新面与增量 token 成本评测)。

## 交付面

- `crates/kode-server/src/def_param_hints.rs`(新建,~1240 行):定义点 def 形参类型 inlay 决策核同构下沉,正则全手写,文本坐标域 UTF-16 code unit,纯库零 RPC;
- `crates/kode-server/src/bin/dump-def-param-hints-golden.rs`(新建):golden 生成器;
- `crates/kode-server/tests/golden/def-param-hints-parity.json`(生成,12 语料/46 探测/46 产出):corpus(name+path+text 三元,path 参与段判)+probes+outcomes 同文件;
- `crates/kode-server/tests/def_param_hints_golden.rs`(新建,2 测试):重生成比对(diff_at 诊断+重生成命令提示)+结构完整性(语料≥10/探测≥30/两面全覆盖审计/产出形态校验+items 非空分布);
- `tests/kodeDefParamHintsParity.test.ts`(新建,3 测试):TS 镜像——读 golden corpus+probes 驱动**生产** findDefParamSites/buildDefParamInlayItems(workspaceRoot='')逐探测复算对拍 outcomes;
- `src/lib.rs`(Rust):两处接线(`pub mod def_param_hints` + `pub use dump_def_param_hints_golden`)。

## 纯面清单(逐条对 TS 生产源核过)

1. **路径身份归一**(pathIdentity.normalizeFileIdentity 同构):词法折叠 `..`(盘符根 C: 不可弹出/UNC floor 2)/盘符与 UNC 小写化/裸盘符段收尾仅对无前缀路径生效;
2. **段判**(entityMappingHelpers.inferMethodSectionFromPythonFile 同构):`/scripts/bots/`、`/assets/scripts/bots/`、`bots/` 前缀、`/bots/` 多形态 → ClientMethods;base→BaseMethods/cell→CellMethods/client→ClientMethods;区块外 None(普通方法不做推导);
3. **pythonCodeLines 掩码**(backend/pythonParser 同构):UTF-16 位置不变(引号内空格/转义吞两位/三引号开占三列 `_` 关闭占三列空格/# 到行尾空白);
4. **pythonStatements 语句合并**:括号深度+反斜杠续行(`\` 剥离+尾空白);`\t` 缩进记 4;
5. **parsePythonFile 类方法表**:stack 缩进域(pop top.indent>=indent)/嵌套函数体内 class 跳过/嵌套类 qualifiedName 链(`Outer.Inner`)/async def 同表/方法名列=statement.text.indexOf(name, indexOf('def')+3) 启发式;
6. **parseDefLine**:名字后首个 `(`;括号深度配对闭括号列;跨行(同行括号不闭合)不出;首参 self/cls 剥离;
7. **splitParams**:顶层逗号切分(括号/字符串字面量感知;quote 内 `\` prev 判定同 TS 简易语义)/名字 token IDENTIFIER 锚(ASCII)/标注边界=名字后首个顶层分隔符是 `:` 才算已标注(默认值字典字面量内 `:` 不算)/star 剥 `*+`/名字列 UTF-16 全域定位(含 CJK 形参名);
8. **内建直查无闸**(resolveEntityAnnotationType('') 同链):PYTHON_BUILTIN_TYPE_ANNOTATIONS 22 键直查**无 BUILTIN_ANNOTATIONS 闸**(VECTOR2→'Vector2' 照出,与 code_action 骨架闸不同;ENTITYCALL/PYTHON 表值 'Any' 与 PYTHON_TYPE_STUB_FALLBACK 同串→该位不出)+ KBENGINE_TYPE_ALIASES(Address/WatcherValue)按名引用;
9. **buildDefParamInlayItems**:配对 min(声明数,形参数);跳过 declared 空/hasAnnotation/isStar/annotation=='Any';ReturnType 同 Any 闸;position=(line, param.end)/(line, closeParen+1);kind Parameter/Type。

## golden 形态与对拍方向

`{generator, corpus, probes, outcomes}`:serde tag=face camelCase(sites/items),产出字段 camelCase(methodName/closeParenCharacter/hasAnnotation/isStar/declaredArgs)。TS 镜像读 corpus+probes 驱动生产函数复算(workspaceRoot='' 走生产内建直查链,与 Rust resolve_annotation_direct 同链零注入),逐探测对拍 outcomes。**镜像红=移植错,按 src/ 生产源码重推**。Rust golden 测试同代码同义反复,防伪靠 9 个独立单元钉。

## 探测面

sites 12(逐语料全站点)+ items 34(cell_multimethod 5 站点×4 声明面 20 + 逐语料声明配对 14)。非空产出 sites 11/12(段外语料零站点如实空)。

## Rust 单元钉(9,全绿)

masks_strings_and_comments_position_invariant / statement_merges_continuations / parse_python_file_class_method_table / section_inference_multiform / parse_def_line_boundaries / split_params_strings_and_defaults / inlay_items_pairing_rules / builtin_direct_gate / find_def_param_sites_section_gate。

## prove-red(双端五靶,全闭环;cp 备份+变异+跑测+cp 还原+cmp 字节校验+grep 钉存在性复绿)

- Rust 靶 1:bots 段判返回值反转 → section_inference_multiform 红 → 还原 → 9/9 绿;
- Rust 靶 2:删 Parameter 位 Any 闸(`annotation != "Any"` guard)→ inlay_items_pairing_rules 红(加钉后)→ 还原 → 绿;
- Rust 靶 3:删 self/cls 首参剥离(条件改恒 false)→ parse_def_line_boundaries + find_def_param_sites_section_gate 红(2 例)→ 还原 → 绿;
- Rust 靶 4:删 ReturnType 位 Any 闸 → inlay_items_pairing_rules 红 → 还原 → 绿;
- TS 靶:生产 Any 闸 bypass(`if (false && ...)`)→ 镜像对拍红 1 例 → 还原 → 3/3 绿。

## 坑账

1. **split_params 字节域切片 panic(实现真缺陷)**:初版 `&param_text[start..end_exclusive]` 用 UTF-16 偏移切 UTF-8 字节串,CJK 语料 `中文, x` 直接 char boundary panic——重写为全程 UTF-16 域(在 units 上切+units_to_string 产出)。教训:TS `slice(start, end)` 的坐标域是 UTF-16,移植必须全域同系,不能「字节串也能切」直觉带过;
2. **钉期望值四连算错**:①掩码期望串把开引号 `_` 写成全下划线(`"x,y"`=开 `_`+内容 4 空格,非 `____`);②statement 数漏计(class+def+pass=3 非 2);③parse_def_line 名字列 9→8(TS 启发式 indexOf('def')+3 起 indexOf(name);`    def foo` 的 foo 列 8);④inlay 已标注例期望 0 实为 1(复用的 3 项声明面里 index 1 是 VECTOR3,`b` 配 Vector3 照出)。教训:钉断言值显式推自语义逐列精算,不凭「大概」;
3. **prove-red 假阴性(护栏缺失)**:初版钉里 Parameter 位无 Any 表值例(ENTITYCALL/PY_DICT 只在 golden 探测里),删 Any 闸变异 9/9 全绿不红——同 RUST-143 fd 紧贴负例教训;加钉(decl=[ENTITYCALL,PY_DICT] 断 len==1 且 text==": dict")后靶红。**加钉时又抓到自己第二处期望错**:PY_DICT→dict 非 Any 该位照出,初版断 len==0 被实现即时拦下(这正是钉的价值);
4. **TS prove-red 前先跑绿新钉**:钉的断言值被实现拦下后修正才闭环,顺序=先钉绿再变异,否则假红/假绿混杂;
5. **serde tuple position**:Rust `(usize, usize)` 序列化为数组,TS `{line, character}` 是对象——改 Rust 侧 InlayPosition 结构体对齐,TS 镜像零转换。

## 诚实边界(批 2 范围)

注册表快照链不下沉:TS buildDefParamInlayItems 经 resolveEntityAnnotationType(workspaceRoot) 的自定义类型/别名发现/脏 types.xml 快照失效全留 TS(本批只承载 workspaceRoot='' 的内建直查链,TS 镜像同链零注入);provider 装配面留 TS(DefParamInlayHintsProvider 配置开关/可视区 range 闸/EntityMappingManager.resolveMethodDefinition 查询/vscode.InlayHint 构造/l10n);SemanticTokens 面(TS 零实现,新面)与增量 token 更新成本评测留批 2。

## 门禁

eslint 0 / tsc 0 / vitest 全量 853 文件 10378+8skip RC=0 / xvfb demo 25 RC=0 / clippy -D warnings 0 / cargo 全量 -p kode-server 15 套件全绿 0 failed RC=0 / prove-red 双端五靶闭环 / golden 重生成字节锁(46 探测)。
