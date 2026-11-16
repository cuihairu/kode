//! CodeAction 决策核 golden 生成器:合成语料+权威探测面+生产产出同文件
//! (TS 侧 tests/kodeCodeActionParity.test.ts 读 corpus+probes 驱动生产
//! 函数复算对拍 outcomes)。

fn main() {
    print!("{}", kode_server::dump_code_action_golden());
    println!();
}
