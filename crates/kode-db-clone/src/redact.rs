//! 源数据脱敏策略(PDC-0106;PDC-0205 的归档加密/密钥存储属 Phase 2)。
//!
//! 定义列敏感度分类(凭据/个人/公开)与掩码助手。执行期(Phase 2 行编码)
//! 按此策略对敏感列默认脱敏;本模块只给分类与掩码规则,不碰密钥/加密。

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
            "password", "passwd", "pwd", "secret", "token", "apikey", "api_key", "credential",
        ];
        if credential.iter().any(|k| lower.contains(k)) {
            return Sensitivity::Credential;
        }
        let personal = [
            "email", "mail", "phone", "mobile", "idcard", "id_card", "realname", "real_name",
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
                // 跳到值末尾(值以空格/引号/行尾为界)。
                let after_eq = eq + 1;
                let val_end = rest[after_eq..]
                    .find([' ', '\t', '"', '\'', ','])
                    .map(|i| after_eq + i)
                    .unwrap_or(rest.len());
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
        assert!(!out.contains("hunter2") && !out.contains("abc123"), "明文不残留: {out}");
    }
}
