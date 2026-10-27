import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Position } from './fake-vscode/core';
import { EntityMappingManager } from '../src/entityMapping';
import {
  PythonDefinitionProvider,
  setPythonMroJumpEnabled
} from '../src/languageProviders';
import { PythonClassIndex } from '../src/pythonClassIndex';
import { getPythonMemberAccessAtPosition } from '../src/pythonLanguageUtils';
import { makeTextDocument } from './helpers/vscodeStub';
import { resetScanRootCache } from '../src/scanRoots';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { Uri } from './helpers/vscodeStub';

// 批158(用户令 2026-10-26):非 self 接收者成员调用 avatar.SendErrorInfo(...)
// 可精确跳转 —— member-access 层;全项目 def walk 改共享倒排索引(一次建,
// 多名共享,不再每方法名全盘重走)。

const p = (root: string, ...segments: string[]) => path.join(root, ...segments);

const write = (root: string, relative: string, content: string): void => {
  const target = p(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const originalFindFiles = stubWorkspace.findFiles;

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-member-access-'));
  resetScanRootCache();
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'workspace', index: 0 }];
  stubWorkspace.findFiles = (async (pattern?: string) => {
    const out: Array<ReturnType<typeof Uri.file>> = [];
    const ext = pattern?.includes('*.def')
      ? '.def'
      : pattern?.includes('*.py')
        ? '.py'
        : null;
    if (!ext) {
      return out;
    }
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(ext)) {
          out.push(Uri.file(full));
        }
      }
    };
    walk(root);
    return out;
  }) as unknown as typeof stubWorkspace.findFiles;

  // 实体 Avatar:def 里声明 SendErrorInfo(BaseMethods)——用户报障的同形最小集
  write(root, 'scripts/entity_defs/Avatar.def', [
    '<root>',
    '  <BaseMethods>',
    '    <SendErrorInfo>',
    '      <Arg> STRING </Arg>',
    '      <Arg> UINT8 </Arg>',
    '    </SendErrorInfo>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  write(root, 'scripts/base/Avatar.py', [
    'class Avatar:',
    '    def onClientEnabled(self, entityCall):',
    '        pass'
  ].join('\n'));

  // 调用点:非 self 接收者(用户报障形态)
  write(root, 'scripts/cell/Monster.py', [
    'class Monster:',
    '    def onEnter(self, avatar):',
    '        avatar.SendErrorInfo("hp low", 1)'
  ].join('\n'));

  // 倒排索引口径:同文件多方法各自入桶(旧实现 break 等价语义)
  write(root, 'scripts/common/multi.py', [
    'class Multi:',
    '    def alpha(self):',
    '        pass',
    '',
    '    def beta(self):',
    '        pass'
  ].join('\n'));
});

afterAll(() => {
  stubWorkspace.findFiles = originalFindFiles;
  fs.rmSync(root, { recursive: true, force: true });
});

const charOf = (lineText: string, needle: string): number =>
  lineText.indexOf(needle) + needle.length;

describe('批158 member-access 层', () => {
  it('avatar.SendErrorInfo 精确跳到 Avatar.def 的声明行(小驼峰→帕斯卡变体)', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const provider = new PythonDefinitionProvider(manager);
    const file = p(root, 'scripts/cell/Monster.py');
    const text = fs.readFileSync(file, 'utf8');
    const document = makeTextDocument(text, { fileName: file, languageId: 'python' });
    const line = text.split('\n').findIndex(l => l.includes('avatar.SendErrorInfo'));
    const character = charOf(text.split('\n')[line], 'SendErrorInfo');

    const traced = await provider.provideDefinitionTraced(document, new Position(line, character));
    expect(traced.location).not.toBeNull();
    const location = Array.isArray(traced.location) ? traced.location[0]! : traced.location;
    expect(location.uri.fsPath.replace(/\\/g, '/')).toContain('Avatar.def');
    expect(traced.layers[0]).toMatchObject({ layer: 'member-access', status: 'hit' });
  });

  it('无同名实体/类时不误跳(member-access miss,location null)', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const provider = new PythonDefinitionProvider(manager);
    const file = p(root, 'scripts/cell/Monster.py');
    const text = [
      'class Monster:',
      '    def onTick(self, stranger):',
      '        stranger.NotAnythingHere(1)'
    ].join('\n');
    const document = makeTextDocument(text, { fileName: file, languageId: 'python' });
    const line = text.split('\n').findIndex(l => l.includes('stranger.NotAnythingHere'));
    const character = charOf(text.split('\n')[line], 'NotAnythingHere');

    const traced = await provider.provideDefinitionTraced(document, new Position(line, character));
    expect(traced.location).toBeNull();
    expect(traced.layers[0]).toMatchObject({ layer: 'member-access', status: 'miss' });
  });

  it('self. 访问不走 member-access 层(self 管线优先,层序不变)', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const provider = new PythonDefinitionProvider(manager);
    const file = p(root, 'scripts/base/Avatar.py');
    const text = fs.readFileSync(file, 'utf8');
    const text2 = text + '\n    def probe(self):\n        self.onClientEnabled(None)\n';
    const document2 = makeTextDocument(text2, { fileName: file, languageId: 'python' });
    const line2 = text2.split('\n').findIndex(l => l.includes('self.onClientEnabled'));
    const character = charOf(text2.split('\n')[line2], 'onClientEnabled');

    const traced = await provider.provideDefinitionTraced(document2, new Position(line2, character));
    const memberLayer = traced.layers.find(l => l.layer === 'member-access');
    expect(memberLayer).toBeUndefined();
  });
});

describe('批158 解析器形态(getPythonMemberAccessAtPosition)', () => {
  it('只认调用形:方法名后必须紧跟 (', () => {
    expect(getPythonMemberAccessAtPosition('avatar.SendErrorInfo("x", 1)', 10)).toMatchObject({
      receiverName: 'avatar',
      memberName: 'SendErrorInfo'
    });
    expect(getPythonMemberAccessAtPosition('callback = avatar.onSpawned', 20)).toBeNull();
    expect(getPythonMemberAccessAtPosition('self.SendErrorInfo("x")', 10)).toBeNull();
  });
});

describe('批158 共享倒排索引(每方法名首声明口径)', () => {
  it('同文件多方法各自入桶,第二方法名查询不再全盘重走', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    manager.ensureStartup();
    const first = await manager.resolveMethodImplementationGlobally('alpha');
    const second = await manager.resolveMethodImplementationGlobally('beta');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.filePath.replace(/\\/g, '/')).toContain('multi.py');
    expect(second!.filePath.replace(/\\/g, '/')).toContain('multi.py');
    expect(second!.line).toBeGreaterThan(first!.line);
  });

  setPythonMroJumpEnabled(true);
  it('倒排索引与形参闸门兼容(declaredArgTypes 过滤仍生效)', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    manager.ensureStartup();
    const hit = await manager.resolveMethodImplementationGlobally('onClientEnabled', 'base');
    expect(hit).not.toBeNull();
    expect(hit!.filePath.replace(/\\/g, '/')).toContain('Avatar.py');
  });
});

describe('IDE-IDX-017 同文件成员跳转只查当前文件快照', () => {
  it('全仓扫描挂起时 SameFile.helper 仍能跳转且不触发 ensureScanned', async () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const index = new PythonClassIndex();
    // 全仓扫描挂起模型:ensureScanned 永远失败并记账(证明同文件路径不再依赖它)
    let ensureScannedCalls = 0;
    (index as unknown as { ensureScanned: () => Promise<void> }).ensureScanned = () => {
      ensureScannedCalls += 1;
      return Promise.reject(new Error('workspace scan held'));
    };
    const provider = new PythonDefinitionProvider(manager, index);
    const file = p(root, 'scripts/cell/SameFile.py');
    const text = [
      'class SameFile:',
      '    def helper(self):',
      '        pass',
      '',
      '    def caller(self):',
      '        SameFile.helper()'
    ].join('\n');
    const document = makeTextDocument(text, { fileName: file, languageId: 'python' });
    const line = text.split('\n').findIndex(l => l.includes('SameFile.helper()'));
    const character = charOf(text.split('\n')[line], 'helper');

    const traced = await provider.provideDefinitionTraced(document, new Position(line, character));
    expect(traced.location).not.toBeNull();
    const location = Array.isArray(traced.location) ? traced.location[0]! : traced.location;
    expect(location.uri.fsPath.replace(/\\/g, '/')).toContain('SameFile.py');
    expect(location.range.start.line).toBe(1);
    expect(ensureScannedCalls).toBe(0);
  }, 10000);
});
