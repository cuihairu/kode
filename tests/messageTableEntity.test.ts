import { afterEach, describe, expect, it } from 'vitest';
import type { KodeCoreGate } from '../src/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import { buildEntityMessageTableShared } from '../src/messageTableEntity';
import { parseLocalDefinition } from '../src/definitionSemantics';
import type { MessageTable } from '../src/messageTable';

// IDE-AUD-060 共享构建面:preview/export 同一 buildEntityMessageTableShared,
// 类型注册表(types.xml)与 alias 配置经 context 注入两条构建路(Rust 核心 /
// TS 兜底),保证「所选根」的 types.xml 自定义别名进注册表,参数不再误报
// unknown-arg-type;缺失 types.xml 按缺省口径如实推进。

const DEF_WITH_MY_INT =
  '<root><BaseMethods><req><Exposed>true</Exposed><Arg>MY_INT</Arg></req></BaseMethods></root>';
const TYPES_XML_MY_INT = '<root><MY_INT>UINT32</MY_INT></root>';

const rawFile = { content: DEF_WITH_MY_INT, filePath: '/defs/entitys/Hero.def' };
const source = {
  loadDefRaw: (_name: string, kind: string) => (kind === 'entity' ? rawFile : null),
  loadDef: (name: string, kind: string) =>
    kind === 'entity' ? parseLocalDefinition(rawFile.content, 'entity', name, rawFile.filePath) : null
};

const cannedTable = (): MessageTable => ({
  module: 'Hero',
  generatedAt: '2026-11-01T00:00:00.000Z',
  aliasIdEnabled: false,
  loadFailed: false,
  fatalCount: 0,
  sources: [{ name: 'Hero', kind: 'own', filePath: rawFile.filePath }],
  methods: [],
  clientMethods: [],
  properties: [],
  clientProperties: [],
  types: [],
  issues: []
});

const contextOf = (typesXml: string | null, alias: boolean) => ({
  readEntityTypesXml: () => typesXml,
  readAliasIdEnabled: () => alias
});

afterEach(() => {
  setKodeCoreShadowGate(null);
});

describe('buildEntityMessageTableShared(消息表共享构建面)', () => {
  it('Rust 核心在场:context 的 typesXml/aliasIdEnabled 注入 RPC 参数', async () => {
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (_method: string, params: unknown) => {
        calledParams = params;
        return { ok: true, result: cannedTable() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);

    const table = await buildEntityMessageTableShared('Hero', source, contextOf(TYPES_XML_MY_INT, true));
    expect(table).not.toBeNull();
    const params = calledParams as { typesXml?: string; aliasIdEnabled: boolean };
    expect(params.typesXml).toBe(TYPES_XML_MY_INT);
    expect(params.aliasIdEnabled).toBe(true);
  });

  it('Rust 不可用/失败:回落 TS 路,types.xml 仍喂入 → MY_INT 不再 unknown-arg-type', async () => {
    const table = await buildEntityMessageTableShared('Hero', source, contextOf(TYPES_XML_MY_INT, false));
    expect(table).not.toBeNull();
    expect(table!.loadFailed).toBe(false);
    expect(table!.issues.filter(issue => issue.kind === 'unknown-arg-type')).toHaveLength(0);
    // MY_INT 别名进入类型表(别名指向 UINT32)
    expect(table!.types.map(type => type.name)).toContain('MY_INT');
  });

  it('types.xml 缺失:TS 路按缺省口径如实报 unknown-arg-type(不静默吞掉)', async () => {
    const table = await buildEntityMessageTableShared('Hero', source, contextOf(null, false));
    expect(table).not.toBeNull();
    expect(table!.loadFailed).toBe(true);
    expect(table!.issues.map(issue => issue.kind)).toContain('unknown-arg-type');
  });

  it('缺自身 def:构建返回 null(与直接构建一致)', async () => {
    const emptySource = { ...source, loadDefRaw: () => null, loadDef: () => null };
    const table = await buildEntityMessageTableShared('Hero', emptySource, contextOf(TYPES_XML_MY_INT, false));
    expect(table).toBeNull();
  });
});
