import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDatabaseSchemaSnapshot, isDatabaseSchemaSnapshotStale } from '../src/databaseSchema';
import type { DatabaseSchemaSnapshot } from '../src/databaseSchema';
import {
  bumpRootConfigGeneration,
  getRootConfigGeneration,
  resetRootConfigGenerationForTests
} from '../src/rootConfigGeneration';
import { workspace } from './fake-vscode/workspaceState';

// IDE-SNP-010:根配置 generation 纳入快照身份——扫描根集与运行域配置是派生
// 快照的隐性输入,文件版本清单(SNP-006)只覆盖文件面;assetsRoot/运行域
// 配置变化后,持旧 generation 的快照必须判过期,不得被误复用。

const temporaryDirectories: string[] = [];

afterEach(() => {
  workspace.textDocuments = [];
  resetRootConfigGenerationForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(): { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-snp10-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Gold hasBase="true"/>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), [
    '<root>',
    '  <Properties>',
    '    <gold>',
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    '    </gold>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'), '<root>\n</root>\n', 'utf8');
  return { root };
}

describe('IDE-SNP-010:根配置 generation 纳入快照身份', () => {
  it('generation 单调递增,bump 记原因,reset 回测试基线', () => {
    resetRootConfigGenerationForTests();
    const before = getRootConfigGeneration();
    expect(bumpRootConfigGeneration('assetsRoot')).toBe(before + 1);
    expect(bumpRootConfigGeneration('workspace-folders')).toBe(before + 2);
    expect(getRootConfigGeneration()).toBe(before + 2);
    resetRootConfigGenerationForTests();
    expect(getRootConfigGeneration()).toBe(before);
  });

  it('快照身份携带构建时的根配置 generation', () => {
    const { root } = makeWorkspace();
    bumpRootConfigGeneration('assetsRoot');
    const generationAtBuild = getRootConfigGeneration();
    const snapshot = getDatabaseSchemaSnapshot('Gold', root);
    expect(snapshot).not.toBeNull();
    expect((snapshot as DatabaseSchemaSnapshot).rootConfigGeneration).toBe(generationAtBuild);
  });

  it('文件一字未动,根配置 generation 前进即判过期(旧结果不得误复用)', () => {
    const { root } = makeWorkspace();
    const snapshot = getDatabaseSchemaSnapshot('Gold', root);
    expect(snapshot).not.toBeNull();
    expect(isDatabaseSchemaSnapshotStale(snapshot as DatabaseSchemaSnapshot)).toBe(false);

    bumpRootConfigGeneration('assetsRoot'); // 模拟 assetsRoot 切换,输入文件全未变

    expect(isDatabaseSchemaSnapshotStale(snapshot as DatabaseSchemaSnapshot)).toBe(true);

    // 重建后的新快照携带新 generation,恢复 fresh
    const rebuilt = getDatabaseSchemaSnapshot('Gold', root);
    expect((rebuilt as DatabaseSchemaSnapshot).rootConfigGeneration).toBe(getRootConfigGeneration());
    expect(isDatabaseSchemaSnapshotStale(rebuilt as DatabaseSchemaSnapshot)).toBe(false);
  });

  it('运行域配置面同样走 generation:db.tablePrefix 变更语义等价 bump', () => {
    const { root } = makeWorkspace();
    const snapshot = getDatabaseSchemaSnapshot('Gold', root);
    bumpRootConfigGeneration('db-config');
    expect(isDatabaseSchemaSnapshotStale(snapshot as DatabaseSchemaSnapshot)).toBe(true);
  });

  it('旧快照缺 generation 字段:防御不过期(与 inputVersions 缺清单同口径)', () => {
    const { root } = makeWorkspace();
    const snapshot = getDatabaseSchemaSnapshot('Gold', root) as DatabaseSchemaSnapshot;
    const legacy: DatabaseSchemaSnapshot = { ...snapshot } as DatabaseSchemaSnapshot;
    delete (legacy as { rootConfigGeneration?: number }).rootConfigGeneration;
    expect(isDatabaseSchemaSnapshotStale(legacy)).toBe(false);
  });

  it('打开的脏文档版本前进仍优先判过期(generation 与文件版本双轴并行)', () => {
    const { root } = makeWorkspace();
    const defPath = path.join(root, 'scripts/entity_defs/Gold.def');
    const snapshot = getDatabaseSchemaSnapshot('Gold', root);
    workspace.textDocuments = [
      { uri: { toString: () => `file://${defPath}`, fsPath: defPath }, version: 3, getText: () => '<root/>', fileName: defPath }
    ];
    expect(isDatabaseSchemaSnapshotStale(snapshot as DatabaseSchemaSnapshot)).toBe(true);
    workspace.textDocuments = [];
  });
});
