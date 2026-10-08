import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ServerControlProvider } from '../src/explorerProviders';
import {
  readTelnetTargetsFromSettings,
  TelnetService,
  TelnetTarget,
  updateTelnetStatusBar
} from '../src/telnetService';
import { memoryFileSystem } from './helpers/vscodeStub';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';

// 装配层两个导出(extension.ts 薄调用)的全分支驱动:
// - readTelnetTargetsFromSettings:设置读取、configXmlPath 的存在/缺失/
//   ${workspaceFolder} 展开三路;
// - updateTelnetStatusBar:无目标隐藏、密码拒、N/M 开启、已连接、全未开
//   五种灯色,以及点击灯开面板的 command 接线。

interface FakeStatusBarItem {
  text: string;
  command?: string;
  shown: number;
  hidden: number;
  hide(): void;
  show(): void;
}

const makeStatusBarItem = (): FakeStatusBarItem => {
  const item: FakeStatusBarItem = {
    text: '',
    command: undefined,
    shown: 0,
    hidden: 0,
    hide() {
      item.hidden += 1;
    },
    show() {
      item.shown += 1;
    }
  };
  return item;
};

const override = (values: Record<string, unknown>): void => {
  configurationOverrides.set('kbengine', { ...configurationOverrides.get('kbengine'), ...values });
};

const makeServiceWithStates = (
  targets: Array<{ key: string }>,
  states: Record<string, string>
): TelnetService => {
  const service = new TelnetService({ getTargets: () => targets as never[] });
  // start 不调:直接注状态,聚焦状态灯文案分支
  (service as unknown as { targets: unknown }).targets = targets;
  for (const [key, state] of Object.entries(states)) {
    (service as unknown as { states: Map<string, string> }).states.set(key, state);
  }
  return service;
};

beforeEach(() => {
  configurationOverrides.clear();
  memoryFileSystem.reset();
  stubWorkspace.workspaceFolders = [];
});

describe('readTelnetTargetsFromSettings', () => {
  it('无任何配置:回落引擎默认七组件端口表', () => {
    const targets = readTelnetTargetsFromSettings();
    expect(targets.map(item => item.port)).toEqual([
      31000, 32000, 33000, 34000, 40000, 50000, 51000
    ]);
    expect(targets[0].password).toBe('');
  });

  it('设置显式 host/port/password/enableCommands:单目标生效', () => {
    override({
      'telnet.host': '10.0.0.8',
      'telnet.port': 31000,
      'telnet.password': 'set-pwd',
      'telnet.enableCommands': ['getCtrlEntities']
    });
    const targets = readTelnetTargetsFromSettings();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      key: '10.0.0.8:31000',
      host: '10.0.0.8',
      port: 31000,
      password: 'set-pwd',
      enableCommands: ['getCtrlEntities']
    });
  });

  it('configXmlPath 指向存在的 kbengine.xml:解析 <telnet_service> 端口/密码', () => {
    // src 侧读真 node fs:配置展开走 ${workspaceFolder},落真临时文件
    const xmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-telnet-'));
    const xmlPath = path.join(xmlDir, 'kbengine.xml');
    fs.writeFileSync(
      xmlPath,
      '<root><telnet_service><port>32123</port><password>xml-pwd</password></telnet_service></root>'
    );
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: xmlDir } } as never];
    override({ 'telnet.configXmlPath': '${workspaceFolder}/kbengine.xml' });

    try {
      const targets = readTelnetTargetsFromSettings();
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        key: '127.0.0.1:32123',
        port: 32123,
        password: 'xml-pwd',
        label: 'kbengine.xml'
      });
    } finally {
      fs.rmSync(xmlDir, { recursive: true, force: true });
    }
  });

  it('configXmlPath 指向不存在的文件:如实回落默认表(不猜)', () => {
    override({ 'telnet.configXmlPath': '/no/such/kbengine.xml' });
    const targets = readTelnetTargetsFromSettings();
    expect(targets).toHaveLength(7);
  });
});

describe('updateTelnetStatusBar', () => {
  it('无目标:隐藏且不设 command', () => {
    const service = makeServiceWithStates([], {});
    const item = makeStatusBarItem();
    updateTelnetStatusBar(service, item as never);
    expect(item.hidden).toBe(1);
    expect(item.shown).toBe(0);
    expect(item.command).toBeUndefined();
  });

  it('密码拒优先于其他状态', () => {
    const targets = [{ key: 'a' }, { key: 'b' }];
    const service = makeServiceWithStates(targets, { a: 'open', b: 'auth-rejected' });
    const item = makeStatusBarItem();
    updateTelnetStatusBar(service, item as never);
    expect(item.text).toBe('$(plug) Telnet: 密码被拒');
    expect(item.command).toBe('kbengine.telnet.showPanel');
    expect(item.shown).toBe(1);
  });

  it('部分开启:N/M 开启文案', () => {
    const targets = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
    const service = makeServiceWithStates(targets, { a: 'open', b: 'auth-required', c: 'closed' });
    const item = makeStatusBarItem();
    updateTelnetStatusBar(service, item as never);
    expect(item.text).toBe('$(plug) Telnet: 2/3 开启');
  });

  it('存在会话连接:已连接文案', () => {
    const targets = [{ key: 'a' }, { key: 'b' }];
    const service = makeServiceWithStates(targets, { a: 'connected', b: 'closed' });
    const item = makeStatusBarItem();
    updateTelnetStatusBar(service, item as never);
    expect(item.text).toBe('$(plug) Telnet: 已连接');
  });

  it('全未开:未开启文案', () => {
    const targets = [{ key: 'a' }];
    const service = makeServiceWithStates(targets, { a: 'closed' });
    const item = makeStatusBarItem();
    updateTelnetStatusBar(service, item as never);
    expect(item.text).toBe('$(plug) Telnet: 未开启');
    expect(item.shown).toBe(1);
  });
});

describe('ServerControlProvider telnet 树项(注入 telnetService 才追加)', () => {
  const telnetTarget = (over: Partial<TelnetTarget> = {}): TelnetTarget => ({
    key: '127.0.0.1:31000',
    label: 'loginapp',
    component: 'loginapp',
    host: '127.0.0.1',
    port: 31000,
    password: 'pwd123456',
    enableCommands: [],
    ...over
  });

  const makeProvider = (
    targets: TelnetTarget[],
    states: Record<string, string>
  ): ServerControlProvider => {
    const service = new TelnetService({ getTargets: () => targets });
    (service as unknown as { targets: unknown }).targets = targets;
    for (const [key, state] of Object.entries(states)) {
      (service as unknown as { states: Map<string, string> }).states.set(key, state);
    }
    const manager = {
      getAllServers: () => [],
      getRunningServers: () => new Map()
    };
    return new ServerControlProvider(manager as never, service);
  };

  it('注入后树尾追加 telnet 状态灯项;单参构造保持纯组件列表', async () => {
    const provider = makeProvider([telnetTarget()], { '127.0.0.1:31000': 'connected' });
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const item = children[0];
    expect(item.label).toBe('Telnet: loginapp');
    expect(item.contextValue).toBe('telnet_127.0.0.1:31000');
    expect(item.description).toBe('127.0.0.1:31000 · 已连接');
    expect((item.iconPath as { id: string }).id).toBe('circle-filled');
    expect(item.command?.command).toBe('kbengine.telnet.showPanel');
    expect(item.tooltip).toContain('telnet loginapp');
    expect(provider.getTreeItem(item)).toBe(item);
    await expect(provider.getChildren(item as never)).resolves.toEqual([]);

    // 单参构造(既有行为):不注入则纯组件列表,无 telnet 项
    const bare = new ServerControlProvider({ getAllServers: () => [], getRunningServers: () => new Map() } as never);
    await expect(bare.getChildren()).resolves.toHaveLength(0);
  });

  it('各状态灯图标与文案逐一定位', async () => {
    const targets = [
      telnetTarget(),
      telnetTarget({ key: 'k2', label: 'dbmgr', port: 32000 }),
      telnetTarget({ key: 'k3', label: 'baseapp', port: 40000 }),
      telnetTarget({ key: 'k4', label: 'cellapp', port: 50000 }),
      telnetTarget({ key: 'k5', label: 'bots', port: 51000 })
    ];
    const provider = makeProvider(targets, {
      '127.0.0.1:31000': 'closed',
      k2: 'open',
      k3: 'auth-required',
      k4: 'auth-rejected',
      k5: 'unconfigured'
    });
    const items = await provider.getChildren();
    const byLabel = Object.fromEntries(items.map(item => [item.label, item]));
    expect((byLabel['Telnet: loginapp'].iconPath as { id: string }).id).toBe('circle-slash');
    expect(byLabel['Telnet: loginapp'].description).toContain('未开启');
    expect((byLabel['Telnet: dbmgr'].iconPath as { id: string }).id).toBe('circle-large-outline');
    expect(byLabel['Telnet: dbmgr'].description).toContain('已开启');
    expect((byLabel['Telnet: baseapp'].iconPath as { id: string }).id).toBe('warning');
    expect(byLabel['Telnet: baseapp'].description).toContain('端口开·未配密码');
    expect((byLabel['Telnet: cellapp'].iconPath as { id: string }).id).toBe('circle-slash');
    expect(byLabel['Telnet: cellapp'].description).toContain('密码被拒');
    expect(byLabel['Telnet: bots'].description).toContain('未配置');
  });
});
