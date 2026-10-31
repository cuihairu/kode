import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { findOwnerSelfReceiverCalls } from '../src/pythonSelfScope';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-AUD-029(R2-F06):receiver RPC 调用按 owner 文件原文正则扫描,结果混入
// 字符串、注释、同文件另一普通类、嵌套重绑 self 的 self.cell.X(。本测试锁定
// 词法/作用域过滤:只保留 owner 类直接方法内「self 即 owner 实例」的真调用点。

const HERO_PY_FIXTURE = [
  'class Hero:',
  '    def tick(self):',
  '        self.cell.sayHi()',
  '        text = "self.cell.sayHi()"',
  '        # self.cell.sayHi()',
  'class Other:',
  '    def tick(self):',
  '        self.cell.sayHi()',
  ''
].join('\n');

describe('findOwnerSelfReceiverCalls 词法与作用域过滤(AUD-029)', () => {
  it('R2-F06 复现:只收 owner 类真调用,字符串/注释/其它类排除', () => {
    const calls = findOwnerSelfReceiverCalls(HERO_PY_FIXTURE, 'Hero', 'cell', 'sayHi');
    // 复现行(1 基)3/4/7(注释 5 亦入)均入结果 → 现只 0 基行 2(=1 基 3)保留
    expect(calls).toEqual([{ line: 2, character: 18 }]);
  });

  it('嵌套重绑 self(def helper(self))排除;闭包(无 self 首参)保留', () => {
    const content = [
      'class Hero:',
      '    def tick(self):',
      '        def helper(self):', // 重绑 self → 非 owner 实例
      '            self.cell.sayHi()',
      '        def closure():',    // 闭包,无 self 首参 → 沿用外层 self
      '            self.cell.sayHi()',
      '        self.cell.sayHi()',
      ''
    ].join('\n');
    const calls = findOwnerSelfReceiverCalls(content, 'Hero', 'cell', 'sayHi');
    // 0 基行 5(closure 内)与 6(方法体)保留;行 3(helper 重绑)排除
    expect(calls.map(call => call.line)).toEqual([5, 6]);
  });

  it('嵌套类方法排除:类内类的 self 非 owner 实例', () => {
    const content = [
      'class Hero:',
      '    class Inner:',
      '        def go(self):',
      '            self.cell.sayHi()',
      '    def tick(self):',
      '        self.cell.sayHi()',
      ''
    ].join('\n');
    const calls = findOwnerSelfReceiverCalls(content, 'Hero', 'cell', 'sayHi');
    expect(calls.map(call => call.line)).toEqual([5]);
  });

  it('receiver 段隔离:cell 只收 self.cell.sayHi(,不串 base/client', () => {
    const content = [
      'class Hero:',
      '    def tick(self):',
      '        self.cell.sayHi()',
      '        self.base.sayHi()',
      '        self.client.sayHi()',
      ''
    ].join('\n');
    const cellCalls = findOwnerSelfReceiverCalls(content, 'Hero', 'cell', 'sayHi');
    expect(cellCalls.map(call => call.line)).toEqual([2]);
    const baseCalls = findOwnerSelfReceiverCalls(content, 'Hero', 'base', 'sayHi');
    expect(baseCalls.map(call => call.line)).toEqual([3]);
    const clientCalls = findOwnerSelfReceiverCalls(content, 'Hero', 'client', 'sayHi');
    expect(clientCalls.map(call => call.line)).toEqual([4]);
  });

  it('非调用形态(无括号)排除', () => {
    const content = [
      'class Hero:',
      '    def tick(self):',
      '        handler = self.cell.sayHi',
      '        self.cell.sayHi()',
      ''
    ].join('\n');
    const calls = findOwnerSelfReceiverCalls(content, 'Hero', 'cell', 'sayHi');
    expect(calls.map(call => call.line)).toEqual([3]);
  });

  it('多行字符串与三引号内 self.cell.sayHi( 排除(掩码跨行)', () => {
    const content = [
      'class Hero:',
      '    def tick(self):',
      '        x = """self.cell.sayHi()',
      'still string"""',
      '        self.cell.sayHi()',
      ''
    ].join('\n');
    const calls = findOwnerSelfReceiverCalls(content, 'Hero', 'cell', 'sayHi');
    expect(calls.map(call => call.line)).toEqual([4]);
  });
});

describe('getIncomingPythonReceiverCalls 集成:owner 类作用域过滤(AUD-029)', () => {
  it('真 owner 文件只收 Hero 真调用,Other/字符串/注释不进', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-aud029-'));
    const put = (relative: string, content: string): string => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return file;
    };
    const heroDef = put(
      'scripts/entity_defs/Hero.def',
      '<root><CellMethods><sayHi></sayHi></CellMethods></root>'
    );
    const heroPy = put('scripts/base/Hero.py', HERO_PY_FIXTURE);
    put('scripts/entity_defs/Other.def', '<root><CellMethods><sayHi></sayHi></CellMethods></root>');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (glob?: string) =>
      glob === '**/*.def' ? [Uri.file(heroDef)] : []) as typeof stubWorkspace.findFiles;
    try {
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      await (manager as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
      const calls = await manager.getIncomingPythonReceiverCalls(heroDef, 'sayHi', 'cell');
      // 复现行(1 基)3/4/7(注释 5 亦入)均入结果 → 现只 1 基行 3 保留,且都属 Hero.py
      expect(calls).toEqual([{ filePath: heroPy, line: 3, character: 18 }]);
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
