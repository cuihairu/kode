import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { INITIAL, Registry } from 'vscode-textmate';
import type { IGrammar, IRawGrammar, IToken } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { DETAIL_LEVELS, KBENGINE_FLAGS, KBENGINE_TYPES } from '../src/kbengineMetadata';

// 语法高亮资产(syntaxes/kbengine.tmLanguage.json)是 17 项已完成功能中此前
// 唯一零自动化覆盖的一项(批88 逐项功能验证收口)。验证三层面:
// 一、资产自洽:package.json 贡献与文件、include 引用完整性、全部正则可编译;
// 二、源码对齐:类型/Flags/DetailLevel 清单与 kbengineMetadata 注册表集合
// 相等(注册表本身由 kbengineMetadata.test.ts 在引擎在位时对
// datatypes.cpp/datatype.cpp 锁定,传递得到语法与引擎对齐);
// 三、功能验证:vscode-textmate + oniguruma 真实分词,按构造断言 scope,
// 含跨行 ruleStack 连续性与"引擎未注册名单不得高亮"的负向锁。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const grammarPath = path.join(root, 'syntaxes', 'kbengine.tmLanguage.json');

interface RawGrammarShape {
  scopeName: string;
  patterns: Array<Record<string, unknown>>;
  repository: Record<string, unknown>;
}

const grammarJson = JSON.parse(fs.readFileSync(grammarPath, 'utf8')) as RawGrammarShape;
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
) as {
  contributes: {
    grammars: Array<{ language: string; scopeName: string; path: string }>;
    languages: Array<{ id: string; configuration?: string }>;
  };
};

type Rule = { match?: string; begin?: string; end?: string; include?: string; patterns?: unknown };

const walkRules = (node: unknown, visit: (rule: Rule) => void): void => {
  if (Array.isArray(node)) {
    node.forEach(entry => walkRules(entry, visit));
    return;
  }
  if (node && typeof node === 'object') {
    visit(node as Rule);
    Object.values(node).forEach(value => walkRules(value, visit));
  }
};

const alternationOf = (rule: Rule | undefined, key: 'match' | 'begin'): string[] => {
  const source = rule?.[key];
  if (typeof source !== 'string') {
    return [];
  }
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

  it('所有 #include 引用均指向已定义的 repository 条目', () => {
    const includes: string[] = [];
    walkRules(grammarJson.patterns, rule => {
      if (typeof rule.include === 'string' && rule.include.startsWith('#')) {
        includes.push(rule.include.slice(1));
      }
    });
    walkRules(grammarJson.repository, rule => {
      if (typeof rule.include === 'string' && rule.include.startsWith('#')) {
        includes.push(rule.include.slice(1));
      }
    });

    expect(includes.length).toBeGreaterThanOrEqual(22);
    const defined = new Set(Object.keys(grammarJson.repository));
    for (const name of includes) {
      expect(defined.has(name), `未定义的 include: #${name}`).toBe(true);
    }
  });

  it('全部 match/begin/end 正则可编译(批88 对齐后 49 处)', () => {
    const sources: string[] = [];
    walkRules([grammarJson.patterns, grammarJson.repository], rule => {
      for (const key of ['match', 'begin', 'end'] as const) {
        if (typeof rule[key] === 'string') {
          sources.push(rule[key] as string);
        }
      }
    });

    expect(sources.length).toBeGreaterThanOrEqual(49);
    for (const source of sources) {
      expect(() => new RegExp(source), source).not.toThrow();
    }
  });
});

describe('kbengine.tmLanguage 源码对齐(清单 ≡ kbengineMetadata 注册表)', () => {
  // 注册表由 kbengineMetadata.test.ts 在引擎在位时对引擎源码逐名锁定
  // (datatypes.cpp addDataType + ARRAY/FIXED_DICT 特判),此处传递对齐。
  const typeNames = (grammarJson.repository['kbengine-types'] as { patterns: Rule[] })
    .patterns.flatMap(pattern => alternationOf(pattern, 'match'));
  const flagNames = (grammarJson.repository['kbengine-flags'] as { patterns: Rule[] })
    .patterns.flatMap(pattern => alternationOf(pattern, 'match'));
  const detailNames = alternationOf(
    grammarJson.repository['kbengine-detail-level'] as Rule,
    'match'
  );

  it('类型清单与 KBENGINE_TYPES 集合相等(无幻影、无遗漏)', () => {
    expect(new Set(typeNames)).toEqual(new Set(KBENGINE_TYPES.map(item => item.name)));
    expect(typeNames).toContain('UNICODE');
    for (const phantom of ['BOOL', 'BOOLEAN', 'FIXED_ARRAY', 'TUPLE', 'MAP']) {
      expect(typeNames, `${phantom} 引擎未注册,不得出现在高亮清单`).not.toContain(phantom);
    }
  });

  it('Flags 清单与 KBENGINE_FLAGS 集合相等且无引擎外旗标', () => {
    expect(new Set(flagNames)).toEqual(new Set(KBENGINE_FLAGS.map(item => item.name)));
    expect(flagNames).not.toContain('INSTALL_ALWAYS');
    expect(flagNames).not.toContain('FLAG_DESTROY');
  });

  it('DetailLevel 清单与 DETAIL_LEVELS 相等', () => {
    expect(detailNames).toEqual(DETAIL_LEVELS);
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

    const registry = new Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (sources: string[]) => createOnigScanner(sources),
        createOnigString: (source: string) => createOnigString(source)
      }),
      loadGrammar: async scopeName =>
        scopeName === grammarJson.scopeName ? (grammarJson as unknown as IRawGrammar) : null
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

  it('section 标签与结构标签得到 kbengine 块级 scope', () => {
    const doc = tokenizeDoc(['<root>', '</root>', '<Properties>', '</Properties>']);
    expectScopeOn(doc, 'root', 'meta.block.section.kbengine');
    expectScopeOn(doc, 'Properties', 'meta.block.section.kbengine');
    expectScopeOn(doc, '<', 'punctuation.definition.tag.begin.xml');
    // '</' 在本语法按 XML 惯例归 begin(闭合标签的起始), '>' 才是 end
    expectScopeOn(doc, '</', 'punctuation.definition.tag.begin.xml');
    expectScopeOn(doc, '>', 'punctuation.definition.tag.end.xml');
  });

  it('基础类型逐组得到对应类型 scope(源码对齐名单内)', () => {
    const doc = tokenizeDoc([
      '<Type>UINT8</Type>',
      '<Type>INT64</Type>',
      '<Type>FLOAT</Type>',
      '<Type>DOUBLE</Type>',
      '<Type>STRING</Type>',
      '<Type>VECTOR3</Type>',
      '<Type>ENTITYCALL</Type>',
      '<Type>PY_DICT</Type>'
    ]);
    expectScopeOn(doc, 'UINT8', 'support.type.primitive.integer.kbengine');
    expectScopeOn(doc, 'INT64', 'support.type.primitive.integer.kbengine');
    expectScopeOn(doc, 'FLOAT', 'support.type.primitive.float.kbengine');
    expectScopeOn(doc, 'DOUBLE', 'support.type.primitive.float.kbengine');
    expectScopeOn(doc, 'STRING', 'support.type.primitive.string.kbengine');
    expectScopeOn(doc, 'VECTOR3', 'support.type.vector.kbengine');
    expectScopeOn(doc, 'ENTITYCALL', 'support.type.reference.kbengine');
    expectScopeOn(doc, 'PY_DICT', 'support.type.python.kbengine');
  });

  it('UNICODE 获得类型 scope(批88 修复回归锁:修复前整体缺失)', () => {
    const doc = tokenizeDoc(['<Type>UNICODE</Type>']);
    expectScopeOn(doc, 'UNICODE', 'support.type.primitive.string.kbengine');
  });

  it('容器类型 ARRAY/FIXED_DICT 得到容器 scope', () => {
    const values = tokenizeDoc(['<Type>ARRAY</Type>', '<slot>', '  <Type>FIXED_DICT</Type>', '</slot>']);
    expectScopeOn(values, 'ARRAY', 'support.type.container.kbengine');
    expectScopeOn(values, 'FIXED_DICT', 'support.type.container.kbengine');

    // 容器标签位(<FIXED_DICT>)由 container-tag 规则给专用 tag scope
    const tags = tokenizeDoc(['<FIXED_DICT>', '</FIXED_DICT>']);
    expectScopeOn(tags, 'FIXED_DICT', 'support.type.container.tag.kbengine');
  });

  it('引擎未注册的类型名不再得到 kbengine 类型 scope(负向锁)', () => {
    const doc = tokenizeDoc([
      '<Type>BOOL</Type>',
      '<Type>BOOLEAN</Type>',
      '<Type>TUPLE</Type>',
      '<Type>MAP</Type>',
      '<Type>FIXED_ARRAY</Type>'
    ]);
    for (const phantom of ['BOOL', 'BOOLEAN', 'TUPLE', 'MAP', 'FIXED_ARRAY']) {
      expectNoScopeOn(doc, phantom, 'support.type.');
    }
  });

  it('引擎未注册的旗标不再得到 kbengine 旗标 scope(负向锁)', () => {
    const doc = tokenizeDoc(['<Flags>INSTALL_ALWAYS</Flags>', '<Flags>FLAG_DESTROY</Flags>']);
    expectNoScopeOn(doc, 'INSTALL_ALWAYS', 'constant.');
    expectNoScopeOn(doc, 'FLAG_DESTROY', 'constant.');
  });

  it('Flags 值与 DetailLevel 值得到专用 scope', () => {
    const doc = tokenizeDoc([
      '<Flags>CELL_PUBLIC</Flags>',
      '<DetailLevel>FAR</DetailLevel>'
    ]);
    expectScopeOn(doc, 'CELL_PUBLIC', 'constant.language.flag.kbengine');
    expectScopeOn(doc, 'Flags', 'meta.block.flags-value.kbengine');
    expectScopeOn(doc, 'FAR', 'support.constant.detail-level.kbengine');
  });

  it('数值、注释、doctype 与 XML 属性得到对应 scope', () => {
    const doc = tokenizeDoc([
      '<!DOCTYPE root>',
      '<Default>100</Default>',
      '<!-- 陷阱提示',
      '   跨行说明 -->',
      '<hp alias="x">1</hp>'
    ]);
    expectScopeOn(doc, 'DOCTYPE', 'keyword.other.doctype.xml');
    expectScopeOn(doc, '100', 'constant.numeric.kbengine');
    expectScopeOn(doc, '<!--', 'punctuation.definition.comment.xml');
    expectScopeOn(doc, '陷阱提示', 'comment.block.xml');
    expectScopeOn(doc, '跨行说明', 'comment.block.xml');
    expectScopeOn(doc, '-->', 'punctuation.definition.comment.xml');
    expectScopeOn(doc, 'alias', 'entity.other.attribute-name.xml');
  });

  it('跨行块级状态沿 ruleStack 连续(标签跨行闭合)', () => {
    const doc = tokenizeDoc([
      '<Properties>',
      '  <hp>',
      '    <Type>UINT8</Type>',
      '  </hp>',
      '</Properties>'
    ]);
    // 第 2 行起处于 section 块内;闭合行 '</Properties>' 仍能命中块 end 规则
    expectScopeOn(doc, 'Properties', 'meta.block.section.kbengine');
    const closing = doc[4].find(token => token.text === '>');
    expect(
      closing?.scopes.some(scope => scope.includes('punctuation.definition.tag.end.xml')),
      `闭合行 '>' 应带 end scope,实际 ${JSON.stringify(closing?.scopes)}`
    ).toBe(true);
    // 嵌套块内的类型 token 正常着色,证明状态机跨 4 行未丢
    expectScopeOn(doc, 'UINT8', 'support.type.primitive.integer.kbengine');
  });
});
