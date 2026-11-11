# 精确性主车道:Rust 侧分析面 AST 化逐批升级(战役审计)

- 日期:2026-11-11
- 授权:用户令「分析出来的数据还是不精确,还有误导人的东西……抓住能解析的一些去推导解析」
- 底座:kode-python 已依赖 ruff_python_parser 0.0.20(C-20 令);`parse.rs::ParsedAst` 容错解析(部分 AST+错误表)+ `line_col(offset)→(0 基行,0 基 UTF-16 列)`;AST 符号模型/visitor 走查先例(symbols.rs/callgraph.rs/dataflow.rs)
- 纪律(贯穿各批):
  1. **能解析的抓来推导,推不出显「未知」,不硬造**——每批双向验收:假阳性必须减少、可推导真值补上、未知保持诚实;
  2. **TS 消费面(inlay/hover UI/诊断发布)零改动**;TS 推导引擎冻结为杀开关兜底(`kbengine.core.backend=ts` 语义不变);
  3. **split-parity 测试法**取代 B1 字节全量对拍——输出合法变好,不再以 TS 旧输出为全量基准:未触及维度保留深等(回归网),升级维度改策展精度断言(误导样本→新正确值 + 无伪造样本→null/空);
  4. 每批全量差异审计:所有对拍/fixture 跑出的分歧逐条过目,只接受「改进/持平」,任何回退单独审并记录在本文件;
  5. 每批门禁:clippy 0 / cargo test 双 crate 全绿 / eslint 0 / compile 0 / unit 全量 / xvfb demo 25 RC=0 / docs 对账 / todo.md 进度注带 hash / prove-red。
- 实测误导账本(战役靶子):
  1. 集合字面量 `{1,2}` 首尾字符嗅探误判 dict(self_flow.rs typeOfExpr)——**批 B**;
  2. 返回注解 hover 级联兜底 `cascadeAnnotation(methodName)` 全局方法名猜测跨类误绑(pythonReturnTypeInference.ts:997-1003)——**批 D**;
  3. 嵌套类/条件 def 域错位(正则跨度把内层类行归外层方法域)——**批 A(本期)**;
  4. 未知 RHS 赋值抹掉 None 证据(替换语义保留=诚实,批 C 收窄漏报面);
  5. 诚实缺失:链式 `f().g()`/别名/跨变量传播/in-file 调用注解恒空——**批 C**。

## 批 A:流引擎类跨度换 ruff AST 真域(2026-11-11)

### 改动

- crates/kode-python/src/self_flow.rs:`class_spans_from_ast`(+`walk_class_scopes` 走查,ruff visitor 惯法同 symbols.rs)取代正则跨度链;`ClassSpan` 增 `method_domains: Vec<MethodDomain>`(方法真实体域:def 名行..语句末字符行,0 基含尾);`enclosing_method` 改**全类集合内含查询行的最小域者胜**;类身份查找(:infer 类体分支)同改最小者胜。
- 删除:PyStatement/python_statements/match_class_statement/match_def_statement/parse_class_spans/python_code_lines(掩码助手)整链——Rust 内无其他消费者;TS 兜底走 TS 自己的解析器,不受影响。
- 行号口径:ruff class/def range **含 @ 装饰器前缀**(parser 源实证:parse_function_definition/parse_class_definition 的 start=装饰器 `@` token)——`name.range.start()` 校正出 def/class 名行,与旧「def 名行」口径一致;语句末字符行=`line_col(range.end()-1)`(end 为排他字节 offset)。
- 不动面:versionKey LRU 协议(键/容量 8/触碰移尾/reset hook)、`$/kode/python/selfAttributeFlow` 与 `$/kode/lint/analyzeAttributeNone` RPC 形状、`converged_baseline`(`__init__` 扫描靠缩进去位自限,真域化等价,最小刀不动)、TS 侧全部文件。
- 走查同员口径:类体直系+控制块(If/For/While/With/Try/Match)内 def 仍归属该类(与旧展平口径同员——条件 def 成员资格不因换道改变);def 体内不下行(与旧 scope.function 同员);嵌套类自成一个 ClassSpan。

### 语义变化与分歧审计(全量对拍跑出的每类分歧,逐条裁决)

| 位置类 | 旧引擎(正则启发式) | 新引擎(真域) | 裁决 |
|---|---|---|---|
| 嵌套类方法体内 | 被外层类吞:归外层最后方法流/落空(跨类误绑) | 归内层类方法,流真实 | **改进**(用户点名误导) |
| 方法间空行/注释(方法域内间隙) | 归上一方法(流至该行) | 不属任何域→类体分支=类基线 | **改进/持平**:空隙非使用位;基线=类级真实知识 |
| 类级赋值行(类尾) | 吞进最后方法域(方法流残留) | 类基线 | **改进**(Rust 内联钉 `trailing_class_body_lines_leave_method_domain` prove-red 恰红) |
| 方法尾注释行(类跨度内,后有成员) | 归该方法(流常被不可解析调用抹空) | 类基线 | **持平/改进**:基线=类级知识,与类体内其他非代码位语义一致(fixture Poller.py@33 实证:旧=被 socket.socket() 抹空的 {},新=类基线 {None}) |
| 类末语句之后的行(模块层) | 注释被当语句吞进类域→方法流 | 类跨度=末语句,范围外诚实空 | **改进**(假象范围收窄) |
| 未闭合括号文件 | 语句合并吞掉尾部 def | ruff 容错解析,尾部 def 可见 | **改进** |
| 平铺单类文件方法体内(生产使用位) | — | 与旧逐位同值 | **持平**(对拍全绿回归网) |

- 注释行说明:生产 inlay 的访问扫描(findPythonSelfPropertyAccesses)**不滤注释**——注释行上的 `self.<attr>` 文本命中仍会查询。两引擎在非代码位均为启发式(类体内不存在 `self.` 声明语句行,类体分支的真实输入全是注释/docstring/字符串行);新语义=类跨度内非代码位统一落类基线(位置稳定),类跨度外诚实空。不改 TS 消费面(纪律 2)。

### 测试改造(split-parity)

- tests/selfAttributeFlowRustParity.test.ts:查询面从「每属性×每行全量」收窄到**使用位**(`self.<attr>` 代码行=生产查询面;首非空白 `#` 的注释行与空行排除,理由见上表)——合成样本深等全绿;`class-level-and-nested` 样本整体移出深等(嵌套类正是本批修正面),精度期望移交 precision 套件;非法入参(null-null)断言保留;fixture 全量使用位深等绿。
- tests/selfAttributeFlowPrecision.test.ts(新):直连 ok 断言(旧二进制/旧行为显式红)+ 嵌套类全使用位显式期望(leaf 流 None→int、Inner 域内查外层属性诚实空、Outer 自身方法面不变)+ 类基线语义(类体尾注释/类级赋值行=基线;类跨度外=空)。
- Rust 内联 +6:ast_span_shape_flat_and_nested / decorated_class_and_def_lines_exclude_decorator / nested_class_lines_attributed_to_inner_class / trailing_class_body_lines_leave_method_domain / decorator_lines_are_not_method_domain / conditional_def_stays_within_its_true_body。
- prove-red:临时换回旧启发式 `enclosing_method`——嵌套/类尾两钉恰红(区分性验证),装饰器/形状四钉双引擎同形(回归网),恢复后全绿。
- 保持不动:tests/selfAttributeFlowRust.test.ts(契约面,门 mock)、tests/attributeNoneRustParity.test.ts(首跑即绿——attributeNone 查询面=写点,全在方法体内)、TS 引擎测试(selfAttributeFlowTypes 33 例等,TS 冻结)。

### 门禁(2026-11-11)

clippy -D warnings 0 / cargo test kode-python+kode-server 780 过(0 红)/ eslint 0 / compile 0 / vitest unit 726 文件 8662 过 8 skip(0 红)/ xvfb demo 25 RC=0。批 A 提交 hash 见 todo.md RUST-PRECISION-001 进度注。

### 后续批(待逐批点火)

- 批 B:typeOfExpr AST 化——集合字面量 `{...}` 误判 dict 假阳性清除,walrus/多行/括号/负数推导,literal_annotations 钉重铸;
- 批 C:in-file 调用/裸名推导(同文件 `-> T` 注解直取,重名歧义→未知;赋值链传播防环;类属性基线全图);
- 批 D:返回注解接收者级联修正——pythonReturnTypeInference.ts:997-1003 全局方法名猜测删除 + `$/kode/python/localReturnType` 接收者定型解析(链式/别名可推导子集,类限定方法表防误绑)。

## 批 B:typeOfExpr AST 化(字面量面假阳性清除,2026-11-11)

### 改动

- crates/kode-python/src/self_flow.rs:赋值收集整链换 ruff AST——`walk_assignments` 走模块体(Assign/AnnAssign/ClassDef/FunctionDef/If(+elif-else)/For/While(+orelse)/With/Try(+handlers/orelse/finalbody)/Match(+case) 全臂),方法级 `self.<attr>` 写点按行预索引(AssignmentTypes),类体直系裸名按类身份隔离(ClassAssignmentTypes 三元键,嵌套类直系条目不进外层基线=旧缩进过滤同语义);`ast_type_of_expr` 按 Expr 节点推导:NoneLiteral/bool/int/float/complex/str(bytes/f/r 前缀分型)/ellipsis/list/**set(杀 {1,2} 误判 dict)**/dict/tuple,Named(walrus)→内层,数值/逻辑一元(-1.5→float/+0x10→int/not→bool/-True→int/~3→int);注解文本=节点字节区间切片 trim(旧 `[^=#]+?` 捕获 trim 同语义)。
- 删除文本链:type_of_expr/strip_trailing_comment/match_call_form/match_self_chain/match_bare_name/assignment_rhs/match_assignment_tail/match_class_assignment/match_class_annotated/is_str_prefix_char/is_digit/trim_js/eq_word 整段(Rust 内无其他消费者,clippy dead_code 清零);TS 引擎一行未动(冻结兜底)。
- 语义保留:替换语义(索引命中=空集也覆盖)、同行复合语句头不收集(`if c: self.x = 1` 依条件执行,与旧行扫描「行首非 self 不匹配」同)、For/With/AugAssign 目标不入索引、守卫文本面(none_guard/not_none_guard)不动、versionKey LRU/RPC 形状零改动。
- 缓存升级:LRU 值从 Vec<ClassSpan> 扩为 FlowParse{classes, assignments, class_direct}(解析一次产齐三面,键协议/容量/reset 不变)。

### 语义变化与分歧审计(逐条裁决)

| 位置类 | 旧引擎(文本嗅探) | 新引擎(AST 推导) | 裁决 |
|---|---|---|---|
| `{1,2}` 集合字面量 | 首尾字符 `{...}`→dict(实测误导 #1) | Set→set;空 `{}` 仍 dict | **改进**(用户点名) |
| 跨行 RHS `self.t = (\n1,\n)` | 截行尾解不出→∅ | 整节点 Tuple→tuple | **改进** |
| `(5)`/`((5))` 括号数值 | 首尾 `()`→tuple(假) | 括号丢弃→int(真) | **改进** |
| 十六进制/科学计数/省略号 | 文本不识别→∅ | 0xFF→int/1e3→float/...→ellipsis | **改进** |
| 方法体 AnnAssign `self.x: T = None` | 无此路径→∅ | 注解原子+RHS 并存 | **改进** |
| 多目标链 `self.x = self.y = 1` | 只首个 RHS | 各目标入索引 | **改进** |
| 分号复合行 `a = 1; self.b = 's'` | RHS 吞到行尾(垃圾) | 按语句切分各自推导 | **改进** |
| docstring/字符串内容里的 `self.x = 1` | 被当真赋值(伪造 int) | StringLiteral 语句不产赋值 | **改进**(假象消除) |
| 元组解包 `self.x, self.y = 1, 2` | 只匹配首个目标 | 单 Tuple 目标 zip 配对;星号不解(∅) | **改进** |
| lone-CR 行(行中孤立 \r) | JS 正则 `.` 不吃 \r→连真赋值都解不出 | ruff(=CPython)视 \r 为行终止:赋值行证据如实;类体断裂后 def 被容错解析丢弃→诚实空(该文件对 CPython 本身即 SyntaxError) | **改进/持平**(对拍唯一分歧,详见下) |

- 对拍分歧审计:全量跑 selfAttributeFlowRustParity(10 合成样本+fixture 使用位)与 attributeNoneRustParity(写点面),**唯一分歧**=lone-cr-mid-line@赋值行(TS [] vs Rust [None])——裁决改进(TS 文本引擎 JS `.` 不匹配 \r 致 `(.+)$` 失败=假象;Rust 按语句推导如实);同样本 m 体位 Rust [] 为诚实(类体断裂=SyntaxError 文件,不硬造流)。该样本移入 PRECISION_MOVED_SAMPLES,双面真相钉入 precision 套件。
- 残余边(记录在案,零语料命中):裸 `else:`/`match:` 后同行一条语句的体(如 `else: self.x = 1`),ruff 对裸 else 无 range,AST 收集面会收进索引而旧行扫描不收——合成面无此形态,生产语料未命中,批 C 若触再裁决。

### 测试(split-parity)

- Rust 内联 +14:set_literal_not_dict/paren_number_not_tuple/walrus_yields_inner_type/multiline_rhs_fully_typed/numeric_unary_operators/hex_scientific_and_bool_literals/same_line_compound_not_typed/tuple_targets_pairing_with_value_tuple/chained_targets_all_typed/annotated_method_body_assignments/bytes_fstring_prefixes/docstring_assignment_not_fabricated/semicolon_combo_each_typed/string_content_assignment_not_fabricated(34 既有钉全绿不动)。
- TS:对拍深等保留(9 样本),lone-cr-mid-line 移入精度面;precision 套件 +2(lone-CR 双面真相/集合字面量 set-not-dict);attributeNoneRustParity 首跑即绿(写点面无分歧)。
- prove-red:Set 臂临时改空集→Rust set 钉红 + 重编 binary 后 TS 集合精度钉恰红(断的就是批 B 新推导面);恢复后全绿。

### 门禁(2026-11-11)

clippy -D warnings 0 / cargo test kode-python+kode-server 0 红(189 kode-python 含 48 self_flow 钉)/ eslint 0 / compile 0 / vitest unit 726 文件 8664 过 8 skip(0 红)/ xvfb demo 25 RC=0。批 B 代码 hash 见 todo.md RUST-PRECISION-001 进度注。

## 批 C:in-file 调用/裸名推导(补可推导真值,2026-11-11)

### 改动

- crates/kode-python/src/self_flow.rs:RHS 不再止步字面量——走查期抽取 owned 形态快照(RhsShape:Typed/Call/SelfAttr/Local/Unknown;await 壳透明,walrus 透传内层),推导期按上下文解析:
  - `name(...)`:同文件模块级 def `-> T` 注解直取(控制块内模块级 def 同员;**重名歧义=未知,不取首定义硬猜**;无注解=未知);
  - `A.m(...)`:类限定方法注解(同类名多个=歧义不猜);`self.m(...)`:所在类限定(self 接收者先判——Name 臂截胡坑,见坑清单);
  - `recv.m(...)` 链式:接收者推导出唯一原子且恰为同类名时取该方法注解(`make_repo().load()` → Row);
  - 方法域内局部裸名链:最近写点胜(替换语义同 self 面),有界跳数(RESOLVE_MAX_HOPS=4,条目形态深度 0 每解一层 +1)+ visited 防环 + 流序前向引用诚实空;
  - `self.z` 读 → 类属性基线(批 B 收敛基线图在 RAW 索引上算,备忘录防每条目重算);
  - walrus 目标登记局部写点(顶层/元素级/await 内层);方法域裸名写点全量入 locals(首版漏登记致链恒空,已修)。
- 两阶段索引:**RAW(字面量面)先行**,基线图与防环都以 RAW 为底(推导不叠加推导,基线与条目解耦、无解析顺序依赖),推导期产出 FINAL 索引;查询面/收敛基线/RPC 形状/版本键 LRU 协议零改动(FlowParse 形状不变)。
- 类身份键修正(批 B 潜伏坑顺修):walk_assignments 类体直系键原用 stmt.range 起点(装饰器类=装饰器行)与 ClassSpan.start_line(名行)错位,批 C 起统一类名行(装饰器不计),`def` 名行同理。
- 诚实边界:无注解/未知 callee/环/越界/接收者非同类名原子 → 空集,绝不猜。

### 语义变化与分歧审计

| RHS 形态 | 批 B(字面量止步) | 批 C(AST 推导) | 裁决 |
|---|---|---|---|
| `self.x = make_tree()` + 同文件 `def make_tree() -> Tree` | ∅ | {Tree} | **改进**(KBEngine 旗舰面) |
| `self.x = self.j` | ∅(None 证据丢) | j 的类基线 {None} | **改进**(None 证据如实传播) |
| `self.x = self.helper()` | ∅ | 所在类 helper 注解 | **改进** |
| `self.x = make_repo().load()` | ∅ | 链式 {Row} | **改进**(实测误导账本 #5) |
| `y = self.items; self.x = y` | ∅ | 基线 {None} | **改进** |
| 重名 def/类/方法、无注解、环、越界 | ∅ | ∅(不猜) | **持平**(诚实边界钉死) |

- 对拍分歧审计:全量跑 parity+attributeNone,**唯一新分歧**=literals-and-bytes@k(`self.k = self.j`:TS ∅ vs Rust {None})——裁决改进(None 证据传播);样本移 PRECISION_MOVED_SAMPLES+precision 双钉(self 属性读/同文件调用)。attributeNone 写点面无新分歧(首跑绿)。
- 上轮单例抖动:unit 全量首跑 1 失败复跑消失(已知满载抖动族,非本批文件,基线口径=清洁复跑绿)。

### 测试(split-parity)

- Rust 内联 +18:module_call_annotation_hit/quoted_annotation_kept_raw/no_annotation_honest_empty/ambiguous_name_not_guessed/self_method_call_resolved/qualified_class_method_call/qualified_class_ambiguous_not_guessed/chained_call_via_class_atom/chained_receiver_not_class_atom/await_call_transparent/walrus_target_registered_as_local/local_chain_to_self_attr_baseline/local_chain_nearest_write_wins/local_chain_cycle_honest_empty/local_chain_forward_reference_honest_empty/local_chain_hop_bound/guard_narrowing_with_call_annotation/class_direct_call_annotation_in_baseline(66 self_flow 钉全绿)。
- TS:parity 深等保留(7 样本,3 移精度面;查询量下限 40→20 随样本数同步),precision +2。
- prove-red:Name 调用臂与 SelfAttr 臂临时置空→Rust 对应钉红+重编 binary 后 TS 两精度钉恰红(断的就是批 C 两推导面);恢复全绿。

### 门禁(2026-11-11)

clippy -D warnings 0 / cargo test kode-python+kode-server 0 红(221 kode-python 含 66 self_flow 钉)/ eslint 0 / compile 0 / vitest unit 726 文件 8665 过 8 skip(0 红,复跑口径)/ xvfb demo 25 RC=0。批 C 代码 hash 见 todo.md RUST-PRECISION-001 进度注。

### 坑清单(批 C 实录)

1. **self 接收者被 Name 臂截胡**:callee 形态匹配 `Name(cn)` 先于 receiver 守卫,`self.helper()` 被当 Qualified{class:"self"}→∅;修=self 先判再归类限定;
2. **局部写点漏登记**:首版只在 walrus 记 locals,普通裸名赋值不入→链恒空 ∅;修=push_entry Name 臂全量登记(method_start None 的类体直系不入=类级链不建模);
3. **rhs_shape 无 Named 臂**:`self.n = (v := f())` 的 n 形态 Unknown(f 的可推导性丢);修=Named 透传内层;
4. **深度语义**:条目形态深度 0、每解一层裸名 +1(5 具名变量链的末层已越界)——钉子按此口径写,勿按「跳数」直觉。

## 批 D:返回注解接收者级联修正(杀跨类误绑,2026-11-11)

靶子=实测误导账本 #2:hover 级联兜底 `cascadeAnnotation(methodName)` 全局方法名猜测——`a.get_data()`/`b.get_data()` 都解析到第一个同名注解,接收者类型完全无视。批 D 双侧落地:

**Rust 新面(kode-python/src/local_return.rs + kode-server/src/local_return.rs)**:`$/kode/python/localReturnType` {lines, hoverLine, word, versionKey?} → `{ret: null | {target, annotation, methodName}}`。引擎本体=同文件可推导子集接收者定型:face_scan 按 matchingAssignments 同域口径向上找悬停词最近写入(mask 先行/悬停行含入/def·class 头行收窄 scopeIndentLimit/写点检查先于头行收窄),RHS 形态解析——Call(Name→同文件 def 注解直取,重名歧义恒未知;SelfMethod→所在类限定;Qualified→唯一类名先行,否则变量原子链回退;Chained→接收者定型到唯一同类名原子)/Local(别名链 face_scan 递归,visited 防环=恒等别名诚实空)/Typed 等不答。类实例化原子(`r = Repo()`)经流证据 callee_atom 参与接收者定型,但实例化本身不是返回注解(face 不答)。versionKey LRU 协议继承(与流面共用 flow_parse 解析缓存,一次解析服务两面)。

**TS 小刀(src/backend/pythonReturnTypeInference.ts)**:级联兜底整链删除(hoveredBucket→mergedOtherDocumentAnnotations→cascadeAnnotation;查询消费面不再读文档桶,桶发布改由 extension.ts 文档事件驱动,机制保留供事件面);查询链只留 IDE-HOV-017 import 绑定路径(接收者已正确);接收者不可知→null(诚实,hover 不显)。mergedOtherDocumentAnnotations 无外部消费者随删;新增 getDocumentReturnAnnotationBucketForTests 访问器供机制断言。TS 引擎其余冻结不动(杀开关语义不变)。

**hover 装配(src/languageProviders/hover.ts + src/backend/localReturnTypeRust.ts)**:局部返回注解段 Rust-first(Rust 腿 client 自带超时不占 TS 预算,语料分支同款)→miss/失败/杀开关回落 TS import 绑定链→双 miss 重入下游既有链(localReturnAttempted 重入标记防环,语料分支同款重入口径);批 D 预检=matchingAssignments 零候选时整段零成本跳过(下游 TYP-ARRAY/数据字典/自属性面照走同步原路,不进异步)。

### 语义变化与分歧审计

| 查询形态 | 批 D 前(级联) | 批 D 后 | 裁决 |
|---|---|---|---|
| `x = svc.load()`,Repo/Noise 同名 load,svc=Repo() | 首个同名注解(Noise 在前则误答) | REPO_DATA(接收者定型) | **改进**(跨类误绑靶心) |
| `v = self.get()`,Driver.get 与 A/B 同名 | 全局猜(可能答 A/B) | FROM_DRIVER(所在类限定) | **改进** |
| `data = get_data()`,同文件 def -> JSONDATA | 级联答 JSONDATA(全工作区同名借用) | Rust 面答 JSONDATA(同文件 def 直取) | **改进**(来源收紧到真定义) |
| `data = get_data()`,无绑定无同文件 def | 磁盘任意同名注解 | null(诚实不显) | **改进**(误导消除) |
| `data = get_data()`,from svc import get_data | 磁盘 svc 桶 | 磁盘 svc 桶(不变) | **持平**(接收者已正确) |
| 文档桶级联(未保存遮蔽/跨文档借名) | 三层级联答话 | 查询不读桶(机制保留) | **改进**(借名面归零) |

### 测试(split-parity)

- Rust 内联 +25(local_return.rs:同文件 def 命中/self 方法/类限定/同类两方法各绑其类/链式别名/链式内联/恒等别名诚实空/字面量覆盖截断/兄弟方法不借用/模块域写点方法体可见/类体写点可见/悬停行写入即答/无注解诚实空/重名歧义诚实空/类实例化非返回注解/self 属性读诚实空/全大写常量跳过/未知接收者链式诚实空/前向引用诚实空/装饰器 def 名行收窄/字符串体伪写点不登记/越界悬停行/互为别名环诚实空/versionKey 缓存命中)+ self_flow +3(实例化流原子/类与 def 同名歧义/裸名变量接收者回退,69 钉全绿)。
- TS 重铸 25 例+新增访问器断言:JSONDATA 旗舰拆双例(无绑定不猜/import 绑定仍解析);IDE-HOV-011 组桶断言走访问器;REV-010/HOV-012/014/015 组查询断言改走 import 绑定路径(接收者正确);HOV-016 同文件声明例改诚实 null(推导归 Rust 面);AUD-043 本地注解例改诚实 null;首扫在途/TTL 重建/过期索引组绑定化;1 例删除(跨文档未保存遮蔽=级联语义永久退场);GapArms 3 例(659 异步让位走访问器/通配与剥点跳过→诚实 null)+2 例绑定化;documentAnnotationQueue 3 例访问器化;extension 装配例绑定化+访问器化;serving 轨道例重铸(无调用候选零请求预检闸/调用候选恰一次 localReturnType 零镜像);metrics 例改诚实 null 口径;discovery 例绑定化;cov 组 2 例(弃桶不复活访问器化/来源日志 import 面)。
- 新契约套件 tests/pythonLocalReturnTypeRust.test.ts(7 例,真二进制 withRustGate+直连断言防旧二进制假绿)+ selfAttributeFlowPrecision +1(实例化流原子)。

### 门禁(2026-11-11)

clippy -D warnings 0 / cargo test kode-python+kode-server 840 过 0 红 / eslint 0 / compile 0 / vitest unit 726 文件 8673 过 8 skip 0 红 / xvfb demo 25 RC=0 / ANCHORS 锁步(hover.ts provideHover 183→185 真位重探,baseline 同步)。

### prove-red

Rust face 早退临时置 None + `cargo build -p kode-server`(必重编,TS 钉跑盘上二进制)→新面契约 7 例中 5 例正例恰红(直连/跨类不误绑/链式/self 方法/同域口径;2 例诚实 null 钉按定义不受断面影响)→恢复重编全绿。

### 坑清单(批 D 实录)

1. **裸名接收者形态歧义**:`row = repo.load()` 的 rhs_shape 把 Name 接收者一律归 Qualified{class:"repo"},但 "repo" 可能是变量非类——修=Qualified 臂唯一类名/方法原子先行,否则 Local 变量原子链回退(类名优先序钉死);流面与 local_return 面两处同修;
2. **Local 臂早退吞掉模块域回退**:`None => return` 跑在模块域回退之前,方法体裸名永远解不到模块级写点;修=method_found 先算再 or_else 模块回退,visited 键换 (method_start.unwrap_or(MAX), name);
3. **对拍锚点位移**:3 钉写点行号手数错(内联接收者 7 非 6/同类两方法 9,10 非 8,9/装饰器 7 非 6)——查询行按 AST 产物重数;
4. **TS 面全量重铸 blast radius**:查询消费面移交后 hover 装配曾整段 return 异步链,下游 TYP-ARRAY/数据字典/自属性面被 null 短路(18 文件 41 例红)——修=matchingAssignments 零候选预检闸(零成本跳过)+双 miss 重入下游(localReturnAttempted 防环),下游面同步原路不变;
5. **serving 轨道断言重铸**:python 文档「零请求直通 TS」前提随 localReturnType 腿失效——重铸为无调用候选零请求(预检闸)+调用候选恰一次请求零镜像;
6. **假绿二叉**:prove-red 必 `cargo build -p kode-server` 重编,TS 钉跑盘上二进制;
7. **fileKey 四斜杠**:测试手拼 `'file:///' + root`(root 已带前导 /)得 `file:////tmp/...` 与桶键错位——用 mock Uri.file().toString() 同源构键。
