//! 符号索引单元/增量门禁(书 IDX-001..007/013/014/015 基础版,PR-007)。
//!
//! rebuild 计数实测(与 pr-007.md 报告数字对应,`--nocapture` 可复现):
//! 首扫 N 文件 = N rebuild;二扫同内容 = 0 rebuild;单文件改动 = 恰 1 rebuild;
//! 批量 k 文件 = 1 次 generation;删除/根级失效 = 0 rebuild 仅清理。

use kode_index::{DocumentKey, MethodFacet, RootId, SymbolIndex, SymbolKind};
use kode_vfs::uri::CanonicalUri;

fn key(uri_path: &str) -> DocumentKey {
    DocumentKey::new(RootId(1), CanonicalUri::from_path(uri_path))
}

fn def_text(parent: Option<&str>, prop: &str, prop_type: &str, methods: &[&str]) -> String {
    def_text_full(parent, prop, prop_type, None, methods)
}

/// 组件槽可选的 def 构造器。
fn def_text_full(
    parent: Option<&str>,
    prop: &str,
    prop_type: &str,
    component: Option<(&str, &str)>,
    methods: &[&str],
) -> String {
    let mut s = String::from("<root>\n");
    if let Some(p) = parent {
        s.push_str(&format!("  <Parent>{p}</Parent>\n"));
    }
    if let Some((slot, ctype)) = component {
        s.push_str(&format!(
            "  <Components>\n    <{slot}>\n      <Type>{ctype}</Type>\n    </{slot}>\n  </Components>\n"
        ));
    }
    s.push_str(&format!(
        "  <Properties>\n    <{prop}>\n      <Type>{prop_type}</Type>\n      <Flags>BASE</Flags>\n    </{prop}>\n  </Properties>\n"
    ));
    s.push_str("  <BaseMethods>\n");
    for m in methods {
        s.push_str(&format!("    <{m}>\n      <Arg>UINT32</Arg>\n    </{m}>\n"));
    }
    s.push_str("  </BaseMethods>\n</root>\n");
    s
}

/// 六文件工作区(2 def + 1 entities + 1 types + 1 alias + 1 组件 def)。
fn workspace() -> Vec<(DocumentKey, String)> {
    let mut files = vec![
        (
            key("/proj/entities/Avatar.def"),
            def_text_full(None, "hp", "UINT32", Some(("inventory", "Inventory")), &["onRpc", "doAttack"]),
        ),
        (
            key("/proj/entities/Monster.def"),
            def_text(Some("Avatar"), "ferocity", "PARITY_LIST", &["onSpawned"]),
        ),
        (
            key("/proj/components/Inventory.def"),
            def_text(None, "slots", "UINT16", &["add"]),
        ),
        (
            key("/proj/entities.xml"),
            "<root>\n  <Avatar/>\n  <Monster/>\n</root>\n".to_string(),
        ),
        (
            key("/proj/types.xml"),
            // 直接文本 directive(与语料/TS parseTypesXml 同口径;属性式跳过不产符号)。
            "<root>\n  <JSONDATA>UINT32</JSONDATA>\n</root>\n".to_string(),
        ),
        (
            key("/proj/alias.xml"),
            "<root>\n  <PARITY_LIST>\n    <Type>ARRAY</Type>\n    <of>UINT32</of>\n  </PARITY_LIST>\n</root>\n"
                .to_string(),
        ),
    ];
    files.sort_by(|a, b| a.0.uri.as_path().cmp(b.0.uri.as_path()));
    files
}

#[test]
fn full_scan_then_rescan_is_zero_rebuild() {
    let files = workspace();
    let mut index = SymbolIndex::new();
    let receipt = index.update_batch(&files);
    println!(
        "首扫: files={} rebuilds={} added={} generation={}",
        receipt.files, receipt.rebuilds, receipt.added, receipt.generation
    );
    assert_eq!(receipt.rebuilds, 6, "首扫每文件恰好 1 rebuild");
    assert_eq!(
        receipt.added, 15,
        "符号总数(3 def 实体+3 属性+4 方法+1 组件槽+2 注册+1 类型+1 别名)"
    );
    assert_eq!(receipt.generation, 1, "批量提交 = 1 次 generation(IDX-007)");

    // 二扫同内容:零重建(IDX-003/004 指纹命中)。
    let again = index.update_batch(&files);
    println!(
        "二扫: rebuilds={} cache_hits={} generation={}",
        again.rebuilds,
        index.stats.cache_hits,
        index.generation()
    );
    assert_eq!(again.rebuilds, 0, "同内容二扫必须零重建");
    assert_eq!(index.generation(), 1, "零重建不 bump generation");
    assert_eq!(index.symbol_count(), 15);
}

#[test]
fn single_file_edit_rebuilds_exactly_one_file() {
    let files = workspace();
    let mut index = SymbolIndex::new();
    index.update_batch(&files);
    let before = index.lookup("hp");

    // 只改 Avatar.def 一个属性名:仅该文件重登记(IDX-013)。
    let mut changed = files.clone();
    changed.retain(|(k, _)| k.uri.as_path().ends_with("Avatar.def"));
    changed[0].1 = def_text_full(
        None,
        "health",
        "UINT32",
        Some(("inventory", "Inventory")),
        &["onRpc", "doAttack"],
    );
    let report = index.update(changed[0].0.clone(), &changed[0].1);
    println!(
        "单文件改动: rebuilt={} removed={} added={} generation={} 总 rebuilds={}",
        report.rebuilt, report.removed, report.added, report.generation, index.stats.rebuilds
    );
    assert!(report.rebuilt);
    assert_eq!(
        report.removed, 5,
        "Avatar.def 旧符号(实体+组件槽+1 属性+2 方法)"
    );
    assert_eq!(report.added, 5);
    assert_eq!(index.stats.rebuilds, 7, "6 首扫 + 1 单文件改动");
    assert!(index.lookup("hp").is_empty(), "旧名符号必须清出倒排");
    assert_eq!(index.lookup("health").len(), 1);
    assert_eq!(
        index.lookup("onRpc").len(),
        1,
        "其余符号查询不受无关文件改动影响"
    );
    assert_eq!(before.len(), 1);
    assert_eq!(index.generation(), 2);

    // 同内容重复 update:零重建。
    let repeat = index.update(changed[0].0.clone(), &changed[0].1);
    assert!(!repeat.rebuilt);
    assert_eq!(index.stats.rebuilds, 7);
}

#[test]
fn queries_cover_all_kinds_and_prefix_scan() {
    let mut index = SymbolIndex::new();
    index.update_batch(&workspace());

    assert_eq!(
        index.lookup_kind("Avatar", SymbolKind::Entity).len(),
        2,
        "def 实体 + entities.xml 注册"
    );
    assert_eq!(
        index.lookup_kind("hp", SymbolKind::Property)[0]
            .detail
            .as_deref(),
        Some("UINT32")
    );
    let on_rpc = &index.lookup_kind("onRpc", SymbolKind::Method)[0];
    assert_eq!(on_rpc.facet, Some(MethodFacet::Base));
    assert_eq!(on_rpc.detail.as_deref(), Some("UINT32"));
    assert_eq!(
        index.lookup_kind("PARITY_LIST", SymbolKind::Alias)[0]
            .detail
            .as_deref(),
        Some("ARRAY")
    );
    assert_eq!(
        index.lookup_kind("JSONDATA", SymbolKind::Type)[0]
            .detail
            .as_deref(),
        Some("builtin")
    );
    assert_eq!(
        index.lookup_kind("inventory", SymbolKind::Component)[0]
            .detail
            .as_deref(),
        Some("Inventory"),
        "组件槽名 = 标签名,组件类型进 detail"
    );
    assert!(
        index
            .dependents_of("Inventory")
            .iter()
            .any(|k| k.uri.as_path().ends_with("Avatar.def")),
        "组件类型引用进反向依赖(IDX-002)"
    );

    let on_prefix = index.workspace_symbols("on", 0);
    assert!(on_prefix.iter().all(|s| s.name.starts_with("on")));
    assert_eq!(on_prefix.len(), 2, "onRpc(Avatar) + onSpawned(Monster)");
    let limited = index.workspace_symbols("", 5);
    assert_eq!(limited.len(), 5, "limit 生效");
    // 有序范围扫描,不线性扫全表:结果按名升序。
    assert!(on_prefix[0].name <= on_prefix[1].name);
}

#[test]
fn reverse_deps_and_inheritance_chain_with_cycle_termination() {
    let mut index = SymbolIndex::new();
    index.update_batch(&workspace());

    // 反向依赖(IDX-002/006):谁引用了 Avatar(Parent)。
    let dependents = index.dependents_of("Avatar");
    assert!(dependents
        .iter()
        .any(|k| k.uri.as_path().ends_with("Monster.def")));
    // 继承链(SEM-004/IDX-005):Monster → Avatar → 根。
    let (chain, cycle) = index.entity_chain("Monster");
    assert!(cycle.is_none());
    assert_eq!(chain.len(), 2);
    assert_eq!(chain[0].entity, "Monster");
    assert_eq!(chain[0].parent.as_deref(), Some("Avatar"));
    assert_eq!(chain[1].entity, "Avatar");

    // 环:互相 Parent,有限步截断 + 显式诊断,绝不死循环。
    index.update(
        key("/proj/entities/A.def"),
        &def_text(Some("B"), "x", "UINT32", &[]),
    );
    index.update(
        key("/proj/entities/B.def"),
        &def_text(Some("A"), "y", "UINT32", &[]),
    );
    let (chain, cycle) = index.entity_chain("A");
    println!("环链长度={} 有环={}", chain.len(), cycle.is_some());
    assert!(cycle.is_some(), "环必须显式诊断");
    assert!(chain.len() <= 3, "环必须截断");
}

#[test]
fn removal_and_rename_clean_every_lookup_path() {
    let files = workspace();
    let mut index = SymbolIndex::new();
    index.update_batch(&files);
    let avatar_key = key("/proj/entities/Avatar.def");

    let removed = index.remove(&avatar_key);
    println!("删除 Avatar.def: 移除 {removed} 符号");
    assert_eq!(removed, 5);
    assert_eq!(index.symbol_count(), 10);
    assert!(index.lookup("hp").is_empty(), "倒排必须清空");
    assert!(index.lookup("onRpc").is_empty());
    assert!(index.symbols_in_file(&avatar_key).is_empty());
    assert!(
        index.entity_declarations().get("Avatar").is_none(),
        "继承边连带清理(IDX-014)"
    );
    assert_eq!(index.tracked_files(), 5, "解析缓存同步失效");
    // Monster 的 Parent 引用还在(它自己声明),但链在 Avatar 处断(根)。
    let (chain, cycle) = index.entity_chain("Monster");
    assert!(cycle.is_none() && chain.len() == 2 && chain[1].parent.is_none());

    // 改名 = remove(old) + update(new)(IDX-014)。
    index.update_batch(&files);
    let new_key = key("/proj/entities/Player.def");
    index.remove(&avatar_key);
    index.update(new_key, &def_text(None, "hp", "UINT32", &["onRpc"]));
    assert!(index.lookup_kind("Player", SymbolKind::Entity).len() == 1);
    assert!(index.symbols_in_file(&avatar_key).is_empty());
    assert_eq!(
        index.stats.rebuilds, 8,
        "6 首扫 + Avatar 重注册 1 + Player 1;删除不产生 rebuild"
    );
    assert_eq!(index.stats.removals, 2);
}

#[test]
fn root_scoped_invalidation_touches_only_that_root() {
    let files = workspace();
    let mut index = SymbolIndex::new();
    index.update_batch(&files);
    // 第二根放一个文件。
    let other = DocumentKey::new(
        RootId(2),
        CanonicalUri::from_path("/other/entities/Npc.def"),
    );
    index.update(other.clone(), &def_text(None, "level", "UINT32", &[]));
    assert_eq!(index.tracked_files(), 7);

    let removed = index.invalidate_root(RootId(1));
    println!("根级失效 root=1: 移除 {removed} 符号");
    assert_eq!(removed, 15);
    assert!(index.lookup("hp").is_empty());
    assert_eq!(
        index.lookup("level").len(),
        1,
        "其它根不受波及(IDX-015 scoped)"
    );
    assert_eq!(index.tracked_files(), 1);
    assert_eq!(index.symbol_count(), 2, "Npc.def = 实体 + 属性");
}

#[test]
fn non_declaration_files_are_reported_not_indexed() {
    let mut index = SymbolIndex::new();
    let txt = key("/proj/notes.txt");
    let report = index.update(txt.clone(), "hello");
    assert!(!report.rebuilt);
    assert!(report.error.is_some(), "ARCH-004:非声明文件必须显式回报");
    assert_eq!(index.symbol_count(), 0);
    let repeat = index.update(txt, "hello");
    assert!(!repeat.rebuilt, "同输入负缓存,不重复解析");
    assert_eq!(index.stats.rebuilds, 0);
}
