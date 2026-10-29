import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cancelDatabaseSchemaSnapshotBuild,
  clearDatabaseSchemaCacheForTests,
  describePropertyDatabaseStoragePublished,
  getDatabaseSchemaCacheStatsForTests,
  scheduleDatabaseSchemaSnapshotBuild
} from '../src/databaseSchema';
import type { SchemaBuildGateOptions } from '../src/databaseSchema';
import { workspace } from './fake-vscode/workspaceState';

// IDE-REV-012(原项 IDE-SCH-006/007):属性 hover 冷 schema 查询只读已发布
// 结果——冷/失效 miss 只调度后台构建(可取消),不同步跑完生成器;发布后
// 字段说明正确。悬停面经 describePropertyDatabaseStoragePublished 单源。

const temporaryDirectories: string[] = [];

afterEach(() => {
  workspace.textDocuments = [];
  clearDatabaseSchemaCacheForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(): { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-rev12-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Gold/>\n</root>\n', 'utf8');
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

describe('IDE-REV-012:属性 hover 冷查询只读已发布结果', () => {
  it('冷查询返回 null 且不同步构建,调度后台构建发布后字段说明正确', async () => {
    const { root } = makeWorkspace();

    // 冷:只读已发布——无同步构建(缓存保持空,无 miss 计入),返回 null
    const cold = describePropertyDatabaseStoragePublished('Gold', 'gold', root);
    expect(cold).toBeNull();
    // 同步构建未发生:缓存保持空(调度的后台构建在闸点让出,尚未发布)
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(0);

    // 调度的后台构建发布后:同一路径读得正确字段说明(只读,不重建)
    await scheduleDatabaseSchemaSnapshotBuild('Gold', root);
    const published = describePropertyDatabaseStoragePublished('Gold', 'gold', root);
    expect(published).not.toBeNull();
    expect(published!.entityName).toBe('Gold');
    expect(published!.targets.length).toBeGreaterThan(0);
    expect(published!.targets[0].fieldName).toBe('sm_gold');
    expect(published!.targets[0].tableName).toBe('tbl_Gold');
    expect(getDatabaseSchemaCacheStatsForTests().hits).toBe(1);
  });

  it('构建期间可响应取消:取消后构建止步不发布', async () => {
    const { root } = makeWorkspace();
    let releaseGate: (() => void) | null = null;
    const options: SchemaBuildGateOptions = {
      gate: () => new Promise<boolean>(resolve => { releaseGate = () => resolve(true); })
    };
    const flight = scheduleDatabaseSchemaSnapshotBuild('Gold', root, options);

    expect(cancelDatabaseSchemaSnapshotBuild('Gold', root)).toBe(true);
    releaseGate!();
    expect(await flight).toBeNull(); // 取消止步:不发布
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(0);

    // 取消后再调度:全新构建可发布
    await scheduleDatabaseSchemaSnapshotBuild('Gold', root);
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(1);
  });

  it('同一实体在飞构建去重:两次调度复用同一 Promise', async () => {
    const { root } = makeWorkspace();
    const first = scheduleDatabaseSchemaSnapshotBuild('Gold', root);
    const second = scheduleDatabaseSchemaSnapshotBuild('Gold', root);
    expect(second).toBe(first);
    expect(await first).not.toBeNull();
  });
});
