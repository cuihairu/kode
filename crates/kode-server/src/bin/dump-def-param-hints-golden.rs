//! defParamInlayHints 决策核 golden 生成器:合成语料+权威探测面+生产产出
//! 同文件(TS 侧 tests/kodeDefParamHintsParity.test.ts 读 corpus+probes 驱动
//! 生产函数复算对拍 outcomes)。

fn main() {
    print!("{}", kode_server::dump_def_param_hints_golden());
    println!();
}
