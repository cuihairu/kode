//! VFS-004/005 行索引与坐标转换。
//!
//! - [`LineIndex`] 建一次、查多次:行起点字节偏移表 + 二分查找,
//!   hover/补全查询**不做全文 split、不复制文本**(VFS-005);
//!   文本以 `&str` 借用访问。
//! - LSP 坐标:`Position { line, character }`,character 按 **UTF-16 code unit**
//!   计数(LSP 规范)——emoji(代理对)占 2,ASCII 占 1(VFS-004)。
//! - 行终止符:`\n` 与 `\r\n`;行内容区间不含终止符(CRLF 文件的 `\r`
//!   不计入 character)。单独出现的 `\r` 按普通内容字符处理。
//! - 越界/落在代理对中间的坐标 **clamp 到最近合法边界**(对齐 rust-analyzer
//!   语义),绝不 panic、绝不切出半个字符。
//!
//! 坐标三方对拍(UTF-16 ↔ bytes ↔ line/col)见 `tests/coordinates.rs`:
//! 对 emoji/CRLF 样例逐坐标与朴素参考实现全量比对。

use std::sync::Arc;

/// LSP 位置:line 0 起,character 按 UTF-16 code unit 计数(VFS-004)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

impl Position {
    pub fn new(line: u32, character: u32) -> Position {
        Position { line, character }
    }
}

/// LSP 区间(半开:start 含,end 含在内容坐标系内)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

impl Range {
    pub fn new(start: Position, end: Position) -> Range {
        Range { start, end }
    }
}

/// 一次文本替换:无 range = 全文替换(LSP full sync),有 range = 增量。
#[derive(Debug, Clone)]
pub struct TextChange {
    pub range: Option<Range>,
    pub text: String,
}

impl TextChange {
    pub fn full(text: impl Into<String>) -> TextChange {
        TextChange {
            range: None,
            text: text.into(),
        }
    }

    pub fn ranged(range: Range, text: impl Into<String>) -> TextChange {
        TextChange {
            range: Some(range),
            text: text.into(),
        }
    }
}

/// 行起点索引:每行内容起始字节偏移,升序;`line_starts[0] == 0`。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineIndex {
    line_starts: Vec<u32>,
}

impl LineIndex {
    /// 扫一遍字节(不 split、不复制文本)建索引。
    pub fn new(text: &str) -> LineIndex {
        let mut line_starts = Vec::with_capacity(16);
        line_starts.push(0u32);
        for (i, byte) in text.bytes().enumerate() {
            if byte == b'\n' {
                line_starts.push(i as u32 + 1);
            }
        }
        LineIndex { line_starts }
    }

    pub fn line_count(&self) -> usize {
        self.line_starts.len()
    }

    /// 行内容字节区间 `[start, end)`:end 不含行终止符(`\n` 或 `\r\n` 的 `\r`)。
    pub fn line_range(&self, text: &str, line: u32) -> Option<(usize, usize)> {
        let line = line as usize;
        if line >= self.line_starts.len() {
            return None;
        }
        let start = self.line_starts[line] as usize;
        let end = if line + 1 < self.line_starts.len() {
            let next = self.line_starts[line + 1] as usize;
            // next 至少含 1 字节 '\n';若是 "\r\n" 再让掉 '\r'。
            if next >= 2 && text.as_bytes()[next - 2] == b'\r' {
                next - 2
            } else {
                next - 1
            }
        } else {
            text.len()
        };
        debug_assert!(start <= end);
        Some((start, end))
    }

    /// 行终止符字节长度:最后一行 0,`"\r\n"` 结尾 2,`"\n"` 结尾 1。
    pub fn line_terminator_len(&self, text: &str, line: u32) -> usize {
        let line = line as usize;
        if line + 1 >= self.line_starts.len() {
            return 0;
        }
        let next = self.line_starts[line + 1] as usize;
        if next >= 2 && text.as_bytes()[next - 2] == b'\r' {
            2
        } else {
            1
        }
    }

    /// VFS-004:Position → 字节偏移。越界行/列与代理对中点一律 clamp。
    pub fn byte_offset(&self, text: &str, pos: Position) -> usize {
        let line = (pos.line as usize).min(self.line_starts.len() - 1);
        let Some((start, end)) = self.line_range(text, line as u32) else {
            return text.len();
        };
        let mut utf16_seen = 0u32;
        let mut offset = start;
        for ch in text[start..end].chars() {
            if utf16_seen >= pos.character {
                break;
            }
            let units = ch.len_utf16() as u32;
            if utf16_seen + units > pos.character {
                break; // character 落在代理对中间:clamp 到该字符起点
            }
            utf16_seen += units;
            offset += ch.len_utf8();
        }
        offset
    }

    /// VFS-004:字节偏移 → Position。offset 向下取整到字符边界;
    /// 越界 clamp 到文末。
    pub fn position_of(&self, text: &str, offset: usize) -> Position {
        let mut offset = offset.min(text.len());
        while offset > 0 && !text.is_char_boundary(offset) {
            offset -= 1;
        }
        // 最后一行起点 <= offset。
        let line = self.line_starts.partition_point(|&s| s as usize <= offset) - 1;
        let line_start = self.line_starts[line] as usize;
        // 行内不越过行内容终点(行终止符属于下一行坐标之外)。
        let within = offset.min(
            self.line_range(text, line as u32)
                .map(|(_, e)| e)
                .unwrap_or(offset),
        );
        Position {
            line: line as u32,
            character: utf16_len(&text[line_start..within]),
        }
    }

    /// VFS-004:UTF-16 全文偏移 → 字节偏移(clamp)。
    pub fn utf16_offset_to_byte(&self, text: &str, utf16_offset: u32) -> usize {
        let mut remaining = utf16_offset;
        for line in 0..self.line_count() as u32 {
            let (start, end) = match self.line_range(text, line) {
                Some(range) => range,
                None => break,
            };
            let content_units = utf16_len(&text[start..end]);
            if remaining <= content_units {
                return self.byte_offset(
                    text,
                    Position {
                        line,
                        character: remaining,
                    },
                );
            }
            remaining -= content_units;
            let term = self.line_terminator_len(text, line) as u32;
            if remaining < term {
                // 偏移落在终止符内:clamp 到行内容末尾。
                return end;
            }
            remaining -= term;
        }
        text.len()
    }

    /// VFS-004:字节偏移 → UTF-16 全文偏移(clamp、floor 到字符边界)。
    pub fn byte_offset_to_utf16(&self, text: &str, byte_offset: usize) -> u32 {
        let pos = self.position_of(text, byte_offset);
        let line = pos.line as usize;
        let mut total = 0u32;
        for l in 0..line {
            let (start, end) = match self.line_range(text, l as u32) {
                Some(range) => range,
                None => break,
            };
            total += utf16_len(&text[start..end]);
            total += self.line_terminator_len(text, l as u32) as u32;
        }
        let line_start = self.line_starts.get(line).copied().unwrap_or(0) as usize;
        let clamped = byte_offset.min(text.len());
        let clamped = {
            let mut o = clamped;
            while o > line_start && !text.is_char_boundary(o) {
                o -= 1;
            }
            o
        };
        if clamped > line_start {
            total
                + utf16_len(
                    &text[line_start
                        ..clamped.min(
                            self.line_range(text, pos.line)
                                .map(|(_, e)| e)
                                .unwrap_or(clamped),
                        )],
                )
        } else {
            total
        }
    }
}

/// 字符串的 UTF-16 code unit 长度(emoji=2、BMP=1 的精确计数)。
pub fn utf16_len(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
}

/// 文档缓冲:`Arc<str>` 文本 + `Arc<LineIndex>` 索引。
/// 克隆 O(1);编辑产生新缓冲(copy-on-write,旧快照 immutable 保持有效——
/// VFS-011「解析缓存只持最新有效快照」由此保证读侧无撕裂)。
#[derive(Debug, Clone)]
pub struct DocumentBuffer {
    text: Arc<str>,
    index: Arc<LineIndex>,
}

impl DocumentBuffer {
    pub fn new(text: impl Into<Arc<str>>) -> DocumentBuffer {
        let text = text.into();
        let index = Arc::new(LineIndex::new(&text));
        DocumentBuffer { text, index }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn index(&self) -> &LineIndex {
        &self.index
    }

    /// 应用一次 change(full 或 ranged),产出新缓冲。
    /// 增量坐标经 VFS-004 精确转换;越界坐标 clamp(不 panic)。
    pub fn apply_change(&self, change: &TextChange) -> DocumentBuffer {
        match change.range {
            None => DocumentBuffer::new(Arc::from(change.text.as_str())),
            Some(range) => {
                let start = self.index.byte_offset(&self.text, range.start);
                let end = self.index.byte_offset(&self.text, range.end);
                let (start, end) = if start <= end {
                    (start, end)
                } else {
                    (end, start)
                };
                let mut text =
                    String::with_capacity(self.text.len() - (end - start) + change.text.len());
                text.push_str(&self.text[..start]);
                text.push_str(&change.text);
                text.push_str(&self.text[end..]);
                DocumentBuffer::new(Arc::from(text.as_str()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_index_basics_lf() {
        let text = "a\nbb\nccc";
        let index = LineIndex::new(text);
        assert_eq!(index.line_count(), 3);
        assert_eq!(index.line_range(text, 0), Some((0, 1)));
        assert_eq!(index.line_range(text, 1), Some((2, 4)));
        assert_eq!(index.line_range(text, 2), Some((5, 8)));
        assert_eq!(index.line_range(text, 3), None);
        assert_eq!(index.line_terminator_len(text, 2), 0);
    }

    #[test]
    fn line_index_crlf_content_excludes_cr() {
        let text = "a\r\nbb\r\n";
        let index = LineIndex::new(text);
        assert_eq!(index.line_count(), 3);
        // 行 0 内容 "a"(不含 \r\n),行 1 内容 "bb",行 2 空且是最后一行。
        assert_eq!(index.line_range(text, 0), Some((0, 1)));
        assert_eq!(index.line_range(text, 1), Some((3, 5)));
        assert_eq!(index.line_range(text, 2), Some((7, 7)));
        assert_eq!(index.line_terminator_len(text, 0), 2);
        assert_eq!(index.line_terminator_len(text, 1), 2);
        assert_eq!(index.line_terminator_len(text, 2), 0);
    }

    #[test]
    fn emoji_surrogate_pair_positions() {
        // "👍x":U+1F44D = 4 字节 / 2 UTF-16 unit。
        let text = "👍x";
        let index = LineIndex::new(text);
        assert_eq!(index.byte_offset(text, Position::new(0, 0)), 0);
        assert_eq!(index.byte_offset(text, Position::new(0, 1)), 0); // 代理对中点 clamp
        assert_eq!(index.byte_offset(text, Position::new(0, 2)), 4);
        assert_eq!(index.byte_offset(text, Position::new(0, 3)), 5);
        assert_eq!(index.position_of(text, 0), Position::new(0, 0));
        assert_eq!(index.position_of(text, 4), Position::new(0, 2));
        assert_eq!(index.position_of(text, 5), Position::new(0, 3));
    }

    #[test]
    fn buffer_ranged_edit_replaces_exactly() {
        let buffer = DocumentBuffer::new("hello\nworld");
        // 把第 1 行 "world" 换成 "W"。
        let change = TextChange::ranged(Range::new(Position::new(1, 0), Position::new(1, 5)), "W");
        let next = buffer.apply_change(&change);
        assert_eq!(next.text(), "hello\nW");
    }

    #[test]
    fn buffer_full_edit_and_cow_snapshot_semantics() {
        let buffer = DocumentBuffer::new("abc");
        let snapshot = buffer.clone();
        let next = buffer.apply_change(&TextChange::full("xyz"));
        assert_eq!(snapshot.text(), "abc"); // 旧快照不受影响
        assert_eq!(next.text(), "xyz");
    }

    #[test]
    fn utf16_offset_helpers_round_trip() {
        let text = "👍\r\nab👍c\n";
        let index = LineIndex::new(text);
        for utf16 in [0u32, 1, 2, 3, 4, 5, 6, 7, 8, 9] {
            let byte = index.utf16_offset_to_byte(text, utf16);
            let back = index.byte_offset_to_utf16(text, byte);
            // clamp 语义下,back 可能小于原值(落在终止符/代理对中点),
            // 但绝不大于;单调可复现。
            assert!(back <= utf16, "utf16 {utf16} → byte {byte} → {back}");
        }
    }
}
