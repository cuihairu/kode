//! CodeAction 装配 golden 生成器(RUST-143 批 2):四族合成案例装配
//! 快照(闸/相交/去重/序),TS 侧 tests/kodeCodeActionAssemblyParity
//! .test.ts 驱动生产 provider 对拍(双向门禁)。

fn main() {
    print!("{}", kode_server::dump_code_action_assembly_golden());
    println!();
}
