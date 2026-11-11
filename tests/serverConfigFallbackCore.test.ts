// serverConfigFallbackCore 单测(AUDIT-007):解析/合并/提取器镜像 Rust
// config.rs 语义的纯函数面。对拍(Rust golden)见
// serverConfigFallbackParity.test.ts;此处钉语义边界:伪根/包裹二层、
// 注释归属、整表替换、leaf_number 口径(0x 拒/0 合法/非有限 null)、
// dbInterface 缺叶回落、telnet 速览表序、customTelnet 文档序首段。
import { describe, expect, it } from 'vitest';
import {
  ENGINE_DEFAULT_TELNET_PORTS,
  extractDatabaseInterfaceConfig,
  mergeConfigXml,
  parseConfigXml,
  resolveConfigProductsInTs
} from '../src/serverConfigFallbackCore';

const xml = (body: string): string => `<root>\n${body}\n</root>\n`;

describe('parseConfigXml(镜像 parse_config)', () => {
  it('伪根恒返回:顶层段作 children;纯注释输入 → null', () => {
    const tree = parseConfigXml('<baseapp><rate> 10 </rate></baseapp>');
    expect(tree!.name).toBe('');
    expect(tree!.children[0].name).toBe('baseapp');
    expect(tree!.children[0].children[0].text).toBe('10');
    expect(parseConfigXml('<!-- 只有注释 -->')).toBeNull();
  });

  it('注释归属:前导挂紧随元素、同行尾随挂前元素、文件尾游离挂所在容器', () => {
    const tree = parseConfigXml(
      ['<baseapp>', '<!-- 前导 -->', '<rate> 10 </rate> <!-- 尾随 -->', '</baseapp>', ''].join('\n')
    )!;
    const rate = tree.children[0].children[0];
    expect(rate.text).toBe('10');
    // 注释原文保留(合并去重时的 sanitize 只用于判等,不回写原文)
    expect(rate.sourceComments).toEqual([' 前导 ', ' 尾随 ']);
    const trailing = parseConfigXml('<baseapp><rate> 1 </rate></baseapp><!-- 游离 -->')!;
    expect(trailing.children[0].sourceComments).toEqual([' 游离 ']);
  });

  it('自闭合与声明容错', () => {
    const tree = parseConfigXml('<?xml version="1.0"?><dbmgr><port/></dbmgr>')!;
    expect(tree.children[0].children[0]).toMatchObject({ name: 'port', text: '', children: [] });
  });
});

describe('mergeConfigXml(镜像 merge_config_xml)', () => {
  it('覆盖叶取自定义、缺省保留、新名追加、整表替换', () => {
    const base = parseConfigXml(xml('<a><x> 1 </x><items><item> a </item></items></a>'))!;
    const over = parseConfigXml(xml('<a><x> 9 </x><items><item> 9 </item><item> b </item></items><y> 2 </y></a>'))!;
    const merged = mergeConfigXml(base, over);
    // 两侧同为 <root> 包裹:同名包裹段合并为一层,'a' 在包裹层内
    expect(merged.children.map(c => c.name)).toEqual(['root']);
    const a = merged.children[0].children.find(c => c.name === 'a')!;
    expect(a.children.map(c => c.name)).toEqual(['x', 'items', 'y']);
    expect(a.children[0].text).toBe('9');
    expect(a.children[1].children.map(c => c.text)).toEqual(['9', 'b']);
    expect(a.children[2].text).toBe('2');
  });

  it('同名单元素源注释 override 优先双侧保留', () => {
    const base = parseConfigXml('<a><x><!-- 基侧 --></x></a>')!;
    const over = parseConfigXml('<a><x><!-- 覆侧 --></x></a>')!;
    const merged = mergeConfigXml(base, over);
    // 注释归属在 x 叶上(容器 a 无注释)
    expect(merged.children[0].children[0].sourceComments).toEqual([' 覆侧 ', ' 基侧 ']);
    expect(merged.children[0].sourceComments).toBeUndefined();
  });
});

describe('dbInterface(镜像 db_interface_config)', () => {
  const dbmgr = (inner: string): string => xml(`<dbmgr><databaseInterfaces><default>${inner}</default></databaseInterfaces></dbmgr>`);

  it('缺叶回落引擎默认;端口 0/负/非法/0x → 3306', () => {
    expect(extractDatabaseInterfaceConfig(parseConfigXml(xml('<baseapp/>')))!).toBeNull();
    const empty = extractDatabaseInterfaceConfig(parseConfigXml(dbmgr('')))!;
    expect(empty).toEqual({
      host: 'localhost',
      port: 3306,
      username: 'kbe',
      databaseName: 'kbe',
      encrypt: true,
      characterSet: 'utf8mb4'
    });
    for (const portText of ['0', '-1', 'abc', '0x10']) {
      const got = extractDatabaseInterfaceConfig(
        parseConfigXml(dbmgr(`<port> ${portText} </port>`))
      )!;
      expect(got.port, `port ${portText}`).toBe(3306);
    }
  });

  it('全叶读取:auth 明文密码只在 encrypt=false;字符集在 unicodeString 下', () => {
    const got = extractDatabaseInterfaceConfig(
      parseConfigXml(
        dbmgr(
          '<host> 10.0.0.9 </host><port> 3307 </port><databaseName> game </databaseName>' +
            '<auth><username> kbe2 </username><encrypt> false </encrypt><password> pw </password></auth>' +
            '<unicodeString><characterSet> gb2312 </characterSet></unicodeString>'
        )
      )
    )!;
    expect(got).toMatchObject({
      host: '10.0.0.9',
      port: 3307,
      username: 'kbe2',
      databaseName: 'game',
      encrypt: false,
      characterSet: 'gb2312',
      plainPassword: 'pw'
    });
    // encrypt 字面大小写不敏感;缺省 true 且不带明文
    const upper = extractDatabaseInterfaceConfig(parseConfigXml(dbmgr('<auth><encrypt> False </encrypt></auth>')))!;
    expect(upper.encrypt).toBe(false);
    const missing = extractDatabaseInterfaceConfig(parseConfigXml(dbmgr('<auth><username> u </username></auth>')))!;
    expect(missing.encrypt).toBe(true);
    expect(missing.plainPassword).toBeUndefined();
  });
});

describe('telnetSummary/customTelnet(镜像 telnet_summary/custom_telnet)', () => {
  it('速览按引擎写死表序;缺段全 null;端口 0 合法保留', () => {
    const products = resolveConfigProductsInTs(
      xml(
        '<baseapp><telnet_service><port> 0 </port><password> pw </password></telnet_service></baseapp>' +
          '<loginapp><telnet_service><port> 31001 </port></telnet_service></loginapp>'
      ),
      null
    );
    expect(products.telnetSummary.map(e => e.component)).toEqual(
      ENGINE_DEFAULT_TELNET_PORTS.map(e => e.component)
    );
    const byName = new Map(products.telnetSummary.map(e => [e.component, e]));
    expect(byName.get('baseapp')).toEqual({ component: 'baseapp', port: 0, password: 'pw' });
    expect(byName.get('loginapp')!.port).toBe(31001);
    expect(byName.get('loginapp')!.password).toBeNull();
    expect(byName.get('dbmgr')).toEqual({ component: 'dbmgr', port: null, password: null });
    expect(products.telnetDefaultPorts).toEqual({
      loginapp: 31000,
      dbmgr: 32000,
      interfaces: 33000,
      logger: 34000,
      baseapp: 40000,
      cellapp: 50000,
      bots: 51000
    });
  });

  it('customTelnet 只看 custom 树文档序首段;custom 缺失 → null(速览仍出)', () => {
    const products = resolveConfigProductsInTs(
      xml('<baseapp><telnet_service><port> 40000 </port></telnet_service></baseapp>'),
      '<cellapp><telnet_service><port> 50001 </port><password> cp </password></telnet_service></cellapp>'
    );
    expect(products.customTelnet).toEqual({ port: 50001, password: 'cp' });
    const noCustom = resolveConfigProductsInTs(xml('<baseapp/>'), null);
    expect(noCustom.customTelnet).toBeNull();
    expect(noCustom.telnetSummary.length).toBeGreaterThan(0);
  });
});

describe('resolveConfigProductsInTs(镜像 resolve_config 组装)', () => {
  it('两侧都缺 → 全空;defaults 缺 custom 在 → merged null 但 customTelnet 仍出', () => {
    const none = resolveConfigProductsInTs(null, null);
    expect(none).toEqual({
      defaultsTree: null,
      customTree: null,
      merged: null,
      telnetSummary: [],
      telnetDefaultPorts: expect.any(Object),
      customTelnet: null,
      dbInterface: null
    });
    const customOnly = resolveConfigProductsInTs(
      null,
      '<cellapp><telnet_service><port> 50001 </port></telnet_service></cellapp>'
    );
    expect(customOnly.defaultsTree).toBeNull();
    expect(customOnly.merged).toBeNull();
    expect(customOnly.telnetSummary).toEqual([]);
    expect(customOnly.dbInterface).toBeNull();
    expect(customOnly.customTelnet).toEqual({ port: 50001, password: null });
  });

  it('同输入 memo 化:产物同一引用(软缓存重试零重解析)', () => {
    const a = resolveConfigProductsInTs(xml('<baseapp/>'), null);
    const b = resolveConfigProductsInTs(xml('<baseapp/>'), null);
    expect(b).toBe(a);
  });
});
