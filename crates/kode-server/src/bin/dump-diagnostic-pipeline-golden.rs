//! Diagnostic scheduler state-machine replay golden generator: authoritative
//! event traces + four-family pipeline replay output (traces and outcomes in
//! one file; the TS side tests/kodeDiagnosticPipelineParity.test.ts reads
//! traces and drives the production DiagnosticScheduler to compare outcomes
//! trace by trace).

fn main() {
    print!("{}", kode_server::dump_diagnostic_pipeline_golden());
    println!();
}
