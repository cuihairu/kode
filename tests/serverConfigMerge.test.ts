import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FinalConfigContentProvider,
  FinalConfigTreeProvider,
  KBE_CONFIG_SCHEME,
  KBE_CONFIG_VIRTUAL_PATH,
  buildFinalServerConfig,
  renderConfigXml,
  renderConfigXmlSections,
  resetDatabaseInterfaceConfigCache,
  resolveCustomConfigXmlPath,
  resolveDatabaseInterfaceConfig,
  type ConfigXmlNode
} from '../src/serverConfigMerge';
import { ensureConfigResolved, resetConfigResolveForTests } from '../src/serverConfigResolve';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import {
  extractDatabaseInterfaceConfig,
  makeContractGate,
  parseConfigXml,
  type ContractGateCall
} from './helpers/configCoreContract';
import { memoryFileSystem } from './helpers/vscodeStub';
import { configurationOverrides, workspace as stubWorkspace } from './fake-vscode/workspaceState';

// 最终服务端配置合成(批112 用户令):引擎 defaults 先载、元件 kbengine.xml
// 覆盖,虚拟文档展示(telnet 端口/密码同源)。锁解析容错、合并四分支
// (仅默认/仅自定义/双容器递归/叶子整名替换)、渲染排版、命令源装配与
// telnet 速览。

const node = (name: string, text = '', children: ConfigXmlNode[] = []): ConfigXmlNode => ({
  name,
  text,
  children
});

/**
 * 取合成文本里按元素名逐层下钻的叶子文本:增强(默认开)会在每个元素内部
 * 加作用注释并把值挪到独立行,按文本子串断言取不到值,故改按树取值。
 */
const leafText = (xml: string, ...names: string[]): string | undefined => {
  let current: ConfigXmlNode | null = parseConfigXml(xml);
  for (const name of names) {
    current = current?.children.find(child => child.name === name) ?? null;
  }
  return current?.text;
};

// KODE-CFG-009:src 侧 parse/merge/telnet 速览/连接要素实现已下线(core 唯一);
// 消费面测试经门替身按契约回数(parse/merge/telnet/连接要素真值由 Rust
// rpc_dispatch + config_resolve_units 钉死,镜像语义在 configCoreContract)。
const contractCalls: ContractGateCall[] = [];

/** 装契约门替身并刷新 core 消费态(async 消费面测试入口先 await 本函数) */
const refreshCore = async (): Promise<void> => {
  contractCalls.length = 0;
  resetConfigResolveForTests();
  resetDatabaseInterfaceConfigCache();
  setKodeCoreShadowGate(makeContractGate(contractCalls));
  await ensureConfigResolved();
};

describe('renderConfigXml / renderConfigXmlSections', () => {
  it('叶子带值两侧留空,空值收成对标签;容器 tab 缩进;伪根不输出', () => {
    const rendered = renderConfigXmlSections(
      node('', '', [
        node('baseapp', '', [node('port', '40000'), node('password')]),
        node('emptySection')
      ])
    );
    expect(rendered).toBe(
      ['<baseapp>', '\t<port> 40000 </port>', '\t<password></password>', '</baseapp>', '<emptySection></emptySection>'].join('\n')
    );
    expect(renderConfigXml(node('port', '40000'))).toBe('<port> 40000 </port>');
  });
});

describe('resolveCustomConfigXmlPath / buildFinalServerConfig(装配读值)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    memoryFileSystem.reset();
    stubWorkspace.workspaceFolders = [];
  });

  it('assetsRoot 下的 kbengine.xml 优先,其次约定路径,全缺为 null', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-'));
    try {
      stubWorkspace.workspaceFolders = [];
      expect(resolveCustomConfigXmlPath(undefined)).toBeNull();
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      expect(resolveCustomConfigXmlPath(root)).toBeNull();

      const convention = path.join(root, 'res', 'server', 'kbengine.xml');
      fs.mkdirSync(path.dirname(convention), { recursive: true });
      fs.writeFileSync(convention, '<root><baseapp><debug> 1 </debug></baseapp></root>');
      expect(resolveCustomConfigXmlPath(root)).toBe(convention);

      const serverDir = path.join(root, 'server');
      fs.mkdirSync(serverDir, { recursive: true });
      const configPathXml = path.join(serverDir, 'kbengine.xml');
      fs.writeFileSync(configPathXml, '<root><baseapp><debug> 2 </debug></baseapp></root>');
      configurationOverrides.set('kbengine', { assetsRoot: '${workspaceFolder}/server' });
      expect(resolveCustomConfigXmlPath(root)).toBe(configPathXml);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('未配置 assetsRoot:发现出的资产根参与探测(server_assets 布局,批128)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-disc-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      const discoveredXml = path.join(root, 'server_assets', 'res', 'server', 'kbengine.xml');
      fs.mkdirSync(path.dirname(discoveredXml), { recursive: true });
      fs.writeFileSync(discoveredXml, '<root><baseapp><debug> 3 </debug></baseapp></root>');

      expect(resolveCustomConfigXmlPath(root)).toBe(discoveredXml);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binPath 推导不出 defaults:命令层拿空文本与默认定位', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-nodefault-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      configurationOverrides.set('kbengine', { binPath: '/no/such/bin' });
      await refreshCore();
      const result = buildFinalServerConfig();
      expect(result.text).toBe('');
      expect(result.defaultsOnly).toBe(true);
      expect(result.defaultsPath).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binPath 推得出 defaults 但文件缺失:按纯默认空文本处理', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-noread-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      fs.mkdirSync(path.join(root, 'kbe', 'bin'), { recursive: true });
      configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
      await refreshCore();

      const result = buildFinalServerConfig();
      expect(result.text).toBe('');
      expect(result.defaultsPath).toBe(path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml'));
      expect(result.defaultsOnly).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults 在:合成展示覆盖值;纯默认时 defaultsOnly', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-merge-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      const engine = path.join(root, 'kbe');
      fs.mkdirSync(path.join(engine, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(engine, 'res', 'server'), { recursive: true });
      fs.writeFileSync(
        path.join(engine, 'res', 'server', 'kbengine_defaults.xml'),
        [
          '<defaults>',
          '  <baseapp>',
          '    <archivePeriod> 300 </archivePeriod>',
          '    <telnet_service>',
          '      <port> 40000 </port>',
          '      <password> pwd123456 </password>',
          '    </telnet_service>',
          '  </baseapp>',
          '  <machine>',
          '    <addresses> </addresses>',
          '  </machine>',
          '</defaults>'
        ].join('\n')
      );
      configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
      await refreshCore();

      // 纯默认:无元件 kbengine.xml
      const onlyDefaults = buildFinalServerConfig();
      expect(onlyDefaults.defaultsOnly).toBe(true);
      expect(onlyDefaults.defaultsPath).toBe(path.join(engine, 'res', 'server', 'kbengine_defaults.xml'));
      expect(leafText(onlyDefaults.text, 'defaults', 'baseapp', 'archivePeriod')).toBe('300');
      expect(leafText(onlyDefaults.text, 'defaults', 'baseapp', 'telnet_service', 'port')).toBe('40000');
      // 头注标一句来源与覆盖口径(默认开启令:读者不用猜数据从哪来);
      // 头注在增强后放进第一个顶层元素内部(注释不落文件头)
      expect(onlyDefaults.text).toContain('仅引擎默认');
      expect(onlyDefaults.text).toContain('kbengine_defaults.xml');

      // 元件 kbengine.xml 覆盖 archivePeriod 并新增 externalAddress
      fs.writeFileSync(
        path.join(root, 'kbengine.xml'),
        '<root><baseapp><archivePeriod>600</archivePeriod><externalAddress>10.0.0.9</externalAddress></baseapp></root>'
      );
      await refreshCore();
      const merged = buildFinalServerConfig();
      expect(merged.defaultsOnly).toBe(false);
      expect(merged.customPath).toBe(path.join(root, 'kbengine.xml'));
      expect(leafText(merged.text, 'root', 'baseapp', 'archivePeriod')).toBe('600');
      expect(leafText(merged.text, 'root', 'baseapp', 'externalAddress')).toBe('10.0.0.9');
      expect(leafText(merged.text, 'defaults', 'baseapp', 'telnet_service', 'password')).toBe('pwd123456');
      expect(merged.text).toContain('同键覆盖');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('元件 kbengine.xml 无元素可解析:按纯默认展示', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-garbage-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      const engine = path.join(root, 'kbe');
      fs.mkdirSync(path.join(engine, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(engine, 'res', 'server'), { recursive: true });
      fs.writeFileSync(
        path.join(engine, 'res', 'server', 'kbengine_defaults.xml'),
        '<defaults><baseapp><archivePeriod> 300 </archivePeriod></baseapp></defaults>'
      );
      fs.writeFileSync(path.join(root, 'kbengine.xml'), '<!-- nothing parseable -->');
      configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
      await refreshCore();

      const result = buildFinalServerConfig();
      expect(result.defaultsOnly).toBe(true);
      expect(result.customPath).toBe(path.join(root, 'kbengine.xml'));
      expect(leafText(result.text, 'defaults', 'baseapp', 'archivePeriod')).toBe('300');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('内容提供者每次打开重算合成文本', () => {
    const provider = new FinalConfigContentProvider();
    expect(provider.provideTextDocumentContent({} as never)).toBe(
      buildFinalServerConfig().text
    );
  });

  it('refresh 发 onDidChange(虚拟文档 URI),文件联动刷新可达', () => {
    const provider = new FinalConfigContentProvider();
    const fired: Array<{ fsPath: string }> = [];
    provider.onDidChange(uri => fired.push(uri as { fsPath: string }));

    provider.refresh();

    expect(fired).toHaveLength(1);
    expect((fired[0] as unknown as { scheme: string }).scheme).toBe(KBE_CONFIG_SCHEME);
    expect(String(fired[0].fsPath)).toContain('kbengine-final.xml');
  });
});

describe('FinalConfigTreeProvider(侧栏常驻入口)', () => {
  it('单节点「最终配置」,点击即开 showFinal 命令', () => {
    const provider = new FinalConfigTreeProvider();
    const items = provider.getChildren();
    expect(items).toHaveLength(1);
    const item = provider.getTreeItem(items[0]);
    expect(item.label).toBe('Final Configuration');
    expect(item.description).toBe('kbengine-final.xml');
    expect(item.command).toMatchObject({ command: 'kbengine.config.showFinal' });
    expect(item.tooltip).toContain('只读视图');
  });
});

describe('buildFinalServerConfig 引擎源码根兜底(批125 自动发现)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    memoryFileSystem.reset();
    stubWorkspace.workspaceFolders = [];
  });

  it('binPath 未配时经 kbe 源码根锚点推出 defaults 路径并合成展示', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-anchor-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      fs.mkdirSync(path.join(root, 'kbe', 'src', 'lib', 'entitydef'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'kbe', 'src', 'lib', 'entitydef', 'entitydef.cpp'),
        '// anchor\n',
        'utf8'
      );
      fs.mkdirSync(path.join(root, 'kbe', 'res', 'server'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml'),
        '<baseapp><debug> 7 </debug></baseapp>',
        'utf8'
      );
      configurationOverrides.set('kbengine', { binPath: '' });
      await refreshCore();

      const result = buildFinalServerConfig();

      expect(result.defaultsPath)
        .toBe(path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml'));
      expect(result.defaultsOnly).toBe(true);
      expect(leafText(result.text, 'baseapp', 'debug')).toBe('7');
    } finally {
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binPath 未配且无引擎锚点时仍为空文本,不猜测路径', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-noanchor-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      configurationOverrides.set('kbengine', { binPath: '' });
      await refreshCore();

      const result = buildFinalServerConfig();

      expect(result.text).toBe('');
      expect(result.defaultsPath).toBeNull();
      expect(result.defaultsOnly).toBe(true);
    } finally {
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveDatabaseInterfaceConfig(合成口径读值与缓存,批131)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    memoryFileSystem.reset();
    stubWorkspace.workspaceFolders = [];
    resetDatabaseInterfaceConfigCache();
  });

  it('defaults + 元件 kbengine.xml 合成后读连接:自定义库名/端口覆盖默认', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-dbiface-merge-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      const engine = path.join(root, 'kbe');
      fs.mkdirSync(path.join(engine, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(engine, 'res', 'server'), { recursive: true });
      fs.writeFileSync(
        path.join(engine, 'res', 'server', 'kbengine_defaults.xml'),
        [
          '<root>',
          '  <dbmgr>',
          '    <databaseInterfaces>',
          '      <default>',
          '        <host> localhost </host>',
          '        <port> 0 </port>',
          '        <auth><username> kbe </username><encrypt> true </encrypt></auth>',
          '        <databaseName> kbe </databaseName>',
          '      </default>',
          '    </databaseInterfaces>',
          '  </dbmgr>',
          '</root>'
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(root, 'kbengine.xml'),
        [
          '<root>',
          '  <dbmgr>',
          '    <databaseInterfaces>',
          '      <default>',
          '        <port> 13306 </port>',
          '        <databaseName> game_db </databaseName>',
          '      </default>',
          '    </databaseInterfaces>',
          '  </dbmgr>',
          '</root>'
        ].join('\n')
      );
      configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
      await refreshCore();

      expect(resolveDatabaseInterfaceConfig()).toEqual({
        host: 'localhost',
        port: 13306,
        username: 'kbe',
        databaseName: 'game_db',
        encrypt: true,
        characterSet: 'utf8mb4'
      });

      // 缓存生效:元件配置改写后不 reset 不重读,reset 后才取新值
      fs.writeFileSync(
        path.join(root, 'kbengine.xml'),
        '<root><dbmgr><databaseInterfaces><default><databaseName> game2 </databaseName></default></databaseInterfaces></dbmgr></root>'
      );
      expect(resolveDatabaseInterfaceConfig()!.databaseName).toBe('game_db');
      // reset 失效消费态后,经 ensure 重取 core 才见新值(KODE-CFG-009:
      // 读值来自 core,不存在本地重算路径)
      resetDatabaseInterfaceConfigCache();
      expect(resolveDatabaseInterfaceConfig()).toBeNull();
      await ensureConfigResolved();
      expect(resolveDatabaseInterfaceConfig()!.databaseName).toBe('game2');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults 不可得 → null,不虚构连接', async () => {
    await refreshCore();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-dbiface-none-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      configurationOverrides.set('kbengine', { binPath: '/no/such/bin' });

      expect(resolveDatabaseInterfaceConfig()).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
