//! kode-kbengine bin: parse arguments -> dispatch; usage errors go to stderr + exit 2.

use kode_kbengine::cli::{parse_args, USAGE};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // --version takes precedence over subcommands (PA-007 version-detection counterpart contract:
    // the extension checks CLI availability and version, one line of output `kode-kbengine <semver>`,
    // exit 0).
    if args.iter().any(|a| a == "--version") {
        println!("kode-kbengine {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let parsed = parse_args(&args);
    if let Some(msg) = parsed.usage_error {
        eprintln!("error: {msg}\n\n{USAGE}");
        std::process::exit(2);
    }
    match kode_kbengine::commands::dispatch(parsed.command) {
        Ok(outcome) => {
            if !outcome.stdout.is_empty() {
                println!("{}", outcome.stdout);
            }
            std::process::exit(outcome.code);
        }
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
