import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexScheduler } from '../src/indexScheduler';
import { scheduleBackgroundSchemaWarmup } from '../src/schemaWarmup';
import {
  buildDatabaseSchemaSnapshotAsync,
  clearDatabaseSchemaCacheForTests,
  getDatabaseSchemaCacheStatsForTests,
  getDatabaseSchemaSnapshot
} from '../src/databaseSchema';
import { workspace } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';

// 2026-10-28 审核整改(SCH-006):预热任务体此前仍同步调用
// getDatabaseSchemaSnapshot——取消只在人工闸门(beforeBuild)处生效,
// 构建中段既不让出宿主也不可止步。整改:schema 构建管线改为阶段生成器,
// 阶段间设闸(让出宿主 + 检查取消),同步查询面直通驱动(行为不变),
// 预热面走异步驱动(阶段间 setImmediate 让出,取消即刻止步不发布)。
// 验收(审核令):不能只用「排入后台队列」或「缓存命中次数」——须证构建
// 期间事件循环可响应(定时器),且取消发生在构建中段也不产出快照。

const temporaryDirectories: string[] = [];
const originalFolders = workspace.workspaceFolders;

afterEach(() => {
  workspace.textDocuments = [];
  workspace.workspaceFolders = originalFolders;
  clearDatabaseSchemaCacheForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(entityNames: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch6gate-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'),
    `<root>\n${entityNames.map(name => `  <${name}/>`).join('\n')}\n</root>\n`, 'utf8');
  for (const name of entityNames) {
    fs.writeFileSync(path.join(root, 'scripts/entity_defs', `${name}.def`), [
      '<root>',
      '  <Properties>',
      '    <value>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </value>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
  }
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'), '<root>\n</root>\n', 'utf8');
  return root;
}

describe('2026-10-28 审核整改:schema 构建阶段闸(让出+中段取消)', () => {
  it('中段取消:阶段闸返回 false 即止步,null 且不发布缓存', async () => {
    const root = makeWorkspace(['Gold']);
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    let gateCalls = 0;
    const built = await buildDatabaseSchemaSnapshotAsync('Gold', root, {
      gate: () => { gateCalls += 1; return gateCalls < 3; } // 第 3 道闸取消
    });
    expect(built).toBeNull();
    expect(gateCalls).toBe(3);
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(0); // 未发布
  });

  it('无闸直通:异步产出与同步快照内容一致(表/实体/清单)', async () => {
    const root = makeWorkspace(['Gold']);
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const asyncBuilt = await buildDatabaseSchemaSnapshotAsync('Gold', root);
    clearDatabaseSchemaCacheForTests();
    const syncBuilt = getDatabaseSchemaSnapshot('Gold', root);
    expect(asyncBuilt).not.toBeNull();
    expect(syncBuilt).not.toBeNull();
    expect(asyncBuilt!.entityName).toBe(syncBuilt!.entityName);
    expect(asyncBuilt!.tables.map(t => t.name)).toEqual(syncBuilt!.tables.map(t => t.name));
    expect(asyncBuilt!.inputVersions).toEqual(syncBuilt!.inputVersions);
  });

  it('预热构建期间事件循环可响应:定时器在冷构建过程中走动', async () => {
    const root = makeWorkspace(['Gold', 'Silver']);
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const scheduler = new IndexScheduler();
    try {
      let ticks = 0;
      const interval = setInterval(() => { ticks += 1; }, 0);
      const handle = scheduleBackgroundSchemaWarmup(scheduler, root, ['Gold', 'Silver']);
      expect(await handle.wait).toBe(2); // 语义保持:两实体照常入缓存
      clearInterval(interval);
      // 调度泵是 queueMicrotask:若构建仍是同步整段,零宏任务边界,定时器
      // 一步不走;阶段闸让出(setImmediate)后构建期间定时器必然走动
      expect(ticks).toBeGreaterThan(0);
    } finally {
      scheduler.dispose();
    }
  });
});
