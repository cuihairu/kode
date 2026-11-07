//! MessageTable 主构建与 def 递归装载流程。

use std::collections::HashMap;

use serde_json::Value;

use crate::message_table::aliases::assign_alias_ids;
use crate::message_table::assembly::{AsmIssue, AsmSource, AsmType, Assembly};
use crate::message_table::components::register_component_slot;
use crate::message_table::constants::{
    normalize_source_key, METHOD_LOAD_ORDER, PRIMITIVE_TYPE_UTYPES,
};
use crate::message_table::json::{
    IssueJson, MethodJson, PropertyJson, SourceJson, TableJson, TypeJson,
};
use crate::message_table::methods::simulate_method;
use crate::message_table::properties::simulate_property;
use crate::message_table::render::{iso_now, method_to_json, property_to_json};
use crate::message_table::source::Source;
use crate::message_table::types::load_types_xml;
use crate::message_table::views::DefView;

// ---------------------------------------------------------------------------
// 主构建
// ---------------------------------------------------------------------------

/// TS buildMessageTable:基元表注册 → types.xml 用户类型 → 自身 def 递归并入
/// → aliasID 分配 → 汇总 JSON。自身 def 结构错误 → null(与 TS loadDef 抛错
/// 同路,不产表)。
pub(super) fn build_table(params: &Value) -> Result<Value, String> {
    let entity_name = params
        .get("entityName")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "messageTable/build: missing entityName".to_string())?;
    let def_text = params
        .get("defText")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "messageTable/build: missing defText".to_string())?;
    let types_xml = params.get("typesXml").and_then(|v| v.as_str());
    let defs = params
        .get("defs")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let paths = params
        .get("paths")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let alias_id_enabled = params
        .get("aliasIdEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let source = Source {
        entity_name,
        def_text,
        defs: &defs,
        paths: &paths,
    };

    // 自身 def 结构错误:TS source.loadDef(entityName,'entity') 抛错 → null(不产表)
    let Some(own) = source.load(entity_name) else {
        return Ok(Value::Null);
    };

    let mut asm = Assembly::new(entity_name);
    for (name, utype) in PRIMITIVE_TYPE_UTYPES {
        asm.registry.insert(name.to_string(), *utype);
        asm.types.push(AsmType {
            name: (*name).to_string(),
            utype: *utype,
            kind: "primitive",
            aliased_to: None,
            line: None,
            origin: String::new(),
        });
    }
    asm.next_type_utype = PRIMITIVE_TYPE_UTYPES.len() as i64 + 1;
    if let Some(xml) = types_xml {
        load_types_xml(entity_name, xml, &mut asm);
    }

    load_def_into_module(entity_name, own, "own", &source, &mut asm);
    assign_alias_ids(&mut asm, alias_id_enabled);

    let fatal_count = asm.issues.iter().filter(|i| i.fatal).count();
    let methods: Vec<MethodJson> = asm.methods.iter().map(method_to_json).collect();
    let properties: Vec<PropertyJson> = asm.properties.iter().map(property_to_json).collect();
    let types: Vec<TypeJson> = asm
        .types
        .iter()
        .map(|t| TypeJson {
            name: t.name.clone(),
            utype: t.utype,
            kind: t.kind.to_string(),
            aliased_to: t.aliased_to.clone(),
            line: t.line,
            origin: t.origin.clone(),
        })
        .collect();
    let table = TableJson {
        module: entity_name.to_string(),
        generated_at: iso_now(),
        alias_id_enabled,
        load_failed: fatal_count > 0,
        fatal_count,
        sources: asm
            .sources
            .iter()
            .map(|s| SourceJson {
                name: s.name.clone(),
                kind: s.kind.to_string(),
                file_path: s.file_path.clone(),
            })
            .collect(),
        client_methods: methods
            .iter()
            .filter(|m| m.visible_to_client)
            .cloned()
            .collect(),
        methods,
        client_properties: properties
            .iter()
            .filter(|p| p.has_client)
            .cloned()
            .collect(),
        properties,
        types,
        issues: asm
            .issues
            .iter()
            .map(|i| IssueJson {
                kind: i.kind.to_string(),
                message: i.message.clone(),
                fatal: i.fatal,
                line: i.line,
            })
            .collect(),
    };
    serde_json::to_value(&table).map_err(|e| e.to_string())
}

/// 单份 def 并入模块(TS loadDefIntoModule):属性 → Cell → Base → Client 方法
/// →(非接口)接口声明序递归 → 组件槽 → 父类递归。
pub(super) fn load_def_into_module(
    module_name: &str,
    local: DefView,
    origin_kind: &'static str,
    source: &Source,
    asm: &mut Assembly,
) {
    let visit_key = normalize_source_key(source.path_of(module_name));
    // 成环守卫只罩实体(own+父链);接口不罩(引擎 loadInterfaces 重复声明
    // 每次完整装载,撞名报 [X] is exist!;接口尾部提前 return 无环风险)。
    if origin_kind != "interface" && asm.visited.contains(&visit_key) {
        asm.issues.push(AsmIssue {
            kind: "parent-cycle",
            fatal: true,
            line: local.parent_line,
            message: format!(
                "父类链成环:{} 装载中重入 {}(引擎递归装载无法终止,kode 截断该分支)",
                asm.entity_name, module_name
            ),
        });
        return;
    }
    asm.sources.push(AsmSource {
        name: module_name.to_string(),
        kind: origin_kind,
        file_path: source.path_of(module_name).to_string(),
    });
    if origin_kind != "interface" {
        asm.visited.insert(visit_key);
    }

    let root_name = local.root_name.clone();
    for property in &local.properties {
        simulate_property(module_name, property, origin_kind, &root_name, asm);
    }
    for section in METHOD_LOAD_ORDER {
        for method in local.methods.iter().filter(|m| m.section == *section) {
            simulate_method(module_name, method, origin_kind, asm);
        }
    }

    // 接口 def 只并入属性+方法(引擎 loadInterfaces 不递归接口自身)
    if origin_kind == "interface" {
        return;
    }

    for interface_ref in &local.interfaces {
        if let Some(interface_local) = source.load(interface_ref) {
            load_def_into_module(interface_ref, interface_local, "interface", source, asm);
        } else {
            asm.issues.push(AsmIssue {
                kind: "interface-file-missing",
                fatal: true,
                line: None,
                message: format!(
                    "EntityDef::loadDefInfo: failed to load entity:{interface_ref} interface."
                ),
            });
        }
    }

    // 组件槽注册(loadComponents 在接口后父类前)
    for component in &local.components {
        register_component_slot(module_name, component, source, asm);
    }

    if let Some(parent_name) = &local.parent {
        if let Some(parent_local) = source.load(parent_name) {
            load_def_into_module(parent_name, parent_local, "parent", source, asm);
        } else {
            asm.issues.push(AsmIssue {
                kind: "parent-file-missing",
                fatal: true,
                line: None,
                message: format!(
                    "EntityDef::loadDefInfo: failed to load entity:{parent_name} parentClass."
                ),
            });
        }
    }
}
