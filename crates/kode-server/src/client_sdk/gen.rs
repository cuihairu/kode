//! 客户端实体 SDK 生成(SRC-012 自 client_sdk 迁出,纯移动):类型名解析与发射
//! (build_client_sdk_type_map/resolve_*/format_*)、TS/CS 实体生成
//! (generate_ts_entity/generate_cs_entity)、固定字典/组件文件、成员冲突检测与
//! 装配(generate)。区域原文零改动;父模块私有符号经 use super 导入。
use std::collections::{HashMap, HashSet};

use kode_parser::diag::LineMap;
use kode_parser::xml;

use super::{
    builtin_table, client_visible_properties, extract_custom_type_alias_type,
    extract_custom_type_raw_value, fallback_for, parse_custom_type_properties,
    parse_entity, COMPONENTS_BASENAME, DEFAULT_CSHARP_NAMESPACE, EngineTrace,
    FIXED_DICTS_BASENAME, FixedDictType, GENERATED_HEADER_LINE, SdkComponent,
    SdkEntity, SdkGenerateParams, SdkProperty, TRACE_UNKNOWN, TypeMap,
};
/// types.xml → 类型表(内建表 + 别名 + FIXED_DICT;与 TS 同口径)。
fn build_client_sdk_type_map(types_xml: Option<&str>, language: &str) -> TypeMap {
    let mut aliases: HashMap<String, String> = HashMap::new();
    let mut fixed_dicts: HashMap<String, FixedDictType> = HashMap::new();

    if let Some(text) = types_xml {
        let doc = xml::parse(text, false);
        if let Some(root) = doc.root() {
            let lines = LineMap::new(text);
            for type_node in doc.child_elements(root) {
                let element = doc.element(type_node);
                let raw_value = extract_custom_type_raw_value(&doc, type_node);
                aliases.insert(
                    element.name.clone(),
                    extract_custom_type_alias_type(&raw_value),
                );
                let properties = parse_custom_type_properties(&doc, type_node, &lines);
                if !properties.is_empty() {
                    fixed_dicts.insert(
                        element.name.clone(),
                        FixedDictType {
                            name: element.name.clone(),
                            source_line: Some(lines.line_of(element.name_span.start)),
                            properties,
                        },
                    );
                }
            }
        }
    }

    TypeMap {
        builtin: builtin_table(language),
        aliases,
        fixed_dicts,
        fallback: fallback_for(language),
    }
}

// ---------------------------------------------------------------------------
// 类型名解析与发射(与 TS resolveClientSdkTypeName / generate* 同口径)
// ---------------------------------------------------------------------------

fn resolve_type_name(type_map: &TypeMap, type_name: &str, element_type: Option<&str>) -> String {
    if let Some(element) = element_type {
        return format!("{}[]", resolve_type_name(type_map, element, None));
    }
    if let Some(builtin) = type_map
        .builtin
        .iter()
        .find(|(name, _)| *name == type_name)
        .map(|(_, value)| *value)
    {
        return builtin.to_string();
    }
    if type_map.fixed_dicts.contains_key(type_name) {
        return type_name.to_string();
    }
    if let Some(alias) = type_map.aliases.get(type_name) {
        if alias != type_name && !type_map.aliases.contains_key(alias) {
            return resolve_type_name(type_map, alias, None);
        }
    }
    type_map.fallback.to_string()
}

fn resolve_property_type(type_map: &TypeMap, property: &SdkProperty) -> String {
    resolve_type_name(
        type_map,
        &property.type_name,
        property.element_type.as_deref(),
    )
}

fn resolve_arg_type(type_map: &TypeMap, type_name: &str) -> String {
    resolve_type_name(type_map, type_name, None)
}

/// def 的 `<Arg>` 只有类型没有名字,统一给 `arg0/arg1…` 编号。
fn format_arg_types(type_map: &TypeMap, arg_types: &[String], language: &str) -> String {
    arg_types
        .iter()
        .enumerate()
        .map(|(index, arg)| {
            let resolved = resolve_arg_type(type_map, arg);
            if language == "typescript" {
                format!("_arg{index}: {resolved}")
            } else {
                format!("{resolved} arg{index}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn format_arg_ids(arg_types: &[String], underscored: bool) -> String {
    arg_types
        .iter()
        .enumerate()
        .map(|(index, _)| format!("{}arg{index}", if underscored { "_" } else { "" }))
        .collect::<Vec<_>>()
        .join(", ")
}

fn to_pascal_case(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn used_fixed_dict_types<'a>(entity: &SdkEntity, type_map: &'a TypeMap) -> Vec<&'a FixedDictType> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut used: Vec<&FixedDictType> = Vec::new();
    for property in client_visible_properties(entity) {
        if let Some(dict) = type_map.fixed_dicts.get(&property.type_name) {
            if seen.insert(dict.name.as_str()) {
                used.push(dict);
            }
        }
    }
    used
}

fn engine_trace_lines(engine_trace: Option<&EngineTrace>) -> Vec<String> {
    let (version, commit) = match engine_trace {
        Some(trace) => {
            let value = |field: &str| {
                if field.is_empty() {
                    TRACE_UNKNOWN.to_string()
                } else {
                    field.to_string()
                }
            };
            (value(&trace.engine_version), value(&trace.engine_commit))
        }
        None => (TRACE_UNKNOWN.to_string(), TRACE_UNKNOWN.to_string()),
    };
    vec![
        format!("// 引擎版本: {version}"),
        format!("// 引擎提交: {commit}"),
    ]
}

fn def_header(language: &str, generated_at: &str, trace_lines: &[String]) -> Vec<String> {
    let mut lines = vec![
        GENERATED_HEADER_LINE.to_string(),
        format!(
            "// 目标语言: {}",
            if language == "typescript" {
                "TypeScript"
            } else {
                "C#"
            }
        ),
        format!("// 生成时间: {generated_at}"),
    ];
    // IDE-AUD-063:TS 64 位整数表示与编解码边界(与 TS defHeader 同口径)。
    if language == "typescript" {
        lines.push(
            "// 64 位整数: UINT64/INT64 → bigint(全精确域);TS 编译目标需 ES2020+;bigint 不进 JSON.stringify,编解码按 BigInt 感知通道实现"
                .to_string(),
        );
    }
    lines.extend(trace_lines.iter().cloned());
    lines.push(String::new());
    lines
}

fn generate_ts_entity(
    entity: &SdkEntity,
    type_map: &TypeMap,
    generated_at: &str,
    trace_lines: &[String],
) -> String {
    let mut lines = def_header("typescript", generated_at, trace_lines);
    let parent_note = match &entity.parent {
        Some(parent) => format!(" 父类: {parent}"),
        None => String::new(),
    };
    lines.push(format!("// 实体: {}{}", entity.name, parent_note));
    lines.push(String::new());

    let used = used_fixed_dict_types(entity, type_map);
    if !used.is_empty() {
        let names = used
            .iter()
            .map(|dict| dict.name.clone())
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "import {{ {names} }} from './{FIXED_DICTS_BASENAME}';"
        ));
        lines.push(String::new());
    }
    if !entity.components.is_empty() {
        let comp_names = entity
            .components
            .iter()
            .map(|comp| comp.type_name.clone())
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "import {{ {comp_names} }} from './{COMPONENTS_BASENAME}';"
        ));
        lines.push(String::new());
    }

    lines.push(format!("export class {} {{", entity.name));
    lines.push("  /** 实体 id（由 baseapp 分配） */".to_string());
    lines.push("  public readonly entityId: number;".to_string());

    for property in client_visible_properties(entity) {
        lines.push(String::new());
        lines.push(format!("  /** Flags: {} */", property.flags));
        lines.push(format!(
            "  public {}: {};",
            property.name,
            resolve_property_type(type_map, property)
        ));
    }
    for component in &entity.components {
        lines.push(String::new());
        lines.push(format!("  /** 组件槽: {} */", component.type_name));
        lines.push(format!(
            "  public {}: {};",
            component.slot, component.type_name
        ));
    }

    lines.push(String::new());
    lines.push("  public constructor(entityId: number) {".to_string());
    lines.push("    this.entityId = entityId;".to_string());
    lines.push("  }".to_string());

    for method in &entity.client_methods {
        lines.push(String::new());
        let arg_comment = method
            .arg_types
            .iter()
            .map(|arg| resolve_arg_type(type_map, arg))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "  /** ClientMethods 回调: {}({arg_comment}) */",
            method.name
        ));
        let args = format_arg_types(type_map, &method.arg_types, "typescript");
        lines.push(format!("  public {}({args}): void {{", method.name));
        lines.push("    // TODO: 实现客户端回调".to_string());
        lines.push("  }".to_string());
    }

    for section in [
        (
            &entity.exposed_base_methods,
            "Exposed BaseMethods（客户端可请求）",
            "onBaseOutgoing",
            "baseCall",
        ),
        (
            &entity.exposed_cell_methods,
            "Exposed CellMethods（客户端可请求）",
            "onCellOutgoing",
            "cellCall",
        ),
    ] {
        let (methods, label, seam, call_prefix) = section;
        for method in methods {
            lines.push(String::new());
            lines.push(format!("  /** {label}: {} */", method.name));
            let args = format_arg_types(type_map, &method.arg_types, "typescript");
            let call_args = format_arg_ids(&method.arg_types, true);
            lines.push(format!(
                "  public {}{}({args}): void {{",
                call_prefix,
                to_pascal_case(&method.name)
            ));
            lines.push(format!(
                "    this.{seam}('{}', [{call_args}]);",
                method.name
            ));
            lines.push("  }".to_string());
        }
    }

    lines.push(String::new());
    lines.push("  /** 发送接缝: 按客户端插件的 base 调用通道实现 */".to_string());
    lines.push("  protected onBaseOutgoing(_method: string, _args: unknown[]): void {".to_string());
    lines.push("  }".to_string());
    lines.push("  /** 发送接缝: 按客户端插件的 cell 调用通道实现 */".to_string());
    lines.push("  protected onCellOutgoing(_method: string, _args: unknown[]): void {".to_string());
    lines.push("  }".to_string());
    lines.push("}".to_string());
    lines.push(String::new());
    lines.join("\n")
}

fn generate_cs_entity(
    entity: &SdkEntity,
    type_map: &TypeMap,
    generated_at: &str,
    trace_lines: &[String],
    namespace: &str,
) -> String {
    let mut lines = def_header("csharp", generated_at, trace_lines);
    lines.push(format!("namespace {namespace}"));
    lines.push("{".to_string());

    let used = used_fixed_dict_types(entity, type_map);
    let parent_note = match &entity.parent {
        Some(parent) => format!("（父类 {parent}）"),
        None => String::new(),
    };
    let fixed_note = if used.is_empty() {
        String::new()
    } else {
        format!(
            "（固定字典: {}）",
            used.iter()
                .map(|dict| dict.name.clone())
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    lines.push(format!(
        "  /// <summary>{} 客户端实体 SDK 骨架{parent_note}{fixed_note}</summary>",
        entity.name
    ));
    lines.push(format!("  public class {}", entity.name));
    lines.push("  {".to_string());
    lines.push("    /// <summary>实体 id（由 baseapp 分配）</summary>".to_string());
    lines.push("    public long EntityId { get; }".to_string());

    for property in client_visible_properties(entity) {
        lines.push(format!(
            "    /// <summary>Flags: {}</summary>",
            property.flags
        ));
        lines.push(format!(
            "    public {} {} {{ get; set; }}",
            resolve_property_type(type_map, property),
            to_pascal_case(&property.name)
        ));
    }
    for component in &entity.components {
        lines.push(format!(
            "    /// <summary>组件槽: {}</summary>",
            component.type_name
        ));
        lines.push(format!(
            "    public {} {} {{ get; set; }}",
            component.type_name,
            to_pascal_case(&component.slot)
        ));
    }

    lines.push(format!("    public {}(long entityId)", entity.name));
    lines.push("    {".to_string());
    lines.push("      EntityId = entityId;".to_string());
    lines.push("    }".to_string());

    for method in &entity.client_methods {
        let args = format_arg_types(type_map, &method.arg_types, "csharp");
        lines.push(format!(
            "    /// <summary>ClientMethods 回调: {}</summary>",
            method.name
        ));
        lines.push(format!(
            "    public virtual void {}({args})",
            to_pascal_case(&method.name)
        ));
        lines.push("    {".to_string());
        lines.push("      // TODO: 实现客户端回调".to_string());
        lines.push("    }".to_string());
    }

    for section in [
        (
            &entity.exposed_base_methods,
            "BaseCall",
            "OnBaseOutgoing",
            "Exposed BaseMethods",
        ),
        (
            &entity.exposed_cell_methods,
            "CellCall",
            "OnCellOutgoing",
            "Exposed CellMethods",
        ),
    ] {
        let (methods, prefix, seam, label) = section;
        for method in methods {
            let args = format_arg_types(type_map, &method.arg_types, "csharp");
            let call_args = format_arg_ids(&method.arg_types, false);
            lines.push(format!(
                "    /// <summary>{label}: {}</summary>",
                method.name
            ));
            lines.push(format!(
                "    public void {}{}({args})",
                prefix,
                to_pascal_case(&method.name)
            ));
            lines.push("    {".to_string());
            lines.push(format!(
                "      {seam}(\"{}\", new object[] {{ {call_args} }});",
                method.name
            ));
            lines.push("    }".to_string());
        }
    }

    lines.push("    /// <summary>发送接缝: 按客户端插件的 base 调用通道实现</summary>".to_string());
    lines.push(
        "    protected virtual void OnBaseOutgoing(string method, object[] args)".to_string(),
    );
    lines.push("    {".to_string());
    lines.push("    }".to_string());
    lines.push("    /// <summary>发送接缝: 按客户端插件的 cell 调用通道实现</summary>".to_string());
    lines.push(
        "    protected virtual void OnCellOutgoing(string method, object[] args)".to_string(),
    );
    lines.push("    {".to_string());
    lines.push("    }".to_string());
    lines.push("  }".to_string());
    lines.push("}".to_string());
    lines.push(String::new());
    lines.join("\n")
}

fn format_source_line(line: Option<usize>) -> String {
    match line {
        Some(line) => line.to_string(),
        None => "unknown".to_string(),
    }
}

/// FIXED_DICT 伴随文件(逐语言;引用为空 → None 不产文件)。
fn generate_fixed_dicts_file(
    entities: &[&SdkEntity],
    type_map: &TypeMap,
    language: &str,
    generated_at: &str,
    trace_lines: &[String],
    namespace: &str,
) -> Option<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut used: Vec<&FixedDictType> = Vec::new();
    for entity in entities {
        for property in client_visible_properties(entity) {
            if let Some(dict) = type_map.fixed_dicts.get(&property.type_name) {
                if seen.insert(dict.name.clone()) {
                    used.push(dict);
                }
            }
        }
        // 组件属性引用的 FIXED_DICT 也计入(与 generate_components_file 的
        // import 同源),避免「仅组件属性引用」时伴随文件缺失导致断裂导入。
        for component in &entity.components {
            for property in &component.properties {
                if let Some(dict) = type_map.fixed_dicts.get(&property.type_name) {
                    if seen.insert(dict.name.clone()) {
                        used.push(dict);
                    }
                }
            }
        }
    }
    if used.is_empty() {
        return None;
    }

    let mut lines = def_header(language, generated_at, trace_lines);
    if language == "typescript" {
        for dict in &used {
            lines.push(format!(
                "/** source: types.xml:{} */",
                format_source_line(dict.source_line)
            ));
            lines.push(format!("/** {} FIXED_DICT 别名 */", dict.name));
            lines.push(format!("export interface {} {{", dict.name));
            for property in &dict.properties {
                lines.push(format!(
                    "  /** source: types.xml:{} */",
                    format_source_line(property.source_line)
                ));
                let resolved = match &property.type_name {
                    Some(type_name) => resolve_arg_type(type_map, type_name),
                    None => "unknown".to_string(),
                };
                lines.push(format!("  {}: {resolved};", property.name));
            }
            lines.push("}".to_string());
            lines.push(String::new());
        }
    } else {
        lines.push(format!("namespace {namespace}"));
        lines.push("{".to_string());
        for dict in &used {
            lines.push(format!(
                "  // source: types.xml:{}",
                format_source_line(dict.source_line)
            ));
            lines.push(format!(
                "  /// <summary>{} FIXED_DICT 别名</summary>",
                dict.name
            ));
            lines.push(format!("  public class {}", dict.name));
            lines.push("  {".to_string());
            for property in &dict.properties {
                lines.push(format!(
                    "    // source: types.xml:{}",
                    format_source_line(property.source_line)
                ));
                let resolved = match &property.type_name {
                    Some(type_name) => resolve_arg_type(type_map, type_name),
                    None => "object".to_string(),
                };
                lines.push(format!(
                    "    public {resolved} {} {{ get; set; }}",
                    to_pascal_case(&property.name)
                ));
            }
            lines.push("  }".to_string());
        }
        lines.push("}".to_string());
        lines.push(String::new());
    }
    Some(lines.join("\n"))
}

/// 组件类型类伴随文件(逐语言;引用为空 → None 不产文件)。
/// 与 FIXED_DICT 伴随同模式:每组件类型一 class/interface(客户端可见属性)。
fn generate_components_file(
    entities: &[&SdkEntity],
    type_map: &TypeMap,
    language: &str,
    generated_at: &str,
    trace_lines: &[String],
    namespace: &str,
) -> Option<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut used: Vec<&SdkComponent> = Vec::new();
    for entity in entities {
        for comp in &entity.components {
            if seen.insert(comp.type_name.clone()) {
                used.push(comp);
            }
        }
    }
    if used.is_empty() {
        return None;
    }

    // 组件属性引用的 FIXED_DICT(TS 需 import;与实体面同模式)。
    let mut dict_seen: HashSet<String> = HashSet::new();
    let mut fixed_names: Vec<String> = Vec::new();
    if language == "typescript" {
        for comp in &used {
            for property in &comp.properties {
                if let Some(dict) = type_map.fixed_dicts.get(&property.type_name) {
                    if dict_seen.insert(dict.name.clone()) {
                        fixed_names.push(dict.name.clone());
                    }
                }
            }
        }
    }

    let mut lines = def_header(language, generated_at, trace_lines);
    if language == "typescript" {
        if !fixed_names.is_empty() {
            let names = fixed_names.join(", ");
            lines.push(format!(
                "import {{ {names} }} from './{FIXED_DICTS_BASENAME}';"
            ));
            lines.push(String::new());
        }
        for comp in &used {
            lines.push(format!("/** 实体组件: {} */", comp.type_name));
            lines.push(format!("export class {} {{", comp.type_name));
            for property in &comp.properties {
                lines.push(format!("  /** Flags: {} */", property.flags));
                lines.push(format!(
                    "  public {}: {};",
                    property.name,
                    resolve_property_type(type_map, property)
                ));
            }
            lines.push("}".to_string());
            lines.push(String::new());
        }
    } else {
        lines.push(format!("namespace {namespace}"));
        lines.push("{".to_string());
        for comp in &used {
            lines.push(format!(
                "  /// <summary>实体组件: {}</summary>",
                comp.type_name
            ));
            lines.push(format!("  public class {}", comp.type_name));
            lines.push("  {".to_string());
            for property in &comp.properties {
                lines.push(format!(
                    "    /// <summary>Flags: {}</summary>",
                    property.flags
                ));
                lines.push(format!(
                    "    public {} {} {{ get; set; }}",
                    resolve_property_type(type_map, property),
                    to_pascal_case(&property.name)
                ));
            }
            lines.push("  }".to_string());
        }
        lines.push("}".to_string());
        lines.push(String::new());
    }
    Some(lines.join("\n"))
}

pub(super) struct GeneratedFile {
    pub(super) file_name: String,
    pub(super) content: String,
}

fn extension_for(language: &str) -> &'static str {
    if language == "csharp" {
        "cs"
    } else {
        "ts"
    }
}

// ---------------------------------------------------------------------------
// IDE-AUD-062:辅助固定成员与业务成员重名预检(与 TS findClientSdkMemberConflicts 同口径)。
// 生成器固定输出 entityId/onBaseOutgoing/onCellOutgoing(TS)与
// EntityId/OnBaseOutgoing/OnCellOutgoing(C#),外加 baseCall*/cellCall* 包装;
// 业务属性/组件槽/ClientMethods 回调与这些固定名字撞名时产物含重复成员无法编译。
// 策略=生成前提前拒绝并说明原因,绝不静默覆盖。
// ---------------------------------------------------------------------------

fn add_member(members: &mut HashMap<String, Vec<String>>, name: &str, source: String) {
    members.entry(name.to_string()).or_default().push(source);
}

fn collect_emitted_members(entity: &SdkEntity, language: &str) -> HashMap<String, Vec<String>> {
    let mut members: HashMap<String, Vec<String>> = HashMap::new();

    if language == "typescript" {
        add_member(
            &mut members,
            "entityId",
            "辅助字段 entityId（实体 id）".to_string(),
        );
        add_member(
            &mut members,
            "onBaseOutgoing",
            "辅助方法 onBaseOutgoing（发送接缝）".to_string(),
        );
        add_member(
            &mut members,
            "onCellOutgoing",
            "辅助方法 onCellOutgoing（发送接缝）".to_string(),
        );
    } else {
        add_member(
            &mut members,
            "EntityId",
            "辅助字段 EntityId（实体 id）".to_string(),
        );
        add_member(
            &mut members,
            "OnBaseOutgoing",
            "辅助方法 OnBaseOutgoing（发送接缝）".to_string(),
        );
        add_member(
            &mut members,
            "OnCellOutgoing",
            "辅助方法 OnCellOutgoing（发送接缝）".to_string(),
        );
    }

    for property in client_visible_properties(entity) {
        let name = if language == "typescript" {
            property.name.clone()
        } else {
            to_pascal_case(&property.name)
        };
        add_member(&mut members, &name, format!("业务属性 {}", property.name));
    }
    for component in &entity.components {
        let name = if language == "typescript" {
            component.slot.clone()
        } else {
            to_pascal_case(&component.slot)
        };
        add_member(&mut members, &name, format!("组件槽 {}", component.slot));
    }
    for method in &entity.client_methods {
        let name = if language == "typescript" {
            method.name.clone()
        } else {
            to_pascal_case(&method.name)
        };
        add_member(
            &mut members,
            &name,
            format!("ClientMethods 回调 {}", method.name),
        );
    }
    for method in &entity.exposed_base_methods {
        let name = if language == "typescript" {
            format!("baseCall{}", to_pascal_case(&method.name))
        } else {
            format!("BaseCall{}", to_pascal_case(&method.name))
        };
        add_member(
            &mut members,
            &name,
            format!("Exposed BaseMethods 包装 {}", method.name),
        );
    }
    for method in &entity.exposed_cell_methods {
        let name = if language == "typescript" {
            format!("cellCall{}", to_pascal_case(&method.name))
        } else {
            format!("CellCall{}", to_pascal_case(&method.name))
        };
        add_member(
            &mut members,
            &name,
            format!("Exposed CellMethods 包装 {}", method.name),
        );
    }

    members
}

fn find_member_conflicts(entities: &[SdkEntity], language: &str) -> Vec<String> {
    let lang = if language == "typescript" {
        "TypeScript"
    } else {
        "C#"
    };
    let mut conflicts = Vec::new();
    for entity in entities {
        for (name, sources) in collect_emitted_members(entity, language) {
            if sources.len() > 1 {
                conflicts.push(format!(
                    "实体 {} 的 {lang} SDK 成员 \"{name}\" 由 {} 个来源生成：{}",
                    entity.name,
                    sources.len(),
                    sources.join("、")
                ));
            }
        }
    }
    conflicts
}

pub(super) fn generate(params: &SdkGenerateParams) -> Result<Vec<GeneratedFile>, String> {
    let language = params.language.as_str();
    if language != "typescript" && language != "csharp" {
        return Err(format!("unsupported language: {language}"));
    }
    let type_map = build_client_sdk_type_map(params.types_xml.as_deref(), language);
    let trace_lines = engine_trace_lines(params.engine_trace.as_ref());
    let namespace = params
        .namespace
        .clone()
        .unwrap_or_else(|| DEFAULT_CSHARP_NAMESPACE.to_string());

    let entities: Vec<SdkEntity> = params
        .entities
        .iter()
        .filter_map(|input| parse_entity(&input.def_text, &input.name, &params.component_defs))
        .collect();

    // IDE-AUD-062:生成前预检辅助固定成员与业务成员重名,冲突即拒绝,绝不静默覆盖。
    let conflict_msgs = find_member_conflicts(&entities, language);
    if !conflict_msgs.is_empty() {
        return Err(format!(
            "客户端实体 SDK 生成已拒绝：辅助成员与业务成员重名。\n{}\n请重命名业务成员或调整 SDK 配置后重试。",
            conflict_msgs.join("\n")
        ));
    }

    let entity_refs: Vec<&SdkEntity> = entities.iter().collect();

    let extension = extension_for(language);
    let mut files = Vec::new();
    for entity in &entities {
        let content = if language == "typescript" {
            generate_ts_entity(entity, &type_map, &params.generated_at, &trace_lines)
        } else {
            generate_cs_entity(
                entity,
                &type_map,
                &params.generated_at,
                &trace_lines,
                &namespace,
            )
        };
        files.push(GeneratedFile {
            file_name: format!("{}.{}", entity.name, extension),
            content,
        });
    }
    if let Some(fixed) = generate_fixed_dicts_file(
        &entity_refs,
        &type_map,
        language,
        &params.generated_at,
        &trace_lines,
        &namespace,
    ) {
        files.push(GeneratedFile {
            file_name: format!("{FIXED_DICTS_BASENAME}.{extension}"),
            content: fixed,
        });
    }
    if let Some(comps) = generate_components_file(
        &entity_refs,
        &type_map,
        language,
        &params.generated_at,
        &trace_lines,
        &namespace,
    ) {
        files.push(GeneratedFile {
            file_name: format!("{COMPONENTS_BASENAME}.{extension}"),
            content: comps,
        });
    }
    Ok(files)
}
