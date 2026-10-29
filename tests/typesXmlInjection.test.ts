import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Registry } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';

// types.xml 注入语法功能验收(批130,来源:用户 2026-10-14 着色增强需求;
// 批131 追加 implementedBy 分段着色):
// types.xml 默认由 XML 插件接管着色,kode 不得抢宿主分词——用注入语法
// (injection grammar)在其上叠加 KBEngine 语义 scope:
//   ① 内置类型(UINT32 等)有别于普通 XML 文本
//   ② 用户自定义类型也着色,且与内置类型可区分
//   ③ ARRAY / FIXED_DICT 指令有显著区别于其它 token 的专属色
//   ④ implementedBy 值分段:点号前逐段=模块段,最后一段=实现对象
//      (引擎 datatype.cpp loadImplModule 把值当「模块路径.实现对象」装载)
// 机制与 VS Code 自带注入语法同款(markdown-math/jsdoc 先例):
//   package.json 贡献点给 injectTo:["text.xml"](VS Code 据此建
//   scopeName→注入者映射),语法文件自带 injectionSelector 选择器
//   (vscode-textmate _collectInjections 按它收集注入规则)。
//   选择器带 "- (comment, string)" 排除:语义色不漏进注释与属性值。
// 本文件在真实 vscode-textmate Registry(宿主 text.xml + 注入语法 +
// KBEngine Dark 主题共装)下断言:
//   一、六类 token 各自取得预期语义 scope(注入真实生效,规则命中);
//   二、注释与属性值内零 kbengine scope 泄漏(排除选择器生效);
//   三、五类(内置/自定义/ARRAY/FIXED_DICT/implementedBy)前景色两两可区分,
//       且与普通 XML 文本可区分——用户验收口径;
//   四、各 token 落在不同 scope 家族(support.type / entity.name.type /
//       keyword.other×2 / variable.other / entity.name.namespace)——这是
//       "换主题仍可区分"的机制保证:语义 scope 不硬编码色值,主题换色不换语义归属。
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

// .def 宿主注入样本(2026-10-29 用户令:def 文件内建/ARRAY/自定义类型着色):
// def 走 source.kbengine-def 专属语法(末模式 include text.xml 委托分词),
// 注入语法须同时覆盖该宿主——与 types.xml 同一套规则、同 scope 家族。
const DEF_SAMPLE = [
  '<root>',
  '  <Properties>',
  '    <serverID><Type>SERVER_ID</Type></serverID>',
  '    <direction><Type>VECTOR3</Type></direction>',
  '    <items>',
  '      <Type>ARRAY<of>ITEM_INFO</of></Type>',
  '    </items>',
  '  </Properties>',
  '  <CellMethods>',
  '    <reborn>',
  '      <Arg>UINT8</Arg>',
  '    </reborn>',
  '  </CellMethods>',
  '</root>'
].join('\n');

// 批131:implementedBy 值形态专项——裸符号(模块缺省)与深层模块路径。
// 引擎 datatype.cpp loadImplModule 把值当「模块路径.实现对象」装载,
// 分段着色口径:点号前的每一段=模块段,紧贴闭标签的最后一段=符号段。
const IMPL_FORMS_SAMPLE = [
  '<types>',
  '  <BARE>',
  '    FIXED_DICT',
  '    <implementedBy>BareImpl</implementedBy>',
  '  </BARE>',
  '  <DEEP>',
  '    FIXED_DICT',
  '    <implementedBy>kbtest.sub.DataImpl</implementedBy>',
  '  </DEEP>',
  '</types>'
].join('\n');

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
    let defGrammar: unknown = null;
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
      defGrammar = JSON.parse(
        fs.readFileSync(path.join(root, 'syntaxes', 'kbengine.tmLanguage.json'), 'utf8')
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
      // 2026-10-29:注入宿主扩双份——text.xml(types.xml 等)+
      // source.kbengine-def(.def),与 package.json injectTo 同步。
      getInjections: scopeName =>
        scopeName === 'text.xml' || scopeName === 'source.kbengine-def'
          ? ['text.kbengine-types']
          : [],
      loadGrammar: async scopeName => {
        if (scopeName === 'text.xml') {
          return textXml as never;
        }
        if (scopeName === 'source.kbengine-def') {
          return defGrammar as never;
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

  /** 同 scopesOfToken,但作用于任意样本(批131:implementedBy 值形态专项) */
  const scopesIn = async (sample: string, needle: string): Promise<string[]> => {
    const grammar = await registry!.loadGrammar('text.xml');
    let stack = null;
    const found: string[][] = [];
    for (const line of sample.split('\n')) {
      const result = grammar!.tokenizeLine(line, stack);
      stack = result.ruleStack;
      for (const token of result.tokens) {
        if (line.slice(token.startIndex, token.endIndex) === needle) {
          found.push(token.scopes);
        }
      }
    }
    return found[0] ?? [];
  };

  /** 同 scopesIn,但宿主是 .def(source.kbengine-def 语法,注入双宿主另一边) */
  const scopesInDef = async (needle: string): Promise<string[]> => {
    const grammar = await registry!.loadGrammar('source.kbengine-def');
    let stack = null;
    const found: string[][] = [];
    for (const line of DEF_SAMPLE.split('\n')) {
      const result = grammar!.tokenizeLine(line, stack);
      stack = result.ruleStack;
      for (const token of result.tokens) {
        if (line.slice(token.startIndex, token.endIndex) === needle) {
          found.push(token.scopes);
        }
      }
    }
    return found[0] ?? [];
  };

  /** tokenizeLine2(前景色模式):取 needle 第 occurrence 次出现的主题前景色 */
  const fgOfToken = async (needle: string, occurrence = 1): Promise<string> => {
    const grammar = await registry!.loadGrammar('text.xml');
    const colorMap = registry!.getColorMap();
    let stack = null;
    let seen = 0;
    for (const line of TYPES_SAMPLE.split('\n')) {
      const result = grammar!.tokenizeLine2(line, stack);
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

  it('implementedBy 值分段着色:模块段与符号段 scope 分离(批131)', async () => {
    if (!registry) {
      return;
    }
    // SKILL_SLOT_DATA.weapon_skill_slot_list_inst:
    //   SKILL_SLOT_DATA = 模块段(namespace),weapon_skill_slot_list_inst = 符号段
    const { scopes: moduleScopes } = await scopesOfToken('SKILL_SLOT_DATA');
    expect(moduleScopes, '模块段缺 namespace scope').toContain('entity.name.namespace.kbengine.implmodule');
    expect(moduleScopes, '模块段不得落符号段 scope').not.toContain('variable.other.kbengine.implementedby');
    const { scopes: symbolScopes } = await scopesOfToken('weapon_skill_slot_list_inst');
    expect(symbolScopes, '符号段缺 variable.other scope').toContain('variable.other.kbengine.implementedby');
    expect(symbolScopes, '符号段不得落模块段 scope').not.toContain('entity.name.namespace.kbengine.implmodule');

    // 回归锁:整值不再是一枚 token(批130 一体着色的反面)
    const grammar = await registry.loadGrammar('text.xml');
    let stack = null;
    let whole = false;
    for (const line of TYPES_SAMPLE.split('\n')) {
      const result = grammar.tokenizeLine(line, stack);
      stack = result.ruleStack;
      for (const token of result.tokens) {
        if (line.slice(token.startIndex, token.endIndex) === 'SKILL_SLOT_DATA.weapon_skill_slot_list_inst') {
          whole = true;
        }
      }
    }
    expect(whole, '整值应拆成多枚 token').toBe(false);
  });

  it('implementedBy 值形态:裸符号只有符号段,深层模块逐段全落模块段(批131)', async () => {
    if (!registry) {
      return;
    }
    // 裸符号(无点号):只落符号段 scope
    const bare = await scopesIn(IMPL_FORMS_SAMPLE, 'BareImpl');
    expect(bare).toContain('variable.other.kbengine.implementedby');
    expect(bare).not.toContain('entity.name.namespace.kbengine.implmodule');

    // 深层模块 kbtest.sub.DataImpl:kbtest、sub = 模块段,DataImpl = 符号段
    for (const seg of ['kbtest', 'sub']) {
      const scopes = await scopesIn(IMPL_FORMS_SAMPLE, seg);
      expect(scopes, `${seg} 应为模块段`).toContain('entity.name.namespace.kbengine.implmodule');
      expect(scopes, `${seg} 不得落符号段`).not.toContain('variable.other.kbengine.implementedby');
    }
    const deepSymbol = await scopesIn(IMPL_FORMS_SAMPLE, 'DataImpl');
    expect(deepSymbol).toContain('variable.other.kbengine.implementedby');
    expect(deepSymbol).not.toContain('entity.name.namespace.kbengine.implmodule');
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
    const builtin = await fgOfToken('UINT32');
    // 第 2 次 = <Type>SKILL_SLOT</Type> 引用处(1 是定义标签,3 是闭标签)
    const custom = await fgOfToken('SKILL_SLOT', 2);
    const array = await fgOfToken('ARRAY');
    const fixedDict = await fgOfToken('FIXED_DICT');
    const plain = await fgOfToken('slot_list'); // 宿主 XML 普通标签,非注入 scope

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

  it('implementedBy 模块段与符号段前景色可区分且不同于普通文本(批131)', async () => {
    if (!registry) {
      return;
    }
    const moduleColor = await fgOfToken('SKILL_SLOT_DATA');
    const symbolColor = await fgOfToken('weapon_skill_slot_list_inst');
    const plain = await fgOfToken('slot_list');
    // 第 2 次 = <Type>SKILL_SLOT</Type> 引用处:implementedBy 就写在自定义类型体内,
    // 模块段与相邻的自定义类型引用也需视觉可区分
    const custom = await fgOfToken('SKILL_SLOT', 2);

    expect(moduleColor, '模块段与符号段同色,分段着色无效').not.toBe(symbolColor);
    expect(moduleColor, '模块段与普通 XML 文本同色').not.toBe(plain);
    expect(symbolColor, '符号段与普通 XML 文本同色').not.toBe(plain);
    expect(moduleColor, '模块段与自定义类型引用同色,同区块内不可区分').not.toBe(custom);
  });

  it('def 宿主注入(2026-10-29 用户令):内建/ARRAY/自定义类型在 .def 内取得同族 scope', async () => {
    if (!registry) {
      return;
    }
    // 方法定义 <Arg>UINT8</Arg> 与属性 <Type>VECTOR3</Type>:内建 support.type
    const vector = await scopesInDef('VECTOR3');
    expect(vector.some(scope => scope.endsWith('.kbengine.builtin'))).toBe(true);
    const argType = await scopesInDef('UINT8');
    expect(argType.some(scope => scope.endsWith('.kbengine.builtin'))).toBe(true);
    // ARRAY 指令 keyword;<Type>ARRAY<of>...</Type> 内联形态同命中
    const array = await scopesInDef('ARRAY');
    expect(array.some(scope => scope.endsWith('.kbengine.array'))).toBe(true);
    // 自定义类型引用(types.xml 名字)与 types.xml 内同款 custom scope
    const serverId = await scopesInDef('SERVER_ID');
    expect(serverId.some(scope => scope.endsWith('.kbengine.custom'))).toBe(true);
  });

  it('五类落在五个不同语义 scope(换主题仍可区分的机制保证)', () => {
    const grammar = JSON.parse(
      fs.readFileSync(path.join(root, 'syntaxes', 'kbengine-types-injection.json'), 'utf8')
    ) as { scopeName: string; injectionSelector: string; patterns: Array<{ name?: string }> };

    // 选择器形态:双宿主注入(text.xml + source.kbengine-def,2026-10-29
    // def 着色扩展),带注释/字符串排除(vscode 自带注入同款)
    expect(grammar.scopeName).toBe('text.kbengine-types');
    expect(grammar.injectionSelector).toBe(
      'L:text.xml - (comment, string), L:source.kbengine-def - (comment, string)'
    );

    const scopes = grammar.patterns.map(rule => rule.name ?? '').filter(Boolean);
    // 内置类型的 <Type> 锚定式与裸文本式共用同一 scope(形态不同、语义相同)
    expect(scopes).toContain('support.type.kbengine.builtin');

    // 五类各自独占一个 scope 字符串:不写死色值,主题按 scope 着色即可区分
    const kinds = ['builtin', 'custom', 'array', 'fixed-dict', 'implmodule'].map(kind => (
      scopes.find(name => name.endsWith(`.kbengine.${kind}`))
    ));
    for (const [index, kind] of kinds.entries()) {
      expect(kind, `缺少 .kbengine.${kinds[index] ?? ''} 归属的 scope`).toBeTruthy();
    }
    expect(new Set(kinds).size).toBe(5); // 五个 scope 两两不同

    // 语义归属只用既有主题家族,不私造新家族:
    //   内置=support.type / 自定义=entity.name.type(类型声明)
    //   ARRAY、FIXED_DICT=keyword.other(指令)
    //   implementedBy=variable.other(实现对象)/ entity.name.namespace(模块段,批131)
    const baseOf = (name: string) => name.replace(/\.kbengine\.[^.]+$/, '');
    expect(baseOf('support.type.kbengine.builtin')).toBe('support.type');
    expect(baseOf('entity.name.type.kbengine.custom')).toBe('entity.name.type');
    expect(new Set(scopes.map(baseOf)).size).toBe(5); // 六 scope 落五家族(array/dict 同属 keyword.other)
  });
});
