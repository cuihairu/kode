//! 源数据脱敏策略(PDC-0106;PDC-0205 的归档加密/密钥存储属 Phase 2)。
//!
//! 定义列敏感度分类(凭据/个人/公开)与掩码助手;执行期经 [`RedactingSink`]
//! 按策略对敏感列默认脱敏(PDC-0205 敏感信息默认脱敏开关)。归档加密/密钥
//! 存储见 keystore.rs/archive.rs。

use std::collections::BTreeMap;

use serde::Serialize;

use crate::error::CloneResult;
use crate::planner::QueryPlan;
use crate::reader::RowSink;
use crate::value::{TypedRow, TypedValue};

/// 列敏感度。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sensitivity {
    /// 凭据(密码/令牌/密钥)——导出与日志一律掩码。
    Credential,
    /// 个人数据(邮箱/电话/证件)——默认掩码,可经配置放宽。
    Personal,
    /// 公开字段(昵称/等级等)——按原值。
    Public,
}

impl Sensitivity {
    pub fn label(self) -> &'static str {
        match self {
            Sensitivity::Credential => "credential",
            Sensitivity::Personal => "personal",
            Sensitivity::Public => "public",
        }
    }
}

/// 脱敏策略:按列名分类 + 提供掩码值。
#[derive(Debug, Clone, Default)]
pub struct SensitivityPolicy {
    /// 覆盖默认分类(列名 → 敏感度)。
    pub overrides: Vec<(String, Sensitivity)>,
}

impl SensitivityPolicy {
    /// 分类一个列名。凭据模式优先于个人模式;显式 overrides 最高优先。
    pub fn classify(&self, column: &str) -> Sensitivity {
        let lower = column.to_ascii_lowercase();
        if let Some((_, s)) = self.overrides.iter().find(|(c, _)| c == column) {
            return *s;
        }
        let credential = [
            "password",
            "passwd",
            "pwd",
            "secret",
            "token",
            "apikey",
            "api_key",
            "credential",
        ];
        if credential.iter().any(|k| lower.contains(k)) {
            return Sensitivity::Credential;
        }
        let personal = [
            "email",
            "mail",
            "phone",
            "mobile",
            "idcard",
            "id_card",
            "realname",
            "real_name",
            "birthday",
        ];
        if personal.iter().any(|k| lower.contains(k)) {
            return Sensitivity::Personal;
        }
        Sensitivity::Public
    }

    /// 按敏感度掩码一个值(凭据→固定 ***;个人→保留首尾;公开→原值)。
    pub fn mask(&self, column: &str, value: &str) -> String {
        match self.classify(column) {
            Sensitivity::Credential => "***".into(),
            Sensitivity::Personal => mask_personal(value),
            Sensitivity::Public => value.into(),
        }
    }

    /// 日志行脱敏:把 `key=value`(key 为凭据)中的 value 掩掉。
    /// 用于导出/审计日志,不把明文凭据写入日志(PDC-0106 源数据脱敏)。
    pub fn redact_log(&self, line: &str) -> String {
        let mut out = String::with_capacity(line.len());
        let mut rest = line;
        while let Some(eq) = rest.find('=') {
            // 取 `=` 前的键(限定在空格/引号边界内的词)。
            let key_start = rest[..eq]
                .rfind([' ', '\t', '"', '\'', ','])
                .map(|i| i + 1)
                .unwrap_or(0);
            let key = &rest[key_start..eq];
            let key_trim = key.trim();
            if self.classify(key_trim) == Sensitivity::Credential {
                out.push_str(&rest[..eq]);
                out.push_str("=***");
                // 跳过值体(不把明文凭据回灌输出)。引号值须跳过整个引号区间
                // (含闭引号,不吸收其后的空白);裸值以空白/逗号为界。
                let after_eq = eq + 1;
                let tail = &rest[after_eq..];
                let val_end = match tail.as_bytes().first() {
                    Some(b'"') | Some(b'\'') => {
                        let quote = tail.as_bytes()[0] as char;
                        // 配对闭引号之后的位置;未闭合则吞掉余下全部(安全)。
                        let close = tail[1..].find(quote).map(|i| i + 2).unwrap_or(tail.len());
                        after_eq + close
                    }
                    _ => tail
                        .find([' ', '\t', ','])
                        .map(|i| after_eq + i)
                        .unwrap_or(rest.len()),
                };
                rest = &rest[val_end..];
            } else {
                let next = eq + 1;
                out.push_str(&rest[..next]);
                rest = &rest[next..];
            }
        }
        out.push_str(rest);
        out
    }
}

/// 个人数据掩码:保留首尾字符,中间以 `*` 替代(长度≤4 则全掩)。
fn mask_personal(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 4 {
        return "*".repeat(chars.len());
    }
    let mut out = String::new();
    out.push(chars[0]);
    for _ in 1..chars.len() - 1 {
        out.push('*');
    }
    out.push(chars[chars.len() - 1]);
    out
}

/// 脱敏执行汇(PDC-0205 默认脱敏):把敏感列的文本值掩码后转交内层汇,
/// 并逐列计数掩码次数(进 redaction-report.json)。非文本敏感值保持原样
/// (无字符串形态,不假掩)但仍在报告标注。
pub struct RedactingSink<'a> {
    inner: &'a mut dyn RowSink,
    policy: &'a SensitivityPolicy,
    /// 表 → 列名序(来自计划,与行值序对齐)。
    columns: BTreeMap<String, Vec<String>>,
    masked: BTreeMap<(String, String), u64>,
}

impl std::fmt::Debug for RedactingSink<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RedactingSink")
            .field("policy", &self.policy)
            .field("columns", &self.columns)
            .field("masked", &self.masked)
            .finish_non_exhaustive()
    }
}

impl<'a> RedactingSink<'a> {
    pub fn new(
        inner: &'a mut dyn RowSink,
        policy: &'a SensitivityPolicy,
        plan: &QueryPlan,
    ) -> Self {
        let columns = plan
            .queries
            .iter()
            .map(|q| (q.table.clone(), q.columns.clone()))
            .collect();
        Self {
            inner,
            policy,
            columns,
            masked: BTreeMap::new(),
        }
    }

    /// 掩码计数(表,列) → 次数,作脱敏报告原料。
    pub fn masked_counts(&self) -> &BTreeMap<(String, String), u64> {
        &self.masked
    }

    /// 脱敏报告(逐条:表/列/敏感度/掩码次数)。
    pub fn report(&self) -> RedactionReport {
        let entries = self
            .masked
            .iter()
            .map(|((table, column), count)| RedactionEntry {
                table: table.clone(),
                column: column.clone(),
                sensitivity: self.policy.classify(column).label().to_string(),
                masked_count: *count,
            })
            .collect();
        RedactionReport { entries }
    }
}

impl RowSink for RedactingSink<'_> {
    fn write_row(&mut self, table: &str, row: &TypedRow) -> CloneResult<u64> {
        let Some(columns) = self.columns.get(table) else {
            return self.inner.write_row(table, row);
        };
        let mut values = row.values.clone();
        let mut changed = false;
        for (i, value) in values.iter_mut().enumerate() {
            let column = columns.get(i).cloned().unwrap_or_default();
            if self.policy.classify(&column) == Sensitivity::Public {
                continue;
            }
            if let TypedValue::Text(s) = value {
                let masked = self.policy.mask(&column, s);
                if masked != *s {
                    *value = TypedValue::Text(masked);
                    *self.masked.entry((table.to_string(), column)).or_insert(0) += 1;
                    changed = true;
                }
            }
        }
        if changed {
            let out = TypedRow {
                table: row.table.clone(),
                values,
            };
            self.inner.write_row(table, &out)
        } else {
            self.inner.write_row(table, row)
        }
    }

    fn end_table(&mut self, table: &str, count: u64) -> CloneResult<()> {
        self.inner.end_table(table, count)
    }
}

/// 脱敏报告(归档 redaction-report.json 的形态)。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct RedactionReport {
    pub entries: Vec<RedactionEntry>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct RedactionEntry {
    pub table: String,
    pub column: String,
    pub sensitivity: String,
    pub masked_count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_credential_and_personal() {
        let p = SensitivityPolicy::default();
        assert_eq!(p.classify("sm_password"), Sensitivity::Credential);
        assert_eq!(p.classify("apiKey"), Sensitivity::Credential);
        assert_eq!(p.classify("email"), Sensitivity::Personal);
        assert_eq!(p.classify("sm_name"), Sensitivity::Public);
    }

    #[test]
    fn override_wins() {
        let p = SensitivityPolicy {
            overrides: vec![("sm_name".into(), Sensitivity::Personal)],
        };
        assert_eq!(p.classify("sm_name"), Sensitivity::Personal);
    }

    #[test]
    fn masks_by_sensitivity() {
        let p = SensitivityPolicy::default();
        assert_eq!(p.mask("sm_password", "hunter2"), "***");
        assert_eq!(p.mask("email", "a@b.com"), "a*****m"); // 首尾保留,中间 *
        assert_eq!(p.mask("sm_name", "Alice"), "Alice");
    }

    #[test]
    fn redacts_credentials_in_log_line() {
        let p = SensitivityPolicy::default();
        let line = "connect host=db user=root password=hunter2 token=abc123 name=Alice";
        let out = p.redact_log(line);
        assert!(out.contains("password=***"), "密码掩掉: {out}");
        assert!(out.contains("token=***"), "令牌掩掉: {out}");
        assert!(out.contains("name=Alice"), "公开字段保留: {out}");
        assert!(out.contains("host=db"));
        assert!(out.contains("user=root"));
        assert!(
            !out.contains("hunter2") && !out.contains("abc123"),
            "明文不残留: {out}"
        );
    }

    #[test]
    fn redacts_quoted_credential_values_wholesale() {
        // 带引号的凭据值:必须跳过整个引号区间,不得把值体回灌输出。
        let p = SensitivityPolicy::default();
        let line = "password=\"hunter2\" token='abc123' name=Alice";
        let out = p.redact_log(line);
        assert!(out.contains("password=***"), "密码掩掉: {out}");
        assert!(out.contains("token=***"), "令牌掩掉: {out}");
        assert!(out.contains("name=Alice"), "公开字段保留: {out}");
        assert!(
            !out.contains("hunter2") && !out.contains("abc123"),
            "引号值明文不得泄漏: {out}"
        );
        assert!(
            !out.contains('"') && !out.contains('\''),
            "引号自身也不残留: {out}"
        );
    }

    #[test]
    fn redacts_quoted_value_with_internal_space() {
        // 引号内空白不截断值:整段引号值一并掩掉。
        let p = SensitivityPolicy::default();
        let line = "password=\"my secret pass\" name=Alice";
        let out = p.redact_log(line);
        assert!(out.contains("password=***"), "密码掩掉: {out}");
        assert!(out.contains("name=Alice"), "公开字段保留: {out}");
        assert!(!out.contains("my secret pass"), "含空白引号值不泄漏: {out}");
    }

    #[test]
    fn labels_cover_all_sensitivities() {
        assert_eq!(Sensitivity::Credential.label(), "credential");
        assert_eq!(Sensitivity::Personal.label(), "personal");
        assert_eq!(Sensitivity::Public.label(), "public");
    }

    #[test]
    fn short_personal_values_are_fully_masked() {
        assert_eq!(mask_personal("ab"), "**");
        assert_eq!(mask_personal("abc"), "***");
        assert_eq!(mask_personal(""), "");
        // 多字节字符按字符数掩码,不按字节;>4 保留首尾。
        assert_eq!(mask_personal("王小明同学"), "王***学");
    }

    #[test]
    fn debug_impls_are_present() {
        let p = SensitivityPolicy::default();
        assert!(format!("{p:?}").contains("overrides"));
        assert!(format!("{p:?}").contains("SensitivityPolicy"));
    }

    /// 行捕获汇:记录流经的行,供断言脱敏前后差异。
    struct CaptureSink {
        rows: Vec<TypedRow>,
        ended: Vec<(String, u64)>,
    }

    impl RowSink for CaptureSink {
        fn write_row(&mut self, _table: &str, row: &TypedRow) -> CloneResult<u64> {
            self.rows.push(row.clone());
            Ok(1)
        }

        fn end_table(&mut self, table: &str, count: u64) -> CloneResult<()> {
            self.ended.push((table.to_string(), count));
            Ok(())
        }
    }

    fn plan_with_columns(columns: &[&str]) -> QueryPlan {
        use crate::planner::{PlanFilter, PlannedQuery};
        QueryPlan {
            entity_name: "Avatar".into(),
            row_budget: 100,
            queries: vec![PlannedQuery {
                sequence: 0,
                table: "tbl_Avatar".into(),
                parent_table: None,
                filter: PlanFilter::RootId,
                columns: columns.iter().map(|c| c.to_string()).collect(),
                column_types: columns.iter().map(|_| "varchar".to_string()).collect(),
                select_sql: "SELECT 1".into(),
                estimated_rows: None,
            }],
            denied: vec![],
            missing: vec![],
            identity: None,
            estimated_rows_total: None,
        }
    }

    fn text_row(table: &str, values: &[&str]) -> TypedRow {
        TypedRow {
            table: table.to_string(),
            values: values
                .iter()
                .map(|v| TypedValue::Text(v.to_string()))
                .collect(),
        }
    }

    #[test]
    fn sink_masks_sensitive_text_columns_and_reports() {
        let plan = plan_with_columns(&["sm_name", "email", "sm_password"]);
        let policy = SensitivityPolicy::default();
        let mut capture = CaptureSink {
            rows: Vec::new(),
            ended: Vec::new(),
        };
        {
            let mut sink = RedactingSink::new(&mut capture, &policy, &plan);
            sink.write_row(
                "tbl_Avatar",
                &text_row("tbl_Avatar", &["Alice", "a@b.com", "hunter2"]),
            )
            .unwrap();
            sink.end_table("tbl_Avatar", 1).unwrap();
            // 计划外的表:直通,不改写。
            sink.write_row("tbl_Unknown", &text_row("tbl_Unknown", &["a@b.com"]))
                .unwrap();
            let report = sink.report();
            assert_eq!(report.entries.len(), 2, "掩码过的列才进报告: {report:?}");
            let mut by_col: BTreeMap<_, _> = report
                .entries
                .iter()
                .map(|e| (e.column.as_str(), (e.sensitivity.as_str(), e.masked_count)))
                .collect();
            assert_eq!(by_col.remove("email"), Some(("personal", 1)));
            assert_eq!(by_col.remove("sm_password"), Some(("credential", 1)));
            assert_eq!(by_col.remove("sm_name"), None, "公开列不进报告");
            assert!(!sink.masked_counts().is_empty());
        }
        // 首行:敏感列被掩,公开列保留;end_table 直通。
        assert_eq!(capture.rows[0].values[0], TypedValue::Text("Alice".into()));
        assert_eq!(
            capture.rows[0].values[1],
            TypedValue::Text("a*****m".into())
        );
        assert_eq!(capture.rows[0].values[2], TypedValue::Text("***".into()));
        assert_eq!(capture.ended, vec![("tbl_Avatar".to_string(), 1)]);
        // 未知表行原样直通。
        assert_eq!(
            capture.rows[1].values[0],
            TypedValue::Text("a@b.com".into())
        );
    }

    #[test]
    fn sink_passes_rows_through_when_masking_is_noop() {
        let plan = plan_with_columns(&["sm_name"]);
        let policy = SensitivityPolicy::default();
        let mut capture = CaptureSink {
            rows: Vec::new(),
            ended: Vec::new(),
        };
        let mut sink = RedactingSink::new(&mut capture, &policy, &plan);
        // 掩码后与原值相同(公开列)→ 不改写、不计数。
        sink.write_row("tbl_Avatar", &text_row("tbl_Avatar", &["Alice"]))
            .unwrap();
        assert_eq!(sink.masked_counts().len(), 0);
        assert!(sink.report().entries.is_empty());
        assert_eq!(capture.rows.len(), 1);
    }

    #[test]
    fn redacting_sink_debug_renders_policy_and_masks() {
        // Debug 是审计面:策略与掩码计数可见,行缓冲不整块倾倒。
        let plan = plan_with_columns(&["sm_name", "email"]);
        let policy = SensitivityPolicy::default();
        let mut capture = CaptureSink {
            rows: Vec::new(),
            ended: Vec::new(),
        };
        let mut sink = RedactingSink::new(&mut capture, &policy, &plan);
        sink.write_row("tbl_Avatar", &text_row("tbl_Avatar", &["Alice", "a@b.com"]))
            .unwrap();
        let rendered = format!("{sink:?}");
        assert!(rendered.starts_with("RedactingSink"), "{rendered}");
        assert!(rendered.contains("masked"), "{rendered}");
    }

    #[test]
    fn non_text_value_in_sensitive_column_passes_through() {
        // 敏感列的值不是文本(数值/blob 等):掩码策略只作用于文本形态,
        // 非文本值原样直通、不计数、不报错。
        let plan = plan_with_columns(&["email"]);
        let policy = SensitivityPolicy::default();
        let mut capture = CaptureSink {
            rows: Vec::new(),
            ended: Vec::new(),
        };
        let mut sink = RedactingSink::new(&mut capture, &policy, &plan);
        sink.write_row(
            "tbl_Avatar",
            &TypedRow {
                table: "tbl_Avatar".into(),
                values: vec![TypedValue::BigUInt(42)],
            },
        )
        .unwrap();
        assert_eq!(sink.masked_counts().len(), 0);
        assert_eq!(capture.rows[0].values[0], TypedValue::BigUInt(42));
    }
}
