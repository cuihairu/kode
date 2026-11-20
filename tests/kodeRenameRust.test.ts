// RUST-141 批 2 接线(kode-server textDocument/prepareRename + rename)
// TS 侧钉子:①桥契约——servePrepareRenameFromRust/serveRenameFromRust 的
// 文档门、载荷(params 形状)、回包整面校验与降级;②provider 切流——
// prepareRename 与 provideRenameEdits 消费 Rust 面(range/placeholder、
// 冲突抛错文案、目标+后代编辑),Rust 面不可用时回 TS 既有实现(非 .def
// 门、无门、应答畸形皆回退,不部分采用)。
// 跨文件闭包预检/后代编辑复算的 Rust 服务面形状由
// crates/kode-server/tests/rename_dispatch.rs LSP 级门禁钉真值。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTextDocument, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import { KBEngineRenameProvider } from '../src/languageProviders';
import {
  servePrepareRenameFromRust,
  serveRenameFromRust,
  setKodeCoreShadowGate
} from '../src/backend/kodeCoreShadowFaces';
import type {
  DefRenameEditsFace,
  LspPrepareRenameFace
} from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';

/** 桩 gate:serveInRust 按 scripted 回包;记录调用面供载荷断言。 */
const makeServingGate = (
  scripted: unknown,
  options?: { serving?: boolean; serveError?: boolean }
): { gate: KodeCoreGate; served: Array<{ method: string; params: Record<string, unknown> }> } => {
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
  return { gate, served };
};

const HERO_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type> UINT32 </Type>',
  '      <Flags> BASE </Flags>',
  '    </hp>',
  '    <mp>',
  '      <Type> UINT32 </Type>',
  '    </mp>',
  '  </Properties>',
  '  <CellMethods>',
  '    <onCellCreate>',
  '      <Arg> UINT32 </Arg>',
  '    </onCellCreate>',
  '  </CellMethods>',
  '</root>',
  ''
].join('\n');

/** 闭包冲突fixture:后代占名 vigor 且域位与 hp 的 BASE 相交。 */
const MONSTER_DEF_VIGOR = [
  '<root>',
  '  <Parent> Hero </Parent>',
  '  <Properties>',
  '    <vigor>',
  '      <Type> UINT32 </Type>',
  '      <Flags> BASE </Flags>',
  '    </vigor>',
  '  </Properties>',
  '</root>',
  ''
].join('\n');

const PREPARE_FACE: LspPrepareRenameFace = {
  range: { start: { line: 2, character: 3 }, end: { line: 2, character: 5 } },
  placeholder: 'hp'
};

const RENAME_EDITS_FACE: DefRenameEditsFace = {
  conflict: null,
  closureConflict: null,
  fileEdits: [
    {
      filePath: '/tmp/ws/scripts/entity_defs/Hero.def',
      edits: [
        { start: { line: 2, character: 3 }, end: { line: 2, character: 5 } },
        { start: { line: 4, character: 2 }, end: { line: 4, character: 6 } }
      ]
    },
    {
      filePath: '/tmp/ws/scripts/entity_defs/Monster.def',
      edits: [{ start: { line: 3, character: 3 }, end: { line: 3, character: 5 } }]
    }
  ]
};

// hp 名字跨度(HERO_DEF 第 2 行 0 基,`    <hp>` 里名字起 char 3)
// hp 名字跨度(HERO_DEF 0 基第 2 行 `    <hp>`:名字起 char 5)
const HP_CURSOR = { line: 2, character: 5 };

describe('servePrepareRenameFromRust 桥契约', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
  });

  it('ok:先镜像再请求,载荷不带 newName,面原样透传', async () => {
    const doc = makeTextDocument(HERO_DEF, { fileName: '/tmp/ws/scripts/entity_defs/Hero.def', version: 1 });
    const { gate, served } = makeServingGate(PREPARE_FACE);
    setKodeCoreShadowGate(gate);
    const result = await servePrepareRenameFromRust(doc, HP_CURSOR);
    expect(result).toEqual(PREPARE_FACE);
    expect(served).toEqual([
      {
        method: 'textDocument/prepareRename',
        params: {
          textDocument: { uri: '/tmp/ws/scripts/entity_defs/Hero.def' },
          position: { line: 2, character: 5 }
        }
      }
    ]);
  });

  it('无门/非服务轨道/非 def 文档 → null 且零请求', async () => {
    const doc = makeTextDocument(HERO_DEF, { fileName: '/tmp/ws/scripts/entity_defs/Hero.def' });
    setKodeCoreShadowGate(null);
    expect(await servePrepareRenameFromRust(doc, HP_CURSOR)).toBeNull();
    const { gate, served } = makeServingGate(PREPARE_FACE, { serving: false });
    setKodeCoreShadowGate(gate);
    expect(await servePrepareRenameFromRust(doc, HP_CURSOR)).toBeNull();
    const pyDoc = makeTextDocument('class Hero:\n    pass\n', {
      fileName: '/tmp/ws/scripts/common/Hero.py',
      languageId: 'python'
    });
    expect(await servePrepareRenameFromRust(pyDoc, { line: 0, character: 6 })).toBeNull();
    expect(served).toEqual([]);
  });

  it('应答畸形(区间缺位/占位名非串/外层包壳)→ 整面作废', async () => {
    const doc = makeTextDocument(HERO_DEF, { fileName: '/tmp/ws/scripts/entity_defs/Hero.def' });
    const badCases: unknown[] = [
      { range: { start: { line: 1 } }, placeholder: 'hp' },
      { range: { start: { line: 1, character: 1 } }, placeholder: 'hp' },
      { range: PREPARE_FACE.range, placeholder: 42 },
      { prepareRename: PREPARE_FACE },
      'nope'
    ];
    for (const bad of badCases) {
      const { gate } = makeServingGate(bad);
      setKodeCoreShadowGate(gate);
      expect(await servePrepareRenameFromRust(doc, HP_CURSOR)).toBeNull();
      setKodeCoreShadowGate(null);
    }
  });

  it('取消位先置 → 零请求直接回落', async () => {
    const doc = makeTextDocument(HERO_DEF, { fileName: '/tmp/ws/scripts/entity_defs/Hero.def' });
    const { gate, served } = makeServingGate(PREPARE_FACE);
    setKodeCoreShadowGate(gate);
    expect(await servePrepareRenameFromRust(doc, HP_CURSOR, () => true)).toBeNull();
    expect(served).toEqual([]);
  });
});

describe('serveRenameFromRust 桥契约', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
  });

  it('ok:载荷带 newName,三键面原样透传', async () => {
    const doc = makeTextDocument(HERO_DEF, { fileName: '/tmp/ws/scripts/entity_defs/Hero.def', version: 1 });
    const { gate, served } = makeServingGate(RENAME_EDITS_FACE);
    setKodeCoreShadowGate(gate);
    const result = await serveRenameFromRust(doc, HP_CURSOR, 'vigor');
    expect(result).toEqual(RENAME_EDITS_FACE);
    expect(served).toEqual([
      {
        method: 'textDocument/rename',
        params: {
          textDocument: { uri: '/tmp/ws/scripts/entity_defs/Hero.def' },
          position: { line: 2, character: 5 },
          newName: 'vigor'
        }
      }
    ]);
  });

  it('应答畸形(缺键/编辑区间缺位/冲突面缺行号)→ 整面作废', async () => {
    const doc = makeTextDocument(HERO_DEF, { fileName: '/tmp/ws/scripts/entity_defs/Hero.def' });
    const badCases: unknown[] = [
      { closureConflict: null, fileEdits: RENAME_EDITS_FACE.fileEdits },
      { conflict: null, closureConflict: null, fileEdits: RENAME_EDITS_FACE },
      {
        conflict: null,
        closureConflict: null,
        fileEdits: [{ filePath: '/tmp/ws/Hero.def', edits: [{ start: { line: 1 } }] }]
      },
      {
        conflict: { surface: 'Properties', name: 'mp' },
        closureConflict: null,
        fileEdits: []
      },
      'nope'
    ];
    for (const bad of badCases) {
      const { gate } = makeServingGate(bad);
      setKodeCoreShadowGate(gate);
      expect(await serveRenameFromRust(doc, HP_CURSOR, 'vigor')).toBeNull();
      setKodeCoreShadowGate(null);
    }
  });
});

const ORIGINAL_FOLDERS = stubWorkspace.workspaceFolders;

describe('rename provider 切流', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
    stubWorkspace.workspaceFolders = ORIGINAL_FOLDERS;
  });

  it('Rust 面命中 → prepareRename 出 Rust 候选区间与占位名', async () => {
    const provider = new KBEngineRenameProvider();
    const doc = makeTextDocument(HERO_DEF, { fileName: '/tmp/ws/scripts/entity_defs/Hero.def', version: 1 });
    const { gate, served } = makeServingGate(PREPARE_FACE);
    setKodeCoreShadowGate(gate);
    const prepared = await provider.prepareRename(doc, { line: HP_CURSOR.line, character: HP_CURSOR.character });
    expect(prepared).not.toBeNull();
    expect(prepared?.placeholder).toBe('hp');
    // Rust 面给的行/列直用(不借 TS 行表换算)
    expect(prepared?.range.start.line).toBe(PREPARE_FACE.range.start.line);
    expect(prepared?.range.start.character).toBe(PREPARE_FACE.range.start.character);
    expect(prepared?.range.end.character).toBe(PREPARE_FACE.range.end.character);
    expect(served.length).toBe(1);
  });

  it('Rust 面命中 → WorkspaceEdit 按 face 逐文件逐区间装配', async () => {
    const provider = new KBEngineRenameProvider();
    const doc = makeTextDocument(HERO_DEF, { fileName: '/tmp/ws/scripts/entity_defs/Hero.def', version: 1 });
    setKodeCoreShadowGate(makeServingGate(RENAME_EDITS_FACE).gate);
    const workspaceEdit = await provider.provideRenameEdits(
      doc,
      { line: HP_CURSOR.line, character: HP_CURSOR.character },
      'vigor'
    );
    expect(workspaceEdit).not.toBeNull();
    expect(workspaceEdit?.size).toBe(RENAME_EDITS_FACE.fileEdits.length);
    const entries = new Map(Array.from(workspaceEdit!.entries()).map(([uri, edits]) => [uri.fsPath, edits]));
    const heroEdits = entries.get('/tmp/ws/scripts/entity_defs/Hero.def');
    expect(heroEdits?.length).toBe(2);
    expect(heroEdits![0].range.start.character).toBe(3);
    expect(heroEdits![0].newText).toBe('vigor');
    expect(heroEdits![1].range.start.line).toBe(4);
    const monsterEdits = entries.get('/tmp/ws/scripts/entity_defs/Monster.def');
    expect(monsterEdits?.length).toBe(1);
    expect(monsterEdits![0].range.start.line).toBe(3);
  });

  it('Rust 同文件冲突面 → 抛 NAV-008 文案(不装配编辑)', async () => {
    const provider = new KBEngineRenameProvider();
    const doc = makeTextDocument(HERO_DEF, { fileName: '/tmp/ws/scripts/entity_defs/Hero.def', version: 1 });
    setKodeCoreShadowGate(
      makeServingGate({
        conflict: { surface: 'Properties', name: 'mp', line: 7, filePath: null },
        closureConflict: null,
        fileEdits: []
      } satisfies DefRenameEditsFace
    ).gate
    );
    await expect(
      provider.provideRenameEdits(doc, { line: HP_CURSOR.line, character: HP_CURSOR.character }, 'mp')
    ).rejects.toThrow('already declared in Properties at line 7 of Hero.def');
  });

  it('Rust 闭包冲突面 → 抛 AUD-061 文案(冲突位带文件 basename)', async () => {
    const provider = new KBEngineRenameProvider();
    const doc = makeTextDocument(HERO_DEF, { fileName: '/tmp/ws/scripts/entity_defs/Hero.def', version: 1 });
    setKodeCoreShadowGate(
      makeServingGate({
        conflict: null,
        closureConflict: {
          surface: 'Properties',
          name: 'vigor',
          line: 4,
          filePath: '/tmp/ws/scripts/entity_defs/Monster.def'
        },
        fileEdits: []
      } satisfies DefRenameEditsFace
    ).gate
    );
    await expect(
      provider.provideRenameEdits(doc, { line: HP_CURSOR.line, character: HP_CURSOR.character }, 'vigor')
    ).rejects.toThrow('already declared in Properties at line 4 of Monster.def');
  });

  it('Rust 应答不可用(serve 抛错)→ 回 TS 既有实现:真闭包走查仍报占名冲突', async () => {
    const workspace = makeTempWorkspace(MONSTER_DEF_VIGOR);
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(workspace.root), name: 'ws', index: 0 }];
    const heroDoc = makeTextDocument(HERO_DEF, { fileName: workspace.heroPath, version: 1 });
    const provider = new KBEngineRenameProvider();
    setKodeCoreShadowGate(makeServingGate(RENAME_EDITS_FACE, { serveError: true }).gate);
    await expect(
      provider.provideRenameEdits(
        heroDoc,
        { line: HP_CURSOR.line, character: HP_CURSOR.character },
        'vigor'
      )
    ).rejects.toThrow('already declared in Properties');
  });
});

/** 临时工作区:scripts/entities.xml + Hero.def + Monster.def(闭包走查真盘)。 */
function makeTempWorkspace(monsterText: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-rename-rust-'));
  const defsDir = path.join(root, 'scripts', 'entity_defs');
  fs.mkdirSync(defsDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), '<root/>\n');
  fs.writeFileSync(path.join(defsDir, 'Hero.def'), HERO_DEF);
  fs.writeFileSync(path.join(defsDir, 'Monster.def'), monsterText);
  const heroPath = path.join(defsDir, 'Hero.def');
  return {
    root,
    heroPath,
    monsterPath: path.join(defsDir, 'Monster.def'),
    uri: { fsPath: root, scheme: 'file' }
  };
}