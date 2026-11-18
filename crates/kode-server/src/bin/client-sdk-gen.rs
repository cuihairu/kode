//! 客户端实体 SDK 独立生成器(CI/bin 面):不依赖 VS Code 会话,直接从资产根
//! (`scripts/entities.xml` + `scripts/entity_defs/`)生成客户端骨架到输出目录。
//! 生成核心与扩展 `$/kode/sdk/generate` RPC 同一函数,双入口零分叉。
//!
//! 用法:
//! ```text
//! client-sdk-gen --assets-root <dir> --language <python|typescript|csharp>
//!   [--out <dir>]            缺省 <assets-root>/scripts/client_entities
//!   [--namespace <ns>]       C# 命名空间(缺省 KbEngineClient)
//!   [--engine-version <v> --engine-commit <sha>]  头部溯源(须成对给)
//!   [--generated-at <text>]  头部生成时间戳(缺省空)
//! ```
//! CI 例:`cargo build -p kode-server --bin client-sdk-gen --release` 后
//! `./target/release/client-sdk-gen --assets-root assets --language python --out tests/generated`。

use std::path::PathBuf;

use kode_server::client_sdk::{generate_sdk_headless, ClientSdkCliRequest};

const USAGE: &str = "usage: client-sdk-gen --assets-root <dir> --language <python|typescript|csharp> \
[--out <dir>] [--namespace <ns>] [--engine-version <v> --engine-commit <sha>] [--generated-at <text>]";

fn main() {
    if let Err(message) = run() {
        eprintln!("client-sdk-gen: {message}\n{USAGE}");
        std::process::exit(1);
    }
}

fn next_value(args: &[String], index: &mut usize) -> Result<String, String> {
    *index += 1;
    args.get(*index)
        .cloned()
        .ok_or_else(|| format!("参数缺值: {}", args[*index - 1]))
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    let mut assets_root: Option<PathBuf> = None;
    let mut language = String::new();
    let mut out_dir: Option<PathBuf> = None;
    let mut namespace: Option<String> = None;
    let mut engine_version: Option<String> = None;
    let mut engine_commit: Option<String> = None;
    let mut generated_at: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--assets-root" => assets_root = Some(PathBuf::from(next_value(&args, &mut i)?)),
            "--language" => language = next_value(&args, &mut i)?,
            "--out" => out_dir = Some(PathBuf::from(next_value(&args, &mut i)?)),
            "--namespace" => namespace = Some(next_value(&args, &mut i)?),
            "--engine-version" => engine_version = Some(next_value(&args, &mut i)?),
            "--engine-commit" => engine_commit = Some(next_value(&args, &mut i)?),
            "--generated-at" => generated_at = Some(next_value(&args, &mut i)?),
            other => return Err(format!("未知参数: {other}")),
        }
        i += 1;
    }

    let assets_root = assets_root.ok_or("缺少 --assets-root")?;
    if language.is_empty() {
        return Err("缺少 --language".to_string());
    }
    if engine_version.is_some() != engine_commit.is_some() {
        return Err("--engine-version 与 --engine-commit 须成对给出".to_string());
    }
    let out_dir = out_dir.unwrap_or_else(|| assets_root.join("scripts").join("client_entities"));

    let files = generate_sdk_headless(&ClientSdkCliRequest {
        assets_root,
        language: language.clone(),
        namespace,
        engine_version,
        engine_commit,
        generated_at,
    })?;

    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("创建输出目录失败({}): {e}", out_dir.display()))?;
    for file in &files {
        let path = out_dir.join(&file.file_name);
        std::fs::write(&path, &file.content)
            .map_err(|e| format!("写文件失败({}): {e}", path.display()))?;
        println!("{}", path.display());
    }
    println!(
        "{} 个文件已写入 {}({language})",
        files.len(),
        out_dir.display()
    );
    Ok(())
}
