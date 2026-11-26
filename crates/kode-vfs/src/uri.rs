//! VFS-001/002 path identity: canonical URI.
//!
//! Base-version semantics (the full cross-platform matrix — Windows UNC, WSL, Unicode
//! normalization, symlink resolution — lands with PR-006 root discovery; this file first
//! establishes the rules and the data shape):
//!
//! - The internal canonical form = **the percent-decoded absolute path**, `/`-separated,
//!   with `.`/`..` segments resolved lexically, Windows drive letters upper-cased and
//!   carrying a leading `/` (`C:/x` ↔ `/C:/x` are equivalent).
//! - Identity comparison is byte comparison of the canonical form: POSIX is case-sensitive;
//!   Windows case-folding semantics need IO probing, and the base version does not pretend
//!   to support it (documented, no silent normalization).
//! - Non-file schemes (`http:` etc.) are always rejected, never silently degraded to a string key.
//! - Building identity from a bare basename is forbidden: identity = (root_id, CanonicalUri) (see [`crate::store`]).

use std::fmt;

/// Why URI parsing failed (VFS-001: illegal input must error explicitly, never degrade silently).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UriError {
    /// A non-file scheme (`http://`, `untitled:` etc.); kode-vfs only handles disk files.
    UnsupportedScheme(String),
    /// A `file:` URI missing its absolute path part.
    NotAbsolute,
    /// Illegal percent-encoding (e.g. `%G1`, a truncated `%A`).
    InvalidEncoding,
    /// Empty input.
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

/// Canonical URI: the path component of the VFS-002 query identity.
/// Comparison looks at the internal `path` field; construction only goes through
/// [`CanonicalUri::parse`] / [`CanonicalUri::from_path`].
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CanonicalUri {
    /// The canonical form: the decoded absolute path, `/`-separated, with no `.`/`..` segments;
    /// Windows looks like `/C:/dir/file.def`.
    path: String,
}

impl CanonicalUri {
    /// Build from a `file:///...` URI or an absolute path. Illegal input errors (VFS-001).
    pub fn parse(input: &str) -> Result<CanonicalUri, UriError> {
        let input = input.trim();
        if input.is_empty() {
            return Err(UriError::Empty);
        }
        // An absolute drive path is not a one-letter URI scheme. Extension clients
        // send fsPath on Windows, and its literal '%' characters are not URI escapes.
        let bytes = input.as_bytes();
        if bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\')
        {
            return Ok(CanonicalUri::from_path(input));
        }
        let raw = if let Some(rest) = strip_scheme(input, "file:") {
            // file://[host]/path — only the local forms are accepted (empty host, or localhost).
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

    /// Build from a filesystem path (an already-absolute path is absorbed as-is into the canonical form).
    pub fn from_path(path: &str) -> CanonicalUri {
        let mut path = path.replace('\\', "/");
        // Windows drive: normalize `C:/...` / `C:\...` / `/c:/...` into `/C:/...`, drive letter upper-cased.
        let bytes = path.as_bytes();
        let drive_pos = if bytes.len() >= 2 && bytes[1] == b':' {
            Some(0) // "C:/..."
        } else if bytes.len() >= 3 && bytes[0] == b'/' && bytes[2] == b':' {
            Some(1) // "/c:/..." (the form passed straight through by a file URI)
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

    /// Canonical path (for disk IO and root prefix matching).
    pub fn as_path(&self) -> &str {
        &self.path
    }

    /// Restore as a path the current platform's std::fs can consume directly (disk IO only;
    /// forbidden on the identity/display surfaces — the same prohibition as VFS-002):
    /// the Windows canonical drive form `/C:/...` drops its prefix to restore
    /// `C:/...` (std natively accepts forward-slash separators); the POSIX form is
    /// returned as-is. This is the inverse of from_path's drive normalization —
    /// previously index_queue's disk fallback fed `as_path()` straight in, and `/C:/...`
    /// is not a valid path on Windows (it resolves relative to the current drive root),
    /// so disk reads always failed = the closed-document fallback always went through the
    /// eviction arm (2026-11-16 win nightly, three genuine reds).
    pub fn to_native_path(&self) -> String {
        let path = &self.path;
        let bytes = path.as_bytes();
        if bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b':'
        {
            return path[1..].to_string();
        }
        path.to_string()
    }

    /// Restore as a `file://` URI string (minimal percent-encoding of reserved characters; non-ASCII kept as-is).
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

    /// The last segment (basename; for display/classification only — forbidden as identity, VFS-002).
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

/// Take the `scheme:` prefix (shaped like `xxx:` with no `/` or `:` before the colon).
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

/// Percent decoding (%XX; illegal sequences error, never swallowed).
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

/// Collapse duplicate `/` and resolve `.`/`..` lexically (no disk access, pure string handling — the VFS-001 base rule).
fn normalize_segments(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if absolute {
                    stack.pop(); // On an absolute path, .. cannot escape the root
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
        // Parsing twice yields the same identity (parse(to_string(u)) == u).
        assert_eq!(CanonicalUri::parse(&uri.to_uri_string()).unwrap(), uri);
    }

    #[test]
    fn to_native_path_posix_is_identity() {
        let uri = CanonicalUri::from_path("/tmp/kode-iq-1/T.def");
        assert_eq!(uri.to_native_path(), "/tmp/kode-iq-1/T.def");
    }

    #[test]
    fn to_native_path_strips_windows_drive_prefix() {
        // Backslash drive path -> canonical `/C:/...` -> native `C:/...` (std accepts forward slashes).
        let uri = CanonicalUri::from_path("C:\\Users\\u\\AppData\\Local\\Temp\\T.def");
        assert_eq!(uri.as_path(), "/C:/Users/u/AppData/Local/Temp/T.def");
        assert_eq!(uri.to_native_path(), "C:/Users/u/AppData/Local/Temp/T.def");
        // A lowercase-drive file URI in pass-through form restores the same way (file:///c:/x -> C:/x).
        let uri = CanonicalUri::parse("file:///c:/temp/T.def").unwrap();
        assert_eq!(uri.as_path(), "/C:/temp/T.def");
        assert_eq!(uri.to_native_path(), "C:/temp/T.def");
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
        assert_eq!(CanonicalUri::parse("c:\\Demo\\x.def").unwrap(), a);
        assert_eq!(CanonicalUri::parse("C:/Demo/x.def").unwrap(), a);
        assert_eq!(
            CanonicalUri::parse("C:\\Demo\\100% done.def")
                .unwrap()
                .as_path(),
            "/C:/Demo/100% done.def"
        );
        assert!(CanonicalUri::parse("x:relative.def").is_err());
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
        // localhost is the only host form allowed through.
        let uri = CanonicalUri::parse("file://localhost/w/a.def").unwrap();
        assert_eq!(uri.as_path(), "/w/a.def");
    }

    #[test]
    fn invalid_inputs_error_not_panic() {
        assert_eq!(CanonicalUri::parse(""), Err(UriError::Empty));
        // A full file URI with illegal percent-encoding -> InvalidEncoding.
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

    #[test]
    fn uri_error_messages_are_stable() {
        assert_eq!(
            UriError::UnsupportedScheme("ftp".into()).to_string(),
            "unsupported URI scheme: ftp"
        );
        assert_eq!(
            UriError::NotAbsolute.to_string(),
            "file URI has no absolute path"
        );
        assert_eq!(
            UriError::InvalidEncoding.to_string(),
            "invalid percent-encoding"
        );
        assert_eq!(UriError::Empty.to_string(), "empty URI");
    }

    #[test]
    fn file_uri_without_absolute_path_is_rejected() {
        // file:def / file:./x.def (no absolute path) -> NotAbsolute; never guess a working directory.
        assert!(matches!(
            CanonicalUri::parse("file:def"),
            Err(UriError::NotAbsolute)
        ));
        assert!(matches!(
            CanonicalUri::parse("file:./x.def"),
            Err(UriError::NotAbsolute)
        ));
    }

    #[test]
    fn reserved_and_control_chars_are_percent_encoded() {
        let uri = CanonicalUri::from_path("/w/a b#c?d\"e<f>g[h]i|j^k%l");
        let s = uri.to_uri_string();
        for token in [
            "%20", "%23", "%3F", "%22", "%3C", "%3E", "%5B", "%5D", "%7C", "%5E", "%25",
        ] {
            assert!(s.contains(token), "`{s}` should contain `{token}`");
        }
        // Control characters are encoded too.
        let ctrl = CanonicalUri::from_path("/w/a\u{7}b");
        assert!(ctrl.to_uri_string().contains("%07"));
        // Parsing after encoding returns to the same identity.
        assert_eq!(CanonicalUri::parse(&uri.to_uri_string()).unwrap(), uri);
        assert_eq!(CanonicalUri::parse(&ctrl.to_uri_string()).unwrap(), ctrl);
    }

    #[test]
    fn display_matches_uri_string() {
        let uri = CanonicalUri::from_path("/w/x.def");
        assert_eq!(format!("{uri}"), uri.to_uri_string());
    }

    #[test]
    fn basename_of_root_and_bare_segment() {
        assert_eq!(CanonicalUri::from_path("/").basename(), "");
        assert_eq!(CanonicalUri::from_path("file").basename(), "file");
    }

    #[test]
    fn relative_paths_keep_leading_dotdot_after_overflow() {
        // A relative path's .. escaping the top keeps a literal .. (it neither escapes
        // the root nor gets swallowed).
        assert_eq!(CanonicalUri::from_path("a/../..").as_path(), "..");
        assert_eq!(CanonicalUri::from_path("a/b/../..").as_path(), "/");
        assert_eq!(CanonicalUri::from_path("a/./b").as_path(), "a/b");
    }

    #[test]
    fn file_uri_with_host_but_no_path_is_not_absolute() {
        // file://host (not even a '/' afterwards) -> NotAbsolute; never guess a working directory.
        assert!(matches!(
            CanonicalUri::parse("file://localhost"),
            Err(UriError::NotAbsolute)
        ));
        assert!(matches!(
            CanonicalUri::parse("file://server"),
            Err(UriError::NotAbsolute)
        ));
    }

    #[test]
    fn plain_paths_and_colon_inside_segment_parse_as_paths() {
        // A plain path fed straight into parse (no scheme at all) -> the same identity as from_path.
        assert_eq!(
            CanonicalUri::parse("/w/demo/x.def").unwrap(),
            CanonicalUri::from_path("/w/demo/x.def")
        );
        // A colon inside a path segment: `/w/odd` contains '/', not a legal scheme
        // character -> received as a plain path, colon kept in the path.
        let odd = CanonicalUri::parse("/w/odd:name.def").unwrap();
        assert_eq!(odd.as_path(), "/w/odd:name.def");
        // Drive letter without a trailing '/': also normalized into the /C:/... form
        // (no path loss).
        assert_eq!(CanonicalUri::from_path("c:x.def").as_path(), "/C:/x.def");
    }
}
