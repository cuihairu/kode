//! 增量索引 rebuild 计数实测(release;数字进 docs/kode2/pr-007.md)。
//!
//! 场景:合成 200 文件工作区(140 def + 20 entities + 20 types + 20 alias),
//! 首扫 → 全量二扫(同内容)→ 单文件编辑 → 批量改 10 文件 → 删 5 文件。
//! 只看计数,不做跨机性能结论(ARCH-012)。
//!
//! 复现:`cargo run -p kode-index --release --example bench_index -- .`

use kode_index::{DocumentKey, RootId, SymbolIndex};
use kode_vfs::uri::CanonicalUri;

fn key(path: &str) -> DocumentKey {
    key_in(RootId(1), path)
}

/// 多根工作区:声明文件种类由文件名判定(entities.xml/types.xml/alias.xml
/// 是保留名),同根不能重名,故每组 XML 各占一个 root(与 VFS-002 身份模型一致)。
fn key_in(root: RootId, path: &str) -> DocumentKey {
    DocumentKey::new(root, CanonicalUri::from_path(path))
}

fn def_text(entity: &str, prop_count: usize, method_count: usize) -> String {
    let mut s = format!("<root>\n  <Properties>\n");
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
        files.push((key(&format!("/proj/entities/E{i}.def")), def_text("E", 4, 3)));
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
        again.rebuilds, index.stats.cache_hits, index.generation()
    );

    let report = index.update(
        key("/proj/entities/E7.def"),
        &def_text("E", 5, 3), // +1 属性
    );
    println!(
        "单文件编辑: rebuilt={} removed={} added={} 累计 rebuilds={}",
        report.rebuilt, report.removed, report.added, index.stats.rebuilds
    );

    let mut batch = files.clone();
    for (k, text) in batch.iter_mut().skip(0).take(10) {
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
