import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { findOwnerSelfPropertyAccesses } from '../src/pythonSelfScope';
import { Uri, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-AUD-028(R2-F05):属性引用按 owner 文件原文正则扫描,结果混入字符串、
// 注释、同文件另一普通类、嵌套重绑 self 的 self.hp。本测试锁定词法/作用域
// 过滤:只保留 owner 类直接方法内「self 即 owner 实例」的真读写点。

const HERO_PY_FIXTURE = [
  'class Hero:',
  '    def tick(self):',
  '        self.hp = 1',
  '        text = "self.hp"',
  '        # self.hp',
  'class Other:',
  '    def tick(self):',
  '        self.hp = 2',
  ''
].join('\n');

describe('findOwnerSelfPropertyAccesses 词法与作用域过滤(AUD-028)', () => {
  it('R2-F05 复现:只收 owner 类真写点,字符串/注释/其它类排除', () => {
    const accesses = findOwnerSelfPropertyAccesses(HERO_PY_FIXTURE, 'Hero', 'hp');
    // 复现行(1 基)3/4/5/8 均入结果 → 现只 0 基行 2(=1 基 3)保留
    expect(accesses).toEqual([{ line: 2, character: 13 }]);
  });

  it('嵌套重绑 self(def helper(self))排除;闭包(无 self 首参)保留', () => {
    const content = [
      'class Hero:',
      '    def tick(self):',
      '        def helper(self):', // 重绑 self → 非 owner 实例
      '            self.hp = 1',
      '        def closure():',    // 闭包,无 self 首参 → 沿用外层 self
      '            self.hp = 2',
      '        self.hp = 3',
      ''
    ].join('\n');
    const accesses = findOwnerSelfPropertyAccesses(content, 'Hero', 'hp');
    // 0 基行 5(closure 内)与 6(方法体)保留;行 3(helper 重绑)排除
    expect(accesses.map(access => access.line)).toEqual([5, 6]);
  });

  it('嵌套类方法排除:类内类的 self 非 owner 实例', () => {
    const content = [
      'class Hero:',
      '    class Inner:',
      '        def go(self):',
      '            self.hp = 1',
      '    def tick(self):',
      '        self.hp = 2',
      ''
    ].join('\n');
    const accesses = findOwnerSelfPropertyAccesses(content, 'Hero', 'hp');
    expect(accesses.map(access => access.line)).toEqual([5]);
  });

  it('方法调用 self.hp( 排除(NAV-003 面),模块级函数 self 排除', () => {
    const content = [
      'class Hero:',
      '    def tick(self):',
      '        self.hp()',
      '        self.hp = 1',
      'def helper(self):',
      '    self.hp = 2',
      ''
    ].join('\n');
    const accesses = findOwnerSelfPropertyAccesses(content, 'Hero', 'hp');
    expect(accesses.map(access => access.line)).toEqual([3]);
  });

  it('多行字符串与三引号内 self.hp 排除(掩码跨行)', () => {
    const content = [
      'class Hero:',
      '    def tick(self):',
      '        x = """self.hp',
      'still string"""',
      '        self.hp = 1',
      ''
    ].join('\n');
    const accesses = findOwnerSelfPropertyAccesses(content, 'Hero', 'hp');
    expect(accesses.map(access => access.line)).toEqual([4]);
  });
});

describe('getIncomingPythonPropertyAccesses 集成:owner 类作用域过滤(AUD-028)', () => {
  it('真 owner 文件只收 Hero 真写点,Other/字符串/注释不进', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-aud028-'));
    const put = (relative: string, content: string): string => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return file;
    };
    const heroDef = put('scripts/entity_defs/Hero.def', '<root><Properties><hp><Type>UINT32</Type></hp></Properties></root>');
    const heroPy = put('scripts/base/Hero.py', HERO_PY_FIXTURE);
    put('scripts/entity_defs/Other.def', '<root><Properties><hp><Type>UINT32</Type></hp></Properties></root>');
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const originalFindFiles = stubWorkspace.findFiles;
    stubWorkspace.findFiles = (async (glob?: string) =>
      glob === '**/*.def' ? [Uri.file(heroDef)] : []) as typeof stubWorkspace.findFiles;
    try {
      const manager = new EntityMappingManager({ subscriptions: [] } as never);
      await (manager as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
      const accesses = await manager.getIncomingPythonPropertyAccesses(heroDef, 'hp');
      // 复现行(1 基)3/4/5/8 均入结果 → 现只 1 基行 3 保留,且都属 Hero.py
      expect(accesses).toEqual([{ filePath: heroPy, line: 3, character: 13 }]);
    } finally {
      stubWorkspace.findFiles = originalFindFiles;
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
