//! 配置域解析单元测试(KODE-CFG-002):逐语义对齐 TS `parseConfigXml`
//! (`src/serverConfigMerge.ts:62`)。覆盖注释归属(行内尾随/前导/段尾/文件尾)、
//! PI/声明丢弃、自闭合、容错(未闭合/多余闭合/未知标签)、文本空格 join、
//! 伪根/纯注释返回 None、任意输入不 panic(本 crate 铁律)。

use kode_parser::config::parse_config;
use kode_parser::config::ConfigNode;

/// 便捷:取伪根(名字为空)的唯一顶层元素。
fn root_of(xml: &str) -> ConfigNode {
    let tree = parse_config(xml).expect("应解析出树");
    assert_eq!(tree.name, "", "伪根名字应为空");
    assert_eq!(tree.children.len(), 1, "应恰有一个顶层元素");
    tree.children.into_iter().next().unwrap()
}

#[test]
fn basic_tree_name_text_children() {
    let root = root_of("<root><name>kbengine</name><port>20013</port></root>");
    assert_eq!(root.name, "root");
    assert_eq!(root.text, "");
    assert_eq!(root.children.len(), 2);
    assert_eq!(root.children[0].name, "name");
    assert_eq!(root.children[0].text, "kbengine");
    assert_eq!(root.children[1].name, "port");
    assert_eq!(root.children[1].text, "20013");
}

#[test]
fn text_space_joined() {
    // takeText 只 trim 首尾空白,内部空白保留(不折叠)
    let root = root_of("<a>hello   world</a>");
    assert_eq!(root.text, "hello   world");
    // 子元素前后文本分块,块间以单空格 join;子元素文本归子元素
    let root = root_of("<a>hello<b>B</b>world</a>");
    assert_eq!(root.text, "hello world");
    assert_eq!(root.children.len(), 1);
    assert_eq!(root.children[0].name, "b");
    assert_eq!(root.children[0].text, "B");
}

#[test]
fn attributes_ignored_self_closing() {
    let root = root_of("<root flag=\"x\"><item id=\"1\"/><empty /></root>");
    assert_eq!(root.children.len(), 2);
    assert_eq!(root.children[0].name, "item");
    assert_eq!(root.children[0].children.len(), 0, "自闭合无子");
    assert_eq!(root.children[1].name, "empty");
    // 自闭合不推栈:后续文本归容器而非子元素
    let root = root_of("<root><a/>tail</root>");
    assert_eq!(root.text, "tail");
}

#[test]
fn inline_comment_attaches_last_closed() {
    // 同一行紧随闭合标签 → 挂该元素
    let root = root_of("<root><a>1</a><!-- inline --></root>");
    assert_eq!(root.children[0].source_comments, vec![" inline "]);
    // 跨行 → 不挂闭合元素,走 pending
    let root = root_of("<root><a>1</a>\n<!-- nextline --></root>");
    assert_eq!(root.children[0].source_comments, Vec::<String>::new());
}

#[test]
fn pending_lead_attaches_next_open() {
    let root = root_of("<root><!-- lead --><a>x</a></root>");
    assert_eq!(root.children[0].source_comments, vec![" lead "]);
}

#[test]
fn pending_attaches_container_on_close() {
    // 元素内部、闭合前的游离注释 → 挂回该容器
    let root = root_of("<a>\n<!-- inner -->\n</a>");
    assert_eq!(root.source_comments, vec![" inner "]);
}

#[test]
fn comment_after_self_closing_attaches_next() {
    // 自闭合后同行注释:lastClosed 已清空 → pending → 挂下一个打开元素
    let root = root_of("<root><a/><!-- x --><b/></root>");
    assert_eq!(root.children[0].source_comments, Vec::<String>::new());
    assert_eq!(root.children[1].source_comments, vec![" x "]);
}

#[test]
fn pi_declaration_dropped() {
    let root = root_of("<?xml version=\"1.0\"?><root><?custom?><a>1</a></root>");
    assert_eq!(root.name, "root");
    assert_eq!(root.children.len(), 1);
}

#[test]
fn comment_body_raw_not_trimmed() {
    let root = root_of("<root><!--   spaced   --><a>1</a></root>");
    // 前导注释挂紧随元素,体保持原样(不 trim)
    assert_eq!(root.children[0].source_comments, vec!["   spaced   "]);
}

#[test]
fn malformed_unclosed_tag_dropped() {
    // 无 `>` 的 `<a` 不算 token(懒扫描推进):其文本随循环结束丢弃
    // (takeText 只在 token 之间运行)——与 TS 同路径,不崩
    let tree = parse_config("<root><a").expect("root 已闭合,应返回树");
    let root = &tree.children[0];
    assert_eq!(root.name, "root");
    assert_eq!(root.text, "");
    assert_eq!(root.children.len(), 0);
    // 整串无 `>` → 无 token → None
    assert!(parse_config("<a").is_none());
}

#[test]
fn malformed_extra_close_ignored() {
    let root = root_of("<root><a>1</a></c></root>");
    assert_eq!(root.children.len(), 1);
    assert_eq!(root.children[0].name, "a");
    // 根上闭合被忽略,不 panic
    let _ = parse_config("<root></root></root>");
}

#[test]
fn malformed_mismatched_close_ignored() {
    // 名字不匹配的闭合:不弹栈、不 panic
    let root = root_of("<root><a>1</b></a></root>");
    assert_eq!(root.children.len(), 1);
    assert_eq!(root.children[0].name, "a");
}

#[test]
fn comments_only_returns_none() {
    assert!(parse_config("<!-- only -->").is_none());
    assert!(parse_config("<!-- a --><!-- b -->").is_none());
}

#[test]
fn empty_returns_none() {
    assert!(parse_config("").is_none());
    assert!(parse_config("   \n\t  ").is_none());
}

#[test]
fn text_before_first_element_skipped_for_root() {
    let root = root_of("text<!-- x --><a>1</a>");
    // 伪根 text 不累积;前导注释走 pending 挂紧随元素 a
    assert_eq!(root.source_comments, vec![" x "]);
    assert_eq!(root.text, "1");
}

#[test]
fn file_tail_comment_attaches_nearest_container() {
    // 栈未空 → 挂栈顶;栈空 → 挂段首容器元素
    let root = root_of("<root><a>1</a>\n<!-- tail --></root>");
    assert_eq!(root.source_comments, vec![" tail "]);
    // 栈空(顶层已闭合)后文件尾注释 → 挂顶层元素
    let root = root_of("<root>\n<!-- tail2 -->");
    assert_eq!(root.source_comments, vec![" tail2 "]);
}

#[test]
fn unknown_tags_attrs_duplicates_tolerated() {
    let root = root_of("<root><unknown a=\"1\">u</unknown><item>x</item><item>y</item></root>");
    assert_eq!(root.children.len(), 3);
    assert_eq!(root.children[2].text, "y");
}

#[test]
fn nested_deep() {
    let root = root_of("<a><b><c><d>deep</d></c></b></a>");
    assert_eq!(root.children[0].children[0].children[0].text, "deep");
}

#[test]
fn no_panic_on_arbitrary_inputs() {
    // 盲测:任何输入不 panic(本 crate 铁律)
    for input in [
        "<",
        ">",
        "</",
        "<>",
        "<a",
        "<a>",
        "</a>",
        "<a/>",
        "<a></a",
        "<!--",
        "<!-->",
        "<!-- -->",
        "<?",
        "<?xml",
        "<a><b>",
        "<a></b></a>",
        "\u{0}<a>\u{1}</a>",
        "a".repeat(10_000).as_str(),
    ] {
        let _ = parse_config(input);
    }
}

// --- golden 重生成比对(Rust 侧真值;TS 侧 tests/configParity.test.ts 复算) ---

#[test]
fn config_golden_matches_regenerated_dump() {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root");
    let regenerated = kode_parser::json::dump_config_corpus(&repo_root);
    let golden_path = repo_root.join("crates/kode-parser/tests/golden/config-parity.json");
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 缺失: crates/kode-parser/tests/golden/config-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "config golden 与重生成不一致(偏移 {diff_at})。重新生成:\n  cargo run -p kode-parser --bin dump-config-golden -- . > crates/kode-parser/tests/golden/config-parity.json\nRust 侧:…{}",
            &regenerated[diff_at.saturating_sub(120)..(diff_at + 160).min(regenerated.len())]
        );
    }
    assert!(committed.contains("\"fileCount\":"));
    assert!(committed.contains("dump-config-golden"));
}
