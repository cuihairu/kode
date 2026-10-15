import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, windowState } from './fake-vscode/windowState';
import { configurationOverrides, workspace, workspaceState } from './fake-vscode/workspaceState';
import { makeTextDocument, Uri, type ExtensionContext } from './fake-vscode/core';
import { window as stubWindow } from './helpers/vscodeStub';

// 漂移校验(批C)命令装配层:kbengine.database.checkDrift 的四段分支——
// 无活动 .def / 读不到实体定义 / 读不到引擎数据库配置 / 真跑一次 mysql2
// 连接(端口无人监听)如实降级为「未校验」并把报告写进 OUTPUT 通道。
// 判读口径与只读红线由 tests/databaseDrift.test.ts 覆盖。

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext')
});

const windowish = stubWindow as unknown as Record<string, unknown>;

let root = '';
let originalActiveTextEditor: unknown;

const HERO_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE</Flags>',
  '      <Persistent>true</Persistent>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

const writeDef = (relative: string, lines: string[]): void => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
};

/** 落一份引擎 defaults(dbmgr 连接要素)+ binPath 覆盖,让引擎配置读得到 */
const writeEngineDefaults = (host: string, port: number): void => {
  const engine = path.join(root, 'kbe');
  fs.mkdirSync(path.join(engine, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(engine, 'res', 'server'), { recursive: true });
  fs.writeFileSync(
    path.join(engine, 'res', 'server', 'kbengine_defaults.xml'),
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
  configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
};

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

const activateAndWait = async (): Promise<ExtensionContext> => {
  const context = makeContext();
  activate(context);
  await new Promise(resolve => setTimeout(resolve, 100));
  return context;
};

const channelText = (): string =>
  windowState.channels.map(channel => channel.lines.join('')).join('');

beforeEach(() => {
  commandRegistry.reset();
  windowState.reset();
  workspaceState.reset();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-drift-cmd-'));
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

describe('kbengine.database.checkDrift 命令', () => {
  it('无活动 .def 时如实提示,不静默空转', async () => {
    await activateAndWait();

    await commands.executeCommand('kbengine.database.checkDrift');

    expect(messages.info.at(-1)).toContain('请先打开一个实体 .def 文件');
    expect(channelText()).not.toContain('数据库漂移');
  });

  it('实体定义读不到时警告并带实体名', async () => {
    windowish.activeTextEditor = {
      document: makeTextDocument('<root/>', {
        fileName: path.join(root, 'scripts', 'entity_defs', 'Ghost.def'),
        languageId: 'kbengine-def'
      })
    };
    await activateAndWait();

    await commands.executeCommand('kbengine.database.checkDrift');

    expect(messages.warning.at(-1)).toContain('读取实体定义失败: Ghost');
  });

  it('读不到引擎数据库配置时降级为未校验', async () => {
    writeDef('scripts/entity_defs/Hero.def', HERO_DEF.split('\n'));
    configurationOverrides.set('kbengine', { binPath: '/no/such/bin' });
    await activateAndWait();

    await commands.executeCommand('kbengine.database.checkDrift', 'Hero');

    expect(messages.info.at(-1)).toContain('数据库漂移未校验:读不到引擎数据库配置');
    expect(messages.warning).toEqual([]);
  });

  it('连不上数据库时如实降级并把报告写进 OUTPUT 通道', async () => {
    writeDef('scripts/entity_defs/Hero.def', HERO_DEF.split('\n'));
    writeEngineDefaults('127.0.0.1', await freePort());
    await activateAndWait();

    await commands.executeCommand('kbengine.database.checkDrift', 'Hero');

    const channel = windowState.channels.find(entry => entry.name === 'KBEngine 数据库漂移');
    expect(channel).toBeDefined();
    expect(channelText()).toContain('# KBEngine 数据库漂移: Hero');
    expect(channelText()).toContain('未校验:连不上数据库');
    expect(messages.info.at(-1)).toContain('数据库漂移未校验:Hero');
    expect(messages.warning).toEqual([]);
  });
});