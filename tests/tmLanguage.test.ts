import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { INITIAL, Registry } from 'vscode-textmate';
import type { IGrammar, IRawGrammar, IToken } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { KBENGINE_FLAGS } from '../src/kbengineMetadata';

// 语法高亮资产(syntaxes/kbengine.tmLanguage.json)批110 重铸后形态:
// .def 是 XML 方言,基准分词整体委托内建 text.xml,仅前置少量语义规则
// (用户令:四段分色/Exposed/Persistent/Flags 常量)。验证三层面:
// 一、资产自洽:package.json 贡献与文件、语言配置(注释对/colorizedBracketPairs)、
//     委托 include 在位、全部正则可编译;
// 二、源码对齐:语义规则中的 Flags 名单与 kbengineMetadata 注册表集合相等
//     (注册表本身由 kbengineMetadata.test.ts 在引擎在位时对引擎源码锁定,
//     传递得到语法与引擎对齐);
// 三、功能验证:vscode-textmate + oniguruma 真实分词(text.xml 宿主取自
//     @shikijs/langs/xml 的 text.xml 条目),按构造断言 scope,含注释区与
//     文本值的零泄漏负向锁和 ruleStack 跨行连续性。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const grammarPath = path.join(root, 'syntaxes', 'kbengine.tmLanguage.json');

interface RawGrammarShape {
  scopeName: string;
  patterns: Array<Record<string, unknown>>;
}

const grammarJson = JSON.parse(fs.readFileSync(grammarPath, 'utf8')) as RawGrammarShape;
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
) as {
  contributes: {
    grammars: Array<{ language?: string; scopeName: string; path: string; injectTo?: string[] }>;
    languages: Array<{ id: string; configuration?: string }>;
  };
};

type Rule = { match?: string; include?: string; captures?: Record<string, unknown> };

const semanticRules = grammarJson.patterns.filter(rule => typeof rule.match === 'string') as Rule[];
const includeRules = grammarJson.patterns.filter(rule => typeof rule.include === 'string') as Rule[];

const flagAlternationOf = (): string[] => {
  const flagRule = semanticRules.find(rule => {
    const captures = rule.captures ?? {};
    const names = Object.values(captures)
      .map(entry => (entry as { name?: string }).name ?? '')
      .filter(Boolean);
    const bare = typeof rule.name === 'string' ? [rule.name] : [];
    return [...names, ...bare].some(name => name.includes('constant.language.flag.kbengine'));
  });
  const source = flagRule?.match ?? '';
  const found = source.match(/\(([A-Z_0-9|]+)\)/);
  return found ? found[1].split('|') : [];
};

describe('kbengine.tmLanguage 资产自洽', () => {
  it('package.json 贡献与语法文件一一对应且配置文件存在', () => {
    expect(pkg.contributes.grammars).toHaveLength(1);
    const entry = pkg.contributes.grammars[0];
    expect(entry.language).toBe('kbengine-def');
    expect(entry.scopeName).toBe(grammarJson.scopeName);
    expect(entry.scopeName).toBe('source.kbengine-def');
    expect(entry.injectTo).toBeUndefined();

    const declared = path.join(root, entry.path.replace(/^\.\//, ''));
    expect(declared).toBe(grammarPath);
    expect(fs.existsSync(declared)).toBe(true);

    const language = pkg.contributes.languages.find(item => item.id === 'kbengine-def');
    expect(language?.configuration).toBe('./language-configuration.json');
    expect(fs.existsSync(path.join(root, language?.configuration ?? ''))).toBe(true);
    expect(() =>
      JSON.parse(fs.readFileSync(path.join(root, language?.configuration ?? ''), 'utf8'))
    ).not.toThrow();
  });

  it('分词委托内建 text.xml,语义规则全部前置在 include 之前', () => {
    expect(includeRules).toHaveLength(1);
    expect(includeRules[0].include).toBe('text.xml');
    expect(grammarJson.patterns[grammarJson.patterns.length - 1]).toEqual(includeRules[0]);
    // 语义层只做用户点名的要素,四段/Exposed/Persistent 全部在位
    const semanticScopes = semanticRules.flatMap(rule => [
      ...Object.values(rule.captures ?? {}).map(
        entry => (entry as { name?: string }).name ?? ''
      ),
      ...(typeof rule.name === 'string' ? [rule.name] : [])
    ]);
    for (const fragment of [
      'entity.name.tag.section.properties.kbengine',
      'entity.name.tag.section.base-methods.kbengine',
      'entity.name.tag.section.cell-methods.kbengine',
      'entity.name.tag.section.client-methods.kbengine',
      'entity.name.tag.exposed.kbengine',
      'entity.name.tag.persistent.kbengine',
      'constant.language.exposed.kbengine',
      'constant.language.persistent.kbengine',
      'constant.language.flag.kbengine'
    ]) {
      expect(semanticScopes.some(name => name === fragment), `语义 scope 缺失: ${fragment}`).toBe(
        true
      );
    }
  });

  it('语义规则标点组显式还回 punctuation.definition.tag(不破坏宿主观感)', () => {
    for (const rule of semanticRules) {
      if (!rule.captures) {
        continue;
      }
      const names = Object.values(rule.captures).map(
        entry => (entry as { name?: string }).name ?? ''
      );
      if (names.some(name => name.startsWith('entity.name.tag.'))) {
        expect(names.some(name => name.startsWith('punctuation.definition.tag.')), rule.match).toBe(
          true
        );
      }
    }
  });

  it('全部 match 正则可编译', () => {
    const sources = semanticRules.map(rule => rule.match as string);
    expect(sources.length).toBeGreaterThanOrEqual(9);
    for (const source of sources) {
      expect(() => new RegExp(source), source).not.toThrow();
    }
  });

  it('语言配置:XML 块注释/尖括号配色对齐,不再有 C 风格行注释', () => {
    const configuration = JSON.parse(
      fs.readFileSync(path.join(root, 'language-configuration.json'), 'utf8')
    ) as {
      comments?: { lineComment?: string; blockComment?: string[] };
      colorizedBracketPairs?: Array<[string, string]>;
    };
    expect(configuration.comments?.lineComment).toBeUndefined();
    expect(configuration.comments?.blockComment).toEqual(['<!--', '-->']);
    expect(configuration.colorizedBracketPairs).toEqual(
      expect.arrayContaining([
        ['<', '>'],
        ['{', '}'],
        ['[', ']'],
        ['(', ')']
      ])
    );
  });
});

describe('kbengine.tmLanguage 源码对齐(语义清单 ≡ kbengineMetadata 注册表)', () => {
  // 注册表由 kbengineMetadata.test.ts 在引擎在位时对引擎源码逐名锁定
  // (flags 语义),此处传递对齐。类型/DetailLevel 批110 起不再私造语法
  // (委托 text.xml 后为普通文本),无清单可对。
  it('Flags 名单与 KBENGINE_FLAGS 集合相等(无幻影、无遗漏)', () => {
    const flagNames = flagAlternationOf();
    expect(new Set(flagNames)).toEqual(new Set(KBENGINE_FLAGS.map(item => item.name)));
    expect(flagNames).not.toContain('INSTALL_ALWAYS');
    expect(flagNames).not.toContain('FLAG_DESTROY');
  });
});

describe('kbengine.tmLanguage 功能验证(vscode-textmate + oniguruma 真实分词)', () => {
  let grammar: IGrammar;

  beforeAll(async () => {
    const wasm = fs.readFileSync(
      path.join(root, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')
    );
    await loadWASM(
      wasm.buffer.slice(
        wasm.byteOffset,
        wasm.byteOffset + wasm.byteLength
      ) as ArrayBuffer
    );

    // 宿主 text.xml 取自 @shikijs/langs/xml(default 为 [java, xml] 数组)
    let textXml: IRawGrammar | null = null;
    try {
      const xmlModule = (await import('@shikijs/langs/xml')) as { default: unknown };
      const xmlRaw = xmlModule.default;
      const xmlGrammars = (Array.isArray(xmlRaw) ? xmlRaw : [xmlRaw]) as Array<{
        scopeName: string;
      }>;
      textXml =
        (xmlGrammars.find(item => item.scopeName === 'text.xml') as IRawGrammar | undefined) ??
        null;
    } catch {
      textXml = null;
    }

    const registry = new Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (sources: string[]) => createOnigScanner(sources),
        createOnigString: (source: string) => createOnigString(source)
      }),
      loadGrammar: async scopeName => {
        if (scopeName === grammarJson.scopeName) {
          return grammarJson as unknown as IRawGrammar;
        }
        if (scopeName === 'text.xml') {
          return textXml;
        }
        return null;
      }
    });

    const loaded = await registry.loadGrammar(grammarJson.scopeName);
    if (!loaded) {
      throw new Error(`语法加载失败: ${grammarJson.scopeName}`);
    }
    grammar = loaded;
  });

  interface LineToken {
    text: string;
    scopes: string[];
  }

  const tokenizeDoc = (lines: string[]): LineToken[][] => {
    let stack = INITIAL;
    return lines.map(line => {
      const result = grammar.tokenizeLine(line, stack);
      stack = result.ruleStack;
      return result.tokens.map((token: IToken) => ({
        text: line.slice(token.startIndex, token.endIndex),
        scopes: token.scopes
      }));
    });
  };

  const findTokens = (doc: LineToken[][], fragment: string): LineToken[] =>
    doc.flat().filter(token => token.text.includes(fragment));

  const expectScopeOn = (doc: LineToken[][], fragment: string, scopeFragment: string): void => {
    const hits = findTokens(doc, fragment);
    expect(hits.length, `token ${fragment} 应存在`).toBeGreaterThan(0);
    for (const token of hits) {
      expect(
        token.scopes.some(scope => scope.includes(scopeFragment)),
        `${fragment} 应带 ${scopeFragment},实际 ${JSON.stringify(token.scopes)}`
      ).toBe(true);
    }
  };

  const expectNoScopeOn = (doc: LineToken[][], fragment: string, scopeFragment: string): void => {
    for (const token of findTokens(doc, fragment)) {
      expect(
        token.scopes.some(scope => scope.includes(scopeFragment)),
        `${fragment} 不应带 ${scopeFragment},实际 ${JSON.stringify(token.scopes)}`
      ).toBe(false);
    }
  };

  it('分词器加载且全样本 .def 走查无异常', () => {
    const doc = tokenizeDoc([
      '<root>',
      '  <Parent>Monster</Parent>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT8</Type>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ]);
    expect(doc).toHaveLength(8);
    expect(doc.flat().length).toBeGreaterThan(8);
  });

  it('四段标签(开/闭)取得各自语义 scope', () => {
    const doc = tokenizeDoc([
      '<Properties></Properties>',
      '<BaseMethods></BaseMethods>',
      '<CellMethods></CellMethods>',
      '<ClientMethods></ClientMethods>'
    ]);
    expectScopeOn(doc, 'Properties', 'entity.name.tag.section.properties.kbengine');
    expectScopeOn(doc, 'BaseMethods', 'entity.name.tag.section.base-methods.kbengine');
    expectScopeOn(doc, 'CellMethods', 'entity.name.tag.section.cell-methods.kbengine');
    expectScopeOn(doc, 'ClientMethods', 'entity.name.tag.section.client-methods.kbengine');
    // 语义规则标点组还回宿主标点 scope
    expectScopeOn(doc, '<', 'punctuation.definition.tag.');
    expectScopeOn(doc, '>', 'punctuation.definition.tag.');
  });

  it('普通标签仍走宿主 XML scope(委托证明)', () => {
    const doc = tokenizeDoc(['<hp></hp>', '<Type>UINT8</Type>']);
    expectScopeOn(doc, 'hp', 'entity.name.tag.localname.xml');
    expectScopeOn(doc, 'Type', 'entity.name.tag.localname.xml');
    // 委托后类型名是普通文本,不再有 kbengine 类型 scope(批110 起私造
    // 类型规则废除,与引擎的对齐由 types.xml 诊断/补全承担)。负向按语义
    // scope 形态精确匹配('.kbengine' 结尾或 '.kbengine.' 链中段),根
    // scope 'source.kbengine-def' 天然含 kbengine 字样故不能粗匹配。
    const leaked = findTokens(doc, 'UINT8').flatMap(token => token.scopes).filter(
      scope => scope.endsWith('.kbengine') || scope.includes('.kbengine.')
    );
    expect(leaked).toEqual([]);
  });

  it('Exposed 标签与 true 值取得语义 scope(客户端可请求)', () => {
    const doc = tokenizeDoc(['<Exposed>true</Exposed>']);
    expectScopeOn(doc, 'Exposed', 'entity.name.tag.exposed.kbengine');
    expectScopeOn(doc, 'true', 'constant.language.exposed.kbengine');
  });

  it('Persistent 标签与 true 值取得语义 scope(自动存储)', () => {
    const doc = tokenizeDoc(['<Persistent>true</Persistent>']);
    expectScopeOn(doc, 'Persistent', 'entity.name.tag.persistent.kbengine');
    expectScopeOn(doc, 'true', 'constant.language.persistent.kbengine');
  });

  it('Flags 值得到引擎常量 scope', () => {
    const doc = tokenizeDoc(['<Flags>CELL_PUBLIC_AND_OWN</Flags>']);
    expectScopeOn(doc, 'CELL_PUBLIC_AND_OWN', 'constant.language.flag.kbengine');
  });

  it('引擎未注册的旗标不再得到常量 scope(负向锁)', () => {
    const doc = tokenizeDoc(['<Flags>INSTALL_ALWAYS</Flags>', '<Flags>FLAG_DESTROY</Flags>']);
    expectNoScopeOn(doc, 'INSTALL_ALWAYS', 'constant.language.flag.kbengine');
    expectNoScopeOn(doc, 'FLAG_DESTROY', 'constant.language.flag.kbengine');
  });

  it('注释区与文本值零 kbengine scope 泄漏(负向锁)', () => {
    const doc = tokenizeDoc([
      '<!-- Properties BASE_AND_CLIENT 注释说明 -->',
      '<Default>Properties</Default>'
    ]);
    expectScopeOn(doc, '注释说明', 'comment.block.xml');
    for (const fragment of ['Properties', 'BASE_AND_CLIENT']) {
      const leaked = findTokens(doc, fragment).flatMap(token => token.scopes).filter(
        scope => scope.endsWith('.kbengine') || scope.includes('.kbengine.')
      );
      expect(leaked, fragment).toEqual([]);
    }
  });

  it('注释、doctype 与 XML 属性仍由宿主 text.xml 提供 scope', () => {
    const doc = tokenizeDoc([
      '<!DOCTYPE root>',
      '<!-- 陷阱提示',
      '   跨行说明 -->',
      '<hp alias="x">1</hp>'
    ]);
    expectScopeOn(doc, 'DOCTYPE', 'keyword.other.doctype.xml');
    expectScopeOn(doc, '<!--', 'punctuation.definition.comment.xml');
    expectScopeOn(doc, '陷阱提示', 'comment.block.xml');
    expectScopeOn(doc, '跨行说明', 'comment.block.xml');
    expectScopeOn(doc, '-->', 'punctuation.definition.comment.xml');
    expectScopeOn(doc, 'alias', 'entity.other.attribute-name.');
    expectScopeOn(doc, 'x', 'string.quoted.');
  });

  it('跨行块级状态沿 ruleStack 连续(注释跨行闭合)', () => {
    const doc = tokenizeDoc([
      '<Properties>',
      '  <!-- 跨行注释开始',
      '     第二行 -->',
      '  <hp/>',
      '</Properties>'
    ]);
    expectScopeOn(doc, '跨行注释开始', 'comment.block.xml');
    expectScopeOn(doc, '第二行', 'comment.block.xml');
    // 注释闭合后宿主标签分词恢复正常
    expectScopeOn(doc, 'hp', 'entity.name.tag.localname.xml');
    const closing = doc[4].find(token => token.text === '>');
    expect(
      closing?.scopes.some(scope => scope.includes('punctuation.definition.tag.')),
      `闭合行 '>' 应带标点 scope,实际 ${JSON.stringify(closing?.scopes)}`
    ).toBe(true);
  });
});
