// RUST-055 协议 schema 单一真源门禁:Rust 类型 → protocol.schema.json →
// src/generated/protocolTypes.ts 三级链,逐级字节对账。
//
// 锁①(恒跑)版本三源:schema 头 x-kode-protocol-version == TS
//   KODE_PROTOCOL_VERSION(Rust 常量↔TS 常量已有 protocolContract 双源
//   守卫,本锁把 schema 补进第三源);
// 锁②(恒跑)入库 TS 生成件 == 由入库 schema 经 renderProtocolTypes 再生
//   (渲染唯一实现=scripts/protocol-schema-codegen.mjs,脚本/测试共用);
//   schema 改了没跑 pnpm gen:protocol 即红;
// 锁③(cargo 臂,无工具链 skip,同 kodeCoreE2E 口径)入库 schema ==
//   `cargo run -q -p kode-protocol --bin dump-protocol-schema` 再生;
//   Rust DTO 改了没再生 schema 即红;
// 锁④(恒跑)wire 真样例结构校验:tsconfig 不含 tests/,类型级断言无门
//   真咬(vitest 不做类型检查),故以 schema definitions 为运行时校验器,
//   对 initialize 发送方向/fileChanged 帧体/health 响应/信封四面走样例。
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { KODE_PROTOCOL_VERSION } from '../src/backend/kodeCoreClient';

const repoRoot = join(__dirname, '..');
const schemaPath = join(repoRoot, 'crates', 'kode-protocol', 'protocol.schema.json');
const generatedPath = join(repoRoot, 'src', 'generated', 'protocolTypes.ts');

const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
  'x-kode-protocol-version'?: string;
  definitions: Record<string, SchemaNode>;
};
type SchemaNode = Record<string, unknown> & {
  $ref?: string;
  anyOf?: SchemaNode[];
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
};

describe('RUST-055 协议 schema 单一真源', () => {
  it('锁①:schema 头版本 == TS KODE_PROTOCOL_VERSION(第三源入锁)', () => {
    expect(schema['x-kode-protocol-version']).toBe(KODE_PROTOCOL_VERSION);
  });

  it('锁②:入库 TS 生成件 == 由入库 schema 再生(字节级)', async () => {
    const { renderProtocolTypes } = await import('../scripts/protocol-schema-codegen.mjs');
    const rendered = await renderProtocolTypes(schema);
    const committed = readFileSync(generatedPath, 'utf8');
    expect(committed).toBe(rendered);
  }, 60_000);

  it('锁②配套:生成件头部带来源与再生指引(禁手改)', () => {
    const committed = readFileSync(generatedPath, 'utf8');
    expect(committed).toContain('GENERATED FILE — DO NOT EDIT');
    expect(committed).toContain('pnpm gen:protocol');
  });
});

const cargoReady = spawnSync('cargo', ['--version'], { timeout: 30_000 }).status === 0;
(cargoReady ? describe : describe.skip)('RUST-055 锁③(cargo 臂)', () => {
  it('入库 schema == dump-protocol-schema 再生(字节级)', () => {
    const run = spawnSync(
      'cargo',
      ['run', '-q', '-p', 'kode-protocol', '--bin', 'dump-protocol-schema'],
      { cwd: repoRoot, timeout: 300_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }
    );
    expect(run.status, `cargo run 失败: ${run.stderr}`).toBe(0);
    const committed = readFileSync(schemaPath, 'utf8');
    expect(committed).toBe(run.stdout);
  }, 360_000);
});

// 锁④:schema 即校验器(支持 $ref/anyOf/enum/integer/object/array 子集,
// 覆盖 kode-protocol DTO 用到的全部 JSON Schema 形态;无 type=透传任意)。
const validate = (value: unknown, node: SchemaNode, path: string): string[] => {
  if (node.$ref) {
    const name = node.$ref.replace('#/definitions/', '');
    return validate(value, schema.definitions[name], path);
  }
  if (node.anyOf) {
    return node.anyOf.some(alt => validate(value, alt, path).length === 0)
      ? []
      : [`${path}: anyOf 全不匹配`];
  }
  if (node.enum) {
    return node.enum.includes(value) ? [] : [`${path}: 枚举外`];
  }
  switch (node.type) {
    case 'array':
      if (!Array.isArray(value)) { return [`${path}: 期望 array`]; }
      return (value as unknown[]).flatMap((item, i) => validate(item, node.items ?? {}, `${path}[${i}]`));
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [`${path}: 期望 object`];
      }
      const errors: string[] = [];
      for (const key of node.required ?? []) {
        if (!(key in value)) { errors.push(`${path}: 缺必填 ${key}`); }
      }
      for (const [key, sub] of Object.entries(node.properties ?? {})) {
        if (key in value) { errors.push(...validate((value as Record<string, unknown>)[key], sub, `${path}.${key}`)); }
      }
      return errors;
    }
    case 'string':
      return typeof value === 'string' ? [] : [`${path}: 期望 string`];
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) ? [] : [`${path}: 期望 integer`];
    case 'number':
      return typeof value === 'number' ? [] : [`${path}: 期望 number`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}: 期望 boolean`];
    default:
      return [];
  }
};

const expectValid = (value: unknown, typeName: string): void => {
  const errors = validate(value, schema.definitions[typeName], typeName);
  expect(errors, `${typeName} 样例应过 schema 校验`).toEqual([]);
};

describe('RUST-055 锁④:wire 真样例过 schema 校验', () => {
  it('initialize 发送方向(全量+最小)', () => {
    expectValid({
      processId: 1234,
      rootUri: 'file:///workspace/demo',
      workspaceFolders: [{ uri: 'file:///workspace/demo', name: 'demo' }],
      capabilities: { testLiteral: { hoverProvider: true } },
      initializationOptions: { restartGeneration: 3 }
    }, 'InitializeParams');
    expectValid({}, 'InitializeParams');
  });

  it('initialize 响应(与 KodeCoreInitializeResult 同形)', () => {
    expectValid({
      capabilities: {
        textDocumentSync: { openClose: true, change: 1 },
        hoverProvider: true,
        definitionProvider: true,
        completionProvider: { triggerCharacters: ['<', '.'], resolveProvider: true }
      },
      serverInfo: { name: 'kode-server', version: '0.2.0' }
    }, 'InitializeResult');
  });

  it('$/kode/fileChanged 帧体(与 NonPythonChangeEvent 同构;可选字段两态)', () => {
    expectValid({
      fsPath: '/ws/assets/res/types.xml',
      identity: '/ws/assets/res/types.xml',
      kind: 'change',
      version: '1730000000000:9',
      fileName: 'types.xml',
      ext: '.xml',
      sha256: 'a'.repeat(64),
      handledBy: 'rust'
    }, 'FileChangedParams');
    expectValid({
      fsPath: '/ws/assets/scripts/AI.py',
      identity: '/ws/assets/scripts/AI.py',
      kind: 'delete',
      fileName: 'AI.py',
      ext: '.py',
      handledBy: 'python'
    }, 'FileChangedParams');
  });

  it('$/kode/health 响应(kode-protocol 面;resources 两态)', () => {
    const base = {
      status: 'healthy',
      pid: 4242,
      serverVersion: '0.2.0',
      uptimeMs: 9527,
      initialized: true,
      shutdownRequested: false,
      restartGeneration: 2,
      documents: [{ uri: 'file:///ws/entities/Monster.def', version: 3 }]
    };
    expectValid(base, 'HealthReport');
    expectValid({
      ...base,
      resources: {
        rssBytes: 1048576,
        threads: 8,
        diskReadBytes: 2048,
        diskWriteBytes: 4096,
        cpuTimeMs: 250
      }
    }, 'HealthReport');
  });

  it('JSON-RPC 信封:请求/通知/成功/错误四帧(IncomingMessage 含 id 区分)', () => {
    expectValid({ jsonrpc: '2.0', id: 1, method: '$/kode/health' }, 'Request');
    expectValid({ jsonrpc: '2.0', id: 'span-42', method: '$/kode/rpc', params: { method: '$/kode/def/md5', spanId: 's1' } }, 'Request');
    expectValid({ jsonrpc: '2.0', method: '$/kode/fileChanged', params: { fsPath: '/a.def' } }, 'Notification');
    expectValid({ jsonrpc: '2.0', method: 'textDocument/didOpen' }, 'IncomingMessage');
    expectValid({ jsonrpc: '2.0', id: 1, result: { ok: true } }, 'Response');
    expectValid({ jsonrpc: '2.0', id: 'span-42', error: { code: -32601, message: 'method not found' } }, 'Response');
    expectValid({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 'Response');
  });

  it('校验器自身有牙:故意错形必须报错(prove-red 内联)', () => {
    const errors = validate({ pid: 'not-a-number' }, schema.definitions.HealthReport, 'HealthReport');
    expect(errors.join('\n')).toContain('pid');
    const missing = validate({ uri: 'x' }, schema.definitions.TextDocumentItem, 'TextDocumentItem');
    expect(missing.join('\n')).toContain('缺必填');
  });
});
