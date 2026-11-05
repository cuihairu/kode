import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import {
  Uri,
  lastFileSystemWatcher,
  workspace as stubWorkspace,
  window as stubWindow
} from './helpers/vscodeStub';

// 2026-11-05 用户反馈(def 方法 Shift+F12):KBEngine def 方法不可跨进程,本进程
// 调用是本地函数(self.x()),跨进程是 RPC(self.cell/base/client.x())。本地调用
// 按方法自身区块/进程作用域收录——baseapp 脚本的 self.onUpdate() 不得计入
// cellapp CellMethods.onUpdate 的引用。此文件锁住 getIncomingPythonMethodCalls
// 的进程过滤:cell 方法 move 的本地引用只含 cell 侧 onReady,不含 base 侧
// onSave 的 self.move()(跨进程伪引用)。
//
// prove-red:去掉 src/entityMapping.ts 的 callerSection/targetSection 过滤后,
// 本用例返回 2(含 base 的 onSave),断言红。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

const write = (root: string, relative: string, content: string) => {
  const target = p(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const until = async (condition: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${what}`);
};

const originalFindFiles = stubWorkspace.findFiles;
const originalOpenTextDocument = stubWorkspace.openTextDocument;
const originalShowTextDocument = stubWindow.showTextDocument;

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-defscope-'));
  (globalThis as { __defScopeRoot?: string }).__defScopeRoot = root;

  write(root, 'scripts/entities.xml', [
    '<root>',
    '  <Hero hasBase="true" hasCell="true"/>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/Hero.def', [
    '<root>',
    '  <BaseMethods>',
    '    <onSave/>',
    '  </BaseMethods>',
    '  <CellMethods>',
    '    <move/>',
    '  </CellMethods>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/entity_defs/types.xml', [
    '<root>',
    '  <ITEM_ID>UINT16</ITEM_ID>',
    '</root>'
  ].join('\n'));

  // base 侧 onSave 调用 cell 方法 move —— 跨进程伪引用,须被进程过滤剔除。
  write(root, 'scripts/base/Hero.py', [
    'class Hero(object):',
    '    def onSave(self, baseId, arg):',
    '        self.move()',
    ''
  ].join('\n'));

  // cell 侧 onReady 调用同进程 move —— 合法本地引用,须保留。
  write(root, 'scripts/cell/Hero.py', [
    'class Hero(object):',
    '    def move(self):',
    '        pass',
    '    def onReady(self):',
    '        self.move()',
    ''
  ].join('\n'));

  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
  stubWorkspace.findFiles = async () => {
    const results: Uri[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = p(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.def')) {
          results.push(Uri.file(full));
        }
      }
    };
    walk(root);
    return results;
  };

  (globalThis as { __defScopeManager?: EntityMappingManager }).__defScopeManager =
    new EntityMappingManager({ subscriptions: [] });
  const manager = managerRef();
  await until(() => manager.getAllMappings().length >= 1, 'initial scan');
});

afterAll(() => {
  managerRef().dispose();
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.openTextDocument = originalOpenTextDocument;
  stubWindow.showTextDocument = originalShowTextDocument;
  stubWorkspace.workspaceFolders = [];
  lastFileSystemWatcher.current = null;

  const root = (globalThis as { __defScopeRoot?: string }).__defScopeRoot;
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const managerRef = (): EntityMappingManager =>
  (globalThis as { __defScopeManager?: EntityMappingManager }).__defScopeManager as EntityMappingManager;

const root = (): string =>
  (globalThis as { __defScopeRoot?: string }).__defScopeRoot as string;

const cellHeroPy = (): string => p(root(), 'scripts', 'cell', 'Hero.py');
const baseHeroPy = (): string => p(root(), 'scripts', 'base', 'Hero.py');

describe('def 方法本地调用进程作用域', () => {
  it('索引 Hero 实体(含 base/cell 两段脚本)', () => {
    const mapping = managerRef().getMapping('Hero');
    expect(mapping?.name).toBe('Hero');
  });

  it('cell 方法 move 的本地引用只含 cell 侧 onReady,剔除 base 侧 onSave 的 self.move()', async () => {
    const incoming = await managerRef().getIncomingPythonMethodCalls(cellHeroPy(), 'move');
    expect(incoming).toHaveLength(1);
    expect(incoming[0].caller.methodName).toBe('onReady');
    expect(incoming[0].caller.filePath).toBe(cellHeroPy());
  });

  it('base 方法 onSave 的本地引用(若有)不受进程过滤误伤', async () => {
    // base 侧无同名方法调用,onSave 自身无传入调用 → 空
    const incoming = await managerRef().getIncomingPythonMethodCalls(baseHeroPy(), 'onSave');
    expect(incoming).toEqual([]);
  });
});
