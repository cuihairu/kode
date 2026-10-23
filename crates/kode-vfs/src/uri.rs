//! VFS-001/002 路径身份:canonical URI。
//!
//! 基础版语义(完整跨平台矩阵——Windows UNC、WSL、Unicode normalization、
//! symlink 解析——随 PR-006 root discovery 落地,此处先立规则与数据形态):
//!
//! - 内部规范形态 = **percent 解码后的绝对路径**,`/` 分隔,`.`/`..` 段已词法消解,
//!   Windows 盘符统一大写并带前导 `/`(`C:/x` ↔ `/C:/x` 等价)。
//! - 身份比较用规范形态字节比较:POSIX 区分大小写;Windows 大小写折叠语义
//!   需要 IO 探测,基础版不假装支持(文档声明,不悄悄归一化)。
//! - 非文件 scheme(`http:` 等)一律拒绝,不静默降级成字符串键。
//! - 禁止仅以 basename 建身份:身份 = (root_id, CanonicalUri)(见 [`crate::store`])。

use std::fmt;

/// URI 解析失败原因(VFS-001:非法输入必须显式报错,不得静默降级)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UriError {
    /// 非文件 scheme(`http://`、`untitled:` 等);kode-vfs 只管磁盘文件。
    UnsupportedScheme(String),
    /// `file:` URI 缺少绝对路径部分。
    NotAbsolute,
    /// percent 编码非法(如 `%G1`、截断的 `%A`)。
    InvalidEncoding,
    /// 空输入。
    Empty,
}

impl fmt::Display for UriError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UriError::UnsupportedScheme(s) => write!(f, "unsupported URI scheme: {s}"),
            UriError::NotAbsolute => write!(f, "file URI has no absolute path"),
            UriError::InvalidEncoding => write!(f, "invalid percent-encoding"),
            UriError::Empty => write!(f, "empty URI"),
        }
    }
}

impl std::error::Error for UriError {}

/// canonical URI:VFS-002 查询身份的路径分量。
/// 比较看内部 `path` 字段;构造只经 [`CanonicalUri::parse`] / [`CanonicalUri::from_path`]。
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CanonicalUri {
    /// 规范形态:解码后的绝对路径,`/` 分隔,无 `.`/`..` 段;
    /// Windows 形如 `/C:/dir/file.def`。
    path: String,
}

impl CanonicalUri {
    /// 从 `file:///...` URI 或绝对路径构造。非法输入报错(VFS-001)。
    pub fn parse(input: &str) -> Result<CanonicalUri, UriError> {
        let input = input.trim();
        if input.is_empty() {
            return Err(UriError::Empty);
        }
        let raw = if let Some(rest) = strip_scheme(input, "file:") {
            // file://[host]/path —— 只接受空 host(或 localhost)的本地形态。
            if let Some(path) = rest.strip_prefix("//") {
                match path.find('/') {
                    Some(0) => path,
                    Some(host_end) => {
                        let host = &path[..host_end];
                        if host.eq_ignore_ascii_case("localhost") {
                            &path[host_end..]
                        } else {
                            return Err(UriError::UnsupportedScheme(format!("file://{host}")));
                        }
                    }
                    None => return Err(UriError::NotAbsolute),
                }
            } else {
                return Err(UriError::NotAbsolute);
            }
        } else if scheme_of(input).is_some() {
            return Err(UriError::UnsupportedScheme(
                scheme_of(input).unwrap().to_string(),
            ));
        } else {
            input
        };
        let decoded = percent_decode(raw)?;
        Ok(CanonicalUri::from_path(&decoded))
    }

    /// 从文件系统路径构造(已是绝对路径则按规范形态收纳)。
    pub fn from_path(path: &str) -> CanonicalUri {
        let mut path = path.replace('\\', "/");
        // Windows 盘符:把 `C:/...` / `C:\...` / `/c:/...` 规范成 `/C:/...`,盘符大写。
        let bytes = path.as_bytes();
        let drive_pos = if bytes.len() >= 2 && bytes[1] == b':' {
            Some(0) // "C:/..."
        } else if bytes.len() >= 3 && bytes[0] == b'/' && bytes[2] == b':' {
            Some(1) // "/c:/..."(file URI 直传形态)
        } else {
            None
        };
        if let Some(pos) = drive_pos {
            let drive = path[pos..pos + 1].to_ascii_uppercase();
            let rest = &path[pos + 2..];
            let rest = rest.strip_prefix(':').unwrap_or(rest);
            let rest = if rest.starts_with('/') {
                rest.to_string()
            } else {
                format!("/{rest}")
            };
            path = format!("/{drive}:{rest}");
        }
        CanonicalUri {
            path: normalize_segments(&path),
        }
    }

    /// 规范路径(供磁盘 IO 与 root 前缀匹配用)。
    pub fn as_path(&self) -> &str {
        &self.path
    }

    /// 还原成 `file://` URI 字符串(保留字符做最小 percent 编码;非 ASCII 原样保留)。
    pub fn to_uri_string(&self) -> String {
        let mut out = String::with_capacity(self.path.len() + 8);
        out.push_str("file://");
        for ch in self.path.chars() {
            match ch {
                '%' => out.push_str("%25"),
                '#' => out.push_str("%23"),
                '?' => out.push_str("%3F"),
                '"' => out.push_str("%22"),
                ' ' => out.push_str("%20"),
                '<' | '>' | '[' | ']' | '|' | '^' => {
                    let mut buf = [0u8; 4];
                    for byte in ch.encode_utf8(&mut buf).as_bytes() {
                        out.push_str(&format!("%{byte:02X}"));
                    }
                }
                c if (c as u32) < 0x20 || (c as u32) == 0x7F => {
                    out.push_str(&format!("%{:02X}", c as u32));
                }
                c => out.push(c),
            }
        }
        out
    }

    /// 最后一段(basename;仅供展示/分类,禁止当身份用——VFS-002)。
    pub fn basename(&self) -> &str {
        let path = self.path.trim_end_matches('/');
        match path.rfind('/') {
            Some(pos) => &path[pos + 1..],
            None => path,
        }
    }
}

impl fmt::Display for CanonicalUri {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_uri_string())
    }
}

/// 取 `scheme:` 前缀(形如 `xxx:` 且冒号前无 `/`、`:`)。
fn scheme_of(input: &str) -> Option<&str> {
    let colon = input.find(':')?;
    let scheme = &input[..colon];
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    Some(scheme)
}

fn strip_scheme<'a>(input: &'a str, scheme: &str) -> Option<&'a str> {
    if input.len() >= scheme.len() && input[..scheme.len()].eq_ignore_ascii_case(scheme) {
        Some(&input[scheme.len()..])
    } else {
        None
    }
}

/// percent 解码(%XX;非法序列报错,不吞)。
fn percent_decode(input: &str) -> Result<String, UriError> {
    if !input.contains('%') {
        return Ok(input.to_string());
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3).ok_or(UriError::InvalidEncoding)?;
            let hi = (hex[0] as char)
                .to_digit(16)
                .ok_or(UriError::InvalidEncoding)?;
            let lo = (hex[1] as char)
                .to_digit(16)
                .ok_or(UriError::InvalidEncoding)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| UriError::InvalidEncoding)
}

/// 折叠重复 `/`,词法消解 `.`/`..`(不触盘,纯字符串——VFS-001 基础规则)。
fn normalize_segments(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if absolute {
                    stack.pop(); // 绝对路径 .. 不会越出根
                } else if stack.pop().is_none() {
                    stack.push("..");
                }
            }
            other => stack.push(other),
        }
    }
    let mut out = String::with_capacity(path.len());
    if absolute {
        out.push('/');
    }
    out.push_str(&stack.join("/"));
    if out.is_empty() {
        out.push('/');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_file_uri_and_plain_path_to_same_identity() {
        let from_uri = CanonicalUri::parse("file:///w/demo/entities/Monster.def").unwrap();
        let from_path = CanonicalUri::from_path("/w/demo/entities/Monster.def");
        assert_eq!(from_uri, from_path);
        assert_eq!(from_uri.as_path(), "/w/demo/entities/Monster.def");
        assert_eq!(from_uri.basename(), "Monster.def");
    }

    #[test]
    fn percent_encoding_round_trips() {
        let uri = CanonicalUri::parse("file:///w/my%20project/a%23b.def").unwrap();
        assert_eq!(uri.as_path(), "/w/my project/a#b.def");
        assert_eq!(uri.to_uri_string(), "file:///w/my%20project/a%23b.def");
        // 二次解析同一身份(parse(to_string(u)) == u)。
        assert_eq!(CanonicalUri::parse(&uri.to_uri_string()).unwrap(), uri);
    }

    #[test]
    fn non_ascii_paths_round_trip() {
        let uri = CanonicalUri::parse("file:///w/怪物/Monster.def").unwrap();
        assert_eq!(uri.as_path(), "/w/怪物/Monster.def");
        assert_eq!(CanonicalUri::parse(&uri.to_uri_string()).unwrap(), uri);
    }

    #[test]
    fn windows_drive_is_normalized() {
        let a = CanonicalUri::parse("file:///c:/Demo/x.def").unwrap();
        let b = CanonicalUri::from_path("c:\\Demo\\x.def");
        assert_eq!(a, b);
        assert_eq!(a.as_path(), "/C:/Demo/x.def");
    }

    #[test]
    fn dot_and_dotdot_segments_are_resolved_lexically() {
        let uri = CanonicalUri::parse("file:///w/demo/./entities/../entities/Monster.def").unwrap();
        assert_eq!(uri.as_path(), "/w/demo/entities/Monster.def");
    }

    #[test]
    fn duplicate_slashes_collapse() {
        let uri = CanonicalUri::parse("file:///w//demo///x.def").unwrap();
        assert_eq!(uri.as_path(), "/w/demo/x.def");
    }

    #[test]
    fn non_file_schemes_are_rejected() {
        assert!(matches!(
            CanonicalUri::parse("http://example.com/a.def"),
            Err(UriError::UnsupportedScheme(s)) if s == "http"
        ));
        assert!(matches!(
            CanonicalUri::parse("untitled:Untitled-1"),
            Err(UriError::UnsupportedScheme(_))
        ));
    }

    #[test]
    fn remote_host_file_uri_is_rejected() {
        assert!(matches!(
            CanonicalUri::parse("file://server/share/a.def"),
            Err(UriError::UnsupportedScheme(_))
        ));
        // localhost 是唯一放行的 host 形态。
        let uri = CanonicalUri::parse("file://localhost/w/a.def").unwrap();
        assert_eq!(uri.as_path(), "/w/a.def");
    }

    #[test]
    fn invalid_inputs_error_not_panic() {
        assert_eq!(CanonicalUri::parse(""), Err(UriError::Empty));
        // 带非法 percent 的完整 file URI → InvalidEncoding。
        assert!(matches!(
            CanonicalUri::parse("file:///%G1.def"),
            Err(UriError::InvalidEncoding)
        ));
        assert!(matches!(
            CanonicalUri::parse("file:///%2"),
            Err(UriError::InvalidEncoding)
        ));
    }

    #[test]
    fn localhost_case_insensitive() {
        let uri = CanonicalUri::parse("file://LOCALHOST/w/a.def").unwrap();
        assert_eq!(uri.as_path(), "/w/a.def");
    }
}
