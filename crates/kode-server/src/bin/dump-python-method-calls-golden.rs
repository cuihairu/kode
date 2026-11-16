//! python 方法调用层次决策核 golden 生成器:合成语料+探测面+生产产出
//! 同文件(TS 侧 tests/kodePythonMethodCallsParity.test.ts 读 corpus+
//! probes 驱动生产函数复算对拍 outcomes)。

fn main() {
    print!("{}", kode_server::python_method_calls::dump_python_method_calls_golden());
    println!();
}
