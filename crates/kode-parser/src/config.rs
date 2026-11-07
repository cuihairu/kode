//! KBEngine 服务端配置 XML 解析(配置先行域,KODE-CFG-002)。
//!
//! 逐语义对齐 TS `parseConfigXml`(`src/serverConfigMerge.ts:62`),供
//! `$/kode/config/*` 通道与字节级对拍复用。纯函数、零第三方依赖、不 panic
//! (沿用本 crate 铁律)。语义对齐清单见 `docs/design/config-first.md` §7.1。
//!
//! 关键差异面(相对字节级 def 解析器):这是**正则容错**解析——仅需元素树,
//! 属性忽略(只用于自闭合判定);声明/XML PI 丢弃;注释**不剥离**,按位置
//! 关联进树(`source_comments` 捕获,KODE-CFG-010:行内/尾随挂所属元素、
//! 前导挂紧随元素、段尾/文件尾游离就近挂容器);标签不闭合/多余闭合按
//! 已见内容容错不抛;根为伪节点(名字空),顶层组件段作其 children。

/// 配置合成树节点(镜像 TS `ConfigXmlNode`)。
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigNode {
    /// 元素名;伪根为空串
    pub name: String,
    /// 叶子值(空格 join,伪根跳过)
    pub text: String,
    /// 子段/子键
    pub children: Vec<ConfigNode>,
    /// 源注释(输入 XML 原文):行内/尾随挂所属元素、前导挂紧随元素、
    /// 段尾/文件尾游离就近挂容器。渲染时原样回写(TS 侧 render 面)。
    pub source_comments: Vec<String>,
}

/// 词法 token(镜像 JS `tokenRe` 三分支)。
enum TokenKind {
    /// 注释体(不含 `<!--`/`-->` 定界符)
    Comment(String),
    /// 声明/XML PI(丢弃)
    Pi,
    /// 标签
    Tag {
        name: String,
        /// 标签名之后的原样文本(自闭合判定用)
        attrs: String,
        is_close: bool,
    },
}

struct Token {
    start: usize,
    end: usize,
    kind: TokenKind,
}

/// 找 `needle` 在 `hay[start..]` 的第一次出现(字节序,定界符均 ASCII)。
fn find_from(hay: &str, start: usize, needle: &str) -> Option<usize> {
    hay.get(start..)?.find(needle).map(|off| start + off)
}

/// 下一个 token:镜像 JS
/// `tokenRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)(\w+)([^>]*)>/g`。
///
/// 优先级(同一位置):comment > PI > tag(JS 交替序);无闭合定界符的候选
/// 不算 token(JS 懒量词 `*?` 失败→该位置整分支不匹配→推进)。标签名只收
/// `[A-Za-z0-9_]`(`\w` ASCII),属性取标签名后到 `>` 前原样(含 `/` 结尾)。
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
                // 无 `-->`:非 token,按文本推进
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
                    // 无 `>`:非 token,按文本推进
                }
            }
        }
        i += 1;
    }
    None
}

/// 自闭合判定:镜像 JS `/\/\s*$/.test(attrs)`——尾部 `/` 可跟空白。
fn is_self_closing(attrs: &str) -> bool {
    attrs.trim_end().ends_with('/')
}

/// 解析引擎风格的服务端配置 XML(仅需元素树;属性忽略;声明/PI 丢弃)。
///
/// 镜像 TS `parseConfigXml` 全语义:注释按位置关联进树(源注释归属规则)、
/// 根为伪节点、标签不闭合/多余闭合容错不抛、无子节点返回 `None`。
pub fn parse_config(xml: &str) -> Option<ConfigNode> {
    struct Node {
        name: String,
        text: String,
        children: Vec<usize>,
        source_comments: Vec<String>,
    }
    // 节点竞技场:index 0 = 伪根;children 存子节点索引。规避递归可变借用,
    // 且 lastClosed 指向已闭合节点(其 children 已定型,只追加源注释)。
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
        // takeText:上一 token 尾到当前 token 首之间的文本,trim 后空格 join
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
                        // 行内/尾随注释 → 最近闭合的元素
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
                    // 多余闭合(名字不匹配/根上闭合):忽略
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
    // 文件尾游离注释:就近挂到尚未闭合的容器;栈已空则挂段首容器元素。
    // 一个元素都没有(纯注释输入)则丢弃——与 TS 返回 None 的路径一致。
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
    // 竞技场 → ConfigNode 树
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

// --- 合并语义(KODE-CFG-003,镜像 TS mergeConfigXml/mergeSourceComments) ---

/// JS `\s` 精确字符集(与 Rust `is_whitespace` 在 `\u{feff}` 等处有出入,
/// 对拍须逐字节一致,故按 ECMAScript 定义镜像)。
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

/// 注释内容消毒:镜像 TS `sanitizeXmlComment`(serverConfigCommentText.ts:11)——
/// 空白串压成单空格并 trim、`-` 连串压成单个、结尾 `-` 补空格(防与 `-->` 拼出
/// `--`)。合并去重与渲染回写共用此口径。
pub fn sanitize_xml_comment(text: &str) -> String {
    // /\s+/g → ' '
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
    // trim()(替换后边缘只剩单空格)
    let trimmed = spaced.trim_matches(' ');
    // /-+/g → '-'
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

/// 两侧源注释合并(override 优先):override 侧在前、defaults 侧在后;规范化
/// (sanitize)后相同只留首条(保留原文);全空返回 None(不设 sourceComments)。
/// 镜像 TS `mergeSourceComments`(serverConfigMerge.ts:143)。
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

/// 合并(引擎同键覆盖口径,镜像 TS `mergeConfigXml`,serverConfigMerge.ts:164):
/// 以 defaults(base)为基、自定义(override)覆盖。子键按名字对齐——自定义没有
/// 的保留默认;自定义写了的整名替换(叶子取自定义值,重复名列表如 `<item>`
/// 整表替换,不与默认表交错);两边都是单一容器段则递归下钻。源注释两侧都保留:
/// override 侧在前(优先),同名单元素的 defaults 侧注释追加其后;重复名列表整表
/// 替换时只带自定义侧注释。
pub fn merge_config_xml(base: &ConfigNode, override_node: &ConfigNode) -> ConfigNode {
    // 名字序:base.children 全序在前,override 新名追加在后(各自保序去重)
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
            // 自定义没写 → 保留默认(整段原样)
            children.extend(base_ones.into_iter().cloned());
        } else if base_ones.is_empty() {
            // 默认没有 → 自定义整段
            children.extend(override_ones.into_iter().cloned());
        } else if base_ones.len() == 1
            && override_ones.len() == 1
            && !base_ones[0].children.is_empty()
            && !override_ones[0].children.is_empty()
        {
            // 两边都是单一容器段 → 递归下钻(子键继续对齐)
            children.push(merge_config_xml(base_ones[0], override_ones[0]));
        } else if base_ones.len() == 1 && override_ones.len() == 1 {
            // 同名单元素(叶子/空容器):值取自定义,源注释两侧都留(override 优先)
            let mut node = override_ones[0].clone();
            if let Some(comments) = merge_source_comments(base_ones[0], override_ones[0]) {
                node.source_comments = comments;
            }
            children.push(node);
        } else {
            // 重复名列表(任一侧多个)→ 整表替换为自定义侧
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

// ============ KODE-CFG-009:core resolve(消费通道唯一取数口) ============
//
// TS 消费面(hover 合成展示/telnet 速览/数据库连接要素)统一经
// `$/kode/config/resolve` 取本模块产物;TS 侧 parseConfigXml/mergeConfigXml/
// summarizeFinalTelnet/extractDatabaseInterfaceConfig 同步下线(设计 §6.2
// step 3),本模块是解析/合并/读值的唯一实现。

/// 引擎各组件 telnet 默认端口(kbengine_defaults.xml `<telnet_service><port/>`)。
/// 写死表自 TS `telnetService.ENGINE_DEFAULT_TELNET_PORTS` 迁入,core 为唯一真源。
pub const ENGINE_DEFAULT_TELNET_PORTS: [&str; 7] = [
    "loginapp",
    "dbmgr",
    "interfaces",
    "logger",
    "baseapp",
    "cellapp",
    "bots",
];

/// telnet 速览条目(镜像 TS summarizeFinalTelnet 产物:端口数字非法→None、
/// 0 合法保留、密码空→None)。
#[derive(Debug, Clone, PartialEq)]
pub struct TelnetSummaryEntry {
    pub component: String,
    pub port: Option<f64>,
    pub password: Option<String>,
}

/// dbmgr 数据库接口连接要素(镜像 TS extractDatabaseInterfaceConfig 产物:
/// 缺叶回落引擎默认;encrypt 缺省 true;明文密码只在 encrypt=false 提取)。
#[derive(Debug, Clone, PartialEq)]
pub struct DatabaseInterfaceConfig {
    pub host: String,
    /// 端口(缺/非法回落 3306;引擎 `<port>0` 表示用 mysql 默认,同样落 3306)
    pub port: f64,
    pub username: String,
    pub database_name: String,
    /// true = 密码经引擎 RSA 加密,kode 不读不解读
    pub encrypt: bool,
    pub character_set: String,
    /// 明文密码(仅 encrypt=false 时提取)
    pub plain_password: Option<String>,
}

/// 引擎 defaults dbmgr 段缺叶时的默认值(kbengine_defaults.xml
/// `<dbmgr><databaseInterfaces><default>`)。
const ENGINE_DB_INTERFACE_DEFAULTS: (&str, f64, &str, &str, &str) =
    ("localhost", 3306.0, "kbe", "kbe", "utf8mb4");

/// 文本按 JS `Number` 口径转数(配置读值用):trim 后空/非数/非有限 → None。
/// JS Number 还接受 "0x10"/"Infinity" 等形态,配置端口域不出现,不镜像。
fn leaf_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// 两候选层找段(镜像 TS extractDatabaseInterfaceConfig 的 candidates:
/// 伪根一层直挂组件段与 `<root>` 包裹二层都找)。
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

/// 从合成树读 telnet 速览:逐组件(引擎写死表序)读 `<telnet_service>` 端口/
/// 密码。端口按 JS Number.isFinite 口径(0 合法保留,非数→None),密码非空
/// 才带出;组件段缺 telnet_service → 全 None(不猜)。
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

/// 从合成树提取 `<dbmgr><databaseInterfaces><default>` 的连接要素;段缺→None。
/// username/encrypt 藏在 `<auth>` 下,characterSet 藏在 `<unicodeString>` 下;
/// 端口缺/非法/0 回落 3306(引擎 `<port>0` 即「用 mysql 默认」,
/// db_interface_mysql.cpp:166-167)。
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
    // encrypt 缺省 true:值(lowercase)非字面 false 即加密
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

/// 元件配置 telnet_service 段读值(镜像 TS parseKbengineXmlTelnet 语义:
/// 文档序首个 `<telnet_service>`,端口数字非法→None,密码空→None)。
#[derive(Debug, Clone, PartialEq)]
pub struct CustomTelnet {
    pub port: Option<f64>,
    pub password: Option<String>,
}

/// `$/kode/config/resolve` 产物:双树 + 合成树 + telnet 速览 + 数据库连接要素
/// + 元件 telnet 段读值一次出全(TS 消费通道唯一取数口)。
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedConfig {
    pub defaults_tree: Option<ConfigNode>,
    pub custom_tree: Option<ConfigNode>,
    pub merged: Option<ConfigNode>,
    pub telnet_summary: Vec<TelnetSummaryEntry>,
    pub db_interface: Option<DatabaseInterfaceConfig>,
    /// 元件配置(自定义侧)telnet_service 段读值(custom 树缺/无段 → None)
    pub custom_telnet: Option<CustomTelnet>,
}

/// 解析 defaults + 元件配置原文、按引擎同键覆盖合并、并读出 telnet 速览与
/// 数据库连接要素。两侧都缺 → 全空产物(merged None,不猜)。
/// 文档序首个名匹配节点(镜像 Rust derive 侧 first_node 语义)。
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

/// 元件配置 telnet_service 段读值(TS parseKbengineXmlTelnet 的 core 迁入形:
/// 无段 → None;端口文本按 JS Number.isFinite 口径;密码空 → None)。
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
