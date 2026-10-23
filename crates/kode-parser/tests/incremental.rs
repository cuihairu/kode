//! 增量重构注册表:同文件未变零重建 + 依赖索引(PR-005 要求 / IDX-003 基础)。

use kode_parser::dep::{file_kind_of_uri, ParseRegistry};
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

fn key(uri: &str) -> DocumentKey {
    DocumentKey::new(RootId(1), CanonicalUri::from_path(uri))
}

#[test]
fn same_content_rebuilds_exactly_once() {
    let mut reg = ParseRegistry::new();
    let k = key("/w/scripts/entity_defs/Avatar.def");
    let text = "<root><Properties><hp><Type> UINT32 </Type></hp></Properties></root>";
    for i in 0..100 {
        let (report, unit) = reg.update(k.clone(), text);
        assert_eq!(report.rebuilt, i == 0, "第 {i} 次同内容更新不得重建");
        assert!(report.error.is_none());
        assert!(unit.is_some());
    }
    assert_eq!(reg.stats.update_calls, 100);
    assert_eq!(reg.stats.rebuilds, 1);
    assert_eq!(reg.stats.cache_hits, 99);
    assert_eq!(reg.tracked_files(), 1);
}

#[test]
fn content_change_invalidates_and_rebuilds() {
    let mut reg = ParseRegistry::new();
    let k = key("/w/scripts/entity_defs/Avatar.def");
    reg.update(k.clone(), "<root></root>");
    let (report, _) = reg.update(k.clone(), "<root><Properties/></root>");
    assert!(report.rebuilt);
    assert_eq!(reg.stats.rebuilds, 2);
    // 改回旧内容:VFS-011 只保留最新有效快照,A→B→A 属重建(不是缓存命中),
    // 解析器层零成本的是「未变的文件」。
    let (report2, _) = reg.update(k.clone(), "<root></root>");
    assert!(report2.rebuilt);
    assert_eq!(reg.stats.rebuilds, 3);
}

#[test]
fn dependency_index_reverse_lookup_and_invalidation() {
    let mut reg = ParseRegistry::new();
    let types = key("/w/scripts/entity_defs/types.xml");
    let avatar = key("/w/scripts/entity_defs/Avatar.def");
    let monster = key("/w/scripts/entity_defs/Monster.def");
    reg.update(
        types.clone(),
        "<root><SKILL> UINT16 </SKILL><LIST><Type>ARRAY<of>SKILL</of></Type>ARRAY</Type></LIST></root>",
    );
    reg.update(
        avatar.clone(),
        "<root><Properties><s><Type>\nARRAY\n<of> SKILL </of>\n</Type></s></Properties></root>",
    );
    reg.update(monster.clone(), "<root><Parent> Avatar </Parent></root>");
    // 反向:谁引用 SKILL → Avatar.def;types.xml 是定义方不是引用方
    let deps = reg.dependents_of("SKILL");
    assert!(deps.contains(&avatar), "{deps:?}");
    assert!(!deps.contains(&types));
    // Parent 依赖
    assert_eq!(reg.dependents_of("Avatar"), vec![monster.clone()]);
    // entities.xml 注册实体 → def 定向
    let entities = key("/w/scripts/entities.xml");
    reg.update(entities.clone(), "<root><Avatar hasCell=\"true\"/></root>");
    assert!(reg.dependents_of("Avatar").contains(&entities));
    // 删除失效:反向索引同步清理
    reg.invalidate(&avatar);
    assert!(!reg.dependents_of("SKILL").contains(&avatar));
    assert_eq!(reg.tracked_files(), 3);
}

#[test]
fn negative_cache_for_untracked_kinds() {
    let mut reg = ParseRegistry::new();
    let py = key("/w/scripts/base/Avatar.py");
    let (report, unit) = reg.update(py.clone(), "print('hi')");
    assert!(!report.rebuilt && unit.is_none());
    assert!(report.error.is_some());
    assert_eq!(reg.stats.failures, 1);
    // 同内容第二次:负缓存命中,不再解析
    let (report2, _) = reg.update(py.clone(), "print('hi')");
    assert!(!report2.rebuilt);
    assert_eq!(reg.stats.negative_hits, 1);
}

#[test]
fn file_kind_by_uri() {
    let fk = |p: &str| file_kind_of_uri(&CanonicalUri::from_path(p));
    assert_eq!(fk("/w/a.def"), kode_parser::dep::FileKind::Def);
    assert_eq!(fk("/w/entities.xml"), kode_parser::dep::FileKind::Entities);
    assert_eq!(
        fk("/w/entity_defs/types.xml"),
        kode_parser::dep::FileKind::Types
    );
    assert_eq!(
        fk("/w/entity_defs/alias.xml"),
        kode_parser::dep::FileKind::Alias
    );
    assert_eq!(fk("/w/other.xml"), kode_parser::dep::FileKind::Other);
}
