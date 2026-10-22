import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Registry } from 'vscode-textmate';
import type { IRawGrammar } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';

// 函数调用注入语法功能验收(2026-10-22,用户第 2 号问题):
// 用户口径: MagicPython 下函数调用一直落在 meta.function-call.generic 这类
// "无主题规则覆盖"的 scope——前景落回默认白(KBEngine Monokai #F8F8F2),
// 裸调用 foo(args) 甚至整行合并成一枚白 token。本单=白→浅蓝的可见变化:
//   ① 注入语法 text.python-function-calls -> source.python,只发射
//      variable.function.call.python 标准 scope;
//   ② 成员调用 obj.method() 的 method 落函数色,obj 不在 match 内(变量色);
//   ③ 排除关键字(if(x)/while(x)/not(x)/match(x) 等不吃色)、def/class 定义处
//      (lookbehind)与装饰器 @name(保宿主装饰器色);
//   ④ 主题新增 Function Calls 规则(浅蓝 #8BD5FF 族,浅色主题用可读深浅蓝)。
// 本文件在真实 vscode-textmate Registry(MagicPython + 双 python 注入 +
// KBEngine Monokai 主题共装)下断言:
//   一、get_color 命中函数 scope 且前景=#8BD5FF(白→浅蓝实测);
//   二、config 必不命中(变量保持默认白);def 定义处不吃色(保持绿);
//   三、关键字不吃色;注释/字符串内零泄漏(排除选择器生效);
//   四、常量注入共存(MAX_HP 仍落 variable.other.constant.python);
//   五、注入语法资产形制锁 + 11 套注册主题的 Function Calls 规则锁。
// MagicPython 取自 @shikijs/langs(与 microsoft/vscode 内建语法同源);
// 包不可解析时整组跳过(测试不引入网络依赖)。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FOREGROUND_MASK = 16744448;
const FOREGROUND_SHIFT = 15;

const FUNCTION_CALL_SCOPE = 'variable.function.call.python';
const FUNCTION_CALL_FG = '#8BD5FF';

const SAMPLE = [
  'MAX_HP = 100',
  'def get_color(self):',
  '    return MAX_HP',
  '',
  'config = load_config()',
  'color = config.get_color()',
  'if (color):',
  '    while (running):',
  '        not (flag)',
  '    entity.reset()',
  'helper(color)',
  '# 注释里的 config.get_color() helper( 不吃色',
  'text = "字符串里的 call foo( 也不吃色"'
].join('\n');

interface Hit {
  scopes: string[];
  fg: string;
}

describe('函数调用注入语法(2026-10-22, 用户第 2 号问题)', () => {
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

    let magicPython: IRawGrammar | null = null;
    let constInjection: unknown = null;
    let funcInjection: unknown = null;
    let theme: unknown = null;
    try {
      const langsModule = (await import('@shikijs/langs/python')) as {
        default: unknown;
      };
      const raw = langsModule.default;
      magicPython = (Array.isArray(raw) ? raw[0] : raw) as IRawGrammar;
      constInjection = JSON.parse(
        fs.readFileSync(path.join(root, 'syntaxes', 'python-constants-injection.json'), 'utf8')
      );
      funcInjection = JSON.parse(
        fs.readFileSync(path.join(root, 'syntaxes', 'python-function-calls-injection.json'), 'utf8')
      );
      theme = JSON.parse(
        fs.readFileSync(path.join(root, 'syntaxes', 'kbengine-color-theme.json'), 'utf8')
      );
    } catch {
      magicPython = null; // 宿主语法不可解析时整组跳过
    }

    if (!magicPython) {
      registry = null;
      return;
    }

    const constScopeName = (constInjection as { scopeName: string }).scopeName;
    const funcScopeName = (funcInjection as { scopeName: string }).scopeName;

    registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      theme: {
        name: (theme as { name: string }).name,
        settings: (theme as { tokenColors: unknown }).tokenColors
      },
      // 与 VS Code TMGrammarFactory 同形:按宿主 scope 给注入者清单,
      // 选择器由注入语法文件自身的 injectionSelector 提供。
      getInjections: scopeName =>
        scopeName === 'source.python' ? [constScopeName, funcScopeName] : [],
      loadGrammar: async scopeName => {
        if (scopeName === 'source.python') {
          return magicPython as never;
        }
        if (scopeName === constScopeName) {
          return constInjection as never;
        }
        if (scopeName === funcScopeName) {
          return funcInjection as never;
        }
        return null;
      }
    });
  });

  /**
   * 取 sample 中全部等于 needle 的 token:scope 栈来自 tokenizeLine 遍
   * (不合并);前景按该 token 的位置到 tokenizeLine2 遍定位(2 遍会把
   * 同前景相邻 token 合并,故按区间包含而非文本对齐)。
   */
  const analyze = async (needle: string, sample = SAMPLE): Promise<Hit[]> => {
    const grammar = (await registry!.loadGrammar('source.python'))!;
    const colorMap = registry!.getColorMap();
    const lines = sample.split('\n');

    const occurrences: Array<{ line: number; start: number; end: number; scopes: string[] }> = [];
    let stack1 = null;
    for (const [index, line] of lines.entries()) {
      const result = grammar.tokenizeLine(line, stack1);
      stack1 = result.ruleStack;
      for (const token of result.tokens) {
        if (line.slice(token.startIndex, token.endIndex) === needle) {
          occurrences.push({
            line: index,
            start: token.startIndex,
            end: token.endIndex,
            scopes: token.scopes
          });
        }
      }
    }

    // 逐行做 tokenizeLine2,按位置区间解析各 occurrence 的前景
    const fgPerLine: Array<Array<{ start: number; end: number; fg: string }>> = [];
    let stack2 = null;
    for (const line of lines) {
      const result = grammar.tokenizeLine2(line, stack2);
      stack2 = result.ruleStack;
      const spans: Array<{ start: number; end: number; fg: string }> = [];
      for (let i = 0; i < result.tokens.length; i += 2) {
        const start = result.tokens[i];
        const end = i + 2 < result.tokens.length ? result.tokens[i + 2] : line.length;
        spans.push({
          start,
          end,
          fg: colorMap[(result.tokens[i + 1] & FOREGROUND_MASK) >>> FOREGROUND_SHIFT]
        });
      }
      fgPerLine.push(spans);
    }

    return occurrences.map(({ line, start, end, scopes }) => {
      const mid = Math.floor((start + end) / 2);
      const span = fgPerLine[line].find(item => item.start <= mid && mid < item.end);
      expect(span, `token ${needle}@${line}:${start} 在前景遍未定位到区间`).toBeTruthy();
      return { scopes, fg: span?.fg ?? '' };
    });
  };

  const expectHits = (hits: Hit[], needle: string, count = 1): void => {
    expect(hits.length, `token ${needle} 应出现 ${count} 次`).toBe(count);
  };

  it('成员调用 method 命中函数 scope 且前景=浅蓝 #8BD5FF(白→浅蓝实测)', async () => {
    if (!registry) {
      return;
    }
    // 第 1 次=def 定义处(保持 entity.name.function),第 2 次=调用处
    const hits = await analyze('get_color');
    expectHits(hits, 'get_color', 2);
    expect(hits[1].scopes, `调用处应带函数 scope,实际 ${JSON.stringify(hits[1].scopes)}`).toContain(
      FUNCTION_CALL_SCOPE
    );
    expect(hits[1].fg).toBe(FUNCTION_CALL_FG);
  });

  it('def 定义处不吃色(函数名保持 entity.name.function 绿)', async () => {
    if (!registry) {
      return;
    }
    const hits = await analyze('get_color');
    expectHits(hits, 'get_color', 2);
    expect(hits[0].scopes).not.toContain(FUNCTION_CALL_SCOPE);
    expect(
      hits[0].scopes.some(scope => scope.startsWith('entity.name.function')),
      `定义处应保持 entity.name.function 族,实际 ${JSON.stringify(hits[0].scopes)}`
    ).toBe(true);
    expect(hits[0].fg).toBe('#A6E22E');
  });

  it('config 必不命中函数 scope(变量保持默认前景,与函数肉眼可分)', async () => {
    if (!registry) {
      return;
    }
    // 赋值左侧与成员调用 obj 位各一次,两处都不得命中
    const hits = await analyze('config');
    expectHits(hits, 'config', 2);
    for (const hit of hits) {
      expect(hit.scopes).not.toContain(FUNCTION_CALL_SCOPE);
      expect(hit.scopes).not.toContain('variable.other.constant.python');
      // before 取证: obj 落在无主题规则覆盖的默认前景(白),修复后必须保持
      expect(hit.fg).toBe('#F8F8F2');
    }
  });

  it('裸调用命中函数 scope(修复前是整行合并的白 token)', async () => {
    if (!registry) {
      return;
    }
    const helper = await analyze('helper');
    expectHits(helper, 'helper');
    expect(helper[0].scopes).toContain(FUNCTION_CALL_SCOPE);
    expect(helper[0].fg).toBe(FUNCTION_CALL_FG);

    const loadConfig = await analyze('load_config');
    expectHits(loadConfig, 'load_config');
    expect(loadConfig[0].scopes).toContain(FUNCTION_CALL_SCOPE);
    expect(loadConfig[0].fg).toBe(FUNCTION_CALL_FG);
  });

  it('关键字不吃色(if/while/not 后跟括号不落函数 scope)', async () => {
    if (!registry) {
      return;
    }
    for (const keyword of ['if', 'while', 'not']) {
      const hits = await analyze(keyword);
      expectHits(hits, keyword);
      expect(
        hits[0].scopes,
        `关键字 ${keyword} 不应带函数 scope,实际 ${JSON.stringify(hits[0].scopes)}`
      ).not.toContain(FUNCTION_CALL_SCOPE);
    }
  });

  it('成员调用的 obj 不吃色、self 保持语言变量色(self/obj 与 method 可分)', async () => {
    if (!registry) {
      return;
    }
    const reset = await analyze('reset');
    expectHits(reset, 'reset');
    expect(reset[0].scopes).toContain(FUNCTION_CALL_SCOPE);
    expect(reset[0].fg).toBe(FUNCTION_CALL_FG);

    const entity = await analyze('entity');
    expectHits(entity, 'entity');
    expect(entity[0].scopes).not.toContain(FUNCTION_CALL_SCOPE);
    expect(entity[0].fg).not.toBe(FUNCTION_CALL_FG);

    const self = await analyze('self');
    expectHits(self, 'self');
    expect(
      self[0].scopes.some(scope =>
        scope.startsWith('variable.parameter.function.language.special.self')
      ),
      `self 应保持宿主 special.self 归属,实际 ${JSON.stringify(self[0].scopes)}`
    ).toBe(true);
  });

  it('常量注入共存: MAX_HP 仍落 variable.other.constant.python(两注入互不干扰)', async () => {
    if (!registry) {
      return;
    }
    const hits = await analyze('MAX_HP');
    expectHits(hits, 'MAX_HP', 2);
    for (const hit of hits) {
      expect(hit.scopes).toContain('variable.other.constant.python');
      expect(hit.scopes).not.toContain(FUNCTION_CALL_SCOPE);
    }
  });

  it('注释与字符串内零函数 scope 泄漏(排除选择器生效)', async () => {
    if (!registry) {
      return;
    }
    for (const sample of [
      '# 注释里的 config.get_color() helper( 不吃色',
      'text = "字符串里的 call foo( 也不吃色"'
    ]) {
      const grammar = (await registry.loadGrammar('source.python'))!;
      let stack = null;
      const leaked: string[] = [];
      for (const line of sample.split('\n')) {
        const result = grammar.tokenizeLine(line, stack);
        stack = result.ruleStack;
        for (const token of result.tokens) {
          for (const scope of token.scopes) {
            if (scope === FUNCTION_CALL_SCOPE) {
              leaked.push(`${scope}@${line.slice(token.startIndex, token.endIndex)}`);
            }
          }
        }
      }
      expect(leaked, `${sample} 内不得出现函数 scope`).toEqual([]);
    }
  });

  it('注入语法资产形制锁(scopeName/选择器/仅发射函数 scope)', () => {
    const grammar = JSON.parse(
      fs.readFileSync(path.join(root, 'syntaxes', 'python-function-calls-injection.json'), 'utf8')
    ) as {
      scopeName: string;
      injectionSelector: string;
      patterns: Array<{ name?: string; match?: string }>;
    };
    // 选择器形态与 python-constants 同款:注入 source.python,排除注释/字符串
    expect(grammar.scopeName).toBe('text.python-function-calls');
    expect(grammar.injectionSelector).toBe('L:source.python - (comment, string)');
    const scopes = grammar.patterns.map(rule => rule.name ?? '').filter(Boolean);
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(scope).toBe(FUNCTION_CALL_SCOPE); // 只发射一个标准 scope
    }
    // 两条规则:成员调用(点号前视)+ 裸调用(关键字/def 排除)
    expect(grammar.patterns).toHaveLength(2);
    expect(grammar.patterns[0].match).toContain('(?<=\\.)');
    expect(grammar.patterns[1].match).toContain('(?<!\\bdef\\s)');
    // 关键字排除在位(if/while/not/match/lambda/return 等)
    for (const keyword of ['if', 'while', 'not', 'match', 'lambda', 'return']) {
      expect(grammar.patterns[1].match).toContain(`${keyword}\\b`);
    }
    // 全部正则可编译(oniguruma 语义由分词用例实测)
    for (const rule of grammar.patterns) {
      expect(() => new RegExp(rule.match ?? ''), rule.match).not.toThrow();
    }
  });

  it('11 套注册主题全带 Function Calls 规则且色值按表(浅蓝族)', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    ) as { contributes: { themes: Array<{ label: string; path: string }> } };
    // 浅色背景主题用可读的浅蓝族深变体(纯 #8BD5FF 在白底近乎不可见)
    const expectedColor: Record<string, string> = {
      'KBEngine (GitHub Light)': '#0969DA',
      'KBEngine (Solarized Light)': '#1A6BA6',
      'KBEngine (Visual Studio Light+)': '#0063B3'
    };
    for (const entry of pkg.contributes.themes) {
      const theme = JSON.parse(
        fs.readFileSync(path.join(root, entry.path.replace(/^\.\//, '')), 'utf8')
      ) as {
        colors: Record<string, string>;
        tokenColors: Array<{ name?: string; scope?: unknown; settings?: { foreground?: string } }>;
      };
      const rule = theme.tokenColors.find(item => item.name === 'Function Calls');
      expect(rule, `${entry.label} 缺 Function Calls 规则`).toBeTruthy();
      const scopes = Array.isArray(rule?.scope) ? (rule?.scope as string[]) : [rule?.scope as string];
      expect(scopes, entry.label).toContain('variable.function.call');
      const want = (expectedColor[entry.label] ?? FUNCTION_CALL_FG).toUpperCase();
      expect(rule?.settings?.foreground?.toUpperCase(), entry.label).toBe(want);
      // 与该主题其它规则的 foreground 不撞色(与既有规则不撞口径)
      const others = theme.tokenColors
        .filter(item => item.name !== 'Function Calls')
        .map(item => item.settings?.foreground?.toUpperCase())
        .filter(Boolean);
      expect(others, `${entry.label} 函数色与既有规则撞色`).not.toContain(want);
      // 与默认前景可区分(白→浅蓝的可见变化)
      expect(want).not.toBe(theme.colors['editor.foreground'].toUpperCase());
    }
  });
});
