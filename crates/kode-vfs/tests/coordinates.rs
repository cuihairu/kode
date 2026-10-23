//! VFS-004 坐标转换对拍:LineIndex(索引法) vs 朴素参考实现(split 法),
//! 对 emoji / CRLF / 混合样例做**全坐标扫描**比对(每个合法 Position、
//! 每个字符边界 byte offset 双向互查),另附书要求的样例断言。

use kode_vfs::{utf16_len, DocumentBuffer, LineIndex, Position, Range, TextChange};

/// 朴素参考实现:split('\n') 分行、strip 尾 '\r',
/// 与 LineIndex(字节扫描 + 二分)零共享代码。
struct Naive {
    /// (行内容, 行内容起始字节偏移)
    lines: Vec<(String, usize)>,
}

impl Naive {
    fn new(text: &str) -> Naive {
        let mut lines = Vec::new();
        let mut offset = 0usize;
        for raw in text.split('\n') {
            let content_len = raw.strip_suffix('\r').map(|c| c.len()).unwrap_or(raw.len());
            lines.push((raw[..content_len].to_string(), offset));
            offset += raw.len() + 1;
        }
        Naive { lines }
    }

    fn line_count(&self) -> usize {
        self.lines.len()
    }

    /// Position → byte(越界 clamp 语义与 LineIndex 对齐:行列取到最近合法值)。
    fn byte_offset(&self, pos: Position) -> usize {
        let line = (pos.line as usize).min(self.line_count() - 1);
        let (content, start) = &self.lines[line];
        let mut units = 0u32;
        let mut offset = *start;
        for ch in content.chars() {
            if units >= pos.character {
                break;
            }
            let u = ch.len_utf16() as u32;
            if units + u > pos.character {
                break;
            }
            units += u;
            offset += ch.len_utf8();
        }
        offset
    }

    /// byte → Position(byte 先 floor 到字符边界,再找行)。
    fn position_of(&self, text: &str, byte: usize) -> Position {
        let mut byte = byte.min(text.len());
        while byte > 0 && !text.is_char_boundary(byte) {
            byte -= 1;
        }
        let mut line = 0usize;
        for (i, (_, start)) in self.lines.iter().enumerate() {
            if *start <= byte {
                line = i;
            } else {
                break;
            }
        }
        let (content, start) = &self.lines[line];
        // 行内 byte 不得越过行内容终点。
        let within = byte.saturating_sub(*start).min(content.len());
        let mut units = 0u32;
        for ch in content[..within].chars() {
            units += ch.len_utf16() as u32;
        }
        Position::new(line as u32, units)
    }
}

/// 全坐标对拍:每个 (line, character 0..=行 utf16 长度) 的 byte 转换一致;
/// 每个字符边界 byte 的 position 转换一致;且 position→byte→position 幂等。
fn cross_check(text: &str) {
    let index = LineIndex::new(text);
    let naive = Naive::new(text);
    assert_eq!(
        index.line_count(),
        naive.line_count(),
        "line count: {text:?}"
    );

    for line in 0..index.line_count() {
        let content_len = match index.line_range(text, line as u32) {
            Some((s, e)) => utf16_len(&text[s..e]),
            None => break,
        };
        for character in 0..=content_len {
            let pos = Position::new(line as u32, character);
            assert_eq!(
                index.byte_offset(text, pos),
                naive.byte_offset(pos),
                "byte_offset mismatch at {pos:?} for {text:?}"
            );
        }
    }
    for byte in 0..=text.len() {
        if byte < text.len() && !text.is_char_boundary(byte) {
            continue;
        }
        let expected = naive.position_of(text, byte);
        let actual = index.position_of(text, byte);
        assert_eq!(
            actual, expected,
            "position_of mismatch at byte {byte} for {text:?}"
        );
        // 回映:内容边界处必须精确回到原 byte;唯一例外是 "\r\n" 的 '\n'
        // ——终止符中点在 LSP 坐标空间不可寻址,回映必须落在 '\r'(内容末尾)。
        let back = index.byte_offset(text, actual);
        let mid_crlf = byte > 0
            && text.as_bytes().get(byte) == Some(&b'\n')
            && text.as_bytes()[byte - 1] == b'\r';
        if mid_crlf {
            assert_eq!(
                back,
                byte - 1,
                "roundtrip at CRLF-\\n byte {byte} for {text:?}"
            );
        } else {
            assert_eq!(back, byte, "roundtrip at byte {byte} for {text:?}");
        }
    }
}

#[test]
fn cross_check_ascii_lf() {
    cross_check("");
    cross_check("a\nbb\nccc");
    cross_check("no terminator");
    cross_check("\n\n\n");
}

#[test]
fn cross_check_crlf() {
    cross_check("a\r\nbb\r\n");
    cross_check("\r\n\r\n");
    cross_check("line1\r\nline2\r\nline3");
    // 孤立 \r(老 Mac 风格)按内容字符处理,两侧语义一致。
    cross_check("a\rb\n");
}

#[test]
fn cross_check_emoji_and_astral() {
    // U+1F44D thumbsup、U+1F1E6 regional indicator、U+1F600——全部 4 字节/2 unit。
    cross_check("👍\r\nab👍c\n");
    cross_check("🇦🇧flag\nx");
    cross_check("前置👍中置🎯后置");
    cross_check("👍👍👍");
}

#[test]
fn cross_check_mixed_everything() {
    cross_check("a👍\r\n\rb🇦🇧\n\n末端🎯\r\n");
    cross_check("Monster🔥.def\rdesc\r\n<GroupName>mob🎯</GroupName>");
}

/// 书要求的样例断言:emoji 与 CRLF 的具体坐标值(文档化对拍结论,
/// 同表输出到 docs/kode2/pr-004.md)。
#[test]
fn documented_samples() {
    let text = "👍x\r\nab🎯c";
    let index = LineIndex::new(text);
    // 行 0 内容 = "👍x"(UTF-16 长 3;👍 占 2 unit / 4 字节,但不拆分)。
    assert_eq!(index.byte_offset(text, Position::new(0, 0)), 0);
    assert_eq!(
        index.byte_offset(text, Position::new(0, 1)),
        0,
        "代理对中点 clamp"
    );
    assert_eq!(index.byte_offset(text, Position::new(0, 2)), 4);
    assert_eq!(index.byte_offset(text, Position::new(0, 3)), 5);
    // CRLF 的 \r 不计入 character:行 1 内容 "ab🎯c" 从字节 7 起,长 7 字节。
    assert_eq!(index.line_range(text, 1), Some((7, 14)));
    assert_eq!(index.byte_offset(text, Position::new(1, 2)), 9);
    assert_eq!(
        index.byte_offset(text, Position::new(1, 3)),
        9,
        "🎯 中点 clamp"
    );
    assert_eq!(index.byte_offset(text, Position::new(1, 4)), 13);
    assert_eq!(index.position_of(text, 9), Position::new(1, 2));
    // bytes ↔ UTF-16 全文偏移:行 1 首 = UTF-16 5(行0内容3 + 终止符2)。
    assert_eq!(index.byte_offset_to_utf16(text, 7), 5);
    assert_eq!(index.utf16_offset_to_byte(text, 5), 7);
}

/// VFS-004 增量编辑:含 emoji 的 ranged 编辑不切字符、位置精确。
#[test]
fn ranged_edits_on_emoji_and_crlf_text() {
    let buffer = DocumentBuffer::new("👍\r\nab🎯c");
    // 删除 "ab🎯" 中 "🎯"(byte 9..13;坐标 1,2..1,4)。
    let next = buffer.apply_change(&TextChange::ranged(
        Range::new(Position::new(1, 2), Position::new(1, 4)),
        "",
    ));
    assert_eq!(next.text(), "👍\r\nabc");
    // 在 👍 前插入 ASCII(坐标 0,0)。
    let next2 = next.apply_change(&TextChange::ranged(
        Range::new(Position::new(0, 0), Position::new(0, 0)),
        "x",
    ));
    assert_eq!(next2.text(), "x👍\r\nabc");
    cross_check(next2.text());
}
