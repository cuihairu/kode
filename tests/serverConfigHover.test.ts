import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SERVER_CONFIG_FIELD_DOCS,
  SERVER_CONFIG_FIELD_DOCS_EN,
  SERVER_CONFIG_SELECTOR,
  ServerConfigHoverProvider,
  provideServerConfigHover,
  serverConfigFieldDoc
} from '../src/serverConfigHover';
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
