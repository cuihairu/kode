//! kode-mcp bin:stdio MCP server。
//!
//! 参数:资产根 = 第一个 CLI 参数(缺省当前目录);其余参数 = 额外知识
//! 路径(search_docs 在此+资产根下收 `.md`,游戏配置需求文档等)。

use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let root = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let extra_paths: Vec<PathBuf> = args.map(PathBuf::from).collect();
    kode_mcp::run_stdio(root, extra_paths).await
}
