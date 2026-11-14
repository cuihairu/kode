import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SERVER_CONFIG_FIELD_DOCS,
  SERVER_CONFIG_FIELD_DOCS_EN,
  SERVER_CONFIG_SELECTOR,
  ServerConfigHoverProvider,
  configImpactForHover,
  provideServerConfigHover,
  serverConfigFieldDoc
} from '../src/serverConfigHover';
import { parseConfigXml } from '../src/serverConfigFallbackCore';
import { configurationOverrides, makeTextDocument, Position } from './helpers/vscodeStub';

// 元件 kbengine.xml / 引擎 kbengine_defaults.xml 字段悬浮文档(批112 用户令):
// 行级标签 + 就近整行 opener 段定位,先查 `段.标签` 再查裸标签。文档内容
// 逐条对照引擎 defaults 注释整理,此处锁解析口径与代表性键,不逐键枚举。
// IDE-I18N-002:文案语言随 kbengine.hover.language——既有断言锁中文包,
// 显式钉 zh-cn 与宿主时区/界面语言解耦(CI 为 UTC+0 英文环境,auto 会落英文)。

const hoverText = (doc: ReturnType<typeof makeTextDocument>, line: number, needle: string) => {
  const character = doc.lineAt(line).text.indexOf(needle);
  return provideServerConfigHover(doc as never, new Position(line, Math.max(character, 0)));
};

const hoverValue = (hover: { contents: unknown } | null): string | null => {
  if (!hover) {
    return null;
  }
  const contents = hover.contents as { value: string } | Array<{ value: string }>;
  return Array.isArray(contents)
    ? contents.map(item => item.value).join('')
    : contents.value;
};

describe('provideServerConfigHover', () => {
  // IDE-I18N-002:本组断言锁中文包原口径,钉 zh-cn 摆脱宿主环境
  beforeEach(() => {
    configurationOverrides.set('kbengine', { 'hover.language': 'zh-cn' });
  });
  afterEach(() => {
    configurationOverrides.delete('kbengine');
  });

  const doc = makeTextDocument(
    [
      '<root>',
      '  <baseapp>',
      '    <telnet_service>',
      '      <port> 40000 </port>',
      '    </telnet_service>',
      '    <entryScriptFile> baseapp.py </entryScriptFile>',
      '    <unknownField> 1 </unknownField>',
      '  </baseapp>',
      '  <unknownSectionField> 1 </unknownSectionField>',
      '</root>',
      '<strayLeaf> 1 </strayLeaf>'
    ].join('\n'),
    { fileName: '/proj/server/kbengine.xml', languageId: 'xml' }
  );

  it('选择器只挂 kbengine*.xml(不碰 types.xml/entities.xml)', () => {
    expect(SERVER_CONFIG_SELECTOR).toEqual({
      language: 'xml',
      pattern: '**/kbengine*.xml'
    });
  });

  it('歧义字段带段键命中:telnet_service 内的 port', () => {
    expect(hoverValue(hoverText(doc, 3, '<port'))).toBe(
      SERVER_CONFIG_FIELD_DOCS['telnet_service.port']
    );
  });

  it('组件段内无歧义字段落裸键;行 0(循环不进)查段 opener 自身', () => {
    // entryScriptFile 向上最近整行 opener 是 <telnet_service>:
    // telnet_service.entryScriptFile 未登记 → 落裸键
    expect(hoverValue(hoverText(doc, 5, '<entryScriptFile'))).toBe(
      SERVER_CONFIG_FIELD_DOCS.entryScriptFile
    );

    // 行 0 <root>:向上无行,section 为空,裸键 root 命中(段 opener 悬停)
    expect(hoverValue(hoverText(doc, 0, '<root'))).toBe(SERVER_CONFIG_FIELD_DOCS.root);
  });

  it('带段键未登记 → 裸键兜底(telnet_service opener 自身悬停)', () => {
    expect(hoverValue(hoverText(doc, 2, '<telnet_service'))).toBe(
      SERVER_CONFIG_FIELD_DOCS.telnet_service
    );
  });

  it('未登记字段返回 null(交回既有悬停体系)', () => {
    expect(hoverText(doc, 6, '<unknownField')).toBeNull();
    expect(hoverText(doc, 8, '<unknownSectionField')).toBeNull();
    expect(hoverText(doc, 10, '<strayLeaf')).toBeNull();
  });

  it('非标签行与纯注释行返回 null', () => {
    const commentDoc = makeTextDocument('<!-- baseapp 进程段 -->\n', {
      fileName: '/proj/kbengine.xml',
      languageId: 'xml'
    });
    expect(hoverText(commentDoc, 0, '<!--')).toBeNull();
  });

  it('向上无任何整行 opener(段上下文缺失)→ 裸键查询后落空', () => {
    const orphanDoc = makeTextDocument(
      ['garbage text line', '<strayTag> 1 </strayTag>'].join('\n'),
      { fileName: '/proj/kbengine.xml', languageId: 'xml' }
    );
    // 行 1 向上只有非 opener 文本行:循环走完无发现,section 空 → 双查皆空
    expect(hoverText(orphanDoc, 1, '<strayTag')).toBeNull();
  });

  it('Provider 类委托同一解析', () => {
    const provider = new ServerConfigHoverProvider();
    const hover = provider.provideHover(
      doc as never,
      new Position(5, doc.lineAt(5).text.indexOf('<entryScriptFile'))
    );
    expect(hoverValue(hover as { contents: unknown } | null)).toBe(
      SERVER_CONFIG_FIELD_DOCS.entryScriptFile
    );
  });

  it('hover.serverConfig 关闭时 Provider 不出悬停(批154)', () => {
    const provider = new ServerConfigHoverProvider();
    const at = (): ReturnType<typeof provider.provideHover> =>
      provider.provideHover(
        doc as never,
        new Position(5, doc.lineAt(5).text.indexOf('<entryScriptFile'))
      );

    // 正对照:默认开启时出悬停
    expect(hoverValue(at() as { contents: unknown } | null)).toBe(
      SERVER_CONFIG_FIELD_DOCS.entryScriptFile
    );

    configurationOverrides.set('kbengine', { 'hover.serverConfig': false });
    try {
      expect(at()).toBeNull();
    } finally {
      configurationOverrides.delete('kbengine');
    }
  });
});

describe('hover 文案语言面(IDE-I18N-002)', () => {
  afterEach(() => {
    configurationOverrides.delete('kbengine');
  });

  const doc = makeTextDocument(
    [
      '<root>',
      '  <baseapp>',
      '    <telnet_service>',
      '      <port> 40000 </port>',
      '    </telnet_service>',
      '    <entryScriptFile> baseapp.py </entryScriptFile>',
      '  </baseapp>',
      '</root>'
    ].join('\n'),
    { fileName: '/proj/server/kbengine.xml', languageId: 'xml' }
  );

  it('英文包与中文包同键同数、逐键互异、值非空(真翻译,非复制)', () => {
    const zhKeys = Object.keys(SERVER_CONFIG_FIELD_DOCS).sort();
    const enKeys = Object.keys(SERVER_CONFIG_FIELD_DOCS_EN).sort();
    expect(enKeys).toEqual(zhKeys);
    for (const key of zhKeys) {
      expect(SERVER_CONFIG_FIELD_DOCS[key].length).toBeGreaterThan(0);
      expect(SERVER_CONFIG_FIELD_DOCS_EN[key].length).toBeGreaterThan(0);
      // 同文=假翻译(与 manifestI18n 契约 ⑥ 同口径)
      expect(SERVER_CONFIG_FIELD_DOCS_EN[key]).not.toBe(SERVER_CONFIG_FIELD_DOCS[key]);
    }
  });

  it('显式 en → 英文包命中;显式 zh-cn → 中文包命中(与宿主环境解耦)', () => {
    const at = (line: number, needle: string) =>
      hoverValue(
        provideServerConfigHover(doc as never, new Position(line, doc.lineAt(line).text.indexOf(needle)))
      );
    configurationOverrides.set('kbengine', { 'hover.language': 'en' });
    expect(at(5, '<entryScriptFile')).toBe(SERVER_CONFIG_FIELD_DOCS_EN.entryScriptFile);
    expect(at(3, '<port')).toBe(SERVER_CONFIG_FIELD_DOCS_EN['telnet_service.port']);
    configurationOverrides.set('kbengine', { 'hover.language': 'zh-cn' });
    expect(at(5, '<entryScriptFile')).toBe(SERVER_CONFIG_FIELD_DOCS.entryScriptFile);
  });

  it('serverConfigFieldDoc:双查序(带段键→裸键)与缺键口径', () => {
    expect(serverConfigFieldDoc('telnet_service.port', 'port', 'zh-cn')).toBe(
      SERVER_CONFIG_FIELD_DOCS['telnet_service.port']
    );
    expect(serverConfigFieldDoc('telnet_service.port', 'port', 'en')).toBe(
      SERVER_CONFIG_FIELD_DOCS_EN['telnet_service.port']
    );
    // 两语言面皆未登记 → undefined → 悬停面交回既有体系(null)
    expect(serverConfigFieldDoc('unregistered.key', 'unknown', 'en')).toBeUndefined();
    expect(serverConfigFieldDoc('unregistered.key', 'unknown', 'zh-cn')).toBeUndefined();
  });
});

// KSEM-CFG-10 修改影响块(联动配置修改影响):受影响模块/默认回退/读取点,
// 只读示数零写入;修改未保存内容也刷新(被悬停文档=配置文件本身时,实文本
// 现解析顶替盘树——悬停面拿文档实文本算,不读盘)。pairOverride 注入盘树,
// 钉「未保存实文本 ≠ 盘树」的分离样本。
describe('KSEM-CFG-10 configImpactForHover(修改影响块/未保存也刷新)', () => {
  beforeEach(() => {
    configurationOverrides.set('kbengine', { 'hover.language': 'zh-cn' });
  });
  afterEach(() => {
    configurationOverrides.delete('kbengine');
  });

  const defaultsDocText = (port: string) =>
    [
      '<root>',
      '  <dbmgr>',
      '    <telnet_service>',
      `      <port>${port}</port>`,
      '      <password>pwd123456</password>',
      '    </telnet_service>',
      '  </dbmgr>',
      '</root>'
    ].join('\n');

  const hoverOn = (doc: ReturnType<typeof makeTextDocument>, line: number, needle: string) => {
    // 路径解析口径(CFG-06 同款):光标落在标签名内部才解析出该标签的完整
    // 路径;恰好 '<' 或首字符处落父路径/null,不悬停语义要锚的名字面
    const character = doc.lineAt(line).text.indexOf(needle) + 3;
    return configImpactForHover(
      doc as never,
      new Position(line, character),
      pairOverrideDefaults()
    );
  };

  /** 盘树:telnet 端口 32000(与实文本编辑值分离) */
  const pairOverrideDefaults = () => {
    const defaultsTree = parseConfigXml(defaultsDocText('32000'));
    const customTree = parseConfigXml('<root>\n  <baseapp>\n  </baseapp>\n</root>');
    return {
      customTree,
      defaultsTree,
      customPath: '/proj/kbengine.xml',
      defaultsPath: '/proj/kbengine_defaults.xml'
    };
  };

  it('未保存 defaults 实文本生效:悬停文档就是 defaults 文件时,回退值取实文本(非盘树)', () => {
    // 实文本 31999 ≠ 盘树 32000:块出 31999 证明未保存内容也刷新
    const doc = makeTextDocument(defaultsDocText('31999'), {
      fileName: '/proj/kbengine_defaults.xml',
      languageId: 'xml'
    });
    const block = hoverOn(doc, 3, '<port');
    expect(block).not.toBeNull();
    expect(block).toContain('`31999`');
    expect(block).not.toContain('`32000`');
    expect(block).toContain('受影响模块:`dbmgr`');
  });

  it('未保存 custom 实文本生效:仅元件键只存在于实文本(盘树无此路径仍能出块)', () => {
    // 盘 custom 树无 customThing,defaults 亦无;实文本有 → 出块靠实文本顶替
    const doc = makeTextDocument(
      [
        '<root>',
        '  <baseapp>',
        '    <customThing>7</customThing>',
        '  </baseapp>',
        '</root>'
      ].join('\n'),
      { fileName: '/proj/kbengine.xml', languageId: 'xml' }
    );
    const block = hoverOn(doc, 2, '<customThing');
    expect(block).not.toBeNull();
    expect(block).toContain('无引擎默认');
  });

  it('非配置文件本身:用 pair 盘树(实文本值不顶替)', () => {
    // 文档 uri ≠ pair 两路径:块取盘树 32000,实文本 12345 不顶替
    const doc = makeTextDocument(defaultsDocText('12345'), {
      fileName: '/other/kbengine.xml',
      languageId: 'xml'
    });
    const block = hoverOn(doc, 3, '<port');
    expect(block).not.toBeNull();
    expect(block).toContain('`32000`');
    expect(block).not.toContain('`12345`');
  });

  it('敏感回退值只出脱敏形态', () => {
    const doc = makeTextDocument(defaultsDocText('32000'), {
      fileName: '/proj/kbengine_defaults.xml',
      languageId: 'xml'
    });
    const block = hoverOn(doc, 4, '<password');
    expect(block).not.toBeNull();
    expect(block).not.toContain('pwd123456');
    expect(block).toContain('p***');
  });

  it('provideServerConfigHover 追加影响块(静态文案+证据块+影响块三段合一)', () => {
    // 树可得性由 pairOverride 之外面承担:纯替身环境盘树为 null → 静默零追加,
    // 既有断言(悬停值=纯文案)已锁此口径;此处锁追加次序面的可组合性
    const doc = makeTextDocument(defaultsDocText('32000'), {
      fileName: '/proj/kbengine.xml',
      languageId: 'xml'
    });
    const standalone = configImpactForHover(
      doc as never,
      new Position(3, doc.lineAt(3).text.indexOf('<port') + 3),
      pairOverrideDefaults()
    );
    expect(standalone).not.toBeNull();
    expect(standalone).toContain('---');
    expect(standalone).toContain('修改影响');
  });
});
