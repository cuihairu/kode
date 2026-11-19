//! WorkspaceSymbol 快速搜索决策核(RUST-139 批 2;TS
//! EntityMappingManager.searchDefSymbolsByPrefix + collectProperty/
//! collectMethodDefinitions 决策链同构下沉)。
//!
//! 批 1 DocumentSymbol(7947d7dc document_symbols.rs)之上,符号检索半边:
//! root 集 = 语料 entity 类 def(TS mappingIndexesByRoot 同口径——接口/组件
//! def 不单独建索引,经 ownerName 回溯);逐 root 走 effective 折叠闭包
//! (own → interfaces → parent 链,first-wins 去重)产出 properties/
//! methods 命中,组件槽走独立槽面(local + parent 链 Components 段,槽名
//! 去重,槽内再走组件自身折叠闭包——TS collectMethodDefinitions 组件臂
//! 同构)。前缀过滤大小写不敏感 + trim(TS needle 同口径),排序
//! rootName → symbolName → line(语料全 ASCII,字节序=locale 序)。
//!
//! 诚实边界(登记,不冒充):TS effectivePropertyKey =
//! `fullPath::sortedFlagDomains`,本面按 `name + 排序旗标` 同构去重;
//! TS pushProperty 递归 children/arrayElement(嵌套 FIXED_DICT 子项/数组
//! 元素独立符号),kode-parser PropertyDef 是顶层模型无嵌套字段——嵌套
//! 符号面归 parser 模型扩展批。TS rootName 来自 entities.xml 实体名,本面
//! 取 def basename(语料两值恒同;异名登记册场景归接线批)。
//!
//! LSP 接线(textDocument/workspaceSymbol server.rs/rpc.rs)留接线批,
//! 本批零接 server.rs 纯库不变。

use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;

use crate::hover::{Category, HoverEngine, category_of};

/// 三段取数器(DefFile 字段直读)。
type SectionMethods = fn(&kode_parser::model::DefFile) -> &Vec<kode_parser::model::MethodDef>;

/// 三段顺序与收集序一致(kode-parser DefFile 字段序;TS
/// DEF_METHOD_SECTIONS 同序)。
const METHOD_SECTIONS: &[(&str, SectionMethods)] = &[
    ("BaseMethods", |d| &d.base_methods),
    ("CellMethods", |d| &d.cell_methods),
    ("ClientMethods", |d| &d.client_methods),
];

/// 检索命中(TS WorkspaceDefSymbolHit 同构;搜索面不携带槽名/旗标——
/// provider containerName 用 rootName·section,identity 细节只在跳转面)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSymbolHit {
    pub symbol_name: String,
    /// "property" | "method"。
    pub kind: &'static str,
    /// 仅 method 在场;TS hit.section 同口径(property 无段)。
    pub section: Option<&'static str>,
    pub root_name: String,
    pub root_def_file: String,
    /// 声明落点(接口/父类/组件 def;TS hit.defFile = identity 落点)。
    pub def_file: String,
    /// 1-based 声明行(defParser/LineMap 同口径)。
    pub line: u32,
}

impl HoverEngine {
    /// 语料 entity 类 def 全集即 root 集(路径序确定性;TS root 发现序在
    /// 最终排序后被归一,镜像与 golden 均以路径序迭代)。
    pub(crate) fn workspace_symbol_roots(&self) -> Vec<(String, String)> {
        let mut roots = Vec::new();
        for path in self.corpus_defs.iter() {
            let Some(defs_root) = self.defs_root(path) else {
                continue;
            };
            if category_of(&defs_root, path) != Category::Entity {
                continue;
            }
            let base = &path[path.rfind('/').map(|i| i + 1).unwrap_or(0)..];
            let name = base.strip_suffix(".def").unwrap_or(base);
            roots.push((name.to_string(), path.clone()));
        }
        roots
    }

    /// 宿主链上的组件槽(local + parent 链 Components 段,槽名小写去重
    /// first-wins——TS semantics.components 折叠同口径;接口 def 不产槽)。
    pub(crate) fn component_slot_defs(&self, root_def: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut seen_slots = BTreeSet::new();
        for node in self.parent_chain_paths(root_def) {
            let Some(cdef) = self.corpus_def(&node) else {
                break;
            };
            let Some(defs_root) = self.defs_root(&node) else {
                continue;
            };
            for comp in &cdef.components {
                let Some(component_type) = &comp.component_type else {
                    continue;
                };
                if !seen_slots.insert(comp.name.to_lowercase()) {
                    continue;
                }
                let candidate = format!("{defs_root}/components/{component_type}.def");
                if self.corpus_defs.contains(&candidate) {
                    out.push((comp.name.clone(), candidate));
                }
            }
        }
        out
    }

    /// 前缀检索(快速搜索决策核)。空前缀 = 全集;needle trim + 小写,
    /// 符号名 toLowerCase().startsWith(needle)(TS 同口径)。
    pub fn workspace_symbols_by_prefix(&self, prefix: &str) -> Vec<WorkspaceSymbolHit> {
        let needle = prefix.trim().to_lowercase();
        let mut hits = Vec::new();
        for (root_name, root_def) in self.workspace_symbol_roots() {
            self.push_fold_hits(&mut hits, &root_name, &root_def, &root_def, &needle);
            for (_slot, comp_path) in self.component_slot_defs(&root_def) {
                self.push_fold_hits(&mut hits, &root_name, &root_def, &comp_path, &needle);
            }
        }
        hits.sort_by(|a, b| {
            a.root_name
                .cmp(&b.root_name)
                .then_with(|| a.symbol_name.cmp(&b.symbol_name))
                .then_with(|| a.line.cmp(&b.line))
        });
        hits
    }

    /// 一次折叠闭包(first-wins 去重按 `name + 排序旗标`/`段+name`)的
    /// 命中入列。属性键 TS effectivePropertyKey(`fullPath::sortedFlagDomains`)
    /// 同构——语料顶层 fullPath=name;方法键 = 段 + 方法名(TS
    /// effectiveMethodMaps 同构)。去重发生在前缀过滤之前(先折叠后过滤,
    /// 两者对同名符号等价)。
    fn push_fold_hits(
        &self,
        hits: &mut Vec<WorkspaceSymbolHit>,
        root_name: &str,
        root_def: &str,
        start_def: &str,
        needle: &str,
    ) {
        let mut seen_props = BTreeSet::new();
        let mut seen_methods = BTreeSet::new();
        for path in self.def_fold_paths(start_def) {
            let Some(cdef) = self.corpus_def(&path) else {
                break;
            };
            for prop in &cdef.properties {
                let mut domains = prop.flags.clone();
                domains.sort();
                let key = format!("{}\u{1}{}", prop.name, domains.join("\u{2}"));
                if !seen_props.insert(key) {
                    continue;
                }
                if !symbol_matches_prefix(&prop.name, needle) {
                    continue;
                }
                hits.push(WorkspaceSymbolHit {
                    symbol_name: prop.name.clone(),
                    kind: "property",
                    section: None,
                    root_name: root_name.to_string(),
                    root_def_file: root_def.to_string(),
                    def_file: path.clone(),
                    line: prop.line as u32,
                });
            }
            for (section, methods) in METHOD_SECTIONS {
                for method in (methods)(cdef) {
                    let key = format!("{section}\u{1}{}", method.name);
                    if !seen_methods.insert(key) {
                        continue;
                    }
                    if !symbol_matches_prefix(&method.name, needle) {
                        continue;
                    }
                    hits.push(WorkspaceSymbolHit {
                        symbol_name: method.name.clone(),
                        kind: "method",
                        section: Some(section),
                        root_name: root_name.to_string(),
                        root_def_file: root_def.to_string(),
                        def_file: path.clone(),
                        line: method.line as u32,
                    });
                }
            }
        }
    }
}

/// needle 为空恒真;否则符号名小写 startsWith(TS 大小写不敏感同口径)。
fn symbol_matches_prefix(symbol_name: &str, needle: &str) -> bool {
    needle.is_empty() || symbol_name.to_lowercase().starts_with(needle)
}

// ---------------------------------------------------------------------------
// golden 第三面(确定性探针:符号名全集派生前缀 + 负例 + 全集空前缀)
// ---------------------------------------------------------------------------

pub const WORKSPACE_SYMBOLS_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/workspace-symbols-parity.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump<'a> {
    generator: &'a str,
    /// entity root 数(接口/组件 def 不入)。
    root_count: usize,
    /// 全集去重符号名数。
    symbol_count: usize,
    probe_count: usize,
    hit_count: usize,
    /// 空前缀命中数(全集)。
    universe_count: usize,
    probes: Vec<GoldenProbe>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenProbe {
    prefix: String,
    hits: Vec<WorkspaceSymbolHit>,
}

/// 取 UTF-8 前两字符(语料符号名 ASCII;非 ASCII 走逐字符切分)。
fn first_two_chars(name: &str) -> Option<String> {
    let mut chars = name.chars();
    let first = chars.next()?;
    let second = chars.next()?;
    Some(format!("{first}{second}"))
}

/// 探针集(确定性派生,不另起探测面):
/// - 每个全集符号名原形(精确命中臂);
/// - 每个符号名小写前两字符(截断前缀臂);
/// - 每个符号名原形前两字符(大小写折叠臂:大写 needle 命中小写符号);
/// - 负例 "zz"/"qq"(语料恒空命中,防全绿退化);
/// - 空前缀一次(全集)。
fn derive_probes(universe: &[WorkspaceSymbolHit]) -> Vec<String> {
    let mut names: BTreeSet<&str> = BTreeSet::new();
    for hit in universe {
        names.insert(&hit.symbol_name);
    }
    let mut probes = BTreeSet::new();
    probes.insert(String::new());
    probes.insert("zz".to_string());
    probes.insert("qq".to_string());
    for name in names {
        probes.insert(name.to_string());
        if let Some(head) = first_two_chars(name) {
            probes.insert(head.to_lowercase());
            probes.insert(head);
        }
    }
    probes.into_iter().collect()
}

pub fn dump_workspace_symbols_golden(repo_root: &Path) -> String {
    use kode_parser::json::{PARITY_CORPORA, collect_corpus};

    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let registry = crate::golden_corpus::corpus_registry();
    let mut engine = HoverEngine::new();
    for (path, (_kind, text)) in &files {
        engine.update(crate::golden_corpus::corpus_key(&registry, path), text);
    }
    let universe = engine.workspace_symbols_by_prefix("");
    let symbol_count = universe
        .iter()
        .map(|hit| hit.symbol_name.as_str())
        .collect::<BTreeSet<_>>()
        .len();
    let prefixes = derive_probes(&universe);
    let mut dump = GoldenDump {
        generator: "kode-server dump-workspace-symbols-golden",
        root_count: engine.workspace_symbol_roots().len(),
        symbol_count,
        probe_count: prefixes.len(),
        hit_count: 0,
        universe_count: universe.len(),
        probes: Vec::new(),
    };
    for prefix in &prefixes {
        let hits = if prefix.is_empty() {
            universe.clone()
        } else {
            engine.workspace_symbols_by_prefix(prefix)
        };
        dump.hit_count += hits.len();
        dump.probes.push(GoldenProbe {
            prefix: prefix.clone(),
            hits,
        });
    }
    serde_json::to_string_pretty(&dump).expect("golden JSON")
}

// ---------------------------------------------------------------------------
// 单元钉(合成语料;RUST-149 横切见尾两钉)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use kode_vfs::store::{DocumentKey, RootRegistry};
    use kode_vfs::uri::CanonicalUri;

    use super::*;

    fn registry() -> RootRegistry {
        let mut registry = RootRegistry::new();
        registry.register("/proj-a");
        registry.register("/proj-b");
        registry
    }

    fn key_for(registry: &RootRegistry, path: &str) -> DocumentKey {
        let uri = CanonicalUri::from_path(path);
        DocumentKey::new(registry.root_for(&uri), uri)
    }

    const A_ENTITIES: &str =
        "<root>\n  <Avatar> scripts/entity_defs/Avatar.def </Avatar>\n</root>\n";
    /// 宿主:own 属性 hp/level、三段方法(同名跨段去重臂)、接口折入、
    /// 组件槽、父类供 Monster 覆盖。
    const A_AVATAR: &str = "<root>\n\
        \x20 <Properties>\n\
        \x20   <hp>\n        <Type> UINT32 </Type>\n      </hp>\n\
        \x20   <level>\n        <Type> UINT8 </Type>\n      </level>\n\
        \x20   <shared>\n        <Type> INT8 </Type>\n      </shared>\n\
        \x20   <parentOnly>\n        <Type> STRING </Type>\n      </parentOnly>\n\
        \x20 </Properties>\n\
        \x20 <Interfaces>\n    <interface> ROLE </interface>\n  </Interfaces>\n\
        \x20 <Components>\n\
        \x20   <Turret>\n        <Type> Turret </Type>\n      </Turret>\n\
        \x20 </Components>\n\
        \x20 <BaseMethods>\n    <onTalk>\n      <Arg> STRING </Arg>\n    </onTalk>\n  </BaseMethods>\n\
        \x20 <CellMethods>\n    <onTalk>\n      <Arg> UINT32 </Arg>\n    </onTalk>\n    <onMove>\n      <Exposed>true</Exposed>\n    </onMove>\n  </CellMethods>\n\
        \x20 <ClientMethods>\n    <onUi>\n      <Arg> FLOAT </Arg>\n    </onUi>\n  </ClientMethods>\n\
        </root>\n";
    /// 父类独有声明由 Avatar.def 承载(parentOnly;见 A_AVATAR)。    /// 接口:shared(压父类同名)/roleExtra;接口不跟随 Parent(A_PAIRED
    /// 的 Parent 不折)。
    const A_ROLE: &str = "<root>\n\
        \x20 <Properties>\n\
        \x20   <shared>\n        <Type> INT32 </Type>\n      </shared>\n\
        \x20   <roleExtra>\n        <Type> STRING </Type>\n      </roleExtra>\n\
        \x20 </Properties>\n\
        \x20 <BaseMethods>\n    <onRoleRpc>\n      <Arg> UINT32 </Arg>\n    </onRoleRpc>\n  </BaseMethods>\n\
        </root>\n";
    /// 接口+父类混合实体:接口 shared 压父类 shared(折叠序臂)。
    const A_MIXED: &str = "<root>\n\
        \x20 <Parent> Avatar </Parent>\n\
        \x20 <Interfaces>\n    <interface> ROLE </interface>\n  </Interfaces>\n\
        </root>\n";
    /// 子类:hp 覆盖父类。
    const A_MONSTER: &str = "<root>\n\
        \x20 <Parent> Avatar </Parent>\n\
        \x20 <Properties>\n\
        \x20   <hp>\n        <Type> UINT16 </Type>\n      </hp>\n\
        \x20 </Properties>\n\
        </root>\n";
    /// 组件与父组件(槽内折叠闭包臂)。
    const A_TURRET: &str = "<root>\n\
        \x20 <Parent> BaseTurret </Parent>\n\
        \x20 <Properties>\n\
        \x20   <cooldown>\n        <Type> UINT32 </Type>\n      </cooldown>\n\
        \x20 </Properties>\n\
        \x20 <BaseMethods>\n    <onFire>\n      <Arg> UINT8 </Arg>\n    </onFire>\n  </BaseMethods>\n\
        </root>\n";
    const A_BASE_TURRET: &str = "<root>\n\
        \x20 <Properties>\n\
        \x20   <range>\n        <Type> FLOAT </Type>\n      </range>\n\
        \x20 </Properties>\n\
        </root>\n";
    /// 跨 root 同名实体(root 隔离臂)。
    const B_ENTITIES: &str =
        "<root>\n  <Avatar> scripts/entity_defs/Avatar.def </Avatar>\n</root>\n";
    const B_AVATAR: &str = "<root>\n\
        \x20 <Properties>\n\
        \x20   <hp>\n        <Type> UINT64 </Type>\n      </hp>\n\
        \x20 </Properties>\n\
        </root>\n";

    fn build() -> (RootRegistry, HoverEngine) {
        let registry = registry();
        let mut engine = HoverEngine::new();
        for (path, text) in [
            ("/proj-a/scripts/entities.xml", A_ENTITIES),
            ("/proj-a/scripts/entity_defs/Avatar.def", A_AVATAR),
            ("/proj-a/scripts/entity_defs/Monster.def", A_MONSTER),
            ("/proj-a/scripts/entity_defs/Mixed.def", A_MIXED),
            ("/proj-a/scripts/entity_defs/interfaces/ROLE.def", A_ROLE),
            (
                "/proj-a/scripts/entity_defs/components/Turret.def",
                A_TURRET,
            ),
            (
                "/proj-a/scripts/entity_defs/components/BaseTurret.def",
                A_BASE_TURRET,
            ),
            ("/proj-b/scripts/entities.xml", B_ENTITIES),
            ("/proj-b/scripts/entity_defs/Avatar.def", B_AVATAR),
        ] {
            engine.update(key_for(&registry, path), text);
        }
        (registry, engine)
    }

    fn files_of(hits: &[WorkspaceSymbolHit]) -> Vec<&str> {
        hits.iter().map(|hit| hit.def_file.as_str()).collect()
    }

    /// effective 折叠序:own 压接口/父类(hp 在 Monster root 落 Monster.def,
    /// 在 Avatar root 落 Avatar.def);接口压父类(Mixed 的 shared 落
    /// ROLE.def 而非 Avatar.def);父类独有折入(parentOnly)。
    #[test]
    fn fold_order_first_wins_matches_ts_effective_sets() {
        let (_registry, engine) = build();
        let monster_hp = engine
            .workspace_symbols_by_prefix("hp")
            .into_iter()
            .filter(|hit| hit.root_name == "Monster")
            .collect::<Vec<_>>();
        assert_eq!(
            files_of(&monster_hp),
            vec!["/proj-a/scripts/entity_defs/Monster.def"]
        );
        let mixed_shared = engine
            .workspace_symbols_by_prefix("shared")
            .into_iter()
            .filter(|hit| hit.root_name == "Mixed")
            .collect::<Vec<_>>();
        assert_eq!(
            files_of(&mixed_shared),
            vec!["/proj-a/scripts/entity_defs/interfaces/ROLE.def"],
            "接口声明压父类同名(折叠序 own > interfaces > parent)"
        );
        let parent_only = engine
            .workspace_symbols_by_prefix("parentOnly")
            .into_iter()
            .filter(|hit| hit.root_name == "Mixed")
            .collect::<Vec<_>>();
        assert_eq!(
            files_of(&parent_only),
            vec!["/proj-a/scripts/entity_defs/Avatar.def"],
            "父类独有声明折入"
        );
    }

    /// 方法段去重键 = 段 + 名:跨段同名各自成 hit,同段同名 first-wins
    /// (Avatar onTalk Base/Cell 双 hit;Monster 的 Base onTalk 仍落
    /// Avatar.def——Monster 未覆盖方法)。
    #[test]
    fn method_dedupe_is_per_section() {
        let (_registry, engine) = build();
        let avatar_talk = engine
            .workspace_symbols_by_prefix("onTalk")
            .into_iter()
            .filter(|hit| hit.root_name == "Avatar")
            .collect::<Vec<_>>();
        assert_eq!(avatar_talk.len(), 2, "Base/Cell 双段各自在场");
        assert_eq!(avatar_talk[0].section, Some("BaseMethods"));
        assert_eq!(avatar_talk[1].section, Some("CellMethods"));
        let monster_talk = engine
            .workspace_symbols_by_prefix("onTalk")
            .into_iter()
            .filter(|hit| hit.root_name == "Monster")
            .collect::<Vec<_>>();
        assert_eq!(
            files_of(&monster_talk)[0],
            "/proj-a/scripts/entity_defs/Avatar.def"
        );
    }

    /// 组件槽独立面:槽内声明入 hit(落点=组件 def),槽内折叠闭包
    /// (Turret Parent BaseTurret → range 折入);宿主 effective 面
    /// 不吞组件声明(去重键不跨槽面)。
    #[test]
    fn component_slot_entries_emit_with_slot_closure() {
        let (_registry, engine) = build();
        let fire = engine
            .workspace_symbols_by_prefix("onFire")
            .into_iter()
            .filter(|hit| hit.root_name == "Avatar")
            .collect::<Vec<_>>();
        assert_eq!(
            files_of(&fire),
            vec!["/proj-a/scripts/entity_defs/components/Turret.def"]
        );
        assert_eq!(fire[0].section, Some("BaseMethods"));
        let range = engine
            .workspace_symbols_by_prefix("range")
            .into_iter()
            .filter(|hit| hit.root_name == "Avatar")
            .collect::<Vec<_>>();
        assert_eq!(
            files_of(&range),
            vec!["/proj-a/scripts/entity_defs/components/BaseTurret.def"],
            "槽内 Parent 链折叠"
        );
    }

    /// root 集 = entity 类 def:接口/组件 def 不是 root(ROLE/Turret 只经
    /// 实体闭包出现);跨 root 同名实体各自成 root 且互不吞(hit 归属
    /// root_name)。
    #[test]
    fn roots_are_entity_defs_only() {
        let (_registry, engine) = build();
        assert_eq!(
            engine
                .workspace_symbol_roots()
                .iter()
                .map(|(name, path)| (name.as_str(), path.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("Avatar", "/proj-a/scripts/entity_defs/Avatar.def"),
                ("Mixed", "/proj-a/scripts/entity_defs/Mixed.def"),
                ("Monster", "/proj-a/scripts/entity_defs/Monster.def"),
                ("Avatar", "/proj-b/scripts/entity_defs/Avatar.def"),
            ],
            "接口/组件 def 不建索引;跨 root 同名各自成 root(路径序)"
        );
        for hit in engine.workspace_symbols_by_prefix("") {
            assert!(
                !hit.root_def_file.contains("/interfaces/")
                    && !hit.root_def_file.contains("/components/"),
                "root 恒实体 def"
            );
        }
    }

    /// 前缀口径:trim + 大小写不敏感(TS needle 同构);空前缀=全集。
    #[test]
    fn prefix_filter_trims_and_folds_case() {
        let (_registry, engine) = build();
        let universe = engine.workspace_symbols_by_prefix("");
        let padded = engine.workspace_symbols_by_prefix("  ONTA  ");
        // Avatar/Mixed/Monster 三 root(后两者经父链折入)× Base/Cell 双段。
        assert_eq!(padded.len(), 6, "trim + 大写 needle 命中小写符号");
        assert_eq!(padded[0].symbol_name, "onTalk");
        assert_eq!(padded[0].section, Some("BaseMethods"));
        assert_eq!(engine.workspace_symbols_by_prefix("onta").len(), 6);
        assert_eq!(
            engine.workspace_symbols_by_prefix("zz"),
            Vec::<WorkspaceSymbolHit>::new()
        );
        for probe in ["", " ", "\t"] {
            assert_eq!(
                engine.workspace_symbols_by_prefix(probe).len(),
                universe.len()
            );
        }
    }

    /// 排序面:rootName → symbolName → line 字节序;跨 root 同名命中按
    /// rootName 归位(Avatar.proj-a < Avatar.proj-b)。
    #[test]
    fn sort_order_root_symbol_line() {
        let (_registry, engine) = build();
        let hits = engine.workspace_symbols_by_prefix("");
        assert!(hits.len() > 4);
        for pair in hits.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            let key_a = (a.root_name.as_str(), a.symbol_name.as_str(), a.line);
            let key_b = (b.root_name.as_str(), b.symbol_name.as_str(), b.line);
            assert!(key_a <= key_b, "排序面 violated: {key_a:?} !<= {key_b:?}");
        }
        let hp_hits = engine
            .workspace_symbols_by_prefix("hp")
            .into_iter()
            .map(|hit| hit.root_def_file)
            .collect::<Vec<_>>();
        assert_eq!(
            hp_hits,
            vec![
                "/proj-a/scripts/entity_defs/Avatar.def",
                // 同 (rootName, symbolName, line) 平位按迭代序稳定(路径序)。
                "/proj-b/scripts/entity_defs/Avatar.def",
                "/proj-a/scripts/entity_defs/Mixed.def",
                "/proj-a/scripts/entity_defs/Monster.def",
            ],
            "同符号按 rootName 归位;跨 root 平位按路径序稳定"
        );
    }

    /// RUST-149 横切(root 移除):撤掉 proj-b 后其 root 与命中扇出摘除
    /// (不虚报);proj-a 域命中不变。
    #[test]
    fn root_removal_drops_hits_and_keeps_other_roots() {
        let (registry, mut engine) = build();
        assert!(
            engine
                .workspace_symbols_by_prefix("hp")
                .iter()
                .any(|hit| hit.root_def_file.starts_with("/proj-b"))
        );
        let root = registry.root_for(&CanonicalUri::from_path("/proj-b/scripts/entities.xml"));
        engine.invalidate_root(root);
        let after = engine.workspace_symbols_by_prefix("hp");
        assert!(
            after
                .iter()
                .all(|hit| !hit.root_def_file.starts_with("/proj-b")),
            "撤根后陈旧 root 命中整个消失"
        );
        assert!(
            after
                .iter()
                .any(|hit| hit.root_def_file == "/proj-a/scripts/entity_defs/Avatar.def")
        );
    }

    /// RUST-149 横切(stale 替位):同路径 def 换代即换命中(不虚报旧符号),
    /// stale/cancel/cold 对同步纯面 N-A(如登记)。
    #[test]
    fn def_update_swaps_hits_same_path() {
        let (registry, mut engine) = build();
        let key = key_for(&registry, "/proj-b/scripts/entity_defs/Avatar.def");
        engine.update(
            key,
            "<root>\n  <Properties>\n    <renamed>\n      <Type> UINT64 </Type>\n    </renamed>\n  </Properties>\n</root>\n",
        );
        let hits = engine.workspace_symbols_by_prefix("");
        assert!(
            !hits
                .iter()
                .any(|hit| hit.root_def_file.starts_with("/proj-b") && hit.symbol_name == "hp"),
            "换代后旧符号不虚报"
        );
        assert!(hits.iter().any(|hit| hit.root_def_file.starts_with("/proj-b") && hit.symbol_name == "renamed"));
    }
}
