import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Registry } from 'vscode-textmate';
import type { IRawGrammar } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';

// .py 高亮与扩展语法共存实证(批103,紧急高亮回归排查的验收面):
// VS Code 的 .py 着色由内建 python 扩展的 MagicPython(scopeName
// source.python)提供,kode 只注册 source.kbengine-def。本文件把两条
// grammar 按真实共装形态注册进同一个 vscode-textmate Registry(等价于
// 干净环境装 kode vsix 后的 grammar 池),证明:
// 一、.py 样例经 MagicPython 分词出完整 python scope(高亮不因 kode
//     在位而缺失);
// 二、python 分词结果零 kbengine scope 泄漏(kode 语法不波及 .py);
// 三、.def 样例在共装池中照常出 kbengine scope(.def 未受牵连)。
// MagicPython 取自 @shikijs/langs(vitepress 依赖链、经 .npmrc
// shamefully-hoist 顶层可见,与 microsoft/vscode 内建语法同源);包不可
// 解析时整组跳过(测试不引入网络依赖)。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PYTHON_SAMPLE = [
  'import time',
  '',
  'class FightAI:',
  '    def on_enter(self, entity):',
  '        # 进入 cell 后初始化',
  '        name = "hero_%d" % entity.id',
  '        if entity.hp > 0:',
  '            return None'
].join('\n');

const DEF_SAMPLE = [
  '<Properties>',
  '  <Property Name="hp" Type="UINT32" Flags="BASE_AND_CLIENT">',
  '    <DetailLevel>0</DetailLevel>',
  '  </Property>',
  '</Properties>'
].join('\n');

const allScopes = (grammar: { tokenizeLine: (line: string, stack: unknown) => { tokens: Array<{ scopes: string[] }> } }, text: string): Set<string> => {
  const scopes = new Set<string>();
  let stack: unknown = null;
  for (const line of text.split('\n')) {
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    for (const token of result.tokens) {
      for (const scope of token.scopes) {
        scopes.add(scope);
      }
    }
  }
  return scopes;
};

describe('python ↔ kbengine-def 语法共装分词(批103)', () => {
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
    try {
      const langsModule = (await import('@shikijs/langs/python')) as {
        default: unknown;
      };
      const raw = langsModule.default;
      magicPython = (Array.isArray(raw) ? raw[0] : raw) as IRawGrammar;
    } catch {
      magicPython = null; // 包不可达(未提升/改版)时整组跳过
    }

    if (!magicPython) {
      registry = null;
      return;
    }

    const kbGrammar = JSON.parse(
      fs.readFileSync(path.join(root, 'syntaxes', 'kbengine.tmLanguage.json'), 'utf8')
    ) as IRawGrammar;

    registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      loadGrammar: async scopeName => {
        if (scopeName === 'source.python') {
          return magicPython;
        }
        if (scopeName === 'source.kbengine-def') {
          return kbGrammar;
        }
        return null;
      }
    });
  });

  it('共装池就绪(依赖在位时)', () => {
    // @shikijs/langs 不可解析时 registry 保持 null,后续用例全部跳过
    if (!registry) {
      return;
    }
    expect(registry).toBeInstanceOf(Registry);
  });

  it('.py 样例由 MagicPython 分词出完整 python scope', async () => {
    if (!registry) {
      return;
    }
    const grammar = await registry.loadGrammar('source.python');
    expect(grammar).not.toBeNull();
    const scopes = allScopes(grammar!, PYTHON_SAMPLE);
    const wanted = [
      'source.python',
      'keyword.control.import.python',
      'meta.class.python',
      'entity.name.function.python',
      'comment.line.number-sign.python',
      'keyword.control.flow.python'
    ];
    const missed = wanted.filter(scope => !scopes.has(scope));
    expect(missed, `python scope 缺失: ${missed.join(', ')}`).toEqual([]);
    // 字符串 scope 按 MagicPython 实际命名(string.quoted.*.python)断言
    const hasString = [...scopes].some(
      scope => scope.startsWith('string.quoted.') && scope.endsWith('.python')
    );
    expect(hasString, 'python 字符串 scope 缺失').toBe(true);
  });

  it('python 分词零 kbengine scope 泄漏', async () => {
    if (!registry) {
      return;
    }
    const grammar = await registry.loadGrammar('source.python');
    const scopes = allScopes(grammar!, PYTHON_SAMPLE);
    const leaked = [...scopes].filter(scope => scope.includes('kbengine'));
    expect(leaked).toEqual([]);
  });

  it('.def 样例在共装池中照常出 kbengine scope(.def 未受牵连)', async () => {
    if (!registry) {
      return;
    }
    const grammar = await registry.loadGrammar('source.kbengine-def');
    expect(grammar).not.toBeNull();
    const scopes = allScopes(grammar!, DEF_SAMPLE);
    const wanted = [
      'source.kbengine-def',
      'entity.name.symbol.kbengine',
      'support.type.primitive.integer.kbengine',
      'constant.language.flag.kbengine'
    ];
    const missed = wanted.filter(scope => !scopes.has(scope));
    expect(missed, `kbengine scope 缺失: ${missed.join(', ')}`).toEqual([]);
  });
});
