import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate } from '../src/extension';
import {
  buildDatabaseTableDescriptor,
  engineStructuralNamesOf,
  formatSchemaImpactReport,
  runSchemaImpactCommand,
  type SchemaImpactCommandDeps
} from '../src/databaseSchemaImpactCommand';
import { previewEntitySchemaImpact } from '../src/databaseSchemaImpact';
import type { TableSchemaDescriptor } from '../src/databaseSchemaCore';
import type { QueryResult } from '../src/databaseDrift';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, windowState } from './fake-vscode/windowState';
import { configurationOverrides, workspace, workspaceState } from './fake-vscode/workspaceState';
import { Uri, type ExtensionContext } from './fake-vscode/core';
import { window as stubWindow } from './helpers/vscodeStub';

// IDE-REV-019 结构影响预览命令:库侧描述符构建(型别归一+结构列同口径
// 剔除)→ databaseSchemaImpact 三态 diff → 只读报告;编排面覆盖 实体
// 选择三源/读不到定义/读不到配置/连不上/表不在库里整表新建/三态清单/
// 无差异;命令级(activate 真装配)注册在册+无配置降级+死端口如实失败。

const HERO_TABLE: TableSchemaDescriptor = {
  name: 'tbl_Hero',
  kind: 'entity',
  title: 'Hero',
  source: { filePath: '/ws/scripts/entity_defs/Hero.def', line: 1, path: 'Hero', category: 'entity' },
  fields: [
    {
      name: 'id',
      typeLabel: 'bigint unsigned',
      sourcePath: 'Hero.id',
      source: { filePath: '/ws/scripts/entity_defs/Hero.def', line: 1, path: 'Hero', category: 'entity' },
      identifier: true,
      synthetic: true
    },
    {
      name: 'sm_hp',
      typeLabel: 'int unsigned',
      sourcePath: 'Hero.hp',
      source: { filePath: '/ws/scripts/entity_defs/Hero.def', line: 3, path: 'hp', category: 'entity' },
      identifier: false
    },
    {
      name: 'sm_level',
      typeLabel: 'smallint unsigned',
      sourcePath: 'Hero.level',
      source: { filePath: '/ws/scripts/entity_defs/Hero.def', line: 8, path: 'level', category: 'entity' },
      identifier: false
    }
  ]
};

const showColumnsResult = (rows: Array<Record<string, unknown>>): QueryResult => ({
  columns: [
    { name: 'Field', type: '' },
    { name: 'Type', type: '' },
    { name: 'Null', type: '' },
    { name: 'Key', type: '' },
    { name: 'Default', type: '' },
    { name: 'Extra', type: '' }
  ],
  rows
});

describe('buildDatabaseTableDescriptor / formatSchemaImpactReport(纯面)', () => {
  it('库列型别归一(整数显示宽度不算差异),引擎结构列按 def 侧名单剔除', () => {
    const descriptor = buildDatabaseTableDescriptor(
      'tbl_Hero',
      [
        { name: 'id', type: 'bigint(20) unsigned' },
        { name: 'sm_hp', type: 'int(10) unsigned' },
        { name: 'sm_old', type: 'varchar(64)' }
      ],
      engineStructuralNamesOf(HERO_TABLE)
    );
    const idField = descriptor.fields.find(field => field.name === 'id');
    expect(idField?.synthetic).toBe(true); // 结构列同口径剔除,不报「移除」
    const hpField = descriptor.fields.find(field => field.name === 'sm_hp');
    expect(hpField?.typeLabel).toBe('int unsigned'); // 与 def 侧 typeLabel 同形
    expect(hpField?.synthetic).toBeUndefined();
  });

  it('三态报告:新增/移除/类型变化按清单渲染,只读声明在头部', () => {
    const databaseTable = buildDatabaseTableDescriptor(
      'tbl_Hero',
      [
        { name: 'id', type: 'bigint(20) unsigned' },
        { name: 'sm_hp', type: 'varchar(20)' },
        { name: 'sm_old', type: 'varchar(64)' }
      ],
      engineStructuralNamesOf(HERO_TABLE)
    );
    const impact = previewEntitySchemaImpact(databaseTable, HERO_TABLE);
    const text = formatSchemaImpactReport('Hero', impact);
    expect(text).toContain('只读预览,不执行任何 DDL/写库');
    expect(text).toContain('+ sm_level smallint unsigned(新增:def 有,库无)');
    expect(text).toContain('- sm_old varchar(64)(移除:库有,def 无)');
    expect(text).toContain('~ sm_hp varchar(20) → int unsigned(类型变化)');
    expect(text).toContain('(共 3 项)');
    expect(text).not.toContain('id'); // 结构列不进影响面
  });

  it('无差异如实说无', () => {
    const databaseTable = buildDatabaseTableDescriptor(
      'tbl_Hero',
      [
        { name: 'id', type: 'bigint(20) unsigned' },
        { name: 'sm_hp', type: 'int(10) unsigned' },
        { name: 'sm_level', type: 'smallint(5) unsigned' }
      ],
      engineStructuralNamesOf(HERO_TABLE)
    );
    const impact = previewEntitySchemaImpact(databaseTable, HERO_TABLE);
    expect(impact.entries).toEqual([]);
    expect(formatSchemaImpactReport('Hero', impact)).toContain('无结构差异');
  });
});

describe('runSchemaImpactCommand(编排面)', () => {
  interface Harness {
    deps: SchemaImpactCommandDeps;
    sqlLog: string[];
    channelLines: string[];
    infos: string[];
    warnings: string[];
    errors: string[];
    pickItems: string[][];
  }

  const makeHarness = (options: {
    entityName?: string;
    entityTable?: TableSchemaDescriptor | null;
    queryResult?: QueryResult | Error;
    pickAnswer?: string;
    connectFails?: string;
  } = {}): Harness => {
    const harness: Harness = {
      sqlLog: [],
      channelLines: [],
      infos: [],
      warnings: [],
      errors: [],
      pickItems: [],
      deps: {
        resolveEntityName: () => options.entityName,
        resolveEntityTable: () => options.entityTable === undefined ? HERO_TABLE : options.entityTable,
        resolveConnection: () => ({ profileId: 'p1', config: {} as never }),
        createConnection: async () => {
          if (options.connectFails) {
            throw new Error(options.connectFails);
          }
          return {
            runQuery: async (sql: string): Promise<QueryResult> => {
              harness.sqlLog.push(sql);
              if (options.queryResult instanceof Error) {
                throw options.queryResult;
              }
              return options.queryResult ?? showColumnsResult([]);
            },
            close: async () => {
              harness.sqlLog.push('__close__');
            }
          };
        },
        listEntityNames: () => ['Avatar', 'Hero'],
        showQuickPick: async (items: string[], pickOptions: { placeHolder: string }) => {
          harness.pickItems.push(items);
          expect(pickOptions.placeHolder).toContain('只读');
          return options.pickAnswer;
        },
        showInformationMessage: message => {
          harness.infos.push(message);
          return undefined;
        },
        showWarningMessage: message => {
          harness.warnings.push(message);
          return undefined;
        },
        showErrorMessage: message => {
          harness.errors.push(message);
          return undefined;
        },
        channel: {
          appendLine: line => {
            harness.channelLines.push(line);
          },
          show: () => undefined
        }
      }
    };
    return harness;
  };

  it('命令参数给定实体:直连对照,SQL 是只读 SHOW FULL COLUMNS,收尾关连接', async () => {
    const harness = makeHarness({
      entityName: 'Hero',
      queryResult: showColumnsResult([
        { Field: 'id', Type: 'bigint(20) unsigned' },
        { Field: 'sm_hp', Type: 'varchar(20)' },
        { Field: 'sm_old', Type: 'varchar(64)' }
      ])
    });
    await runSchemaImpactCommand(harness.deps);
    expect(harness.sqlLog).toEqual(['SHOW FULL COLUMNS FROM `tbl_Hero`', '__close__']);
    expect(harness.pickItems).toHaveLength(0); // 有实体名不走选择器
    const text = harness.channelLines.join('\n');
    expect(text).toContain('+ sm_level');
    expect(text).toContain('- sm_old');
    expect(text).toContain('~ sm_hp varchar(20) → int unsigned');
  });

  it('无实体名走选择器:选中即对照;取消如实不执行', async () => {
    const harness = makeHarness({ pickAnswer: 'Hero' });
    await runSchemaImpactCommand(harness.deps);
    expect(harness.pickItems[0]).toEqual(['Avatar', 'Hero']);
    expect(harness.sqlLog).toEqual(['SHOW FULL COLUMNS FROM `tbl_Hero`', '__close__']);

    const cancelled = makeHarness({ pickAnswer: undefined });
    await runSchemaImpactCommand(cancelled.deps);
    expect(cancelled.infos.at(-1)).toContain('未选择实体');
    expect(cancelled.sqlLog).toHaveLength(0);
  });

  it('无注册实体也无活动 def:如实提示不建连接', async () => {
    const harness = makeHarness({ entityName: undefined });
    harness.deps.listEntityNames = () => [];
    await runSchemaImpactCommand(harness.deps);
    expect(harness.infos.at(-1)).toContain('没有注册实体');
    expect(harness.sqlLog).toHaveLength(0);
  });

  it('实体定义读不到:警告带实体名', async () => {
    const harness = makeHarness({ entityName: 'Ghost', entityTable: null });
    await runSchemaImpactCommand(harness.deps);
    expect(harness.warnings.at(-1)).toContain('读取实体定义失败: Ghost');
    expect(harness.sqlLog).toHaveLength(0);
  });

  it('读不到数据库配置:如实降级不建连接', async () => {
    const harness = makeHarness({ entityName: 'Hero' });
    harness.deps.resolveConnection = () => null;
    await runSchemaImpactCommand(harness.deps);
    expect(harness.infos.at(-1)).toContain('结构影响预览未执行');
    expect(harness.infos.at(-1)).toContain('读不到引擎数据库配置');
    expect(harness.sqlLog).toHaveLength(0);
  });

  it('连不上:如实报错带原因,不发查询不写通道', async () => {
    const harness = makeHarness({ entityName: 'Hero', connectFails: 'connect ECONNREFUSED 127.0.0.1:3306' });
    await runSchemaImpactCommand(harness.deps);
    expect(harness.errors.at(-1)).toContain('结构影响预览失败');
    expect(harness.errors.at(-1)).toContain('ECONNREFUSED');
    expect(harness.sqlLog).toHaveLength(0);
    expect(harness.channelLines).toHaveLength(0);
  });

  it('表还不在库里:如实说明整表将新建,不虚构对照', async () => {
    const harness = makeHarness({
      entityName: 'Hero',
      queryResult: new Error("Table 'game_db.tbl_Hero' doesn't exist")
    });
    await runSchemaImpactCommand(harness.deps);
    expect(harness.errors).toHaveLength(0);
    const text = harness.channelLines.join('\n');
    expect(text).toContain('表 tbl_Hero 还不在库里');
    expect(text).toContain('整表新建');
    expect(text).toContain('def 推导列 2 项');
  });

  it('读表失败(非缺表):如实报错不写通道', async () => {
    const harness = makeHarness({
      entityName: 'Hero',
      queryResult: new Error('SELECT command denied')
    });
    await runSchemaImpactCommand(harness.deps);
    expect(harness.errors.at(-1)).toContain('读取表结构失败');
    expect(harness.channelLines).toHaveLength(0);
  });
});

describe('kbengine.database.previewSchemaImpact 命令(activate 真装配)', () => {
  let root = '';
  let originalActiveTextEditor: unknown;

  const freePort = async (): Promise<number> => {
    const probe = http.createServer();
    return new Promise<number>(resolve => {
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address() as AddressInfo;
        probe.close(() => resolve(address.port));
      });
    });
  };

    const HERO_DEF = [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n');

  /** def + entities.xml:让 resolveEntityTable 的真虚拟 schema 推导出 tbl_Hero */
  const writeRegisteredHero = (): void => {
    const defDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defDir, { recursive: true });
    fs.writeFileSync(path.join(defDir, 'Hero.def'), HERO_DEF, 'utf8');
    fs.writeFileSync(
      path.join(root, 'scripts', 'entities.xml'),
      ['<root>', '  <Hero hasBase="true" hasCell="true"/>', '</root>'].join('\n'),
      'utf8'
    );
  };

  const writeEngineDefaults = (host: string, port: number): void => {
    const engine = path.join(root, 'kbe', 'res', 'server');
    fs.mkdirSync(engine, { recursive: true });
    fs.writeFileSync(
      path.join(engine, 'kbengine_defaults.xml'),
      [
        '<defaults>',
        '  <dbmgr>',
        '    <databaseInterfaces>',
        '      <default>',
        `        <host>${host}</host>`,
        `        <port>${port}</port>`,
        '        <databaseName>game_db</databaseName>',
        '        <auth>',
        '          <username>game</username>',
        '          <encrypt>false</encrypt>',
        '          <password>kbe</password>',
        '        </auth>',
        '      </default>',
        '    </databaseInterfaces>',
        '  </dbmgr>',
        '</defaults>'
      ].join('\n'),
      'utf8'
    );
    configurationOverrides.set('kbengine', { binPath: `${root}/kbe/bin/server` });
  };

  beforeEach(() => {
    commandRegistry.reset();
    windowState.reset();
    workspaceState.reset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-impact-cmd-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.textDocuments = [];
    originalActiveTextEditor = (stubWindow as unknown as Record<string, unknown>).activeTextEditor;
  });

  afterEach(() => {
    configurationOverrides.clear();
    const windowish = stubWindow as unknown as Record<string, unknown>;
    if (originalActiveTextEditor === undefined) {
      delete windowish.activeTextEditor;
    } else {
      windowish.activeTextEditor = originalActiveTextEditor;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const activateAndWait = async (): Promise<void> => {
    activate({ subscriptions: [], extensionUri: Uri.file('/workspace/ext') } as ExtensionContext);
    await new Promise(resolve => setTimeout(resolve, 100));
  };

  it('命令已注册;无引擎配置:如实降级提示,不建连接', async () => {
    writeRegisteredHero();
    await activateAndWait();
    expect(commandRegistry.registeredCommandIds()).toContain('kbengine.database.previewSchemaImpact');

    await commands.executeCommand('kbengine.database.previewSchemaImpact', 'Hero');

    expect(messages.info.at(-1)).toContain('结构影响预览未执行');
    expect(messages.info.at(-1)).toContain('读不到引擎数据库配置');
  });

  it('死端口:真连 mysql2 如实报连不上,不写影响通道', async () => {
    writeRegisteredHero();
    writeEngineDefaults('127.0.0.1', await freePort());
    await activateAndWait();

    await commands.executeCommand('kbengine.database.previewSchemaImpact', 'Hero');

    expect(messages.error.length).toBeGreaterThan(0);
    expect(messages.error.at(-1)).toContain('结构影响预览失败');
    expect(messages.error.at(-1)).toContain('连不上数据库');
    const impact = windowState.channels.find(channel => channel.name.includes('结构影响预览'));
    expect(impact?.lines.join('') ?? '').not.toContain('===== KBEngine 结构影响预览');
  });
});
