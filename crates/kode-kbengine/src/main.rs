//! kode-kbengine bin:解析参数 → dispatch;用法错误打 stderr + exit 2。

use kode_kbengine::cli::{parse_args, USAGE};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
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
