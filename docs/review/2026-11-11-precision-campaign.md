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
