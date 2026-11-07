//! 对拍 golden 序列化单测(KODE-CFG 之外的 json.rs 面):转义/默认构造、
//! 语料收集容错(缺目录/非 UTF-8/非 .xml)、各 kind 记录形状、合并语料缺文件
//! 的 null 记录。断言真实 JSON 形状,不做纯行覆盖。

use std::fs;
use std::path::PathBuf;

use kode_parser::json::{
    collect_config_corpus, collect_corpus, dump_config_merge_corpus, record_json, JsonWriter,
};

/// 唯一临时目录(std::process::id() 保证并发会话不互踩)。
fn temp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("kp-json-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn json_writer_escapes_quotes_backslash_and_control_chars() {
    let mut w = JsonWriter::new();
    w.str("a\"b\\c\nd\te\rf\u{1}\u{8}");
    assert_eq!(w.buf, "\"a\\\"b\\\\c\\nd\\te\\rf\\u0001\\u0008\"");
}

#[test]
fn json_writer_helpers_null_and_bool() {
    let mut w = JsonWriter::default();
    assert!(w.buf.is_empty(), "Default 与 new 等价");
    w.opt_str(Some("x")).raw(",").opt_str(None);
    assert_eq!(w.buf, "\"x\",null");
    let mut w2 = JsonWriter::new();
    w2.opt_bool(Some(true))
        .raw(",")
        .opt_bool(Some(false))
        .raw(",")
        .opt_bool(None)
        .raw(",")
        .boolean(true);
    assert_eq!(w2.buf, "true,false,null,true");
    let mut w3 = JsonWriter::new();
    w3.num(42);
    assert_eq!(w3.buf, "42");
}

#[test]
fn corpus_collection_skips_missing_dir_and_unreadable_files() {
    let root = temp_dir("corpus");
    // 缺目录:walk 直接返回,不 panic、不产条目。
    let empty = collect_corpus(&root, &["no-such-corpus"]);
    assert!(empty.is_empty());

    // 语料内:合法 def 收录;非 UTF-8 文件跳过;无关扩展名跳过。
    let corpus = root.join("scripts");
    fs::create_dir_all(&corpus).unwrap();
    fs::write(
        corpus.join("Avatar.def"),
        "<root><Parent> Base </Parent></root>",
    )
    .unwrap();
    fs::write(corpus.join("binary.def"), [0xff, 0xfe, 0x00]).unwrap();
    fs::write(corpus.join("notes.txt"), "not collected").unwrap();
    let files = collect_corpus(&root, &["scripts"]);
    assert_eq!(files.len(), 1, "只有合法 UTF-8 的 .def 收录: {files:?}");
    let (kind, text) = files.get("scripts/Avatar.def").unwrap();
    assert_eq!(*kind, "def");
    assert!(text.contains("Avatar.def") || text.contains("Base") || !text.is_empty());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn record_json_emits_alias_and_panics_on_unknown_kind() {
    // alias 记录:名字 + aliasType + line,与 dump_alias 形状一致。
    let json = record_json("alias", "<root><A1> UINT16 </A1></root>");
    assert_eq!(
        json,
        "{\"aliases\":[{\"name\":\"A1\",\"aliasType\":\"UINT16\",\"line\":1}]}"
    );

    // 空 alias 语料:空数组。
    let empty = record_json("alias", "<root/>");
    assert_eq!(empty, "{\"aliases\":[]}");

    // 多个 alias:逐项 `,` 分隔(单条与多条之间的分隔臂)。
    let multi = record_json("alias", "<root><A1> UINT16 </A1><B2> UINT8 </B2></root>");
    assert_eq!(
        multi,
        "{\"aliases\":[{\"name\":\"A1\",\"aliasType\":\"UINT16\",\"line\":1},{\"name\":\"B2\",\"aliasType\":\"UINT8\",\"line\":1}]}"
    );

    // 未知 kind:内部契约,panic 即 fail-fast(不静默产错档)。
    let result = std::panic::catch_unwind(|| record_json("bogus", "<root/>"));
    assert!(result.is_err(), "未知 kind 必须显式失败");
}

#[test]
fn def_record_json_commits_components_and_extra_sections() {
    // 两个组件 + 两个未知段落:JSON 里逗号分隔,逐项保留。
    let text = "<root>\
        <Components><inv><Type> Inventory </Type><Persistent> true </Persistent></inv>\
        <bag><Type> Bag </Type></bag></Components>\
        <DetailLevels><NEAR><radius> 10 </radius></NEAR></DetailLevels>\
        <FarLevels><NEAR><radius> 5 </radius></NEAR></FarLevels>\
        </root>";
    let json = record_json("def", text);
    assert!(json.contains("\"components\":[{\"name\":\"inv\",\"type\":\"Inventory\",\"persistent\":true,\"line\":1},{\"name\":\"bag\",\"type\":\"Bag\",\"persistent\":null,\"line\":1}]"), "{json}");
    assert!(
        json.contains("\"extraSections\":[\"DetailLevels\",\"FarLevels\"]"),
        "{json}"
    );
    assert!(json.contains("\"syntaxErrorCount\":0"), "{json}");
}

#[test]
fn config_corpus_collection_skips_missing_dir_and_non_xml() {
    let root = temp_dir("config");
    // 缺目录:空表。
    assert!(collect_config_corpus(&root).is_empty());

    let dir = root.join("tests").join("fixtures").join("config");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("a.xml"), "<root><k>1</k></root>").unwrap();
    fs::write(dir.join("b.txt"), "skip me").unwrap();
    fs::write(dir.join("c.xml"), [0xff, 0xfe]).unwrap();
    let files = collect_config_corpus(&root);
    assert_eq!(
        files.keys().cloned().collect::<Vec<_>>(),
        vec!["tests/fixtures/config/a.xml".to_string()],
        "只收合法 UTF-8 的 .xml: {files:?}"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn config_merge_corpus_records_null_when_pair_files_missing() {
    // 空仓库根:每个对读文件失败 → record=null,不 panic。
    let root = temp_dir("merge-empty");
    let json = dump_config_merge_corpus(&root);
    assert!(json.contains("\"record\":null"), "{json}");
    assert!(json.contains("\"pairCount\":12"));
    let _ = fs::remove_dir_all(&root);
}
