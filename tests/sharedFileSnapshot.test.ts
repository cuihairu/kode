import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readSharedFileSnapshot,
  type SharedFileSnapshotDeps,
  type SharedFileSnapshotDocument
} from '../src/sharedFileSnapshot';
import { workspace } from './fake-vscode/workspaceState';
import { getSemanticIndex, resetSemanticTypeRegistryForTests } from '../src/semanticIndex';

const temporaryDirectories: string[] = [];
afterEach(() => {
  workspace.textDocuments = [];
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeOpenDocument(fsPath: string, text: string, version: number): SharedFileSnapshotDocument {
  return {
    uri: { toString: () => `file://${fsPath}`, fsPath },
    version,
    getText: () => text
  };
}

function fixtureDeps(overrides: Partial<SharedFileSnapshotDeps> = {}): SharedFileSnapshotDeps & {
  diskReads: string[];
} {
  const diskReads: string[] = [];
  const deps: SharedFileSnapshotDeps & { diskReads: string[] } = {
    diskReads,
    listOpenDocuments: () => workspace.textDocuments as SharedFileSnapshotDocument[],
    readDiskFile: fsPath => {
      diskReads.push(fsPath);
      return overrides.readDiskFile ? overrides.readDiskFile(fsPath) : null;
    },
    statDiskFile: fsPath => overrides.statDiskFile?.(fsPath) ?? { mtimeMs: 1000 },
    resolveRootId: fsPath => overrides.resolveRootId?.(fsPath) ?? null
  };
  return deps;
}

describe('IDE-SNP-001:共享文件快照读取接口', () => {
  it('打开文档优先:内容/版本取编辑器缓冲区,不读磁盘', () => {
    workspace.textDocuments = [makeOpenDocument('/ws/entity_defs/Avatar.def', '<root><Dirty/></root>', 7)];
    const deps = fixtureDeps({ readDiskFile: () => '<root><Disk/></root>' });
    const snapshot = readSharedFileSnapshot('/ws/entity_defs/Avatar.def', deps);
    expect(snapshot).toMatchObject({
      rootId: null,
      fsPath: '/ws/entity_defs/Avatar.def',
      version: 7,
      content: '<root><Dirty/></root>',
      source: 'document'
    });
    expect(deps.diskReads, '打开文档在位时不得读盘').toEqual([]);
  });

  it('未打开文件从磁盘补载:版本=mtimeMs,不要求打开其他文档', () => {
    const deps = fixtureDeps({
      readDiskFile: () => '<root><Disk/></root>',
      statDiskFile: () => ({ mtimeMs: 1729123456789 })
    });
    const snapshot = readSharedFileSnapshot('/ws/entity_defs/Monster.def', deps);
    expect(snapshot).toMatchObject({
      rootId: null,
      fsPath: '/ws/entity_defs/Monster.def',
      version: 1729123456789,
      content: '<root><Disk/></root>',
      source: 'disk'
    });
    // 读取过程不得把文件塞进打开文档清单(接口不提供打开其他文档的能力)
    expect(workspace.textDocuments).toEqual([]);
    expect(deps.diskReads).toEqual(['/ws/entity_defs/Monster.def']);
  });

  it('rootId 经注入的根解析器透传:登记根命中,未登记为 null', () => {
    const deps = fixtureDeps({
      readDiskFile: () => 'x',
      resolveRootId: fsPath => (fsPath.startsWith('/ws/') ? '/ws' : null)
    });
    expect(readSharedFileSnapshot('/ws/a.def', deps)?.rootId).toBe('/ws');
    expect(readSharedFileSnapshot('/other/a.def', deps)?.rootId).toBeNull();
  });

  it('URI 身份归一:查询路径与文档 URI 拼写不同仍命中同一打开文档', () => {
    workspace.textDocuments = [makeOpenDocument('/ws/scripts/Base.py', 'class Base: pass', 3)];
    const deps = fixtureDeps({ readDiskFile: () => 'disk' });
    const snapshot = readSharedFileSnapshot('/ws/scripts/Base.py', deps);
    expect(snapshot).toMatchObject({ source: 'document', version: 3, content: 'class Base: pass' });
    expect(deps.diskReads).toEqual([]);
  });

  it('打开文档与磁盘皆无 → null', () => {
    const deps = fixtureDeps();
    expect(readSharedFileSnapshot('/ws/missing.def', deps)).toBeNull();
  });

  it('默认依赖(生产接线):打开文档走缓冲区,未打开走真实磁盘+mtime,rootId 走语义索引根', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-snapshot-'));
    temporaryDirectories.push(root);
    const defPath = path.join(root, 'Avatar.def');
    fs.writeFileSync(defPath, '<root><Disk/></root>');
    const mtimeMs = fs.statSync(defPath).mtimeMs;
    resetSemanticTypeRegistryForTests();
    getSemanticIndex().registerRoot(root);
    try {
      // 未打开:磁盘补载,版本=真实 mtimeMs,rootId=登记根
      const disk = readSharedFileSnapshot(defPath);
      expect(disk).toMatchObject({ source: 'disk', content: '<root><Disk/></root>', rootId: root.replace(/\\/g, '/') });
      expect(disk?.version).toBe(mtimeMs);
      // 已打开(脏缓冲):缓冲区优先,版本=编辑序号
      workspace.textDocuments = [makeOpenDocument(defPath, '<root><Dirty/></root>', 12)];
      const live = readSharedFileSnapshot(defPath);
      expect(live).toMatchObject({ source: 'document', content: '<root><Dirty/></root>', version: 12 });
    } finally {
      resetSemanticTypeRegistryForTests();
      getSemanticIndex();
    }
  });
});
