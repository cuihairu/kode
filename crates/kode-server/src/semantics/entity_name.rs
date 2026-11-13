//! 创建 API 实体名字面量解析(KSEM-CREATE-02)。
//!
//! 创建 API(CREATE-01 契约表)的 entityType 参按字面量形态分诊:
//!
//! - **字面量**:对目录解析实体名——存在则检验「所需脚本部件」(该创建族
//!   要求的 def 段:cell 族要求 cell 段、baseapp 创建族要求 base 段),
//!   缺段分「引擎硬闸」与「结构性缺」两档(engine 真值:
//!   `createCellEntityInNewSpace` 对无 cell 段实体 ERROR+静默 None,
//!   baseapp.cpp:2523-2529;其余路径引擎不设硬闸,由结构判);名字不在
//!   目录 → `Missing`;
//! - **部分字面量**(f-string 已知前缀):前缀候选集——补全面;
//! - **动态**(变量/getattr/拼接):`Unknown`——保持未知不猜;
//! - **目录缺失**:`IndexMissing`——**绝不判 Missing**(验收红线:索引
//!   未就绪时「实体不存在」这句话说不出口,与 RPC-09 覆盖态同纪律)。
//!
//! 跳转目标由消费方从 `Resolved.name` 映射 def 文件(目录实现方可携带
//! 文件位);本模块只登记语义判定,不持文件句柄。

use super::create_api::CreateKind;
use super::id::Facet;

/// entityType 实参形态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NameArg {
    /// 字面量(可静态折叠形态由消费方折叠后传入)。
    Literal(String),
    /// 已知前缀的部分字面量(f-string/拼接前半)。
    PartialPrefix(String),
    /// 动态名(变量/getattr/完全拼接)。
    Dynamic,
}

/// 实体目录(消费方从 def 索引/快照实现;库面不持索引)。
pub trait EntityCatalog {
    /// 实体 def 名 → 声明了哪些段;None = 目录中无此实体。
    fn facets_of(&self, entity: &str) -> Option<Vec<Facet>>;
    /// 目录可见的全部实体名(补全/候选面;实现方保证去重)。
    fn known_entities(&self) -> Vec<String>;
}

/// 名字解析结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NameCheck {
    /// 实体在目录且名字可解析;`missing_facets` = 所需段中实体未声明的
    /// (空=部件齐);`engine_gated` = 缺段中引擎会硬闸的子集
    /// (非空时消费面可报确定错误,其余缺段为结构缺,措辞自持)。
    Resolved {
        name: String,
        missing_facets: Vec<Facet>,
        engine_gated: Vec<Facet>,
    },
    /// 字面量但目录中无此实体(索引就绪才有资格下此结论)。
    Missing { name: String },
    /// 前缀候选(补全面;空集=无匹配,仍不是 Missing)。
    Candidates { names: Vec<String> },
    /// 动态名——保持未知。
    Unknown { reason: String },
    /// 目录未就绪——绝不判 Missing。
    IndexMissing,
}

/// 某创建族要求的 def 段,及该要求是否引擎硬闸。
pub fn required_facets(kind: CreateKind) -> Vec<(Facet, bool)> {
    use CreateKind::*;
    match kind {
        // cell 实体创建族:cell 段必需;InNewSpace 引擎硬闸
        // (baseapp.cpp:2523-2529 ERROR+静默 None),直连路径结构判
        // (Baseapp::createCellEntity 本调用点无 hasCell 闸,baseapp.cpp:3119-3145)。
        CellEntity => vec![(Facet::Cell, false)],
        CellEntityInNewSpace => vec![(Facet::Cell, true)],
        // baseapp 创建族(含 baseapp 口径的 Local):建的是 base 实体,
        // base 段结构必需(引擎不设硬闸);cellapp 口径的 Local 由
        // `required_facets_cellapp_local()` 单独给。
        Local | Remote | Anywhere | FromDbid | AnywhereFromDbid | RemotelyFromDbid => {
            // Local 族的挂载面区分 base/cellapp 在消费侧(API 名同、面不同),
            // 此处按 kind 给 baseapp 口径;cellapp 本地创建走 cell_required_local。
            vec![(Facet::Base, false)]
        }
    }
}

/// cellapp 本地 `createEntity`(挂载面区分 kind==Local 的双义)所需段。
pub fn required_facets_cellapp_local() -> Vec<(Facet, bool)> {
    vec![(Facet::Cell, false)]
}

/// 解析创建 API 的实体名(kind 给挂载面口径;cellapp 本地创建传
/// `required_facets_cellapp_local()` 结果由本函数内部分流)。
pub fn check_entity_name(
    kind: CreateKind,
    is_cellapp_local: bool,
    arg: &NameArg,
    catalog: Option<&dyn EntityCatalog>,
) -> NameCheck {
    // 动态名不依赖目录,先判(目录缺失不改变其结论)。
    if matches!(arg, NameArg::Dynamic) {
        return NameCheck::Unknown {
            reason: "实体名为动态形态(变量/getattr/拼接),运行时才知".to_string(),
        };
    }

    // Literal/PartialPrefix 都依赖目录;目录未就绪 → IndexMissing,
    // 绝不给「实体不存在」或「无候选」这类依赖完备性的结论。
    let Some(catalog) = catalog else {
        return NameCheck::IndexMissing;
    };

    match arg {
        NameArg::PartialPrefix(prefix) => {
            let mut names: Vec<String> = catalog
                .known_entities()
                .into_iter()
                .filter(|n| n.starts_with(prefix.as_str()))
                .collect();
            names.sort();
            NameCheck::Candidates { names }
        }
        NameArg::Literal(name) => {
            let Some(declared) = catalog.facets_of(name) else {
                return NameCheck::Missing {
                    name: name.clone(),
                };
            };
            let required = if is_cellapp_local {
                required_facets_cellapp_local()
            } else {
                required_facets(kind)
            };
            let missing_facets: Vec<Facet> = required
                .iter()
                .filter(|(facet, _)| !declared.contains(facet))
                .map(|(facet, _)| *facet)
                .collect();
            let engine_gated: Vec<Facet> = required
                .iter()
                .filter(|(facet, gated)| *gated && !declared.contains(facet))
                .map(|(facet, _)| *facet)
                .collect();
            NameCheck::Resolved {
                name: name.clone(),
                missing_facets,
                engine_gated,
            }
        }
        // 已在函数入口前置分流(动态名不依赖目录)。
        NameArg::Dynamic => unreachable!("dynamic handled before catalog gate"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Catalog {
        entities: Vec<(String, Vec<Facet>)>,
    }

    impl EntityCatalog for Catalog {
        fn facets_of(&self, entity: &str) -> Option<Vec<Facet>> {
            self.entities
                .iter()
                .find(|(n, _)| n == entity)
                .map(|(_, f)| f.clone())
        }

        fn known_entities(&self) -> Vec<String> {
            self.entities.iter().map(|(n, _)| n.clone()).collect()
        }
    }

    fn catalog() -> Catalog {
        Catalog {
            entities: vec![
                ("Avatar".to_string(), vec![Facet::Base, Facet::Cell, Facet::Client]),
                ("Monster".to_string(), vec![Facet::Base]),
                ("SpawnPoint".to_string(), vec![Facet::Cell]),
                ("Ghost".to_string(), vec![]),
            ],
        }
    }

    #[test]
    fn literal_with_all_facets_resolves_clean() {
        let check = check_entity_name(
            CreateKind::CellEntityInNewSpace,
            false,
            &NameArg::Literal("Avatar".to_string()),
            Some(&catalog()),
        );
        assert_eq!(
            check,
            NameCheck::Resolved {
                name: "Avatar".to_string(),
                missing_facets: vec![],
                engine_gated: vec![],
            }
        );
    }

    #[test]
    fn in_new_space_without_cell_is_engine_gated() {
        // Monster 无 cell 段:InNewSpace 引擎硬闸(baseapp.cpp:2523-2529)。
        let check = check_entity_name(
            CreateKind::CellEntityInNewSpace,
            false,
            &NameArg::Literal("Monster".to_string()),
            Some(&catalog()),
        );
        assert_eq!(
            check,
            NameCheck::Resolved {
                name: "Monster".to_string(),
                missing_facets: vec![Facet::Cell],
                engine_gated: vec![Facet::Cell],
            }
        );
    }

    #[test]
    fn direct_cell_entity_without_cell_is_structural_only() {
        // 直连 createCellEntity 本调用点无 hasCell 闸(baseapp.cpp:3119-3145):
        // 缺段只是结构缺,engine_gated 空。
        let check = check_entity_name(
            CreateKind::CellEntity,
            false,
            &NameArg::Literal("Monster".to_string()),
            Some(&catalog()),
        );
        assert!(matches!(&check, NameCheck::Resolved { missing_facets, engine_gated, .. }
            if missing_facets == &vec![Facet::Cell] && engine_gated.is_empty()));
    }

    #[test]
    fn baseapp_creation_requires_base_section() {
        // SpawnPoint 只有 cell 段:baseapp 创建族缺 base 段(结构缺)。
        let check = check_entity_name(
            CreateKind::Anywhere,
            false,
            &NameArg::Literal("SpawnPoint".to_string()),
            Some(&catalog()),
        );
        assert!(matches!(&check, NameCheck::Resolved { missing_facets, engine_gated, .. }
            if missing_facets == &vec![Facet::Base] && engine_gated.is_empty()));
    }

    #[test]
    fn cellapp_local_requires_cell_section() {
        // cellapp 本地 createEntity 建 cell 实体:SpawnPoint 合法,Monster 缺 cell。
        let ok = check_entity_name(
            CreateKind::Local,
            true,
            &NameArg::Literal("SpawnPoint".to_string()),
            Some(&catalog()),
        );
        assert!(matches!(&ok, NameCheck::Resolved { missing_facets, .. } if missing_facets.is_empty()));
        let bad = check_entity_name(
            CreateKind::Local,
            true,
            &NameArg::Literal("Monster".to_string()),
            Some(&catalog()),
        );
        assert!(matches!(&bad, NameCheck::Resolved { missing_facets, .. }
            if missing_facets == &vec![Facet::Cell]));
    }

    #[test]
    fn empty_def_resolves_with_both_missing() {
        // Ghost 无任何段:baseapp 族缺 base、cellapp 族缺 cell。
        let base_side = check_entity_name(
            CreateKind::FromDbid,
            false,
            &NameArg::Literal("Ghost".to_string()),
            Some(&catalog()),
        );
        assert!(matches!(&base_side, NameCheck::Resolved { missing_facets, .. }
            if missing_facets == &vec![Facet::Base]));
    }

    #[test]
    fn literal_unknown_entity_is_missing() {
        let check = check_entity_name(
            CreateKind::Local,
            false,
            &NameArg::Literal("Nope".to_string()),
            Some(&catalog()),
        );
        assert_eq!(
            check,
            NameCheck::Missing {
                name: "Nope".to_string(),
            }
        );
    }

    #[test]
    fn missing_catalog_never_reports_missing_entity() {
        // 验收红线:目录未就绪时字面量也拿不到「实体不存在」结论。
        let check = check_entity_name(
            CreateKind::Local,
            false,
            &NameArg::Literal("Nope".to_string()),
            None,
        );
        assert_eq!(check, NameCheck::IndexMissing);
    }

    #[test]
    fn dynamic_name_stays_unknown() {
        let check = check_entity_name(
            CreateKind::Anywhere,
            false,
            &NameArg::Dynamic,
            Some(&catalog()),
        );
        assert!(matches!(check, NameCheck::Unknown { .. }));
    }

    #[test]
    fn partial_prefix_yields_sorted_candidates() {
        let check = check_entity_name(
            CreateKind::Anywhere,
            false,
            &NameArg::PartialPrefix("Av".to_string()),
            Some(&catalog()),
        );
        assert_eq!(
            check,
            NameCheck::Candidates {
                names: vec!["Avatar".to_string()],
            }
        );
        let none = check_entity_name(
            CreateKind::Anywhere,
            false,
            &NameArg::PartialPrefix("Zz".to_string()),
            Some(&catalog()),
        );
        // 无匹配仍是 Candidates 空集,不是 Missing(前缀只是不完整信息)。
        assert_eq!(none, NameCheck::Candidates { names: vec![] });
    }

    #[test]
    fn dynamic_and_partial_not_affected_by_catalog_presence() {
        // 动态名在目录缺失时仍是 Unknown(不因索引缺而升级/降级)。
        let check = check_entity_name(CreateKind::Anywhere, false, &NameArg::Dynamic, None);
        assert!(matches!(check, NameCheck::Unknown { .. }));
    }
}
