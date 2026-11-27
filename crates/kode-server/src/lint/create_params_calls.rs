//! Creation-API params dict check wired into the Python diagnostics chain
//! (KSEM-CREATE-05 wiring batch; the ruling face
//! [`crate::semantics::create_params`] is consumed unchanged).
//!
//! Engine truth (entity_macro.h:391-508): `createNamespace` is an
//! engine-internal C++ method, never exposed to Python. The params dict a
//! script passes to the creation-API family lands there verbatim, so the
//! folding face below runs at those call sites:
//!
//! - `KBEngine.createEntity(entityType, params=None)` (baseapp);
//! - `KBEngine.createEntityAnywhere(entityType, params=None, callback=None)`;
//! - `KBEngine.createEntityRemotely(entityType, baseEntityCall, params=None,
//!   callback=None)`;
//! - `KBEngine.createEntity(entityType, spaceID, position, direction,
//!   params=None)` (cellapp; arity picks the shape).
//!
//! Name-correction record (todo 2026-11-28): the names `crateNamespace` /
//! `createNamespace` have zero repo-wide hits as Python-callable APIs; the
//! checks therefore attach at the creation-API call sites above, not at any
//! Python-side "createNamespace" call.
//!
//! Fold discipline (honest boundaries):
//! - only module-qualified `KBEngine.<api>(...)` attribute calls fold; bare
//!   or aliased imports are out of scope (no scope analysis in this batch);
//! - the `params` keyword wins over the positional index; a missing/None/
//!   non-dict-literal params arg yields no entries for that call;
//! - dict keys must be string literals, values must be literals, otherwise
//!   the entry degrades to Dynamic/DynamicKey (never guessed);
//! - `entityType` must be a string literal or the call is skipped (the
//!   catalog cannot resolve the entity, so nothing may be claimed).
//!
//! Findings (the only non-silent verdicts; everything else stays quiet):
//! - `create-params-celldata-not-dict` (error): the special `"cellData"`
//!   key with a non-dict literal — the engine logs an ERROR and drops the
//!   merge (entity_macro.h:417-432);
//! - `create-params-undeclared-attr` (information): key absent from the
//!   entity def; the engine accepts it via PyObject_SetAttr
//!   (entity_macro.h:486-502), so this is a hint, never an error;
//! - `create-params-type-suspicious` (information): literal value family
//!   incompatible with the declared field family (static discipline hint;
//!   the creation face itself does not type-check).
//!
//! Catalog readiness red line: when the entityType has no parsed def in the
//! corpus the catalog is `None` and the face stays silent — never "the def
//! does not declare it" from an unready index (same acceptance red line as
//! CREATE-02/RPC-09).

use ruff_python_ast as ast;
use ruff_python_ast::visitor::Visitor;
use ruff_text_size::Ranged;

use crate::lint::{byte_offset_to_utf16, Finding, RangeFace};
use crate::semantics::create_params::{
    check_params, FieldChannel, FieldInfo, KeyCheck, KeyFinding, ParamEntry, ParamFields, ValueArg,
};
use crate::semantics::rpcargs::arg_text_to_sem_type;

/// Check code: special `cellData` key with a non-dict literal (error).
pub(crate) const CHECK_CELLDATA_NOT_DICT: &str = "create-params-celldata-not-dict";
/// Check code: key absent from the entity def (information hint).
pub(crate) const CHECK_UNDECLARED_ATTR: &str = "create-params-undeclared-attr";
/// Check code: literal value family vs field family mismatch (information
/// hint).
pub(crate) const CHECK_TYPE_SUSPICIOUS: &str = "create-params-type-suspicious";

/// Def-declared field set of one entity (consumed as the `ParamFields`
/// catalog by [`check_params`]).
#[derive(Debug, Clone, PartialEq)]
pub struct EntityFieldSet {
    fields: Vec<(String, FieldInfo)>,
}

impl EntityFieldSet {
    /// Build from parsed def properties: type token → SemType (builtin-only
    /// honest stance, same as rpcargs without a type graph) and the cell
    /// domain flag → cellData channel.
    pub fn from_def(properties: &[kode_parser::model::PropertyDef]) -> Self {
        let fields = properties
            .iter()
            .map(|prop| {
                let ty = arg_text_to_sem_type(prop.type_name.as_deref().unwrap_or_default(), None);
                let channel = if kode_parser::model::flag_domains(&prop.flags).contains(&"cell") {
                    FieldChannel::CellData
                } else {
                    FieldChannel::Property
                };
                (prop.name.clone(), FieldInfo { ty, channel })
            })
            .collect();
        Self { fields }
    }

    /// Empty set (entity def parsed but declares no properties; a ready
    /// catalog — every key is honestly "undeclared").
    pub fn empty() -> Self {
        Self { fields: Vec::new() }
    }
}

impl ParamFields for EntityFieldSet {
    fn field_of(&self, key: &str) -> Option<FieldInfo> {
        self.fields
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, info)| info.clone())
    }
}

/// Entity catalog provider: entityType literal → def-declared field set;
/// `None` = catalog not ready (entity not in the corpus / def unparsed).
pub type EntityFieldLookup<'a> = dyn Fn(&str) -> Option<EntityFieldSet> + 'a;

/// One creation-API call site selected for folding.
struct CallSite<'a> {
    /// API name (`createEntity` / `createEntityAnywhere` /
    /// `createEntityRemotely`).
    api: &'static str,
    call: &'a ast::ExprCall,
}

/// Collect `KBEngine.<api>(...)` attribute calls (module-qualified only).
struct CallCollector<'a> {
    sites: Vec<CallSite<'a>>,
}

impl<'a> Visitor<'a> for CallCollector<'a> {
    fn visit_expr(&mut self, expr: &'a ast::Expr) {
        if let ast::Expr::Call(call) = expr {
            if let Some(api) = engine_api_name(&call.func) {
                self.sites.push(CallSite { api, call });
            }
        }
        ast::visitor::walk_expr(self, expr);
    }
}

/// `KBEngine.<name>` attribute chain → API contract name; anything else
/// (bare name, other receivers) is not folded.
fn engine_api_name(func: &ast::Expr) -> Option<&'static str> {
    let ast::Expr::Attribute(attr) = func else {
        return None;
    };
    let ast::Expr::Name(module) = attr.value.as_ref() else {
        return None;
    };
    if module.id.as_str() != "KBEngine" {
        return None;
    }
    match attr.attr.as_str() {
        "createEntityAnywhere" => Some("createEntityAnywhere"),
        "createEntityRemotely" => Some("createEntityRemotely"),
        "createEntity" => Some("createEntity"),
        _ => None,
    }
}

/// The `params` keyword argument literal, if present.
fn keyword_params(call: &ast::ExprCall) -> Option<&ast::Expr> {
    call.arguments.keywords.iter().find_map(|kw| {
        let name = kw.arg.as_ref()?;
        (name.as_str() == "params").then_some(&kw.value)
    })
}

/// Positional params index per API contract shape (arity disambiguates the
/// two `createEntity` shapes; the keyword form handled separately).
fn positional_params_index(api: &str, arg_count: usize) -> Option<usize> {
    match api {
        "createEntityRemotely" => (arg_count >= 3).then_some(2),
        "createEntityAnywhere" => (arg_count >= 2).then_some(1),
        // Two shapes: baseapp (entityType, params) vs cellapp
        // (entityType, spaceID, position, direction, params).
        "createEntity" => {
            if arg_count >= 5 {
                Some(4)
            } else if arg_count == 2 {
                Some(1)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Fold a params dict literal into check entries; `None` = not a dict
/// literal / dynamic (nothing checkable, nothing claimed).
fn fold_params(value: &ast::Expr) -> Option<Vec<ParamEntry>> {
    let ast::Expr::Dict(dict) = value else {
        return None;
    };
    let mut out = Vec::new();
    for item in &dict.items {
        let Some(key) = &item.key else {
            // `**spread` — dynamic key.
            out.push(ParamEntry::DynamicKey);
            continue;
        };
        let ast::Expr::StringLiteral(key_lit) = key else {
            // Non-string-literal key (variable/computed) — dynamic key.
            out.push(ParamEntry::DynamicKey);
            continue;
        };
        out.push(ParamEntry::Named {
            key: key_lit.value.to_str().to_string(),
            value: fold_value(&item.value),
        });
    }
    Some(out)
}

/// Literal value classification; non-literal expressions degrade to
/// `ValueArg::Dynamic` (never guessed).
fn fold_value(value: &ast::Expr) -> ValueArg {
    // Complex literals (1+2j) have no check-face kind — dynamic.
    if matches!(value, ast::Expr::NumberLiteral(n) if matches!(n.value, ast::Number::Complex { .. }))
    {
        return ValueArg::Dynamic;
    }
    match value {
        ast::Expr::StringLiteral(_)
        | ast::Expr::NumberLiteral(_)
        | ast::Expr::BooleanLiteral(_)
        | ast::Expr::NoneLiteral(_)
        | ast::Expr::List(_)
        | ast::Expr::Dict(_)
        | ast::Expr::Set(_)
        | ast::Expr::Tuple(_) => ValueArg::Literal(literal_kind(value)),
        _ => ValueArg::Dynamic,
    }
}

/// Map an AST literal expression to the check-face literal kind.
fn literal_kind(value: &ast::Expr) -> crate::semantics::create_params::ParamLiteral {
    use crate::semantics::create_params::ParamLiteral as PL;
    match value {
        ast::Expr::StringLiteral(_) => PL::Str,
        ast::Expr::NumberLiteral(n) => match &n.value {
            ast::Number::Int(_) => PL::Int,
            _ => PL::Float,
        },
        ast::Expr::BooleanLiteral(_) => PL::Bool,
        ast::Expr::NoneLiteral(_) => PL::None,
        ast::Expr::List(_) => PL::List,
        ast::Expr::Dict(_) => PL::Dict,
        ast::Expr::Set(_) => PL::Set,
        ast::Expr::Tuple(_) => PL::Tuple,
        _ => unreachable!("literal_kind called on a non-literal"),
    }
}

/// entityType literal (first positional argument); `None` = dynamic name —
/// the call is skipped entirely.
fn entity_type_literal(call: &ast::ExprCall) -> Option<String> {
    let first = call.arguments.args.first()?;
    let ast::Expr::StringLiteral(lit) = first else {
        return None;
    };
    Some(lit.value.to_str().to_string())
}

/// Byte span of an AST expression → Finding location face (1-based line +
/// UTF-16 doc offset/length; same coordinate system as the def rules).
fn finding_at(
    check: &'static str,
    severity: &'static str,
    text: &str,
    span: ruff_text_size::TextRange,
    message: String,
) -> Finding {
    let start = span.start().to_u32() as usize;
    let end = span.end().to_u32() as usize;
    let offset = byte_offset_to_utf16(text, start);
    let length = byte_offset_to_utf16(text, end).saturating_sub(offset);
    let lines = kode_vfs::LineIndex::new(text);
    let line = lines.position_of(text, start).line as usize + 1;
    Finding {
        check,
        code: check,
        severity,
        line,
        offset,
        length,
        name: None,
        message,
        range: RangeFace { offset, length },
        related: None,
    }
}

/// Analyze one Python document: fold creation-API params dict literals,
/// run [`check_params`] per call, surface the three non-silent verdicts.
pub fn analyze_create_params_calls(
    text: &str,
    entity_fields: &EntityFieldLookup<'_>,
) -> Vec<Finding> {
    let mut out = Vec::new();
    let ast_handle = kode_python::parse::ParsedAst::new(text);
    let mut collector = CallCollector { sites: Vec::new() };
    for stmt in &ast_handle.module().body {
        ast::visitor::Visitor::visit_stmt(&mut collector, stmt);
    }
    for site in collector.sites {
        // entityType must be a literal or nothing can be claimed.
        let Some(entity) = entity_type_literal(site.call) else {
            continue;
        };
        // params: keyword wins, then the positional slot by arity.
        let params_value = keyword_params(site.call).or_else(|| {
            positional_params_index(site.api, site.call.arguments.args.len())
                .and_then(|index| site.call.arguments.args.get(index))
        });
        let Some(params_value) = params_value else {
            continue;
        };
        // None-literal params ≡ omitted (engine default) — nothing to fold.
        if matches!(params_value, ast::Expr::NoneLiteral(_)) {
            continue;
        }
        let Some(entries) = fold_params(params_value) else {
            continue;
        };
        // Catalog readiness: entity absent from the corpus → silent
        // (IndexMissing inside check_params; never "def does not declare").
        let catalog = entity_fields(&entity);
        let findings = check_params(
            &entries,
            catalog.as_ref().map(|set| set as &dyn ParamFields),
        );
        for finding in findings {
            emit_finding(text, &site, &entity, finding, &mut out);
        }
    }
    out
}

/// Map one `KeyFinding` to a published Finding (only the three non-silent
/// verdicts; Ok/Unknown/IndexMissing/Dynamic stay quiet).
fn emit_finding(
    text: &str,
    site: &CallSite<'_>,
    entity: &str,
    finding: KeyFinding,
    out: &mut Vec<Finding>,
) {
    let KeyFinding::Named { key, check } = finding else {
        // DynamicKey entries: never guessed, nothing to report.
        return;
    };
    let span = key_span(site, &key);
    let Some(span) = span else {
        return;
    };
    let message = match check {
        KeyCheck::CellDataDict {
            is_dict_literal: Some(false),
        } => Some((
            CHECK_CELLDATA_NOT_DICT,
            "error",
            "cellData is not a dict: 创建 API 的 params 里键 \"cellData\" 的值不是 dict 字面量。引擎合并 cellData 时按 dict 处理,非 dict 只记 ERROR 日志并丢弃合并(entity_macro.h:417-432)。".to_string(),
        )),
        KeyCheck::UndeclaredDynamicAttr => Some((
            CHECK_UNDECLARED_ATTR,
            "info",
            format!(
                "属性 \"{key}\" 未在实体 {entity} 的 def 中声明。引擎会经 PyObject_SetAttr 动态创建实例属性,不拦截(entity_macro.h:486-502);如非刻意,请核对键名或补 def 声明。",
            ),
        )),
        KeyCheck::PropertyPath {
            value:
                crate::semantics::create_params::ValueCheck::Suspicious { reason },
        } => Some((
            CHECK_TYPE_SUSPICIOUS,
            "info",
            format!(
                "键 \"{key}\" 的字面量与 {entity} def 声明的字段型不相容:{reason}。创建面引擎不校验类型,此为静态纪律提示。",
            ),
        )),
        KeyCheck::CellDataPath {
            value:
                crate::semantics::create_params::ValueCheck::Suspicious { reason },
        } => Some((
            CHECK_TYPE_SUSPICIOUS,
            "info",
            format!(
                "键 \"{key}\" 的字面量与 {entity} def 声明的 cellData 字段型不相容:{reason}。该键经 cellData dict 通道落到 cell 侧;创建面引擎不校验类型,此为静态纪律提示。",
            ),
        )),
        _ => None,
    };
    let Some((check_code, severity, message)) = message else {
        return;
    };
    out.push(finding_at(check_code, severity, text, span, message));
}

/// Source span of the params dict key with this name (the diagnostic
/// anchors on the key literal, not the whole call).
fn key_span(site: &CallSite<'_>, key: &str) -> Option<ruff_text_size::TextRange> {
    let params_value = keyword_params(site.call).or_else(|| {
        positional_params_index(site.api, site.call.arguments.args.len())
            .and_then(|index| site.call.arguments.args.get(index))
    })?;
    let ast::Expr::Dict(dict) = params_value else {
        return None;
    };
    dict.items.iter().find_map(|item| {
        let Some(ast::Expr::StringLiteral(lit)) = item.key.as_ref() else {
            return None;
        };
        (lit.value.to_str() == key).then_some(lit.range())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantics::create_params::ParamLiteral as PL;

    fn no_catalog(_entity: &str) -> Option<EntityFieldSet> {
        None
    }

    fn catalog_of(
        entities: Vec<(&'static str, EntityFieldSet)>,
    ) -> impl Fn(&str) -> Option<EntityFieldSet> {
        move |name: &str| {
            entities
                .iter()
                .find(|(entity, _)| *entity == name)
                .map(|(_, set)| set.clone())
        }
    }

    fn fields(pairs: &[(&str, &str, bool)]) -> EntityFieldSet {
        let set = EntityFieldSet {
            fields: pairs
                .iter()
                .map(|(name, ty, cell)| {
                    (
                        (*name).to_string(),
                        FieldInfo {
                            ty: arg_text_to_sem_type(ty, None),
                            channel: if *cell {
                                FieldChannel::CellData
                            } else {
                                FieldChannel::Property
                            },
                        },
                    )
                })
                .collect(),
        };
        set
    }

    fn codes(findings: &[Finding]) -> Vec<&'static str> {
        findings.iter().map(|f| f.check).collect()
    }

    #[test]
    fn celldata_non_dict_literal_is_error_regardless_of_catalog() {
        let text = "import KBEngine\nKBEngine.createEntity(\"Monster\", {\"cellData\": 5})\n";
        let findings = analyze_create_params_calls(text, &no_catalog);
        assert_eq!(codes(&findings), vec![CHECK_CELLDATA_NOT_DICT]);
        assert_eq!(findings[0].severity, "error");
        // Anchor lands on the key literal, not the call head.
        let key_at = text.find("\"cellData\"").expect("key in source");
        assert_eq!(findings[0].offset, key_at);
    }

    #[test]
    fn undeclared_and_type_faces_need_ready_catalog() {
        let text = "import KBEngine\n\
                    KBEngine.createEntity(\"Monster\", {\"extra\": 1, \"hp\": \"no\", \"ok\": \"fine\"})\n";
        let catalog = catalog_of(vec![(
            "Monster",
            fields(&[("hp", "UINT32", false), ("ok", "STRING", false)]),
        )]);
        let findings = analyze_create_params_calls(text, &catalog);
        assert_eq!(
            codes(&findings),
            vec![CHECK_UNDECLARED_ATTR, CHECK_TYPE_SUSPICIOUS]
        );
        assert!(findings.iter().all(|f| f.severity == "info"));
    }

    #[test]
    fn unready_catalog_stays_silent_even_for_unknown_keys() {
        // Catalog missing (entity not in corpus) → IndexMissing inside
        // check_params → zero findings (red line: never "def does not
        // declare" from an unready index).
        let text = "import KBEngine\nKBEngine.createEntity(\"Ghost\", {\"mystery\": 1})\n";
        assert!(analyze_create_params_calls(text, &no_catalog).is_empty());
    }

    #[test]
    fn dynamic_entity_type_or_params_are_not_folded() {
        let catalog = catalog_of(vec![("Monster", fields(&[]))]);
        let dynamic_entity =
            "import KBEngine\nname = \"Monster\"\nKBEngine.createEntity(name, {\"a\": 1})\n";
        assert!(analyze_create_params_calls(dynamic_entity, &catalog).is_empty());
        let dynamic_params = "import KBEngine\np = {}\nKBEngine.createEntity(\"Monster\", p)\n";
        assert!(analyze_create_params_calls(dynamic_params, &catalog).is_empty());
        let none_params = "import KBEngine\nKBEngine.createEntity(\"Monster\", None)\n";
        assert!(analyze_create_params_calls(none_params, &catalog).is_empty());
    }

    #[test]
    fn bare_or_foreign_receiver_calls_are_not_folded() {
        let catalog = catalog_of(vec![("Monster", fields(&[]))]);
        let bare = "import KBEngine\ncreateEntity(\"Monster\", {\"a\": 1})\n";
        assert!(analyze_create_params_calls(bare, &catalog).is_empty());
        let foreign = "import KBEngine\nother.createEntity(\"Monster\", {\"a\": 1})\n";
        assert!(analyze_create_params_calls(foreign, &catalog).is_empty());
    }

    #[test]
    fn keyword_params_wins_over_positional_slot() {
        // Remotely shape: params is position 2, but the keyword form also
        // works and must land on the same face.
        let catalog = catalog_of(vec![("Monster", EntityFieldSet::empty())]);
        let keyword = "import KBEngine\ntarget = None\nKBEngine.createEntityRemotely(\"Monster\", target, params={\"cellData\": []})\n";
        let findings = analyze_create_params_calls(keyword, &catalog);
        assert_eq!(codes(&findings), vec![CHECK_CELLDATA_NOT_DICT]);
    }

    #[test]
    fn cellapp_arity_picks_slot_four() {
        let catalog = catalog_of(vec![("Monster", fields(&[("hp", "STRING", false)]))]);
        let text = "import KBEngine\nKBEngine.createEntity(\"Monster\", 789, (0, 0, 0), (0, 0, 0), {\"hp\": 5})\n";
        let findings = analyze_create_params_calls(text, &catalog);
        assert_eq!(codes(&findings), vec![CHECK_TYPE_SUSPICIOUS]);
    }

    #[test]
    fn spread_and_dynamic_values_stay_silent_on_declared_keys() {
        // Dynamic VALUES still check key existence: "a" is declared →
        // Unknown → silent; `**spread` is a DynamicKey → never reported.
        let catalog = catalog_of(vec![("Monster", fields(&[("a", "UINT32", false)]))]);
        let text = "import KBEngine\nextra = {\"z\": 1}\nKBEngine.createEntity(\"Monster\", {\"a\": extra, **extra})\n";
        assert!(analyze_create_params_calls(text, &catalog).is_empty());
    }

    #[test]
    fn cell_domain_property_reports_through_celldata_channel() {
        let catalog = catalog_of(vec![("Monster", fields(&[("speed", "FLOAT", true)]))]);
        // List literal vs FLOAT field → family mismatch on the cellData path.
        let text = "import KBEngine\nKBEngine.createEntity(\"Monster\", {\"speed\": []})\n";
        let findings = analyze_create_params_calls(text, &catalog);
        assert_eq!(codes(&findings), vec![CHECK_TYPE_SUSPICIOUS]);
        assert!(findings[0].message.contains("cellData"));
    }

    #[test]
    fn folded_literal_kinds_cover_the_table() {
        // Every ParamLiteral kind folds; union field accepts any member.
        let text = "import KBEngine\nKBEngine.createEntity(\"Monster\", {\
                     \"s\": \"x\", \"i\": 1, \"f\": 1.5, \"b\": True, \"n\": None, \
                     \"l\": [], \"d\": {}, \"t\": (1, 2), \"set\": {1}})\n";
        let catalog = catalog_of(vec![("Monster", fields(&[]))]);
        // All nine keys are undeclared on an empty def → nine hints, each
        // anchored on its key.
        let findings = analyze_create_params_calls(text, &catalog);
        assert_eq!(findings.len(), 9);
        assert!(findings.iter().all(|f| f.check == CHECK_UNDECLARED_ATTR));
    }

    #[test]
    fn empty_def_is_a_ready_catalog() {
        // Parsed def with zero properties = ready catalog: every key is
        // honestly undeclared (not IndexMissing).
        let catalog = catalog_of(vec![("Bare", EntityFieldSet::empty())]);
        let text = "import KBEngine\nKBEngine.createEntity(\"Bare\", {\"a\": 1})\n";
        assert_eq!(
            codes(&analyze_create_params_calls(text, &catalog)),
            vec![CHECK_UNDECLARED_ATTR]
        );
    }

    #[test]
    fn finding_coordinates_match_key_span() {
        let text =
            "import KBEngine\nKBEngine.createEntityAnywhere(\"Monster\", {\"cellData\": 7})\n";
        let findings = analyze_create_params_calls(text, &no_catalog);
        assert_eq!(codes(&findings), vec![CHECK_CELLDATA_NOT_DICT]);
        let key_at = text.find("\"cellData\"").expect("key span");
        assert_eq!(findings[0].offset, key_at);
        assert_eq!(findings[0].line, 2);
    }

    #[test]
    fn param_literal_table_is_complete() {
        // Guard the literal-kind mapping: all nine kinds distinguish.
        let cases = [
            ("\"x\"", PL::Str),
            ("1", PL::Int),
            ("1.5", PL::Float),
            ("True", PL::Bool),
            ("None", PL::None),
            ("[1]", PL::List),
            ("{}", PL::Dict),
            ("(1,)", PL::Tuple),
            ("{1, 2}", PL::Set),
        ];
        for (source, expected) in cases {
            let wrapped = format!("x = {source}\n");
            let ast_handle = kode_python::parse::ParsedAst::new(&wrapped);
            let expr = match ast_handle.module().body.first() {
                Some(ast::Stmt::Assign(assign)) => &assign.value,
                _ => panic!("parse {source}"),
            };
            assert_eq!(literal_kind(expr), expected, "kind of {source}");
        }
    }
}
