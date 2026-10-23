//! 逐字节 XML 状态机:arena 树 + 精确 span + 容错恢复(SYNTAX-002/003/005)。
//!
//! - 输入是**原始字节**(UTF-8);文本/属性值解码五个预定义实体与 `&#..;`。
//! - 每个节点保留开/闭标签、内容、名称的精确字节区间;`.def` 悬停/诊断
//!   的 file:line 映射不丢定位。
//! - 任何坏输入:记录结构化诊断、局部恢复(跳到下一个 `<`),**绝不 panic、
//!   绝不丢掉已解析部分**(活编辑器中途不完整是常态)。
//! - `.def` 伪注释:引擎历史格式允许 `#` 开头行(如 `# <原本 80 列>` 截断头),
//!   [`mask_def_pseudo_comments`] 把这类行整行替换为空格——字节长度不变,
//!   因此 span 对原始文件依然精确。

use crate::diag::{DiagCode, Diagnostic, Span};

/// 解析树节点(arena 下标引用,父指针避免递归所有权)。
#[derive(Debug, Clone)]
pub struct Node {
    pub parent: Option<usize>,
    pub data: NodeData,
}

/// 节点体。注释/PI/声明只留 span(引擎格式不消费其内容)。
#[derive(Debug, Clone)]
pub enum NodeData {
    Element(ElementData),
    Text { span: Span, decoded: String },
    Comment { span: Span },
    Cdata { span: Span, decoded: String },
    ProcessingInstruction { span: Span },
    Declaration { span: Span },
}

/// 元素:开/闭标签、内容、名称 span 与属性(SYNTAX-002:值解析不丢定位)。
#[derive(Debug, Clone)]
pub struct ElementData {
    pub name: String,
    pub name_span: Span,
    /// 开标签整体 `<name ...>`(含 `<` 与 `>`)。
    pub open_span: Span,
    /// 开闭标签之间的内容区间(自闭合为空)。
    pub content_span: Span,
    /// 闭合标签整体;自闭合时为空区间,起点=开标签终点。
    pub close_span: Span,
    pub self_closing: bool,
    pub attributes: Vec<Attribute>,
    pub children: Vec<usize>,
}

impl ElementData {
    pub fn attribute(&self, name: &str) -> Option<&Attribute> {
        self.attributes.iter().find(|a| a.name == name)
    }

    /// 直接文本子节点的解码文本拼接(等价 TS getElementText)。
    pub fn text(&self, doc: &Document) -> String {
        let mut out = String::new();
        for &c in &self.children {
            if let NodeData::Text { decoded, .. } = &doc.nodes[c].data {
                out.push_str(decoded);
            }
        }
        out
    }

    /// getElementText(item).trim().split(/\s+/)[0] 的等价物:首个非空白 token。
    pub fn first_text_token(&self, doc: &Document) -> Option<String> {
        self.text(doc)
            .split_whitespace()
            .next()
            .filter(|t| !t.is_empty())
            .map(str::to_string)
    }
}

/// 属性:解码值 + 名称/值 span。
#[derive(Debug, Clone)]
pub struct Attribute {
    pub name: String,
    pub name_span: Span,
    pub value: String,
    pub value_span: Span,
}

/// 解析产物:arena + 顶层节点 + 诊断。
#[derive(Debug, Clone)]
pub struct Document {
    pub nodes: Vec<Node>,
    pub roots: Vec<usize>,
    pub diagnostics: Vec<Diagnostic>,
    pub len: usize,
}

impl Document {
    /// 第一个顶层元素(fxp preserveOrder 的 document.root 等价物)。
    pub fn root(&self) -> Option<usize> {
        self.roots
            .iter()
            .copied()
            .find(|&i| matches!(self.nodes[i].data, NodeData::Element(_)))
    }

    pub fn element(&self, idx: usize) -> &ElementData {
        match &self.nodes[idx].data {
            NodeData::Element(e) => e,
            _ => unreachable!("element() called on non-element node"),
        }
    }

    /// 直接元素子节点下标。
    pub fn child_elements(&self, idx: usize) -> Vec<usize> {
        self.element(idx)
            .children
            .iter()
            .copied()
            .filter(|&c| matches!(self.nodes[c].data, NodeData::Element(_)))
            .collect()
    }

    /// 名字匹配的直接元素子节点(首个)。
    pub fn child_element(&self, idx: usize, name: &str) -> Option<usize> {
        self.child_elements(idx)
            .into_iter()
            .find(|&c| self.element(c).name == name)
    }

    /// 名字匹配的全部直接元素子节点。
    pub fn child_elements_named(&self, idx: usize, name: &str) -> Vec<usize> {
        self.child_elements(idx)
            .into_iter()
            .filter(|&c| self.element(c).name == name)
            .collect()
    }

    /// TS getScalarChildValue:直接子元素文本 trim,空串视作无值。
    pub fn scalar_child_value(&self, idx: usize, name: &str) -> Option<String> {
        let child = self.child_element(idx, name)?;
        let value = self.element(child).text(self).trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }

    /// TS hasTruthyChildTag:自闭合即真;文本 ∈ {'', true, 1, yes}(小写)为真。
    pub fn truthy_child(&self, idx: usize, name: &str) -> bool {
        let child = match self.child_element(idx, name) {
            Some(c) => c,
            None => return false,
        };
        let e = self.element(child);
        if e.self_closing {
            return true;
        }
        matches!(
            e.text(self).trim().to_ascii_lowercase().as_str(),
            "" | "true" | "1" | "yes"
        )
    }
}

/// 解析入口。`mask_pseudo_comments` 为 true 时先做 `#` 行掩码(仅 `.def`)。
pub fn parse(text: &str, mask_pseudo_comments: bool) -> Document {
    let owned;
    let bytes: &[u8] = if mask_pseudo_comments {
        owned = mask_def_pseudo_comments(text.as_bytes());
        &owned
    } else {
        text.as_bytes()
    };
    let mut p = Parser {
        b: bytes,
        pos: 0,
        nodes: Vec::new(),
        roots: Vec::new(),
        diagnostics: Vec::new(),
        stack: Vec::new(),
    };
    p.run();
    Document {
        nodes: p.nodes,
        roots: p.roots,
        diagnostics: p.diagnostics,
        len: bytes.len(),
    }
}

struct Parser<'a> {
    b: &'a [u8],
    pos: usize,
    nodes: Vec<Node>,
    roots: Vec<usize>,
    diagnostics: Vec<Diagnostic>,
    stack: Vec<usize>,
}

fn is_name_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b == b':'
}

fn is_name_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b':' || b == b'-' || b == b'.'
}

impl<'a> Parser<'a> {
    fn run(&mut self) {
        while self.pos < self.b.len() {
            if self.b[self.pos] != b'<' {
                self.parse_text();
                continue;
            }
            match self.peek_after_lt() {
                b'!' if self.starts_with(b"<!--") => self.parse_comment(),
                b'!' if self.starts_with(b"<![CDATA[") => self.parse_cdata(),
                b'!' => self.parse_doctype(),
                b'?' => self.parse_pi(),
                b'/' => self.parse_close_tag(),
                _ if self.pos + 1 < self.b.len() && is_name_start(self.b[self.pos + 1]) => {
                    self.parse_open_tag();
                }
                _ => {
                    // '<' 后无合法构造:记诊断,把 '<' 当文本收掉并继续。
                    let span = Span::new(self.pos, self.pos + 1);
                    self.diagnostics.push(Diagnostic::new(
                        DiagCode::UnexpectedLt,
                        crate::diag::Severity::Error,
                        span,
                        "'<' 后不是可识别的标签/注释/CDATA/PI 构造",
                    ));
                    self.pos += 1;
                }
            }
        }
        // EOF 还有未闭合元素:容错收尾(逐个补 close span),不丢树。
        let end = self.b.len();
        while let Some(idx) = self.stack.pop() {
            let name_start = {
                let e = self.element_mut(idx);
                e.content_span = Span::new(e.content_span.start, end);
                e.close_span = Span::new(end, end);
                e.name_span.start
            };
            self.diagnostics.push(Diagnostic::new(
                DiagCode::UnclosedElement,
                crate::diag::Severity::Error,
                Span::new(name_start, end),
                "未闭合元素(输入在标签内结束)",
            ));
        }
    }

    fn peek_after_lt(&self) -> u8 {
        *self.b.get(self.pos + 1).unwrap_or(&0)
    }

    fn starts_with(&self, pat: &[u8]) -> bool {
        self.b[self.pos..].starts_with(pat)
    }

    fn push_node(&mut self, data: NodeData) -> usize {
        let parent = self.stack.last().copied();
        let idx = self.nodes.len();
        self.nodes.push(Node { parent, data });
        match parent {
            Some(p) => self.element_mut(p).children.push(idx),
            None => self.roots.push(idx),
        }
        idx
    }

    fn element_mut(&mut self, idx: usize) -> &mut ElementData {
        match &mut self.nodes[idx].data {
            NodeData::Element(e) => e,
            _ => unreachable!("element_mut on non-element"),
        }
    }

    fn parse_text(&mut self) {
        let start = self.pos;
        while self.pos < self.b.len() && self.b[self.pos] != b'<' {
            self.pos += 1;
        }
        let span = Span::new(start, self.pos);
        let bytes = self.b;
        let decoded = decode_entities(
            &bytes[span.start..span.end],
            &mut self.diagnostics,
            span.start,
        );
        // 纯空白文本也保留:TS fxp(trimValues:false)同样产出空白文本节点,
        // getElementText 的首 token 语义依赖它们存在与否等价。
        self.push_node(NodeData::Text { span, decoded });
    }

    fn parse_comment(&mut self) {
        let start = self.pos;
        self.pos += 4;
        let mut end = self.pos;
        let mut closed = false;
        while end + 2 < self.b.len() + 1 {
            if end + 3 <= self.b.len() && &self.b[end..end + 3] == b"-->" {
                closed = true;
                break;
            }
            end += 1;
        }
        if closed {
            self.pos = end + 3;
            self.push_node(NodeData::Comment {
                span: Span::new(start, self.pos),
            });
        } else {
            self.pos = self.b.len();
            self.diagnostics.push(Diagnostic::new(
                DiagCode::UnterminatedComment,
                crate::diag::Severity::Error,
                Span::new(start, self.pos),
                "注释未闭合(缺 '-->')",
            ));
        }
    }

    fn parse_cdata(&mut self) {
        let start = self.pos;
        self.pos += 9;
        let content_start = self.pos;
        let mut end = content_start;
        let mut closed = false;
        while end + 3 <= self.b.len() {
            if &self.b[end..end + 3] == b"]]>" {
                closed = true;
                break;
            }
            end += 1;
        }
        if closed {
            let bytes = self.b;
            let decoded = String::from_utf8_lossy(&bytes[content_start..end]).into_owned();
            self.pos = end + 3;
            self.push_node(NodeData::Cdata {
                span: Span::new(start, self.pos),
                decoded,
            });
        } else {
            self.pos = self.b.len();
            self.diagnostics.push(Diagnostic::new(
                DiagCode::UnterminatedCdata,
                crate::diag::Severity::Error,
                Span::new(start, self.pos),
                "CDATA 未闭合(缺 ']]>')",
            ));
        }
    }

    fn parse_doctype(&mut self) {
        let start = self.pos;
        let mut end = self.pos;
        let mut closed = false;
        while end < self.b.len() {
            if self.b[end] == b'>' {
                closed = true;
                break;
            }
            end += 1;
        }
        if closed {
            self.pos = end + 1;
        } else {
            self.pos = self.b.len();
        }
        self.push_node(NodeData::Declaration {
            span: Span::new(start, self.pos),
        });
        if !closed {
            self.diagnostics.push(Diagnostic::new(
                DiagCode::UnterminatedComment,
                crate::diag::Severity::Error,
                Span::new(start, self.pos),
                "<!...> 构造未闭合",
            ));
        }
    }

    fn parse_pi(&mut self) {
        let start = self.pos;
        let mut end = self.pos + 2;
        let mut closed = false;
        while end + 2 <= self.b.len() {
            if &self.b[end..end + 2] == b"?>" {
                closed = true;
                break;
            }
            end += 1;
        }
        if closed {
            self.pos = end + 2;
        } else {
            self.pos = self.b.len();
            self.diagnostics.push(Diagnostic::new(
                DiagCode::UnterminatedProcessingInstruction,
                crate::diag::Severity::Error,
                Span::new(start, self.pos),
                "处理指令未闭合(缺 '?>')",
            ));
        }
        self.push_node(NodeData::ProcessingInstruction {
            span: Span::new(start, self.pos),
        });
    }

    fn parse_close_tag(&mut self) {
        let start = self.pos;
        self.pos += 2;
        let name_start = self.pos;
        while self.pos < self.b.len() && is_name_char(self.b[self.pos]) {
            self.pos += 1;
        }
        let name = String::from_utf8_lossy(&self.b[name_start..self.pos]).into_owned();
        // 跳过名字后垃圾到 '>'
        while self.pos < self.b.len() && self.b[self.pos] != b'>' {
            self.pos += 1;
        }
        let end = (self.pos + 1).min(self.b.len());
        self.pos = end;
        let span = Span::new(start, end);
        if name.is_empty() {
            self.diagnostics.push(Diagnostic::new(
                DiagCode::InvalidTagName,
                crate::diag::Severity::Error,
                span,
                "闭合标签缺名字",
            ));
            return;
        }
        // 栈内找同名:找到则逐层弹出补诊断;找不到是游离闭合。
        // 精确匹配优先;退化容忍遗留多词标签(</Client> 闭合 <Client Flags>)。
        let open_canon = crate::model::canonical_tag(&name);
        let match_depth = self
            .stack
            .iter()
            .rev()
            .position(|&idx| self.element_ref(idx).name == name)
            .or_else(|| {
                if open_canon.chars().count() < 3 {
                    return None;
                }
                self.stack.iter().rev().position(|&idx| {
                    let open = crate::model::canonical_tag(&self.element_ref(idx).name);
                    open.starts_with(&open_canon) && open != open_canon
                })
            });
        match match_depth {
            Some(depth_from_top) => {
                // 弹出 depth_from_top+1 层:被同名闭合的层拿到精确 close span,
                // 中途被连带闭合的层记 MismatchedCloseTag(容错收口,不丢树)。
                for k in 0..=depth_from_top {
                    let idx = self.stack[self.stack.len() - 1 - k];
                    if k > 0 {
                        let n = self.element_ref(idx).name.clone();
                        self.diagnostics.push(Diagnostic::new(
                            DiagCode::MismatchedCloseTag,
                            crate::diag::Severity::Error,
                            span,
                            format!("<{n}> 被更内层的 </{name}> 连带闭合"),
                        ));
                    }
                    self.close_element(idx, span);
                }
                self.stack.truncate(self.stack.len() - 1 - depth_from_top);
            }
            None => {
                self.diagnostics.push(Diagnostic::new(
                    DiagCode::StrayCloseTag,
                    crate::diag::Severity::Error,
                    span,
                    format!("</{name}> 没有对应的打开标签"),
                ));
            }
        }
    }

    fn element_ref(&self, idx: usize) -> &ElementData {
        match &self.nodes[idx].data {
            NodeData::Element(e) => e,
            _ => unreachable!("element_ref on non-element"),
        }
    }

    fn close_element(&mut self, idx: usize, close_span: Span) {
        let e = self.element_mut(idx);
        e.close_span = close_span;
        e.content_span = Span::new(e.content_span.start, close_span.start);
    }

    fn parse_open_tag(&mut self) {
        let tag_start = self.pos;
        self.pos += 1; // '<'
        let name_start = self.pos;
        while self.pos < self.b.len() && is_name_char(self.b[self.pos]) {
            self.pos += 1;
        }
        let name_span = Span::new(name_start, self.pos);
        let name = String::from_utf8_lossy(&self.b[name_span.start..name_span.end]).into_owned();
        let idx = self.push_node(NodeData::Element(ElementData {
            name: name.clone(),
            name_span,
            open_span: Span::new(tag_start, tag_start),
            content_span: Span::new(self.pos, self.pos),
            close_span: Span::new(self.pos, self.pos),
            self_closing: false,
            attributes: Vec::new(),
            children: Vec::new(),
        }));
        self.stack.push(idx);

        let mut attributes: Vec<Attribute> = Vec::new();
        loop {
            self.skip_ws();
            match self.b.get(self.pos).copied() {
                None => {
                    // 输入在开标签内结束:容错,标签保持打开(EOF 收尾处理)。
                    let p = self.pos;
                    let e = self.element_mut(idx);
                    e.open_span = Span::new(tag_start, p);
                    e.attributes = attributes;
                    return;
                }
                Some(b'>') => {
                    self.pos += 1;
                    let p = self.pos;
                    let e = self.element_mut(idx);
                    e.open_span = Span::new(tag_start, p);
                    e.content_span = Span::new(p, p);
                    e.close_span = Span::new(p, p);
                    e.attributes = attributes;
                    return;
                }
                Some(b'/') => {
                    // '/>':要求紧邻 '>',否则按 '>' 前垃圾容错。
                    if self.b.get(self.pos + 1) == Some(&b'>') {
                        self.pos += 2;
                        let p = self.pos;
                        let e = self.element_mut(idx);
                        e.open_span = Span::new(tag_start, p);
                        e.content_span = Span::new(p, p);
                        e.close_span = Span::new(p, p);
                        e.self_closing = true;
                        e.attributes = attributes;
                        self.stack.pop();
                        return;
                    }
                    self.pos += 1;
                }
                Some(_) => {
                    // 遗留多词标签容忍:属性位出现「无 = 的裸词且紧跟 >」时
                    // (如 `<Client Flags> ALL_CLIENTS </Client Flags>`),
                    // 视作标签名延续,不是属性。
                    let word_start = self.pos;
                    let save = self.pos;
                    while self.pos < self.b.len() && is_name_char(self.b[self.pos]) {
                        self.pos += 1;
                    }
                    let is_bare_name = self.pos > word_start;
                    let word_end = self.pos;
                    self.skip_ws();
                    if is_bare_name && self.b.get(self.pos) == Some(&b'>') {
                        self.pos = word_end;
                        let word =
                            String::from_utf8_lossy(&self.b[word_start..word_end]).into_owned();
                        let p = self.pos;
                        let e = self.element_mut(idx);
                        e.name.push(' ');
                        e.name.push_str(&word);
                        e.name_span = Span::new(e.name_span.start, p);
                        continue;
                    }
                    self.pos = save;
                    let _ = self.parse_attribute(&mut attributes);
                }
            }
        }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.b.len() && self.b[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn parse_attribute(&mut self, attributes: &mut Vec<Attribute>) -> Option<()> {
        let name_start = self.pos;
        if !self.b.get(self.pos).copied().is_some_and(is_name_start) {
            // 属性位垃圾:记诊断,跳到 '>' 或下一个可能的名字起点。
            let junk_start = self.pos;
            while self.pos < self.b.len()
                && !self.b[self.pos].is_ascii_whitespace()
                && self.b[self.pos] != b'>'
                && self.b[self.pos] != b'/'
            {
                self.pos += 1;
            }
            if self.pos == junk_start {
                self.pos += 1; // 保证前进,避免死循环
            }
            self.diagnostics.push(Diagnostic::new(
                DiagCode::InvalidAttribute,
                crate::diag::Severity::Error,
                Span::new(junk_start, self.pos),
                "属性位出现非法字符",
            ));
            return None;
        }
        while self.pos < self.b.len() && is_name_char(self.b[self.pos]) {
            self.pos += 1;
        }
        let name_span = Span::new(name_start, self.pos);
        let name = String::from_utf8_lossy(&self.b[name_span.start..name_span.end]).into_owned();
        self.skip_ws();
        let value;
        let value_span;
        if self.b.get(self.pos) == Some(&b'=') {
            self.pos += 1;
            self.skip_ws();
            match self.b.get(self.pos).copied() {
                Some(q @ (b'"' | b'\'')) => {
                    self.pos += 1;
                    let vstart = self.pos;
                    while self.pos < self.b.len() && self.b[self.pos] != q {
                        self.pos += 1;
                    }
                    if self.pos >= self.b.len() {
                        self.diagnostics.push(Diagnostic::new(
                            DiagCode::UnterminatedAttributeValue,
                            crate::diag::Severity::Error,
                            Span::new(vstart - 1, self.pos),
                            format!("属性 {name} 的引号值未闭合"),
                        ));
                    }
                    value_span = Span::new(vstart, self.pos);
                    let bytes = self.b;
                    let decoded = decode_entities(
                        &bytes[vstart..value_span.end],
                        &mut self.diagnostics,
                        vstart,
                    );
                    if self.pos < self.b.len() {
                        self.pos += 1; // 收掉闭合引号
                    }
                    value = decoded;
                }
                Some(_) => {
                    let vstart = self.pos;
                    while self.pos < self.b.len()
                        && !self.b[self.pos].is_ascii_whitespace()
                        && self.b[self.pos] != b'>'
                    {
                        self.pos += 1;
                    }
                    value_span = Span::new(vstart, self.pos);
                    let bytes = self.b;
                    value =
                        decode_entities(&bytes[vstart..self.pos], &mut self.diagnostics, vstart);
                    self.diagnostics.push(Diagnostic::new(
                        DiagCode::InvalidAttribute,
                        crate::diag::Severity::Warning,
                        Span::new(name_span.start, self.pos),
                        format!("属性 {name} 值未加引号"),
                    ));
                }
                None => {
                    self.diagnostics.push(Diagnostic::new(
                        DiagCode::UnterminatedAttributeValue,
                        crate::diag::Severity::Error,
                        Span::new(self.pos, self.pos),
                        format!("属性 {name} 缺值(输入结束)"),
                    ));
                    value = String::new();
                    value_span = Span::new(self.pos, self.pos);
                }
            }
        } else {
            self.diagnostics.push(Diagnostic::new(
                DiagCode::InvalidAttribute,
                crate::diag::Severity::Error,
                name_span,
                format!("属性 {name} 缺 '='"),
            ));
            value = String::new();
            value_span = Span::new(self.pos, self.pos);
        }
        if attributes.iter().any(|a| a.name == name) {
            self.diagnostics.push(Diagnostic::new(
                DiagCode::DuplicateAttribute,
                crate::diag::Severity::Warning,
                name_span,
                format!("重复属性 {name}(保留首个)"),
            ));
            return Some(());
        }
        attributes.push(Attribute {
            name,
            name_span,
            value,
            value_span,
        });
        Some(())
    }
}

/// 实体解码(文本/属性共用)。未知实体记诊断、保留原文。
fn decode_entities(bytes: &[u8], diags: &mut Vec<Diagnostic>, base: usize) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'&' {
            // 直接按 UTF-8 复制(输入保证是 &str 切片,多字节序列完整)
            let ch_start = i;
            i += 1;
            while i < bytes.len() && (bytes[i] & 0xC0) == 0x80 {
                i += 1;
            }
            out.push_str(&String::from_utf8_lossy(&bytes[ch_start..i]));
            continue;
        }
        let ent_start = i;
        let mut j = i + 1;
        let known: &[(&[u8], &str)] = &[
            (b"amp;", "&"),
            (b"lt;", "<"),
            (b"gt;", ">"),
            (b"quot;", "\""),
            (b"apos;", "'"),
        ];
        let mut matched = false;
        for (pat, rep) in known {
            if bytes[j..].starts_with(pat) {
                out.push_str(rep);
                j += pat.len();
                matched = true;
                break;
            }
        }
        if matched {
            i = j;
            continue;
        }
        // 数字实体 &#NN; / &#xHH;
        if bytes.get(j) == Some(&b'#') {
            j += 1;
            let hex = bytes.get(j).copied() == Some(b'x') || bytes.get(j).copied() == Some(b'X');
            if hex {
                j += 1;
            }
            let digits_start = j;
            while j < bytes.len()
                && (if hex {
                    bytes[j].is_ascii_hexdigit()
                } else {
                    bytes[j].is_ascii_digit()
                })
            {
                j += 1;
            }
            if j > digits_start && bytes.get(j) == Some(&b';') {
                let digits = std::str::from_utf8(&bytes[digits_start..j]).unwrap_or("0");
                let code = u32::from_str_radix(digits, if hex { 16 } else { 10 }).unwrap_or(0xFFFD);
                out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                i = j + 1;
                continue;
            }
        }
        // 未知实体:保留原文字节,记诊断。
        while j < bytes.len()
            && bytes[j] != b';'
            && bytes[j] != b'<'
            && bytes[j].is_ascii_alphanumeric()
        {
            j += 1;
        }
        let ent_end = (j + 1).min(bytes.len());
        diags.push(Diagnostic::new(
            DiagCode::InvalidEntity,
            crate::diag::Severity::Warning,
            Span::new(base + ent_start, base + ent_end),
            "未知实体引用,按原文保留",
        ));
        out.push_str(&String::from_utf8_lossy(&bytes[ent_start..ent_end]));
        i = ent_end;
    }
    out
}

/// `.def` 伪注释掩码:`#` 开头行(前导空白允许)整行替换为空格。
///
/// - 只在**标签外**生效(状态机跟踪 `<`/引号),标签行内的 `#` 不受影响;
/// - 字节长度严格不变 → 掩码后文本上的 span 对原文件逐字节成立;
/// - 已知限制(文档化):CDATA 内部行首 `#` 同样被掩码。KBEngine .def 不使用
///   CDATA;若未来需要,掩码前先跑一轮 CDATA 区间扫描。
pub fn mask_def_pseudo_comments(input: &[u8]) -> Vec<u8> {
    let mut out = input.to_vec();
    let mut in_tag = false;
    let mut quote: Option<u8> = None;
    let mut line_start_ws_only = true;
    let mut i = 0;
    while i < out.len() {
        let b = out[i];
        if b == b'\n' {
            line_start_ws_only = true;
            i += 1;
            continue;
        }
        if line_start_ws_only && b.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if line_start_ws_only && b == b'#' && !in_tag {
            while i < out.len() && out[i] != b'\n' {
                out[i] = b' ';
                i += 1;
            }
            continue;
        }
        line_start_ws_only = false;
        if in_tag {
            if let Some(q) = quote {
                if b == q {
                    quote = None;
                }
            } else if b == b'"' || b == b'\'' {
                quote = Some(b);
            } else if b == b'>' {
                in_tag = false;
            }
        } else if b == b'<' {
            in_tag = true;
        }
        i += 1;
    }
    out
}
