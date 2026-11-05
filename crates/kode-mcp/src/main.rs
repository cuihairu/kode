//! kode-mcp bin:stdio MCP server(资产根 = 第一个 CLI 参数,缺省当前目录)。

use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let root = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    kode_mcp::run_stdio(root).await
}
