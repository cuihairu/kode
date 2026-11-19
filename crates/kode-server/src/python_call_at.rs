//! RUST-140 批 1:SignatureHelp 调用点词法面(批159 TS
//! `getPythonCallAtPosition` 逐点同构,src/backend/pythonLanguageUtils.ts)。
//!
//! 单行词法:覆盖 `self.base/cell/client.X(...)` 与对象调用 `avatar.X(...)`
//! 两形态;光标须落在「'(' 及其实参表内」(方法名上不算);实参表字符串感知
//! 深度扫描定顶层逗号活动实参;闭合调用要求光标不越过闭括号(未闭合视为
//! 延伸到行尾);一行多调用取起点最靠后者。
//!
//! 批 1 只落纯库 + golden 对拍(TS tests/kodeDocumentSymbolsParity 同构:
//! vitest 直接 import 生产 `getPythonCallAtPosition` 复算同一 golden——生产面
//! ↔ Rust 面最强对拍,零复算漂移)。`resolveMethodDefinition` def 语义解析
//! 与 `textDocument/signatureHelp` LSP 接线留批 2(同 references/RUST-138
//! 边界口径:server.rs/rpc.rs 并发在途,生产服务面仍是 TS)。
//!
//! 实现注:全扫描在 UTF-16 单元数组上进行(`encode_utf16`),与 TS 字符串
//! 逐单元语义一致(正则 `\b`/字符类、`i += 1` 逃逸跳步、`i < character`
//! 比较全部同坐标系);匹配 token 全 ASCII,无跨系换算。

use std::collections::BTreeMap;

/// 一次调用解析面:接收者('self' 或对象变量名)/方法名/接收者段映射
/// (base→BaseMethods 等;对象调用 None)/光标所在实参序号(0 起)。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PythonCallAtFace {
    #[serde(rename = "receiverName")]
    pub receiver_name: String,
    #[serde(rename = "methodName")]
    pub method_name: String,
    pub section: Option<&'static str>,
    #[serde(rename = "activeArgument")]
    pub active_argument: u32,
}

/// TS `PYTHON_RECEIVER_SECTIONS` 同构。
fn receiver_section(token_second: &str) -> Option<&'static str> {
    match token_second {
        "base" => Some("BaseMethods"),
        "cell" => Some("CellMethods"),
        "client" => Some("ClientMethods"),
        _ => None,
    }
}

fn is_word(c: u16) -> bool {
    c == b'_' as u16
        || (c >= b'0' as u16 && c <= b'9' as u16)
        || (c >= b'a' as u16 && c <= b'z' as u16)
        || (c >= b'A' as u16 && c <= b'Z' as u16)
}

fn is_ident_start(c: u16) -> bool {
    c == b'_' as u16 || (c >= b'a' as u16 && c <= b'z' as u16) || (c >= b'A' as u16 && c <= b'Z' as u16)
}

fn is_ident_continue(c: u16) -> bool {
    is_ident_start(c) || (c >= b'0' as u16 && c <= b'9' as u16)
}

fn units_start_with(units: &[u16], pos: usize, word: &str) -> bool {
    let bytes = word.as_bytes();
    pos + bytes.len() <= units.len()
        && bytes
            .iter()
            .enumerate()
            .all(|(k, &b)| units[pos + k] == b as u16)
}

fn read_ident(units: &[u16], pos: usize) -> Option<(String, usize)> {
    if pos >= units.len() || !is_ident_start(units[pos]) {
        return None;
    }
    let mut end = pos + 1;
    while end < units.len() && is_ident_continue(units[end]) {
        end += 1;
    }
    Some((String::from_utf16_lossy(&units[pos..end]), end))
}

/// 一次匹配尝试:返回 (receiver_token, method_name, match_end)。
/// 分支序 = TS 正则 alternation:先 `self.base/cell/client` 字面,再
/// `[A-Za-z_]\w*` 通用 ident(如 `self.foo(` 走通用臂,receiverToken 无点
/// → 非段接收者)。
fn try_match_at(units: &[u16], pos: usize) -> Option<(String, String, usize)> {
    // \b:起点须为词边界(TS \b 同义:前邻非 \w)。
    if pos > 0 && is_word(units[pos - 1]) {
        return None;
    }
    let mut cursor = pos;
    let receiver_token: String;
    let method: String;
    if units_start_with(units, cursor, "self.")
        && (units_start_with(units, cursor + 5, "base.")
            || units_start_with(units, cursor + 5, "cell.")
            || units_start_with(units, cursor + 5, "client."))
    {
        // 分支 1:字面接收者 self.base / self.cell / self.client(含 '.' 已
        // 消费,cursor 直接落方法名)。
        let after = units[cursor + 5..].iter().position(|&c| c == b'.' as u16)?;
        let second = String::from_utf16_lossy(&units[cursor + 5..cursor + 5 + after]);
        cursor += 5 + after + 1;
        receiver_token = format!("self.{second}");
        let (ident, end) = read_ident(units, cursor)?;
        method = ident;
        cursor = end;
    } else {
        // 分支 2:通用 ident + `\.` + method(TS alternation 第二臂;如
        // `self.foo(` 走此臂,receiverToken 无点 → 非段接收者)。
        let (ident, end) = read_ident(units, cursor)?;
        cursor = end;
        receiver_token = ident;
        if cursor >= units.len() || units[cursor] != b'.' as u16 {
            return None;
        }
        cursor += 1;
        let (ident, end) = read_ident(units, cursor)?;
        method = ident;
        cursor = end;
    }
    // `[ \t]*` + `(`(两臂共享尾)
    while cursor < units.len() && (units[cursor] == b' ' as u16 || units[cursor] == b'\t' as u16) {
        cursor += 1;
    }
    if cursor >= units.len() || units[cursor] != b'(' as u16 {
        return None;
    }
    Some((receiver_token, method, cursor + 1))
}

/// TS `getPythonCallAtPosition` 同构主体(单行,UTF-16 单元域)。
/// character 为 UTF-16 列(与 TS position.character 同坐标系)。
pub fn get_python_call_at_position(line: &str, character: usize) -> Option<PythonCallAtFace> {
    let units: Vec<u16> = line.encode_utf16().collect();
    let mut candidates: Vec<PythonCallAtFace> = Vec::new();
    let mut i = 0usize;
    // 非重叠扫描(exec 循环同构:命中后从匹配尾续扫)。
    while i < units.len() {
        let Some((receiver_token, method_name, match_end)) = try_match_at(&units, i) else {
            i += 1;
            continue;
        };
        let call_open = match_end - 1; // '(' 单元位
        if character < call_open {
            i = match_end;
            continue;
        }
        // 实参表字符串感知深度扫描:顶层逗号定活动实参,顺带找闭合。
        let mut depth = 0i32;
        let mut in_string: Option<u16> = None;
        let mut active_argument = 0u32;
        let mut closed = false;
        let mut close_index = 0usize;
        let mut j = call_open;
        while j < units.len() {
            let ch = units[j];
            if let Some(q) = in_string {
                if ch == b'\\' as u16 {
                    j += 1; // 逃逸跳一单元(TS i += 1 同形)
                } else if ch == q {
                    in_string = None;
                }
            } else if ch == b'\'' as u16 || ch == b'"' as u16 {
                in_string = Some(ch);
            } else if ch == b'(' as u16 || ch == b'[' as u16 || ch == b'{' as u16 {
                depth += 1;
            } else if ch == b')' as u16 || ch == b']' as u16 || ch == b'}' as u16 {
                depth -= 1;
                if depth == 0 {
                    closed = true;
                    close_index = j;
                    break;
                }
            } else if ch == b',' as u16 && depth == 1 && j < character {
                active_argument += 1;
            }
            j += 1;
        }
        // 归属判定:闭合调用要求光标不越过闭括号;未闭合视为延伸到行尾。
        if !(closed && close_index < character) {
            let is_receiver = receiver_token.starts_with("self.");
            let section = if is_receiver {
                receiver_section(receiver_token.split('.').nth(1).unwrap_or(""))
            } else {
                None
            };
            candidates.push(PythonCallAtFace {
                receiver_name: if is_receiver {
                    "self".to_string()
                } else {
                    receiver_token.clone()
                },
                method_name,
                section,
                active_argument,
            });
        }
        i = match_end;
    }
    // 嵌套/相邻取起点最靠后者(匹配序即 callOpen 升序)。
    candidates.pop()
}

// ---------------------------------------------------------------------------
// golden(vitest 直接 import 生产 getPythonCallAtPosition 复算对拍)
// ---------------------------------------------------------------------------

pub const PYTHON_CALL_AT_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/python-call-at-parity.json";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenHit {
    line: usize,
    character: usize,
    #[serde(flatten)]
    call: PythonCallAtFace,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFile {
    file: String,
    probe_count: usize,
    hits: Vec<GoldenHit>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    file_count: usize,
    probe_count: usize,
    hit_count: usize,
    files: Vec<GoldenFile>,
}

/// .py 语料收集(PARITY_CORPORA 同根;collect_corpus 只收 def/xml,本面
/// 自收 .py,BTreeMap 字典序确定性)。
fn collect_python_corpus(repo_root: &std::path::Path) -> BTreeMap<String, String> {
    fn walk(dir: &std::path::Path, rel_prefix: &str, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<std::path::PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        entries.sort();
        for path in entries {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let rel = format!("{rel_prefix}/{name}");
            if path.is_dir() {
                walk(&path, &rel, out);
                continue;
            }
            if name.ends_with(".py") {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    out.insert(rel, text);
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    for corpus in kode_parser::json::PARITY_CORPORA {
        walk(&repo_root.join(corpus), corpus, &mut out);
    }
    out
}

/// 遍历 .py 语料,逐行逐位置探测(0..=行长全位置),非空命中入 golden。
/// 空结果文件也入列(probeCount 对账;vitest 同全集探测,空 ↔ 空平凡相等
/// 但全集覆盖防漏探)。
pub fn dump_python_call_at_golden(repo_root: &std::path::Path) -> String {
    let corpus = collect_python_corpus(repo_root);
    let mut dump = GoldenDump {
        generator: "kode-server dump-python-call-at-golden",
        file_count: corpus.len(),
        probe_count: 0,
        hit_count: 0,
        files: Vec::new(),
    };
    for (path, text) in &corpus {
        let mut golden_file = GoldenFile {
            file: path.clone(),
            probe_count: 0,
            hits: Vec::new(),
        };
        // 行切分 = '\n',行内容剥尾部 '\r'(VS Code lineAt 同语义)。
        for (idx, raw_line) in text.split('\n').enumerate() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            let units: Vec<u16> = line.encode_utf16().collect();
            // 行内无接收者调用形态则整行零命中(全位置平凡 null,不逐位
            // 存 golden;probeCount 仍计——TS 侧同全集探测对账)。
            let mut any_call = false;
            {
                let mut i = 0usize;
                while i < units.len() {
                    if try_match_at(&units, i).is_some() {
                        any_call = true;
                        break;
                    }
                    i += 1;
                }
            }
            if !any_call {
                golden_file.probe_count += units.len() + 1;
                continue;
            }
            for character in 0..=units.len() {
                golden_file.probe_count += 1;
                if let Some(call) = get_python_call_at_position(line, character) {
                    dump.hit_count += 1;
                    golden_file.hits.push(GoldenHit {
                        line: idx + 1,
                        character,
                        call,
                    });
                }
            }
        }
        dump.probe_count += golden_file.probe_count;
        dump.files.push(golden_file);
    }
    serde_json::to_string_pretty(&dump).expect("serialize")
}

// ---------------------------------------------------------------------------
// 单元钉
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn call_at(line: &str, character: usize) -> Option<PythonCallAtFace> {
        get_python_call_at_position(line, character)
    }

    #[test]
    fn section_receiver_faces() {
        // self.base/cell/client 三段映射;方法名上(character < callOpen)不认。
        let line = "self.base.doSpell(1, 2)";
        let open = line.find('(').unwrap();
        assert!(call_at(line, open - 1).is_none(), "方法名上不触发");
        let hit = call_at(line, open).expect("'(' 上触发");
        assert_eq!(hit.receiver_name, "self");
        assert_eq!(hit.method_name, "doSpell");
        assert_eq!(hit.section, Some("BaseMethods"));
        assert_eq!(hit.active_argument, 0);
        let hit2 = call_at(line, open + 2).expect("首实参中段");
        assert_eq!(hit2.active_argument, 0);
        let hit3 = call_at(line, open + 5).expect("第二实参");
        assert_eq!(hit3.active_argument, 1);
        // 逗号判定 = i < character:character=逗号位时未过(0),+1 即过(1)。
        let comma = line.find(',').unwrap();
        assert_eq!(call_at(line, comma).unwrap().active_argument, 0);
        assert_eq!(call_at(line, comma + 1).unwrap().active_argument, 1);
    }

    #[test]
    fn cell_and_client_sections_and_object_receiver() {
        let cell = call_at("self.cell.onEnterCell(", "self.cell.onEnterCell(".len()).unwrap();
        assert_eq!(cell.section, Some("CellMethods"));
        let client = call_at("self.client.onLevelUp(", "self.client.onLevelUp(".len()).unwrap();
        assert_eq!(client.section, Some("ClientMethods"));
        // 对象调用:receiverName=变量名,section=None。
        let obj = call_at("avatar.learnSkill(1)", "avatar.learnSkill(".len()).unwrap();
        assert_eq!(obj.receiver_name, "avatar");
        assert_eq!(obj.method_name, "learnSkill");
        assert_eq!(obj.section, None);
        // self.非段(self.foo( ):走通用 ident 臂,receiverName=self 但无段。
        let plain = call_at("self.foo(", "self.foo(".len()).unwrap();
        assert_eq!(plain.receiver_name, "self");
        assert_eq!(plain.method_name, "foo");
        assert_eq!(plain.section, None);
    }

    #[test]
    fn string_aware_commas_and_escape() {
        // 字符串内逗号/括号不参与深度;逃逸引号不闭合字符串。
        // 行 = self.base.say("a,b(c", 2):字符串内 ,17 不算,顶层 ,21 才算。
        let line = r#"self.base.say("a,b(c", 2)"#;
        let top_comma = line.rfind(',').unwrap();
        assert_eq!(call_at(line, top_comma).unwrap().active_argument, 0);
        assert_eq!(call_at(line, top_comma + 1).unwrap().active_argument, 1);
        let escaped = r#"self.base.say("it\'s, x", 3)"#;
        let comma2 = escaped.rfind(',').unwrap();
        assert_eq!(call_at(escaped, comma2 + 2).unwrap().active_argument, 1);
    }

    #[test]
    fn nested_brackets_depth() {
        // 嵌套括号内逗号不算顶层;闭括号回落顶层后逗号计数。
        let line = "self.base.go(a(1,2), 3)";
        let outer_comma = line.rfind(", 3").unwrap();
        assert_eq!(call_at(line, outer_comma + 2).unwrap().active_argument, 1);
        let inner_comma = line.find("1,2").unwrap() + 1;
        assert_eq!(call_at(line, inner_comma).unwrap().active_argument, 0);
    }

    #[test]
    fn unclosed_extends_and_closed_rejects_after_close() {
        // 未闭合(边打边求助)视为延伸到行尾:行尾仍命中。
        let unclosed = call_at("self.base.x(1, 2", 16).unwrap();
        assert_eq!(unclosed.active_argument, 1);
        // 已闭合调用,光标越过闭括号 → 不认。
        let line = "self.base.x(1) ; rest";
        assert!(call_at(line, line.len()).is_none());
        assert!(call_at(line, line.find(')').unwrap()).is_some());
    }

    #[test]
    fn two_calls_pick_latest_start() {
        // 一行两调用:光标在第二调用实参内取第二调用(起点最靠后)。
        let line = "self.base.a(1) self.cell.b(2, 3)";
        let second_open = line.rfind('(').unwrap();
        let hit = call_at(line, second_open + 3).unwrap();
        assert_eq!(hit.method_name, "b");
        assert_eq!(hit.section, Some("CellMethods"));
        assert_eq!(hit.active_argument, 1);
    }

    #[test]
    fn property_read_and_plain_calls_rejected() {
        // 属性读取(名字后非 '(')不认;裸函数调用 f( )无接收者点分不认。
        assert!(call_at("self.base.x", 11).is_none());
        assert!(call_at("doSpell(1)", 8).is_none());
    }

    #[test]
    fn nested_calls_innermost_wins() {
        // 嵌套双活:外层 self.base.a( ... 内层 self.cell.b( ...),光标在内
        // 层实参内两候选都活着(内层闭括号未过、外层闭括号未过)→ 取起点
        // 最靠后者 = 内层(最紧包含,TS 同义)。
        let line = "self.base.a(self.cell.b(1), 3)";
        let probe = line.find("b(").unwrap() + 2;
        let hit = call_at(line, probe).expect("嵌套实参内命中");
        assert_eq!(hit.method_name, "b");
        assert_eq!(hit.section, Some("CellMethods"));
        assert_eq!(hit.active_argument, 0);
    }

    #[test]
    fn word_boundary_no_midword_match() {
        // \b:xself.y( 的 0 位 ident 整吞 "xself"(receiverName=xself);
        // 1 位 "self.y(" 前邻 'x' 词字符 → \b 拒 → 不产生第二候选。若去
        // \b,1 位多出 candidate 且 callOpen 平局后扫者胜 → winner 变
        // "self",本钉即红(\b 的可观察面 = 词中候选参与 tie-break)。
        // \b 可观察面:myself.cell.y( 的 0 位分支尝试("myself" ident →
        // '.cell.' 尾非 '(' 失败)后,扫描进到 1 位 "self.cell.y("——前邻
        // 'm' 词字符 → \b 拒;最终 6 位 "cell.y(" 词边界合法命中 →
        // receiver=cell。若去 \b,1 位字面臂假命中且 callOpen 平局后扫者
        // 胜 → winner 变 self,本钉即红。
        let line = "myself.cell.y(1)";
        let hit = call_at(line, line.find("y(").unwrap() + 2).expect("实参区内命中");
        assert_eq!(hit.receiver_name, "cell");
        assert_eq!(hit.method_name, "y");
        assert_eq!(hit.section, None);
        // 词边界外正常命中锚(x.self.y( 的 self 前邻是点,字面臂不认 client
        // 外段名走通用臂,receiverName=self 无段)。
        let ok = "x.self.y(";
        let hit2 = call_at(ok, ok.len() - 1).expect("点后词边界合法命中");
        assert_eq!(hit2.receiver_name, "self");
        assert_eq!(hit2.method_name, "y");
        assert_eq!(hit2.section, None);
    }
}
