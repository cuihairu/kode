import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Registry } from 'vscode-textmate';
import type { IRawGrammar } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';

// KBEngine Dark 主题通用 tokenColors 覆盖回归(批107,高亮消失根因修复的验收面):
// 根因=主题仅含 .kbengine/xml 专属规则(31 条),切到本主题后 .py 等通用
// 语言 token 无规则可配 → 全部落到前景色,用户所见即"着色消失"。
// 修复=按 VS Code Dark+ 标准 scope 集补通用规则(字符串/关键字/数字/
// 类型/函数/变量/操作符/正则等),并在 kbengine.tmLanguage.json 里把
// 追加给 .def 的标准 scope(entity.name.function、storage.type.numeric.*)
// 调到 scope 栈浅层,让既有 kbengine 规则始终占据最深层——vscode-textmate
// 主题匹配按"路径深度优先、同深度取更长选择器"评分,且不支持通配符与
// 排除选择器(实测 `entity.name.function.*`、`a -b` 均整条静默失配),
// 浅层化是唯一能让通用规则与 .def 专属规则共存的手法。
// 本文件在真实 vscode-textmate Registry(主题 + MagicPython + kbengine
// 共装形态)下断言:
// 一、.py 样例的关键 token 在本主题下取得预期前景色(不再落前景兜底色);
// 二、.def 样例逐 token 前景色与修复前基线完全一致(.def 着色零回归);
// 三、python 分词零 kbengine scope 泄漏(主题修复不改变批103 结论)。
// MagicPython 取自 @shikijs/langs(与 microsoft/vscode 内建语法同源);
// 包不可解析时整组跳过(测试不引入网络依赖)。

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

// .def 金样本:修复前基线逐 token 前景色(探针实测,22 行样本共 21 个
// 非空白 token)。主题修复后必须与此逐位一致。
const DEF_GOLDEN: Array<[string, string]> = [
  ['<Properties>', '#F92672'],
  ['<Property', '#F92672'],
  ['Name', '#A6E22E'],
  ['=', '#F8F8F2'],
  ['"hp"', '#E6DB74'],
  ['Type', '#A6E22E'],
  ['=', '#F8F8F2'],
  ['"', '#E6DB74'],
  ['UINT32', '#66D9EF'],
  ['"', '#E6DB74'],
  ['Flags', '#A6E22E'],
  ['=', '#F8F8F2'],
  ['"', '#E6DB74'],
  ['BASE_AND_CLIENT', '#F92672'],
  ['"', '#E6DB74'],
  ['>', '#F92672'],
  ['<DetailLevel>', '#F92672'],
  ['0', '#F8F8F2'],
  ['</DetailLevel>', '#F92672'],
  ['</Property>', '#F92672'],
  ['</Properties>', '#F92672']
];

// .py 必须取得的前景色(期望子集:每个 [token, 颜色] 都须在实际结果中出现)。
const PYTHON_EXPECTED: Array<[string, string]> = [
  ['import', '#C586C0'],
  ['class', '#569CD6'],
  ['FightAI', '#4EC9B0'],
  ['def', '#569CD6'],
  ['on_enter', '#DCDCAA'],
  ['self', '#9CDCFE'],
  ['entity', '#9CDCFE'],
  ['# 进入 cell 后初始化', '#75715E'],
  ['=', '#D4D4D4'],
  ['"hero_%d"', '#CE9178'],
  ['%', '#D4D4D4'],
  ['if', '#C586C0'],
  ['>', '#D4D4D4'],
  ['0', '#B5CEA8'],
  ['return', '#C586C0'],
  ['None', '#569CD6']
];

// 前景掩码与位移来自 vscode-textmate EncodedTokenAttributes.getForeground
const FOREGROUND_MASK = 16744448;
const FOREGROUND_SHIFT = 15;

describe('KBEngine Dark 主题通用着色覆盖(批107)', () => {
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
    const theme = JSON.parse(
      fs.readFileSync(path.join(root, 'syntaxes', 'kbengine-color-theme.json'), 'utf8')
    ) as { name: string; tokenColors: unknown };

    registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      theme: { name: theme.name, settings: theme.tokenColors },
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

  /** tokenizeLine2 逐 token 解出 [非空白文本, 前景色],按行推进 ruleStack */
  const coloredTokens = async (
    scopeName: string,
    text: string
  ): Promise<Array<[string, string]>> => {
    const grammar = await registry!.loadGrammar(scopeName);
    const colorMap = registry!.getColorMap();
    const out: Array<[string, string]> = [];
    let stack = null;
    for (const line of text.split('\n')) {
      const result = grammar!.tokenizeLine2(line, stack);
      stack = result.ruleStack;
      const raw = result.tokens;
      for (let i = 0; i < raw.length; i += 2) {
        const start = raw[i];
        const end = i + 2 < raw.length ? raw[i + 2] : line.length;
        const fg = colorMap[(raw[i + 1] & FOREGROUND_MASK) >>> FOREGROUND_SHIFT];
        const tokenText = line.slice(start, end);
        if (tokenText.trim().length > 0) {
          out.push([tokenText.trim(), fg ?? '']);
        }
      }
    }
    return out;
  };

  it('共装池与主题就绪(依赖在位时)', () => {
    // @shikijs/langs 不可解析时 registry 保持 null,后续用例全部跳过
    if (!registry) {
      return;
    }
    expect(registry).toBeInstanceOf(Registry);
  });

  it('.py 关键 token 在本主题下取得预期前景色(着色不再消失)', async () => {
    if (!registry) {
      return;
    }
    const actual = await coloredTokens('source.python', PYTHON_SAMPLE);
    const actualSet = new Set(actual.map(([text, fg]) => `${text}\u0000${fg}`));
    const missed = PYTHON_EXPECTED.filter(
      ([text, fg]) => !actualSet.has(`${text}\u0000${fg}`)
    );
    expect(
      missed,
      `python token 未取得预期色: ${missed.map(([t, c]) => `${t}→${c}`).join(', ')}`
    ).toEqual([]);
  });

  it('.def 样例前景色与修复前基线逐位一致(零回归)', async () => {
    if (!registry) {
      return;
    }
    const actual = await coloredTokens('source.kbengine-def', DEF_SAMPLE);
    expect(actual).toEqual(DEF_GOLDEN);
  });

  it('python 分词零 kbengine scope 泄漏(主题修复不波及批103 结论)', async () => {
    if (!registry) {
      return;
    }
    const grammar = await registry.loadGrammar('source.python');
    let stack = null;
    const leaked: string[] = [];
    for (const line of PYTHON_SAMPLE.split('\n')) {
      const result = grammar!.tokenizeLine(line, stack);
      stack = result.ruleStack;
      for (const token of result.tokens) {
        for (const scope of token.scopes) {
          if (scope.includes('kbengine')) {
            leaked.push(scope);
          }
        }
      }
    }
    expect(leaked).toEqual([]);
  });
});
