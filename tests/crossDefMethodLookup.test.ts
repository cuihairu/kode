import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { PythonDefinitionProvider, RpcCodeLensProvider } from '../src/languageProviders';
import { Position, Uri, workspace } from './helpers/vscodeStub';
import { makeTextDocument } from './helpers/vscodeStub';

describe('跨 .def 文件解析 Python 接口方法', () => {
  const originalFolders = workspace.workspaceFolders;
  const originalFindFiles = workspace.findFiles;
  const managers: EntityMappingManager[] = [];
  const roots: string[] = [];

  afterEach(() => {
    managers.splice(0).forEach(manager => manager.dispose());
    roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
    workspace.workspaceFolders = originalFolders;
    workspace.findFiles = originalFindFiles;
  });

  it('resolves interface_Mysterious.py against Interface_Activity.def and emits CodeLens', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cross-def-'));
    roots.push(root);
    const put = (relative: string, content: string) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return file;
    };
    const defFile = put('scripts/entity_defs/Interface_Activity.def', [
      '<root>',
      '  <BaseMethods>',
      '    <reqRefreshMysteriousBox/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));
    put('scripts/base/interfaces/interface_Mysterious.py', [
      'def reqRefreshMysteriousBox(self):',
      '    pass'
    ].join('\n'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'cross-def', index: 0 }];
    workspace.findFiles = async (glob?: string) => {
      if (glob !== '**/*.def') return [];
      return [Uri.file(defFile)];
    };

    const manager = new EntityMappingManager({ subscriptions: [] });
    managers.push(manager);
    const pythonFile = path.join(root, 'scripts/base/interfaces/interface_Mysterious.py');

    // Regression evidence: before global def fallback, no Mysterious.def owner exists.
    const definition = await manager.resolveMethodDefinition(pythonFile, 'reqRefreshMysteriousBox');
    expect(definition).toMatchObject({ defFile, line: 3, section: 'BaseMethods' });

    const caller = makeTextDocument(
      'class Caller:\n    def update(self):\n        self.reqRefreshMysteriousBox()\n',
      { fileName: pythonFile, languageId: 'python' }
    );
    const callerPosition = new Position(2, '        self.'.length + 2);
    const goToDefinition = await new PythonDefinitionProvider(manager).provideDefinition(caller, callerPosition);
    expect(goToDefinition).toMatchObject({
      uri: { fsPath: defFile },
      range: { start: { line: 2 } }
    });

    const provider = new RpcCodeLensProvider(manager);
    const lenses = await provider.provideCodeLenses(makeTextDocument(
      'def reqRefreshMysteriousBox(self):\n    pass',
      { fileName: pythonFile, languageId: 'python' }
    ));
    expect(lenses).toHaveLength(1);
    expect(lenses[0].command?.title).toContain('Interface_Activity.def');
    expect(lenses[0].command?.arguments?.[0]).toMatchObject({ fsPath: defFile });
    expect(lenses[0].command?.arguments?.[1]).toMatchObject({ selection: { start: { line: 2 } } });

    // Public method lookup used by the Python definition provider returns the same def position.
    expect(definition && new Position(definition.line - 1, 0)).toMatchObject({ line: 2 });
  });
});
