//! kode-mcp bin:stdio MCP server。
//!
//! 参数:[--probe] [资产根](缺省当前目录);其余参数 = 额外知识
//! 路径(search_docs 在此+资产根下收 `.md`,游戏配置需求文档等)。
//! `--probe`:探活模式(跳过语料装载,只服务握手面;扩展健康探针用)。

use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut probe = false;
    let mut positional: Vec<PathBuf> = Vec::new();
    for arg in std::env::args().skip(1) {
        if arg == "--probe" {
            probe = true;
        } else {
            positional.push(PathBuf::from(arg));
        }
    }
    let mut positional = positional.into_iter();
    let root = positional.next().unwrap_or_else(|| PathBuf::from("."));
    let extra_paths: Vec<PathBuf> = positional.collect();
    if probe {
        kode_mcp::run_stdio_probe(root, extra_paths).await
    } else {
        kode_mcp::run_stdio(root, extra_paths).await
    }
}
