//! golden 重生成比对(Rust 侧真值;TS 侧 tests/kodeTypesParity.test.ts 用现有
//! defParser/compositionRoots 原语复算同一 golden,形成双向对拍,PR-005/007 同构)。

use kode_types::golden::{dump_type_golden, GOLDEN_REL_PATH};

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn type_golden_matches_regenerated_dump() {
    let regenerated = dump_type_golden(&repo_root());
    let golden_path = repo_root().join(GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-types/tests/golden/type-parity.json");
    // 尾部换行由重定向/dump-type-golden println! 引入,不参与比对
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "type golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-types --bin dump-type-golden -- . > crates/kode-types/tests/golden/type-parity.json\nRust 重生成:…{}",
            &regenerated[diff_at.saturating_sub(120)..(diff_at + 160).min(regenerated.len())],
        );
    }
    assert!(committed.contains("\"typeNodeCount\":"));
    assert!(committed.contains("dump-type-golden"));
}

/// 最小 JSON 读取器(零依赖,与 kode-index 同款;仅做结构完整性抽查)。
#[derive(Debug, Clone, PartialEq)]
enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> P<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && (self.b[self.i] as char).is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn value(&mut self) -> Option<Value> {
        self.ws();
        match *self.b.get(self.i)? {
            b'{' => {
                self.i += 1;
                let mut out = Vec::new();
                loop {
                    self.ws();
                    match *self.b.get(self.i)? {
                        b'}' => {
                            self.i += 1;
                            return Some(Value::Obj(out));
                        }
                        b',' => {
                            self.i += 1;
                        }
                        _ => {
                            let k = match self.value()? {
                                Value::Str(s) => s,
                                _ => return None,
                            };
                            self.ws();
                            if *self.b.get(self.i)? != b':' {
                                return None;
                            }
                            self.i += 1;
                            let v = self.value()?;
                            out.push((k, v));
                        }
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut out = Vec::new();
                loop {
                    self.ws();
                    match *self.b.get(self.i)? {
                        b']' => {
                            self.i += 1;
                            return Some(Value::Arr(out));
                        }
                        b',' => {
                            self.i += 1;
                        }
                        _ => out.push(self.value()?),
                    }
                }
            }
            b'"' => {
                self.i += 1;
                let mut s = String::new();
                loop {
                    let c = *self.b.get(self.i)? as char;
                    self.i += 1;
                    match c {
                        '"' => return Some(Value::Str(s)),
                        '\\' => {
                            let e = *self.b.get(self.i)? as char;
                            self.i += 1;
                            s.push(match e {
                                'n' => '\n',
                                't' => '\t',
                                'r' => '\r',
                                other => other,
                            });
                        }
                        other => s.push(other),
                    }
                }
            }
            b't' => {
                self.i += 4;
                Some(Value::Bool(true))
            }
            b'f' => {
                self.i += 5;
                Some(Value::Bool(false))
            }
            b'n' => {
                self.i += 4;
                Some(Value::Null)
            }
            _ => {
                let start = self.i;
                while self.i < self.b.len()
                    && matches!(
                        self.b[self.i],
                        b'-' | b'.' | b'0'..=b'9' | b'e' | b'E' | b'+'
                    )
                {
                    self.i += 1;
                }
                std::str::from_utf8(&self.b[start..self.i])
                    .ok()?
                    .parse::<f64>()
                    .ok()
                    .map(Value::Num)
            }
        }
    }
}

fn parse_json(text: &str) -> Value {
    let mut p = P {
        b: text.as_bytes(),
        i: 0,
    };
    p.value().expect("golden 不是合法 JSON")
}

#[test]
fn type_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(repo_root().join(GOLDEN_REL_PATH)).expect("golden");
    let value = parse_json(committed.trim_end_matches('\n'));
    let Value::Obj(root) = value else {
        panic!("golden 顶层必须是对象");
    };
    let get = |obj: &Vec<(String, Value)>, key: &str| -> Value {
        obj.iter()
            .find(|(k, _)| k == key)
            .cloned()
            .map(|(_, v)| v)
            .unwrap_or(Value::Null)
    };
    let file_count = match get(&root, "fileCount") {
        Value::Num(n) => n as usize,
        _ => panic!("fileCount 缺失"),
    };
    assert!(file_count >= 25, "语料文件数异常: {file_count}");
    let Value::Arr(files) = get(&root, "files") else {
        panic!("files 缺失");
    };
    assert_eq!(files.len(), file_count, "files 数与 fileCount 不符");
    let mut def_compositions = 0;
    let mut type_decls = 0;
    for f in &files {
        let Value::Obj(fobj) = f else {
            panic!("file 条目必须是对象");
        };
        assert!(
            matches!(get(fobj, "kind"), Value::Str(ref k) if matches!(k.as_str(), "def" | "entities" | "types" | "alias"))
        );
        if get(fobj, "kind") != Value::Str("def".into()) {
            continue;
        }
        def_compositions += 1;
        let Value::Obj(comp) = get(fobj, "composition") else {
            panic!("def 文件缺少 composition");
        };
        assert!(matches!(get(&comp, "parent"), Value::Str(_) | Value::Null));
        assert!(matches!(get(&comp, "interfaces"), Value::Arr(_)));
        assert!(matches!(get(&comp, "components"), Value::Arr(_)));
        assert!(matches!(get(&comp, "fieldTypes"), Value::Arr(_)));
    }
    assert!(
        def_compositions >= 10,
        "def composition 数异常: {def_compositions}"
    );
    for f in &files {
        let Value::Obj(fobj) = f else { continue };
        if get(fobj, "kind") != Value::Str("types".into()) {
            continue;
        }
        if let Value::Arr(decls) = get(fobj, "decls") {
            type_decls += decls.len();
        }
    }
    assert!(type_decls >= 5, "types.xml 声明数异常: {type_decls}");
    let Value::Obj(graph) = get(&root, "graph") else {
        panic!("graph 缺失");
    };
    for section in [
        "classifications",
        "aliasChains",
        "inheritanceChains",
        "cycles",
    ] {
        assert!(
            matches!(get(&graph, section), Value::Arr(_)),
            "graph.{section} 缺失"
        );
    }
}
