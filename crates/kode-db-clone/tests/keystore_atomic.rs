//! KODE-FULL-016:密钥文件创建原子性——并发首建、败者只读、失败不残留。
//!
//! 旧实现 exists()→write→chmod 三步非原子:并发首次导出同一路径时两路都
//! 见「不存在」,各自生成密钥后 fs::write 互相截断覆盖——两路拿到不同的
//! key,而盘上只剩最后写者的;先到者用它根本解不开自己刚写出的归档。
//! 本文件用屏障把竞态窗口拉满锁行为面。探针只比较相等,绝不打印密钥材料。

use std::sync::Arc;

use kode_db_clone::keystore::{FileKeyStore, KeyStore};

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("kode-key-atomic-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn barrier_first_create_converges_on_single_winning_key() {
    let dir = temp_dir("race");
    let store = Arc::new(FileKeyStore::new(&dir));
    // 8 路屏障同点起跑:旧实现下必有多路同时通过 exists() 检查(检查是
    // 一次快速 stat,而首建要 getrandom+建目录+写盘+chmod,窗口极宽)。
    const LANES: usize = 8;
    let barrier = Arc::new(std::sync::Barrier::new(LANES));
    let handles: Vec<_> = (0..LANES)
        .map(|_| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                store.get_or_create("avatar-export").unwrap()
            })
        })
        .collect();
    let keys: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    for key in &keys {
        assert_eq!(key, &keys[0], "并发首建必须收敛到同一获胜密钥");
    }
    // 盘上落的就是获胜密钥:新存储实例重读一致(不存在「文件是 A、内存
    // 返回 B」的分叉)。
    assert_eq!(
        FileKeyStore::new(&dir)
            .get_or_create("avatar-export")
            .unwrap(),
        keys[0]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn loser_leaves_no_temp_files_and_keeps_existing_key_bytes() {
    let dir = temp_dir("loser");
    let store = FileKeyStore::new(&dir);
    let first = store.get_or_create("avatar-export").unwrap();
    let before = std::fs::read(dir.join("avatar-export.key")).unwrap();
    // 第二次必走「已存在」路径:同一把 key、文件字节原样(败者只读不写)。
    assert_eq!(store.get_or_create("avatar-export").unwrap(), first);
    assert_eq!(
        std::fs::read(dir.join("avatar-export.key")).unwrap(),
        before,
        "已存在密钥绝不被覆盖"
    );
    // 任何路径不残留 .tmp 临时件(独占创建+失败即时清理)。
    let leftovers: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "残留临时件: {leftovers:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn concurrent_lanes_share_key_across_ids_and_root_survives_reuse() {
    // 多 id 并发(不同归档目标)+ 同一存储根复用:各 id 独立收敛,互不串钥。
    let dir = temp_dir("multi");
    let store = Arc::new(FileKeyStore::new(&dir));
    let barrier = Arc::new(std::sync::Barrier::new(6));
    let handles: Vec<_> = ["a", "b", "a", "b", "a", "b"]
        .iter()
        .map(|id| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            let id = (*id).to_string();
            std::thread::spawn(move || {
                barrier.wait();
                (id.clone(), store.get_or_create(&id).unwrap())
            })
        })
        .collect();
    let results: Vec<(String, [u8; 32])> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let key_a = results.iter().find(|(id, _)| id == "a").unwrap().1;
    let key_b = results.iter().find(|(id, _)| id == "b").unwrap().1;
    for (id, key) in &results {
        assert_eq!(key, if id == "a" { &key_a } else { &key_b });
    }
    assert_ne!(key_a, key_b, "不同 id 各自独立成钥");
    let _ = std::fs::remove_dir_all(&dir);
}
