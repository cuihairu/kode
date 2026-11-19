# RUST-138 批 2:References 语义分类面(真实引用=类型 IR 可证)

日期:2026-11-19
todo.md 行:`RUST-138(旧 LSP-005)References:跨 root 实体/方法/组件/类型,区分语法同名和真实语义引用。`
本批边界:**语义分类面 + 语义过滤面**(批 1 语料引用位之上,跨 root/跨 tree 同名站点三分:真实语义引用 / 语法同名 / 悬挂)。entityMapping 运行时半边(python 键族)与 `textDocument/references` LSP 接线留批 3+(本批零接 server.rs,纯库不变)。

## 架构

- `references.rs` 查询核重构(行为零变化):批 1 `def_references/types_references` 的解析臂提取为 `def_reference_query/types_reference_query`(产物 = target + declaration + sites),位置面与批 2 语义面同饮一核;位置面响应字节不变(golden references-parity.json 未动,批 1 TS 镜像 3 例照绿)。
- **三分类语义模型**(引擎事实:types.xml/实体表是 per-asset-tree IR,跨 root 名字解析互相独立):
  - `Semantic`:站点自身解析域内声明 == 查询声明(同一 IR 节点)——真实语义引用;
  - `Shadow`:站点域内解析到**不同**声明(别 root 的同名 types 声明/同名实体 def/同名接口 def)——语法同名;
  - `Dangling`:站点域内不可解析——语法同名且悬挂。
  - 解析域按**站点自身路径**定(`name_decl_path_at`:Type=同根 types 字典序首见声明,无则实体 def;Parent=实体 def;Interface=接口 def;None=不猜)。域走查 defs_root 逐路径,同根多 entity_defs 树互不串(单测钉:同 root 两树各自 interfaces/ROLE.def,跨树站点判 Shadow 而非靠 root 相等短路)。
- 新公开面(均纯库):
  - `classified_references(key, text, line0, character)` → (target, Vec&lt;ClassifiedSite&gt;)——逐站点分类,证据=站点域命中声明路径,Dangling 无证据;
  - `semantic_reference_locations(..., include_declaration)` → 只留 Semantic 的 Location 列表(def 面声明先行+dedup 同位置面;types 面无声明不 dedup 同位置面;空结果 None)。
- golden 第二面:`crates/kode-server/tests/golden/references-semantic-parity.json`(批 1 同探针集;30 files / 13 entries / 88 probes / 25 sites;classCounts = semantic 23 + shadow 2,dangling 0——语料自洽无悬挂,悬挂臂由合成单测钉闭环)。**shadow 2 = 真分布**:demo↔parity 双语料各持己 Avatar/Monster 声明,parity Monster.def `<Parent>Avatar</Parent>` 与 demo Monster.def 对查互判 Shadow。生成器 `dump-references-semantic-golden`;条目判据 = 站点非空(probe_count 记全集探针,审计口径)。

## TS 镜像

`tests/kodeReferencesSemanticParity.test.ts`(自足复算,不改 src/,4 例):
1. 语料同集(文件序一致);
2. 逐文件逐探针逐站点 deep-equal + referenceCount/probeCount 全集对账——分类按同链(`nameDeclPathAt`:types-then-entity/parent/interface)独立重推,不读 Rust 结果;
3. 分类计数守恒(classCounts 非零键与逐站点重数一致)+ 跨语料同名真分布在场(semantic>0 && shadow>0,分类面退化成恒 semantic 会红);
4. 护栏:站点与证据声明路径都不出语料,Dangling 无证据。
坑账:golden `class_counts` 是惰性 BTreeMap(零计数键不入档),TS 复算首版把 `dangling:0` 也计入 → 对拍红;两侧统一只比非零键。

## prove-red(三靶闭环,cp+cmp 还原复绿)

- T1(Rust):`classify_sites` 恒返 Semantic → `shadow_site_when_cross_root_has_own_decl` 红 + semantic golden 重生成比对红(committed 含 shadow 条目);
- T2(Rust):`semantic_only_sites` 过滤臂摘除 → `semantic_filter_keeps_same_decl_sites_only` 红(Shadow 站点涌入过滤面);
- T3(TS):镜像分类翻转(semantic↔shadow 交换)→ 逐站点 deep-equal 红 1 例。
- 还原后 grep 钉在(`d == q` / `filter(|c| c.semantic == SemanticClass::Semantic)` / `'semantic' as const`)+ cmp 字节一致。

## 单元钉(合成语料,批 2 新增 8 例,references 合计 29)

1. `shadow_site_when_cross_root_has_own_decl`——proj-b 有己声明:站点 Shadow + 证据=proj-b types.xml;同 root 站点 Semantic + 证据=查询声明;
2. `dangling_site_when_cross_root_cannot_resolve`——proj-b 无 types 无同名实体:Dangling + 无证据;
3. `semantic_filter_keeps_same_decl_sites_only`——过滤面 exclude Shadow;含声明时 decl 先行;全量位置面比过滤面多 1 位(三面差账);
4. `interface_missing_decl_sites_dangle`——接口 def 缺失(批 1 位置面照列先例):语义面如实 Dangling,过滤面全空 → None;
5. `interface_shadow_across_trees_in_same_root`——同 root 两 entity_defs 树各自 ROLE.def:跨树站点 Shadow(域按站点路径,不靠 root 相等);
6. `types_xml_face_classifies_cross_root_shadow`——types.xml 查询面同分类口径;
7. `classified_face_absent_for_non_corpus_kinds`——entities.xml 无面(与位置面同闸);
8. `root_removal_drops_stale_sites_and_keeps_query_domain`(RUST-149 横切)——`invalidate_root(proj-b)` 后陈旧站点整个消失(不虚报 Shadow/Dangling),查询域分类与证据不变。首版钉误设「降级为 Dangling」红——撤根语义是 corpus 扇出摘除(站点不再被扫到),修正期望后绿;stale/cancel/cold 维度对本面 N-A(同步纯函数零 await/RPC),root 维度由本钉闭环。

## golden 结构完整性(2 例)

重生成比对 + 审计:probe_count ≥ reference_count;classCounts 三项之和 == siteCount;semantic>0 && shadow>0(区分度真分布钉);站点键形(uri/line/start/end + semantic ∈ 三值);Dangling 无证据 / Semantic·Shadow 必带证据路径。

## 门禁

- `cargo test -p kode-server`(全 crate 套件)0 failed;references 单元 29/29;references_golden + references_semantic_golden 4/4;
- `cargo clippy -p kode-server --all-targets` 0(初跑 2 错:GoldenTarget 生命周期悬空 / SemanticClass 缺 Ord,修后 0;另 RefKind/RefTarget 提 pub 消 private_interfaces);
- vitest:kodeReferencesSemanticParity 4 + kodeReferencesParity(批 1 回归)3 = 7/7;
- tsc:`tsconfig.json` 0(tests/ 在 exclude=既有口径,本批零 src/ 改动)。

## 余账(批 3+)

- entityMapping 运行时引用半边(python 键族:属性 self 访问/方法段实现/receiver 调用/数据字典键)——Rust 侧需 python 扫描面接线,留批 3;
- `textDocument/references` LSP 接线(server.rs/rpc.rs)——本批只落纯库,接线时产品面可切 `semantic_reference_locations`(跨 root 同名不再污染 Shift+F12)或保持位置面+分类注记,归用户拍板;
- TS 生产面(provideDefSymbolReferences)切换 Rust 薄壳——随接线批。
