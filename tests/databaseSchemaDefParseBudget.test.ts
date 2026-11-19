import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildDatabaseSchemaSnapshotAsync,
  clearDatabaseSchemaCacheForTests,
  getDatabaseSchemaCacheStatsForTests
} from '../src/databaseSchema';
import { parseDefDocument } from '../src/backend/defParser';
import { workspace } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';

// KODE-FULL-015:def 解析 worker 预算拒收后的驱动语义——过载有界重试
// (过闸让出+取消止步+小睡退避)、窗耗尽本轮诚实跳过该定义(槽 null,不
// 假成功不炸构建)、worker 崩溃等真错误保留同步兜底。红线:预算类错误
// 绝不回落宿主同步解析大输入(Extension Host 冻结病灶)。parseDefDocumentResponsive
// 以脚本化替身注入(保留真实 DefParserBudgetError 类,instanceof 口径不破)。

const responsiveState = vi.hoisted(() => ({
  script: [] as Array<'overload' | 'too-large' | 'crash' | 'resolve'>,
  calls: 0
}));

vi.mock('../src/backend/defParserWorkerHost', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/backend/defParserWorkerHost')>();
  return {
    ...actual,
    parseDefDocumentResponsive: async (text: string, label?: string) => {
      responsiveState.calls += 1;
      const step = responsiveState.script[Math.min(responsiveState.calls - 1, responsiveState.script.length - 1)];
      if (step === 'overload' || step === 'too-large') {
        throw new actual.DefParserBudgetError(step, `mock budget ${step} (${label})`);
      }
      if (step === 'crash') {
        throw new Error('worker crash');
      }
      return parseDefDocument(text);
    }
  };
});

const temporaryDirectories: string[] = [];
const originalFolders = workspace.workspaceFolders;

afterEach(() => {
  workspace.textDocuments = [];
  workspace.workspaceFolders = originalFolders;
  clearDatabaseSchemaCacheForTests();
  responsiveState.script = [];
  responsiveState.calls = 0;
  vi.restoreAllMocks();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(entityNames: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch-budget-'));
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

const mount = (root: string): void => {
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
};

describe('KODE-FULL-015:def 解析预算拒收的驱动语义', () => {
  it('过载退避重试:首轮拒收第二轮放行,构建照常产出属性面', async () => {
    const root = makeWorkspace(['Gold']);
    mount(root);
    responsiveState.script = ['overload', 'resolve'];
    const built = await buildDatabaseSchemaSnapshotAsync('Gold', root, { defParseBudgetRetryMs: 1000 });
    expect(built).not.toBeNull();
    expect(responsiveState.calls).toBeGreaterThanOrEqual(2);
    // 重试后真文档进槽:持久化属性 value 产出表列
    expect(JSON.stringify(built)).toContain('value');
  }, 10000);

  it('持续过载至重试窗耗尽:诚实放弃本轮(不发布不假成功),不回落宿主同步解析', async () => {
    const root = makeWorkspace(['Gold']);
    mount(root);
    responsiveState.script = ['overload'];
    const built = await buildDatabaseSchemaSnapshotAsync('Gold', root, { defParseBudgetRetryMs: 30 });
    // 主实体 def 槽 null → 生成器如实 return null:本轮无快照、不发布缓存。
    // (嵌套 def 槽 null 才是「跳过该定义继续构建」面;主 def 缺席构建无意义)
    expect(built).toBeNull();
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(0);
    expect(responsiveState.calls).toBeGreaterThanOrEqual(2); // 确实重试过才放弃
    expect(JSON.stringify(responsiveState)).not.toContain('parseDefDocument('); // 静态 sanity
  }, 10000);

  it('重试期间取消:gate 返回 false 即止步,null 且不发布缓存', async () => {
    const root = makeWorkspace(['Gold']);
    mount(root);
    responsiveState.script = ['overload'];
    let gateCalls = 0;
    const built = await buildDatabaseSchemaSnapshotAsync('Gold', root, {
      defParseBudgetRetryMs: 10_000,
      gate: () => {
        gateCalls += 1;
        return gateCalls < 10; // 第 10 道闸取消(重试轮的闸必到达)
      }
    });
    expect(built).toBeNull();
    expect(gateCalls).toBe(10);
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(0); // 未发布
  }, 10000);

  it('worker 崩溃等真错误:保留同步兜底一次(IDE-REV-039 原语义)', async () => {
    const root = makeWorkspace(['Gold']);
    mount(root);
    responsiveState.script = ['crash'];
    const built = await buildDatabaseSchemaSnapshotAsync('Gold', root);
    expect(built).not.toBeNull();
    expect(responsiveState.calls).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(built)).toContain('value'); // 同步兜底产出真属性
  }, 10000);
});
