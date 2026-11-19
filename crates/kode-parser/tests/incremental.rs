//! 增量重构注册表:同文件未变零重建 + 依赖索引(PR-005 要求 / IDX-003 基础)。

use kode_parser::dep::{file_kind_of_uri, key_for, ParseRegistry};
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

#[test]
fn parsed_unit_kinds_cover_all_four_file_kinds() {
    let mut reg = ParseRegistry::new();
    // 四种声明文件都走通注册表,产物 kind 字符串与文件种类一一对应。
    let cases: [(&str, &str, &str); 4] = [
        ("/w/ed/Avatar.def", "<root></root>", "def"),
        (
            "/w/entities.xml",
            "<root><Avatar hasCell=\"true\"/></root>",
            "entities.xml",
        ),
        (
            "/w/ed/types.xml",
            "<root><SKILL> UINT16 </SKILL></root>",
            "types.xml",
        ),
        (
            "/w/ed/alias.xml",
            "<root><A1> UINT16 </A1></root>",
            "alias.xml",
        ),
    ];
    for (uri, text, kind) in cases {
        let k = key(uri);
        let (report, unit) = reg.update(k, text);
        assert!(report.rebuilt, "{uri} 应真实重建");
        assert!(report.error.is_none());
        assert_eq!(unit.as_ref().map(|u| u.kind()), Some(kind), "{uri}");
    }
    assert_eq!(reg.tracked_files(), 4);
}

#[test]
fn reparse_cleans_stale_reverse_entries_and_helpers_work() {
    let mut reg = ParseRegistry::new();
    let avatar = key_for(RootId(2), "/w/scripts/entity_defs/Avatar.def");
    reg.update(
        avatar.clone(),
        "<root><Properties><s><Type> SKILL </Type></s></Properties></root>",
    );
    assert_eq!(reg.dependents_of("SKILL"), vec![avatar.clone()]);
    assert!(reg.refs_of(&avatar).is_some(), "登记过的文件可查引用集");

    // 同 key 换内容(引用从 SKILL 改为 OTHER):旧反向条目被差量清理,
    // 且 SKILL 只被本文件引用 → 反向键整体移除。
    reg.update(
        avatar.clone(),
        "<root><Properties><s><Type> OTHER </Type></s></Properties></root>",
    );
    assert!(reg.dependents_of("SKILL").is_empty());
    assert_eq!(reg.dependents_of("OTHER"), vec![avatar.clone()]);

    // invalidate 清掉新条目;对未登记 key 调用不 panic(前向无记录直通)。
    reg.invalidate(&avatar);
    assert!(reg.dependents_of("OTHER").is_empty());
    assert!(reg.refs_of(&avatar).is_none());
    let never = key("/w/never_seen.def");
    reg.invalidate(&never);
    assert_eq!(reg.tracked_files(), 0);

    // clear:全量重置(缓存/索引/实测计数)。
    reg.clear();
    assert_eq!(reg.stats.update_calls, 0);
    assert_eq!(reg.stats.rebuilds, 0);
}

// ---- CORE-013 基础版:解析层驻留预算 ----

#[test]
fn resident_budget_mirror_and_rebuild_correctness() {
    // 预算 1B:任何产物都超限,插入即驱逐——确定性形态,统计镜像可精钉。
    let mut reg = ParseRegistry::with_resident_budget(1);
    let keys: Vec<_> = (0..30)
        .map(|i| key(&format!("/w/scripts/entity_defs/E{i}.def")))
        .collect();
    for (i, k) in keys.iter().enumerate() {
        let text = format!("<root><p{i}><Type>UINT32</Type></p{i}></root>");
        let (report, unit) = reg.update(k.clone(), &text);
        assert!(report.rebuilt);
        assert!(unit.is_some());
    }
    assert_eq!(reg.stats.evictions, 30, "每条插入都被预算驱逐");
    // 驱逐后同文档再 update 即重建:缓存丢失不丢正确性。
    let (report, unit) = reg.update(keys[7].clone(), "<root><p7><Type>UINT32</Type></p7></root>");
    assert!(report.rebuilt, "被驱逐条目必须重建");
    assert!(unit.is_some());
    assert_eq!(reg.stats.evictions, 31);
}

#[test]
fn unbounded_registry_has_zero_evictions() {
    let mut reg = ParseRegistry::new();
    for i in 0..30 {
        let k = key(&format!("/w/scripts/entity_defs/E{i}.def"));
        reg.update(k, &format!("<root><p{i}><Type>UINT32</Type></p{i}></root>"));
    }
    assert_eq!(reg.stats.evictions, 0, "缺省无界,不得驱逐");
    assert_eq!(reg.stats.rebuilds, 30);
}

// ---- 观测面/负缓存枚举/活跃通知 + 预算权重四产物(COV 批) ----

#[test]
fn resident_budget_bytes_accessor_face() {
    // 有界=Some(透传),缺省无界=None:装配观测面可分辨两种形态。
    assert_eq!(
        ParseRegistry::with_resident_budget(64).resident_budget_bytes(),
        Some(64)
    );
    assert_eq!(ParseRegistry::new().resident_budget_bytes(), None);
}

#[test]
fn negative_entries_enumerates_failed_parses_only() {
    let mut reg = ParseRegistry::new();
    let bad = key("/w/scripts/base/Bad.py");
    reg.update(bad.clone(), "syntax ((( error");
    reg.update(
        key("/w/ed/Avatar.def"),
        "<root><Properties><hp><Type>UINT32</Type></hp></Properties></root>",
    );
    let entries = reg.negative_entries();
    assert_eq!(entries.len(), 1, "只列负缓存条目: {entries:?}");
    assert_eq!(entries[0].0, bad);
    assert!(
        entries[0].1.contains("非 KBEngine 声明文件"),
        "第二元应是失败原因: {:?}",
        entries[0].1
    );
}

#[test]
fn buffer_activity_and_parse_cache_stats_faces() {
    let mut reg = ParseRegistry::with_resident_budget(1 << 20);
    let k = key("/w/ed/Avatar.def");
    reg.update(
        k.clone(),
        "<root><Properties><hp><Type>UINT32</Type></hp></Properties></root>",
    );
    // 缓刑标记:命中键与非命中键都不得 panic(非命中=无副作用)。
    reg.note_buffer_activity(&k);
    reg.note_buffer_activity(&key("/w/ed/Never.def"));
    let stats = reg.parse_cache_stats();
    assert_eq!(stats.budget_bytes, Some(1 << 20));
    assert_eq!(stats.valid, 1);
    assert_eq!(stats.negative, 0);
    assert_eq!(stats.evictions, 0);
    assert!(stats.resident_bytes > 0, "权重面必须计入");

    let mut neg = ParseRegistry::new();
    neg.update(key("/w/scripts/base/Bad.py"), "syntax ((( error");
    let s2 = neg.parse_cache_stats();
    assert_eq!(s2.budget_bytes, None, "无界缓存预算=None");
    assert_eq!(s2.negative, 1);
}

#[test]
fn resident_weight_all_four_unit_kinds_rich_shapes() {
    // 预算必须 Some 才驱动权重函数;四产物各带富形状遍历各自字段臂。
    let mut reg = ParseRegistry::with_resident_budget(u64::MAX);
    // Def:父名/接口/属性全字段(默认值/flags/DetailLevel/DatabaseLength/
    // Identifier/extra)/组件/三方法面/extra 段
    let def_text = "<root>\n<Parent> Base </Parent>\n<Interfaces>\n<interface> I1 </interface>\n</Interfaces>\n<Properties>\n<hp>\n<Type> UINT32 </Type>\n<Default> 100 </Default>\n<Flags> ALL_CLIENTS </Flags>\n<DetailLevel> MEDIUM </DetailLevel>\n<DatabaseLength> 4 </DatabaseLength>\n<Identifier> sm_id </Identifier>\n<CustomExt> x </CustomExt>\n</hp>\n<bag>\n<Type>\nARRAY\n<of> ITEM </of>\n</Type>\n</bag>\n</Properties>\n<Components>\n<inv>\n<Type> Inventory </Type>\n</inv>\n</Components>\n<BaseMethods>\n<req>\n<Exposed> true </Exposed>\n<Arg> UINT32 </Arg>\n</req>\n</BaseMethods>\n<CellMethods>\n<cel>\n<Arg> STRING </Arg>\n</cel>\n</CellMethods>\n<ClientMethods>\n<onX/>\n</ClientMethods>\n<DetailLevels>\n<NEAR>\n<radius> 10 </radius>\n</NEAR>\n</DetailLevels>\n</root>";
    reg.update(key("/w/ed/Rich.def"), def_text);
    // Entities:实体属性面
    reg.update(
        key("/w/entities.xml"),
        "<root>\n<Account hasClient=\"true\"></Account>\n</root>",
    );
    // Types:文本式/ARRAY(element_ref)/FIXED_DICT(implementedBy/field_refs)
    reg.update(
        key("/w/ed/types.xml"),
        "<root>\n<ID> UINT16 </ID>\n<LISTS>\n\tARRAY\n\t<of> ID </of>\n</LISTS>\n<FD>\n\tFIXED_DICT\n\t<Properties>\n\t\t<x>\n\t\t\t<Type>\n\t\t\t\tARRAY\n\t\t\t\t<of> FLOAT </of>\n\t\t\t</Type>\n\t\t</x>\n\t</Properties>\n\t<implementedBy> M.Sym </implementedBy>\n</FD>\n</root>",
    );
    // Alias:文本式 + Type 式 + 纯属性式(attribute_aliases)
    reg.update(
        key("/w/ed/alias.xml"),
        "<root>\n<A1> UINT16 </A1>\n<A2>\n<Type>\nARRAY\n<of> A1 </of>\n</Type>\n</A2>\n<A3 type=\"ARRAY\" of=\"UINT8\"/>\n</root>",
    );
    let stats = reg.parse_cache_stats();
    assert_eq!(stats.valid, 4, "预算 u64::MAX 四条全驻留");
    assert!(stats.resident_bytes > 512, "富形状权重应显著非零");
}
