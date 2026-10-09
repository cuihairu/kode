import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Registry } from 'vscode-textmate';
import type { IRawGrammar } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';

// KBEngine Dark 主题通用 tokenColors 覆盖回归(批107 建面,批110 重铸):
// 批107 根因=主题仅含 .kbengine/xml 专属规则,切到本主题后 .py 等通用
// 语言 token 无规则可配 → 全部落到前景色,用户所见即"着色消失"。
// 修复=按 VS Code Dark+ 标准 scope 集补通用规则。批110 用户令 def 改版:
// 分词委托内建 XML + 少量语义前置规则(Properties=玩家属性、三方法段
// 分色、Exposed=客户端可请求、Persistent=自动存储、Flags 值=引擎常量),
// 旧"全红"基线随之作废,.def 金样本按新语义逐 token 重录(探针实测后
// 逐项对着色意图核对,非盲拍快照)。
// 本文件在真实 vscode-textmate Registry(主题 + MagicPython + kbengine
// 共装形态)下断言:
// 一、.py 样例的关键 token 在本主题下取得预期前景色(不再落前景兜底色);
// 二、.def 样例逐 token 前景色与批110 语义基线一致;
// 三、python 分词零 kbengine scope 泄漏(主题修复不改变批103 结论)。
// MagicPython/text.xml 取自 @shikijs/langs(与 microsoft/vscode 内建语法
// 同源;text.xml 是 [java, xml] 数组,按 scopeName 取 text.xml);
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
  '  <hp id="1">',
  '    <Type>UINT32</Type>',
  '    <Flags>BASE_AND_CLIENT</Flags>',
  '    <Persistent>true</Persistent>',
  '  </hp>',
  '</Properties>',
  '<BaseMethods>',
  '  <onKill>',
  '    <Exposed>true</Exposed>',
  '  </onKill>',
  '</BaseMethods>',
  '<CellMethods>',
  '  <onScan>',
  '    <Arg>ENTITY_ID</Arg>',
  '  </onScan>',
  '</CellMethods>',
  '<ClientMethods>',
  '  <onDamage>',
  '    <Arg>UINT8</Arg>',
  '  </onDamage>',
  '</ClientMethods>'
].join('\n');

// .def 金样本:批110 语义基线逐 token 前景色(探针实测,四段+Exposed/
// Persistent/Flags 全要素;批110 二调按 ui-ux-pro-max 技能分析重配:
// One Dark 色调家族去饱和变体、全部对 #272822 ≥4.5:1(AA)、粗体只留
// 四区块)。着色意图:标点灰 #969696、普通标签蓝、属性名浅蓝、字符串
// 橙、裸值默认前景、Properties 琥珀 #E5C07B、BaseMethods 绿 #98C379、
// CellMethods 青 #56B6C2、ClientMethods 紫 #C678DD(四区块粗体)、
// Exposed/其 true 值红 #E06C75、Persistent/其 true 值橙 #D19A66、Flags
// 值蓝 #61AFEF。主题与语法任何一方漂移都会在此逐位暴露。
const DEF_GOLDEN: Array<[string, string]> = [
  ['<', '#969696'],
  ['Properties', '#E5C07B'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['hp', '#569CD6'],
  ['id', '#9CDCFE'],
  ['=', '#969696'],
  ['"1"', '#CE9178'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['Type', '#569CD6'],
  ['>', '#969696'],
  ['UINT32', '#F8F8F2'],
  ['</', '#969696'],
  ['Type', '#569CD6'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['Flags', '#569CD6'],
  ['>', '#969696'],
  ['BASE_AND_CLIENT', '#61AFEF'],
  ['</', '#969696'],
  ['Flags', '#569CD6'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['Persistent', '#D19A66'],
  ['>', '#969696'],
  ['true', '#D19A66'],
  ['</', '#969696'],
  ['Persistent', '#D19A66'],
  ['>', '#969696'],
  ['</', '#969696'],
  ['hp', '#569CD6'],
  ['>', '#969696'],
  ['</', '#969696'],
  ['Properties', '#E5C07B'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['BaseMethods', '#98C379'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['onKill', '#569CD6'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['Exposed', '#E06C75'],
  ['>', '#969696'],
  ['true', '#E06C75'],
  ['</', '#969696'],
  ['Exposed', '#E06C75'],
  ['>', '#969696'],
  ['</', '#969696'],
  ['onKill', '#569CD6'],
  ['>', '#969696'],
  ['</', '#969696'],
  ['BaseMethods', '#98C379'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['CellMethods', '#56B6C2'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['onScan', '#569CD6'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['Arg', '#569CD6'],
  ['>', '#969696'],
  ['ENTITY_ID', '#F8F8F2'],
  ['</', '#969696'],
  ['Arg', '#569CD6'],
  ['>', '#969696'],
  ['</', '#969696'],
  ['onScan', '#569CD6'],
  ['>', '#969696'],
  ['</', '#969696'],
  ['CellMethods', '#56B6C2'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['ClientMethods', '#C678DD'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['onDamage', '#569CD6'],
  ['>', '#969696'],
  ['<', '#969696'],
  ['Arg', '#569CD6'],
  ['>', '#969696'],
  ['UINT8', '#F8F8F2'],
  ['</', '#969696'],
  ['Arg', '#569CD6'],
  ['>', '#969696'],
  ['</', '#969696'],
  ['onDamage', '#569CD6'],
  ['>', '#969696'],
  ['</', '#969696'],
  ['ClientMethods', '#C678DD'],
  ['>', '#969696']
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
    let textXml: IRawGrammar | null = null;
    try {
      const langsModule = (await import('@shikijs/langs/python')) as {
        default: unknown;
      };
      const raw = langsModule.default;
      magicPython = (Array.isArray(raw) ? raw[0] : raw) as IRawGrammar;

      // 批110:kbengine-def 分词委托 text.xml,Registry 须能取到宿主语法。
      // @shikijs/langs/xml 的 default 是 [java, text.xml] 数组,按 scopeName 取。
      const xmlModule = (await import('@shikijs/langs/xml')) as {
        default: unknown;
      };
      const xmlRaw = xmlModule.default;
      const xmlGrammars = (Array.isArray(xmlRaw) ? xmlRaw : [xmlRaw]) as Array<{
        scopeName: string;
      }>;
      textXml = (xmlGrammars.find(item => item.scopeName === 'text.xml') ?? null) as IRawGrammar | null;
    } catch {
      magicPython = null; // 包不可达(未提升/改版)时整组跳过
    }

    if (!magicPython || !textXml) {
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
        if (scopeName === 'text.xml') {
          return textXml;
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
