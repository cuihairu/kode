import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate } from '../src/extension';
import { setActiveProfile } from '../src/activeProfile';
import { ProjectProfileStore } from '../src/projectProfiles';
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

/** 三个互不为前缀的端口(ECONNREFUSED 文案按 127.0.0.1:port 断言,前缀串会误伤) */
const threeDistinctPorts = async (): Promise<[number, number, number]> => {
  for (;;) {
    const ports = await Promise.all([freePort(), freePort(), freePort()]);
    const texts = ports.map(port => String(port));
    const pairwiseNoPrefix = texts.every((text, i) =>
      texts.every((other, j) => i === j || !other.startsWith(text))
    );
    if (pairwiseNoPrefix) {
      return ports as [number, number, number];
    }
  }
};

/** 引擎 defaults 落任意目录(dbmgr 连接要素带指定端口) */
const writeEngineDefaultsAt = (dir: string, host: string, port: number): void => {
  const engine = path.join(dir, 'kbe', 'res', 'server');
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
};

/** 落一份引擎 defaults(dbmgr 连接要素)+ binPath 覆盖,让引擎配置读得到 */
const writeEngineDefaults = (host: string, port: number): void => {
  writeEngineDefaultsAt(root, host, port);
  configurationOverrides.set('kbengine', { binPath: `${root}/kbe/bin/server` });
};

const activateAndWait = async (workspaceState?: unknown): Promise<ExtensionContext> => {
  const context = makeContext();
  if (workspaceState) {
    context.workspaceState = workspaceState;
  }
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

// IDE-REV-015(原项 IDE-DB-001 重开):命令的连接配置必须经 profile 台账。
// 验收口径:两个项目(两个 profile,引擎 defaults 各配一个端口)从注册命令
// 执行查询,连接要素各连各的库——工作区设置链另配第三个端口作探针,命令
// 只要绕过台账(直接读工作区配置/沿用旧 profile 配置),端口即串,断言即红。
class MemoryMemento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }
  keys(): readonly string[] {
    return [...this.map.keys()];
  }
  setKeysForSync(_keys: readonly string[]): void {
    // 内存替身不参与云同步
  }
}

describe('kbengine.database.checkDrift 命令 · profile 连接台账(IDE-REV-015)', () => {
  it('两项目两配置:命令各连各的库,端口互不串(漏接台账即被捕获)', async () => {
    writeDef('scripts/entity_defs/Hero.def', HERO_DEF.split('\n'));
    const [portA, portB, portC] = await threeDistinctPorts();
    // 工作区设置链配第三处(端口 C):命令绕过台账就会连到这里
    writeEngineDefaults('127.0.0.1', portC);
    // 两个 profile 各带自己的引擎根(端口 A / B)
    const engineA = path.join(root, 'eng-a');
    const engineB = path.join(root, 'eng-b');
    writeEngineDefaultsAt(engineA, '127.0.0.1', portA);
    writeEngineDefaultsAt(engineB, '127.0.0.1', portB);
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento as never);
    const profileA = await store.create({ displayName: 'A', assetsRoot: '', engineRoot: engineA });
    const profileB = await store.create({ displayName: 'B', assetsRoot: '', engineRoot: engineB });
    await setActiveProfile(memento as never, profileA.id);
    await activateAndWait(memento);

    await commands.executeCommand('kbengine.database.checkDrift', 'Hero');
    expect(channelText()).toContain(`127.0.0.1:${portA}`); // 连的是 A 的库
    expect(channelText()).not.toContain(`127.0.0.1:${portC}`); // 不是工作区探针

    await setActiveProfile(memento as never, profileB.id);
    await commands.executeCommand('kbengine.database.checkDrift', 'Hero');
    expect(channelText()).toContain(`127.0.0.1:${portB}`); // 切换后连 B 的库
    expect(channelText()).not.toContain(`127.0.0.1:${portA}`); // 不沿用 A 的配置
    expect(channelText()).not.toContain(`127.0.0.1:${portC}`);
  });

  it('profile 引擎根读不到配置 → 如实未校验,不落工作区设置链的配置', async () => {
    writeDef('scripts/entity_defs/Hero.def', HERO_DEF.split('\n'));
    const [, , portC] = await threeDistinctPorts();
    writeEngineDefaults('127.0.0.1', portC); // 工作区链有配置(探针)
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento as never);
    const broken = await store.create({
      displayName: 'broken', assetsRoot: '', engineRoot: path.join(root, 'eng-none')
    });
    await setActiveProfile(memento as never, broken.id);
    await activateAndWait(memento);

    await commands.executeCommand('kbengine.database.checkDrift', 'Hero');

    expect(messages.info.at(-1)).toContain('数据库漂移未校验:读不到引擎数据库配置');
    expect(channelText()).not.toContain(`127.0.0.1:${portC}`); // 没拿工作区配置去连
  });
});