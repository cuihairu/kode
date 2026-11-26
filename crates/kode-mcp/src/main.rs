//! kode-mcp bin: stdio MCP server.
//!
//! Arguments: [--probe] [asset root] (defaults to the current directory);
//! remaining arguments = extra knowledge paths (search_docs collects `.md`
//! files here plus under the asset root, e.g. game configuration specs).
//! `--probe`: liveness mode (skips corpus loading, serves the handshake face
//! only; used by the extension health probe).

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
