// SemanticTokens 决策核(RUST-144 批 3,新面):python 文件结构符号语义
// ——class/方法/模块级函数声明名、def 形参名、装饰器名,共 5 类 token
// (语法关键字/字符串面留给 TextMate grammar,不与之重叠)。纯函数零
// RPC,解析复用 def_param_hints(python_code_lines/python_statements/
// parse_python_file/parse_def_line 同一套 def 行扫描,口径一致),全程
// UTF-16 单元域。诚实边界:self.X 属性访问与局部变量面不做(与
// Pylance 冲突大+需 self scope 分析,后续批次按 RUST-148 冲突矩阵裁
// 度);跨行 def 的形参不提取(与 inlay 同单行闸)。
use crate::def_param_hints::{
    index_from, is_ident_start, is_ident_unit, parse_def_line, parse_python_file,
    python_code_lines, python_statements, units, units_to_string,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// legend 顺序即编码 typeIndex(与 TS semanticTokens.ts 同序,勿改序)。
pub const SEMANTIC_TOKEN_TYPES: [&str; 5] = ["class", "function", "method", "parameter", "macro"];

pub const SEMANTIC_TOKEN_MODIFIERS: [&str; 2] = ["declaration", "async"];

/// 结构符号 span(与 TS SemanticTokenSpan 同形;`type` 字段经 serde rename)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTokenSpan {
    /// 0 起行
    pub line: usize,
    /// 行内 0 起 UTF-16 列
    pub start_character: usize,
    pub length: usize,
    #[serde(rename = "type")]
    pub token_type: String,
    /// 'declaration' 声明位;'async' async def(声明名与形参都可带)
    pub modifiers: Vec<String>,
}

fn is_js_space(unit: u16) -> bool {
    matches!(unit, 0x20 | 0x09 | 0x0a | 0x0b | 0x0c | 0x0d)
}

fn units_startswith(u: &[u16], word: &str) -> bool {
    let w: Vec<u16> = word.encode_utf16().collect();
    u.len() >= w.len() && u[..w.len()] == w[..]
}

fn skip_js_space(u: &[u16], mut i: usize) -> usize {
    while i < u.len() && is_js_space(u[i]) {
        i += 1;
    }
    i
}

fn ident_end(u: &[u16], mut i: usize) -> usize {
    while i < u.len() && is_ident_unit(u[i]) {
        i += 1;
    }
    i
}

/// `/^\s*class\s+([A-Za-z_]\w*)/` 同构:返回 (名字, 匹配尾 UTF-16 列)。
fn match_class_name(line: &str) -> Option<(String, usize)> {
    let u = units(line);
    let mut i = skip_js_space(&u, 0);
    if !units_startswith(&u[i..], "class") {
        return None;
    }
    i += 5;
    let ws_start = i;
    i = skip_js_space(&u, i);
    if i == ws_start || i >= u.len() || !is_ident_start(u[i]) {
        return None;
    }
    let name_start = i;
    let end = ident_end(&u, i);
    Some((units_to_string(&u[name_start..end]), end))
}

/// `/^\s*(async\s+)?def\s+([A-Za-z_]\w*)/` 同构:返回 (async?, 名字, 匹配
/// 尾 UTF-16 列)。async 分支不成立时回退裸 def 分支(正则回溯语义)。
fn match_def_head(text: &str) -> Option<(bool, String, usize)> {
    let u = units(text);
    let i = skip_js_space(&u, 0);
    let mut j = i;
    let mut is_async = false;
    if units_startswith(&u[j..], "async") {
        j += 5;
        let ws_start = j;
        j = skip_js_space(&u, j);
        if j > ws_start && units_startswith(&u[j..], "def") {
            j += 3;
            let ws2 = j;
            j = skip_js_space(&u, j);
            if j > ws2 {
                is_async = true;
            }
        }
    }
    if !is_async {
        j = i;
        if !units_startswith(&u[j..], "def") {
            return None;
        }
        j += 3;
        let ws_start = j;
        j = skip_js_space(&u, j);
        if j == ws_start {
            return None;
        }
    }
    if j >= u.len() || !is_ident_start(u[j]) {
        return None;
    }
    let name_start = j;
    let end = ident_end(&u, j);
    Some((is_async, units_to_string(&u[name_start..end]), end))
}

/// `/^\s*@\s*([A-Za-z_][\w.]*)/` 同构:返回 (装饰器全表达式, 匹配尾 UTF-16 列)。
fn match_decorator(text: &str) -> Option<(String, usize)> {
    let u = units(text);
    let mut i = skip_js_space(&u, 0);
    if i >= u.len() || u[i] != b'@' as u16 {
        return None;
    }
    i += 1;
    i = skip_js_space(&u, i);
    if i >= u.len() || !is_ident_start(u[i]) {
        return None;
    }
    let name_start = i;
    while i < u.len() && (is_ident_unit(u[i]) || u[i] == b'.' as u16) {
        i += 1;
    }
    Some((units_to_string(&u[name_start..i]), i))
}

/// `/^\s*async\s+def\s/` 同构(掩码行 async 判定)。
fn is_async_def_line(line: &str) -> bool {
    let u = units(line);
    let mut i = skip_js_space(&u, 0);
    if !units_startswith(&u[i..], "async") {
        return false;
    }
    i += 5;
    let ws_start = i;
    i = skip_js_space(&u, i);
    if i == ws_start || !units_startswith(&u[i..], "def") {
        return false;
    }
    i += 3;
    i < u.len() && is_js_space(u[i])
}

/// 单行闭合 def 的形参 span(parse_def_line 与 inlay 同一套;site.params
/// 已剥首参 self/cls——本扩展 parameter 语义=RPC 形参,接收者不是形参,
/// 与 inlay/签名 formatter 同口径;跨行不出)。
#[allow(clippy::too_many_arguments)]
fn collect_parameter_spans(
    line_text: &str,
    line: usize,
    method_name: &str,
    name_character: usize,
    modifiers: &[&str],
    spans: &mut Vec<SemanticTokenSpan>,
) {
    let Some(site) = parse_def_line(line_text, line, method_name, name_character, "ClientMethods")
    else {
        return;
    };
    for param in &site.params {
        spans.push(SemanticTokenSpan {
            line,
            start_character: param.start,
            length: param.end - param.start,
            token_type: "parameter".into(),
            modifiers: modifiers.iter().map(|m| (*m).to_string()).collect(),
        });
    }
}

/// 提取结构符号 span(按行/列升序,无去重——同一 token 只会由单一规则产
/// 出)。任何 python 文件都出(语言级结构语义,无实体段闸);空文件/无符
/// 号文件返回空数组。
pub fn build_semantic_token_spans(text: &str) -> Vec<SemanticTokenSpan> {
    let masked_lines = python_code_lines(text);
    let parsed = parse_python_file(text);
    let mut spans: Vec<SemanticTokenSpan> = Vec::new();

    // 类声明名(掩码行内 class 后名字;掩码位置不变故列对齐原文)
    for cls in &parsed {
        let line_text = masked_lines.get(cls.start_line).map(String::as_str).unwrap_or("");
        if let Some((name, match_end)) = match_class_name(line_text) {
            let name_units = units(&name).len();
            let from = match_end - name_units;
            let start = index_from(line_text, &name, from).unwrap_or(from);
            spans.push(SemanticTokenSpan {
                line: cls.start_line,
                start_character: start,
                length: name_units,
                token_type: "class".into(),
                modifiers: vec!["declaration".into()],
            });
        }
    }

    // 方法声明名(parse_python_file methods 表,行/列直用;async 从掩码行判)
    let mut class_bound_def_lines: HashSet<usize> = HashSet::new();
    for cls in &parsed {
        for (method_name, line, character) in &cls.methods {
            class_bound_def_lines.insert(*line);
            let mut modifiers = vec!["declaration".to_string()];
            let masked = masked_lines.get(*line).map(String::as_str).unwrap_or("");
            if is_async_def_line(masked) {
                modifiers.push("async".to_string());
            }
            spans.push(SemanticTokenSpan {
                line: *line,
                start_character: *character,
                length: units(method_name).len(),
                token_type: "method".into(),
                modifiers,
            });
        }
    }

    // 语句面:模块级 def(function)/装饰器(macro)
    for statement in python_statements(text) {
        let mut handled = false;
        if let Some((is_async, name, match_end)) = match_def_head(&statement.text) {
            if !class_bound_def_lines.contains(&statement.line) {
                let mut modifiers = vec!["declaration".to_string()];
                if is_async {
                    modifiers.push("async".to_string());
                }
                let name_units = units(&name).len();
                let from = match_end - name_units;
                let start = index_from(&statement.text, &name, from).unwrap_or(from);
                spans.push(SemanticTokenSpan {
                    line: statement.line,
                    start_character: start,
                    length: name_units,
                    token_type: "function".into(),
                    modifiers: modifiers.clone(),
                });
                let masked = masked_lines
                    .get(statement.line)
                    .map(String::as_str)
                    .unwrap_or("");
                let modifier_refs: Vec<&str> =
                    modifiers.iter().map(String::as_str).collect();
                collect_parameter_spans(
                    masked,
                    statement.line,
                    &name,
                    start,
                    &modifier_refs,
                    &mut spans,
                );
                handled = true;
            }
        }
        if !handled {
            if let Some((name, match_end)) = match_decorator(&statement.text) {
                let name_units = units(&name).len();
                let from = match_end - name_units;
                let start = index_from(&statement.text, &name, from).unwrap_or(from);
                spans.push(SemanticTokenSpan {
                    line: statement.line,
                    start_character: start,
                    length: name_units,
                    token_type: "macro".into(),
                    modifiers: Vec::new(),
                });
            }
        }
    }

    // 形参:类方法 def 行(parse_python_file 表给的行/列)
    for cls in &parsed {
        for (method_name, line, character) in &cls.methods {
            let masked = masked_lines.get(*line).map(String::as_str).unwrap_or("");
            let modifiers: Vec<&str> = if is_async_def_line(masked) {
                vec!["declaration", "async"]
            } else {
                vec!["declaration"]
            };
            collect_parameter_spans(masked, *line, method_name, *character, &modifiers, &mut spans);
        }
    }

    spans.sort_by(|a, b| a.line.cmp(&b.line).then(a.start_character.cmp(&b.start_character)));
    spans
}

/// LSP 相对编码:[deltaLine, deltaStartChar, length, typeIndex,
/// modifierBitmask]。span 须已按行/列升序(build 保证);legend 索引由
/// SEMANTIC_TOKEN_TYPES/MODIFIERS 定,未知类型报错(装配面 bug 早爆)。
pub fn encode_semantic_tokens(spans: &[SemanticTokenSpan]) -> Result<Vec<u32>, String> {
    let mut data: Vec<u32> = Vec::new();
    let mut prev_line = 0usize;
    let mut prev_start = 0usize;
    for span in spans {
        let type_index = SEMANTIC_TOKEN_TYPES
            .iter()
            .position(|t| *t == span.token_type)
            .ok_or_else(|| format!("unknown semantic token type: {}", span.token_type))?;
        let mut modifier_mask = 0u32;
        for modifier in &span.modifiers {
            if let Some(bit) = SEMANTIC_TOKEN_MODIFIERS.iter().position(|m| m == modifier) {
                modifier_mask |= 1 << bit;
            }
        }
        let delta_line = span.line - prev_line;
        let delta_start = if delta_line == 0 {
            span.start_character - prev_start
        } else {
            span.start_character
        };
        data.extend_from_slice(&[
            delta_line as u32,
            delta_start as u32,
            span.length as u32,
            type_index as u32,
            modifier_mask,
        ]);
        prev_line = span.line;
        prev_start = span.start_character;
    }
    Ok(data)
}

/// 语料条目(py 源)。
#[derive(Debug, Serialize, Deserialize)]
pub struct SemanticCorpusEntry {
    pub name: String,
    pub text: String,
}

/// 探测面:span 提取 / 相对编码。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum SemanticProbe {
    Spans { corpus: String },
    Encoded { corpus: String },
}

/// 产出面(与 Probe 一一对应)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "face", rename_all = "camelCase")]
pub enum SemanticProbeOutcome {
    Spans { spans: Vec<SemanticTokenSpan> },
    Encoded { data: Vec<u32> },
}

/// golden 文件形态。
#[derive(Debug, Serialize, Deserialize)]
pub struct SemanticTokensGolden {
    pub generator: String,
    pub corpus: Vec<SemanticCorpusEntry>,
    pub probes: Vec<SemanticProbe>,
    pub outcomes: Vec<SemanticProbeOutcome>,
}

pub const GOLDEN_REL_PATH: &str = "crates/kode-server/tests/golden/semantic-tokens-parity.json";

// SemanticCorpusEntry 也要 serde(golden 序列化)。
/// golden 语料:8 族(全类提取/伪声明/嵌套类/CJK 列域/async 面/装饰器
/// 变体/注解与星形参/纯注释空产出)。
fn semantic_corpus() -> Vec<SemanticCorpusEntry> {
    vec![
        SemanticCorpusEntry {
            name: "mixed_classes".into(),
            text: concat!(
                "import base\n",
                "\n",
                "@classmethod\n",
                "class Avatar(Base):\n",
                "    async def shoot(self, target, times=1):\n",
                "        pass\n",
                "\n",
                "    def plain(self):\n",
                "        pass\n",
                "\n",
                "def helper(a, b):\n",
                "    pass\n",
            )
            .into(),
        },
        SemanticCorpusEntry {
            name: "pseudo_decls".into(),
            text: concat!(
                "x = \"def fake(self, a):\"\n",
                "# class Ghost:\n",
                "class Real:\n",
                "    def cross(self, a,\n",
                "              b):\n",
                "        pass\n",
            )
            .into(),
        },
        SemanticCorpusEntry {
            name: "nested_class".into(),
            text: concat!(
                "class Outer:\n",
                "    class Inner:\n",
                "        def probe(self, z):\n",
                "            return z\n",
                "\n",
                "    def top(self, y):\n",
                "        pass\n",
            )
            .into(),
        },
        SemanticCorpusEntry {
            name: "cjk_columns".into(),
            text: concat!(
                "# 中文注释:武器类\n",
                "class Weapon:\n",
                "    # 攻击方法\n",
                "    def attack(self, target, times=1):  # 目标 = 敌人\n",
                "        pass\n",
                "\n",
                "def 打印(text):\n",
                "    return text\n",
            )
            .into(),
        },
        SemanticCorpusEntry {
            name: "async_heavy".into(),
            text: concat!(
                "async def fetch(url, retries=3):\n",
                "    pass\n",
                "\n",
                "class Bot:\n",
                "    async def tick(self, dt):\n",
                "        pass\n",
                "\n",
                "    async def stop(self):\n",
                "        pass\n",
            )
            .into(),
        },
        SemanticCorpusEntry {
            name: "decorators_variants".into(),
            text: concat!(
                "@app.route(\"/x\")\n",
                "def handle(req, resp):\n",
                "    pass\n",
                "\n",
                "@base.exposed\n",
                "class Node:\n",
                "    @staticmethod\n",
                "    def make(self, v):\n",
                "        pass\n",
            )
            .into(),
        },
        SemanticCorpusEntry {
            name: "annotated_params".into(),
            text: concat!(
                "class Calc:\n",
                "    def add(self, a: int, b: int = 2, *rest, **kw):\n",
                "        return a + b\n",
                "\n",
                "def scale(v: float, k = 1.5):\n",
                "    return v * k\n",
            )
            .into(),
        },
        SemanticCorpusEntry {
            name: "only_comments".into(),
            text: concat!(
                "# 只有注释\n",
                "# class Phantom:\n",
                "\n",
            )
            .into(),
        },
    ]
}

fn semantic_probes() -> Vec<SemanticProbe> {
    let names = [
        "mixed_classes",
        "pseudo_decls",
        "nested_class",
        "cjk_columns",
        "async_heavy",
        "decorators_variants",
        "annotated_params",
        "only_comments",
    ];
    let mut probes = Vec::new();
    for name in names {
        probes.push(SemanticProbe::Spans { corpus: name.into() });
    }
    for name in names {
        probes.push(SemanticProbe::Encoded { corpus: name.into() });
    }
    probes
}

fn run_semantic_probe(probe: &SemanticProbe) -> SemanticProbeOutcome {
    let corpus = match probe {
        SemanticProbe::Spans { corpus } => corpus,
        SemanticProbe::Encoded { corpus } => corpus,
    };
    let entry = semantic_corpus()
        .into_iter()
        .find(|entry| &entry.name == corpus)
        .unwrap_or_else(|| panic!("corpus 缺失: {corpus}"));
    let spans = build_semantic_token_spans(&entry.text);
    match probe {
        SemanticProbe::Spans { .. } => SemanticProbeOutcome::Spans { spans },
        SemanticProbe::Encoded { .. } => {
            let data = encode_semantic_tokens(&spans).expect("encode");
            SemanticProbeOutcome::Encoded { data }
        }
    }
}

pub fn dump_semantic_tokens_golden() -> String {
    let probes = semantic_probes();
    let outcomes: Vec<SemanticProbeOutcome> = probes.iter().map(run_semantic_probe).collect();
    let golden = SemanticTokensGolden {
        generator: "dump-semantic-tokens-golden".into(),
        corpus: semantic_corpus(),
        probes,
        outcomes,
    };
    serde_json::to_string(&golden).expect("golden 序列化")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_extraction_async_and_params() {
        let text = concat!(
            "import base\n",
            "\n",
            "@classmethod\n",
            "class Avatar(Base):\n",
            "    async def shoot(self, target, times=1):\n",
            "        pass\n",
            "\n",
            "    def plain(self):\n",
            "        pass\n",
            "\n",
            "def helper(a, b):\n",
            "    pass\n",
        );
        let spans = build_semantic_token_spans(text);
        let kind = |line: usize| -> Vec<&str> {
            spans
                .iter()
                .filter(|span| span.line == line)
                .map(|span| span.token_type.as_str())
                .collect()
        };
        // 行 0 import 无符号
        assert_eq!(kind(0), Vec::<&str>::new());
        // 行 2 装饰器 macro
        assert_eq!(kind(2), vec!["macro"]);
        // 行 3 class
        assert_eq!(kind(3), vec!["class"]);
        // 行 4 async def:method+2 形参(self 不算)
        assert_eq!(kind(4), vec!["method", "parameter", "parameter"]);
        // 行 7 普通方法(无形参)
        assert_eq!(kind(7), vec!["method"]);
        // 行 10 模块级 function+2 形参
        assert_eq!(kind(10), vec!["function", "parameter", "parameter"]);
        let shoot = spans
            .iter()
            .find(|span| span.token_type == "method" && span.line == 4)
            .expect("shoot span");
        assert_eq!(shoot.modifiers, vec!["declaration", "async"]);
        let avatar = spans
            .iter()
            .find(|span| span.token_type == "class")
            .expect("avatar span");
        assert_eq!(
            avatar,
            &SemanticTokenSpan {
                line: 3,
                start_character: 6,
                length: 6,
                token_type: "class".into(),
                modifiers: vec!["declaration".into()],
            }
        );
    }

    #[test]
    fn pseudo_decls_and_cross_line_def() {
        let text = concat!(
            "x = \"def fake(self, a):\"\n",
            "# class Ghost:\n",
            "class Real:\n",
            "    def cross(self, a,\n",
            "              b):\n",
            "        pass\n",
        );
        let spans = build_semantic_token_spans(text);
        assert!(spans.iter().any(|span| span.token_type == "class"));
        assert!(!spans.iter().any(|span| span.token_type == "function"));
        // 跨行 def:方法名出(单行),形参不出(同行括号不闭合)
        assert!(spans.iter().any(|span| span.token_type == "method"));
        assert!(!spans.iter().any(|span| span.token_type == "parameter"));
    }

    #[test]
    fn encode_relative_and_unknown_type() {
        assert_eq!(SEMANTIC_TOKEN_TYPES, ["class", "function", "method", "parameter", "macro"]);
        assert_eq!(SEMANTIC_TOKEN_MODIFIERS, ["declaration", "async"]);
        let spans = vec![
            SemanticTokenSpan {
                line: 3,
                start_character: 6,
                length: 6,
                token_type: "class".into(),
                modifiers: vec!["declaration".into()],
            },
            SemanticTokenSpan {
                line: 4,
                start_character: 13,
                length: 5,
                token_type: "method".into(),
                modifiers: vec!["declaration".into(), "async".into()],
            },
            SemanticTokenSpan {
                line: 4,
                start_character: 20,
                length: 6,
                token_type: "parameter".into(),
                modifiers: vec!["declaration".into()],
            },
        ];
        // 行 3→4 deltaLine=1(deltaStart 绝对),行 4 内 deltaStart=20-13
        assert_eq!(
            encode_semantic_tokens(&spans).expect("encode"),
            vec![3, 6, 6, 0, 1, 1, 13, 5, 2, 3, 0, 7, 6, 3, 1]
        );
        // 同行首 token deltaStart 为绝对列
        let same_line = vec![
            SemanticTokenSpan {
                line: 0,
                start_character: 2,
                length: 3,
                token_type: "class".into(),
                modifiers: Vec::new(),
            },
            SemanticTokenSpan {
                line: 0,
                start_character: 9,
                length: 3,
                token_type: "macro".into(),
                modifiers: Vec::new(),
            },
        ];
        assert_eq!(encode_semantic_tokens(&same_line).expect("encode"), vec![0, 2, 3, 0, 0, 0, 7, 3, 4, 0]);
        // 未知类型报错
        assert!(encode_semantic_tokens(&[SemanticTokenSpan {
            line: 0,
            start_character: 0,
            length: 1,
            token_type: "variable".into(),
            modifiers: Vec::new(),
        }])
        .is_err());
    }
}
