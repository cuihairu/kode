//! 调度面对拍 golden 生成器:重放 10 个调度场景,输出决策面 JSON。
//!
//! golden 文件由 Rust 产出、TS 侧 tests/kodeSchedulerParity.test.ts 用真实
//! IndexScheduler + fake timers 复算对拍(双向门禁:Rust 测试重生成比对 +
//! vitest 复算;ARCH-012:只对决策面,不做性能对比)。

fn main() {
    print!("{}", kode_scheduler::golden::dump_golden());
}
