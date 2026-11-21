// RUST-142 推送消费面(kode-server 四层管线 → TS 主 collection 的接线)。
// 锁三件事:①`$/kode/publishDiagnostics` 按 localSyntax 层 + fsPath 定位 +
// 版本护栏落 collection;②异层/异版本/异层名的通知不触碰 collection;
// ③空 findings 不重入(归并幂等,同步面重置已由 validateDocument 承担)。
// 服务器端发射面由 crates/kode-server/tests/diagnostic_push.rs 独立锁。
import { describe, expect, it } from 'vitest';
import {
  applyRustDiagnosticsPush,
  wireDiagnosticsPush,
  type RustDiagnosticsPushParams
} from '../src/languageProviders/validation';
import { DiagnosticCollection, Uri, makeTextDocument } from './helpers/vscodeStub';

/** gate 通知回调替身:捕获 wireDiagnosticsPush 装配的 handler。 */
function gateStub(): {
  handler: ((notification: { method: string; params?: unknown }) => void) | null;
  setNotificationHandler: (handler: ((n: { method: string; params?: unknown }) => void) | null) => void;
} {
  const stub: {
    handler: ((notification: { method: string; params?: unknown }) => void) | null;
    setNotificationHandler: (handler: ((n: { method: string; params?: unknown }) => void) | null) => void;
  } = {
    handler: null,
    setNotificationHandler: handler => {
      stub.handler = handler;
    }
  };
  return stub;
}

const PHANTOM_FINDINGS = [
  {
    check: 'phantom-type',
    severity: 'error' as const,
    line: 2,
    offset: 30,
    length: 4,
    message: '未定义的引用类型: Ghost'
  }
];

const DEF_TEXT = [
  '<root>',
  '<Properties>',
  '\t<hp>',
  '\t\t<Type>Ghost</Type>',
  '\t\t<Flags>BASE</Flags>',
  '\t</hp>',
  '</Properties>',
  '</root>'
].join('\n');

function doc(version: number, fsPath = '/tmp/workspace/scripts/entity_defs/Hero.def') {
  return makeTextDocument(DEF_TEXT, {
    fileName: fsPath,
    languageId: 'kbengine-def',
    uri: Uri.file(fsPath),
    version
  });
}

describe('RUST-142 推送消费面(wireDiagnosticsPush / applyRustDiagnosticsPush)', () => {
  it('localSyntax 层按 fsPath 定位 + 版本护栏落 collection', () => {
    const gate = gateStub();
    const collection = new DiagnosticCollection();
    const d = doc(3);
    wireDiagnosticsPush(gate, collection, () => [d]);

    expect(typeof gate.handler, 'wire 装配 handler').toBe('function');
    gate.handler!({
      method: '$/kode/publishDiagnostics',
      params: {
        uri: d.uri.fsPath,
        version: 3,
        layer: 'localSyntax',
        findings: PHANTOM_FINDINGS
      } satisfies RustDiagnosticsPushParams
    });

    const published = collection.get(d.uri);
    expect(published.length, '并集一条').toBe(1);
    expect(published[0].message).toBe('未定义的引用类型: Ghost');
  });

  it('版本前进后晚到旧版通知:丢弃(与 pull 腿同护栏)', () => {
    const collection = new DiagnosticCollection();
    const d = doc(3);
    applyRustDiagnosticsPush(
      { uri: d.uri.fsPath, version: 2, layer: 'localSyntax', findings: PHANTOM_FINDINGS },
      collection,
      [d]
    );
    expect(collection.get(d.uri), '版本不符不落').toEqual([]);
  });

  it('异层通知不并入主 collection(三族归各自车道)', () => {
    const collection = new DiagnosticCollection();
    const d = doc(3);
    for (const layer of ['semantic', 'engineCompat', 'runtimeConfig']) {
      applyRustDiagnosticsPush(
        { uri: d.uri.fsPath, version: 3, layer, findings: PHANTOM_FINDINGS },
        collection,
        [d]
      );
    }
    expect(collection.get(d.uri), '异层零触碰').toEqual([]);
  });

  it('文档已关闭(不在场)或 version 非数:零触碰', () => {
    const collection = new DiagnosticCollection();
    const d = doc(3);
    applyRustDiagnosticsPush(
      { uri: '/tmp/elsewhere/Gone.def', version: 3, layer: 'localSyntax', findings: PHANTOM_FINDINGS },
      collection,
      [d]
    );
    applyRustDiagnosticsPush(
      { uri: d.uri.fsPath, version: null, layer: 'localSyntax', findings: PHANTOM_FINDINGS },
      collection,
      [d]
    );
    expect(collection.get(d.uri)).toEqual([]);
  });

  it('空 findings:不重入 set(归并幂等)', () => {
    const collection = new DiagnosticCollection();
    const d = doc(3);
    applyRustDiagnosticsPush(
      { uri: d.uri.fsPath, version: 3, layer: 'localSyntax', findings: [] },
      collection,
      [d]
    );
    expect(collection.get(d.uri)).toEqual([]);
  });

  it('其他方法名通知:不解析(桥面按 method 分叉)', () => {
    const gate = gateStub();
    const collection = new DiagnosticCollection();
    const d = doc(3);
    wireDiagnosticsPush(gate, collection, () => [d]);
    gate.handler!({
      method: '$/other/notification',
      params: { uri: d.uri.fsPath, version: 3, layer: 'localSyntax', findings: PHANTOM_FINDINGS }
    });
    expect(collection.get(d.uri)).toEqual([]);
  });
});
