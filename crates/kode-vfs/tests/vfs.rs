//! VFS-013 场景测试:100 次编辑、保存竞态、未保存变更、重命名/删除、根切换。
//! 坐标对拍单独在 coordinates.rs;这里是 store 级别的真实临时目录场景。

use std::fs;
use std::path::PathBuf;

use kode_vfs::{
    CanonicalUri, ContentSource, DocumentKey, DocumentStore, Position, Range, RootId, RootRegistry,
    TextChange, VersionConflict,
};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kode-vfs-scene-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn key(root: RootId, path: &str) -> DocumentKey {
    DocumentKey::new(root, CanonicalUri::from_path(path))
}

/// VFS-013a:100 次连续增量编辑——每次 version 严格递增,
/// 最终文本与朴素逐次拼接一致,且每次编辑后都能立刻取到快照。
#[test]
fn one_hundred_incremental_edits() {
    let mut store = DocumentStore::new();
    let k = key(RootId(1), "/w/stress/Monster.def");
    store.open(k.clone(), 0, String::new()).unwrap();

    let mut expected = String::new();
    for i in 0..100 {
        let insertion = format!("[{i}]👍");
        // 朴素期望:追加到末尾(末尾 = 行 0 character = UTF-16 长度)。
        let char_pos = kode_vfs::utf16_len(&expected) as u32;
        store
            .change(
                &k,
                (i + 1) as i64,
                vec![TextChange::ranged(
                    Range::new(Position::new(0, char_pos), Position::new(0, char_pos)),
                    insertion.clone(),
                )],
            )
            .unwrap();
        expected.push_str(&insertion);
        // 每次编辑后快照立即可见(不丢、不旧)。
        let snap = store.snapshot(&k).unwrap();
        assert_eq!(snap.version, Some((i + 1) as i64));
        assert_eq!(snap.buffer.text(), expected);
    }
    // 旧 version 重放被拒(竞态防线)。
    assert!(matches!(
        store.change(&k, 50, vec![TextChange::full("stale")]),
        Err(VersionConflict::Stale {
            current: 100,
            incoming: 50
        })
    ));
    assert_eq!(store.snapshot(&k).unwrap().buffer.text(), expected);
}

/// VFS-013b:保存竞态——文档打开期间磁盘被外部改写:
/// overlay 必须赢(未保存内容不被覆盖);指纹记录磁盘变化;close 后读到新盘内容。
#[test]
fn save_race_disk_changes_behind_open_overlay() {
    let dir = temp_dir("race");
    let file = dir.join("Monster.def");
    fs::write(&file, "<Entity version=1/>").unwrap();

    let mut registry = RootRegistry::new();
    let root = registry.register(dir.to_str().unwrap());
    let mut store = DocumentStore::new();
    let k = key(root, file.to_str().unwrap());

    // 首次快照来自磁盘。
    let snap = store.snapshot(&k).unwrap();
    assert_eq!(snap.source, ContentSource::Disk);
    assert_eq!(snap.buffer.text(), "<Entity version=1/>");

    // 用户打开并编辑(未保存)。
    store.open(k.clone(), 1, "<Entity version=1/>").unwrap();
    store
        .change(&k, 2, vec![TextChange::full("<Entity version=2/>")])
        .unwrap();

    // 外部(另一个编辑器/git checkout)改写磁盘。
    fs::write(&file, "<Entity external/>").unwrap();

    // overlay 优先:仍是未保存内容。
    let snap = store.snapshot(&k).unwrap();
    assert_eq!(snap.source, ContentSource::OpenOverlay);
    assert_eq!(snap.buffer.text(), "<Entity version=2/>");
    assert_eq!(snap.version, Some(2));

    // close 后回落磁盘真相(指纹变化触发重读)。
    assert!(store.close(&k));
    let snap = store.snapshot(&k).unwrap();
    assert_eq!(snap.source, ContentSource::Disk);
    assert_eq!(snap.buffer.text(), "<Entity external/>");
    fs::remove_dir_all(&dir).unwrap();
}

/// VFS-013c:未保存变更——同一 store 中打开文档与磁盘内容并存可辨。
#[test]
fn unsaved_changes_are_observable_against_disk() {
    let dir = temp_dir("unsaved");
    let file = dir.join("types.xml");
    fs::write(&file, "<root/>").unwrap();

    let mut registry = RootRegistry::new();
    let root = registry.register(dir.to_str().unwrap());
    let mut store = DocumentStore::new();
    let k = key(root, file.to_str().unwrap());

    store.open(k.clone(), 5, "<root edited/>").unwrap();
    let open_snap = store.snapshot(&k).unwrap();
    assert_eq!(open_snap.source, ContentSource::OpenOverlay);
    assert_eq!(open_snap.version, Some(5));

    // 另一个文档未打开 → 磁盘来源。
    let other = key(root, dir.join("entities.xml").to_str().unwrap());
    fs::write(dir.join("entities.xml"), "<entities/>").unwrap();
    let disk_snap = store.snapshot(&other).unwrap();
    assert_eq!(disk_snap.source, ContentSource::Disk);
    assert_eq!(disk_snap.version, None);
    fs::remove_dir_all(&dir).unwrap();
}

/// VFS-013d:重命名/删除——旧身份整体失效,打开状态/内容迁移到新身份;
/// parse cache 同步清理。
#[test]
fn rename_and_remove_invalidate_old_identity() {
    let mut store = DocumentStore::new();
    let old = key(RootId(1), "/w/entities/Monster.def");
    let new = key(RootId(1), "/w/entities/Boss.def");
    store.open(old.clone(), 3, "monster body").unwrap();

    let mut cache: kode_vfs::ParseCache<u32> = kode_vfs::ParseCache::new();
    cache.insert(
        old.clone(),
        kode_vfs::content_fingerprint("monster body"),
        7,
    );

    let removed = store.rename(&old, new.clone()).unwrap();
    assert!(removed.was_open);
    assert_eq!(removed.last_version, Some(3));
    assert!(!store.is_open(&old));
    let (version, buffer) = store.open_buffer(&new).unwrap();
    assert_eq!(version, 3);
    assert_eq!(buffer.text(), "monster body");

    cache.invalidate(&old);
    assert!(cache
        .get(&old, kode_vfs::content_fingerprint("monster body"))
        .is_none());

    // remove:新身份也清掉。
    store.remove(&new);
    assert!(!store.is_open(&new));
}

/// VFS-013e:根切换——同一 canonical URI 在两个根下是两个独立文档;
/// invalidate_root 只清目标根,另一根的打开文档不受牵连。
#[test]
fn root_switch_keeps_documents_isolated() {
    let dir = temp_dir("roots");
    let sub_a = dir.join("projA");
    let sub_b = dir.join("projB");
    fs::create_dir_all(&sub_a).unwrap();
    fs::create_dir_all(&sub_b).unwrap();
    fs::write(sub_a.join("shared.def"), "A body").unwrap();
    fs::write(sub_b.join("shared.def"), "B body").unwrap();

    let mut registry = RootRegistry::new();
    let root_a = registry.register(sub_a.to_str().unwrap());
    let root_b = registry.register(sub_b.to_str().unwrap());
    assert_ne!(root_a, root_b);

    let mut store = DocumentStore::new();
    let path = sub_a.join("shared.def").to_str().unwrap().to_string();
    let rel = path.rsplit_once("/projA/").map(|(_, r)| r).unwrap();
    let ka = key(root_a, &format!("{}/{rel}", sub_a.to_str().unwrap()));
    let kb = key(root_b, &format!("{}/{rel}", sub_b.to_str().unwrap()));
    assert_ne!(ka, kb, "VFS-002:同 URI 异根 = 不同身份");

    store.open(ka.clone(), 1, "A unsaved").unwrap();
    store.open(kb.clone(), 1, "B unsaved").unwrap();

    // 切走根 A:只清 A。
    let removed = store.invalidate_root(root_a);
    assert_eq!(removed, vec![ka.clone()]);
    assert!(!store.is_open(&ka));
    assert!(store.is_open(&kb));
    // B 的内容原样。
    let snap = store.snapshot(&kb).unwrap();
    assert_eq!(snap.buffer.text(), "B unsaved");
    fs::remove_dir_all(&dir).unwrap();
}

/// VFS-009:根注册顺序/最长前缀/冲突列表(集成层再验一次)。
#[test]
fn root_registry_priority_and_conflict_diagnostics() {
    let mut registry = RootRegistry::new();
    let resources = registry.register("/game/res");
    let scripts = registry.register("/game/res/scripts");
    let engine = registry.register("/game/kbengine");
    let uri = CanonicalUri::from_path("/game/res/scripts/entities/Avatar.py");
    assert_eq!(registry.root_for(&uri), scripts);
    let hits = registry.overlapping_roots(&uri);
    assert_eq!(hits, vec![resources, scripts]);
    assert_eq!(
        registry.root_for(&CanonicalUri::from_path("/game/kbengine/x.h")),
        engine
    );
    assert_eq!(
        registry.root_for(&CanonicalUri::from_path("/elsewhere/x.def")),
        RootId::UNROOTED
    );
}
