import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildTypeStorageUsageIndexPhased,
  cancelTypeStorageUsageColdBuild,
  clearDatabaseSchemaCacheForTests,
  findTypeStorageUsages,
  findTypeStorageUsagesReadOnly,
  flushTypeStorageUsageColdBuildForTests,
  getTypeStorageColdBuildGaugeForTests,
  getPendingTypeStorageColdBuildCount,
  invalidateTypeStorageUsageIndex,
  setTypeStorageUsageBackgroundDispatcher
} from '../src/databaseSchema';
import { workspace } from './fake-vscode/workspaceState';

// IDE-REV-013(原项 IDE-SCH-006/009):拆分 type storage 冷索引的实际计算
// 阶段——不在单个 setImmediate 回调内同步遍历全部实体;逐实体按预算让出
// 宿主并检查取消。验收:真实构建中途取消停止后续工作;最大连续阻塞入
// 量规,不以 beforeBuild 假闸门冒充响应性。

const temporaryDirectories: string[] = [];
const originalFolders = workspace.workspaceFolders;

afterEach(() => {
  workspace.workspaceFolders = originalFolders;
  workspace.textDocuments = [];
  setTypeStorageUsageBackgroundDispatcher(null);
  invalidateTypeStorageUsageIndex();
  clearDatabaseSchemaCacheForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(entityCount: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-rev13-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  const entityNames = Array.from({ length: entityCount }, (_, index) => `Gold${index}`);
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'),
    `<root>\n${entityNames.map(name => `  <${name}/>`).join('\n')}\n</root>\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'),
    '<root>\n  <ITEM_ID> UINT16 </ITEM_ID>\n</root>\n', 'utf8');
  for (const name of entityNames) {
    fs.writeFileSync(path.join(root, 'scripts/entity_defs', `${name}.def`), [
      '<root>',
      '  <Properties>',
      `    <${name.toLowerCase()}>`,
      '      <Type>ITEM_ID</Type>',
      '      <Persistent>true</Persistent>',
      `    </${name.toLowerCase()}>`,
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
  }
  return root;
}

describe('IDE-REV-013:type storage 冷索引逐实体分阶段', () => {
  it('中途取消停止后续实体:真实构建边界止步,不发布聚合', async () => {
    const root = makeWorkspace(6);
    workspace.workspaceFolders = [{ uri: { toString: () => `file://${root}`, fsPath: root }, name: 'ws', index: 0 }];

    let remainingBudget = 4; // 实体边界+让路后各查一次:预算 4 → 两个实体后止步
    const outcome = await buildTypeStorageUsageIndexPhased(root, {
      shouldContinue: () => (remainingBudget -= 1) >= 0,
      yieldControl: () => Promise.resolve(),
      entityBudgetMs: 0 // 每实体让路,取消在实体边界生效
    });

    expect(outcome.stopped).toBe(true);
    expect(outcome.entities).toBe(2); // 第 3 个实体前止步
    expect(outcome.yields).toBeGreaterThanOrEqual(1); // 真实让路面,非 beforeBuild 假闸门
    expect(outcome.maxSliceMs).toBeGreaterThanOrEqual(0);
    // 量规入账:测试面读得同一次运行的最大连续阻塞
    expect(getTypeStorageColdBuildGaugeForTests()?.entities).toBe(2);
    // 取消不发布:查询走全量重建面(非部分聚合)
    expect(findTypeStorageUsages(root, 'ITEM_ID')).toHaveLength(6);
  });

  it('完整构建零取消:全部实体入账,聚合发布', async () => {
    const root = makeWorkspace(3);
    workspace.workspaceFolders = [{ uri: { toString: () => `file://${root}`, fsPath: root }, name: 'ws', index: 0 }];

    const outcome = await buildTypeStorageUsageIndexPhased(root, { entityBudgetMs: 25 });
    expect(outcome.stopped).toBe(false);
    expect(outcome.entities).toBe(3);
    expect(findTypeStorageUsages(root, 'ITEM_ID')).toHaveLength(3); // 聚合已发布
  });

  it('调度面取消:在飞冷构建收到取消,部分状态弃置', async () => {
    const root = makeWorkspace(4);
    workspace.workspaceFolders = [{ uri: { toString: () => `file://${root}`, fsPath: root }, name: 'ws', index: 0 }];
    invalidateTypeStorageUsageIndex();

    let release: (() => void) | null = null;
    setTypeStorageUsageBackgroundDispatcher(run => new Promise<void>(resolve => {
      release = () => { void run().then(resolve, resolve); };
    }));

    // 首个只读查询调度冷构建(渲染面口径,无状态→后台调度);派发被挡住,取消到达后放行
    expect(findTypeStorageUsagesReadOnly(root, 'ITEM_ID')).toHaveLength(0); // 空表不整表构建
    expect(getPendingTypeStorageColdBuildCount()).toBe(1);
    expect(cancelTypeStorageUsageColdBuild(root)).toBe(true);
    for (let i = 0; i < 100 && !release; i += 1) { await Promise.resolve(); } // 等链上微任务到达派发器
    release!();
    await flushTypeStorageUsageColdBuildForTests();

    expect(getPendingTypeStorageColdBuildCount()).toBe(0);
    const gauge = getTypeStorageColdBuildGaugeForTests();
    expect(gauge?.stopped).toBe(true); // 部分实体后止步
    expect(gauge?.entities).toBeLessThan(4);
    // 再查:状态已弃置,重新调度后完整发布
    setTypeStorageUsageBackgroundDispatcher(null);
    const usages = findTypeStorageUsages(root, 'ITEM_ID');
    await flushTypeStorageUsageColdBuildForTests();
    expect(usages).toHaveLength(4);
  });
});
