//! python method-call hierarchy decision-core golden generator: synthetic
//! corpus + probe surface + production output in one file (the TS side
//! tests/kodePythonMethodCallsParity.test.ts reads corpus+probes and drives
//! the production function to recompute and compare outcomes).

fn main() {
    print!(
        "{}",
        kode_server::python_method_calls::dump_python_method_calls_golden()
    );
    println!();
}
