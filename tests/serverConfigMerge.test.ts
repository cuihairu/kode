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
  extractDatabaseInterfaceConfig,
  mergeConfigXml,
  parseConfigXml,
  renderConfigXml,
  renderConfigXmlSections,
  resetDatabaseInterfaceConfigCache,
  resolveCustomConfigXmlPath,
  resolveDatabaseInterfaceConfig,
  summarizeFinalTelnet,
  type ConfigXmlNode
} from '../src/serverConfigMerge';
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

describe('parseConfigXml', () => {
  it('解析元素树:注释/XML 声明剥离,自闭合不入栈,叶子收文本', () => {
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<!-- kbengine defaults -->',
      '<dbmgr>',
      '  <debug> 1 </debug>',
      '  <ids />',
      '  <account_system>',
      '    <accountEntityScriptType> Account </accountEntityScriptType>',
      '  </account_system>',
      '</dbmgr>'
    ].join('\n');
    const tree = parseConfigXml(xml)!;
    expect(tree.name).toBe('');
    expect(tree.children).toHaveLength(1);
    const dbmgr = tree.children[0];
    expect(dbmgr.children.map(child => child.name)).toEqual([
      'debug',
      'ids',
      'account_system'
    ]);
    expect(dbmgr.children[0].text).toBe('1');
    expect(dbmgr.children[1]).toEqual({ name: 'ids', text: '', children: [] });
    expect(dbmgr.children[2].children[0].text).toBe('Account');
  });

  it('多段文本合并进同一叶子;根层散落文本被忽略', () => {
    const tree = parseConfigXml('lead text<mixed> x <inner>1</inner> y </mixed>')!;
    const mixed = tree.children[0];
    expect(mixed.text).toBe('x y');
    expect(mixed.children[0].text).toBe('1');
    expect(tree.text).toBe('');
  });

  it('多余/错位闭合容错:根层闭合与名字不符的闭合都被忽略', () => {
    // <b> 内 </x> 名字不符被忽略;<b> 正常闭合后,根层的 </stray>/</c> 均忽略
    const mismatched = parseConfigXml('<a><b>1</x></b></a>')!;
    expect(mismatched.children).toHaveLength(1);
    expect(mismatched.children[0].children[0].text).toBe('1');

    const strayAtRoot = parseConfigXml('<a><b>1</b></stray></c>')!;
    expect(strayAtRoot.children).toHaveLength(1);
    expect(strayAtRoot.children[0].name).toBe('a');
  });

  it('无元素 → null', () => {
    expect(parseConfigXml('<!-- only comment -->')).toBeNull();
    expect(parseConfigXml('')).toBeNull();
  });
});

describe('mergeConfigXml(引擎同键覆盖口径)', () => {
  it('仅默认保留、仅自定义新增', () => {
    const merged = mergeConfigXml(
      node('', '', [node('machine', '', [node('addresses')]), node('entryScriptFile', 'm.py')]),
      node('', '', [node('logger', '', [node('tick_sync_logs', '0')])])
    );
    expect(merged.children.map(child => child.name)).toEqual([
      'machine',
      'entryScriptFile',
      'logger'
    ]);
  });

  it('双容器段递归下钻;叶子与重复名列表整名替换', () => {
    const merged = mergeConfigXml(
      node('', '', [
        node('baseapp', '', [
          node('telnet_service', '', [node('port', '40000'), node('password', 'pwd123456')]),
          node('archivePeriod', '300')
        ])
      ]),
      node('', '', [
        node('baseapp', '', [
          node('telnet_service', '', [node('port', '41000')]),
          node('externalAddress', '10.0.0.1')
        ])
      ])
    );
    const baseapp = merged.children[0];
    const telnet = baseapp.children.find(child => child.name === 'telnet_service')!;
    // 递归:port 被自定义覆盖,password 仅默认有 → 保留
    expect(telnet.children.map(child => `${child.name}=${child.text}`)).toEqual([
      'port=41000',
      'password=pwd123456'
    ]);
    // 叶子:archivePeriod 仅默认保留;externalAddress 仅自定义新增
    expect(baseapp.children.map(child => child.name)).toEqual([
      'telnet_service',
      'archivePeriod',
      'externalAddress'
    ]);
  });

  it('重复名列表(如 <item>):自定义整表替换,不与默认表交错', () => {
    const merged = mergeConfigXml(
      node('', '', [node('addresses', '', [node('item', '10.0.0.1'), node('item', '10.0.0.2')])]),
      node('', '', [node('addresses', '', [node('item', '192.168.1.1')])])
    );
    const addresses = merged.children[0];
    expect(addresses.children.map(child => child.text)).toEqual(['192.168.1.1']);
  });

  it('一侧容器一侧叶子:整名取自定义侧', () => {
    const merged = mergeConfigXml(
      node('', '', [node('odd', '', [node('deep', '1')])]),
      node('', '', [node('odd', 'flat')])
    );
    expect(merged.children[0]).toEqual(node('odd', 'flat'));
  });
});

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

  it('binPath 推导不出 defaults:命令层拿空文本与默认定位', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-nodefault-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      configurationOverrides.set('kbengine', { binPath: '/no/such/bin' });
      const result = buildFinalServerConfig();
      expect(result.text).toBe('');
      expect(result.defaultsOnly).toBe(true);
      expect(result.defaultsPath).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binPath 推得出 defaults 但文件缺失:按纯默认空文本处理', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-noread-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      fs.mkdirSync(path.join(root, 'kbe', 'bin'), { recursive: true });
      configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });

      const result = buildFinalServerConfig();
      expect(result.text).toBe('');
      expect(result.defaultsPath).toBe(path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml'));
      expect(result.defaultsOnly).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults 在:合成展示覆盖值;纯默认时 defaultsOnly', () => {
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

      // 纯默认:无元件 kbengine.xml
      const onlyDefaults = buildFinalServerConfig();
      expect(onlyDefaults.defaultsOnly).toBe(true);
      expect(onlyDefaults.defaultsPath).toBe(path.join(engine, 'res', 'server', 'kbengine_defaults.xml'));
      expect(onlyDefaults.text).toContain('<archivePeriod> 300 </archivePeriod>');
      expect(onlyDefaults.text).toContain('<port> 40000 </port>');
      // 头注标一句来源与覆盖口径(默认开启令:读者不用猜数据从哪来)
      expect(onlyDefaults.text.split('\n')[0]).toContain('仅引擎默认');
      expect(onlyDefaults.text.split('\n')[0]).toContain('kbengine_defaults.xml');

      // 元件 kbengine.xml 覆盖 archivePeriod 并新增 externalAddress
      fs.writeFileSync(
        path.join(root, 'kbengine.xml'),
        '<root><baseapp><archivePeriod>600</archivePeriod><externalAddress>10.0.0.9</externalAddress></baseapp></root>'
      );
      const merged = buildFinalServerConfig();
      expect(merged.defaultsOnly).toBe(false);
      expect(merged.customPath).toBe(path.join(root, 'kbengine.xml'));
      expect(merged.text).toContain('<archivePeriod> 600 </archivePeriod>');
      expect(merged.text).toContain('<externalAddress> 10.0.0.9 </externalAddress>');
      expect(merged.text).toContain('<password> pwd123456 </password>');
      expect(merged.text.split('\n')[0]).toContain('同键覆盖');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('元件 kbengine.xml 无元素可解析:按纯默认展示', () => {
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

      const result = buildFinalServerConfig();
      expect(result.defaultsOnly).toBe(true);
      expect(result.customPath).toBe(path.join(root, 'kbengine.xml'));
      expect(result.text).toContain('<archivePeriod> 300 </archivePeriod>');
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
    expect(item.label).toBe('最终配置');
    expect(item.description).toBe('kbengine-final.xml');
    expect(item.command).toMatchObject({ command: 'kbengine.config.showFinal' });
    expect(item.tooltip).toContain('只读视图');
  });
});

describe('summarizeFinalTelnet(合成配置的 telnet 速览)', () => {
  it('逐组件读端口/密码;缺段/缺值落 null', () => {
    const summary = summarizeFinalTelnet(
      [
        '<baseapp>',
        '  <telnet_service>',
        '    <port> 40001 </port>',
        '    <password> pwd123456 </password>',
        '  </telnet_service>',
        '</baseapp>',
        '<logger>',
        '  <telnet_service>',
        '    <port> 34000 </port>',
        '  </telnet_service>',
        '</logger>'
      ].join('\n')
    );
    const byComponent = Object.fromEntries(summary.map(entry => [entry.component, entry]));
    expect(byComponent.baseapp).toEqual({ component: 'baseapp', port: 40001, password: 'pwd123456' });
    expect(byComponent.logger).toEqual({ component: 'logger', port: 34000, password: null });
    expect(byComponent.loginapp).toEqual({ component: 'loginapp', port: null, password: null });
  });

  it('端口非数字:落 null', () => {
    const summary = summarizeFinalTelnet(
      '<dbmgr><telnet_service><port> abc </port></telnet_service></dbmgr>'
    );
    expect(summary.find(entry => entry.component === 'dbmgr')!.port).toBeNull();
  });
});

describe('buildFinalServerConfig 引擎源码根兜底(批125 自动发现)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    memoryFileSystem.reset();
    stubWorkspace.workspaceFolders = [];
  });

  it('binPath 未配时经 kbe 源码根锚点推出 defaults 路径并合成展示', () => {
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

      const result = buildFinalServerConfig();

      expect(result.defaultsPath)
        .toBe(path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml'));
      expect(result.defaultsOnly).toBe(true);
      expect(result.text).toContain('<debug> 7 </debug>');
    } finally {
      stubWorkspace.workspaceFolders = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binPath 未配且无引擎锚点时仍为空文本,不猜测路径', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-noanchor-'));
    try {
      stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } } as never];
      configurationOverrides.set('kbengine', { binPath: '' });

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

// 批131(用户令:MySQL 连接直接读 KBEngine 自身配置):dbmgr
// <databaseInterfaces><default> 的连接要素从合成树读出,端口 0 落引擎
// 默认 3306(db_interface_mysql.cpp:166-167)。
// 批C 起例外:encrypt=false(明文配置)时一并读出明文密码供漂移校验连库,
// 密文(encrypt=true)不解读,留 undefined 由上层降级为「未校验」。
describe('extractDatabaseInterfaceConfig(dbmgr 连接要素提取,批131)', () => {
  it('读 host/port/auth/unicodeString:自定义值原样,encrypt=false 落 false', () => {
    const tree = parseConfigXml([
      '<defaults>',
      '  <dbmgr>',
      '    <databaseInterfaces>',
      '      <default>',
      '        <host> 127.0.0.1 </host>',
      '        <port> 3307 </port>',
      '        <auth>',
      '          <username> game </username>',
      '          <password> secret </password>',
      '          <encrypt> false </encrypt>',
      '        </auth>',
      '        <databaseName> game_db </databaseName>',
      '        <unicodeString>',
      '          <characterSet> utf8 </characterSet>',
      '        </unicodeString>',
      '      </default>',
      '    </databaseInterfaces>',
      '  </dbmgr>',
      '</defaults>'
    ].join('\n'))!;

    expect(extractDatabaseInterfaceConfig(tree)).toEqual({
      host: '127.0.0.1',
      port: 3307,
      username: 'game',
      databaseName: 'game_db',
      encrypt: false,
      characterSet: 'utf8',
      // encrypt=false 即明文配置,密码一并读出(批C 漂移校验连库需要)
      plainPassword: 'secret'
    });
  });

  it('引擎 defaults 原始形态:port 0 → 3306,encrypt 非 false 即按加密处理', () => {
    const tree = parseConfigXml([
      '<root>',
      '  <dbmgr>',
      '    <databaseInterfaces>',
      '      <default>',
      '        <host> localhost </host>',
      '        <port> 0 </port>',
      '        <auth>',
      '          <username> kbe </username>',
      '          <password> pwd123456 </password>',
      '          <encrypt> true </encrypt>',
      '        </auth>',
      '        <databaseName> kbe </databaseName>',
      '        <unicodeString>',
      '          <characterSet> utf8mb4 </characterSet>',
      '        </unicodeString>',
      '      </default>',
      '    </databaseInterfaces>',
      '  </dbmgr>',
      '</root>'
    ].join('\n'))!;

    expect(extractDatabaseInterfaceConfig(tree)).toEqual({
      host: 'localhost',
      port: 3306,
      username: 'kbe',
      databaseName: 'kbe',
      encrypt: true,
      characterSet: 'utf8mb4'
    });
  });

  it('encrypt=false 但没写 password:明文密码缺席(漂移校验据此降级)', () => {
    const tree = parseConfigXml(
      '<root><dbmgr><databaseInterfaces><default><auth><encrypt>false</encrypt><username>game</username></auth></default></databaseInterfaces></dbmgr></root>'
    )!;

    expect(extractDatabaseInterfaceConfig(tree)).toMatchObject({
      encrypt: false,
      plainPassword: undefined
    });
    // toEqual 口径:字段存在但值 undefined(toMatchObject 不看 undefined 键)
    expect('plainPassword' in (extractDatabaseInterfaceConfig(tree) as object)).toBe(true);
  });

  it('叶子全缺:逐项落引擎默认值;端口非数字同落 3306', () => {
    const tree = parseConfigXml(
      '<root><dbmgr><databaseInterfaces><default><port> abc </port></default></databaseInterfaces></dbmgr></root>'
    )!;

    expect(extractDatabaseInterfaceConfig(tree)).toEqual({
      host: 'localhost',
      port: 3306,
      username: 'kbe',
      databaseName: 'kbe',
      encrypt: true,
      characterSet: 'utf8mb4'
    });
  });

  it('无 dbmgr / 无 databaseInterfaces / 无 default 段 → null', () => {
    expect(extractDatabaseInterfaceConfig(parseConfigXml('<root><cellapp/></root>')!)).toBeNull();
    expect(
      extractDatabaseInterfaceConfig(parseConfigXml('<root><dbmgr><debug> 1 </debug></dbmgr></root>')!)
    ).toBeNull();
    expect(
      extractDatabaseInterfaceConfig(
        parseConfigXml('<root><dbmgr><databaseInterfaces/></dbmgr></root>')!
      )
    ).toBeNull();
  });
});

describe('resolveDatabaseInterfaceConfig(合成口径读值与缓存,批131)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    memoryFileSystem.reset();
    stubWorkspace.workspaceFolders = [];
    resetDatabaseInterfaceConfigCache();
  });

  it('defaults + 元件 kbengine.xml 合成后读连接:自定义库名/端口覆盖默认', () => {
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
      resetDatabaseInterfaceConfigCache();
      expect(resolveDatabaseInterfaceConfig()!.databaseName).toBe('game2');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults 不可得 → null,不虚构连接', () => {
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
