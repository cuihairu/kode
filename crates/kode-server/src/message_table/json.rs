//! MessageTable 输出 JSON 形状。

// ---------------------------------------------------------------------------
// 输出 JSON 结构(与 TS renderMessageTableJson 同形;全量条目)
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArgJson {
    pub(super) name: String,
    pub(super) of_type: Option<Box<ArgJson>>,
    pub(super) utype: Option<i64>,
    pub(super) line: usize,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MethodJson {
    pub(super) name: String,
    pub(super) section: String,
    pub(super) direction: String,
    pub(super) visible_to_client: bool,
    pub(super) exposed: bool,
    pub(super) args: Vec<ArgJson>,
    pub(super) declared_utype: Option<i64>,
    pub(super) utype: Option<i64>,
    #[serde(rename = "aliasID")]
    pub(super) alias_id: Option<i64>,
    pub(super) status: String,
    pub(super) origin: String,
    pub(super) origin_kind: String,
    pub(super) line: usize,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PropertyJson {
    pub(super) name: String,
    pub(super) type_name: Option<String>,
    pub(super) flags: String,
    pub(super) has_client: bool,
    pub(super) utype: Option<i64>,
    pub(super) declared_utype: Option<i64>,
    #[serde(rename = "aliasID")]
    pub(super) alias_id: Option<i64>,
    /// 组件槽 `<Persistent>`(缺省 true);普通属性不透出(null)。
    pub(super) persistent: Option<bool>,
    pub(super) origin: String,
    pub(super) origin_kind: String,
    pub(super) line: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TypeJson {
    pub(super) name: String,
    pub(super) utype: i64,
    pub(super) kind: String,
    pub(super) aliased_to: Option<String>,
    pub(super) line: Option<usize>,
    pub(super) origin: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IssueJson {
    pub(super) kind: String,
    pub(super) message: String,
    pub(super) fatal: bool,
    pub(super) line: Option<usize>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SourceJson {
    pub(super) name: String,
    pub(super) kind: String,
    pub(super) file_path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TableJson {
    pub(super) module: String,
    pub(super) generated_at: String,
    pub(super) alias_id_enabled: bool,
    pub(super) load_failed: bool,
    pub(super) fatal_count: usize,
    pub(super) sources: Vec<SourceJson>,
    pub(super) methods: Vec<MethodJson>,
    pub(super) client_methods: Vec<MethodJson>,
    pub(super) properties: Vec<PropertyJson>,
    pub(super) client_properties: Vec<PropertyJson>,
    pub(super) types: Vec<TypeJson>,
    pub(super) issues: Vec<IssueJson>,
}
