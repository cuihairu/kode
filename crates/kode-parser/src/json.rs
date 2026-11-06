//! 对拍 golden 序列化:零依赖 JSON 写出(只写不读;读取交 TS 侧 JSON.parse)。
//!
//! 输出形状由 dump 函数决定,须与 tests/kodeParserParity.test.ts 的 TS 提取器
//! 逐字段一致(结构/字段名/空值语义),任何一侧改动都要重新生成 golden 并
//! 让两侧门禁同时过。

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;

use crate::config::{merge_config_xml, parse_config};
use crate::model::{parse_alias, parse_entities, parse_types, TypeKind};
use crate::xml::Document;

/// 对拍语料(仓库相对路径;顺序无关,输出按路径排序确定性生成)。
pub const PARITY_CORPORA: &[&str] = &[
    "tests/fixtures/kbengine-demo-assets",
    "tests/fixtures/parity-project",
    "tests/fixtures/electron-ws",
    "tests/fixtures/kbengine-tpl-scripts",
];

/// 收集语料:*.def + entities.xml/types.xml/alias.xml(排序遍历保证确定性)。
pub fn collect_corpus(
    repo_root: &Path,
    corpora: &[&str],
) -> BTreeMap<String, (&'static str, String)> {
    fn walk(dir: &Path, rel_prefix: &str, out: &mut BTreeMap<String, (&'static str, String)>) {
        let mut entries: Vec<std::path::PathBuf> = match std::fs::read_dir(dir) {
            Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
            Err(_) => return,
        };
        entries.sort();
        for path in entries {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            let rel = format!("{rel_prefix}/{name}");
            if path.is_dir() {
                walk(&path, &rel, out);
                continue;
            }
            let kind = if name.ends_with(".def") {
                "def"
            } else if name == "entities.xml" {
                "entities"
            } else if name == "types.xml" {
                "types"
            } else if name == "alias.xml" {
                "alias"
            } else {
                continue;
            };
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            out.insert(rel, (kind, text));
        }
    }
    let mut out = BTreeMap::new();
    for corpus in corpora {
        walk(&repo_root.join(corpus), corpus, &mut out);
    }
    out
}

/// 整个语料的 golden JSON(与 tests/kodeParserParity.test.ts 的 TS 提取器逐字段一致)。
pub fn dump_corpus(repo_root: &Path) -> String {
    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let mut w = JsonWriter::new();
    w.raw("{\"generator\":\"kode-parser dump-golden\",\"fileCount\":");
    w.num(files.len());
    w.raw(",\"files\":[");
    for (i, (file, (kind, text))) in files.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("{\"file\":");
        w.str(file);
        w.raw(",\"kind\":");
        w.str(kind);
        w.raw(",\"record\":");
        w.buf.push_str(&record_json(kind, text));
        w.raw("}");
    }
    w.raw("]}");
    w.buf
}

/// 单个语料文件的 golden 记录。
#[derive(Debug, Clone, PartialEq)]
pub struct FileRecord {
    /// 相对 fixture 根的路径(统一 `/` 分隔)。
    pub file: String,
    pub kind: &'static str,
    pub json: String,
}

/// 小型 JSON 输出器(确保转义正确,零依赖)。
#[derive(Debug, Clone)]
pub struct JsonWriter {
    pub buf: String,
}

impl JsonWriter {
    pub fn new() -> JsonWriter {
        JsonWriter { buf: String::new() }
    }

    pub fn raw(&mut self, s: &str) -> &mut Self {
        self.buf.push_str(s);
        self
    }

    pub fn str(&mut self, s: &str) -> &mut Self {
        self.buf.push('"');
        for c in s.chars() {
            match c {
                '"' => self.buf.push_str("\\\""),
                '\\' => self.buf.push_str("\\\\"),
                '\n' => self.buf.push_str("\\n"),
                '\r' => self.buf.push_str("\\r"),
                '\t' => self.buf.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    let _ = write!(self.buf, "\\u{:04x}", c as u32);
                }
                c => self.buf.push(c),
            }
        }
        self.buf.push('"');
        self
    }

    pub fn num(&mut self, n: usize) -> &mut Self {
        let _ = write!(self.buf, "{n}");
        self
    }

    pub fn opt_str(&mut self, v: Option<&str>) -> &mut Self {
        match v {
            Some(s) => self.str(s),
            None => self.raw("null"),
        }
    }

    pub fn opt_bool(&mut self, v: Option<bool>) -> &mut Self {
        match v {
            Some(b) => self.raw(if b { "true" } else { "false" }),
            None => self.raw("null"),
        }
    }

    pub fn boolean(&mut self, b: bool) -> &mut Self {
        self.raw(if b { "true" } else { "false" })
    }
}

impl Default for JsonWriter {
    fn default() -> Self {
        JsonWriter::new()
    }
}

/// 解析单个文件文本并产出 golden JSON(不含外层 file/kind 包装)。
pub fn record_json(kind: &str, text: &str) -> String {
    let mut w = JsonWriter::new();
    match kind {
        "def" => {
            let doc = crate::xml::parse(text, true);
            let def = crate::model::extract_def(&doc, text);
            dump_def(&mut w, &doc, &def);
        }
        "entities" => {
            let e = parse_entities(text);
            dump_entities(&mut w, &e);
        }
        "types" => {
            let t = parse_types(text);
            dump_types(&mut w, &t);
        }
        "alias" => {
            let a = parse_alias(text);
            dump_alias(&mut w, &a);
        }
        _ => unreachable!("unknown kind"),
    }
    w.buf
}

fn dump_def(w: &mut JsonWriter, doc: &Document, def: &crate::model::DefFile) {
    w.raw("{\"root\":");
    w.opt_str(def.root_tag.as_deref());
    w.raw(",\"parent\":");
    w.opt_str(def.parent.as_deref());
    w.raw(",\"interfaces\":");
    str_array(w, &def.interfaces);
    w.raw(",\"volatile\":");
    w.boolean(def.volatile);
    w.raw(",\"properties\":[");
    for (i, p) in def.properties.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("{\"name\":");
        w.str(&p.name);
        w.raw(",\"type\":");
        w.opt_str(p.type_name.as_deref());
        w.raw(",\"flags\":");
        str_array(w, &p.flags);
        w.raw(",\"detailLevel\":");
        w.opt_str(p.detail_level.as_deref());
        w.raw(",\"persistent\":");
        w.opt_bool(p.persistent);
        w.raw(",\"sensitive\":");
        w.boolean(p.sensitive);
        w.raw(",\"line\":");
        w.num(p.line);
        w.raw("}");
    }
    w.raw("],\"components\":[");
    for (i, c) in def.components.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("{\"name\":");
        w.str(&c.name);
        w.raw(",\"type\":");
        w.opt_str(c.component_type.as_deref());
        w.raw(",\"persistent\":");
        w.opt_bool(c.persistent);
        w.raw(",\"line\":");
        w.num(c.line);
        w.raw("}");
    }
    w.raw("]");
    for (key, methods) in [
        ("baseMethods", &def.base_methods),
        ("cellMethods", &def.cell_methods),
        ("clientMethods", &def.client_methods),
    ] {
        w.raw(",\"");
        w.buf.push_str(key);
        w.raw("\":[");
        for (i, m) in methods.iter().enumerate() {
            if i > 0 {
                w.raw(",");
            }
            w.raw("{\"name\":");
            w.str(&m.name);
            w.raw(",\"args\":");
            str_array(w, &m.args);
            w.raw(",\"exposed\":");
            w.boolean(m.exposed);
            w.raw(",\"line\":");
            w.num(m.line);
            w.raw("}");
        }
        w.raw("]");
    }
    w.raw(",\"extraSections\":[");
    for (i, (name, _)) in def.extra_sections.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.str(name);
    }
    w.raw("],\"syntaxErrorCount\":");
    w.num(
        doc.diagnostics
            .iter()
            .filter(|d| d.severity == crate::diag::Severity::Error)
            .count(),
    );
    w.raw("}");
}

fn dump_entities(w: &mut JsonWriter, e: &crate::model::EntitiesFile) {
    w.raw("{\"entities\":[");
    for (i, ent) in e.entities.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("{\"name\":");
        w.str(&ent.name);
        w.raw(",\"attrs\":{");
        for (j, (k, v)) in ent.attributes.iter().enumerate() {
            if j > 0 {
                w.raw(",");
            }
            w.str(k);
            w.raw(":");
            w.str(v);
        }
        w.raw("},\"line\":");
        w.num(ent.line);
        w.raw("}");
    }
    w.raw("]}");
}

fn dump_types(w: &mut JsonWriter, t: &crate::model::TypesFile) {
    w.raw("{\"types\":[");
    for (i, ty) in t.types.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("{\"name\":");
        w.str(&ty.name);
        w.raw(",\"kind\":");
        w.str(match ty.kind {
            TypeKind::FixedDict => "fixedDict",
            TypeKind::Array => "array",
            TypeKind::Builtin => "builtin",
        });
        w.raw(",\"implementedBySymbol\":");
        w.opt_str(ty.implemented_by_symbol.as_deref());
        w.raw(",\"fieldRefs\":");
        str_array(w, &ty.field_refs);
        w.raw(",\"elementRef\":");
        w.opt_str(ty.element_ref.as_deref());
        w.raw(",\"line\":");
        w.num(ty.line);
        w.raw("}");
    }
    w.raw("]}");
}

fn dump_alias(w: &mut JsonWriter, a: &crate::model::AliasFile) {
    w.raw("{\"aliases\":[");
    for (i, al) in a.aliases.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("{\"name\":");
        w.str(&al.name);
        w.raw(",\"aliasType\":");
        w.str(&al.alias_type);
        w.raw(",\"line\":");
        w.num(al.line);
        w.raw("}");
    }
    w.raw("]}");
}

fn str_array(w: &mut JsonWriter, items: &[String]) {
    w.raw("[");
    for (i, s) in items.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.str(s);
    }
    w.raw("]");
}

// --- 配置域对拍(KODE-CFG-002) ---

/// 配置语料(仓库相对路径;全部 `.xml`,含 edge/ 边界集)。
pub const CONFIG_CORPORA: &[&str] = &["tests/fixtures/config"];

/// 收集配置语料:递归收 `.xml` 文件(排序遍历保证确定性)。
pub fn collect_config_corpus(repo_root: &Path) -> BTreeMap<String, String> {
    fn walk(dir: &Path, rel_prefix: &str, out: &mut BTreeMap<String, String>) {
        let mut entries: Vec<std::path::PathBuf> = match std::fs::read_dir(dir) {
            Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
            Err(_) => return,
        };
        entries.sort();
        for path in entries {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            let rel = format!("{rel_prefix}/{name}");
            if path.is_dir() {
                walk(&path, &rel, out);
                continue;
            }
            if !name.ends_with(".xml") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            out.insert(rel, text);
        }
    }
    let mut out = BTreeMap::new();
    for corpus in CONFIG_CORPORA {
        walk(&repo_root.join(corpus), corpus, &mut out);
    }
    out
}

/// 整个配置语料的 golden JSON(与 tests/configParity.test.ts 的 TS 提取器逐字段一致)。
pub fn dump_config_corpus(repo_root: &Path) -> String {
    let files = collect_config_corpus(repo_root);
    let mut w = JsonWriter::new();
    w.raw("{\"generator\":\"kode-parser dump-config-golden\",\"fileCount\":");
    w.num(files.len());
    w.raw(",\"files\":[");
    for (i, (file, text)) in files.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("{\"file\":");
        w.str(file);
        w.raw(",\"record\":");
        match parse_config(text) {
            Some(node) => dump_config_node(&mut w, &node),
            None => {
                w.raw("null");
            }
        }
        w.raw("}");
    }
    w.raw("]}");
    w.buf
}

/// 配置树 golden 记录(镜像 TS `ConfigXmlNode` 提取字段)。
pub fn dump_config_node(w: &mut JsonWriter, node: &crate::config::ConfigNode) {
    w.raw("{\"name\":");
    w.str(&node.name);
    w.raw(",\"text\":");
    w.str(&node.text);
    w.raw(",\"children\":[");
    for (i, c) in node.children.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        dump_config_node(w, c);
    }
    w.raw("],\"sourceComments\":");
    str_array(w, &node.source_comments);
    w.raw("}");
}

// --- 配置合并对拍(KODE-CFG-003) ---

/// 合并对拍语料(base, override)XML 对(仓库相对路径;每对先 parse 后 merge,
/// 输出 merge(base, override) 树记录)。
pub const CONFIG_MERGE_PAIRS: &[(&str, &str)] = &[
    // 真实路径:引擎 defaults 为基、元件 kbengine.xml 覆盖(顶层单 `<root>` 递归下钻)
    (
        "tests/fixtures/config/kbengine_defaults.xml",
        "tests/fixtures/config/kbengine.xml",
    ),
    // 分支覆盖:单名叶子替换 / 仅 base / 仅 override / 双容器递归 / 容器↔叶子双向 /
    // 重复名整表替换双向 / 注释合并去重与 override 优先 / 名字序 / 深层递归
    (
        "tests/fixtures/config/merge/m01_leaf_base.xml",
        "tests/fixtures/config/merge/m01_leaf_override.xml",
    ),
    (
        "tests/fixtures/config/merge/m02_base_only_base.xml",
        "tests/fixtures/config/merge/m02_base_only_override.xml",
    ),
    (
        "tests/fixtures/config/merge/m03_override_only_base.xml",
        "tests/fixtures/config/merge/m03_override_only_override.xml",
    ),
    (
        "tests/fixtures/config/merge/m04_both_containers_base.xml",
        "tests/fixtures/config/merge/m04_both_containers_override.xml",
    ),
    (
        "tests/fixtures/config/merge/m05_container_vs_leaf_base.xml",
        "tests/fixtures/config/merge/m05_container_vs_leaf_override.xml",
    ),
    (
        "tests/fixtures/config/merge/m06_leaf_vs_container_base.xml",
        "tests/fixtures/config/merge/m06_leaf_vs_container_override.xml",
    ),
    (
        "tests/fixtures/config/merge/m07_repeat_base.xml",
        "tests/fixtures/config/merge/m07_repeat_override.xml",
    ),
    (
        "tests/fixtures/config/merge/m08_repeat_override_base.xml",
        "tests/fixtures/config/merge/m08_repeat_override_override.xml",
    ),
    (
        "tests/fixtures/config/merge/m09_comment_base.xml",
        "tests/fixtures/config/merge/m09_comment_override.xml",
    ),
    (
        "tests/fixtures/config/merge/m10_order_base.xml",
        "tests/fixtures/config/merge/m10_order_override.xml",
    ),
    (
        "tests/fixtures/config/merge/m11_nested_base.xml",
        "tests/fixtures/config/merge/m11_nested_override.xml",
    ),
];

/// 整个合并语料的 golden JSON(与 tests/configMergeParity.test.ts 的 TS 提取器
/// 逐字段一致;parse 任一侧失败则 record=null)。
pub fn dump_config_merge_corpus(repo_root: &Path) -> String {
    let mut w = JsonWriter::new();
    w.raw("{\"generator\":\"kode-parser dump-config-merge-golden\",\"pairCount\":");
    w.num(CONFIG_MERGE_PAIRS.len());
    w.raw(",\"pairs\":[");
    for (i, (base_path, override_path)) in CONFIG_MERGE_PAIRS.iter().enumerate() {
        if i > 0 {
            w.raw(",");
        }
        w.raw("{\"base\":");
        w.str(base_path);
        w.raw(",\"override\":");
        w.str(override_path);
        w.raw(",\"record\":");
        let base_text = std::fs::read_to_string(repo_root.join(base_path)).unwrap_or_default();
        let override_text =
            std::fs::read_to_string(repo_root.join(override_path)).unwrap_or_default();
        match (parse_config(&base_text), parse_config(&override_text)) {
            (Some(base), Some(over)) => {
                dump_config_node(&mut w, &merge_config_xml(&base, &over));
            }
            _ => {
                w.raw("null");
            }
        }
        w.raw("}");
    }
    w.raw("]}");
    w.buf
}
