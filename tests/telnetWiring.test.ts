import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { TelnetTreeProvider } from '../src/telnetTree';
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
//   ${workspaceFolder} 展开、未配置时的约定路径探测(kbengine.xml /
//   res/server/kbengine.xml / assets/res/server/kbengine.xml),以及批111
//   用户令的门控口径:配置未开 telnet → 空目标,不回落引擎默认表;
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
  it('无任何配置且无工作区:配置未开 telnet → 空目标(不再回落默认表)', () => {
    // 批111 用户令:配置里都没有开启 telnet 就不展示 telnet 相关的东西
    expect(readTelnetTargetsFromSettings()).toEqual([]);
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

  it('configXmlPath 指向不存在的文件:配置未开 telnet → 空目标(不猜)', () => {
    override({ 'telnet.configXmlPath': '/no/such/kbengine.xml' });
    expect(readTelnetTargetsFromSettings()).toEqual([]);
  });

  it('configXmlPath 指向存在的 xml 但无 <telnet_service> 段:段不在=未开 → 空目标', () => {
    // 官方 demo 的 kbengine.xml 就没有该段:此时不展示 telnet 入口
    const xmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-telnet-nosection-'));
    fs.writeFileSync(path.join(xmlDir, 'kbengine.xml'), '<root><res_paths/></root>');
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: xmlDir } } as never];
    override({ 'telnet.configXmlPath': '${workspaceFolder}/kbengine.xml' });

    try {
      expect(readTelnetTargetsFromSettings()).toEqual([]);
    } finally {
      fs.rmSync(xmlDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['工作区根', '', 'kbengine.xml'],
    ['约定布局 res/server', 'res/server', 'kbengine.xml'],
    ['嵌套 assets 布局', 'assets/res/server', 'kbengine.xml']
  ])('未配置 configXmlPath:约定路径探测(%s)', (_name, subDir, fileName) => {
    const xmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-telnet-discover-'));
    const target = subDir
      ? path.join(xmlDir, ...subDir.split('/'), fileName)
      : path.join(xmlDir, fileName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      '<root><telnet_service><port>32555</port></telnet_service></root>'
    );
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: xmlDir } } as never];

    try {
      const targets = readTelnetTargetsFromSettings();
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ key: '127.0.0.1:32555', port: 32555, label: 'kbengine.xml' });
    } finally {
      fs.rmSync(xmlDir, { recursive: true, force: true });
    }
  });

  it('未配置 configXmlPath 且约定路径全缺:空目标(不猜)', () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-telnet-bare-'));
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: bareDir } } as never];

    try {
      expect(readTelnetTargetsFromSettings()).toEqual([]);
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it('configPath 下的 kbengine.xml 优先于约定路径(引擎 KBE_RES_PATH 项目侧)', () => {
    const xmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-telnet-configpath-'));
    const configDir = path.join(xmlDir, 'server');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'kbengine.xml'),
      '<root><telnet_service><port>32666</port></telnet_service></root>'
    );
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: xmlDir } } as never];
    override({ configPath: '${workspaceFolder}/server' });

    try {
      const targets = readTelnetTargetsFromSettings();
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ key: '127.0.0.1:32666', port: 32666 });
    } finally {
      fs.rmSync(xmlDir, { recursive: true, force: true });
    }
  });

  it('xml 段在而无端口 + binPath 指向引擎树:逐组件端口/密码取 kbengine_defaults.xml', () => {
    // 批112 用户令:引擎 defaults 先载、元件 kbengine.xml 覆盖——defaults 补值
    const xmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-telnet-defaults-'));
    fs.writeFileSync(
      path.join(xmlDir, 'kbengine.xml'),
      '<root><telnet_service></telnet_service></root>'
    );
    const engineDir = path.join(xmlDir, 'kbe');
    fs.mkdirSync(path.join(engineDir, 'res', 'server'), { recursive: true });
    fs.mkdirSync(path.join(engineDir, 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(engineDir, 'res', 'server', 'kbengine_defaults.xml'),
      [
        '<root>',
        '  <loginapp><telnet_service><port> 31000 </port><password> pwd123456 </password></telnet_service></loginapp>',
        '  <baseapp><telnet_service><port> 40001 </port><password> pwd123456 </password></telnet_service></baseapp>',
        '</root>'
      ].join('\n')
    );
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: xmlDir } } as never];
    override({ binPath: '${workspaceFolder}/kbe/bin/server' });

    try {
      const targets = readTelnetTargetsFromSettings();
      expect(targets).toHaveLength(7);
      const byComponent = Object.fromEntries(targets.map(target => [target.component, target]));
      expect(byComponent.baseapp.port).toBe(40001); // defaults 解析值覆盖常量表
      expect(byComponent.loginapp.port).toBe(31000);
      expect(byComponent.cellapp.port).toBe(50000); // defaults 未覆盖 → 常量表
      expect(targets.every(target => target.password === 'pwd123456')).toBe(true);
    } finally {
      fs.rmSync(xmlDir, { recursive: true, force: true });
    }
  });

  it('binPath 推得出 defaults 但文件缺失:catch 臂回落常量端口表', () => {
    const xmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-telnet-noread-'));
    fs.writeFileSync(
      path.join(xmlDir, 'kbengine.xml'),
      '<root><telnet_service></telnet_service></root>'
    );
    fs.mkdirSync(path.join(xmlDir, 'kbe', 'bin'), { recursive: true });
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: xmlDir } } as never];
    override({ binPath: '${workspaceFolder}/kbe/bin/server' });

    try {
      const targets = readTelnetTargetsFromSettings();
      expect(targets.map(target => target.port)).toEqual([
        31000, 32000, 33000, 34000, 40000, 50000, 51000
      ]);
    } finally {
      fs.rmSync(xmlDir, { recursive: true, force: true });
    }
  });

  it('binPath 推导不出引擎 defaults(后缀不在):回落常量端口表', () => {
    const xmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-telnet-nodefaults-'));
    fs.writeFileSync(
      path.join(xmlDir, 'kbengine.xml'),
      '<root><telnet_service></telnet_service></root>'
    );
    stubWorkspace.workspaceFolders = [{ uri: { fsPath: xmlDir } } as never];
    override({ binPath: '${workspaceFolder}/kbe/bin' });

    try {
      const targets = readTelnetTargetsFromSettings();
      expect(targets.map(target => target.port)).toEqual([
        31000, 32000, 33000, 34000, 40000, 50000, 51000
      ]);
    } finally {
      fs.rmSync(xmlDir, { recursive: true, force: true });
    }
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

describe('TelnetTreeProvider(批112 用户令:telnet 独立树视图,与 server 进程分开)', () => {
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
  ): TelnetTreeProvider => {
    const service = new TelnetService({ getTargets: () => targets });
    (service as unknown as { targets: unknown }).targets = targets;
    for (const [key, state] of Object.entries(states)) {
      (service as unknown as { states: Map<string, string> }).states.set(key, state);
    }
    return new TelnetTreeProvider(service);
  };

  it('独立树只列 telnet 状态灯项,刷新走 onDidChangeTreeData', async () => {
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

    // 空目标时独立树为空列表(manifest when 子句隐藏整个视图)
    const bare = new TelnetTreeProvider({ getTargets: () => [], getState: () => 'unconfigured' });
    expect(bare.getChildren()).toHaveLength(0);
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
    const items = provider.getChildren();
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
