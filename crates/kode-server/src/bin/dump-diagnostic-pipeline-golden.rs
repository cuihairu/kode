//! 诊断调度状态机回放 golden 生成器:权威事件迹 + 四族管线回放产出
//! (traces 与 outcomes 同文件;TS 侧 tests/kodeDiagnosticPipelineParity.test.ts
//! 读 traces 驱动生产 DiagnosticScheduler 逐迹对拍 outcomes)。

fn main() {
    print!(
        "{}",
        kode_server::dump_diagnostic_pipeline_golden()
    );
    println!();
}
