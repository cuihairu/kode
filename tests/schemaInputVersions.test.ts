import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDatabaseSchemaSnapshot, isDatabaseSchemaSnapshotStale, invalidateDatabaseSchemaCacheForFiles } from '../src/databaseSchema';
import type { DatabaseSchemaSnapshot } from '../src/databaseSchema';
import { workspace } from './fake-vscode/workspaceState';

// IDE-SNP-006:派生结果记录输入版本清单——schema 快照自带「所消费共享快照
// 文件 → 来源域+版本」清单,任一依赖再读后 source/version 漂移即可判过期。

const temporaryDirectories: string[] = [];

afterEach(() => {
  workspace.textDocuments = [];
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(): { root: string; defPath: string; parentPath: string; typesPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-snp6-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Gold hasBase="true"/>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Base.def'), [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), [
    '<root>',
    '  <Parent>Base</Parent>',
    '  <Properties>',
    '    <gold>',
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    '    </gold>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'), '<root>\n</root>\n', 'utf8');
  return {
    root,
    defPath: path.join(root, 'scripts/entity_defs/Gold.def'),
    parentPath: path.join(root, 'scripts/entity_defs/Base.def'),
    typesPath: path.join(root, 'scripts/entity_defs/types.xml')
  };
}

function openDocument(fsPath: string, version: number, text: string): void {
  workspace.textDocuments = [
    ...workspace.textDocuments,
    { uri: { toString: () => `file://${fsPath}`, fsPath }, version, getText: () => text }
  ];
}

describe('IDE-SNP-006:派生结果记录输入版本清单', () => {
  it('快照列出所消费文件与版本:脏 def/types 记文档域序号,未打开父 def 记磁盘域 mtimeMs', () => {
    const { root, defPath, parentPath, typesPath } = makeWorkspace();
    openDocument(defPath, 8, [
      '<root>',
      '  <Parent>Base</Parent>',
      '  <Properties>',
      '    <gold>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </gold>',
      '    <extra>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </extra>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    openDocument(typesPath, 2, '<root>\n</root>\n');

    const snapshot = getDatabaseSchemaSnapshot('Gold', root);
    expect(snapshot).not.toBeNull();

    const inputVersions = snapshot!.inputVersions ?? {};
    expect(inputVersions[defPath]).toEqual({ source: 'document', version: 8 });
    expect(inputVersions[typesPath]).toEqual({ source: 'document', version: 2 });
    expect(inputVersions[parentPath]).toEqual({
      source: 'disk',
      version: fs.statSync(parentPath).mtimeMs
    });
  });

  it('任一依赖变更后可判定过期:版本前进/来源翻转→stale,重建后→fresh', () => {
    const { root, defPath, typesPath } = makeWorkspace();
    openDocument(defPath, 8, '<root>\n  <Properties>\n  </Properties>\n</root>\n');
    openDocument(typesPath, 2, '<root>\n</root>\n');

    const built = getDatabaseSchemaSnapshot('Gold', root)!;
    expect(isDatabaseSchemaSnapshotStale(built)).toBe(false);

    // 同一文档版本前进(继续编辑) → 旧清单对账面判过期
    // (IDE-REV-011:查询热命中不再懒重读清单,版本前进由编辑事件面
    // invalidateDatabaseSchemaCacheForFiles 摘除;本函数保留为对账面)
    workspace.textDocuments = [];
    openDocument(defPath, 9, '<root>\n  <Properties>\n  </Properties>\n</root>\n');
    openDocument(typesPath, 2, '<root>\n</root>\n');
    expect(isDatabaseSchemaSnapshotStale(built)).toBe(true);

    // 事件面摘除 → 重建 → 新清单 fresh
    invalidateDatabaseSchemaCacheForFiles([defPath]);
    const rebuilt = getDatabaseSchemaSnapshot('Gold', root)!;
    expect(isDatabaseSchemaSnapshotStale(rebuilt)).toBe(false);

    // 关闭脏文档(来源翻转 document → disk) → 对账面判旧清单过期
    workspace.textDocuments = [];
    expect(isDatabaseSchemaSnapshotStale(rebuilt)).toBe(true);

    // 关闭后事件面摘除 → 重建 → fresh
    invalidateDatabaseSchemaCacheForFiles([defPath]);
    expect(isDatabaseSchemaSnapshotStale(getDatabaseSchemaSnapshot('Gold', root)!)).toBe(false);
  });

  it('无清单的旧快照视为不过期(防御面:清单缺失不误伤)', () => {
    const legacy = { backend: 'mysql', entityName: 'X', tables: [], tableIndex: new Map() } as unknown as DatabaseSchemaSnapshot;
    expect(isDatabaseSchemaSnapshotStale(legacy)).toBe(false);
  });
});
