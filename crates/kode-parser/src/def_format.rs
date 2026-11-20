//! `.def` 原生格式化核(KODE-SYN-006,评估结论见
//! docs/design/def-formatter-evaluation.md 方案 B)。
//!
//! 纯函数核:kode-parser 的精确 span 树 → 行化渲染 → 行级极小编辑集。
//! 零第三方依赖(铁律同 crate 头注),任何输入不 panic。
//!
//! 规则(首版):
//! - **缩进按深度**(默认 4 空格,官方 KBEngine `.def` 模板惯例);
//! - **有语义的值文本按 span 逐字节回写**:属性值照原引号形态(单/双/未加
//!   引号各自保形),实体解码后不再重编码;
//! - **注释 / CDATA / 处理指令 / 声明整体逐字节保留**(首行缩进归一,块体原样);
//! - **伪注释行(`#` 行首)逐字保留**——掩码函数把这类行变空白,因此它们在
//!   解析树里藏在文本节点的空白中,本核按原始字节分类,不当空白丢;
//! - **保守空行压缩**:连续空行压到一行,块首/块尾的结构换行不产空行;
//! - **安全退回**:任何解析诊断(不完整 XML 在活编辑器里是常态)→ 零编辑,
//!   绝不半改;渲染结果与原文逐字节相同 → 零编辑。
//!
//! 幂等:对已格式化的文本再跑一次返回零编辑(见 tests/def_format_units.rs)。

use crate::diag::Span;
use crate::xml::{self, Document, NodeData};

/// 格式化规则集(首版只有缩进尺寸;其余规则本核固定,见模块头注)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefFormatOptions {
    /// 每层缩进的空格数。
    pub indent_size: usize,
}

impl Default for DefFormatOptions {
    fn default() -> Self {
        DefFormatOptions { indent_size: 4 }
    }
}

/// 一条编辑:`[start, end)` 是**原文本**上的字节区间(`start == end` 为纯插入)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefFormatEdit {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// 渲染产物(格式化入口与测试共用):有解析诊断 → 原样返回输入。
pub fn format_def_text(text: &str, options: &DefFormatOptions) -> String {
    let doc = xml::parse(text, true);
    if !doc.diagnostics.is_empty() {
        return text.to_string();
    }
    render_document(&doc, text, options)
}

/// 一次解析两用:编辑集 + 解析诊断条数(单次 parse,不双算)。
///
/// `diagnostics` 供调用方把「零编辑」如实区分成两种口径:**已经格式化好**
/// (诊断 0、编辑 0)还是**解析不通、安全退回**(诊断非 0、编辑 0)——后者必须
/// 在编辑面上亮信息,不能当「无需格式化」静默。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefFormatReport {
    pub edits: Vec<DefFormatEdit>,
    pub diagnostics: usize,
}

pub fn format_def_report(text: &str, options: &DefFormatOptions) -> DefFormatReport {
    let doc = xml::parse(text, true);
    let diagnostics = doc.diagnostics.len();
    let edits = if doc.diagnostics.is_empty() {
        let formatted = render_document(&doc, text, options);
        if formatted == text {
            Vec::new()
        } else {
            line_edits(text, &formatted)
        }
    } else {
        Vec::new()
    };
    DefFormatReport { edits, diagnostics }
}

/// 极小编辑集:把 `[start, end)` 区间换成 `text`。空 = 不改(已格式化/安全退回)。
pub fn format_def_edits(text: &str, options: &DefFormatOptions) -> Vec<DefFormatEdit> {
    format_def_report(text, options).edits
}

/// 整个渲染器:根节点序列 → 行项序列,输出统一 LF、单一结尾换行。
fn render_document(doc: &Document, orig: &str, options: &DefFormatOptions) -> String {
    let mut renderer = Renderer {
        doc,
        orig,
        out: String::new(),
        pending_blank: false,
        options,
    };
    for &node in &doc.roots {
        renderer.render_node(node, 0);
    }
    renderer.out
}

struct Renderer<'a> {
    doc: &'a Document,
    /// 原始文本:掩码严格等长,故 span 对原文件逐字节成立(伪注释靠它逐字回写)。
    orig: &'a str,
    out: String,
    /// 待定空行(压缩后的至多一行);下一行项发射时先落一行空白。
    pending_blank: bool,
    options: &'a DefFormatOptions,
}

impl Renderer<'_> {
    fn indent(&mut self, level: usize) {
        for _ in 0..level * self.options.indent_size {
            self.out.push(' ');
        }
    }

    /// 发射一个行项:待定空行先落一行,再缩进 + 内容 + 换行。
    fn emit_line(&mut self, level: usize, content: &str) {
        if self.pending_blank {
            self.out.push('\n');
            self.pending_blank = false;
        }
        self.indent(level);
        self.out.push_str(content);
        self.out.push('\n');
    }

    fn mark_blank(&mut self) {
        self.pending_blank = true;
    }

    /// 块体原语(注释/CDATA/PI/声明):首行缩进归一,块体逐字节原样拷贝。
    fn emit_verbatim(&mut self, raw: &str, depth: usize) {
        if self.pending_blank {
            self.out.push('\n');
            self.pending_blank = false;
        }
        self.indent(depth);
        let body = raw.strip_suffix('\n').unwrap_or(raw);
        let body = body.strip_suffix('\r').unwrap_or(body);
        self.out.push_str(body);
        self.out.push('\n');
    }

    fn render_node(&mut self, idx: usize, depth: usize) {
        match &self.doc.nodes[idx].data {
            NodeData::Element(_) => self.render_element(idx, depth),
            NodeData::Text { span, .. } => self.render_text(slice_text(self.orig, *span), depth),
            NodeData::Comment { span }
            | NodeData::ProcessingInstruction { span }
            | NodeData::Declaration { span } => {
                self.emit_verbatim(slice_text(self.orig, *span), depth)
            }
            NodeData::Cdata { span, .. } => self.emit_verbatim(slice_text(self.orig, *span), depth),
        }
    }

    fn render_element(&mut self, idx: usize, depth: usize) {
        let e = self.doc.element(idx);
        let mut open = String::new();
        open.push('<');
        open.push_str(&e.name);
        let bytes = self.orig.as_bytes();
        for attr in &e.attributes {
            open.push(' ');
            open.push_str(&attr.name);
            let before = if attr.value_span.start > 0 {
                bytes[attr.value_span.start - 1]
            } else {
                0
            };
            let after = bytes.get(attr.value_span.end).copied().unwrap_or(0);
            if (before == b'"' || before == b'\'') && before == after {
                // 有引号值:值字节逐字保留(实体不重编码),引号照原形态
                open.push('=');
                open.push(before as char);
                open.push_str(slice_text(self.orig, attr.value_span));
                open.push(before as char);
            }
            // 无值属性 / 未加引号的值 / 值引号不闭合:解析侧各自带诊断 →
            // 整档安全退回(见 format_def_text),渲染面不出现这些形态。
        }

        // 行项子节点(元素/注释/CDATA/PI)存在 → 块模式;纯文本可一行化
        let has_line_children = e
            .children
            .iter()
            .any(|&c| !matches!(self.doc.nodes[c].data, NodeData::Text { .. }));
        let mut text_raw = String::new();
        for &c in &e.children {
            if let NodeData::Text { span, .. } = &self.doc.nodes[c].data {
                text_raw.push_str(slice_text(self.orig, *span));
            }
        }
        let text_trim = text_raw.trim();
        let has_pseudo = self.content_has_pseudo_line(e.content_span);

        // 空内容(自闭合 / 纯空白内容)统一规范化为自闭合
        if !has_line_children && !has_pseudo && text_trim.is_empty() {
            self.emit_line(depth, &format!("{open}/>"));
            return;
        }
        // 单行内容:一行化(不跨行、无伪注释行、无行项子节点)
        if !has_line_children && !has_pseudo && !text_trim.contains('\n') {
            self.emit_line(depth, &format!("{open}>{text_trim}</{}>", e.name));
            return;
        }
        // 块模式:开标签行 → 子节点行项 → 闭标签行
        self.emit_line(depth, &format!("{open}>"));
        for &c in &e.children {
            match &self.doc.nodes[c].data {
                NodeData::Element(_) => self.render_element(c, depth + 1),
                NodeData::Text { span, .. } => {
                    self.render_text(slice_text(self.orig, *span), depth + 1)
                }
                other => self.emit_verbatim(slice_text(self.orig, node_span(other)), depth + 1),
            }
        }
        self.emit_line(depth, &format!("</{}>", e.name));
    }

    /// 文本节点 → 行项序列:伪注释行(`#` 行首,可带前导空白)逐字保留;
    /// 内容行 trim(行内空白保留);空行压缩——节点首尾的换行是结构性分隔
    /// (不产空行),其间的连续空行压到一行。
    fn render_text(&mut self, raw: &str, depth: usize) {
        let mut blank_run = 0usize;
        let mut saw_item = false;
        for line in raw.split('\n') {
            if line.trim().is_empty() {
                blank_run += 1;
                continue;
            }
            let content = match pseudo_hash_col(line) {
                Some(col) => {
                    let body = &line[col..];
                    body.strip_suffix('\r').unwrap_or(body)
                }
                None => line.trim(),
            };
            // 首个空行 run 的首个换行是结构性的(紧跟上一行项),故 -1
            let blanks = if saw_item || blank_run == 0 {
                blank_run.min(1)
            } else {
                blank_run.saturating_sub(1).min(1)
            };
            if blanks > 0 {
                self.mark_blank();
            }
            blank_run = 0;
            saw_item = true;
            self.emit_line(depth, content);
        }
        // 尾部空行:最后一个换行归闭标签/下一行项,其余压一行
        if saw_item && blank_run >= 2 {
            self.mark_blank();
        }
        // 全空白节点(元素之间的缩进段):首个与末尾换行都是结构性的
        if !saw_item && blank_run >= 3 {
            self.mark_blank();
        }
    }

    /// `content_span` 内是否存在行首 `#` 行(掩码后它们变成空白,藏在文本
    /// 节点里;渲染必须照原文逐字保留,不能当空白丢)。
    fn content_has_pseudo_line(&self, span: Span) -> bool {
        let bytes = self.orig.as_bytes();
        let start = span.start.min(bytes.len());
        let end = span.end.min(bytes.len()).max(start);
        let mut line_start = start;
        while line_start < end {
            let mut i = line_start;
            while i < end && is_space(bytes[i]) {
                i += 1;
            }
            if i < end && bytes[i] == b'#' {
                return true;
            }
            while i < end && bytes[i] != b'\n' {
                i += 1;
            }
            line_start = i + 1;
        }
        false
    }
}

/// 按 span 切原文(越界 clamp,不 panic);掩码严格等长,故对原文件逐字节成立。
fn slice_text(orig: &str, span: Span) -> &str {
    let start = span.start.min(orig.len());
    let end = span.end.min(orig.len()).max(start);
    &orig[start..end]
}

fn node_span(data: &NodeData) -> Span {
    match data {
        NodeData::Text { span, .. }
        | NodeData::Comment { span }
        | NodeData::Cdata { span, .. }
        | NodeData::ProcessingInstruction { span }
        | NodeData::Declaration { span } => *span,
        _ => Span::new(0, 0),
    }
}

fn is_space(b: u8) -> bool {
    b == b' ' || b == b'\t' || b == b'\r'
}

/// 行首(前导空白之后)是 `#` → 伪注释行;返回 `#` 的字节位。
fn pseudo_hash_col(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() && is_space(bytes[i]) {
        i += 1;
    }
    (i < bytes.len() && bytes[i] == b'#').then_some(i)
}

/// 行级极小编辑集:公共前缀/后缀行夹出差异中段;中段行级 LCS(规模有界,
/// 超界整段一改——正确性不变,粒度变粗),走查把「删+插」连续段合成单条替换。
/// 文本侧按行起点字节切片,故区间与字节精确一致(末行无换行也不多补一个)。
fn line_edits(orig: &str, new: &str) -> Vec<DefFormatEdit> {
    // 行 = 含行尾换行的字节块(末行无换行则原样,空文本一行空串)——
    // 行列精确平铺文本,行尾「有无换行」的差异以「替换该行」如实表达。
    let a: Vec<&str> = orig.split_inclusive('\n').collect();
    let b: Vec<&str> = new.split_inclusive('\n').collect();
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf]
    {
        suf += 1;
    }
    let mid_a = &a[pre..a.len() - suf];
    let mid_b = &b[pre..b.len() - suf];
    if mid_a.is_empty() && mid_b.is_empty() {
        return Vec::new();
    }
    let a_starts = line_starts(&a, orig.len());
    let b_starts = line_starts(&b, new.len());
    let n = mid_a.len();
    let m = mid_b.len();
    if n.saturating_mul(m) > LCS_CELL_LIMIT {
        // 整段一改:原行区间 `[pre, pre+n)` 全换成新行(粒度变粗,结果不变)
        return match make_edit(
            &a_starts,
            orig,
            &b_starts,
            new,
            Some((pre, pre + n)),
            Some((pre, pre + m)),
        ) {
            Some(edit) => vec![edit],
            None => Vec::new(),
        };
    }
    let w = m + 1;
    let mut dp = vec![0u32; (n + 1) * (m + 1)];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i * w + j] = if mid_a[i] == mid_b[j] {
                dp[(i + 1) * w + j + 1] + 1
            } else {
                dp[i * w + j + 1].max(dp[(i + 1) * w + j])
            };
        }
    }
    let mut edits = Vec::new();
    let mut run_a: Option<(usize, usize)> = None;
    let mut run_b: Option<(usize, usize)> = None;
    let mut ai = 0usize;
    let mut bi = 0usize;
    while ai < n || bi < m {
        if ai < n && bi < m && mid_a[ai] == mid_b[bi] {
            if let Some(edit) =
                make_edit(&a_starts, orig, &b_starts, new, run_a.take(), run_b.take())
            {
                edits.push(edit);
            }
            ai += 1;
            bi += 1;
        } else {
            let go_del = ai < n && (bi >= m || dp[(ai + 1) * w + bi] >= dp[ai * w + bi + 1]);
            if go_del {
                let line = pre + ai;
                run_a = Some(extend(run_a.take(), line, line + 1));
                ai += 1;
            } else {
                let line = pre + bi;
                run_b = Some(extend(run_b.take(), line, line + 1));
                bi += 1;
            }
        }
    }
    if let Some(edit) = make_edit(&a_starts, orig, &b_starts, new, run_a.take(), run_b.take()) {
        edits.push(edit);
    }
    edits
}

/// LCS 表规模上限:中段两侧行数乘积超界即整段一改(不 O(n·m) 爆内存)。
const LCS_CELL_LIMIT: usize = 1_000_000;

/// 行起点表 + 末尾哨兵(`'\n'` 单字节,按行字节长累加;哨兵钉文本长,
/// 末行无换行时不越界)。
fn line_starts(lines: &[&str], total: usize) -> Vec<usize> {
    let mut starts = Vec::with_capacity(lines.len() + 1);
    let mut acc = 0usize;
    for line in lines {
        starts.push(acc);
        acc += line.len();
    }
    starts.push(total);
    starts
}

/// 连续段起点:首个行号起,后续行号并入(只延长终点)。
fn extend(run: Option<(usize, usize)>, start: usize, end: usize) -> (usize, usize) {
    match run {
        Some((head, _)) => (head, end),
        None => (start, end),
    }
}

/// 一条编辑:原行区间 `[a0, a1)` 换成新行 `[b0, b1)`(绝对行号)。删行连
/// 换行带走(取下一行起点);插行取零宽区间;新行文本按行起点字节切片。
fn make_edit(
    a_starts: &[usize],
    orig: &str,
    b_starts: &[usize],
    new: &str,
    run_a: Option<(usize, usize)>,
    run_b: Option<(usize, usize)>,
) -> Option<DefFormatEdit> {
    if run_a.is_none() && run_b.is_none() {
        return None;
    }
    let (a0, a1) = match run_a {
        Some(range) => range,
        None => {
            let line = run_b.unwrap().0;
            (line, line)
        }
    };
    let (b0, b1) = match run_b {
        Some(range) => range,
        None => (a0, a0),
    };
    let text = new[b_starts[b0.min(b_starts.len() - 1)].min(new.len())
        ..b_starts[b1.min(b_starts.len() - 1)].min(new.len())]
        .to_string();
    Some(DefFormatEdit {
        start: a_starts[a0.min(a_starts.len() - 1)].min(orig.len()),
        end: a_starts[a1.min(a_starts.len() - 1)].min(orig.len()),
        text,
    })
}
