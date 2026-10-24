import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  KodeCoreGate,
  ShadowDiffLog,
  type ShadowClientLike
} from '../src/kodeCoreGate';
import {
  getKodeCoreShadowGate,
  setKodeCoreShadowGate,
  shadowMirrorCorpusDocument
} from '../src/kodeCoreShadowFaces';
import { releaseAllDocumentSnapshots } from '../src/documentStore';
import { validateDocument } from '../src/languageProviders';
import {
  configurationOverrides,
  DiagnosticCollection,
  makeTextDocument,
  Uri
} from './helpers/vscodeStub';

// E-1 验收锁:语料镜像腿与诊断开关解耦。
// 关闭 kbengine.enableDiagnostics 时 validateDocument 提前返回(不再镜像),
// 但语料镜像仍由文档快照更新驱动 —— 诊断开关不影响 Rust 侧语料,definition
// 与注册类型诊断才有同输入。

interface StubCall {
  method: string;
  params?: unknown;
}

/** makeTextDocument 无 version 字段,补挂(同 diagnosticScheduler.test.ts 口径) */
interface VersionedDocument extends ReturnType<typeof makeTextDocument> {
  version: number;
}

function makeStubClient(): ShadowClientLike & { calls: StubCall[] } {
  const calls: StubCall[] = [];
  return {
    calls,
    start: vi.fn(async () => {
      calls.push({ method: 'start' });
      return {};
    }),
    request: vi.fn(async (method: string) => {
      calls.push({ method: `request:${method}` });
      throw new Error(`no stub for ${method}`);
    }),
    dispose: vi.fn(async () => undefined),
    openDocument: vi.fn((uri: string, languageId: string, version: number, text: string) => {
      calls.push({ method: 'openDocument', params: { uri, languageId, version, text } });
    }),
    changeDocument: vi.fn((uri: string, version: number, text: string) => {
      calls.push({ method: 'changeDocument', params: { uri, version, text } });
    }),
    closeDocument: vi.fn((uri: string) => {
      calls.push({ method: 'closeDocument', params: { uri } });
    })
  };
}

function makeVersionedDocument(
  text: string,
  fileName: string,
  version: number,
  languageId: string
): VersionedDocument {
  const document = makeTextDocument(text, {
    fileName,
    languageId,
    uri: Uri.file(fileName)
  }) as VersionedDocument;
  document.version = version;
  return document;
}

const HERO_DEF = ['<root>', '  <Properties>', '    <hp>', '      <Type>PARITY_POINT</Type>', '      <Flags>CELL_PUBLIC</Flags>', '    </hp>', '  </Properties>', '</root>'].join('\n');
// 真实 KBEngine 形态(与 tests/fixtures/parity-project 一致)
const TYPES_XML = ['<root>', '  <PARITY_POINT type="UINT32"/>', '</root>'].join('\n');

afterEach(() => {
  setKodeCoreShadowGate(null);
  configurationOverrides.delete('kbengine');
  releaseAllDocumentSnapshots();
});

describe('E-1 语料镜像与诊断开关解耦', () => {
  it('诊断开关关闭:validateDocument 早退,语料镜像照常同步', async () => {
    const client = makeStubClient();
    const diffLog = new ShadowDiffLog();
    const gate = new KodeCoreGate({ clientFactory: () => client, diffLog });
    gate.setConfig({ backend: 'shadow', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    setKodeCoreShadowGate(gate);

    const hero = makeVersionedDocument(HERO_DEF, '/w/demo/scripts/entity_defs/Avatar.def', 1, 'kbengine-def');
    const types = makeVersionedDocument(TYPES_XML, '/w/demo/scripts/entity_defs/types.xml', 1, 'xml');

    configurationOverrides.set('kbengine', { enableDiagnostics: false });

    // 诊断路径:早退,不镜像不同步、不比对
    validateDocument(hero, new DiagnosticCollection());
    // 镜像路径:与诊断无关,语料照常入库
    shadowMirrorCorpusDocument(hero);
    shadowMirrorCorpusDocument(types);

    await vi.waitFor(() => {
      const opened = client.calls.filter(call => call.method === 'openDocument');
      expect(opened.length).toBe(2);
      expect(opened.map(call => (call.params as { uri: string }).uri)).toEqual([
        '/w/demo/scripts/entity_defs/Avatar.def',
        '/w/demo/scripts/entity_defs/types.xml'
      ]);
    });
    expect(diffLog.summary().total).toBe(0);
  });

  it('诊断开关打开:两腿同账本,validateDocument 的重入镜像不重复 didOpen', async () => {
    const client = makeStubClient();
    const diffLog = new ShadowDiffLog();
    const gate = new KodeCoreGate({ clientFactory: () => client, diffLog });
    gate.setConfig({ backend: 'shadow', serverPath: 'node:stub', shadowTimeoutMs: 500 });
    setKodeCoreShadowGate(gate);

    const hero = makeVersionedDocument(HERO_DEF, '/w/demo/scripts/entity_defs/Avatar.def', 1, 'kbengine-def');
    shadowMirrorCorpusDocument(hero);
    validateDocument(hero, new DiagnosticCollection());

    await vi.waitFor(() => {
      expect(client.calls.filter(call => call.method === 'openDocument').length).toBe(1);
    });
    expect(client.calls.some(call => call.method === 'closeDocument')).toBe(false);
    expect(getKodeCoreShadowGate()).toBe(gate);
  });
});
