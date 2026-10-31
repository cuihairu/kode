//! flag→domain 对拍 golden 生成器:输出 kode-parser model.rs 的
//! `normalize_flag_tokens` + `flag_domains` 组合真值表 JSON。
//!
//! golden 由 Rust 产出;TS 侧 `src/generated/flagDomains.ts` 由此派生,
//! `tests/flagDomainsParity.test.ts` 复算对拍(双向门禁:Rust 测试重生成
//! 比对 + vitest 复算,同 hover/completion golden 模式)。

fn main() {
    print!("{}", kode_server::dump_flag_domains_golden());
    println!();
}
