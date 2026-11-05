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
