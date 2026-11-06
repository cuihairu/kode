//! def 知识库核心(MCP-001):资产根装载 + 七个 MCP 工具的纯逻辑面。
//!
//! 与 kode-server 同源单测:消息表/数据库 schema 经 `RpcRegistry` 直调
//! kode-server 的既有实现(不复制逻辑),类型图/实体模型/校验直调
//! kode-parser。bin(server.rs)只是薄装配。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kode_parser::diag::LineMap;
use kode_parser::model::{
    flag_domains, parse_alias, parse_def, parse_types, AliasFile, DefFile, TypesFile,
};
use kode_server::process_topology::{validate_process_topology, DefInput};
use kode_server::rpc::RpcRegistry;
use kode_server::wire_codec::{
    decode_value, encode_value, WireCursor, WireLayout, WireSchema, WireValue,
};
use serde_json::{json, Value};

/// 单份已解析 def(实体/接口/组件统一收口,按文件名立索引)。
#[derive(Debug, Clone)]
pub struct ParsedDef {
    pub name: String,
    /// entity | interface | component(按目录归属)。
    pub category: String,
    /// 相对资产根的路径(正斜杠)。
    pub rel_path: String,
    pub text: String,
    pub model: DefFile,
}

/// 资产根知识库:`<root>/scripts/entity_defs` 的 def 集 + types.xml +
/// alias.xml + `<root>/scripts/entities.xml`。装载容错:单文件解析失败
/// 记入 load_errors,不中断其余文件。
#[derive(Debug, Default)]
pub struct AssetKnowledge {
    pub defs: BTreeMap<String, ParsedDef>,
    pub types_text: Option<String>,
    pub alias_text: Option<String>,
    pub entities_xml_text: Option<String>,
    pub types: TypesFile,
    pub alias: AliasFile,
    pub load_errors: Vec<String>,
}

impl AssetKnowledge {
    /// 从资产根装载(目录不存在=空库不抛错,如实记 load_errors)。
    pub fn load(root: &Path) -> AssetKnowledge {
        let mut kb = AssetKnowledge::default();
        let defs_dir = root.join("scripts").join("entity_defs");
        collect_defs(&defs_dir, "", &mut kb);
        kb.types_text = read_opt(&defs_dir.join("types.xml"));
        kb.alias_text = read_opt(&defs_dir.join("alias.xml"));
        kb.entities_xml_text = read_opt(&root.join("scripts").join("entities.xml"));
        if let Some(text) = &kb.types_text {
            kb.types = parse_types(text);
        }
        if let Some(text) = &kb.alias_text {
            kb.alias = parse_alias(text);
        }
        kb
    }

    fn rpc_registry() -> RpcRegistry {
        let mut reg = RpcRegistry::new();
        kode_server::message_table::register(&mut reg);
        kode_server::database_schema::register(&mut reg);
        reg
    }

    /// search_entities:按实体名或标签(属性/方法名)子串过滤(大小写不敏感)。
    pub fn search_entities(&self, query: &str, limit: usize) -> Value {
        let needle = query.to_lowercase();
        let mut out = Vec::new();
        for def in self.defs.values() {
            let mut matched_tags = Vec::new();
            let name_hit = def.name.to_lowercase().contains(&needle);
            for prop in &def.model.properties {
                if prop.name.to_lowercase().contains(&needle) {
                    matched_tags.push(json!({"kind": "property", "name": prop.name}));
                }
            }
            for method in def
                .model
                .base_methods
                .iter()
                .chain(&def.model.cell_methods)
                .chain(&def.model.client_methods)
            {
                if method.name.to_lowercase().contains(&needle) {
                    matched_tags.push(json!({"kind": "method", "name": method.name}));
                }
            }
            if name_hit || !matched_tags.is_empty() {
                out.push(json!({
                    "name": def.name,
                    "category": def.category,
                    "file": def.rel_path,
                    "nameMatch": name_hit,
                    "matchedTags": matched_tags,
                    "summary": summarize(&def.model),
                }));
                if out.len() >= limit {
                    break;
                }
            }
        }
        json!({ "matches": out, "totalDefs": self.defs.len() })
    }

    /// get_entity_model:实体全模型(属性/方法/Flags 域/进程归属)。
    pub fn get_entity_model(&self, entity: &str) -> Result<Value, String> {
        let def = self.defs.get(entity).ok_or_else(|| {
            format!(
                "entity not found: {entity} (known: {:?})",
                self.defs.keys().take(20).collect::<Vec<_>>()
            )
        })?;
        let model = &def.model;
        let properties: Vec<Value> = model
            .properties
            .iter()
            .map(|p| {
                json!({
                    "name": p.name,
                    "line": p.line,
                    "type": p.type_name,
                    "typeRefs": p.type_refs,
                    "flags": p.flags,
                    "domains": flag_domains(&p.flags),
                    "persistent": p.persistent.unwrap_or(false),
                    "databaseLength": p.database_length,
                    "default": p.default_value,
                    "identifier": p.identifier,
                })
            })
            .collect();
        let methods = |section: &str, list: &[kode_parser::model::MethodDef]| -> Vec<Value> {
            list.iter()
                .map(|m| {
                    json!({
                        "name": m.name,
                        "line": m.line,
                        "args": m.args,
                        "exposed": m.exposed,
                        "section": section,
                    })
                })
                .collect()
        };
        // 进程归属:组件槽 → 组件 def 类型(组件承载自身属性归属)。
        let components: Vec<Value> = model
            .components
            .iter()
            .map(|c| {
                json!({
                    "name": c.name,
                    "type": c.component_type,
                    "persistent": c.persistent.unwrap_or(false),
                    "line": c.line,
                })
            })
            .collect();
        let parse_diagnostics: Vec<Value> = {
            let lines = LineMap::new(&def.text);
            def.model
                .diagnostics
                .iter()
                .map(|d| diag_json(d, &lines))
                .collect()
        };
        Ok(json!({
            "name": def.name,
            "category": def.category,
            "file": def.rel_path,
            "parent": model.parent,
            "interfaces": model.interfaces,
            "volatile": model.volatile,
            "properties": properties,
            "baseMethods": methods("BaseMethods", &model.base_methods),
            "cellMethods": methods("CellMethods", &model.cell_methods),
            "clientMethods": methods("ClientMethods", &model.client_methods),
            "components": components,
            "processOwnership": {
                "cellSide": !model.cell_methods.is_empty()
                    || model.properties.iter().any(|p| flag_domains(&p.flags).contains(&"cell")),
                "baseSide": !model.base_methods.is_empty()
                    || model.properties.iter().any(|p| flag_domains(&p.flags).contains(&"base")),
                "componentTypes": component_types_deep(self, model, &mut Vec::new()),
            },
            "parseDiagnostics": parse_diagnostics,
        }))
    }

    /// get_type_graph:types.xml 自定义类型(别名/数组/FIXED_DICT)+
    /// alias.xml 关联,以及节点间的引用边。
    pub fn get_type_graph(&self) -> Value {
        let type_lines = self
            .types_text
            .as_deref()
            .map(LineMap::new)
            .map(|lines| {
                self.types
                    .diagnostics
                    .iter()
                    .map(|d| diag_json(d, &lines))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let alias_lines = self
            .alias_text
            .as_deref()
            .map(LineMap::new)
            .map(|lines| {
                self.alias
                    .diagnostics
                    .iter()
                    .map(|d| diag_json(d, &lines))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let nodes: Vec<Value> = self
            .types
            .types
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "line": t.line,
                    "kind": format!("{:?}", t.kind),
                    "directive": t.directive,
                    "implementedBy": t.implemented_by_symbol,
                    "fieldRefs": t.field_refs,
                    "elementRef": t.element_ref,
                })
            })
            .collect();
        let mut edges = Vec::new();
        for t in &self.types.types {
            // types.xml 别名链:`<ITEM_ID> UINT16 </ITEM_ID>` = kind Builtin +
            // directive 指向目标——即别名边。
            if t.kind == kode_parser::model::TypeKind::Builtin {
                if let Some(target) = &t.directive {
                    edges.push(json!({"from": t.name, "to": target, "kind": "alias"}));
                }
            }
            for field in &t.field_refs {
                edges.push(json!({"from": t.name, "to": field, "kind": "field"}));
            }
            if let Some(element) = &t.element_ref {
                edges.push(json!({"from": t.name, "to": element, "kind": "element"}));
            }
        }
        let aliases: Vec<Value> = self
            .alias
            .aliases
            .iter()
            .map(|a| json!({"name": a.name, "line": a.line, "aliasType": a.alias_type}))
            .collect();
        for a in &self.alias.aliases {
            edges.push(json!({"from": a.name, "to": a.alias_type, "kind": "alias"}));
        }
        json!({
            "types": nodes,
            "aliases": aliases,
            "edges": edges,
            "diagnostics": {
                "typesXml": type_lines,
                "aliasXml": alias_lines,
            },
        })
    }

    /// validate_defs:全部 def/types/entities 的解析诊断(文件+行)+
    /// 可选进程拓扑错配预警(manifestPath 提供 C-17 清单时)。
    pub fn validate_defs(&self, manifest_path: Option<&str>) -> Value {
        let mut findings = Vec::new();
        for def in self.defs.values() {
            let lines = LineMap::new(&def.text);
            for diag in &def.model.diagnostics {
                let mut entry = diag_json(diag, &lines);
                entry["file"] = json!(def.rel_path);
                findings.push(entry);
            }
        }
        if let Some(text) = &self.types_text {
            let lines = LineMap::new(text);
            for diag in &self.types.diagnostics {
                let mut entry = diag_json(diag, &lines);
                entry["file"] = json!("scripts/entity_defs/types.xml");
                findings.push(entry);
            }
        }
        let mut topology: Vec<Value> = Vec::new();
        if let Some(path) = manifest_path {
            match std::fs::read_to_string(path) {
                Ok(manifest_text) => {
                    let defs = self
                        .defs
                        .values()
                        .map(|d| DefInput {
                            name: d.name.clone(),
                            category: d.category.clone(),
                            file_path: d.rel_path.clone(),
                            text: d.text.clone(),
                        })
                        .collect();
                    for finding in validate_process_topology(
                        &manifest_text,
                        self.entities_xml_text.as_deref(),
                        defs,
                    ) {
                        topology.push(json!({
                            "target": finding.target,
                            "file": finding.file_path,
                            "line": finding.line,
                            "severity": finding.severity,
                            "code": finding.code,
                            "message": finding.message,
                        }));
                    }
                }
                Err(error) => {
                    findings.push(json!({
                        "file": path,
                        "line": 1,
                        "code": "ManifestUnreadable",
                        "message": error.to_string(),
                    }));
                }
            }
        }
        json!({ "findings": findings, "processTopology": topology })
    }

    /// get_message_entry:kode-server 消息表(C-15)按实体构建,可选按方法名
    /// 过滤;返回带 utype/aliasID/参数布局的表条目。
    pub fn get_message_entry(&self, entity: &str, method: Option<&str>) -> Result<Value, String> {
        let table = self.message_table(entity)?;
        let needle = method.map(str::to_lowercase);
        let methods: Vec<Value> = table
            .get("methods")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|entry| match &needle {
                Some(needle) => entry
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.to_lowercase().contains(needle)),
                None => true,
            })
            .collect();
        Ok(json!({
            "entity": entity,
            "entries": methods,
            "loadFailed": table.get("loadFailed").cloned().unwrap_or(Value::Bool(false)),
            "issues": table.get("issues").cloned().unwrap_or(Value::Array(vec![])),
        }))
    }

    /// 消息表全量(C-15 直调,经 RpcRegistry 同源)。
    pub fn message_table(&self, entity: &str) -> Result<Value, String> {
        let def = self
            .defs
            .get(entity)
            .ok_or_else(|| format!("entity not found: {entity}"))?;
        let mut defs = BTreeMap::new();
        let mut paths = BTreeMap::new();
        for (name, parsed) in &self.defs {
            defs.insert(name.clone(), parsed.text.clone());
            paths.insert(name.clone(), parsed.rel_path.clone());
        }
        let params = json!({
            "entityName": entity,
            "defText": def.text,
            "typesXml": self.types_text,
            "defs": defs,
            "paths": paths,
        });
        Self::rpc_registry().dispatch("$/kode/messageTable/build", params)
    }

    /// encode_decode_sample:类型名 + JSON 值 → 线格式字节样本(hex)+
    /// 回解码(roundtrip 自检)。经 kode-server wire_codec(C-15 同源)。
    /// `value` 用朴素 JSON(整数/浮点/布尔/字符串/数组/对象),按解析出的
    /// 布局映射到线值;也可直接传带标签形式(如 `{"U16": 7}`)。
    pub fn encode_decode_sample(&self, type_name: &str, value: &Value) -> Result<Value, String> {
        let resolver = WireSchema::from_sources(
            self.types_text.as_deref().unwrap_or(""),
            self.alias_text.as_deref().unwrap_or(""),
        );
        let layout = resolver.resolve(type_name).map_err(|e| e.to_string())?;
        let wire = wire_from_json(&layout, value)?;
        let mut out = Vec::new();
        encode_value(&layout, &wire, &mut out).map_err(|e| e.to_string())?;
        let mut cursor = WireCursor::new(&out);
        let decoded = decode_value(&layout, &mut cursor).map_err(|e| e.to_string())?;
        Ok(json!({
            "type": type_name,
            "hex": hex(&out),
            "byteLen": out.len(),
            "decoded": serde_json::to_value(&decoded).map_err(|e| e.to_string())?,
        }))
    }

    /// db_schema_preview:kode-server 数据库 schema(C-16 直调)def→DDL 预览;
    /// entity 缺省=全部实体逐个推导。
    pub fn db_schema_preview(&self, entity: Option<&str>) -> Result<Value, String> {
        let mut tables = Vec::new();
        let mut errors = Vec::new();
        let mut seen = 0usize;
        for (name, def) in &self.defs {
            if def.category != "entity" {
                continue;
            }
            if entity.is_some_and(|want| want != name) {
                continue;
            }
            seen += 1;
            let properties: Vec<Value> = def
                .model
                .properties
                .iter()
                .map(|p| {
                    json!({
                        "name": p.name,
                        "typeName": p.type_name.as_deref().unwrap_or_default(),
                        "persistent": p.persistent.unwrap_or(false),
                        "databaseLength": p.database_length.as_deref().and_then(|s| s.parse::<i64>().ok()),
                        "defaultValue": p.default_value,
                        "identifier": p.identifier.is_some(),
                        "flags": p.flags.join(" "),
                        "scopes": flag_domains(&p.flags),
                        "source": {
                            "filePath": def.rel_path,
                            "line": p.line,
                            "path": format!("{}/{}", def.name, p.name),
                            "category": "entity",
                        },
                    })
                })
                .collect();
            let has_cell_content = !def.model.cell_methods.is_empty()
                || !def.model.components.is_empty()
                || def
                    .model
                    .properties
                    .iter()
                    .any(|p| flag_domains(&p.flags).contains(&"cell"));
            let params = json!({
                "entityName": name,
                "defFilePath": def.rel_path,
                "properties": properties,
                "hasCellContent": has_cell_content,
            });
            match Self::rpc_registry().dispatch("$/kode/databaseSchema/build", params) {
                Ok(result) => {
                    if let Some(list) = result.get("tables").and_then(Value::as_array) {
                        tables.extend(list.clone());
                    }
                }
                Err(error) => errors.push(json!({"entity": name, "error": error})),
            }
        }
        if let Some(want) = entity {
            if seen == 0 {
                return Err(format!("entity not found: {want}"));
            }
        }
        Ok(json!({ "tables": tables, "errors": errors }))
    }
}

fn summarize(model: &DefFile) -> Value {
    json!({
        "properties": model.properties.len(),
        "baseMethods": model.base_methods.len(),
        "cellMethods": model.cell_methods.len(),
        "clientMethods": model.client_methods.len(),
        "components": model.components.len(),
        "parent": model.parent,
    })
}

/// 组件槽类型树(带递归路径去环守卫):沿 component 槽解析组件 def 并递归。
/// `seen` 为当前递归路径上的 def 名;再遇同名 def 即环(自引用/互引组件),
/// 以 `"cycle": true` 标记该槽、不再展开,避免无限递归栈溢出(审核发现)。
fn component_types_deep(
    kb: &AssetKnowledge,
    model: &DefFile,
    seen: &mut Vec<String>,
) -> Vec<Value> {
    let mut out = Vec::new();
    for slot in &model.components {
        let Some(component_type) = &slot.component_type else {
            continue;
        };
        // 组件槽类型:先按槽类型名查 def(组件 def 本体),再按槽名兜底。
        let resolved = kb
            .defs
            .get(component_type)
            .or_else(|| kb.defs.get(&slot.name));
        let mut entry = json!({
            "slot": slot.name,
            "type": component_type,
        });
        if let Some(component_def) = resolved {
            entry["file"] = json!(component_def.rel_path);
            if seen.contains(&component_def.name) {
                // 环:该 def 已在当前路径上(自引用/互引)→ 标记循环,不递归。
                entry["cycle"] = json!(true);
            } else {
                seen.push(component_def.name.clone());
                entry["componentTypes"] =
                    json!(component_types_deep(kb, &component_def.model, seen));
                seen.pop();
            }
        }
        out.push(entry);
    }
    out
}

fn diag_json(diag: &kode_parser::diag::Diagnostic, lines: &LineMap) -> Value {
    json!({
        "line": lines.line_of(diag.span.start),
        "code": format!("{:?}", diag.code),
        "message": diag.message,
    })
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 朴素 JSON → 线值:按布局选 WireValue 变体;带标签对象(`{"U16": 7}`)直取。
fn wire_from_json(layout: &WireLayout, value: &Value) -> Result<WireValue, String> {
    // 带标签形式只在**标量**布局下优先(与 WireValue 的 serde 形状一致);
    // 复合布局(容器/结构)的单键对象是普通字典/结构,不得当带标签值——
    // 否则单字段 FIXED_DICT `{"hp":100}` 被误判为 `tagged value hp ...`,
    // 且字段名恰为 tag 名(如字段 `Str`)也被误认(审核发现)。
    let is_scalar_layout = !matches!(layout, WireLayout::FixedDict(_) | WireLayout::Array(_));
    if is_scalar_layout {
        if let Some(map) = value.as_object() {
            if map.len() == 1 {
                let (tag, inner) = map.iter().next().unwrap();
                let from_inner: Result<WireValue, String> = match tag.as_str() {
                    "U8" => inner.as_u64().map(|v| WireValue::U8(v as u8)),
                    "U16" => inner.as_u64().map(|v| WireValue::U16(v as u16)),
                    "U32" => inner.as_u64().map(|v| WireValue::U32(v as u32)),
                    "U64" => inner.as_u64().map(WireValue::U64),
                    "I8" => inner.as_i64().map(|v| WireValue::I8(v as i8)),
                    "I16" => inner.as_i64().map(|v| WireValue::I16(v as i16)),
                    "I32" => inner.as_i64().map(|v| WireValue::I32(v as i32)),
                    "I64" => inner.as_i64().map(WireValue::I64),
                    "F32" => inner.as_f64().map(|v| WireValue::F32(v as f32)),
                    "F64" => inner.as_f64().map(WireValue::F64),
                    "Bool" => inner.as_bool().map(WireValue::Bool),
                    "Str" => inner.as_str().map(|s| WireValue::Str(s.to_string())),
                    _ => None,
                }
                .ok_or_else(|| format!("tagged value {tag} payload type mismatch"));
                if from_inner.is_ok() || !inner.is_object() {
                    return from_inner;
                }
                return serde_json::from_value(value.clone()).map_err(|e| format!("value: {e}"));
            }
        }
    }
    match layout {
        WireLayout::U8 => Ok(WireValue::U8(u64_from(value)? as u8)),
        WireLayout::U16 => Ok(WireValue::U16(u64_from(value)? as u16)),
        WireLayout::U32 => Ok(WireValue::U32(u64_from(value)? as u32)),
        WireLayout::U64 => Ok(WireValue::U64(u64_from(value)?)),
        WireLayout::I8 => Ok(WireValue::I8(i64_from(value)? as i8)),
        WireLayout::I16 => Ok(WireValue::I16(i64_from(value)? as i16)),
        WireLayout::I32 => Ok(WireValue::I32(i64_from(value)? as i32)),
        WireLayout::I64 => Ok(WireValue::I64(i64_from(value)?)),
        WireLayout::F32 => Ok(WireValue::F32(f64_from(value)? as f32)),
        WireLayout::F64 => Ok(WireValue::F64(f64_from(value)?)),
        WireLayout::Bool => Ok(WireValue::Bool(
            value.as_bool().ok_or("expected bool for Bool layout")?,
        )),
        WireLayout::Str => Ok(WireValue::Str(
            value
                .as_str()
                .ok_or("expected string for Str layout")?
                .to_string(),
        )),
        WireLayout::Unicode => Ok(WireValue::Unicode(
            value
                .as_str()
                .ok_or("expected string for Unicode layout")?
                .as_bytes()
                .to_vec(),
        )),
        WireLayout::Blob => Ok(WireValue::Blob(
            value
                .as_str()
                // 字节按字符串原文逐字节入 blob,不做 base64/hex 解码——
                // 提示不得宣称解码(审核发现:文案与行为不符)。
                .ok_or("expected string for Blob (bytes taken verbatim)")?
                .as_bytes()
                .to_vec(),
        )),
        WireLayout::Array(inner) => {
            let items = value.as_array().ok_or("expected array for Array layout")?;
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(wire_from_json(inner, item)?);
            }
            Ok(WireValue::Array(out))
        }
        WireLayout::FixedDict(fields) => {
            let map = value
                .as_object()
                .ok_or("expected object for FixedDict layout")?;
            // 引擎位置序:按字段声明序收集值(WireValue::FixedDict(Vec<WireValue>))。
            let mut out = Vec::with_capacity(fields.len());
            for field in fields {
                let item = map
                    .get(&field.name)
                    .ok_or_else(|| format!("missing FixedDict field: {}", field.name))?;
                out.push(wire_from_json(&field.layout, item)?);
            }
            Ok(WireValue::FixedDict(out))
        }
        other => Err(format!(
            "layout {other:?} not supported for plain-JSON input; use the tagged form"
        )),
    }
}

fn u64_from(value: &Value) -> Result<u64, String> {
    value
        .as_u64()
        .ok_or_else(|| format!("expected unsigned integer, got {value}"))
}

fn i64_from(value: &Value) -> Result<i64, String> {
    value
        .as_i64()
        .ok_or_else(|| format!("expected integer, got {value}"))
}

fn f64_from(value: &Value) -> Result<f64, String> {
    value
        .as_f64()
        .ok_or_else(|| format!("expected number, got {value}"))
}

fn read_opt(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn collect_defs(dir: &Path, prefix: &str, kb: &mut AssetKnowledge) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        if !prefix.is_empty() {
            kb.load_errors
                .push(format!("unreadable dir: {}", dir.display()));
        }
        return;
    };
    let mut entries: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let rel = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };
        if path.is_dir() {
            collect_defs(&path, &rel, kb);
        } else if name.to_lowercase().ends_with(".def") {
            let stem = name.trim_end_matches(".def").to_string();
            match std::fs::read_to_string(&path) {
                Ok(text) => {
                    let category = if prefix == "interfaces" {
                        "interface"
                    } else if prefix == "components" {
                        "component"
                    } else {
                        "entity"
                    }
                    .to_string();
                    let model = parse_def(&text);
                    kb.defs.insert(
                        stem.clone(),
                        ParsedDef {
                            name: stem,
                            category,
                            rel_path: format!("scripts/entity_defs/{rel}"),
                            text,
                            model,
                        },
                    );
                }
                Err(error) => kb.load_errors.push(format!("{rel}: {error}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_server::wire_codec::WireField;

    #[test]
    fn single_key_object_is_plain_fixed_dict_not_tagged() {
        // 单字段 FIXED_DICT `{"hp":100}`:键 hp 非已知 tag → 必须是普通结构,
        // 不得被误判为带标签值(审核发现旧码返回 tagged value hp ... 错误)。
        let layout = WireLayout::FixedDict(vec![WireField {
            name: "hp".into(),
            layout: WireLayout::U32,
        }]);
        let value = serde_json::json!({"hp": 100});
        let wire = wire_from_json(&layout, &value).unwrap();
        assert_eq!(wire, WireValue::FixedDict(vec![WireValue::U32(100)]));
    }

    #[test]
    fn dict_field_named_like_tag_is_not_mistaken_for_tagged() {
        // 字段名恰为 tag 名(如 `Str`):单字段 FIXED_DICT `{"Str":"x"}` 按布局
        // 解码为 Str 字段值,而非把整个对象当带标签 Str 值。
        let layout = WireLayout::FixedDict(vec![WireField {
            name: "Str".into(),
            layout: WireLayout::Str,
        }]);
        let value = serde_json::json!({"Str": "x"});
        let wire = wire_from_json(&layout, &value).unwrap();
        assert_eq!(wire, WireValue::FixedDict(vec![WireValue::Str("x".into())]));
    }

    #[test]
    fn scalar_layout_still_accepts_tagged_form() {
        // 标量布局的带标签形式不受影响(往返无损入口)。
        let wire = wire_from_json(&WireLayout::U16, &serde_json::json!({"U16": 7})).unwrap();
        assert_eq!(wire, WireValue::U16(7));
    }
}

#[test]
fn component_types_deep_marks_self_reference_cycle_without_infinite_recursion() {
    // 自引用组件:A 的槽 Type=A → 递归再入 A,旧码无限递归栈溢出;
    // 修复后以 cycle 标记不再展开,深度有界。
    let mut kb = AssetKnowledge::default();
    let text = "<root><Components><selfSlot><Type>A</Type></selfSlot></Components></root>";
    let model = parse_def(text);
    kb.defs.insert(
        "A".into(),
        ParsedDef {
            name: "A".into(),
            category: "component".into(),
            rel_path: "scripts/entity_defs/components/A.def".into(),
            text: text.into(),
            model,
        },
    );
    let out = component_types_deep(&kb, &kb.defs["A"].model, &mut Vec::new());
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["type"], "A");
    // 环标记落在再入层,不再展开 componentTypes。
    let nested = out[0]["componentTypes"].as_array().unwrap();
    assert_eq!(nested.len(), 1);
    assert_eq!(nested[0]["cycle"], true);
    assert!(nested[0].get("componentTypes").is_none());
}

#[test]
fn component_types_deep_marks_mutual_reference_cycle() {
    // 互引组件 A↔B:A→B→A→B… 旧码无限递归;修复后有界并以 cycle 标记。
    let mut kb = AssetKnowledge::default();
    let a_text = "<root><Components><bSlot><Type>B</Type></bSlot></Components></root>";
    let b_text = "<root><Components><aSlot><Type>A</Type></aSlot></Components></root>";
    let def = |name: &str, text: &str| ParsedDef {
        name: name.into(),
        category: "component".into(),
        rel_path: format!("scripts/entity_defs/components/{name}.def"),
        text: text.into(),
        model: parse_def(text),
    };
    kb.defs.insert("A".into(), def("A", a_text));
    kb.defs.insert("B".into(), def("B", b_text));
    let out = component_types_deep(&kb, &kb.defs["A"].model, &mut Vec::new());
    // A→B→A→B:第二层 B 的 bSlot 命中路径上的 B → cycle。
    assert_eq!(out[0]["type"], "B");
    let lvl2 = out[0]["componentTypes"].as_array().unwrap();
    assert_eq!(lvl2[0]["type"], "A");
    let lvl3 = lvl2[0]["componentTypes"].as_array().unwrap();
    assert_eq!(lvl3[0]["cycle"], true);
}
