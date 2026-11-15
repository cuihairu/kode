# RUST-105 验收:类型出处面(declaration/definition/reference source span、root/version、生成映射)

日期:2026-11-16。验收对象:todo.md RUST-105(旧 SEM-003)「每个类型记录 deklaration/definition/reference/source span、原始 root/version、生成映射」。方法:逐名词映射到实现面 + 诚实边界 + prove-red 三靶。

## 1. 判据词 → 实现面映射(crates/kode-types/src/provenance.rs)

| 判据词 | 实现面 | 语义 |
|---|---|---|
| declaration span | `TypeOrigin{source: TypesXml/AliasXml, span: name_span, line}` 节点平行表 | types.xml/alias.xml 条目 = 声明出处,parser `name_span`(0 基字节区间)+ 1 基行 |
| definition span | `TypeOrigin{source: Def}` | 实体 .def = 定义出处;实体名来自文件名(`kode-index::def_entity_name` 同口径),正文无声明 site → span/line 如实 None(不虚构) |
| entities.xml 注册 | `entity_registrations: BTreeMap<名, TypeOrigin>` 侧表 | 注册面无节点(既有口径不变),注册出处(name_span/line/root/version)落侧表,同名先到先得;`classify` 口径不变 |
| reference span | `ref_sites: Vec<TypeRefSite{from, kind, name, span, line}>` | **锚统一 = 引用方声明的 name span**(六处:add_types 容器字段/数组元素/别名指向、add_alias 指向、add_def 属性/组件);Parent 无 span 如实 None |
| source span | 即上述 parser 来源 span | 全部为真实源文本区间,无生成物冒充 |
| 原始 root/version | `TypeOrigin.root/version` + `set_ingest(root, version)` 上下文 | 接线方灌入前供给(纯库面无自动来源);不透明字符串键 root + u64 version;`clear_ingest` 复位 |
| 生成映射 | `generation_links: BTreeMap<名, Vec<GenerationTarget{kind: PyiStub/EntityStub, path}>>` + `link_generation`/`generation_targets` | opt-in 注册表,构建器永不自动填充(生成管线现居 TS 侧 pythonTypeStubs/entityTypeStubs,Rust 消费待接线,如实登记) |

## 2. 关键语义保证

- **构建语义零改动**:全部为平行侧表/注册表;`push_node` 单隘口锁步盖章(`origins` 与 `nodes` 下标等长);既有 types_units 11+7 钉与 golden 字节全部原样(golden 序列化不触侧表,dump_bin/golden_shapes/golden_edges 实测绿);
- **绕过锁步防御读**:直接写 `nodes` 的形态(rpcargs 测试助手等)`origin_of` 防御性返 None,不虚构出处;
- **引用点锚的诚实边界**:解析器对 types.xml 内层 `<of>`/`<Type>` 文本与 alias 指向不暴露独立 span——锚统一落在引用方声明的 name span(引用点所在声明),不虚构引用文本自身 span(模块doc 显式登记);
- **消费面零编译破**:kode-server 全量 979 绿(semantics/rpcargs/golden 消费面不经侧表,零改动)。

## 3. 测试与 prove-red

- 新 `tests/provenance_units.rs` 6 例:`origin_stamped_with_ingest_context`(root/version/source/span/line 四入口盖章 + add_def 无 site 不虚构)/ `origin_lockstep_and_defensive_reads`(锁步+越界/缺位防御)/ `reference_sites_anchor_at_referencing_declaration`(三锚类 + Parent 无锚 + 按名过滤 + 灌入序)/ `entity_registration_first_wins_and_no_nodes`(先到先得+无节点+分类不变)/ `generation_links_are_opt_in_registry`(opt-in+登记序+不自动填充)/ `ingest_context_reset_leaves_source_site_intact`;
- prove-red 三靶(cp 备份 + cmp 字节还原):① 撤 `push_node` 的 origins 盖章 → 锁步钉红;② 撤 add_def 属性引用点登记 → reference_sites 钉红;③ 注册出处改后到覆盖(insert 替 or_insert)→ 先到先得钉红。

## 4. 门禁(2026-11-16 实跑)

clippy 六 crate `-D warnings` 0 / cargo test:kode-types 30 绿(24+6)、kode-server 979 绿、其余四 crate 329 绿 / rustfmt --check 本批文件 / pnpm lint 0 / pnpm compile 0 / vitest 10332+8skip 全绿 / xvfb demo 25 RC=0。

## 5. 结论

RUST-105 判据词全落:declaration/definition/reference/source span(nodes 平行表 + ref_sites + 注册侧表)、原始 root/version(ingest 上下文)、生成映射(opt-in 注册表待接线如实登记)。构建语义与消费面零改动。整行 `[x]` 勾账。
