import { describe, expect, it } from 'vitest';
import {
  SERVER_CONFIG_FIELD_DOCS,
  SERVER_CONFIG_SELECTOR,
  ServerConfigHoverProvider,
  provideServerConfigHover
} from '../src/serverConfigHover';
import { makeTextDocument, Position } from './helpers/vscodeStub';

// 元件 kbengine.xml / 引擎 kbengine_defaults.xml 字段悬浮文档(批112 用户令):
// 行级标签 + 就近整行 opener 段定位,先查 `段.标签` 再查裸标签。文档内容
// 逐条对照引擎 defaults 注释整理,此处锁解析口径与代表性键,不逐键枚举。

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
});
