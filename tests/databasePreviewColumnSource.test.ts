import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFileSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTablePreviewCommand } from '../src/databaseTablePreviewCommand';
import {
  createPreviewColumnSourceTableResolver,
  renderColumnSourceSection
} from '../src/databasePreviewColumnSource';
import type { TableSchemaDescriptor } from '../src/databaseSchemaCore';
import { getRegisteredEntities } from '../src/definitionWorkspace';
import { getDatabaseSchemaSnapshot } from '../src/databaseSchema';
import { configurationOverrides, workspace } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';

// IDE-REV-018 列来源接到实际结果展示:反查器(注入面)+ 真链路反查(真
// 注册表/真 schema 快照,真 def 文件拿到真声明行号)+ 渲染三态(derived
// 带 filePath:line 点击定位面,合成/未知如实不带跳转)+ 预览命令编排把
// 列来源段落进通道 + 装配层接线源锁。

const makeTable = (name: string, fields: TableSchemaDescriptor['fields']): TableSchemaDescriptor => ({
  name,
  kind: 'entity',
  title: name.replace(/^tbl_/, ''),
  source: { filePath: '/ws/entity_defs/X.def', line: 1, path: 'root' },
  fields
});

describe('createPreviewColumnSourceTableResolver(反查面)', () => {
  const tableA = makeTable('tbl_Avatar', []);
  const childB = makeTable('tbl_Bag', []);

  it('逐实体反查:首个命中即返回;单实体 miss、清单尾命中各归各位', () => {
    const snapshots = new Map([
      ['Avatar|/ws', { tableIndex: new Map([['tbl_Avatar', tableA]]) }],
      ['Bot|/ws', null],
      ['Bag|/ws', { tableIndex: new Map([['tbl_Bag', childB]]) }]
    ]);
    const resolve = createPreviewColumnSourceTableResolver({
      listEntityRoots: () => [
        { rootPath: '/ws', entityName: 'Avatar' },
        { rootPath: '/ws', entityName: 'Bot' },
        { rootPath: '/ws', entityName: 'Bag' }
      ],
      getSnapshot: (entityName, rootPath) => snapshots.get(`${entityName}|${rootPath}`) ?? null
    });
    expect(resolve('tbl_Avatar')).toBe(tableA);
    expect(resolve('tbl_Bag')).toBe(childB); // 中间快照为 null 不挡后续实体
    expect(resolve('tbl_Ghost')).toBeNull(); // 全清单 miss = 如实 null
  });

  it('快照为 null 的实体如实跳过,不伪造描述符', () => {
    const resolve = createPreviewColumnSourceTableResolver({
      listEntityRoots: () => [{ rootPath: '/ws', entityName: 'Ghost' }],
      getSnapshot: () => null
    });
    expect(resolve('tbl_Ghost')).toBeNull();
  });
});

describe('renderColumnSourceSection(渲染面)', () => {
  const table = makeTable('tbl_Hero', [
    {
      name: 'id',
      typeLabel: 'bigint unsigned',
      sourcePath: 'Hero.id',
      source: { filePath: '/ws/scripts/entity_defs/Hero.def', line: 1, path: 'Hero' },
      identifier: true,
      synthetic: true
    },
    {
      name: 'sm_hp',
      typeLabel: 'int unsigned',
      declaredType: 'UINT32',
      sourcePath: 'Hero.hp',
      source: { filePath: '/ws/scripts/entity_defs/Hero.def', line: 4, path: 'root>Properties>hp' },
      identifier: false
    }
  ]);

  it('derived 行带声明处 filePath:line 与类型原文;合成列无跳转面;未知列如实', () => {
    const lines = renderColumnSourceSection(
      [{ name: 'id' }, { name: 'sm_hp' }, { name: 'mystery_col' }],
      'tbl_Hero',
      table
    );
    const text = lines.join('\n');
    expect(text).toContain('sm_hp:源自 def 声明 /ws/scripts/entity_defs/Hero.def:4(root>Properties>hp,TypeUINT32)');
    expect(text).toContain('id:引擎合成列');
    expect(text).toContain('mystery_col:未知列');
    // 合成/未知行绝不含路径跳转面(不跳错误位置)
    const idLine = lines.find(line => line.includes('id:'));
    const unknownLine = lines.find(line => line.includes('mystery_col'));
    expect(idLine).not.toMatch(/\.def:\d+/);
    expect(unknownLine).not.toMatch(/\.def:\d+/);
  });

  it('表不在推导面内:整段如实说明,不逐列猜', () => {
    const lines = renderColumnSourceSection([{ name: 'anything' }], 'tbl_Other', null);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('tbl_Other 不在工作区虚拟 schema 推导面内');
    expect(lines[0]).toContain('如实');
  });
});

describe('反查真链路(真注册表 + 真 schema 快照 + 真 def 文件)', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-col-source-'));
    const defDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defDir, { recursive: true });
    fs.writeFileSync(
      path.join(defDir, 'Hero.def'),
      [
        '<root>',
        '  <Properties>',
        '    <hp>',
        '      <Type>UINT32</Type>',
        '      <Persistent>true</Persistent>',
        '    </hp>',
        '    <bag>',
        '      <Type>',
        '        ARRAY',
        '        <of>UINT32</of>',
        '      </Type>',
        '      <Persistent>true</Persistent>',
        '    </bag>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(root, 'scripts', 'entities.xml'),
      ['<root>', '  <Hero hasBase="true" hasCell="true"/>', '</root>'].join('\n'),
      'utf8'
    );
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  });

  afterEach(() => {
    configurationOverrides.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const realResolver = () =>
    createPreviewColumnSourceTableResolver({
      listEntityRoots: () =>
        (workspace.workspaceFolders ?? []).flatMap(folder =>
          getRegisteredEntities(folder.uri.fsPath).map(entity => ({
            rootPath: folder.uri.fsPath,
            entityName: entity.name
          }))
        ),
      getSnapshot: (entityName, rootPath) => getDatabaseSchemaSnapshot(entityName, rootPath)
    });

  it('真 def 推导:根表/ARRAY 子表都能反查到,derived 行给真声明行号', () => {
    const resolve = realResolver();
    const heroTable = resolve('tbl_Hero');
    expect(heroTable).not.toBeNull();
    const lines = renderColumnSourceSection([{ name: 'id' }, { name: 'sm_hp' }], 'tbl_Hero', heroTable);
    const text = lines.join('\n');
    expect(text).toContain('sm_hp:源自 def 声明');
    expect(text).toMatch(/sm_hp:源自 def 声明 [^\s]*scripts\/entity_defs\/Hero\.def:3\(hp,TypeUINT32\)/);
    expect(text).toContain('id:引擎合成列');

    const bagTable = resolve('tbl_Hero_bag');
    expect(bagTable).not.toBeNull();
    expect(bagTable!.kind).toBe('array');

    expect(resolve('tbl_Ghost')).toBeNull();
  });
});

describe('runTablePreviewCommand · 列来源段(编排面)', () => {
  const table = makeTable('tbl_Hero', [
    {
      name: 'sm_hp',
      typeLabel: 'int unsigned',
      declaredType: 'UINT32',
      sourcePath: 'Hero.hp',
      source: { filePath: '/ws/scripts/entity_defs/Hero.def', line: 4, path: 'root>Properties>hp' },
      identifier: false
    }
  ]);

  const harness = (resolver: (table: string) => TableSchemaDescriptor | null) => {
    const channelLines: string[] = [];
    return {
      channelLines,
      run: () =>
        runTablePreviewCommand({
          resolveConnection: () => ({ profileId: 'p1', config: {} as never }),
          createConnection: async () => ({
            runQuery: async (sql: string) =>
              sql === 'SHOW TABLES'
                ? { columns: [{ name: 'T' }], rows: [{ T: 'tbl_Hero' }] }
                : { columns: [{ name: 'sm_hp' }], rows: [{ sm_hp: 7 }] },
            close: async () => undefined
          }),
          showQuickPick: async () => 'tbl_Hero',
          showInputBox: async () => undefined,
          showInformationMessage: () => undefined,
          showErrorMessage: () => undefined,
          channel: {
            appendLine: line => {
              channelLines.push(line);
            },
            show: () => undefined
          },
          resolveColumnSourceTable: resolver
        })
    };
  };

  it('预览落通道后列来源段紧随:derived 行带可点击定位面', async () => {
    const h = harness(() => table);
    await h.run();
    const text = h.channelLines.join('\n');
    expect(text).toContain('表预览 tbl_Hero');
    expect(text).toContain('列来源:Hero');
    expect(text).toContain('sm_hp:源自 def 声明 /ws/scripts/entity_defs/Hero.def:4');
  });

  it('反查 miss:如实说明该表不在推导面,不猜列来源', async () => {
    const h = harness(() => null);
    await h.run();
    const text = h.channelLines.join('\n');
    expect(text).toContain('不在工作区虚拟 schema 推导面内');
    expect(text).not.toContain('源自 def 声明');
  });
});

describe('装配层接线(源锁)', () => {
  it('extension.ts 把反查器接进预览命令(解除接线即红)', () => {
    const wiring = readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    expect(wiring).toContain('resolveColumnSourceTable: createPreviewColumnSourceTableResolver');
  });
});
