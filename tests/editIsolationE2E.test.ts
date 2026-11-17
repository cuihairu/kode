import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { KodeCoreClient } from '../src/backend/kodeCoreClient';
import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import {
  serveDiagnosticsFromRust,
  serveHoverFromRust,
  setKodeCoreShadowGate
} from '../src/backend/kodeCoreShadowFaces';
import { KBEngineHoverProvider } from '../src/languageProviders/hover';
import { Position, makeTextDocument } from './helpers/vscodeStub';

// QA-003(旧 KSEM-QA-03)编辑与跨工程隔离:未保存修改、连续输入、同名跨根、
// 关闭重开、重命名均不出过期结果 —— 真实二进制镜像差分语义下的五场景+破档
// 修复场景+门未装配降级臂。钉值全部探针实测(2026-11-18)。rootB fixture
// (Default 777)是同名跨根臂的对照环境:rust 服务器单 assetsRoot 环境语义
// 下,第二个 root 的 def 不入环境 → hover 诚实 NULL 回落 TS,且 rootA 环境
// 不被同名文件串值 —— 这正是「不出过期结果」的隔离面。二进制缺失时跳过
// (与 kodeCoreServingE2E 同口径)。

const repoRoot = join(__dirname, '..');
const serverBinary = join(repoRoot, 'target', 'debug', 'kode-server');
const DEFA = join(repoRoot, 'tests', 'fixtures', 'kbengine-demo-assets', 'scripts', 'entity_defs', 'Avatar.def');
const DEFB = join(repoRoot, 'tests', 'fixtures', 'editIsolation-rootB', 'scripts', 'entity_defs', 'Avatar.def');

const suite = existsSync(serverBinary) ? describe : describe.skip;

const defDoc = (uri: string, text: string, version = 1) =>
  makeTextDocument(text, { fileName: uri, languageId: 'kbengine-def', version });

const hpPos = (text: string): { line: number; character: number } => {
  const lines = text.split('\n');
  const i = lines.findIndex(l => /\bhp\b/.test(l) && !/<Type>|<Flags>|<Default>|<Persistent>/.test(l));
  expect(i, 'def 应含 hp 属性词').toBeGreaterThanOrEqual(0);
  return { line: i, character: lines[i].indexOf('hp') + 1 };
};

const withDefault = (text: string, value: number): string =>
  text.replace(/<Default> \d+ <\/Default>/, `<Default> ${value} </Default>`);

const defaultOf = (hover: string): string | null => {
  const m = /\*\*Default\*\*: `(-?\d+)`/.exec(hover);
  return m === null ? null : m[1];
};

function realGate(): { gate: KodeCoreGate; client: KodeCoreClient } {
  const client = new KodeCoreClient({ binaryPath: serverBinary });
  const gate = new KodeCoreGate({ clientFactory: () => client });
  gate.setConfig({ backend: 'rust', serverPath: serverBinary, shadowTimeoutMs: 15000 });
  return { gate, client };
}

const gates: KodeCoreGate[] = [];
afterEach(() => {
  setKodeCoreShadowGate(null);
});
afterAll(async () => {
  await Promise.all(gates.splice(0).map(gate => gate.dispose().catch(() => undefined)));
});

suite('kode 编辑与跨工程隔离 e2e(真实二进制):五场景不出过期结果(QA-003)', () => {
  const baseA = readFileSync(DEFA, 'utf8');

  it('未保存修改:镜像 v2 后悬停立即出编辑器内容(Default 100→200)', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const pos = hpPos(baseA);
    const v1 = await serveHoverFromRust(defDoc(DEFA, baseA, 1), pos);
    expect(defaultOf(String(v1))).toBe('100');
    const v2text = withDefault(baseA, 200);
    const v2 = await serveHoverFromRust(defDoc(DEFA, v2text, 2), pos);
    expect(defaultOf(String(v2))).toBe('200');
    expect(String(v2)).toContain(`**hp**`);
  }, 30_000);

  it('连续输入:同文件 v2→v3→v4 快速多版,每版即时生效不回旧值', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const pos = hpPos(baseA);
    let text = withDefault(baseA, 200);
    const seen: Array<string | null> = [];
    for (const [version, value] of [[2, 200], [3, 300], [4, 400]] as const) {
      const hover = await serveHoverFromRust(defDoc(DEFA, text, version), pos);
      seen.push(defaultOf(String(hover)));
      expect(defaultOf(String(hover))).toBe(String(value));
      text = withDefault(text, value + 100);
    }
    expect(seen).toEqual(['200', '300', '400']);
  }, 30_000);

  it('同名跨根:第二 root 同名 def 诚实 NULL 回落;rootA 环境不被串值', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const baseB = readFileSync(DEFB, 'utf8');
    expect(baseB).toContain('<Default> 777 </Default>');
    const posB = hpPos(baseB);
    const rootB = await serveHoverFromRust(defDoc(DEFB, baseB, 1), posB);
    expect(rootB).toBeNull();
    const posA = hpPos(baseA);
    const rootA = await serveHoverFromRust(defDoc(DEFA, withDefault(baseA, 300), 3), posA);
    expect(defaultOf(String(rootA))).toBe('300');
  }, 30_000);

  it('关闭重开:gate dispose 后重建,同文件重新镜像仍出最新编辑内容', async () => {
    const first = realGate();
    gates.push(first.gate);
    setKodeCoreShadowGate(first.gate);
    const pos = hpPos(baseA);
    const edited = withDefault(baseA, 300);
    await serveHoverFromRust(defDoc(DEFA, edited, 3), pos);
    setKodeCoreShadowGate(null);
    await first.gate.dispose().catch(() => undefined);

    const second = realGate();
    gates.push(second.gate);
    setKodeCoreShadowGate(second.gate);
    const reopened = await serveHoverFromRust(defDoc(DEFA, edited, 4), pos);
    expect(defaultOf(String(reopened))).toBe('300');
  }, 45_000);

  it('重命名:新路径镜像即时命中且 Source 锚重算到新路径', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const renamedDir = mkdtempSync(join(tmpdir(), 'kode-qa003-rename-'));
    const renamedUri = join(renamedDir, 'Avatar.def');
    const edited = withDefault(baseA, 300);
    const hover = await serveHoverFromRust(defDoc(renamedUri, edited, 1), hpPos(edited));
    expect(defaultOf(String(hover))).toBe('300');
    expect(String(hover)).toContain(renamedUri);
  }, 30_000);

  it('破档修复:镜像 v1 破档出未知 Flags 错误,镜像 v2 修复后诊断归零', async () => {
    const { gate } = realGate();
    gates.push(gate);
    setKodeCoreShadowGate(gate);
    const brokenUri = join(mkdtempSync(join(tmpdir(), 'kode-qa003-diag-')), 'Broken.def');
    const brokenV1 = [
      '<root>',
      '<Type>Broken</Type>',
      '<Entity>',
      '\t<Properties>',
      '\t\t<hp>',
      '\t\t\t<Type> UINT32 </Type>',
      '\t\t\t<Flags> NOT_A_FLAG </Flags>',
      '\t\t</hp>',
      '\t</Properties>',
      '</Entity>',
      '</root>',
      ''
    ].join('\n');
    const v1 = await serveDiagnosticsFromRust(defDoc(brokenUri, brokenV1, 1));
    expect(v1).not.toBeNull();
    expect(v1!.items.some(item => item.message.includes('NOT_A_FLAG'))).toBe(true);
    const fixedV2 = brokenV1.replace('NOT_A_FLAG', 'ALL_CLIENTS');
    const v2 = await serveDiagnosticsFromRust(defDoc(brokenUri, fixedV2, 2));
    expect(v2).not.toBeNull();
    expect(v2!.items).toHaveLength(0);
  }, 30_000);

  it('降级臂:门未装配(backend=ts)TS 悬停链仍出 hp,隔离语义不依赖 rust 存活', async () => {
    setKodeCoreShadowGate(null);
    const hover = await new KBEngineHoverProvider().provideHoverTimed(
      defDoc(DEFA, baseA, 1),
      new Position(hpPos(baseA).line, hpPos(baseA).character)
    );
    const contents = (hover as { contents: unknown }).contents;
    const text = Array.isArray(contents)
      ? contents.map(item => (typeof item === 'string' ? item : String((item as { value?: string }).value ?? ''))).join('')
      : typeof contents === 'object' && contents !== null && 'value' in contents
        ? String((contents as { value: string }).value)
        : String(contents);
    expect(text).toContain('hp');
  }, 30_000);
});
