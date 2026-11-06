//! 配置合并语义单元测试(KODE-CFG-003):逐语义镜像 TS `mergeConfigXml`
//! (`src/serverConfigMerge.ts:164`)与 `mergeSourceComments`(:143)、
//! `sanitizeXmlComment`(serverConfigCommentText.ts:11)。覆盖覆盖规则
//! (叶子取自定义/仅 base/仅 override/双容器递归/容器↔叶子/重复名整表替换)、
//! 注释合并(override 优先+规范化去重)、名字序、深层递归、注释消毒。

use kode_parser::config::{merge_config_xml, parse_config, sanitize_xml_comment, ConfigNode};

fn parse(xml: &str) -> ConfigNode {
    parse_config(xml).expect("应解析出树")
}

/// 合并两个伪根树,取合并结果的唯一顶层元素(测试语料均为单 `<root>` 顶层)。
fn merged_root(base: &str, override_xml: &str) -> ConfigNode {
    let merged = merge_config_xml(&parse(base), &parse(override_xml));
    assert_eq!(merged.children.len(), 1, "应恰一个顶层元素");
    merged.children.into_iter().next().unwrap()
}

// --- sanitizeXmlComment 镜像 ---

#[test]
fn sanitize_collapses_ws_and_trims() {
    assert_eq!(sanitize_xml_comment("  a  b  "), "a b");
    assert_eq!(sanitize_xml_comment("a\t\nb"), "a b");
    assert_eq!(sanitize_xml_comment("   "), "");
    assert_eq!(sanitize_xml_comment(""), "");
}

#[test]
fn sanitize_collapses_dashes() {
    assert_eq!(sanitize_xml_comment("a---b"), "a-b");
    assert_eq!(sanitize_xml_comment("-"), "- ");
    assert_eq!(sanitize_xml_comment("x-"), "x- ");
    assert_eq!(sanitize_xml_comment("x--"), "x- ");
}

#[test]
fn sanitize_keeps_middle_content() {
    assert_eq!(sanitize_xml_comment("  共享 注释  "), "共享 注释");
}

// --- mergeConfigXml 分支 ---

#[test]
fn merge_leaf_override_wins() {
    let root = merged_root("<root><a>1</a></root>", "<root><a>2</a></root>");
    assert_eq!(root.children.len(), 1);
    assert_eq!(root.children[0].name, "a");
    assert_eq!(root.children[0].text, "2");
}

#[test]
fn merge_base_only_kept() {
    let root = merged_root("<root><a>1</a><b>2</b></root>", "<root><a>3</a></root>");
    assert_eq!(root.children.len(), 2);
    assert_eq!(root.children[0].name, "a");
    assert_eq!(root.children[0].text, "3");
    assert_eq!(root.children[1].name, "b");
    assert_eq!(root.children[1].text, "2");
}

#[test]
fn merge_override_only_added() {
    let root = merged_root("<root><a>1</a></root>", "<root><a>2</a><b>3</b></root>");
    assert_eq!(root.children.len(), 2);
    assert_eq!(root.children[0].name, "a");
    assert_eq!(root.children[0].text, "2");
    assert_eq!(root.children[1].name, "b");
    assert_eq!(root.children[1].text, "3");
}

#[test]
fn merge_both_containers_recurse() {
    let root = merged_root(
        "<root><section><x>1</x></section></root>",
        "<root><section><x>2</x><y>3</y></section></root>",
    );
    let section = &root.children[0];
    assert_eq!(section.name, "section");
    assert_eq!(section.children.len(), 2);
    assert_eq!(section.children[0].name, "x");
    assert_eq!(section.children[0].text, "2");
    assert_eq!(section.children[1].name, "y");
    assert_eq!(section.children[1].text, "3");
}

#[test]
fn merge_container_vs_leaf_takes_override_shape() {
    // base 容器,override 叶子 → 叶子形态(override 整名替换)
    let root = merged_root(
        "<root><section><x>1</x></section></root>",
        "<root><section>5</section></root>",
    );
    assert_eq!(root.children[0].name, "section");
    assert_eq!(root.children[0].text, "5");
    assert_eq!(root.children[0].children.len(), 0);
    // base 叶子,override 容器 → 容器形态(override 整名替换)
    let root = merged_root(
        "<root><section>5</section></root>",
        "<root><section><x>2</x></section></root>",
    );
    assert_eq!(root.children[0].text, "");
    assert_eq!(root.children[0].children.len(), 1);
    assert_eq!(root.children[0].children[0].text, "2");
}

#[test]
fn merge_repeat_table_replaced() {
    // base 两个 item,override 一个 → 整表替换为 override
    let root = merged_root(
        "<root><item>1</item><item>2</item></root>",
        "<root><item>3</item></root>",
    );
    assert_eq!(root.children.len(), 1);
    assert_eq!(root.children[0].text, "3");
    // base 一个,override 两个 → 整表替换为 override(不与默认交错)
    let root = merged_root(
        "<root><item>1</item></root>",
        "<root><item>3</item><item>4</item></root>",
    );
    assert_eq!(root.children.len(), 2);
    assert_eq!(root.children[0].text, "3");
    assert_eq!(root.children[1].text, "4");
}

#[test]
fn merge_comments_override_priority_dedup() {
    let root = merged_root(
        "<root><a><!-- shared -->x</a><b><!-- b-only -->1</b></root>",
        "<root><a><!-- shared -->y</a><b>2</b><c><!-- c-lead -->3</c></root>",
    );
    // a:override 优先,同一内容规范化后去重(只留一条原文)
    assert_eq!(root.children[0].name, "a");
    assert_eq!(root.children[0].text, "y");
    assert_eq!(root.children[0].source_comments, vec![" shared "]);
    // b:override 无注释,base 注释保留
    assert_eq!(root.children[1].name, "b");
    assert_eq!(root.children[1].text, "2");
    assert_eq!(root.children[1].source_comments, vec![" b-only "]);
    // c:仅 override 有 → 保留
    assert_eq!(root.children[2].name, "c");
    assert_eq!(root.children[2].source_comments, vec![" c-lead "]);
}

#[test]
fn merge_name_order_base_first_then_override_new() {
    let root = merged_root(
        "<root><b>1</b><a>2</a></root>",
        "<root><a>3</a><c>4</c></root>",
    );
    let names: Vec<&str> = root.children.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["b", "a", "c"]);
    assert_eq!(root.children[1].text, "3");
    assert_eq!(root.children[2].text, "4");
}

#[test]
fn merge_nested_deep_recursion() {
    let root = merged_root(
        "<root><a><b><c>1</c></b></a></root>",
        "<root><a><b><c>2</c><d>3</d></b></a></root>",
    );
    let b = &root.children[0].children[0];
    assert_eq!(b.children.len(), 2);
    assert_eq!(b.children[0].name, "c");
    assert_eq!(b.children[0].text, "2");
    assert_eq!(b.children[1].name, "d");
    assert_eq!(b.children[1].text, "3");
}

#[test]
fn merge_top_level_name_text_from_override() {
    // 伪根名空/文本空,来自 override 侧
    let merged = merge_config_xml(
        &parse("<root><a>1</a></root>"),
        &parse("<root><a>2</a></root>"),
    );
    assert_eq!(merged.name, "");
    assert_eq!(merged.text, "");
}

// --- 合并 golden 重生成比对(Rust 侧真值;TS 侧 configMergeParity.test.ts 复算) ---

#[test]
fn config_merge_golden_matches_regenerated_dump() {
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root");
    let regenerated = kode_parser::json::dump_config_merge_corpus(&repo_root);
    let golden_path = repo_root.join("crates/kode-parser/tests/golden/config-merge-parity.json");
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 缺失: crates/kode-parser/tests/golden/config-merge-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "config-merge golden 与重生成不一致(偏移 {diff_at})。重新生成:\n  cargo run -p kode-parser --bin dump-config-merge-golden -- . > crates/kode-parser/tests/golden/config-merge-parity.json\nRust 侧:…{}",
            &regenerated[diff_at.saturating_sub(120)..(diff_at + 160).min(regenerated.len())]
        );
    }
    assert!(committed.contains("\"pairCount\":"));
    assert!(committed.contains("dump-config-merge-golden"));
}
