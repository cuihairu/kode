# R2 索引字段清单

- 日期:2026-10-29 · 基线:`6b5eea0`(IDE-RST-002 收口后)
- 来源:todo IDE-RST-003;范围评审修正建议 2(「解析过同一份 XML」不表示索引已经具备派生计算所需的全部数据,docs/review/2026-10-27-rust-scope-review.md)
- 性质:逐字段列 Rust R2 已提供的**代码事实**(crates/kode-parser、kode-types、kode-index,落地证据 docs/kode2/pr-005/007/008.md);§4 把派生计算需要而索引没有的面标成【缺失】,这些**不得被当成现成输入**引用。
- 锁定:tests/rstR2IndexInventory.test.ts——SymbolIndex 公开方法清单与 `crates/kode-index/src/index.rs` 实际 `pub fn` 集合恰好相等;DefFile/PropertyDef/MethodDef/TypeDecl 字段逐名对账。crate API 漂移必须同笔改本页。

## 1. AST 面(kode-parser/xml.rs + diag.rs)

- 字节级 XML 状态机(非 quick-xml;仓库零第三方依赖铁律),保留源位置:`Span` 为**字节偏移**对(强于行级定位),`LineMap` 由原文换算 1 起行号;`.def` 解析带伪注释掩码(掩码不改长度,行号与原文一致)。
- 树形访问:`Document`(`root()/element()/child_elements()/child_element()/child_elements_named()/scalar_child_value()/truthy_child()`),节点 `Node`/`ElementData`(`attribute()/text()/first_text_token()`),属性 `Attribute`。
- 容错与留痕:未识别子标签/顶层段落保留(`extra_tags`/`extra_sections`,SYNTAX-005);诊断带 `DiagCode`+`Severity`+`Span`。
- 四语料入口:`parse_def`/`parse_entities`/`parse_types`/`parse_alias`,及从已解析 `Document` 二次提取的 `extract_def`/`extract_types`(共享一次解析)。

## 2. 语义模型面(kode-parser/model.rs + kode-types/graph.rs)

逐字段(字段名与 model.rs 定义一致):

- `DefFile`:root_tag parent interfaces volatile properties components base_methods cell_methods client_methods extra_sections diagnostics
- `PropertyDef`:name name_span line type_name type_refs flags_raw flags default_value detail_level database_length identifier persistent sensitive extra_tags(type_refs 与 TS collectTypeReferences 同口径;persistent truthy 语义同 TS)
- `MethodDef`:name name_span line args exposed——**仅保留这五个字段**(见 §4 缺失)
- `ComponentDef`:name name_span line component_type persistent
- `EntityEntry`:name name_span line attributes(hasBase/hasCell/hasClient 等,文档顺序;root 伪条目排除)
- `TypeDecl`:name name_span line kind(FixedDict|Array|Builtin) directive implemented_by_symbol field_refs element_ref
- `AliasDecl`:name name_span line alias_type(属性式别名另存 attribute_aliases,不进对拍 golden)
- `ChainNode`:entity parent(继承链节点;解析器 `resolve_parent_chain` 环时截断+诊断,不死循环)
- `TypeGraph`(kode-types,PR-008 类型图):装配 `add_types`/`add_alias`/`add_def`/`register_entities`;查询 `classify`(TypeClass)/`resolve_alias_chain`/`resolve_inheritance`/`find_cycles`;Alias/Array/FixedDict/UserType 节点+六种边,全图环检测,TS 类型面对拍 100%。

## 3. 公开索引接口面(kode-index/src/index.rs)

SymbolIndex 公开方法:new update update_batch remove invalidate_root generation lookup lookup_kind workspace_symbols symbols_in_file dependents_of entity_chain symbol_count tracked_files entity_declarations

- 出口符号 `Symbol`:id(SymbolId=arena 槽位号,删除后复用,**不得跨 generation 缓存**)/name/kind(Entity|Property|Method|Type|Alias|Component)/file(DocumentKey)/line(1 起;.def 实体本体约定 1)/facet(Base|Cell|Client)/detail;查询返回 owned 拷贝,不暴露内部 arena/倒排。
- 增量语义:文件级差量替换(replace_file:摘旧装新),`IndexUpdateReport`/`BatchReceipt` 计数;`generation()` 单调递增;`invalidate_root`/`remove` 按文件/根摘除。
- 六类符号索引+名称倒排+文件级增量+原子 generation(pr-007);继承链 `entity_chain`(pr-007 SEM 面);依赖反查 `dependents_of`。
- 消费示范:kode-server definition/hover/completion/diagnostics 四条响应链消费上述接口(golden 面已锁,pr-012 门 2 最小集)。

## 4. 缺失面(不得标为现成输入)

以下为派生计算需要而 R2 索引**当前不提供**的输入;引用本清单做迁移决策时,这些项按缺口计,不按现成计(对照范围评审「R2.5 模块边界核对」表):

- 【缺失】当前文档缓冲区/未保存内容:索引吃文本字符串,不含 VS Code 打开文档的脏缓冲区与版本(defAnalyzer 需要未保存缓冲区同步口径)。
- 【缺失】VS Code 配置:aliasIdEnabled、表名前缀、各功能开关、数据库配置均在 TS 配置面(messageTable/databaseSchema 消费)。
- 【缺失】消息编号规则与 def 树装配顺序:messageTable 需要;MethodDef 仅保留 name/name_span/line/args/exposed 五字段,无编号、无返回、无段落外信息。
- 【缺失】接口/组件/缺失文件标记在链出口的表达:TS defChain 结果含接口、组件、缺失文件标记及环截断信息;Rust `ChainNode` 只有 entity/parent,环诊断 Span 为 0,0(无文件位)。
- 【缺失】Python 语义:compositionRoots 需要 entities.xml+def+types.xml **加** Python 类/实例赋值;Python 面无 Rust 解析器(R1 §5 范围判断)。
- 【缺失】项目布局与文件存在性:entities.xml 域位、脚本文件存在性、外部 assetsRoot 关系(databaseSchema/entityFlow 需要;kode-root 只对齐了 TS discovery 的根发现)。
- 【缺失】运行期数据:空间/组件 socket 帧与回包(kbengineProtocol,与 def 语料无关)。
- 【缺失】模拟行状态与用户操作(databaseSimulator 除 schema 输入外的动态面)。

## 5. 引用口径

- 迁移决策(RST-004/005/006 及后续)引用本清单时:§1–§3 为现成输入,§4 为缺口输入;每项决策须自行补「含 IPC 的端到端耗时」与「未保存文档语义」两面(范围评审修正建议 1)。
- 本页只描述 R2 已落地代码;kode-python/kode-typings/kode-diagnostics/kode-runtime 等 Phase 4/6 crate 未落地(crates/README.md),不得按将来看待。
