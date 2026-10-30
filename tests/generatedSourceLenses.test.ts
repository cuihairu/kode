import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GeneratedSourceCodeLensProvider } from '../src/generatedSourceLenses';
import { makeTextDocument, Uri, workspace } from './helpers/vscodeStub';
import type { PythonTypeStubEntry } from '../src/pythonTypeStubs';
import { KBENGINE_SOURCE_REVEAL_COMMAND } from '../src/sourceRevealCommand';

// 生成源 CodeLens 提供者:目标文件名/工作区根/types.xml 注册表三重门各
// 自返回空;命中时按桩条目源行出「原始定义」镜,command 指向源揭示并带
// types.xml 选中范围。python 条目优先,entity 条目兜底。
describe('GeneratedSourceCodeLensProvider', () => {
  const roots: string[] = [];
  const originalFolders = workspace.workspaceFolders;
  const originalGetWorkspaceFolder = (workspace as { getWorkspaceFolder?: unknown }).getWorkspaceFolder;
  let root = '';

  const makeDoc = (fileName: string, text: string) => {
    const doc = makeTextDocument(text, { fileName, languageId: 'python' });
    return Object.assign(doc, { lineCount: text.split('\n').length });
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-lens-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'scripts/entity_defs/types.xml'),
      ['<root>', '  <ITEM_ID>UINT16</ITEM_ID>', '</root>'].join('\n'),
      'utf8'
    );
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'lens', index: 0 }];
    (workspace as { getWorkspaceFolder?: unknown }).getWorkspaceFolder =
      (uri: { path?: string; fsPath?: string }) =>
        String(uri.path ?? uri.fsPath ?? '').startsWith(root)
          ? { uri: Uri.file(root), name: 'lens', index: 0 }
          : undefined;
  });

  afterEach(() => {
    (workspace as { getWorkspaceFolder?: unknown }).getWorkspaceFolder = originalGetWorkspaceFolder;
    workspace.workspaceFolders = originalFolders;
    roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
  });

  const pythonEntries: PythonTypeStubEntry[] = [{
    kind: 'class',
    name: 'ITEM_ID',
    annotation: 'int',
    sourceLine: 4,
    sourceFile: 'types.xml',
    properties: []
  }];

  it('非目标文件名 → 空镜列表(不触工作区)', () => {
    const provider = new GeneratedSourceCodeLensProvider('stub_types.py', pythonEntries, []);
    expect(provider.provideCodeLenses(makeDoc(path.join(root, 'other.py'), 'x\n'))).toEqual([]);
  });

  it('文档不在任何工作区文件夹 → 空', () => {
    const provider = new GeneratedSourceCodeLensProvider('stub_types.py', pythonEntries, []);
    const outside = makeDoc('/tmp/definitely-outside/stub_types.py', 'x\n');
    expect(provider.provideCodeLenses(outside)).toEqual([]);
  });

  it('工作区无 types.xml 注册表 → 空', () => {
    fs.rmSync(path.join(root, 'scripts/entity_defs/types.xml'));
    const provider = new GeneratedSourceCodeLensProvider('stub_types.py', pythonEntries, []);
    expect(provider.provideCodeLenses(makeDoc(path.join(root, 'stub_types.py'), 'x\n'))).toEqual([]);
  });

  it('命中:条目源行出「原始定义」镜,command 带源揭示与选中范围', () => {
    const provider = new GeneratedSourceCodeLensProvider('stub_types.py', pythonEntries, []);
    const lenses = provider.provideCodeLenses(makeDoc(path.join(root, 'stub_types.py'), 'class ITEM_ID(int):\n    pass\n'));
    expect(lenses).toHaveLength(1);
    const lens = lenses[0] as unknown as { range: { start: { line: number } }; command?: { title: string; command: string; arguments: unknown[] } };
    expect(lens.range.start.line).toBe(0);
    expect(lens.command?.command).toBe(KBENGINE_SOURCE_REVEAL_COMMAND);
    expect(lens.command?.title).toContain('原始定义: ITEM_ID types.xml:4');
    const [uriArg, optionsArg] = lens.command?.arguments as [{ path: string }, { selection: { start: { line: number } } }];
    expect(uriArg.path.endsWith('types.xml')).toBe(true);
    expect(optionsArg.selection.start.line).toBe(3);
  });

  it('python 条目缺源行时回落 entity 条目兜底', () => {
    const noSource: PythonTypeStubEntry[] = [{
      kind: 'alias',
      name: 'NO_SOURCE',
      annotation: 'int',
      sourceLine: null
    }];
    const provider = new GeneratedSourceCodeLensProvider('stub_types.py', noSource, [{
      entity: 'Avatar',
      properties: [{ name: 'profile', sourceLine: 24, customTypeLine: 30 }]
    }]);
    const lenses = provider.provideCodeLenses(makeDoc(path.join(root, 'stub_types.py'), 'class Avatar:\n    pass\n'));
    expect(lenses).toHaveLength(1);
    const lens = lenses[0] as { command?: { title: string } };
    expect(lens.command?.title).toContain('原始定义: Avatar types.xml:30');
  });
});
