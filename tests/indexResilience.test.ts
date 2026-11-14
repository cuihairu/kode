import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Position, Uri, makeTextDocument } from './fake-vscode/core';
import { workspace as stubWorkspace } from './fake-vscode/workspaceState';
import { EntityMappingManager } from '../src/entityMapping';
import { PythonClassIndex } from '../src/backend/pythonClassIndex';
import { IndexScheduler, IndexTaskPriority } from '../src/backend/indexScheduler';
import { PythonDefinitionProvider } from '../src/languageProviders';
import { resetScanRootCache } from '../src/scanRoots';

// RUST-030 韧性面单测:①损坏索引自动回建——截断 def 启动不阻塞、修复后重建
 // 实体回位;②py 损坏容错——语法错文档解析不抛、修复后基类解析恢复;
 // ③失败重试——调度器失败终态出表后 ensureTask 同键重跑成功。
// (杀进程恢复面=kodeCoreE2E CORE-015/016/E-2 真实二进制已覆盖;取消面=
//  indexScheduler 终态计数已覆盖,此处不重复。)

const p = (root: string, ...relative: string[]): string => path.join(root, ...relative);

const write = (root: string, relative: string, content: string): void => {
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

const pointAt = (root: string): void => {
  resetScanRootCache();
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  stubWorkspace.findFiles = async (): Promise<Uri[]> => {
    const results: Uri[] = [];
    const walk = (dir: string): void => {
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
};

const AVATAR_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE</Flags>',
  '    </hp>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <onSave>',
  '      <Exposed/>',
  '    </onSave>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const BROKEN_DEF = [
  '<root>',
  '  <Properties>',
  '    <frag>',
  '      <Type>UINT32</Type>'
  // 故意截断:无 </Properties>、无 </root>(解析位抛错,调用方跳过为容错语义)
].join('\n');

const mappingNames = (manager: EntityMappingManager): Set<string> =>
  new Set(manager.getAllMappings().map(mapping => mapping.name));

beforeAll(() => {
  stubWorkspace.workspaceFolders = [];
});

afterAll(() => {
  stubWorkspace.findFiles = originalFindFiles;
  stubWorkspace.workspaceFolders = [];
});

describe('RUST-030 损坏索引自动回建与失败重试', () => {
  it('截断 def 不阻塞首扫,修复盘上文件后重建实体回位', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-resilience-'));
    write(root, 'scripts/entities.xml', '<root>\n  <Avatar hasBase="true"/>\n  <Broken hasBase="true"/>\n</root>');
    write(root, 'scripts/entity_defs/Avatar.def', AVATAR_DEF);
    write(root, 'scripts/entity_defs/Broken.def', BROKEN_DEF);

    pointAt(root);
    const damaged = new EntityMappingManager({ subscriptions: [] } as never);
    await damaged.waitForInitialScan();
    // 损坏面:首扫照常收尾,Avatar 建档,Broken 跳过(解析位抛错=容错语义)
    const damagedNames = mappingNames(damaged);
    expect(damagedNames.has('Avatar')).toBe(true);
    expect(damagedNames.has('Broken')).toBe(false);
    damaged.dispose();

    // 修复盘上文件 → 重建(manager 全量再索引)= 损坏索引自动回建
    write(root, 'scripts/entity_defs/Broken.def', AVATAR_DEF.replace(/Avatar/g, 'Broken'));
    const repaired = new EntityMappingManager({ subscriptions: [] } as never);
    await repaired.waitForInitialScan();
    const repairedNames = mappingNames(repaired);
    expect(repairedNames.has('Broken')).toBe(true);
    expect(repairedNames.has('Avatar')).toBe(true);
    repaired.dispose();
  }, 60000);

  it('py 语法错文档解析不抛,修复后基类解析恢复', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-resilience-py-'));
    write(root, 'scripts/entities.xml', '<root>\n  <Avatar hasBase="true"/>\n</root>');
    write(root, 'scripts/entity_defs/Avatar.def', AVATAR_DEF);
    write(root, 'scripts/base/Avatar.py', 'class Avatar(object):\n    def onSave(self):\n        pass\n');
    pointAt(root);

    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    const index = new PythonClassIndex();
    const pyDef = new PythonDefinitionProvider(manager, index);
    await manager.waitForInitialScan();
    await index.waitForInitialScan();

    const avatarPath = p(root, 'scripts/base/Avatar.py');
    const cellPath = p(root, 'scripts/base/CellAvatar.py');
    const cellText = 'class CellAvatar(Avatar):\n    pass\n';
    const cellDoc = makeTextDocument(cellText, {
      fileName: cellPath, languageId: 'python', uri: Uri.file(cellPath)
    });
    Object.assign(cellDoc, { version: 1 });
    await index.onDocumentChanged(cellDoc);
    const basePos = new Position(0, cellText.indexOf('(Avatar') + 1);
    expect(await pyDef.provideDefinition(cellDoc, basePos)).not.toBeNull();

    // 损坏:语法错文档进索引(容错解析,不抛;基类解析断——Avatar 类表被坏版顶掉)
    const corruptText = 'def broken(:\n  pass\n';
    const corruptDoc = makeTextDocument(corruptText, {
      fileName: avatarPath, languageId: 'python', uri: Uri.file(avatarPath)
    });
    Object.assign(corruptDoc, { version: 2 });
    await expect(index.onDocumentChanged(corruptDoc)).resolves.toBeUndefined();

    // 修复回建:合法内容重新登记 → 基类解析恢复
    const repairedDoc = makeTextDocument('class Avatar(object):\n    def onSave(self):\n        pass\n', {
      fileName: avatarPath, languageId: 'python', uri: Uri.file(avatarPath)
    });
    Object.assign(repairedDoc, { version: 3 });
    await index.onDocumentChanged(repairedDoc);
    expect(await pyDef.provideDefinition(cellDoc, basePos)).not.toBeNull();
    manager.dispose();
  }, 60000);

  it('调度器失败终态出表后,同键 ensureTask 重跑成功', async () => {
    const scheduler = new IndexScheduler({ interactiveCooldownMs: 1 });
    let attempts = 0;
    // 首跑失败(拒绝=该次尝试失败,可恢复不算永久状态)
    await expect(
      scheduler.enqueue({
        kind: 'single-file-update',
        priority: IndexTaskPriority.CurrentFileLight,
        filePath: '/r030.py',
        version: 1,
        run: async () => {
          attempts += 1;
          throw new Error('transient');
        }
      }).wait
    ).rejects.toThrow('transient');
    expect(scheduler.getStatus().failed).toBe(1);

    // 同键重跑:失败已终态出表,ensureTask 重新执行并成功(重试面)
    await scheduler.ensureTask('/r030.py:v2', () => ({
      kind: 'single-file-update' as const,
      priority: IndexTaskPriority.CurrentFileLight,
      filePath: '/r030.py',
      version: 2,
      run: async () => {
        attempts += 1;
      }
    }));
    expect(attempts).toBe(2);
    expect(scheduler.getStatus().completed).toBe(1);
    scheduler.dispose();
  });
});
