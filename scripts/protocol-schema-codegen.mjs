// RUST-055:协议 TS 类型渲染唯一实现(脚本与门禁测试共用,选项不双写)。
// generate-protocol-types.mjs(写盘)与 tests/protocolSchema.test.ts
// (字节对账)都走本函数;改选项只改这一处。
import { compile } from 'json-schema-to-typescript';

export async function renderProtocolTypes(schema) {
  if (schema['x-kode-protocol-version'] === undefined) {
    throw new Error('schema 缺 x-kode-protocol-version 头;请用 dump-protocol-schema 再生');
  }
  const banner = [
    '/* eslint-disable */',
    '/**',
    ' * GENERATED FILE — DO NOT EDIT.',
    ' * 源:crates/kode-protocol/protocol.schema.json(kode-protocol wire DTO 单一真源)。',
    ` * 协议版本:${schema['x-kode-protocol-version']}`,
    ' * 再生:pnpm gen:protocol(schema 本身由 cargo run -q -p kode-protocol --bin dump-protocol-schema 再生)。',
    ' * 门禁:tests/protocolSchema.test.ts 三锁对账,漂移即红。',
    ' */'
  ].join('\n');
  return compile(schema, 'KodeProtocol', {
    bannerComment: banner,
    style: { singleQuote: true },
    additionalProperties: false
  });
}
