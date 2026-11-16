# kode-parser 正式文法规范(SYNTAX-001/RUST-097)

- 状态:已发布(2026-11-17,RUST-097 收口件);实现正本:`crates/kode-parser/src/{xml,model,diag}.rs`
- 关联:ADR-102(选型裁决,`adr/ADR-102-parser-tech-choice.md`)、pr-005(解析器交付与对拍门禁)、pr-008(类型图语义面口径)
- 口径声明:本文只描述**实现实际所为**,每节带实现锚;实现变更而本文未同步=规范漂移,按 `tests/parser_units.rs` 为最终权威(单测即文档)。
- 四类文件:`.def`(实体定义)/ `entities.xml`(实体注册)/ `types.xml`(自定义类型)/ `alias.xml`(别名关联)。共用同一字节级 XML 状态机(`xml::parse`),各自有独立语义抽取层(`model.rs`)。

## 1. 通用词法层(字节级状态机)

实现:`xml.rs::Parser::run`(844 行,零第三方依赖,ADR-102)。

### 1.1 输入与坐标系

- 输入为**原始字节**(UTF-8 `&str`);所有 span 为 0 基字节区间 `[start,end)`(`diag::Span`),对原始文件逐字节成立。
- `.def` 解析先经伪注释掩码(§1.5);掩码不改字节长度,故掩码后文本上的 span 对原文件同样成立。行号经 `LineMap`(1 基,越界 clamp 到末行)。

### 1.2 构造识别(`<` 后分派)

| `<` 后字节 | 构造 | 节点 | 未闭合行为 |
|---|---|---|---|
| `!--` | 注释 | `Comment{span}` | 消费到 EOF + `kp-unterminated-comment` |
| `![CDATA[` | CDATA | `Cdata{span,decoded}`(不解实体) | 消费到 EOF + `kp-unterminated-cdata` |
| `!` 其他 | DOCTYPE 类声明 | `Declaration{span}`(只留 span) | 消费到 EOF + `kp-unterminated-comment`(码复用,消息区分) |
| `?` | 处理指令 | `ProcessingInstruction{span}` | 消费到 EOF + `kp-unterminated-pi` |
| `/` | 闭合标签 | (弹栈,§1.4) | — |
| 名字起始字节 | 开标签 | `Element`(§1.3) | EOF 容错收尾(§1.4) |
| 其他 | 非法 `<` | 无节点 | `kp-unexpected-lt`,`<` 字节被吞后照常继续 |

- 名字字节集:`is_name_start` = ASCII 字母/`_`/`:`;`is_name_char` 加 数字/`-`/`.`(XML 1.0 ASCII 子集;引擎四类文件不使用非 ASCII 标签名)。
- 文本:两个构造之间的字节段;**纯空白文本节点也保留**(与 TS fxp `trimValues:false` 同构,`first_text_token` 语义依赖);五个预定义实体(`amp/lt/gt/quot/apos`)与数字实体(`&#NN;`/`&#xHH;`)解码;未知实体保留原文字节 + `kp-invalid-entity`(Warning)。

### 1.3 开标签与属性

- 自闭合 `/>` 要求 `/` 紧邻 `>`;孤立的 `/` 按属性位垃圾容错(逐字节前进)。
- 属性:名字 `is_name_start` 起 `is_name_char` 续;值三种形态——双/单引号(可含实体解码)、**未加引号**(读到空白或 `>` 为止 + `kp-invalid-attribute` Warning,值照常取出)、缺 `=`(Error,值置空)。
- 重复属性:`kp-duplicate-attribute`(Warning),**保留首个**。
- 属性位垃圾:记 Error 后跳到空白/`>`/`/`(保证前进,不死循环)。
- **遗留多词标签容忍**(引擎历史格式):属性位出现「无 `=` 的裸词 + 紧跟 `>`」时,视作标签名延续(空格拼接进 `name`,如 `<Client Flags>`);语义层用规范化名匹配(§2.1)。

### 1.4 闭合配对与 EOF 收尾

- 闭合标签:名字后垃圾跳到 `>`;栈内**精确同名**优先;退化容忍——规范化名(§2.1)字符数 ≥3 时按「开标签规范化名以闭合规范化名为前缀」匹配遗留多词标签(`</Client>` 可闭合 `<Client Flags>`)。
- 命中后逐层弹出:被同名闭合层取精确 close span,中途被连带闭合层记 `kp-mismatched-close-tag`(容错收口,不丢树);栈内无匹配 → `kp-stray-close-tag`,该闭合标签被丢弃。
- EOF 时栈非空:逐层补 close span(空区间,起点=EOF),content 延伸到 EOF,记 `kp-unclosed-element`——**活编辑器中途不完整是常态,树前缀永不丢弃**。

### 1.5 `.def` 伪注释掩码

`mask_def_pseudo_comments`(`xml.rs:803`):行首(允许前导空白)`#` 开头的行整行替换为空格(换行保留,字节长度严格不变)。

- 只在**标签外**生效:状态机跟踪 `<`/引号,标签行内或属性值内的 `#` 不受影响;
- 已知限制(文档化于实现):CDATA 内部行首 `#` 同样被掩码——KBEngine 四类文件不使用 CDATA;若未来需要,掩码前先跑 CDATA 区间扫描。

## 2. 语义层:四类文件各自的抽取文法

实现:`model.rs`。原则:已知标签用**规范化名**匹配(§2.1),未知子标签/段落**保留不丢弃**(`extra_*`,SYNTAX-005 不因未知标签失败)。

### 2.1 规范化名(canonical_tag)

小写 + 去掉空格/`_`/`-`/`\t`(`model.rs:371`)。用途:容忍引擎历史拼写变体(`DetailLevel`/`Detaillevel`、`All Clients`/`ALL_CLIENTS`、`ClientFlags`/`Client Flags`)。对拍事实:fixture 语料全用规范拼写,故与 TS 侧精确名匹配结果一致(pr-005 对拍覆盖)。

### 2.2 `.def` 文法

根=首个顶层元素;顶层段落按规范化名分派(`model.rs:134 extract_def`):

| 规范名 | 产出 | 子文法 |
|---|---|---|
| `parent` | `parent: Option<String>` | trim 文本,空则不置 |
| `interfaces` | `interfaces: Vec<String>` | 条目标签必须 ∈ `{interface,Interface,type,Type}`(原文精确,引擎 `loadInterfaces` entitydef.cpp:561-585 口径,KR-AUD-88);接口名=条目**首个非注释子节点**:元素形态取元素名、文本/CDATA 形态取 trim 文本(xml.cpp:72-95/113-119 getKey 口径) |
| `volatile` | `volatile: bool` | truthy 语义(§2.6) |
| `properties` | `properties: Vec<PropertyDef>` | 见下 |
| `components` | `components: Vec<ComponentDef>` | 条目名=元素名;`Type` 子值直文本;`Persistent` truthy |
| `basemethods`/`cellmethods`/`clientmethods` | 三段 `Vec<MethodDef>` | 见下 |
| 其他 | `extra_sections`(名+span 保留) | — |

**PropertyDef 子标签**(规范化名):`type`(首文本 token=`type_name`;`type_refs`=`collect_type_refs` §2.7)、`flags`/`clientflags`(**遗留双标签合并**:两处 token 并集去重保序;`flags_raw` 以 `|` 连接原文)、`default`/`detaillevel`/`databaselength`/`identifier`(trim 文本,空不置)、`persistent`/`sensitive`(truthy;sensitive 累积 OR)、其他→`extra_tags`。

**MethodDef 子标签**:`arg`(trim 文本,空跳过;逐 Arg 附 `arg_type_refs` §2.7——指令独占 Arg 产出空 ref,如实)、`returntype`(规范化名同收 `ReturnType`/`Returntype` 遗留拼写;trim 文本,缺/空=None 如实)、`exposed`(truthy)、其他静默忽略。

**旗标 token 规范化**(`normalize_flag_tokens`,`model.rs:387`):`|` 分隔 → trim → 大写 → 引擎 `g_entityFlagMapping` 12 项表(entitydef.cpp:161-172)口径:8 规范名 `BASE/BASE_AND_CLIENT/CELL_PUBLIC/CELL_PRIVATE/ALL_CLIENTS/CELL_PUBLIC_AND_OWN/OWN_CLIENT/OTHER_CLIENTS`;4 旧式别名 `CELL→CELL_PUBLIC`、`CELL_AND_CLIENT→CELL_PUBLIC_AND_OWN`、`CELL_AND_CLIENTS→ALL_CLIENTS`、`CELL_AND_OTHER_CLIENTS→OTHER_CLIENTS`;其余**去分隔符折叠**(去空白/`_`/`-` 后与规范形去 `_` 对照,`ALL CLIENTS`→`ALLCLIENTS`→`ALL_CLIENTS`);未知 token 按原文大写保留,不悄悄丢弃。去重保序。

**三域位**(`flag_domains`):`BASE`→base;`BASE_AND_CLIENT`→base+client;`CELL_PUBLIC/CELL_PRIVATE`→cell;`ALL_CLIENTS/CELL_PUBLIC_AND_OWN`→cell+client;`OWN_CLIENT/OTHER_CLIENTS`→cell+client(KR-AUD-87:两旗标在 `ENTITY_CELL_DATA_FLAGS`,common.h:43,引擎按 hasCellFlags 注册进 cell map)。产出顺序恒 base,cell,client。

### 2.3 `entities.xml` 文法

根=首个顶层元素;其直接子元素=注册条目(`model.rs:507`):

- **`root` 伪条目排除**(与 TS getRegisteredEntities 同口径);
- 条目产出:名(元素名)+ name_span + 1 基行 + **属性表(文档顺序,原文值)**——`hasBase/hasCell/hasClient` 等不解释、不筛选,解释居消费面(semantics)。
- 不做伪注释掩码(伪注释是 `.def` 专属)。

### 2.4 `types.xml` 文法

根=首个顶层元素;其直接子元素=类型声明(`model.rs:578 extract_types`):

- **指引面**:首文本 token 为指引;**无文本指引时回落 `type` 属性值**(属性式条目 `<JSONDATA type="UINT32"/>`,PR-012 门 §1.3-① 口径,与 TS provider 注册面一致);指引为空=纯注释位,**不产出条目**(与 TS 一致)。
- **kind 判定**:`FIXED_DICT`→FixedDict;`ARRAY`→Array;其他非空→Builtin(重定向目标等记入 `directive`,PR-008 别名节点消费)。
- **FixedDict**:`implementedBy` 子值直文本 → 末段符号(`MODULE.Symbol`→`Symbol`);`Properties` 子元素逐条目 `Type` 子 → `collect_type_refs` → `field_refs`。
- **Array**:`<of>` 子文本 trim 为元素类型;属性式回落 `of` 属性值(`<X type="ARRAY" of="UINT32"/>`)。
- **Builtin**:无附加面。

### 2.5 `alias.xml` 文法

根=首个顶层元素;每条目按三元组判定(`model.rs:692`):

| Type 子元素 | 其他子元素 | 非空直文本 | 结果 |
|---|---|---|---|
| 有 | — | — | `alias_type`=Type 首个空白 token(空则字面 `ALIAS`) |
| 无 | 有 | — | `alias_type`=该子元素标签名 |
| 无 | 无 | 有 | `alias_type`=该文本 |
| 无 | 无 | 无 | 跳过;**有属性时结构化保留进 `attribute_aliases`**(TS 现实现跳过属性式,Rust 不丢;不进对拍 golden) |

### 2.6 truthy 语义

`truthy_child`(`xml.rs:149`):子元素存在时,自闭合=真;否则文本 trim 小写 ∈ `{"", "true", "1", "yes"}`=真(与 TS hasTruthyChildTag 同口径)。

### 2.7 类型引用收集(collect_type_refs)

`Type`/`Arg` 元素文本按空白切 token,剔除字面 `ARRAY`/`FIXED_DICT` 指令,再按文档顺序追加 `<of>` 子元素文本;顺序保留(`model.rs:350`;与 TS collectTypeReferences 同口径)。RUST-108 消费面(arg_type_refs/field_refs/type_refs 共用)。

### 2.8 继承链解析

`resolve_parent_chain`(`model.rs:774`):输入实体名→Parent 声明映射;`HashSet` 防环,**环时截断在重复点**并产出 `kp-inheritance-cycle`(语义层诊断,无文件内 span),绝不死循环(SEM-004/IDX-005 同类保障)。

## 3. 容错恢复语义与诊断码

铁律(实现头注):**任何坏输入不 panic、不中断、不丢已解析树前缀**;所有失败产出结构化诊断(码+级别+字节 span+消息)。

| 码 | 级别 | 触发 | 恢复行为 |
|---|---|---|---|
| `kp-unclosed-element` | Error | EOF 时栈非空 | 逐层补空 close span,树保留 |
| `kp-mismatched-close-tag` | Error | 闭合连带弹出中间层 | 中间层闭合收口,树保留 |
| `kp-stray-close-tag` | Error | 闭合无对应开标签 | 丢弃该闭合标签,树保留 |
| `kp-invalid-tag-name` | Error | 闭合标签缺名字 | 丢弃该闭合标签 |
| `kp-invalid-attribute` | Error/Warning | 属性位垃圾/缺 `=`/值未加引号 | 缺 `=`:值空;未引号:读到边界照常取值 |
| `kp-unterminated-attribute-value` | Error | 引号值未闭合/缺值 | 值取到 EOF/空 |
| `kp-unterminated-comment` | Error | `<!--` 缺 `-->`(含 `<!...>` 构造) | 消费到 EOF |
| `kp-unterminated-cdata` | Error | 缺 `]]>` | 消费到 EOF |
| `kp-unterminated-pi` | Error | 缺 `?>` | 消费到 EOF |
| `kp-invalid-entity` | Warning | 未知/残缺实体 | 保留原文字节 |
| `kp-duplicate-attribute` | Warning | 重复属性 | 保留首个 |
| `kp-unexpected-lt` | Error | `<` 后无合法构造 | 吞 `<` 字节继续 |
| `kp-skipped-garbage` | — | 预留(顶层垃圾跳过) | — |
| `kp-inheritance-cycle` | Error | 继承/别名链环(语义层) | 截断在重复点 |

## 4. 无效输入目录(invalid corpus)与门禁

RUST-097 要求的 invalid fixtures 以**确定性变异语料**形式落地(`tests/blind.rs`,QA-002 基础版;fuzz 纲要 proptest/arbitrary 随 fuzz 单后置,ADR-102 已声明):

1. **语料基座**:`PARITY_CORPORA` 四目录(`tests/fixtures/{kbengine-demo-assets,parity-project,electron-ws,kbengine-tpl-scripts}`)全部 `.def`+三类 XML,断言 ≥20 文件(`json.rs::collect_corpus`,排序遍历确定性);
2. **变异四臂**(LCG 固定种子 `0xDEF1_5EED`,CI 可复现,每语料 60 轮):截断/随机字节翻转(1-8 字节)/随机插入(1-4 个,池=`<>""#&\n`/0xFF)/随机删除(1-6 字节);非 UTF-8 中间态跳过(字节层截断轮覆盖);
3. **断言面**:变异体过全部五个解析入口(裸 xml+def+entities+types+alias),诊断 span 在界内、非空消息、非空码;盲样量 `>500` 断言(实测量随语料增长,ADR-102 时点记录 1149 例 0 panic);
4. **截断专项**(`blind_truncations_keep_prefix_tree`):截断点吸附 UTF-8 字符边界(模拟真实文件截断读取),断言前缀树不丢(首开标签闭合后根元素必在)。

### 对拍 golden 门禁

- `crates/kode-parser/tests/golden/def-parity.json`(+config 两族):fixture 驱动双向门禁,TS↔Rust 逐字段一致(pr-005「对拍 golden 双向门禁」节);
- 语义面口径对拍:pr-008(decls/aliases/composition/entities 抽取规则);`fixtures_golden.rs` 全绿=抽取口径零漂移;
- RUST-108 两字段(`arg_type_refs`/`return_type`)**刻意不进** parser golden(TypeDecl.directive 先例):parity JSON `{name,args,exposed,line}` 面零扰动。

### 测试锚点(单测即文档)

| 文件 | 面 |
|---|---|
| `tests/parser_units.rs`(641 行) | 字节 span 精确性/属性双 span/伪注释掩码长度不变+标签内 `#` 不动/实体解码/未知实体/截断恢复不丢树 |
| `tests/blind.rs` | §4 变异语料全部 |
| `tests/fixtures_golden.rs` | 语义抽取对拍 golden |
| `tests/incremental.rs` | 指纹命中零重建/文本真变必重建 |
| `tests/method_meta_units.rs` | RUST-108 方法元数据(return_type 提取/遗留拼写/逐 Arg refs 三形态) |
| `tests/{config_units,config_derive_units,config_merge_units,config_resolve_units}.rs` | KSEM-CFG 配置文件族(独立车道,本文不覆盖) |

## 5. 已知边界(如实)

- 通用 XML 能力不设目标:无命名空间/DTD 校验语义(ADR-102「后果」节);
- 标签名字节集为 ASCII 子集(§1.2);非 ASCII 标签按构造外字节走文本/容错路径;
- 伪注释掩码的 CDATA 限制(§1.5);
- fuzz 纲要未接,现有保障=确定性盲样(§4);
- 文中行为以 `crates/kode-parser` 当前实现为准;实现变更须同步本文,锚点漂移由 `parser_units.rs` 断言兜底。
