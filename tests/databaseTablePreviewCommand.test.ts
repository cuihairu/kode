import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate } from '../src/extension';
import {
  formatTablePreview,
  listPreviewTables,
  runTablePreviewCommand,
  type TablePreviewCommandDeps
} from '../src/databaseTablePreviewCommand';
import type { QueryResult } from '../src/databaseDrift';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, windowState } from './fake-vscode/windowState';
import { configurationOverrides, workspace, workspaceState } from './fake-vscode/workspaceState';
import { Uri, type ExtensionContext } from './fake-vscode/core';
import { window as stubWindow } from './helpers/vscodeStub';

// IDE-REV-016 单表只读预览:命令编排面(纯注入)覆盖 取消选表不发预览查询
// /白名单语句是实际下发的语句/连不上如实报错/渲染含 SQL 与行数;命令级
// (activate 真装配)覆盖 无配置降级 与 死端口诚实失败。

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext')
});

const windowish = stubWindow as unknown as Record<string, unknown>;

interface Harness {
  deps: TablePreviewCommandDeps;
  sqlLog: string[];
  quickPickItems: string[][];
  inputOptions: Array<{ prompt: string; validateInput?: (value: string) => string | null }>;
  infos: string[];
  errors: string[];
  channelLines: string[];
  shown: boolean;
}

/** 连接与 UI 全替身:runQuery 记 SQL 序列,选择器/输入框按队列回值 */
const makeHarness = (options: {
  showTablesResult?: QueryResult | Error;
  previewResult?: QueryResult;
  quickPickAnswers?: Array<string | undefined>;
  inputAnswer?: string | undefined;
  connectFails?: string;
} = {}): Harness => {
  const sqlLog: string[] = [];
  const harness: Harness = {
    sqlLog,
    quickPickItems: [],
    inputOptions: [],
    infos: [],
    errors: [],
    channelLines: [],
    shown: false,
    deps: {
      resolveConnection: () => ({ profileId: 'p1', config: {} as never }),
      createConnection: async () => {
        if (options.connectFails) {
          throw new Error(options.connectFails);
        }
        return {
          runQuery: async (sql: string): Promise<QueryResult> => {
            sqlLog.push(sql);
            if (options.showTablesResult instanceof Error && sql === 'SHOW TABLES') {
              throw options.showTablesResult;
            }
            if (sql === 'SHOW TABLES') {
              return options.showTablesResult ?? { columns: [{ name: 'Tables_in_game_db' }], rows: [] };
            }
            if (options.previewResult instanceof Error) {
              throw options.previewResult;
            }
            return options.previewResult ?? { columns: [], rows: [] };
          },
          close: async () => {
            sqlLog.push('__close__');
          }
        };
      },
      showQuickPick: async (items: string[], quickPickOptions: { placeHolder: string }) => {
        harness.quickPickItems.push(items);
        expect(quickPickOptions.placeHolder).toContain('只读');
        return (options.quickPickAnswers ?? []).shift();
      },
      showInputBox: async (inputBoxOptions: { prompt: string; validateInput?: (value: string) => string | null }) => {
        harness.inputOptions.push(inputBoxOptions);
        return options.inputAnswer;
      },
      showInformationMessage: message => {
        harness.infos.push(message);
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
        show: () => {
          harness.shown = true;
        }
      }
    }
  };
  return harness;
};

describe('runTablePreviewCommand(编排面)', () => {
  it('读不到配置:如实提示不建连接', async () => {
    const harness = makeHarness();
    harness.deps.resolveConnection = () => null;
    await runTablePreviewCommand(harness.deps);
    expect(harness.infos).toHaveLength(1);
    expect(harness.infos[0]).toContain('数据库预览未执行');
    expect(harness.infos[0]).toContain('读不到引擎数据库配置');
    expect(harness.sqlLog).toHaveLength(0);
  });

  it('连不上:如实报错(带原因),不发查询不写通道', async () => {
    const harness = makeHarness({ connectFails: 'connect ECONNREFUSED 127.0.0.1:3307' });
    await runTablePreviewCommand(harness.deps);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toContain('数据库预览失败');
    expect(harness.errors[0]).toContain('ECONNREFUSED');
    expect(harness.sqlLog).toHaveLength(0);
    expect(harness.channelLines).toHaveLength(0);
  });

  it('选表后预览:实际下发的就是白名单限量语句,结果进通道,连接即收', async () => {
    const harness = makeHarness({
      showTablesResult: {
        columns: [{ name: 'Tables_in_game_db' }],
        rows: [{ Tables_in_game_db: 'tbl_account' }, { Tables_in_game_db: 'tbl_entity' }]
      },
      quickPickAnswers: ['tbl_account'],
      previewResult: {
        columns: [{ name: 'id' }, { name: 'name' }],
        rows: [{ id: 1, name: 'hero_1' }, { id: 2, name: 'hero_2' }]
      }
    });
    await runTablePreviewCommand(harness.deps);
    // 表清单来自 SHOW TABLES;预览语句是固定白名单形状
    expect(harness.sqlLog).toEqual([
      'SHOW TABLES',
      'SELECT * FROM `tbl_account` LIMIT 100',
      '__close__'
    ]);
    expect(harness.quickPickItems[0]).toEqual(['tbl_account', 'tbl_entity']);
    expect(harness.errors).toHaveLength(0);
    expect(harness.shown).toBe(true);
    const text = harness.channelLines.join('\n');
    expect(text).toContain('表预览 tbl_account');
    expect(text).toContain('SELECT * FROM `tbl_account` LIMIT 100');
    expect(text).toContain('hero_2');
    expect(text).toContain('(2 行');
  });

  it('取消选表:不发预览查询(SHOW TABLES 之外零下发),不写通道', async () => {
    const harness = makeHarness({
      showTablesResult: { columns: [{ name: 'Tables_in_game_db' }], rows: [{ Tables_in_game_db: 'tbl_account' }] },
      quickPickAnswers: [undefined]
    });
    await runTablePreviewCommand(harness.deps);
    expect(harness.sqlLog).toEqual(['SHOW TABLES', '__close__']);
    expect(harness.channelLines).toHaveLength(0);
    expect(harness.errors).toHaveLength(0);
  });

  it('表清单拿不到(权限):退手输,标识符同口径校验,输入合法表名照常预览', async () => {
    const harness = makeHarness({
      showTablesResult: new Error('SELECT command denied to user'),
      inputAnswer: 'tbl_manual',
      previewResult: { columns: [{ name: 'id' }], rows: [{ id: 7 }] }
    });
    await runTablePreviewCommand(harness.deps);
    expect(harness.inputOptions).toHaveLength(1);
    expect(harness.inputOptions[0].prompt).toContain('SELECT command denied');
    const validate = harness.inputOptions[0].validateInput!;
    expect(validate('bad-table;drop')).toContain('表名只允许');
    expect(validate('tbl_ok')).toBeNull();
    expect(harness.sqlLog).toEqual(['SHOW TABLES', 'SELECT * FROM `tbl_manual` LIMIT 100', '__close__']);
    expect(harness.channelLines.join('\n')).toContain('tbl_manual');
  });

  it('手输取消:同样不发预览查询', async () => {
    const harness = makeHarness({
      showTablesResult: new Error('denied'),
      inputAnswer: undefined
    });
    await runTablePreviewCommand(harness.deps);
    expect(harness.sqlLog).toEqual(['SHOW TABLES', '__close__']);
    expect(harness.channelLines).toHaveLength(0);
  });

  it('空库(清单为空):也走手输面,不弹空选择器', async () => {
    const harness = makeHarness({
      showTablesResult: { columns: [{ name: 'Tables_in_game_db' }], rows: [] },
      inputAnswer: undefined
    });
    await runTablePreviewCommand(harness.deps);
    expect(harness.quickPickItems).toHaveLength(0);
    expect(harness.inputOptions).toHaveLength(1);
    expect(harness.inputOptions[0].prompt).toContain('没有表');
  });

  it('预览语句被拒(不应发生):如实报错不写通道', async () => {
    const harness = makeHarness({
      showTablesResult: { columns: [{ name: 'T' }], rows: [{ T: 'tbl_x' }] },
      quickPickAnswers: ['tbl_x'],
      previewResult: new Error('mock preview failure')
    });
    await runTablePreviewCommand(harness.deps);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toContain('数据库预览失败');
    expect(harness.channelLines).toHaveLength(0);
  });
});

describe('listPreviewTables', () => {
  it('首列值即表名;失败归 {ok:false} 不抛', async () => {
    const ok = await listPreviewTables(async () => ({
      columns: [{ name: 'Tables_in_db' }],
      rows: [{ Tables_in_db: 'a' }, { Tables_in_db: 'b' }]
    }));
    expect(ok).toEqual({ ok: true, tables: ['a', 'b'] });
    const failed = await listPreviewTables(async () => {
      throw new Error('nope');
    });
    expect(failed).toEqual({ ok: false, reason: 'nope' });
  });
});

describe('formatTablePreview', () => {
  it('对齐渲染:NULL/对象/超宽截断,截断尾注', () => {
    const text = formatTablePreview(
      {
        kind: 'preview',
        columns: [{ name: 'id' }, { name: 'payload' }],
        rows: [
          { id: 1, payload: null },
          { id: 2, payload: { deep: 'value' } },
          { id: 3, payload: 'x'.repeat(60) }
        ],
        returnedRows: 100,
        limit: 100,
        truncated: true
      },
      'tbl_demo'
    );
    expect(text).toContain('表预览 tbl_demo(100 行上限)');
    expect(text).toContain('SELECT * FROM `tbl_demo` LIMIT 100');
    expect(text).toContain('NULL');
    expect(text).toContain('{"deep":"value"}');
    expect(text).toContain('…'); // 超宽单元格截断
    expect(text).toContain('已截断');
    expect(text).toContain('(100 行');
  });
});

describe('kbengine.database.previewTable 命令(activate 真装配)', () => {
  let root = '';
  let originalActiveTextEditor: unknown;

  /** 占一个端口再立刻放开:拿到一个确定没人监听的端口 */
  const freePort = async (): Promise<number> => {
    const probe = http.createServer();
    return new Promise<number>(resolve => {
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address() as AddressInfo;
        probe.close(() => resolve(address.port));
      });
    });
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-preview-cmd-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.textDocuments = [];
    originalActiveTextEditor = windowish.activeTextEditor;
  });

  afterEach(() => {
    configurationOverrides.clear();
    if (originalActiveTextEditor === undefined) {
      delete windowish.activeTextEditor;
    } else {
      windowish.activeTextEditor = originalActiveTextEditor;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const activateAndWait = async (): Promise<void> => {
    activate(makeContext());
    await new Promise(resolve => setTimeout(resolve, 100));
  };

  it('命令已注册;无引擎配置:如实降级提示,不建连接', async () => {
    await activateAndWait();
    expect(commandRegistry.registeredCommandIds()).toContain('kbengine.database.previewTable');

    await commands.executeCommand('kbengine.database.previewTable');

    expect(messages.info.at(-1)).toContain('数据库预览未执行');
    expect(messages.info.at(-1)).toContain('读不到引擎数据库配置');
  });

  it('死端口:真连 mysql2 如实报连不上,不写预览通道', async () => {
    const port = await freePort();
    writeEngineDefaults('127.0.0.1', port);
    await activateAndWait();

    await commands.executeCommand('kbengine.database.previewTable');

    expect(messages.error.length).toBeGreaterThan(0);
    expect(messages.error.at(-1)).toContain('数据库预览失败');
    expect(messages.error.at(-1)).toContain('连不上数据库');
    const preview = windowState.channels.find(channel => channel.name.includes('数据库预览'));
    expect(preview?.lines.join('') ?? '').not.toContain('表预览');
  });
});
