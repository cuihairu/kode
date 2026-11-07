//! 项目目录 → [`Schema`] 的装配器(磁盘面;kode-vfs 读缓存)。

use std::path::Path;

use kode_vfs::disk::DiskCache;

use crate::layout::{self, AliasMap};
use crate::messages::{build_message_table, MessageTable};
use crate::schema::{EntityWireInfo, Schema};

/// 构建选项。
#[derive(Debug, Clone, Default)]
pub struct BuildOptions {
    /// §4.3 packetAlwaysContainLength(引擎默认 false;true 时所有消息按
    /// 线上可变建模,message_handler.cpp:173-175)。
    pub packet_always_contain_length: bool,
}

/// 构建失败(项目结构不满足最小要求;坏文件走诊断不失败)。
#[derive(Debug)]
pub struct BuildError(pub String);

impl std::fmt::Display for BuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "kbengine schema build error: {}", self.0)
    }
}
impl std::error::Error for BuildError {}

/// 从项目资产根(`kbengine_<...>_assets/`,内含 `scripts/entities.xml` 等)
/// 构建完整 Schema。
///
/// `engine_fixed_defaults_xml` = 引擎 `kbe/res/server/messages_fixed_defaults.xml`
/// 原文(固定表基准;调用方自带,crate 不绑引擎仓库路径)。项目
/// `res/server/messages_fixed.xml` 存在则作为覆盖段并入;`kbengine.xml` /
/// `kbengine_defaults.xml` 存在则读 `<packetAlwaysContainLength>`。
pub fn build_schema_from_project(
    project_root: &Path,
    engine_fixed_defaults_xml: Option<&str>,
    opts: &BuildOptions,
) -> Result<Schema, BuildError> {
    let scripts = project_root.join("scripts");
    if !scripts.is_dir() {
        return Err(BuildError(format!(
            "not a KBEngine asset root (no scripts/ dir): {}",
            project_root.display()
        )));
    }

    let mut diagnostics: Vec<String> = Vec::new();
    let mut cache = DiskCache::new();
    let mut read = |path: &Path, acc: &mut Vec<String>| -> Option<String> {
        match cache.load(path) {
            Ok(buf) => Some(buf.text().to_string()),
            Err(e) => {
                // 诊断走相对项目根的路径(快照/日志跨机器可对拍)。
                let shown = path.strip_prefix(project_root).unwrap_or(path);
                acc.push(format!("{}: unreadable ({e})", shown.display()));
                None
            }
        }
    };

    // ---- types.xml / alias.xml → 别名线类型表 ----
    let defs_dir = scripts.join("entity_defs");
    let types_xml = read(&defs_dir.join("types.xml"), &mut diagnostics);
    let alias_xml = read(&defs_dir.join("alias.xml"), &mut diagnostics);
    let raw = layout::collect_raw_types(
        types_xml.as_deref().unwrap_or("<root></root>"),
        alias_xml.as_deref(),
    );
    let aliases: AliasMap = layout::resolve_alias_map(&raw);

    // ---- entities.xml + *.def → 实体线格式 ----
    let entities_xml = read(&scripts.join("entities.xml"), &mut diagnostics)
        .ok_or_else(|| BuildError("scripts/entities.xml missing".into()))?;
    let registered = layout::entity_registered(&entities_xml);

    let mut load_def = |name: &str| -> Option<kode_parser::model::DefFile> {
        let path = defs_dir.join(format!("{name}.def"));
        let text = read(&path, &mut diagnostics)?;
        Some(kode_parser::model::parse_def(&text))
    };

    let mut entities = std::collections::BTreeMap::new();
    let mut missing_entities: Vec<String> = Vec::new();
    for (name, _attrs) in &registered {
        match layout::entity_wire_info(name, &mut load_def, &raw) {
            Some(info) => {
                entities.insert(name.clone(), info);
            }
            None => missing_entities.push(name.clone()),
        }
    }

    // ---- 固定消息表:引擎默认 + 项目覆盖 ----
    let mut defaults_xml_text: Option<String> = engine_fixed_defaults_xml.map(str::to_string);
    if defaults_xml_text.is_none() {
        // 允许项目 res/server/messages_fixed_defaults.xml 兜底(引擎也按
        // res/server 解析该文件;不存在则表为空段)。
        defaults_xml_text = read(
            &project_root.join("res/server/messages_fixed_defaults.xml"),
            &mut diagnostics,
        );
    }
    let project_fixed = read(
        &project_root.join("res/server/messages_fixed.xml"),
        &mut diagnostics,
    );
    let mut messages: MessageTable = build_message_table(
        defaults_xml_text.as_deref().unwrap_or("<root></root>"),
        project_fixed.as_deref(),
    );
    if defaults_xml_text.is_none() {
        diagnostics.push(
            "engine messages_fixed_defaults.xml not provided: fixed table = project segment only"
                .into(),
        );
    }

    // ---- packetAlwaysContainLength(项目配置覆盖引擎默认) ----
    let mut always_len = opts.packet_always_contain_length;
    for cfg in [
        "res/server/kbengine.xml",
        "res/server/kbengine_defaults.xml",
    ] {
        if let Some(text) = read(&project_root.join(cfg), &mut diagnostics) {
            if let Some(v) = parse_truthy_tag(&text, "packetAlwaysContainLength") {
                always_len = v;
            }
        }
    }
    if always_len {
        // §4.3:所有消息按变长建模(含原定长)。
        for e in &mut messages.entries {
            e.length = crate::messages::MessageLength::Variable;
        }
    }

    let schema = Schema {
        schema_version: Schema::SCHEMA_VERSION,
        engine_baseline: Schema::ENGINE_BASELINE.to_string(),
        packet_always_contain_length: always_len,
        aliases,
        entities,
        missing_entities,
        messages,
        diagnostics,
    };
    Ok(schema)
}

/// `<tag> 1|true|True </tag>` 语义(引擎 serverconfig 的布尔读取近似:
/// 数字 0=假 / 非 0=真,布尔字面量按大小写不敏感;标签缺失 = None)。
fn parse_truthy_tag(xml_text: &str, tag: &str) -> Option<bool> {
    let doc = kode_parser::xml::parse(xml_text, false);
    let root = doc.root()?;
    let el = doc.child_element(root, tag)?;
    let raw = doc.element(el).text(&doc).trim().to_ascii_lowercase();
    if raw.is_empty() {
        return None;
    }
    Some(raw != "0" && raw != "false" && raw != "no")
}

// EntityWireInfo 未在本文件使用时保留导入名(构建期消警)。
#[allow(unused)]
fn _type_witness(_: &EntityWireInfo) {}
