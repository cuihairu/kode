//! KSEM-DOCLASS(RUST-112,旧 SEM-010)文档类别区分与重复定义检测(纯库
//! 面,无 RPC/无 TS 消费)。
//!
//! 区分面:`classify_document` 把文档键按 KBEngine 路径约定归 [`DocClass`]——
//! Python 实体脚本(`scripts/<Entity>.py` 根件 + `scripts/{base,cell,client}/
//! <Entity>.py` 段件,nav [`super::nav::script_layout`] 同口径)/ Python 组件
//! 脚本(`scripts/{base,cell}/components/<Name>.py`;引擎组件只装应用侧,
//! client/components 不产此类,TS defMd5Check 组件脚本面同口径)/ def 三池
//! (`def_kind_from_key` 同口径)/ entities.xml / types.xml / alias.xml / 其他。
//!
//! 重复定义检测三面(文件内重复已由 lint `duplicate-definition`/
//! `duplicate-type-tag` 覆盖,此处只做跨文档/清单/Python 面):
//! - `duplicate_defs`:跨文件同池同名 def(引擎装载序依文件系统,无显式
//!   优先序——只报事实**不选 winner**,与 RUST-111 的 IDE 显式序消解不同);
//! - `duplicate_registrations`:entities.xml 同名重复条目(引擎静默复用已有
//!   模块 `registerNewScriptDefModule`,entitydef.cpp:255-262,第二条目及
//!   其属性断言不生效、作者无感知——kode 如实报);
//! - `duplicate_py_classes`:同文件重复类定义(Python 模块属性后见覆前,
//!   引擎无诊断,kode 如实报)。
//!
//! 组件绑定区分:`resolve_pool_ref` 把 def 属性类型名按三池(components/
//! entities/interfaces)归类——组件绑定、实体引用、接口引用、多池命中
//! (歧义全列不任取)、各池查无(builtin/类型图面由调用方续判)。

use std::collections::BTreeMap;

use kode_parser::model::EntityEntry;
use kode_vfs::DocumentKey;

use super::id::Facet;
use super::nav::{script_layout, PyFacet};
use super::snapshot::ReferenceKind;
use super::store::{def_kind_from_key, def_name_from_key};

/// 池判别确定性序(枚举声明序;`ReferenceKind` 未派生 Ord,BTreeMap 键须
/// 数值化)。
fn kind_rank(kind: ReferenceKind) -> u8 {
    match kind {
        ReferenceKind::Entity => 0,
        ReferenceKind::Interface => 1,
        ReferenceKind::Component => 2,
    }
}

/// 文档类别(路径判别)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocClass {
    /// Python 实体脚本(根件/段件,nav 布局口径)。
    PythonEntity(PyFacet),
    /// Python 组件脚本(`scripts/{base,cell}/components/<Name>.py`;引擎组
    /// 件只装应用侧,`client/components` 不产此类)。
    PythonComponent(Facet),
    /// def 三池(实体/接口/组件)。
    Def(ReferenceKind),
    EntitiesXml,
    TypesXml,
    AliasXml,
    /// 其余(Python 但非实体/组件脚本布局、未识别 XML、其他文件)。
    Other,
}

/// 文档键 → 类别。判别序:`.py`(组件布局优先于实体布局)→ 已知 XML 名 →
/// `.def`(三池)→ 其他。
pub fn classify_document(key: &DocumentKey) -> DocClass {
    let path = key.uri.as_path();
    let basename = key.uri.basename();
    if basename.ends_with(".py") {
        // 组件脚本:scripts/{base,cell}/components/<Name>.py(倒数第三段
        // 须为角色目录、倒数第二段为 components)。
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        if segments.len() >= 3 {
            let role = segments[segments.len() - 3];
            let pool = segments[segments.len() - 2];
            let role_facet = match role {
                "base" => Some(Facet::Base),
                "cell" => Some(Facet::Cell),
                _ => None,
            };
            if pool == "components" {
                if let Some(facet) = role_facet {
                    return DocClass::PythonComponent(facet);
                }
                // client/components 引擎不装载,落 Other(诚实:不给段腿)。
                return DocClass::Other;
            }
        }
        return match script_layout(path) {
            Some((facet, _)) => DocClass::PythonEntity(facet),
            None => DocClass::Other,
        };
    }
    match basename {
        "entities.xml" => return DocClass::EntitiesXml,
        "types.xml" => return DocClass::TypesXml,
        "alias.xml" => return DocClass::AliasXml,
        _ => {}
    }
    if basename.ends_with(".def") {
        return DocClass::Def(def_kind_from_key(key));
    }
    DocClass::Other
}

/// 跨文件同池同名 def 重复事实(文件键升序,确定性)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefDuplicateFact {
    pub kind: ReferenceKind,
    pub name: String,
    pub files: Vec<String>,
}

/// 跨文档 def 同池同名重复(同池 ≥2 文件;池间同名不合并)。引擎装载序依
/// 文件系统,本面只报事实不选 winner。
pub fn duplicate_defs(keys: &[DocumentKey]) -> Vec<DefDuplicateFact> {
    let mut buckets: BTreeMap<(u8, String), Vec<String>> = BTreeMap::new();
    for key in keys {
        let name = def_name_from_key(key);
        if !key.uri.basename().ends_with(".def") {
            continue;
        }
        let kind = def_kind_from_key(key);
        buckets
            .entry((kind_rank(kind), name.clone()))
            .or_default()
            .push(key.uri.as_path().to_string());
    }
    buckets
        .into_iter()
        .filter(|(_, files)| files.len() > 1)
        .map(|((rank, name), mut files)| {
            files.sort();
            DefDuplicateFact {
                kind: rank_kind(rank),
                name,
                files,
            }
        })
        .collect()
}

/// [`kind_rank`] 的逆映射(rank 常量与枚举一一对应)。
fn rank_kind(rank: u8) -> ReferenceKind {
    match rank {
        0 => ReferenceKind::Entity,
        1 => ReferenceKind::Interface,
        _ => ReferenceKind::Component,
    }
}

/// entities.xml 同名重复条目事实(行 = parser 1 基;首见 + 后续全列)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationDuplicateFact {
    pub name: String,
    pub lines: Vec<usize>,
}

/// entities.xml 同名重复条目(引擎静默复用已有模块,第二条目不生效)。
pub fn duplicate_registrations(entries: &[EntityEntry]) -> Vec<RegistrationDuplicateFact> {
    let mut seen: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for e in entries {
        seen.entry(e.name.clone()).or_default().push(e.line);
    }
    seen.into_iter()
        .filter(|(_, lines)| lines.len() > 1)
        .map(|(name, lines)| RegistrationDuplicateFact { name, lines })
        .collect()
}

/// 同文件重复类定义事实(行 = AST 0 基;首见 + 后续全列)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PyClassDuplicateFact {
    pub class: String,
    pub lines: Vec<usize>,
}

/// 同文件重复类定义(模块属性后见覆前;文件直属类表按限定名判重)。
pub fn duplicate_py_classes(symbols: &kode_python::model::AstSymbols) -> Vec<PyClassDuplicateFact> {
    let mut seen: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for c in &symbols.classes {
        seen.entry(c.qualified_name.clone())
            .or_default()
            .push(c.start_line);
    }
    seen.into_iter()
        .filter(|(_, lines)| lines.len() > 1)
        .map(|(class, lines)| PyClassDuplicateFact { class, lines })
        .collect()
}

/// def 属性引用的池归属(组件绑定区分)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoolRef {
    /// 组件绑定(components 池命中;文件键升序)。
    Component(Vec<String>),
    /// 实体引用(entities 池;文件键升序)。
    Entity(Vec<String>),
    /// 接口引用(interfaces 池;属性位不合法,事实照报,合法性归消费面)。
    Interface(Vec<String>),
    /// 多池同名命中(歧义事实全列,不任取;桶序 = 枚举声明序)。
    Ambiguous(Vec<(ReferenceKind, Vec<String>)>),
    /// 各池查无(builtin/类型图面由调用方续判)。
    NoPoolHit,
}

/// 属性类型名 → 池归属。按 (kind, name) 分桶收集全部命中文件(键升序);
/// 恰一个池命中 → 对应变体;≥2 池命中 → `Ambiguous` 全列;零命中 →
/// `NoPoolHit`。
pub fn resolve_pool_ref(keys: &[DocumentKey], name: &str) -> PoolRef {
    let mut by_kind: BTreeMap<u8, Vec<String>> = BTreeMap::new();
    for key in keys {
        if key.uri.basename().ends_with(".def") && def_name_from_key(key) == name {
            by_kind
                .entry(kind_rank(def_kind_from_key(key)))
                .or_default()
                .push(key.uri.as_path().to_string());
        }
    }
    let mut sorted: Vec<(u8, Vec<String>)> = by_kind.into_iter().collect();
    for (_, files) in &mut sorted {
        files.sort();
    }
    match sorted.len() {
        0 => PoolRef::NoPoolHit,
        1 => match rank_kind(sorted[0].0) {
            ReferenceKind::Component => PoolRef::Component(sorted.remove(0).1),
            ReferenceKind::Interface => PoolRef::Interface(sorted.remove(0).1),
            ReferenceKind::Entity => PoolRef::Entity(sorted.remove(0).1),
        },
        _ => PoolRef::Ambiguous(
            sorted
                .into_iter()
                .map(|(rank, files)| (rank_kind(rank), files))
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_vfs::store::RootId;
    use kode_vfs::uri::CanonicalUri;

    fn key(path: &str) -> DocumentKey {
        DocumentKey::new(RootId(1), CanonicalUri::from_path(path))
    }

    #[test]
    fn def_classes_by_directory_pool() {
        assert_eq!(
            classify_document(&key("/proj/scripts/entities/Avatar.def")),
            DocClass::Def(ReferenceKind::Entity)
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/entity_defs/Avatar.def")),
            DocClass::Def(ReferenceKind::Entity),
            "无池目录段默认实体池"
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/entity_defs/interfaces/HasHP.def")),
            DocClass::Def(ReferenceKind::Interface)
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/entity_defs/components/Bag.def")),
            DocClass::Def(ReferenceKind::Component)
        );
    }

    #[test]
    fn python_entity_and_component_scripts_distinguished() {
        assert_eq!(
            classify_document(&key("/proj/scripts/Avatar.py")),
            DocClass::PythonEntity(PyFacet::Root)
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/base/Avatar.py")),
            DocClass::PythonEntity(PyFacet::Base)
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/cell/Monster.py")),
            DocClass::PythonEntity(PyFacet::Cell)
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/client/Avatar.py")),
            DocClass::PythonEntity(PyFacet::Client)
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/base/components/Bag.py")),
            DocClass::PythonComponent(Facet::Base)
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/cell/components/Bag.py")),
            DocClass::PythonComponent(Facet::Cell)
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/client/components/Bag.py")),
            DocClass::Other,
            "client/components 引擎不装载,诚实落 Other"
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/common/Helper.py")),
            DocClass::Other
        );
    }

    #[test]
    fn xml_corpus_and_other_files() {
        assert_eq!(
            classify_document(&key("/proj/scripts/entities.xml")),
            DocClass::EntitiesXml
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/entity_defs/types.xml")),
            DocClass::TypesXml
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/entity_defs/alias.xml")),
            DocClass::AliasXml
        );
        assert_eq!(
            classify_document(&key("/proj/scripts/entity_defs/other.xml")),
            DocClass::Other
        );
        assert_eq!(classify_document(&key("/proj/notes.txt")), DocClass::Other);
    }

    #[test]
    fn cross_file_same_pool_def_duplicates() {
        let keys = vec![
            key("/proj/scripts/entities/Avatar.def"),
            key("/proj/scripts/entities/nested/Avatar.def"),
            key("/proj/scripts/entity_defs/Monster.def"),
            key("/proj/scripts/entity_defs/interfaces/HasHP.def"),
        ];
        let facts = duplicate_defs(&keys);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].kind, ReferenceKind::Entity);
        assert_eq!(facts[0].name, "Avatar");
        assert_eq!(
            facts[0].files,
            [
                "/proj/scripts/entities/Avatar.def",
                "/proj/scripts/entities/nested/Avatar.def"
            ],
            "文件键升序"
        );
    }

    #[test]
    fn def_duplicates_kind_isolated_and_singles_absent() {
        let keys = vec![
            key("/proj/scripts/entities/Bag.def"),
            key("/proj/scripts/entity_defs/components/Bag.def"),
            key("/proj/scripts/entity_defs/Unique.def"),
        ];
        let facts = duplicate_defs(&keys);
        assert!(facts.is_empty(), "跨池同名不合并,单文件不产事实");
    }

    #[test]
    fn duplicate_registrations_report_all_lines() {
        let ents = kode_parser::model::parse_entities(
            "<root>\n <Avatar/>\n <Monster/>\n <Avatar/>\n\n <Avatar/>\n</root>",
        );
        let facts = duplicate_registrations(&ents.entities);
        assert_eq!(facts.len(), 1, "Monster 单条目不产");
        assert_eq!(facts[0].name, "Avatar");
        assert_eq!(facts[0].lines, [2, 4, 6], "首见+后续全列(parser 1 基)");
    }

    #[test]
    fn duplicate_py_classes_report_all_lines() {
        let symbols = kode_python::symbols::extract(&kode_python::parse::ParsedAst::new(
            "class Avatar:\n  pass\n\nclass Other:\n  pass\n\nclass Avatar:\n  pass\n",
        ));
        let facts = duplicate_py_classes(&symbols);
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].class, "Avatar");
        assert_eq!(facts[0].lines, [0, 6], "AST 0 基首见+后续");
    }

    #[test]
    fn pool_ref_component_entity_interface_hits() {
        let keys = vec![
            key("/proj/scripts/entity_defs/components/Bag.def"),
            key("/proj/scripts/entities/Avatar.def"),
            key("/proj/scripts/entity_defs/interfaces/HasHP.def"),
        ];
        assert_eq!(
            resolve_pool_ref(&keys, "Bag"),
            PoolRef::Component(vec!["/proj/scripts/entity_defs/components/Bag.def".into()])
        );
        assert_eq!(
            resolve_pool_ref(&keys, "Avatar"),
            PoolRef::Entity(vec!["/proj/scripts/entities/Avatar.def".into()])
        );
        assert_eq!(
            resolve_pool_ref(&keys, "HasHP"),
            PoolRef::Interface(vec!["/proj/scripts/entity_defs/interfaces/HasHP.def".into()])
        );
        assert_eq!(resolve_pool_ref(&keys, "Ghost"), PoolRef::NoPoolHit);
    }

    #[test]
    fn pool_ref_multi_kind_hits_enumerate_ambiguity() {
        let keys = vec![
            key("/proj/scripts/entities/Bag.def"),
            key("/proj/scripts/entity_defs/components/Bag.def"),
        ];
        let r = resolve_pool_ref(&keys, "Bag");
        let PoolRef::Ambiguous(buckets) = r else {
            panic!("多池命中须 Ambiguous,得 {r:?}");
        };
        assert_eq!(buckets.len(), 2);
        assert_eq!(
            buckets[0].0,
            ReferenceKind::Entity,
            "桶序 = 枚举声明序(Entity/Interface/Component)"
        );
        assert_eq!(
            buckets[0].1,
            ["/proj/scripts/entities/Bag.def"],
            "文件键升序"
        );
        assert_eq!(buckets[1].0, ReferenceKind::Component);
    }
}
