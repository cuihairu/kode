// RUST-055:协议 schema 单一真源 —— TS 类型生成器(写盘入口)。
//
// 输入 = crates/kode-protocol/protocol.schema.json(由 Rust 侧
// `cargo run -q -p kode-protocol --bin dump-protocol-schema` 导出),
// 输出 = src/generated/protocolTypes.ts(入库,勿手改)。
//
// 三锁链:Rust 类型 → schema → TS 类型;tests/protocolSchema.test.ts
// 逐级字节对账(恒跑臂:TS 从 schema 再生 diff 入库件;cargo 臂:Rust 再生
// schema diff 入库件),任一侧漂移即红。渲染选项的唯一实现见
// protocol-schema-codegen.mjs(本脚本与测试共用)。
//
// 用法:pnpm gen:protocol
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProtocolTypes } from './protocol-schema-codegen.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const schemaPath = join(repoRoot, 'crates', 'kode-protocol', 'protocol.schema.json');
const outPath = join(repoRoot, 'src', 'generated', 'protocolTypes.ts');

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const ts = await renderProtocolTypes(schema);
writeFileSync(outPath, ts);
console.log(`wrote ${outPath} (${ts.length} bytes)`);
