//! Measured rebuild counts of the incremental index (release; the numbers go into
//! docs/kode2/pr-007.md).
//!
//! Scenario: a synthetic 200-file workspace (140 def + 20 entities + 20 types +
//! 20 alias), first scan -> full second scan (same content) -> single-file edit ->
//! batch change of 10 files -> delete 5 files.
//! Counters only; no cross-machine performance conclusions are drawn (ARCH-012).
//!
//! Reproduce: `cargo run -p kode-index --release --example bench_index -- .`

use kode_index::{DocumentKey, RootId, SymbolIndex};
use kode_vfs::uri::CanonicalUri;

fn key(path: &str) -> DocumentKey {
    key_in(RootId(1), path)
}

/// Multi-root workspace: the declaration file kind is decided by file name (entities.xml /
/// types.xml / alias.xml are reserved names), and names must be unique within a root, so
/// each XML group gets its own root (consistent with the VFS-002 identity model).
fn key_in(root: RootId, path: &str) -> DocumentKey {
    DocumentKey::new(root, CanonicalUri::from_path(path))
}

fn def_text(entity: &str, prop_count: usize, method_count: usize) -> String {
    let mut s = String::from("<root>\n  <Properties>\n");
    for i in 0..prop_count {
        s.push_str(&format!(
            "    <prop{i}>\n      <Type>UINT32</Type>\n      <Flags>BASE</Flags>\n    </prop{i}>\n"
        ));
    }
    s.push_str("  </Properties>\n  <BaseMethods>\n");
    for i in 0..method_count {
        s.push_str(&format!(
            "    <m{i}>\n      <Arg>UINT32</Arg>\n    </m{i}>\n"
        ));
    }
    s.push_str("  </BaseMethods>\n</root>\n");
    let _ = entity;
    s
}

fn main() {
    let mut index = SymbolIndex::new();
    let mut files: Vec<(DocumentKey, String)> = Vec::new();
    for i in 0..140 {
        files.push((
            key(&format!("/proj/entities/E{i}.def")),
            def_text("E", 4, 3),
        ));
    }
    for i in 0..20 {
        files.push((
            key_in(RootId(100 + i as u32), "/proj/entities.xml"),
            format!("<root>\n  <E{i}/>\n  <E{}/>\n</root>\n", i + 100),
        ));
    }
    for i in 0..20 {
        files.push((
            key_in(RootId(200 + i as u32), "/proj/types.xml"),
            format!("<root>\n  <T{i}>UINT32</T{i}>\n</root>\n"),
        ));
    }
    for i in 0..20 {
        files.push((
            key_in(RootId(300 + i as u32), "/proj/alias.xml"),
            format!("<root>\n  <A{i}>\n    <Type>ARRAY</Type>\n    <of>UINT32</of>\n  </A{i}>\n</root>\n"),
        ));
    }
    println!("files={}", files.len());

    let receipt = index.update_batch(&files);
    println!(
        "首扫: rebuilds={} added={} generation={}",
        receipt.rebuilds, receipt.added, receipt.generation
    );

    let again = index.update_batch(&files);
    println!(
        "全量二扫(同内容): rebuilds={} cache_hits={} generation={}",
        again.rebuilds,
        index.stats.cache_hits,
        index.generation()
    );

    let report = index.update(
        key("/proj/entities/E7.def"),
        &def_text("E", 5, 3), // +1 property
    );
    println!(
        "单文件编辑: rebuilt={} removed={} added={} 累计 rebuilds={}",
        report.rebuilt, report.removed, report.added, index.stats.rebuilds
    );

    let mut batch = files.clone();
    for (k, text) in batch.iter_mut().take(10) {
        if k.uri.as_path().ends_with(".def") {
            *text = def_text("E", 6, 3);
        }
    }
    let receipt = index.update_batch(&batch);
    println!(
        "批量 200 文件提交(其中 10 def 内容变化): rebuilds={} generation={}",
        receipt.rebuilds, receipt.generation
    );

    let mut removed_symbols = 0usize;
    for i in 0..5 {
        removed_symbols += index.remove(&key(&format!("/proj/entities/E{i}.def")));
    }
    println!(
        "删除 5 def: 移除符号={removed_symbols} removals={} rebuilds={}",
        index.stats.removals, index.stats.rebuilds
    );
}
