//! python 方法调用层次解析决策核(RUST-145 批 1):与
//! src/backend/pythonMethodCallQueries.ts 同构——方法块解析(索引首扫/
//! 未保存文档覆盖共用)+ outgoing 绑定解析(精确文件+名→同名回退→dedup)
//! 与 incoming 全量扫描(进程作用域过滤/打开文档覆盖/未入索引打开文件跳过)。
//! 纯库零 RPC;golden 语料化对拍(tests/python_method_calls_golden.rs 重生成
//! 比对,TS 侧 tests/kodePythonMethodCallsParity.test.ts 驱动生产函数复算)。
//!
//! 保真口径(与 TS 正则逐路径同构):
//! - JS `\s` 全集(含 \u00a0/\u2000-\u200a/\u3000/\ufeff 等)——缩进计数与
//!   空白行判定都用它,`\u3000` 全角空格行按 JS trim 语义算空白行;
//! - def 行正则 `^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(`:async 路先试
//!   (贪婪可选组),整体失败回退裸 def 路(JS 回溯语义);
//! - 方法名列 = JS `indexOf(name)` 全行首现(非正则命中位)——`def de(self)`
//!   的 indexOf("de") 命中 "def" 前缀内部列 0,双端同构诚实保真;
//! - self 调用正则 `\bself\.([A-Za-z_]\w*)\s*\(`:词边界(前一字符非
//!   [A-Za-z0-9_])、ident 贪婪、`\s*(`;ident 后非 `(` 整体失败前移一位;
//!   字符串/注释无感知(正则盲区,双端一致);
//! - 列域 UTF-16(LSP 面):CJK 前缀按 code unit 计数。
use crate::def_param_hints::{infer_method_section_from_python_file, normalize_file_identity};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// JS `\s`(regex)全集;亦是 JS String.trim 的空白集(不含额外字符)。
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t'
            | '\n'
            | '\u{000b}'
            | '\u{000c}'
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

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_cont(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// JS trim 空判定:全部字符是 JS 空白(含空串)。
fn js_trim_empty(line: &str) -> bool {
    line.chars().all(is_js_space)
}

/// 行首 `\s*` 宽度(JS match[0].length 语义,UTF-16 单元)。
fn leading_js_space_units(chars: &[char]) -> usize {
    let mut units = 0;
    for c in chars {
        if !is_js_space(*c) {
            break;
        }
        units += c.len_utf16();
    }
    units
}

/// 字节偏移 → UTF-16 列(LSP 面)。
fn utf16_col(text: &str, byte_idx: usize) -> usize {
    text[..byte_idx].chars().map(|c| c.len_utf16()).sum()
}

/// self 调用点(解析产物,TS IndexedPythonMethodLocation['calls'] 同形)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonSelfCall {
    pub method_name: String,
    pub line: u32,
    pub character: u32,
    pub file_path: String,
}

/// 索引方法块(方法名/1 基行/名列/缩进边界 endLine/自调用点集)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedPythonMethodLocation {
    pub file_path: String,
    pub method_name: String,
    pub line: u32,
    pub character: u32,
    pub end_line: u32,
    pub calls: Vec<PythonSelfCall>,
}

/// outgoing 引用(resolved 绑定四元组,保留原始路径非归一形)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonMethodCallReference {
    pub file_path: String,
    pub method_name: String,
    pub line: u32,
    pub character: u32,
}

/// incoming 调用方窄面(不带 endLine/calls)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingCaller {
    pub file_path: String,
    pub method_name: String,
    pub line: u32,
    pub character: u32,
}

/// incoming 命中(调用方+调用点行列)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingPythonMethodCall {
    pub caller: IncomingCaller,
    pub call_line: u32,
    pub call_character: u32,
}

/// 打开文档快照(manager 面 collectOpenDocumentTexts 的语料化形态)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocumentText {
    pub fs_path: String,
    pub content: String,
}

/// def 行匹配(手写扫描器,正则 `^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(`)。
/// 返回 (indent UTF-16 宽, 名字节起点[character 回退位], 名)。
/// 名列不在此定:TS 面 = `indexOf(name)` 全行首现(可能落在 "def" 前缀内部),
/// 由 parse 层统一计算。
fn match_def_line(line: &str) -> Option<(usize, usize, String)> {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() && is_js_space(chars[i]) {
        i += 1;
    }
    let indent = leading_js_space_units(&chars[..i]);

    let try_match = |p: usize| -> Option<(usize, String)> {
        // def
        if p + 3 > chars.len() || chars[p] != 'd' || chars[p + 1] != 'e' || chars[p + 2] != 'f' {
            return None;
        }
        // \s+(至少一个)
        let mut q = p + 3;
        let mut any = false;
        while q < chars.len() && is_js_space(chars[q]) {
            q += 1;
            any = true;
        }
        if !any || q >= chars.len() || !is_ident_start(chars[q]) {
            return None;
        }
        // ident 贪婪(无回溯:\s*( 不吃 ident 字符,缩短必失败)
        let start = q;
        q += 1;
        while q < chars.len() && is_ident_cont(chars[q]) {
            q += 1;
        }
        // \s*(
        let mut r = q;
        while r < chars.len() && is_js_space(chars[r]) {
            r += 1;
        }
        if r < chars.len() && chars[r] == '(' {
            Some((start, chars[start..q].iter().collect()))
        } else {
            None
        }
    };

    // JS 贪婪可选组:async 路先试,失败回退裸 def 路。
    if chars[i..].starts_with(&['a', 's', 'y', 'n', 'c'])
        && i + 5 < chars.len()
        && is_js_space(chars[i + 5])
    {
        let mut p = i + 5;
        while p < chars.len() && is_js_space(chars[p]) {
            p += 1;
        }
        if let Some((name_start, name)) = try_match(p) {
            let byte_start: usize = chars[..name_start].iter().map(|c| c.len_utf8()).sum();
            return Some((indent, byte_start, name));
        }
    }
    let (name_start, name) = try_match(i)?;
    let byte_start: usize = chars[..name_start].iter().map(|c| c.len_utf8()).sum();
    Some((indent, byte_start, name))
}

/// self 调用扫描(手写,正则 `\bself\.([A-Za-z_]\w*)\s*\(` 逐路径同构)。
/// startLine 为 bodyLines[0] 的 1 基行号(TS 面 index+2)。
fn parse_python_self_calls(body_lines: &[&str], start_line: u32, python_file: &str) -> Vec<PythonSelfCall> {
    let mut calls = Vec::new();
    for (offset, line) in body_lines.iter().enumerate() {
        let chars: Vec<char> = line.chars().collect();
        // (byte_idx, char_idx) 同步推进
        let mut i = 0;
        while i < chars.len() {
            let word_boundary = i == 0 || !is_ident_cont(chars[i - 1]);
            let is_self_dot = chars[i] == 's'
                && i + 5 <= chars.len()
                && chars[i + 1] == 'e'
                && chars[i + 2] == 'l'
                && chars[i + 3] == 'f'
                && chars[i + 4] == '.';
            if !word_boundary || !is_self_dot {
                i += 1;
                continue;
            }
            let name_start = i + 5;
            if name_start >= chars.len() || !is_ident_start(chars[name_start]) {
                i += 1;
                continue;
            }
            let mut q = name_start + 1;
            while q < chars.len() && is_ident_cont(chars[q]) {
                q += 1;
            }
            let mut r = q;
            while r < chars.len() && is_js_space(chars[r]) {
                r += 1;
            }
            if r < chars.len() && chars[r] == '(' {
                let name: String = chars[name_start..q].iter().collect();
                let byte_idx: usize = chars[..i].iter().map(|c| c.len_utf8()).sum();
                calls.push(PythonSelfCall {
                    method_name: name,
                    line: start_line + offset as u32,
                    character: (utf16_col(line, byte_idx) + "self.".len()) as u32,
                    file_path: python_file.to_string(),
                });
                // JS lastIndex = 匹配尾(右括号后一位)
                i = r + 1;
            } else {
                i += 1;
            }
        }
    }
    calls
}

/// 方法块解析(TS parsePythonMethodBlocks 同构;索引首扫/未保存文档覆盖共用)。
pub fn parse_python_method_blocks(content: &str, python_file: &str) -> Vec<IndexedPythonMethodLocation> {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut methods = Vec::new();

    for (index, line) in lines.iter().enumerate() {
        let Some((indent, name_byte_start, method_name)) = match_def_line(line) else {
            continue;
        };
        // TS 面 character = `lineText.indexOf(name)` 全行首现——可落在 "def"
        // 前缀内部(def de( → "de" 命中 "def"),非正则命中位。
        let character = match line.find(&method_name) {
            Some(byte_idx) => utf16_col(line, byte_idx),
            None => utf16_col(line, name_byte_start), // 不可达:名从本行摘出
        };
        let mut end_line = lines.len();
        for (next, next_text) in lines.iter().enumerate().skip(index + 1) {
            if js_trim_empty(next_text) {
                continue;
            }
            let next_chars: Vec<char> = next_text.chars().collect();
            let next_indent = leading_js_space_units(&next_chars);
            if next_indent <= indent {
                end_line = next;
                break;
            }
        }
        let body_lines: Vec<&str> = lines[index + 1..end_line].to_vec();
        methods.push(IndexedPythonMethodLocation {
            file_path: python_file.to_string(),
            method_name,
            line: (index + 1) as u32,
            character: character as u32,
            end_line: end_line as u32,
            calls: parse_python_self_calls(&body_lines, (index + 2) as u32, python_file),
        });
    }
    methods
}

/// outgoing 解析:目标定位(路径身份归一)→ 逐调用点绑定(精确文件+名,
/// 同名任意文件回退)→ dedup(归一路径:名:行:列)。
pub fn resolve_outgoing_python_method_calls(
    methods: &[IndexedPythonMethodLocation],
    python_file: &str,
    method_name: &str,
) -> Vec<PythonMethodCallReference> {
    let Some(target) = methods.iter().find(|m| {
        normalize_file_identity(&m.file_path) == normalize_file_identity(python_file)
            && m.method_name == method_name
    }) else {
        return Vec::new();
    };

    let mut references = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for reference in &target.calls {
        let binding = methods.iter().find(|candidate| {
            normalize_file_identity(&candidate.file_path)
                == normalize_file_identity(&reference.file_path)
                && candidate.method_name == reference.method_name
        });
        let resolved = binding.or_else(|| {
            methods
                .iter()
                .find(|candidate| candidate.method_name == reference.method_name)
        });
        let Some(resolved) = resolved else {
            continue;
        };
        let key = format!(
            "{}:{}:{}:{}",
            normalize_file_identity(&resolved.file_path),
            resolved.method_name,
            resolved.line,
            resolved.character
        );
        if !seen.insert(key) {
            continue;
        }
        references.push(PythonMethodCallReference {
            file_path: resolved.file_path.clone(),
            method_name: resolved.method_name.clone(),
            line: resolved.line,
            character: resolved.character,
        });
    }
    references
}

/// incoming 解析:按文件分桶(插入序)→ 打开文档覆盖(仅覆盖已入索引桶,
/// 覆盖保持原桶位序)→ 全量扫描(名命中+目标在列+进程作用域过滤:双方块
/// 已知且不同跳过;未知保守保留)。
pub fn resolve_incoming_python_method_calls(
    methods: &[IndexedPythonMethodLocation],
    open_texts: &[OpenDocumentText],
    python_file: &str,
    method_name: &str,
) -> Vec<IncomingPythonMethodCall> {
    let normalized_target = normalize_file_identity(python_file);
    let target_section = infer_method_section_from_python_file(&normalized_target);

    // 分桶:JS Map 插入序(set 已存键保位)+ 逐桶覆盖。
    let mut order: Vec<String> = Vec::new();
    let mut buckets: HashMap<String, Vec<IndexedPythonMethodLocation>> = HashMap::new();
    for method in methods {
        let key = normalize_file_identity(&method.file_path);
        match buckets.get_mut(&key) {
            Some(bucket) => bucket.push(method.clone()),
            None => {
                order.push(key.clone());
                buckets.insert(key, vec![method.clone()]);
            }
        }
    }
    for open in open_texts {
        let key = normalize_file_identity(&open.fs_path);
        let Some(bucket) = buckets.get(&key) else {
            continue;
        };
        let file_path = bucket[0].file_path.clone();
        buckets.insert(key, parse_python_method_blocks(&open.content, &file_path));
    }
    let mut flat: Vec<IndexedPythonMethodLocation> = Vec::new();
    for key in &order {
        if let Some(bucket) = buckets.get(key) {
            flat.extend(bucket.iter().cloned());
        }
    }

    let mut incoming = Vec::new();
    for method in &flat {
        for call in &method.calls {
            if call.method_name != method_name {
                continue;
            }
            if flat.iter().find(|candidate| {
                candidate.method_name == call.method_name
                    && normalize_file_identity(&candidate.file_path) == normalized_target
            })
            .is_none()
            {
                continue;
            }
            let caller_section = infer_method_section_from_python_file(&method.file_path);
            if let (Some(target), Some(caller)) = (target_section, caller_section) {
                if caller != target {
                    continue;
                }
            }
            incoming.push(IncomingPythonMethodCall {
                caller: IncomingCaller {
                    file_path: method.file_path.clone(),
                    method_name: method.method_name.clone(),
                    line: method.line,
                    character: method.character,
                },
                call_line: call.line,
                call_character: call.character,
            });
        }
    }
    incoming
}

// ---------------------------------------------------------------------------
// golden 语料/探测/dump(TS 侧 parity 驱动同集)
// ---------------------------------------------------------------------------

/// 语料条目:in_index=false 的条目只作打开文档覆盖文本,不入索引。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodCallsCorpusEntry {
    pub name: String,
    pub text: String,
    pub in_index: bool,
    pub fs_path: String,
}

/// 探测面:outgoing / incoming(open_texts 引用 corpus 条目作覆盖文本)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum MethodCallsProbe {
    // 变体级 rename_all 才落字段(容器级只改变体名)
    #[serde(rename_all = "camelCase")]
    Outgoing {
        target_file: String,
        target_method: String,
    },
    #[serde(rename_all = "camelCase")]
    Incoming {
        target_file: String,
        target_method: String,
        #[serde(default)]
        open_texts: Vec<OpenTextRef>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTextRef {
    pub corpus: String,
    pub fs_path: String,
}

/// 产出面(与 Probe 一一对应)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum MethodCallsProbeOutcome {
    Outgoing {
        references: Vec<PythonMethodCallReference>,
    },
    Incoming {
        incoming: Vec<IncomingPythonMethodCall>,
    },
}

/// golden 文件形态。
#[derive(Debug, Serialize, Deserialize)]
pub struct PythonMethodCallsGolden {
    pub generator: String,
    pub corpus: Vec<MethodCallsCorpusEntry>,
    pub probes: Vec<MethodCallsProbe>,
    pub outcomes: Vec<MethodCallsProbeOutcome>,
}

pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/python-method-calls-parity.json";

/// golden 语料:三进程同构(同名方法跨 base/cell)+ common 未知区块 +
/// 正则盲区诚实面(字符串/注释命中、myself 词边界、self.self 链)+
/// 缩进边界(全角空格空白行/零缩进注释截断)+ CJK 列域 + def de 首现列。
#[allow(clippy::needless_raw_string_hashes)]
fn method_calls_corpus() -> Vec<MethodCallsCorpusEntry> {
    vec![
        MethodCallsCorpusEntry {
            name: "base_avatar".into(),
            fs_path: "ws/scripts/base/avatar.py".into(),
            in_index: true,
            text: concat!(
                "class Avatar(BaseAvatar):\n",
                "    \"\"\"base avatar\"\"\"\n",
                "\n",
                "    def onEnterWorld(self, y):\n",
                "        self.prepare(y)\n",
                "        self.helper()\n",
                "        self.remoteOnly()\n",
                "\n",
                "    def prepare(self, y):\n",
                "        self.helper()\n",
                "\n",
                "    def helper(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "base_forms".into(),
            fs_path: "ws/scripts/base/forms.py".into(),
            in_index: true,
            text: concat!(
                "class Forms:\n",
                "    async def run(self):\n",
                "        self.step()\n",
                "        myself.step()\n",
                "        s = 'self.step()'\n",
                "        print(s)  # self.step()\n",
                "\n",
                "    def step(self):\n",
                "        self.self.x()\n",
                "\n",
                "    def de(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "base_cjk".into(),
            fs_path: "ws/scripts/base/cjk.py".into(),
            in_index: true,
            text: concat!(
                "class Cjk:\n",
                "    def Fire(self):\n",
                "        \u{72b6}\u{6001} = 1  # \u{4e2d}\u{6587} self.Helper()\n",
                "        self.Helper()\n",
                "\n",
                "    def Helper(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "base_gap".into(),
            fs_path: "ws/scripts/base/gap.py".into(),
            in_index: true,
            text: concat!(
                "class Gap:\n",
                "    def wide(self):\n",
                "        self.narrow()\n",
                "\u{3000}\n",
                "        self.tail()\n",
                "# \u{96f6}\u{7f29}\u{8fdb}\u{6ce8}\u{91ca}\u{622a}\u{65ad}\u{65b9}\u{6cd5}\u{5757}\n",
                "    def narrow(self):\n",
                "        pass\n",
                "    def tail(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "cell_avatar".into(),
            fs_path: "ws/scripts/cell/avatar.py".into(),
            in_index: true,
            text: concat!(
                "class Avatar:\n",
                "    def onEnterWorld(self, y):\n",
                "        self.prepare(y)\n",
                "\n",
                "    def prepare(self, y):\n",
                "        pass\n",
                "\n",
                "    def helper(self):\n",
                "        pass\n",
                "\n",
                "    def remoteOnly(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "common_util".into(),
            fs_path: "ws/scripts/common/util.py".into(),
            in_index: true,
            text: concat!(
                "class Util:\n",
                "    def onEnterWorld(self, y):\n",
                "        self.prepare(y)\n",
                "        self.helper()\n",
                "\n",
                "    def prepare(self, y):\n",
                "        pass\n",
                "\n",
                "    def helper(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "open_base_avatar_stripped".into(),
            fs_path: "ws/scripts/base/avatar.py".into(),
            in_index: false,
            text: concat!(
                "class Avatar(BaseAvatar):\n",
                "    \"\"\"base avatar\"\"\"\n",
                "\n",
                "    def onEnterWorld(self, y):\n",
                "        self.helper()\n",
                "        self.remoteOnly()\n",
                "\n",
                "    def prepare(self, y):\n",
                "        self.helper()\n",
                "\n",
                "    def helper(self):\n",
                "        pass\n",
            ).into(),
        },
        MethodCallsCorpusEntry {
            name: "open_ghost".into(),
            fs_path: "ws/scripts/base/ghost.py".into(),
            in_index: false,
            text: concat!(
                "class Ghost:\n",
                "    def prepare(self):\n",
                "        self.helper()\n",
            ).into(),
        },
    ]
}

fn method_calls_probes() -> Vec<MethodCallsProbe> {
    vec![
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/avatar.py".into(),
            target_method: "onEnterWorld".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/avatar.py".into(),
            target_method: "helper".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/avatar.py".into(),
            target_method: "prepare".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/avatar.py".into(),
            target_method: "missingMethod".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/forms.py".into(),
            target_method: "run".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/forms.py".into(),
            target_method: "step".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/cjk.py".into(),
            target_method: "Fire".into(),
        },
        MethodCallsProbe::Outgoing {
            target_file: "ws/scripts/base/gap.py".into(),
            target_method: "wide".into(),
        },
        MethodCallsProbe::Incoming {
            target_file: "ws/scripts/base/avatar.py".into(),
            target_method: "prepare".into(),
            open_texts: vec![],
        },
        MethodCallsProbe::Incoming {
            target_file: "ws/scripts/common/util.py".into(),
            target_method: "prepare".into(),
            open_texts: vec![],
        },
        MethodCallsProbe::Incoming {
            target_file: "ws/scripts/base/avatar.py".into(),
            target_method: "prepare".into(),
            open_texts: vec![
                OpenTextRef { corpus: "open_base_avatar_stripped".into(), fs_path: "ws/scripts/base/avatar.py".into() },
                OpenTextRef { corpus: "open_ghost".into(), fs_path: "ws/scripts/base/ghost.py".into() },
            ],
        },
        MethodCallsProbe::Incoming {
            target_file: "ws/scripts/cell/avatar.py".into(),
            target_method: "helper".into(),
            open_texts: vec![],
        },
    ]
}

/// 索引 = in_index 条目按序解析(与 TS parity 驱动同构)。
fn build_index_from_corpus(corpus: &[MethodCallsCorpusEntry]) -> Vec<IndexedPythonMethodLocation> {
    let mut methods = Vec::new();
    for entry in corpus.iter().filter(|e| e.in_index) {
        methods.extend(parse_python_method_blocks(&entry.text, &entry.fs_path));
    }
    methods
}

fn run_method_calls_probe(probe: &MethodCallsProbe) -> MethodCallsProbeOutcome {
    let corpus = method_calls_corpus();
    let index = build_index_from_corpus(&corpus);
    match probe {
        MethodCallsProbe::Outgoing { target_file, target_method } => {
            MethodCallsProbeOutcome::Outgoing {
                references: resolve_outgoing_python_method_calls(&index, target_file, target_method),
            }
        }
        MethodCallsProbe::Incoming { target_file, target_method, open_texts } => {
            let open_docs: Vec<OpenDocumentText> = open_texts
                .iter()
                .map(|reference| {
                    let entry = corpus
                        .iter()
                        .find(|entry| entry.name == reference.corpus)
                        .unwrap_or_else(|| panic!("corpus 缺失: {}", reference.corpus));
                    OpenDocumentText {
                        fs_path: reference.fs_path.clone(),
                        content: entry.text.clone(),
                    }
                })
                .collect();
            MethodCallsProbeOutcome::Incoming {
                incoming: resolve_incoming_python_method_calls(&index, &open_docs, target_file, target_method),
            }
        }
    }
}

pub fn dump_python_method_calls_golden() -> String {
    let probes = method_calls_probes();
    let outcomes: Vec<MethodCallsProbeOutcome> = probes.iter().map(run_method_calls_probe).collect();
    let golden = PythonMethodCallsGolden {
        generator: "dump-python-method-calls-golden".into(),
        corpus: method_calls_corpus(),
        probes,
        outcomes,
    };
    serde_json::to_string(&golden).expect("golden 序列化")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_blocks_indent_endline_and_edges() {
        let blocks = parse_python_method_blocks(
            concat!(
                "class A:\n",
                "    async def run(self):\n",
                "        self.step()\n",
                "\u{3000}\n",
                "        self.tail2()\n",
                "# zero indent comment\n",
                "    def step(self):\n",
                "        pass\n",
                "    def tail2(self):\n",
                "        pass\n",
            ),
            "ws/scripts/base/a.py",
        );
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].method_name, "run");
        assert_eq!(blocks[0].line, 2);
        // \u3000 全角空格行按 JS trim 语义是空白行,跳过;零缩进注释行截断
        assert_eq!(blocks[0].end_line, 5);
        assert_eq!(blocks[0].calls.len(), 2);
        assert_eq!(blocks[0].calls[0].method_name, "step");
        assert_eq!(blocks[0].calls[0].line, 3);
        assert_eq!(blocks[0].calls[0].character, 13);
        // \u3000 空白行跳过后,尾调用仍被捕获(空白行截断会丢尾调用,钉住)
        assert_eq!(blocks[0].calls[1].method_name, "tail2");
        assert_eq!(blocks[0].calls[1].line, 5);
        assert_eq!(blocks[0].calls[1].character, 13);
        assert_eq!(blocks[1].method_name, "step");
        assert_eq!(blocks[1].line, 7);
        assert_eq!(blocks[2].method_name, "tail2");
        assert_eq!(blocks[2].line, 9);
    }

    #[test]
    fn parse_def_edge_first_occurrence_and_cjk_columns() {
        // def de(...): indexOf("de") 命中 "def" 前缀内部(4 缩进后列 4,JS indexOf 同构)
        let blocks = parse_python_method_blocks("    def de(self):\n        pass\n", "f.py");
        assert_eq!(blocks[0].method_name, "de");
        assert_eq!(blocks[0].character, 4);

        // CJK 前缀调用点列 = UTF-16 列(状态 = 1  # 中文 self.Helper())
        let line = "        \u{72b6}\u{6001} = 1  # \u{4e2d}\u{6587} self.Helper()\n";
        let blocks = parse_python_method_blocks(
            &format!("class C:\n    def Fire(self):\n{}\n", line),
            "c.py",
        );
        let call = &blocks[0].calls[0];
        assert_eq!(call.method_name, "Helper");
        // 8 缩进 + 状态(2) + " = 1  # "(9,1 后双空格) + 中文(2) + 空格(1) = 22,self. 后 +5 = 27?实算:0-7 空格,8-9 状态,10 空格,11 =,12 空格,13 1,14-15 双空格,16 #,17 空格,18-19 中文,20 空格,self.=21-25 → H 列 26
        assert_eq!(call.character, 26);
    }

    #[test]
    fn parse_self_call_word_boundary_and_chain() {
        let blocks = parse_python_method_blocks(
            concat!(
                "class F:\n",
                "    def run(self):\n",
                "        myself.step()\n",
                "        s = 'self.step()'\n",
                "        self.self.x()\n",
                "        self.step ( )\n",
            ),
            "f.py",
        );
        let calls: Vec<&str> = blocks[0].calls.iter().map(|c| c.method_name.as_str()).collect();
        // myself 不匹配(词边界);字符串/注释态照匹配(正则盲区,双端诚实);
        // self.self.x → 第二个 self. 起 ident x 命中;self.step ( ) 带空白命中
        assert_eq!(calls, vec!["step", "x", "step"]);
        assert_eq!(blocks[0].calls[1].method_name, "x");
    }

    #[test]
    fn outgoing_binding_fallback_and_dedup() {
        let index = vec![
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/base/a.py".into(),
                method_name: "caller".into(),
                line: 2,
                character: 8,
                end_line: 5,
                calls: vec![
                    PythonSelfCall { method_name: "same".into(), line: 3, character: 13, file_path: "ws/scripts/base/a.py".into() },
                    PythonSelfCall { method_name: "same".into(), line: 4, character: 13, file_path: "ws/scripts/base/a.py".into() },
                    PythonSelfCall { method_name: "elsewhere".into(), line: 5, character: 13, file_path: "ws/scripts/base/a.py".into() },
                ],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/base/a.py".into(),
                method_name: "same".into(),
                line: 7,
                character: 8,
                end_line: 8,
                calls: vec![],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/cell/a.py".into(),
                method_name: "elsewhere".into(),
                line: 2,
                character: 8,
                end_line: 3,
                calls: vec![],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/common/a.py".into(),
                method_name: "elsewhere".into(),
                line: 2,
                character: 8,
                end_line: 3,
                calls: vec![],
            },
        ];
        let references = resolve_outgoing_python_method_calls(&index, "ws/scripts/base/a.py", "caller");
        // 同文件重复调用 dedup 为一;elsewhere 本文件无 → 同名回退首现(cell)
        assert_eq!(references.len(), 2);
        assert_eq!(references[0].file_path, "ws/scripts/base/a.py");
        assert_eq!(references[0].method_name, "same");
        assert_eq!(references[1].file_path, "ws/scripts/cell/a.py");
        // 目标不存在 → 空
        assert!(resolve_outgoing_python_method_calls(&index, "ws/scripts/base/a.py", "nope").is_empty());
    }

    #[test]
    fn incoming_section_filter_and_unknown_retention() {
        let index = vec![
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/base/a.py".into(),
                method_name: "caller".into(),
                line: 2,
                character: 8,
                end_line: 3,
                calls: vec![PythonSelfCall { method_name: "work".into(), line: 3, character: 13, file_path: "ws/scripts/base/a.py".into() }],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/cell/a.py".into(),
                method_name: "caller".into(),
                line: 2,
                character: 8,
                end_line: 3,
                calls: vec![PythonSelfCall { method_name: "work".into(), line: 3, character: 13, file_path: "ws/scripts/cell/a.py".into() }],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/common/a.py".into(),
                method_name: "caller".into(),
                line: 2,
                character: 8,
                end_line: 3,
                calls: vec![PythonSelfCall { method_name: "work".into(), line: 3, character: 13, file_path: "ws/scripts/common/a.py".into() }],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/base/a.py".into(),
                method_name: "work".into(),
                line: 5,
                character: 8,
                end_line: 6,
                calls: vec![],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/common/a.py".into(),
                method_name: "work".into(),
                line: 5,
                character: 8,
                end_line: 6,
                calls: vec![],
            },
        ];
        // 目标 base:cell 调用方被作用域过滤,common(未知区块)保守保留
        let incoming = resolve_incoming_python_method_calls(&index, &[], "ws/scripts/base/a.py", "work");
        assert_eq!(incoming.len(), 2);
        assert_eq!(incoming[0].caller.file_path, "ws/scripts/base/a.py");
        assert_eq!(incoming[1].caller.file_path, "ws/scripts/common/a.py");
        // 目标区块未知(common):全保留
        let all = resolve_incoming_python_method_calls(&index, &[], "ws/scripts/common/a.py", "work");
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn incoming_open_text_override_and_missing_bucket() {
        let index = vec![
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/base/a.py".into(),
                method_name: "caller".into(),
                line: 2,
                character: 8,
                end_line: 3,
                calls: vec![PythonSelfCall { method_name: "work".into(), line: 3, character: 13, file_path: "ws/scripts/base/a.py".into() }],
            },
            IndexedPythonMethodLocation {
                file_path: "ws/scripts/base/a.py".into(),
                method_name: "work".into(),
                line: 5,
                character: 8,
                end_line: 6,
                calls: vec![],
            },
        ];
        // 覆盖已入索引桶:调用点随缓冲区消失 → 空
        let stripped = "class A:\n    def caller(self):\n        pass\n    def work(self):\n        pass\n";
        let incoming = resolve_incoming_python_method_calls(
            &index,
            &[OpenDocumentText { fs_path: "ws/scripts/base/a.py".into(), content: stripped.into() }],
            "ws/scripts/base/a.py",
            "work",
        );
        assert!(incoming.is_empty());
        // 未入索引的打开文件不整体增扫(跳过)
        let incoming2 = resolve_incoming_python_method_calls(
            &index,
            &[OpenDocumentText {
                fs_path: "ws/scripts/base/ghost.py".into(),
                content: "class Ghost:\n    def caller(self):\n        self.work()\n".into(),
            }],
            "ws/scripts/base/a.py",
            "work",
        );
        assert_eq!(incoming2.len(), 1);
        assert_eq!(incoming2[0].caller.file_path, "ws/scripts/base/a.py");
    }

    #[test]
    fn golden_probes_cover_both_faces() {
        let probes = method_calls_probes();
        assert!(probes.len() >= 12);
        let outgoing = probes.iter().filter(|p| matches!(p, MethodCallsProbe::Outgoing { .. })).count();
        let incoming = probes.iter().filter(|p| matches!(p, MethodCallsProbe::Incoming { .. })).count();
        assert!(outgoing >= 8, "outgoing 探测面规模");
        assert!(incoming >= 4, "incoming 探测面规模");
        // 覆盖文本探测有且引用真 corpus 条目
        let corpus = method_calls_corpus();
        for probe in &probes {
            if let MethodCallsProbe::Incoming { open_texts, .. } = probe {
                for reference in open_texts {
                    assert!(
                        corpus.iter().any(|entry| entry.name == reference.corpus && !entry.in_index),
                        "覆盖文本条目须在 corpus 且不入索引: {}", reference.corpus
                    );
                }
            }
        }
    }
}
