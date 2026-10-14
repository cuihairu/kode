import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Registry } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';

// types.xml 注入语法功能验收(批130,来源:用户 2026-10-14 着色增强需求):
// types.xml 默认由 XML 插件接管着色,kode 不得抢宿主分词——用注入语法
// (injection grammar)在其上叠加 KBEngine 语义 scope:
//   ① 内置类型(UINT32 等)有别于普通 XML 文本
//   ② 用户自定义类型也着色,且与内置类型可区分
//   ③ ARRAY / FIXED_DICT 指令有显著区别于其它 token 的专属色
// 机制与 VS Code 自带注入语法同款(markdown-math/jsdoc 先例):
//   package.json 贡献点给 injectTo:["text.xml"](VS Code 据此建
//   scopeName→注入者映射),语法文件自带 injectionSelector 选择器
//   (vscode-textmate _collectInjections 按它收集注入规则)。
//   选择器带 "- (comment, string)" 排除:语义色不漏进注释与属性值。
// 本文件在真实 vscode-textmate Registry(宿主 text.xml + 注入语法 +
// KBEngine Dark 主题共装)下断言:
//   一、五类 token 各自取得预期语义 scope(注入真实生效,规则命中);
//   二、注释与属性值内零 kbengine scope 泄漏(排除选择器生效);
//   三、四类(内置/自定义/ARRAY/FIXED_DICT)前景色两两可区分,
//       且与普通 XML 文本可区分——用户验收口径;
//   四、四类落在不同 scope 家族(support.type / entity.name.type /
//       keyword.other×2)——这是"换主题仍可区分"的机制保证:语义
//       scope 不硬编码色值,主题换色不换语义归属。
// 宿主 text.xml 取自 @shikijs/langs(与 microsoft/vscode 内建语法同源;
// default 是 [java, text.xml] 数组,按 scopeName 取)。包不可解析时整组
// 跳过(测试不引入网络依赖)。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FOREGROUND_MASK = 16744448;
const FOREGROUND_SHIFT = 15;

const TYPES_SAMPLE = [
  '<types>',
  '  <ITEM_ID>UINT16</ITEM_ID>',
  '  <SKILL_SLOT>',
  '    FIXED_DICT',
  '    <Properties>',
  '      <slot_list>',
  '        <Type>ARRAY</Type>',
  '        <of>',
  '          <Type>SKILL_SLOT</Type>',
  '        </of>',
  '      </slot_list>',
  '      <count><Type>UINT32</Type></count>',
  '    </Properties>',
  '    <implementedBy>SKILL_SLOT_DATA.weapon_skill_slot_list_inst</implementedBy>',
  '  </SKILL_SLOT>',
  '</types>'
].join('\n');

const COMMENT_SAMPLE = '<!-- 注释里的 UINT16 ARRAY FIXED_DICT 不应着色 -->';
const ATTR_SAMPLE = '<ghost id="UINT16" kind="ARRAY"/>';

describe('types.xml 注入语法(批130)', () => {
  let registry: Registry | null = null;

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

    let textXml: unknown = null;
    let injection: unknown = null;
    let theme: unknown = null;
    try {
      const xmlModule = (await import('@shikijs/langs/xml')) as {
        default: unknown;
      };
      const xmlRaw = xmlModule.default;
      const xmlGrammars = (Array.isArray(xmlRaw) ? xmlRaw : [xmlRaw]) as Array<{
        scopeName: string;
      }>;
      textXml = xmlGrammars.find(item => item.scopeName === 'text.xml') ?? null;
      injection = JSON.parse(
        fs.readFileSync(path.join(root, 'syntaxes', 'kbengine-types-injection.json'), 'utf8')
      );
      theme = JSON.parse(
        fs.readFileSync(path.join(root, 'syntaxes', 'kbengine-color-theme.json'), 'utf8')
      );
    } catch {
      textXml = null; // 宿主语法不可解析时整组跳过
    }

    if (!textXml) {
      registry = null;
      return;
    }

    registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      theme: { name: (theme as { name: string }).name, settings: (theme as { tokenColors: unknown }).tokenColors },
      // 与 VS Code TMGrammarFactory 同形:按宿主 scope 给注入者清单,
      // 选择器由注入语法文件自身的 injectionSelector 提供。
      getInjections: scopeName => (scopeName === 'text.xml' ? ['text.kbengine-types'] : []),
      loadGrammar: async scopeName => {
        if (scopeName === 'text.xml') {
          return textXml as never;
        }
        if (scopeName === 'text.kbengine-types') {
          return injection as never;
        }
        return null;
      }
    });
  });

  /** tokenizeLine(scopes 模式):取 needle 的第 occurrence 次出现的 token scope 栈 */
  const scopesOfToken = async (
    needle: string,
    occurrence = 1
  ): Promise<{ scopes: string[]; count: number }> => {
    const grammar = await registry!.loadGrammar('text.xml');
    let stack = null;
    const found: string[][] = [];
    for (const line of TYPES_SAMPLE.split('\n')) {
      const result = grammar!.tokenizeLine(line, stack);
      stack = result.ruleStack;
      for (const token of result.tokens) {
        const text = line.slice(token.startIndex, token.endIndex);
        if (text === needle) {
          found.push(token.scopes);
        }
      }
    }
    return { scopes: found[occurrence - 1] ?? [], count: found.length };
  };

  it('内置类型取得 support.type.kbengine.builtin(别名形式与 Type 值形式)', async () => {
    if (!registry) {
      return;
    }
    for (const needle of ['UINT16', 'UINT32']) {
      const { scopes, count } = await scopesOfToken(needle);
      expect(count, `${needle} 应被分词命中`).toBeGreaterThan(0);
      expect(scopes, `${needle} 缺内置类型 scope`).toContain('support.type.kbengine.builtin');
    }
  });

  it('自定义类型引用取得 entity.name.type.kbengine.custom(与内置 scope 不同家族)', async () => {
    if (!registry) {
      return;
    }
    // SKILL_SLOT 出现三次:① 定义标签 <SKILL_SLOT> ② <Type>SKILL_SLOT</Type>
    // 引用处 ③ 闭标签 </SKILL_SLOT>——只有引用处落注入 scope。
    const ref = await scopesOfToken('SKILL_SLOT', 2);
    expect(ref.count, 'SKILL_SLOT 应出现三次').toBe(3);
    expect(ref.scopes).toContain('entity.name.type.kbengine.custom');
    expect(ref.scopes).not.toContain('support.type.kbengine.builtin');
  });

  it('自定义类型的定义标签与闭标签仍归宿主 XML 着色(注入不抢定义面)', async () => {
    if (!registry) {
      return;
    }
    for (const occurrence of [1, 3]) {
      const { scopes } = await scopesOfToken('SKILL_SLOT', occurrence);
      expect(scopes, `SKILL_SLOT 第 ${occurrence} 次出现应保留宿主标签 scope`)
        .toContain('entity.name.tag.localname.xml');
      expect(scopes).not.toContain('entity.name.type.kbengine.custom');
    }
  });

  it('ARRAY/FIXED_DICT 指令取得专属 keyword scope(含 Type 值位置)', async () => {
    if (!registry) {
      return;
    }
    // <Type>ARRAY</Type>:ARRAY 必须落指令 scope,不许被内置/自定义规则抢先
    const arrayHit = await scopesOfToken('ARRAY');
    expect(arrayHit.scopes).toContain('keyword.other.kbengine.array');
    expect(arrayHit.scopes).not.toContain('support.type.kbengine.builtin');
    expect(arrayHit.scopes).not.toContain('entity.name.type.kbengine.custom');

    // 裸写 FIXED_DICT(自定义类型体内)
    const dictHit = await scopesOfToken('FIXED_DICT');
    expect(dictHit.scopes).toContain('keyword.other.kbengine.fixed-dict');
    expect(dictHit.scopes).not.toContain('support.type.kbengine.builtin');
  });

  it('implementedBy 值取得专属 scope(模块段与符号段一体着色)', async () => {
    if (!registry) {
      return;
    }
    const needle = 'SKILL_SLOT_DATA.weapon_skill_slot_list_inst';
    const grammar = await registry.loadGrammar('text.xml');
    let stack = null;
    let hit = false;
    for (const line of TYPES_SAMPLE.split('\n')) {
      const result = grammar.tokenizeLine(line, stack);
      stack = result.ruleStack;
      for (const token of result.tokens) {
        if (line.slice(token.startIndex, token.endIndex) === needle) {
          hit = true;
          expect(token.scopes).toContain('variable.other.kbengine.implementedby');
        }
      }
    }
    expect(hit).toBe(true);
  });

  it('注释与属性值内零 kbengine scope 泄漏(排除选择器生效)', async () => {
    if (!registry) {
      return;
    }
    const grammar = await registry.loadGrammar('text.xml');
    for (const sample of [COMMENT_SAMPLE, ATTR_SAMPLE]) {
      let stack = null;
      const leaked: string[] = [];
      for (const line of sample.split('\n')) {
        const result = grammar.tokenizeLine(line, stack);
        stack = result.ruleStack;
        for (const token of result.tokens) {
          for (const scope of token.scopes) {
            if (scope.includes('kbengine')) {
              leaked.push(`${scope}@${line.slice(token.startIndex, token.endIndex)}`);
            }
          }
        }
      }
      expect(leaked, `${sample} 内不得出现 kbengine scope`).toEqual([]);
    }
  });

  it('四类前景色两两可区分且不同于普通文本(KBEngine Dark 实测)', async () => {
    if (!registry) {
      return;
    }
    const grammar = await registry.loadGrammar('text.xml');
    const colorMap = registry.getColorMap();
    const fgOf = (needle: string, occurrence = 1): string => {
      let stack = null;
      let seen = 0;
      for (const line of TYPES_SAMPLE.split('\n')) {
        const result = grammar.tokenizeLine2(line, stack);
        stack = result.ruleStack;
        for (let i = 0; i < result.tokens.length; i += 2) {
          const start = result.tokens[i];
          const end = i + 2 < result.tokens.length ? result.tokens[i + 2] : line.length;
          if (line.slice(start, end) === needle) {
            seen += 1;
            if (seen === occurrence) {
              return colorMap[(result.tokens[i + 1] & FOREGROUND_MASK) >>> FOREGROUND_SHIFT];
            }
          }
        }
      }
      throw new Error(`token not found: ${needle}#${occurrence} (seen ${seen})`);
    };

    const builtin = fgOf('UINT32');
    // 第 2 次 = <Type>SKILL_SLOT</Type> 引用处(1 是定义标签,3 是闭标签)
    const custom = fgOf('SKILL_SLOT', 2);
    const array = fgOf('ARRAY');
    const fixedDict = fgOf('FIXED_DICT');
    const plain = fgOf('slot_list'); // 宿主 XML 普通标签,非注入 scope

    const quads: Array<[string, string, string]> = [
      ['内置', builtin, custom],
      ['内置/ARRAY', builtin, array],
      ['内置/FIXED_DICT', builtin, fixedDict],
      ['自定义/ARRAY', custom, array],
      ['自定义/FIXED_DICT', custom, fixedDict],
      ['ARRAY/FIXED_DICT', array, fixedDict]
    ];
    for (const [pairName, a, b] of quads) {
      expect(a, `${pairName} 前景色相同,四类不可区分`).not.toBe(b);
    }
    for (const [kind, color] of [
      ['内置', builtin],
      ['自定义', custom],
      ['ARRAY', array],
      ['FIXED_DICT', fixedDict]
    ] as Array<[string, string]>) {
      expect(color, `${kind} 与普通 XML 文本同色`).not.toBe(plain);
    }
  });

  it('四类落在四个不同语义 scope(换主题仍可区分的机制保证)', () => {
    const grammar = JSON.parse(
      fs.readFileSync(path.join(root, 'syntaxes', 'kbengine-types-injection.json'), 'utf8')
    ) as { scopeName: string; injectionSelector: string; patterns: Array<{ name?: string }> };

    // 选择器形态:注入 text.xml,带注释/字符串排除(vscode 自带注入同款)
    expect(grammar.scopeName).toBe('text.kbengine-types');
    expect(grammar.injectionSelector).toBe('L:text.xml - (comment, string)');

    const scopes = grammar.patterns.map(rule => rule.name ?? '').filter(Boolean);
    // 内置类型的 <Type> 锚定式与裸文本式共用同一 scope(形态不同、语义相同)
    expect(scopes).toContain('support.type.kbengine.builtin');

    // 四类各自独占一个 scope 字符串:不写死色值,主题按 scope 着色即可区分
    const kinds = ['builtin', 'custom', 'array', 'fixed-dict'].map(kind => (
      scopes.find(name => name.endsWith(`.kbengine.${kind}`))
    ));
    for (const [index, kind] of kinds.entries()) {
      expect(kind, `缺少 .kbengine.${kinds[index] ?? ''} 归属的 scope`).toBeTruthy();
    }
    expect(new Set(kinds).size).toBe(4); // 四个 scope 两两不同

    // 语义归属只用既有主题家族,不私造新家族:
    //   内置=support.type / 自定义=entity.name.type(类型声明)
    //   ARRAY、FIXED_DICT=keyword.other(指令)/ implementedBy=variable.other
    const baseOf = (name: string) => name.replace(/\.kbengine\.[^.]+$/, '');
    expect(baseOf('support.type.kbengine.builtin')).toBe('support.type');
    expect(baseOf('entity.name.type.kbengine.custom')).toBe('entity.name.type');
    expect(new Set(scopes.map(baseOf)).size).toBe(4); // 五类落四个家族(array/dict 同属 keyword.other)
  });
});
