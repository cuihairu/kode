//! KODE-FULL-016: key-file creation atomicity — concurrent first creation, losers
//! read-only, no residue on failure.
//!
//! The old implementation's exists()→write→chmod three steps were not atomic: when
//! concurrent first-time exports hit the same path, both lanes saw "not present",
//! each generated a key and the fs::write calls truncated overwrote each other —
//! the two lanes held different keys while the disk kept only the last writer's;
//! the earlier lane could not even decrypt the archive it had just written with
//! it. This file uses a barrier to stretch the race window and lock down the
//! behavior face. Probes only compare for equality, never printing key material.

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
    // 8 lanes start simultaneously at the barrier: under the old implementation
    // multiple lanes would necessarily pass the exists() check together (the check
    // is one quick stat, while first creation needs getrandom + mkdir + write +
    // chmod — a very wide window).
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
        assert_eq!(
            key, &keys[0],
            "concurrent first creation must converge on the single winning key"
        );
    }
    // What lands on disk is the winning key: a fresh store instance re-reads it
    // consistently (no "file holds A, memory returns B" divergence).
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
    // The second call must take the "already exists" path: the same key, file bytes
    // untouched (the loser reads, never writes).
    assert_eq!(store.get_or_create("avatar-export").unwrap(), first);
    assert_eq!(
        std::fs::read(dir.join("avatar-export.key")).unwrap(),
        before,
        "an existing key is never overwritten"
    );
    // No path leaves .tmp temp files behind (exclusive creation + immediate cleanup
    // on failure).
    let leftovers: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn concurrent_lanes_share_key_across_ids_and_root_survives_reuse() {
    // Multiple concurrent ids (different archive targets) + the same store root
    // reused: each id converges independently, keys never cross.
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
    assert_ne!(key_a, key_b, "different ids become independent keys");
    let _ = std::fs::remove_dir_all(&dir);
}
