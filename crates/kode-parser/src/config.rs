//! KBEngine server-side configuration XML parsing (config-first domain, KODE-CFG-002).
//!
//! Semantically line-by-line aligned with TS `parseConfigXml` (`src/serverConfigMerge.ts:62`),
//! shared by the `$/kode/config/*` channels and byte-level parity comparison. Pure functions,
//! zero third-party dependencies, no panics (following this crate's iron rules). See
//! `docs/design/config-first.md` §7.1 for the semantic alignment checklist.
//!
//! Key difference from the byte-level def parser: this is a **regex-tolerant** parse — only the
//! element tree is needed, attributes are ignored (used only for the self-closing decision);
//! declarations/XML PIs are dropped; comments are **not stripped**, but associated into the tree
//! by position (`source_comments` capture, KODE-CFG-010: inline/trailing ones attach to their own
//! element, leading ones to the following element, section-end/file-end strays to the nearest
//! enclosing container); unclosed tags/extra close tags are tolerated against what has already
//! been seen and never thrown; the root is a pseudo node (empty name) whose children are the
//! top-level component sections.

/// Config synthesized-tree node (mirrors TS `ConfigXmlNode`).
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigNode {
    /// Element name; empty string for the pseudo root
    pub name: String,
    /// Leaf value (space-joined, skipped for the pseudo root)
    pub text: String,
    /// Sub-sections / sub-keys
    pub children: Vec<ConfigNode>,
    /// Source comments (verbatim from the input XML): inline/trailing attach to their own element,
    /// leading ones to the following element, section-end/file-end strays to the nearest enclosing
    /// container. Written back verbatim at render time (TS-side render face).
    pub source_comments: Vec<String>,
}

/// Lexical token (mirrors the three JS `tokenRe` branches).
enum TokenKind {
    /// Comment body (excluding the `<!--`/`-->` delimiters)
    Comment(String),
    /// Declaration/XML PI (dropped)
    Pi,
    /// Tag
    Tag {
        name: String,
        /// Raw text after the tag name (used for the self-closing decision)
        attrs: String,
        is_close: bool,
    },
}

struct Token {
    start: usize,
    end: usize,
    kind: TokenKind,
}

/// Find the first occurrence of `needle` in `hay[start..]` (byte order; all delimiters are ASCII).
fn find_from(hay: &str, start: usize, needle: &str) -> Option<usize> {
    hay.get(start..)?.find(needle).map(|off| start + off)
}

/// Next token: mirrors JS
/// `tokenRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)(\w+)([^>]*)>/g`.
///
/// Priority (at the same position): comment > PI > tag (JS alternation order); a candidate without a
/// closing delimiter is not a token (JS lazy quantifier `*?` fails -> the whole branch fails at that
/// position -> advance). Tag names only accept `[A-Za-z0-9_]` (ASCII `\w`); attrs are taken verbatim
/// from after the tag name up to `>` (including a trailing `/`).
fn next_token(xml: &str, pos: usize) -> Option<Token> {
    let b = xml.as_bytes();
    let mut i = pos;
    while i < b.len() {
        if b[i] == b'<' {
            if b.get(i + 1) == Some(&b'!')
                && b.get(i + 2) == Some(&b'-')
                && b.get(i + 3) == Some(&b'-')
            {
                if let Some(close) = find_from(xml, i + 4, "-->") {
                    let body = &xml[i + 4..close];
                    return Some(Token {
                        start: i,
                        end: close + 3,
                        kind: TokenKind::Comment(body.to_string()),
                    });
                }
                // No `-->`: not a token, advance as text
            } else if b.get(i + 1) == Some(&b'?') {
                if let Some(close) = find_from(xml, i + 2, "?>") {
                    return Some(Token {
                        start: i,
                        end: close + 2,
                        kind: TokenKind::Pi,
                    });
                }
            } else {
                let mut j = i + 1;
                let is_close = b.get(j) == Some(&b'/');
                if is_close {
                    j += 1;
                }
                let name_start = j;
                while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                    j += 1;
                }
                if j > name_start {
                    let mut k = j;
                    while k < b.len() && b[k] != b'>' {
                        k += 1;
                    }
                    if k < b.len() {
                        let name = &xml[name_start..j];
                        let attrs = &xml[j..k];
                        return Some(Token {
                            start: i,
                            end: k + 1,
                            kind: TokenKind::Tag {
                                name: name.to_string(),
                                attrs: attrs.to_string(),
                                is_close,
                            },
                        });
                    }
                    // No `>`: not a token, advance as text
                }
            }
        }
        i += 1;
    }
    None
}

/// Self-closing decision: mirrors JS `/\/\s*$/.test(attrs)` — a trailing `/` may be followed by whitespace.
fn is_self_closing(attrs: &str) -> bool {
    attrs.trim_end().ends_with('/')
}

/// Parse engine-style server-side config XML (only the element tree is needed; attributes ignored;
/// declarations/PIs dropped).
///
/// Mirrors the full semantics of TS `parseConfigXml`: comments associated into the tree by position
/// (source-comment attribution rules), root as a pseudo node, unclosed tags/extra close tags tolerated
/// without throwing, and `None` when there are no child nodes.
pub fn parse_config(xml: &str) -> Option<ConfigNode> {
    struct Node {
        name: String,
        text: String,
        children: Vec<usize>,
        source_comments: Vec<String>,
    }
    // Node arena: index 0 = pseudo root; children hold child-node indices. Avoids recursive mutable
    // borrows, and lastClosed points at an already-closed node (its children are settled, so only
    // source comments are appended).
    let mut arena: Vec<Node> = vec![Node {
        name: String::new(),
        text: String::new(),
        children: Vec::new(),
        source_comments: Vec::new(),
    }];
    let mut stack: Vec<usize> = vec![0];
    let mut last_end = 0usize;
    let mut last_tag_end = 0usize;
    let mut last_closed: Option<usize> = None;
    let mut pending: Vec<String> = Vec::new();
    let mut pos = 0usize;

    while let Some(tok) = next_token(xml, pos) {
        let top = *stack.last().expect("stack never empty");
        // takeText: text between the previous token's end and the current token's start, space-joined after trim
        if top != 0 {
            let text = xml.get(last_end..tok.start).unwrap_or("").trim();
            if !text.is_empty() {
                let node = &mut arena[top];
                if !node.text.is_empty() {
                    node.text.push(' ');
                }
                node.text.push_str(text);
            }
        }
        last_end = tok.end;
        match tok.kind {
            TokenKind::Comment(body) => {
                let since_tag = xml.get(last_tag_end..tok.start).unwrap_or("");
                if let Some(closed) = last_closed {
                    if !since_tag.contains('\n') {
                        // Inline/trailing comment -> most recently closed element
                        arena[closed].source_comments.push(body);
                    } else {
                        pending.push(body);
                    }
                } else {
                    pending.push(body);
                }
                last_tag_end = tok.end;
                pos = tok.end;
            }
            TokenKind::Pi => {
                last_tag_end = tok.end;
                pos = tok.end;
            }
            TokenKind::Tag {
                name,
                attrs,
                is_close,
            } => {
                last_tag_end = tok.end;
                last_closed = None;
                if is_close {
                    let top = *stack.last().expect("stack never empty");
                    if top != 0 && arena[top].name == name {
                        stack.pop();
                        if !pending.is_empty() {
                            arena[top].source_comments.append(&mut pending);
                        }
                        last_closed = Some(top);
                    }
                    // Extra close (name mismatch / closing at the root): ignore
                } else {
                    let idx = arena.len();
                    arena.push(Node {
                        name,
                        text: String::new(),
                        children: Vec::new(),
                        source_comments: Vec::new(),
                    });
                    let top = *stack.last().expect("stack never empty");
                    arena[top].children.push(idx);
                    if !pending.is_empty() {
                        arena[idx].source_comments.append(&mut pending);
                    }
                    if !is_self_closing(&attrs) {
                        stack.push(idx);
                    }
                }
                pos = tok.end;
            }
        }
    }
    // File-end stray comments: attach to the nearest not-yet-closed container; if the stack is back to
    // just the root, attach to the first container element of the section. If there is not a single element
    // (comment-only input) they are dropped — consistent with the path where TS returns None.
    if !pending.is_empty() {
        let target = if stack.len() > 1 {
            Some(*stack.last().expect("stack never empty"))
        } else {
            arena[0].children.first().copied()
        };
        if let Some(t) = target {
            arena[t].source_comments.append(&mut pending);
        }
    }
    if arena[0].children.is_empty() {
        return None;
    }
    // Arena -> ConfigNode tree
    fn build(idx: usize, arena: &[Node]) -> ConfigNode {
        let n = &arena[idx];
        ConfigNode {
            name: n.name.clone(),
            text: n.text.clone(),
            children: n.children.iter().map(|&c| build(c, arena)).collect(),
            source_comments: n.source_comments.clone(),
        }
    }
    Some(build(0, &arena))
}

// --- Merge semantics (KODE-CFG-003, mirroring TS mergeConfigXml/mergeSourceComments) ---

/// JS `\s` exact character set (differs from Rust `is_whitespace` around `\u{feff}`; parity comparison
/// must match byte for byte, so the ECMAScript definition is mirrored).
fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// Sanitize comment content: mirrors TS `sanitizeXmlComment` (serverConfigCommentText.ts:11) —
/// whitespace runs collapse to a single space and are trimmed, runs of `-` collapse to one, and a
/// trailing `-` gets a space appended (prevents it combining with `-->` to form `--`). Both merge
/// deduplication and render-time writeback share this contract.
pub fn sanitize_xml_comment(text: &str) -> String {
    // /\s+/g -> ' '
    let mut spaced = String::with_capacity(text.len());
    let mut in_ws = false;
    for c in text.chars() {
        if is_js_ws(c) {
            if !in_ws {
                spaced.push(' ');
            }
            in_ws = true;
        } else {
            spaced.push(c);
            in_ws = false;
        }
    }
    // trim() (after replacement, only single spaces remain at the edges)
    let trimmed = spaced.trim_matches(' ');
    // /-+/g -> '-'
    let mut collapsed = String::with_capacity(trimmed.len());
    let mut prev_dash = false;
    for c in trimmed.chars() {
        if c == '-' {
            if !prev_dash {
                collapsed.push('-');
            }
            prev_dash = true;
        } else {
            collapsed.push(c);
            prev_dash = false;
        }
    }
    if collapsed.ends_with('-') {
        collapsed.push(' ');
    }
    collapsed
}

/// Merge source comments from both sides (override wins): override-side entries first, defaults-side
/// after; identical after normalization (sanitize) keep only the first occurrence (original text
/// preserved); all empty returns None (sourceComments is not set).
/// Mirrors TS `mergeSourceComments` (serverConfigMerge.ts:143).
fn merge_source_comments(base: &ConfigNode, over: &ConfigNode) -> Option<Vec<String>> {
    let mut merged: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for comment in over
        .source_comments
        .iter()
        .chain(base.source_comments.iter())
    {
        let normalized = sanitize_xml_comment(comment);
        if normalized.is_empty() || seen.contains(&normalized) {
            continue;
        }
        seen.push(normalized);
        merged.push(comment.clone());
    }
    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

/// Merge (engine same-key-override contract, mirroring TS `mergeConfigXml`, serverConfigMerge.ts:164):
/// defaults (base) is the base and the custom config (override) overrides it. Sub-keys are aligned by
/// name — those the custom config lacks keep the default; names the custom config writes are replaced
/// by the whole name (leaves take the custom value, repeated-name lists such as `<item>` are replaced
/// wholesale, never interleaved with the default table); when both sides are single container sections
/// it recurses downward. Source comments are kept from both sides: the override side goes first
/// (preferred), and for a single same-name element the defaults-side comments are appended after; when a
/// repeated-name list is replaced wholesale only the custom-side comments are carried.
pub fn merge_config_xml(base: &ConfigNode, override_node: &ConfigNode) -> ConfigNode {
    // Name order: the full order of base.children first, override-only names appended (each deduped while preserving order)
    let mut names: Vec<&str> = Vec::new();
    for child in base.children.iter().chain(override_node.children.iter()) {
        if !names.contains(&child.name.as_str()) {
            names.push(&child.name);
        }
    }
    let mut children: Vec<ConfigNode> = Vec::new();
    for name in names {
        let base_ones: Vec<&ConfigNode> = base
            .children
            .iter()
            .filter(|child| child.name == name)
            .collect();
        let override_ones: Vec<&ConfigNode> = override_node
            .children
            .iter()
            .filter(|child| child.name == name)
            .collect();
        if override_ones.is_empty() {
            // Not written in the custom config -> keep the default (whole section verbatim)
            children.extend(base_ones.into_iter().cloned());
        } else if base_ones.is_empty() {
            // Not present in defaults -> the whole custom section
            children.extend(override_ones.into_iter().cloned());
        } else if base_ones.len() == 1
            && override_ones.len() == 1
            && !base_ones[0].children.is_empty()
            && !override_ones[0].children.is_empty()
        {
            // Both sides are single container sections -> recurse downward (sub-keys keep aligning)
            children.push(merge_config_xml(base_ones[0], override_ones[0]));
        } else if base_ones.len() == 1 && override_ones.len() == 1 {
            // Single same-name element (leaf/empty container): value from the custom config, source comments kept from both sides (override preferred)
            let mut node = override_ones[0].clone();
            if let Some(comments) = merge_source_comments(base_ones[0], override_ones[0]) {
                node.source_comments = comments;
            }
            children.push(node);
        } else {
            // Repeated-name list (multiple on either side) -> replace the whole table with the custom side
            children.extend(override_ones.into_iter().cloned());
        }
    }
    let mut merged = ConfigNode {
        name: override_node.name.clone(),
        text: override_node.text.clone(),
        children,
        source_comments: Vec::new(),
    };
    if let Some(comments) = merge_source_comments(base, override_node) {
        merged.source_comments = comments;
    }
    merged
}

// ============ KODE-CFG-009: core resolve (the single data source for consuming channels) ============
//
// The TS consuming faces (hover synthesized display / telnet quick view / database connection
// essentials) all fetch this module's output via `$/kode/config/resolve`; the TS-side
// parseConfigXml/mergeConfigXml/summarizeFinalTelnet/extractDatabaseInterfaceConfig are retired
// in lockstep (design §6.2 step 3) — this module is the sole implementation for
// parse/merge/value-read.

/// Engine default telnet ports per component (kbengine_defaults.xml `<telnet_service><port/>`).
/// The hard-coded table was migrated from TS `telnetService.ENGINE_DEFAULT_TELNET_PORTS`; core is
/// the single source of truth.
pub const ENGINE_DEFAULT_TELNET_PORTS: [&str; 7] = [
    "loginapp",
    "dbmgr",
    "interfaces",
    "logger",
    "baseapp",
    "cellapp",
    "bots",
];

/// Telnet quick-view entry (mirrors the TS summarizeFinalTelnet output: invalid port number -> None,
/// 0 is valid and kept, empty password -> None).
#[derive(Debug, Clone, PartialEq)]
pub struct TelnetSummaryEntry {
    pub component: String,
    pub port: Option<f64>,
    pub password: Option<String>,
}

/// dbmgr database-interface connection essentials (mirrors the TS extractDatabaseInterfaceConfig
/// output: missing leaves fall back to engine defaults; encrypt defaults to true; the plaintext
/// password is only extracted when encrypt=false).
#[derive(Debug, Clone, PartialEq)]
pub struct DatabaseInterfaceConfig {
    pub host: String,
    /// Port (missing/invalid falls back to 3306; engine `<port>0` means "use the mysql default", which also lands on 3306)
    pub port: f64,
    pub username: String,
    pub database_name: String,
    /// true = password is RSA-encrypted by the engine; kode neither reads nor interprets it
    pub encrypt: bool,
    pub character_set: String,
    /// Plaintext password (only extracted when encrypt=false)
    pub plain_password: Option<String>,
}

/// Defaults for missing leaves in the engine defaults dbmgr section (kbengine_defaults.xml
/// `<dbmgr><databaseInterfaces><default>`).
const ENGINE_DB_INTERFACE_DEFAULTS: (&str, f64, &str, &str, &str) =
    ("localhost", 3306.0, "kbe", "kbe", "utf8mb4");

/// Parse text into a number following the JS `Number` contract (for config value reads): empty /
/// non-numeric / non-finite after trim -> None. JS Number also accepts forms like "0x10"/"Infinity",
/// which never occur in the config port domain and are not mirrored.
fn leaf_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Find a section among the two candidate layers (mirrors the candidates of TS
/// extractDatabaseInterfaceConfig: both the layer where component sections hang directly under the
/// pseudo root and the `<root>`-wrapped second layer are searched).
fn find_among_layers<'a>(root: &'a ConfigNode, name: &str) -> Option<&'a ConfigNode> {
    root.children
        .iter()
        .find(|child| child.name == name)
        .or_else(|| {
            root.children
                .iter()
                .flat_map(|child| child.children.iter())
                .find(|child| child.name == name)
        })
}

fn child_leaf<'a>(parent: &'a ConfigNode, name: &str) -> Option<&'a str> {
    parent
        .children
        .iter()
        .find(|child| child.name == name)
        .map(|child| child.text.as_str())
}

/// Read the telnet quick view from the synthesized tree: per component (in the engine's hard-coded
/// table order) read the `<telnet_service>` port/password. The port follows the JS Number.isFinite
/// contract (0 is valid and kept, non-numeric -> None); the password is emitted only when non-empty;
/// a component section missing telnet_service -> all None (no guessing).
pub fn telnet_summary(root: &ConfigNode) -> Vec<TelnetSummaryEntry> {
    ENGINE_DEFAULT_TELNET_PORTS
        .iter()
        .map(|component| {
            let section = find_among_layers(root, component).and_then(|node| {
                node.children
                    .iter()
                    .find(|child| child.name == "telnet_service")
            });
            let port = section
                .and_then(|s| child_leaf(s, "port"))
                .and_then(leaf_number);
            let password = section
                .and_then(|s| child_leaf(s, "password"))
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(str::to_string);
            TelnetSummaryEntry {
                component: (*component).to_string(),
                port,
                password,
            }
        })
        .collect()
}

/// Extract the connection essentials of `<dbmgr><databaseInterfaces><default>` from the synthesized
/// tree; section missing -> None. username/encrypt hide under `<auth>`, characterSet under
/// `<unicodeString>`; a missing/invalid/0 port falls back to 3306 (engine `<port>0` means "use the
/// mysql default", db_interface_mysql.cpp:166-167).
pub fn db_interface_config(root: &ConfigNode) -> Option<DatabaseInterfaceConfig> {
    let iface = find_among_layers(root, "dbmgr")?
        .children
        .iter()
        .find(|child| child.name == "databaseInterfaces")?
        .children
        .iter()
        .find(|child| child.name == "default")?;
    let auth = iface.children.iter().find(|child| child.name == "auth");
    let unicode = iface
        .children
        .iter()
        .find(|child| child.name == "unicodeString");
    let leaf_text = |name: &str| -> &str { child_leaf(iface, name).unwrap_or("") };
    let (default_host, default_port, default_username, default_database, default_charset) =
        ENGINE_DB_INTERFACE_DEFAULTS;
    let host = leaf_text("host").trim();
    let username = auth
        .and_then(|a| child_leaf(a, "username"))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(default_username);
    let database = leaf_text("databaseName").trim();
    let charset = unicode
        .and_then(|u| child_leaf(u, "characterSet"))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(default_charset);
    // encrypt defaults to true: any value (lowercased) other than the literal false means encrypted
    let encrypt = auth
        .and_then(|a| child_leaf(a, "encrypt"))
        .map(str::trim)
        .map(|v| !v.eq_ignore_ascii_case("false"))
        .unwrap_or(true);
    let plain_password = if encrypt {
        None
    } else {
        auth.and_then(|a| child_leaf(a, "password"))
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    Some(DatabaseInterfaceConfig {
        host: if host.is_empty() {
            default_host.to_string()
        } else {
            host.to_string()
        },
        port: leaf_number(leaf_text("port"))
            .filter(|v| *v > 0.0)
            .unwrap_or(default_port),
        username: username.to_string(),
        database_name: if database.is_empty() {
            default_database.to_string()
        } else {
            database.to_string()
        },
        encrypt,
        character_set: charset.to_string(),
        plain_password,
    })
}

/// Read the telnet_service section of the project config (mirrors TS parseKbengineXmlTelnet
/// semantics: first `<telnet_service>` in document order, invalid port number -> None, empty
/// password -> None).
#[derive(Debug, Clone, PartialEq)]
pub struct CustomTelnet {
    pub port: Option<f64>,
    pub password: Option<String>,
}

/// Output of `$/kode/config/resolve`: both trees + the synthesized tree + telnet quick view +
/// database connection essentials + project-config telnet section values, all emitted at once
/// (the single data source for TS consuming channels).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedConfig {
    pub defaults_tree: Option<ConfigNode>,
    pub custom_tree: Option<ConfigNode>,
    pub merged: Option<ConfigNode>,
    pub telnet_summary: Vec<TelnetSummaryEntry>,
    pub db_interface: Option<DatabaseInterfaceConfig>,
    /// Project-config (custom-side) telnet_service section values (custom tree missing / no section -> None)
    pub custom_telnet: Option<CustomTelnet>,
}

/// Parse the defaults + project-config raw text, merge under the engine same-key-override rules,
/// and read out the telnet quick view and database connection essentials. Both sides missing ->
/// an all-empty result (merged None, no guessing).
/// First name-matching node in document order (mirrors the Rust derive-side first_node semantics).
fn first_node<'a>(node: &'a ConfigNode, name: &str) -> Option<&'a ConfigNode> {
    node.children
        .iter()
        .find(|child| child.name == name)
        .or_else(|| {
            node.children
                .iter()
                .find_map(|child| first_node(child, name))
        })
}

/// Read the telnet_service section of the project config (core-migrated form of TS
/// parseKbengineXmlTelnet: no section -> None; port text follows the JS Number.isFinite contract;
/// empty password -> None).
pub fn custom_telnet(custom_tree: Option<&ConfigNode>) -> Option<CustomTelnet> {
    let section = first_node(custom_tree?, "telnet_service")?;
    let port = child_leaf(section, "port").and_then(leaf_number);
    let password = child_leaf(section, "password")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    Some(CustomTelnet { port, password })
}

pub fn resolve_config(defaults_xml: Option<&str>, custom_xml: Option<&str>) -> ResolvedConfig {
    let defaults_tree = defaults_xml.and_then(parse_config);
    let custom_tree = custom_xml.and_then(parse_config);
    let merged = match (&defaults_tree, &custom_tree) {
        (Some(defaults), Some(custom)) => Some(merge_config_xml(defaults, custom)),
        (Some(defaults), None) => Some(defaults.clone()),
        _ => None,
    };
    let telnet_summary = merged.as_ref().map(telnet_summary).unwrap_or_default();
    let db_interface = merged.as_ref().and_then(db_interface_config);
    let custom_telnet = custom_telnet(custom_tree.as_ref());
    ResolvedConfig {
        defaults_tree,
        custom_tree,
        merged,
        telnet_summary,
        db_interface,
        custom_telnet,
    }
}
