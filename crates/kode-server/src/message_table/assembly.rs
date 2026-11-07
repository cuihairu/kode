//! MessageTable 中间装配状态。

use std::collections::{HashMap, HashSet};

// ---------------------------------------------------------------------------
// 中间装配态(TS ModuleAssembly 对应物)
// ---------------------------------------------------------------------------

pub(super) struct AsmType {
    pub(super) name: String,
    pub(super) utype: i64,
    pub(super) kind: &'static str,
    pub(super) aliased_to: Option<String>,
    pub(super) line: Option<usize>,
    pub(super) origin: String,
}

pub(super) struct AsmIssue {
    pub(super) kind: &'static str,
    pub(super) message: String,
    pub(super) fatal: bool,
    pub(super) line: Option<usize>,
}

pub(super) struct AsmArg {
    pub(super) name: String,
    pub(super) of_type: Option<Box<AsmArg>>,
    pub(super) utype: Option<i64>,
    pub(super) line: usize,
}

pub(super) struct AsmMethod {
    pub(super) name: String,
    pub(super) section: &'static str,
    pub(super) direction: &'static str,
    pub(super) visible_to_client: bool,
    pub(super) exposed: bool,
    pub(super) args: Vec<AsmArg>,
    pub(super) declared_utype: Option<i64>,
    pub(super) utype: Option<i64>,
    pub(super) alias_id: Option<i64>,
    pub(super) status: &'static str,
    pub(super) origin: String,
    pub(super) origin_kind: &'static str,
    pub(super) line: usize,
}

pub(super) struct AsmProperty {
    pub(super) name: String,
    pub(super) type_name: Option<String>,
    pub(super) flags: String,
    pub(super) has_client: bool,
    pub(super) utype: Option<i64>,
    pub(super) declared_utype: Option<i64>,
    pub(super) alias_id: Option<i64>,
    pub(super) persistent: Option<bool>,
    pub(super) origin: String,
    pub(super) origin_kind: &'static str,
    pub(super) line: usize,
}

pub(super) struct AsmSource {
    pub(super) name: String,
    pub(super) kind: &'static str,
    pub(super) file_path: String,
}

/// 装配态:引擎全局计数器与模块内已注册名的模拟(TS ModuleAssembly)。
pub(super) struct Assembly {
    pub(super) entity_name: String,
    pub(super) used_utypes: HashSet<i64>,
    pub(super) auto_counter: i64,
    pub(super) holders: HashMap<i64, String>,
    pub(super) property_used_utypes: HashSet<i64>,
    pub(super) property_auto_counter: i64,
    pub(super) property_holders: HashMap<i64, (String, HashSet<&'static str>)>,
    pub(super) method_names_by_section: HashMap<&'static str, HashSet<String>>,
    pub(super) all_method_names: HashSet<String>,
    pub(super) property_domains: HashMap<&'static str, HashSet<String>>,
    pub(super) all_property_names: HashSet<String>,
    pub(super) component_names: HashSet<String>,
    pub(super) registry: HashMap<String, i64>,
    pub(super) seen_component_types: HashSet<String>,
    pub(super) types: Vec<AsmType>,
    pub(super) issues: Vec<AsmIssue>,
    pub(super) next_type_utype: i64,
    pub(super) methods: Vec<AsmMethod>,
    pub(super) properties: Vec<AsmProperty>,
    pub(super) sources: Vec<AsmSource>,
    pub(super) visited: HashSet<String>,
}

impl Assembly {
    pub(super) fn new(entity_name: &str) -> Assembly {
        let mut method_names_by_section = HashMap::new();
        method_names_by_section.insert("CellMethods", HashSet::new());
        method_names_by_section.insert("BaseMethods", HashSet::new());
        method_names_by_section.insert("ClientMethods", HashSet::new());
        let mut property_domains = HashMap::new();
        property_domains.insert("cell", HashSet::new());
        property_domains.insert("base", HashSet::new());
        property_domains.insert("client", HashSet::new());
        Assembly {
            entity_name: entity_name.to_string(),
            used_utypes: HashSet::new(),
            auto_counter: 1,
            holders: HashMap::new(),
            property_used_utypes: HashSet::new(),
            property_auto_counter: 1,
            property_holders: HashMap::new(),
            method_names_by_section,
            all_method_names: HashSet::new(),
            property_domains,
            all_property_names: HashSet::new(),
            component_names: HashSet::new(),
            registry: HashMap::new(),
            seen_component_types: HashSet::new(),
            types: Vec::new(),
            issues: Vec::new(),
            next_type_utype: 1,
            methods: Vec::new(),
            properties: Vec::new(),
            sources: Vec::new(),
            visited: HashSet::new(),
        }
    }
}
