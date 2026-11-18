//! client-sdk-gen CLI 冒烟(COV-007):`CARGO_BIN_EXE_` 真实拉起二进制,
//! 走 main 全链(参数解析 → 校验 → generate_sdk_headless → 落盘报告)。
//! 语料=真实夹具 tests/fixtures/kbengine-demo-assets(与 headless 面同源);
//! 输出一律进临时目录,绝不回写夹具。

use std::path::{Path, PathBuf};
use std::process::Command;

fn demo_assets_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/kbengine-demo-assets")
}

fn run_bin(args: &[&str]) -> (bool, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_client-sdk-gen"))
        .args(args)
        .output()
        .expect("spawn client-sdk-gen");
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kode_cov7_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("tmp dir");
    dir
}

#[test]
fn cli_help_usage_and_arg_errors() {
    // --help 早退:stdout 出用法,exit 0
    let (ok, stdout, _) = run_bin(&["--help"]);
    assert!(ok);
    assert!(stdout.contains("usage: client-sdk-gen"), "{stdout}");

    let root = demo_assets_root();
    let root = root.to_str().expect("utf8 fixture path");
    // 缺 --assets-root
    let (ok, _, err) = run_bin(&["--language", "python"]);
    assert!(!ok);
    assert!(err.contains("缺少 --assets-root"), "{err}");
    assert!(err.contains("usage:"), "错误须附用法: {err}");
    // 缺 --language
    let (ok, _, err) = run_bin(&["--assets-root", root]);
    assert!(!ok);
    assert!(err.contains("缺少 --language"), "{err}");
    // 未知参数
    let (ok, _, err) = run_bin(&["--assets-root", root, "--language", "python", "--bogus"]);
    assert!(!ok);
    assert!(err.contains("未知参数: --bogus"), "{err}");
    // 参数缺值(末尾无值可取)
    let (ok, _, err) = run_bin(&["--assets-root"]);
    assert!(!ok);
    assert!(err.contains("参数缺值: --assets-root"), "{err}");
    // 溯源对不齐:只给 --engine-version
    let (ok, _, err) = run_bin(&[
        "--assets-root",
        root,
        "--language",
        "python",
        "--engine-version",
        "2.5.10",
    ]);
    assert!(!ok);
    assert!(err.contains("须成对给出"), "{err}");
}

#[test]
fn cli_generates_python_skeleton_to_out_dir() {
    let out = tmp_dir("py");
    let (ok, stdout, stderr) = run_bin(&[
        "--assets-root",
        demo_assets_root().to_str().unwrap(),
        "--language",
        "python",
        "--out",
        out.to_str().unwrap(),
        "--engine-version",
        "2.5.10",
        "--engine-commit",
        "55a66552",
        "--generated-at",
        "2026-11-19T00:00:00Z",
    ]);
    assert!(ok, "stderr={stderr}");
    // 报告面:逐文件路径行 + 收尾计数
    assert!(stdout.contains("Avatar.py"), "{stdout}");
    assert!(stdout.contains("个文件已写入"), "{stdout}");
    // 落盘面:骨架 + 溯源头
    let avatar = std::fs::read_to_string(out.join("Avatar.py")).expect("Avatar.py written");
    assert!(avatar.contains("base_call_reqCastSkill"), "{avatar}");
    assert!(avatar.contains("2.5.10"), "溯源须带引擎版本");
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
fn cli_generates_csharp_with_namespace() {
    let out = tmp_dir("cs");
    let (ok, stdout, stderr) = run_bin(&[
        "--assets-root",
        demo_assets_root().to_str().unwrap(),
        "--language",
        "csharp",
        "--namespace",
        "DemoClient",
        "--out",
        out.to_str().unwrap(),
    ]);
    assert!(ok, "stderr={stderr}");
    assert!(stdout.contains("Avatar.cs"), "{stdout}");
    let avatar = std::fs::read_to_string(out.join("Avatar.cs")).expect("Avatar.cs written");
    assert!(avatar.contains("namespace DemoClient"), "{avatar}");
    let _ = std::fs::remove_dir_all(&out);
}

#[test]
fn cli_default_out_dir_and_file_system_errors() {
    // 缺省输出目录:<assets-root>/scripts/client_entities(在夹具副本上跑,
    // 绝不回写仓内夹具)
    let copy = tmp_dir("default");
    let assets = copy.join("assets");
    copy_dir(&demo_assets_root(), &assets);
    let (ok, stdout, stderr) = run_bin(&[
        "--assets-root",
        assets.to_str().unwrap(),
        "--language",
        "python",
    ]);
    assert!(ok, "stderr={stderr}");
    let default_out = assets.join("scripts").join("client_entities");
    assert!(stdout.contains(default_out.to_str().unwrap()), "{stdout}");
    assert!(default_out.join("Avatar.py").is_file(), "缺省目录须落盘");

    // create_dir_all 失败:输出目录落在文件之下
    let block = copy.join("blocker");
    std::fs::write(&block, b"x").expect("blocker file");
    let (ok, _, err) = run_bin(&[
        "--assets-root",
        assets.to_str().unwrap(),
        "--language",
        "python",
        "--out",
        block.join("sub").to_str().unwrap(),
    ]);
    assert!(!ok);
    assert!(err.contains("创建输出目录失败"), "{err}");

    // 写文件失败:目标文件名被同名目录占住
    let out2 = copy.join("out2");
    std::fs::create_dir_all(out2.join("Avatar.py")).expect("dir named as file");
    let (ok, _, err) = run_bin(&[
        "--assets-root",
        assets.to_str().unwrap(),
        "--language",
        "python",
        "--out",
        out2.to_str().unwrap(),
    ]);
    assert!(!ok);
    assert!(err.contains("写文件失败"), "{err}");

    let _ = std::fs::remove_dir_all(&copy);
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).expect("dst dir");
    for entry in std::fs::read_dir(src).expect("read src") {
        let entry = entry.expect("entry");
        let target = dst.join(entry.file_name());
        if entry.file_type().expect("type").is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("copy file");
        }
    }
}
