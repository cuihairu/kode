// RUST-138 批 3 接线(kode-server textDocument/references)TS 侧钉子:
// ①桥契约:serveReferencesFromRust 的文档门/载荷(includeDeclaration)/回包
//   校验与降级;
// ②provider 切流:types.xml 面与 def 语料面两处消费点——Rust 命中 → 引用位
//   来自 Rust 面(references-parity.json golden 真值驱动 + 故意漂移面证真
//   消费);Rust 失败 → 回 TS 既有实现且与无门基线同树。
// 语义分类切流(semantic_reference_locations)是产品面,不在本批。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { makeTextDocument, Position, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import { KBEngineReferencesProvider } from '../src/languageProviders';
import type { EntityMappingManager } from '../src/entityMapping';
import {
  serveReferencesFromRust,
  setKodeCoreShadowGate
} from '../src/backend/kodeCoreShadowFaces';
import type { LspLocationFace } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';

const REPO_ROOT = path.resolve(__dirname, '..');

/** 桩 gate:serveInRust 按 scripted 回包;记录调用面供载荷断言。 */
const makeServingGate = (
  scripted: unknown,
  options?: { serving?: boolean; serveError?: boolean }
): {
  gate: KodeCoreGate;
  served: Array<{ method: string; params: Record<string, unknown> }>;
  mirrored: string[];
} => {
  const served: Array<{ method: string; params: Record<string, unknown> }> = [];
  const mirrored: string[] = [];
  const gate = {
    serveFromRust: () => options?.serving ?? true,
    mirrorDocument: async (uri: string) => {
      mirrored.push(uri);
    },
    serveInRust: async (method: string, params: unknown) => {
      served.push({ method, params: params as Record<string, unknown> });
      if (options?.serveError) {
        throw new Error('rust serve failed');
      }
      return scripted;
    }
  } as unknown as KodeCoreGate;
  return { gate, served, mirrored };
};

const DEF_DOC = makeTextDocument(
  '<root>\n\t<Parent> Monster </Parent>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type> UINT32 </Type>\n\t\t</hp>\n\t</Properties>\n</root>\n',
  { fileName: '/tmp/ws/scripts/entity_defs/Avatar.def', version: 5 }
);

const FACES: LspLocationFace[] = [
  {
    uri: '/tmp/ws/scripts/entity_defs/Monster.def',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
  },
  {
    uri: '/tmp/ws/scripts/entity_defs/Avatar.def',
    range: { start: { line: 1, character: 10 }, end: { line: 1, character: 10 } }
  }
];

describe('serveReferencesFromRust 桥契约(①载荷与回包)', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
  });

  it('ok:先镜像再请求,载荷带位置与 includeDeclaration,面原样透传(locations 态)', async () => {
    const { gate, served, mirrored } = makeServingGate(FACES);
    setKodeCoreShadowGate(gate);
    const result = await serveReferencesFromRust(DEF_DOC, { line: 1, character: 10 }, true);
    expect(result).toEqual({ kind: 'locations', locations: FACES });
    expect(mirrored).toEqual(['/tmp/ws/scripts/entity_defs/Avatar.def']);
    expect(served).toEqual([
      {
        method: 'textDocument/references',
        params: {
          textDocument: { uri: '/tmp/ws/scripts/entity_defs/Avatar.def' },
          position: { line: 1, character: 10 },
          context: { includeDeclaration: true }
        }
      }
    ]);
    const flipped = await serveReferencesFromRust(DEF_DOC, { line: 1, character: 10 }, false);
    expect(flipped).toEqual({ kind: 'locations', locations: FACES });
    expect(served[1].params.context).toEqual({ includeDeclaration: false });
  });

  it('Rust 权威 null → none 态(与失败/不可用分开,消费点据此不回 TS)', async () => {
    const { gate, served } = makeServingGate(null);
    setKodeCoreShadowGate(gate);
    const result = await serveReferencesFromRust(DEF_DOC, { line: 1, character: 10 }, true);
    expect(result).toEqual({ kind: 'none' });
    expect(served.length).toBe(1);
  });

  it('Rust 权威空数组 → locations 态空集(合法应答,非失败)', async () => {
    const { gate } = makeServingGate([]);
    setKodeCoreShadowGate(gate);
    expect(await serveReferencesFromRust(DEF_DOC, { line: 1, character: 10 }, true)).toEqual({
      kind: 'locations',
      locations: []
    });
  });

  it('无门/非服务轨道/python 文档 → unavailable 态且零请求(回 TS 既有实现)', async () => {
    setKodeCoreShadowGate(null);
    expect(await serveReferencesFromRust(DEF_DOC, { line: 1, character: 10 }, true)).toEqual({
      kind: 'unavailable'
    });
    const { gate, served } = makeServingGate(FACES, { serving: false });
    setKodeCoreShadowGate(gate);
    expect(await serveReferencesFromRust(DEF_DOC, { line: 1, character: 10 }, true)).toEqual({
      kind: 'unavailable'
    });
    const pyDoc = makeTextDocument('class Monster:\n    pass\n', {
      fileName: '/tmp/ws/scripts/cell/Monster.py',
      languageId: 'python'
    });
    expect(await serveReferencesFromRust(pyDoc, { line: 0, character: 6 }, true)).toEqual({
      kind: 'unavailable'
    });
    expect(served).toEqual([]);
  });

  it('应答非数组/条目畸形(缺 uri、区间缺位、外层包壳)→ 整面作废不可用', async () => {
    const badCases: unknown[] = [
      { locations: FACES },
      [{ uri: 42, range: FACES[0].range }],
      [{ uri: FACES[0].uri, range: { start: { line: 1 } } }],
      [{ uri: FACES[0].uri, range: { start: { line: 1, character: 1 } } }],
      'nope'
    ];
    for (const bad of badCases) {
      const { gate } = makeServingGate(bad);
      setKodeCoreShadowGate(gate);
      expect(await serveReferencesFromRust(DEF_DOC, { line: 1, character: 10 }, true)).toEqual({
        kind: 'unavailable'
      });
      setKodeCoreShadowGate(null);
    }
  });

  it('取消位先置 → 零请求直接不可用', async () => {
    const { gate, served } = makeServingGate(FACES);
    setKodeCoreShadowGate(gate);
    expect(
      await serveReferencesFromRust(DEF_DOC, { line: 1, character: 10 }, true, () => true)
    ).toEqual({ kind: 'unavailable' });
    expect(served).toEqual([]);
  });
});

// ---- ②provider 切流面(golden 真值驱动) ------------------------------------

interface GoldenLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}
interface GoldenFile {
  file: string;
  kind: string;
  references: Array<{ line: number; character: number; locations: GoldenLocation[] }>;
}

const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'crates/kode-server/tests/golden/references-parity.json'), 'utf8')
) as { files: GoldenFile[] };

/** golden 真值驱动的语料文档(读真盘文本,与 Rust dump 同输入) */
const corpusDoc = (entry: GoldenFile): vscode.TextDocument => {
  const text = fs.readFileSync(path.join(REPO_ROOT, entry.file), 'utf8');
  return makeTextDocument(text, {
    fileName: path.join(REPO_ROOT, entry.file),
    version: 7,
    languageId: entry.kind === 'types' ? 'xml' : 'kbengine-def'
  }) as never;
};

/** manager 桩:语料面两消费点不该走到 entityMapping 运行时面 */
const makeManagerStub = (): { manager: EntityMappingManager; calls: number } => {
  const state = { calls: 0 };
  const manager = {
    getIncomingPythonPropertyAccesses: async () => {
      state.calls += 1;
      return [];
    },
    getIncomingPythonMethodCalls: async () => {
      state.calls += 1;
      return [];
    },
    getIncomingPythonReceiverCalls: async () => {
      state.calls += 1;
      return [];
    }
  };
  return { manager: manager as unknown as EntityMappingManager, calls: state.calls };
};

/** vscode.Location → 可比较纯视图(stub Uri 不参与深等) */
const toView = (locations: vscode.Location[]): unknown[] =>
  locations.map(location => ({
    uri: location.uri.fsPath,
    range: {
      start: { line: location.range.start.line, character: location.range.start.character },
      end: { line: location.range.end.line, character: location.range.end.character }
    }
  }));

const defEntriesWithSites = (): Array<{ entry: GoldenFile; reference: { line: number; character: number; locations: GoldenLocation[] } }> => {
  const out: Array<{ entry: GoldenFile; reference: { line: number; character: number; locations: GoldenLocation[] } }> = [];
  for (const entry of GOLDEN.files) {
    if (entry.kind !== 'def') {
      continue;
    }
    const reference = entry.references.find(item => item.locations.length > 0);
    if (reference) {
      out.push({ entry, reference });
    }
  }
  return out;
};

describe('provider 切流(②Rust 命中/失败回落)', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
  });

  it('Rust 命中:golden 真值面 → provider 引用位逐点深等(def 语料面)', async () => {
    // golden 探针行 1 基(dump 侧 probe.line - 1 后查询),位置面含声明
    // (dump 恒 includeDeclaration=true)。
    const cases = defEntriesWithSites().slice(0, 3);
    expect(cases.length).toBeGreaterThan(0);
    for (const { entry, reference } of cases) {
      const { gate } = makeServingGate(reference.locations);
      setKodeCoreShadowGate(gate);
      const { manager, calls } = makeManagerStub();
      const provider = new KBEngineReferencesProvider(manager);
      const result = await provider.provideReferences(
        corpusDoc(entry),
        new Position(reference.line - 1, reference.character),
        { includeDeclaration: true },
        undefined
      );
      setKodeCoreShadowGate(null);
      expect(result).not.toBeNull();
      expect(toView(result!)).toEqual(reference.locations);
      // 运行时引用面零调用:引用位真来自 Rust 面,不是 TS 兜底自算。
      expect(calls).toBe(0);
    }
  });

  it('Rust 命中:types.xml 面 golden 真值 → provider 引用位逐点深等', async () => {
    const entry = GOLDEN.files.find(
      file => file.kind === 'types' && file.references.some(item => item.locations.length > 0)
    );
    expect(entry).toBeTruthy();
    const reference = entry!.references.find(item => item.locations.length > 0)!;
    const { gate } = makeServingGate(reference.locations);
    setKodeCoreShadowGate(gate);
    const provider = new KBEngineReferencesProvider(makeManagerStub().manager);
    const result = await provider.provideReferences(
      corpusDoc(entry!),
      new Position(reference.line - 1, reference.character),
      { includeDeclaration: true },
      undefined
    );
    setKodeCoreShadowGate(null);
    expect(result).not.toBeNull();
    expect(toView(result!)).toEqual(reference.locations);
  });

  it('Rust 面被真消费:故意漂移的合法面原样出镜(证明不是 TS 兜底自算)', async () => {
    const { entry, reference } = defEntriesWithSites()[0];
    const drifted: GoldenLocation[] = [
      ...reference.locations,
      {
        uri: 'RUST_ONLY_MARKER.def',
        range: { start: { line: 3, character: 4 }, end: { line: 3, character: 4 } }
      }
    ];
    const { gate } = makeServingGate(drifted);
    setKodeCoreShadowGate(gate);
    const result = await new KBEngineReferencesProvider(makeManagerStub().manager).provideReferences(
      corpusDoc(entry),
      new Position(reference.line - 1, reference.character),
      { includeDeclaration: true },
      undefined
    );
    setKodeCoreShadowGate(null);
    expect(toView(result!)).toEqual(drifted);
  });

  it('Rust 失败 → 回 TS 既有实现,结果与无门基线同树', async () => {
    // 临时小工作区:TS 语料面(findFiles+workspaceFolders)真算基线。
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-refs-rust-'));
    const defsDir = path.join(wsRoot, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    const monsterPath = path.join(defsDir, 'Monster.def');
    const avatarPath = path.join(defsDir, 'Avatar.def');
    fs.writeFileSync(monsterPath, '<root>\n\t<Parent> Account </Parent>\n</root>\n');
    fs.writeFileSync(avatarPath, '<root>\n\t<Parent> Monster </Parent>\n</root>\n');
    const originalFolders = stubWorkspace.workspaceFolders;
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(wsRoot), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async (glob?: string) =>
      glob.endsWith('.def') ? [Uri.file(avatarPath), Uri.file(monsterPath)] : []) as never;
    try {
      const doc = makeTextDocument(fs.readFileSync(avatarPath, 'utf8'), {
        fileName: avatarPath,
        version: 1
      }) as never;
      const query = () =>
        new KBEngineReferencesProvider(makeManagerStub().manager).provideReferences(
          doc,
          new Position(1, 10),
          { includeDeclaration: true },
          undefined
        );
      setKodeCoreShadowGate(null);
      const baseline = await query();
      expect(baseline).not.toBeNull();
      const { gate } = makeServingGate(null, { serveError: true });
      setKodeCoreShadowGate(gate);
      const fallback = await query();
      setKodeCoreShadowGate(null);
      expect(toView(fallback!)).toEqual(toView(baseline!));
    } finally {
      stubWorkspace.workspaceFolders = originalFolders;
      stubWorkspace.findFiles = originalFindFiles;
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it('Rust 权威 null → provider 权威空(不回 TS 补同名语法站点,批 4)', async () => {
    // 临时小工作区:TS 语料面真能算出 Parent Monster 引用位(基线非空),
    // 权威 null 时 provider 必须如实 null——若回 TS 兜底,语义过滤面
    // (Shadow/Dangling 不出列)就被兜底否决。本批拍板(2026-11-21)钉死此岔。
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-refs-none-'));
    const defsDir = path.join(wsRoot, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    const monsterPath = path.join(defsDir, 'Monster.def');
    const avatarPath = path.join(defsDir, 'Avatar.def');
    fs.writeFileSync(monsterPath, '<root>\n\t<Parent> Account </Parent>\n</root>\n');
    fs.writeFileSync(avatarPath, '<root>\n\t<Parent> Monster </Parent>\n</root>\n');
    const originalFolders = stubWorkspace.workspaceFolders;
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(wsRoot), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = (async (glob?: string) =>
      glob.endsWith('.def') ? [Uri.file(avatarPath), Uri.file(monsterPath)] : []) as never;
    try {
      const doc = makeTextDocument(fs.readFileSync(avatarPath, 'utf8'), {
        fileName: avatarPath,
        version: 1
      }) as never;
      const { manager, calls } = makeManagerStub();
      const query = () =>
        new KBEngineReferencesProvider(manager).provideReferences(
          doc,
          new Position(1, 10),
          { includeDeclaration: true },
          undefined
        );
      setKodeCoreShadowGate(null);
      const baseline = await query();
      expect(baseline, '无门基线 TS 语料面应真算出引用位').not.toBeNull();
      setKodeCoreShadowGate(makeServingGate(null).gate);
      const authoritative = await query();
      expect(authoritative, 'Rust 权威 null 必须如实空,不回 TS 补').toBeNull();
      expect(calls, '运行时引用面零调用').toBe(0);
    } finally {
      stubWorkspace.workspaceFolders = originalFolders;
      stubWorkspace.findFiles = originalFindFiles;
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});
