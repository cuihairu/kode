import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineDefinitionProvider } from '../src/languageProviders';
import type { EntityMappingManager } from '../src/entityMapping';
import {
  Position,
  Uri,
  makeTextDocument,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// IDE-ACC-013 单测锁:def→python F12 的落点行读取优先开着的文档缓冲
// (readScriptLinesForNavigation)。脏缓冲把方法 def 行挪动后,落点必须跟
// 缓冲(编辑时跳到脏缓冲区位置);缓冲撤出 textDocuments 后回落磁盘直读
// (放弃修改关闭后恢复磁盘位)。真实编辑器全流程(编辑/revert/关闭的
// 宿主手势)在 --dirty 真机套件(src/test/electron/suite/
// dirtyBufferNavigation.test.ts)。

interface LocationLike {
  uri: { fsPath: string };
  range: { start: { line: number } };
}

let wsRoot = '';
let defPath = '';
let scriptPath = '';
const ON_SPIN_DISK_LINE = 3;
const INSERTED_LINES = 5;

beforeAll(() => {
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-dirtybuf-'));
  const write = (relative: string, content: string) => {
    const target = path.join(wsRoot, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };
  write('scripts/entities.xml', [
    '<root>',
    '  <DirtyEntity hasBase="true"/>',
    '</root>'
  ].join('\n'));
  write('scripts/entity_defs/DirtyEntity.def', [
    '<root>',
    '  <BaseMethods>',
    '    <onSpin>',
    '      <Arg>UINT8</Arg>',
    '    </onSpin>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));
  // 磁盘形位:def onSpin 固定在 0 基第 3 行(注释/类/空行各一)
  write('scripts/base/DirtyEntity.py', [
    '# acc013 dirty buffer navigation fixture.',
    'class DirtyEntity:',
    '',
    '    def onSpin(self, level):',
    '        return None'
  ].join('\n'));
  defPath = path.join(wsRoot, 'scripts', 'entity_defs', 'DirtyEntity.def');
  scriptPath = path.join(wsRoot, 'scripts', 'base', 'DirtyEntity.py');
  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(wsRoot), name: 'ws', index: 0 }
  ];
});

afterAll(() => {
  fs.rmSync(wsRoot, { recursive: true, force: true });
  stubWorkspace.workspaceFolders = [];
  stubWorkspace.textDocuments = [];
});

describe('IDE-ACC-013:def→python 落点读取优先脏缓冲', () => {
  const defProvider = new KBEngineDefinitionProvider();

  const definitionAtOnSpin = (): LocationLike | null => {
    const defText = fs.readFileSync(defPath, 'utf8');
    const lines = defText.split('\n');
    const line = lines.findIndex(text => text.includes('<onSpin>'));
    expect(line).toBeGreaterThanOrEqual(0);
    const document = makeTextDocument(defText, { fileName: defPath, languageId: 'kbengine-def' });
    const position = new Position(line, lines[line].indexOf('onSpin') + 2);
    return defProvider.provideDefinition(document, position) as unknown as LocationLike | null;
  };

  it('脚本未打开:落点=磁盘直读行(既有口径不回退)', () => {
    stubWorkspace.textDocuments = [];
    const location = definitionAtOnSpin();
    expect(location?.uri.fsPath).toBe(scriptPath);
    expect(location?.range.start.line).toBe(ON_SPIN_DISK_LINE);
  });

  it('脏缓冲打开且方法挪行:落点=缓冲新行(编辑时跳到脏缓冲区位置)', () => {
    const diskText = fs.readFileSync(scriptPath, 'utf8');
    const dirtyText = [
      '# dirty buffer: five inserted lines shift the method definition.',
      '# line 2',
      '# line 3',
      '# line 4',
      '# line 5',
      diskText
    ].join('\n');
    expect(dirtyText.split('\n').findIndex(text => text.includes('def onSpin')))
      .toBe(ON_SPIN_DISK_LINE + INSERTED_LINES);
    const dirtyDocument = makeTextDocument(dirtyText, { fileName: scriptPath, languageId: 'python' });
    stubWorkspace.textDocuments = [dirtyDocument];
    const location = definitionAtOnSpin();
    expect(location?.uri.fsPath).toBe(scriptPath);
    expect(location?.range.start.line).toBe(ON_SPIN_DISK_LINE + INSERTED_LINES);
  });

  it('缓冲撤出(放弃修改并关闭后):落点恢复磁盘行', () => {
    stubWorkspace.textDocuments = [];
    const location = definitionAtOnSpin();
    expect(location?.range.start.line).toBe(ON_SPIN_DISK_LINE);
  });
});

describe('IDE-ACC-013:索引臂(identity)落点同样优先脏缓冲', () => {
  // 宿主内 def→python F12 主臂=映射索引(resolveMethodImplementationByIdentity,
  // 扫描期磁盘行);落点经 adjustMethodTargetToOpenBuffer 在脏缓冲在场时重定行。
  const identityManagerStub = {
    resolveDefinitionSymbolAtPosition: async () => ({
      entityName: 'DirtyEntity', section: 'BaseMethods', methodName: 'onSpin'
    }),
    resolveMethodImplementationByIdentity: async () => ({
      filePath: scriptPath, line: ON_SPIN_DISK_LINE + 1, character: 4
    }),
    resolveMethodImplementationGlobally: async () => null
  } as unknown as EntityMappingManager;
  const defProvider = new KBEngineDefinitionProvider(identityManagerStub);

  const definitionAtOnSpin = async (): Promise<LocationLike | null> => {
    const defText = fs.readFileSync(defPath, 'utf8');
    const lines = defText.split('\n');
    const line = lines.findIndex(text => text.includes('<onSpin>'));
    const document = makeTextDocument(defText, { fileName: defPath, languageId: 'kbengine-def' });
    const position = new Position(line, lines[line].indexOf('onSpin') + 2);
    return await defProvider.provideDefinition(document, position) as unknown as LocationLike | null;
  };

  it('脚本未打开:索引行原样(磁盘口径)', async () => {
    stubWorkspace.textDocuments = [];
    const location = await definitionAtOnSpin();
    expect(location?.uri.fsPath).toBe(scriptPath);
    expect(location?.range.start.line).toBe(ON_SPIN_DISK_LINE);
  });

  it('脏缓冲打开且方法挪行:索引臂落点重定到缓冲新行', async () => {
    const diskText = fs.readFileSync(scriptPath, 'utf8');
    const dirtyText = [
      '# dirty buffer: five inserted lines shift the method definition.',
      '# line 2',
      '# line 3',
      '# line 4',
      '# line 5',
      diskText
    ].join('\n');
    stubWorkspace.textDocuments = [
      makeTextDocument(dirtyText, { fileName: scriptPath, languageId: 'python' })
    ];
    const location = await definitionAtOnSpin();
    expect(location?.range.start.line).toBe(ON_SPIN_DISK_LINE + INSERTED_LINES);
  });

  it('脏缓冲里方法已被删除:保留索引行(不让落点凭空消失)', async () => {
    stubWorkspace.textDocuments = [
      makeTextDocument('class DirtyEntity:\n\n    pass\n', { fileName: scriptPath, languageId: 'python' })
    ];
    const location = await definitionAtOnSpin();
    expect(location?.range.start.line).toBe(ON_SPIN_DISK_LINE);
  });
});
