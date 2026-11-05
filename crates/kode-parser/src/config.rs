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
            if b.get(i + 1) == Some(&b'!') && b.get(i + 2) == Some(&b'-') && b.get(i + 3) == Some(&b'-') {
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
                            arena[top].source_comments.extend(pending.drain(..));
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
                        arena[idx].source_comments.extend(pending.drain(..));
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
            arena[t].source_comments.extend(pending.drain(..));
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
        ' ' | '\t'
            | '\n'
            | '\u{0b}'
            | '\u{0c}'
            | '\r'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
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
        if normalized.is_empty() || seen.iter().any(|s| *s == normalized) {
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
    for child in base
        .children
        .iter()
        .chain(override_node.children.iter())
    {
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
