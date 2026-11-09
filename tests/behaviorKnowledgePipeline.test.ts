import { describe, expect, it } from 'vitest';
import {
  KBEngineFixedDictWholeReassignCodeActionProvider,
  KBEngineHoverProvider
} from '../src/languageProviders';
import { FIXED_DICT_NESTED_MUTATION_CODE } from '../src/backend/behaviorKnowledge';
import { FIXED_DICT_TYPE_NAME } from '../src/backend/kbengineMetadata';
import type { EntityMappingManager } from '../src/entityMapping';
import {
  CodeActionKind,
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range,
  configurationOverrides,
  makeTextDocument
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// C-23(交付③)集成面:行为知识条目 → 悬停注记 / 快速修复 的 provider 级
// 验收。纯层(条目结构/lint 判定/编辑产出)在 behaviorKnowledge.test.ts 与
// behaviorLints.test.ts;这里锁 wiring:①符号注记挂在真实 hover 链出口
// (python 面,开关 gate,重建 MarkdownString 不叠 memo 缓存);②FIXED_DICT
// 属性类型 hover 尾部挂 FIXED_DICT 注记(defTypeName 直文本命中);③
// fixedDictNestedMutation 诊断 → 整体重赋 QuickFix(code 对账,非本码/行
// 形态不匹配不出)。

const hoverText = (hover: unknown): string => {
  if (!hover || typeof hover !== 'object') {
    return '';
  }
  const contents = (hover as { contents: unknown }).contents;
  if (Array.isArray(contents)) {
    return contents.map(item => (typeof item === 'string' ? item : String((item as { value?: string }).value ?? ''))).join('');
  }
  if (contents && typeof contents === 'object' && 'value' in contents) {
    return String((contents as { value: string }).value);
  }
  return typeof contents === 'string' ? contents : '';
};

const pythonHover = async (
  provider: KBEngineHoverProvider,
  text: string,
  line: number,
  character: number,
  fileName = '/tmp/ws/scripts/base/Avatar.py'
): Promise<string> => {
  const document = makeTextDocument(text, { fileName, languageId: 'python' });
  const hover = await provider.provideHover(document, new Position(line, character));
  return hoverText(hover);
};

describe('C-23 悬停行为注记:符号面(wiring)', () => {
  it('delTimer 词上挂双语行为注记(现象/正确姿势/依据)', async () => {
    const provider = new KBEngineHoverProvider();
    const text = 'self.delTimer(self.tid)\n';
    const note = await pythonHover(provider, text, 0, 8);
    expect(note).toContain('行为注记');
    expect(note).toContain('Behavior note');
    expect(note).toContain('正确姿势');
    expect(note).toContain('Correct pattern');
    expect(note).toContain('依据/Evidence');
  });

  it('addTimer 一词挂两条(实体级安全 + 模块级泄漏),互不吞并', async () => {
    const provider = new KBEngineHoverProvider();
    const text = 'tid = self.addTimer(0.5, 1.0, 0)\n';
    const note = await pythonHover(provider, text, 0, 14);
    // 两条 symptom 都在:实体级 destroy 全量取消 + 模块级 app timer 强持
    expect(note).toContain('destroy');
    expect((note.match(/Behavior note:/g) ?? []).length).toBe(2);
  });

  it('同点位二次悬停不叠加(memo 缓存实例不被原地改写)', async () => {
    const provider = new KBEngineHoverProvider();
    const document = makeTextDocument('self.delTimer(1)\n', {
      fileName: '/tmp/ws/scripts/base/Avatar.py',
      languageId: 'python'
    });
    const position = new Position(0, 8);
    const first = await provider.provideHover(document, position);
    const firstText = hoverText(first);
    const second = await provider.provideHover(document, position);
    const secondText = hoverText(second);
    expect((firstText.match(/Behavior note:/g) ?? []).length).toBe(1);
    expect(secondText).toBe(firstText);
    // 缓存实例未被第二次请求污染(重建而非 append)
    expect(hoverText(first)).toBe(firstText);
  });

  it('hover.behaviorNotes=false → 行为注记面整体让位', async () => {
    const provider = new KBEngineHoverProvider();
    const text = 'self.delTimer(self.tid)\n';
    configurationOverrides.set('kbengine', { 'hover.behaviorNotes': false });
    try {
      const note = await pythonHover(provider, text, 0, 8);
      expect(note).not.toContain('行为注记');
    } finally {
      configurationOverrides.delete('kbengine');
    }
  });

  it('非 python 文档不挂注记(def 面 python-only gate)', async () => {
    const provider = new KBEngineHoverProvider();
    const document = makeTextDocument('<root>\n</root>\n', {
      fileName: '/tmp/ws/scripts/entity_defs/Avatar.def'
    });
    const hover = await provider.provideHover(document, new Position(0, 2));
    expect(hoverText(hover)).not.toContain('行为注记');
  });

  it('无条目词(self/id 等泛词)零追加', async () => {
    const provider = new KBEngineHoverProvider();
    const text = 'value = self.hp + self.id\n';
    const plain = await pythonHover(provider, text, 0, 12);
    expect(plain).not.toContain('行为注记');
  });
});

/** def 属性定位替身:指定 typeName 的根属性(与 resolvePropertyDefinitionInfo 同形) */
const stubManagerWith = (typeName: string | null): EntityMappingManager =>
  ({
    resolvePropertyDefinitionInfo: async () => ({
      defFile: '/tmp/ws/scripts/entity_defs/Avatar.def',
      line: 3,
      typeName,
      defaultValue: undefined,
      domains: [],
      persistent: false,
      identity: {
        ownerKind: 'entity',
        ownerName: 'Avatar',
        sourceKind: 'local',
        sourceChain: [],
        symbolName: 'equip'
      }
    })
  }) as unknown as EntityMappingManager;

describe('C-23 悬停行为注记:FIXED_DICT 属性面(wiring)', () => {
  it('FIXED_DICT 属性类型 hover 尾部挂子键不同步注记', async () => {
    const provider = new KBEngineHoverProvider(stubManagerWith(FIXED_DICT_TYPE_NAME));
    const text = 'value = self.equip\n';
    const note = await pythonHover(provider, text, 0, 14);
    // 类型注解本体仍在(def 属性声明类型)
    expect(note.length).toBeGreaterThan(0);
    expect(note).toContain('行为注记');
    expect(note).toContain('Behavior note');
    expect(note).toContain('FIXED_DICT');
  });

  it('非 FIXED_DICT 声明类型不挂该注记', async () => {
    const provider = new KBEngineHoverProvider(stubManagerWith('ARRAY'));
    const text = 'value = self.equip\n';
    const note = await pythonHover(provider, text, 0, 14);
    expect(note).not.toContain('FIXED_DICT 子键');
  });
});

const PY_TEXT = [
  'class Avatar(object):',
  '    def update(self):',
  "        self.equip['slot'] = 1",
  ''
].join('\n');

const pyDocument = (): MinimalTextDocument =>
  makeTextDocument(PY_TEXT, { fileName: '/tmp/ws/scripts/base/Avatar.py', languageId: 'python' });

const fixedDictDiagnostic = (line = 2): Diagnostic => {
  const diagnostic = new Diagnostic(
    new Range(new Position(line, 8), new Position(line, 19)),
    'FIXED_DICT 属性子键赋值不同步(整体重赋习语)',
    DiagnosticSeverity.Warning
  );
  diagnostic.code = FIXED_DICT_NESTED_MUTATION_CODE;
  return diagnostic;
};

describe('C-23 整体重赋快速修复 provider(wiring)', () => {
  const provider = new KBEngineFixedDictWholeReassignCodeActionProvider();

  it('fixedDictNestedMutation 诊断 → 整体重赋编辑(三行习语,缩进保持)', () => {
    const document = pyDocument();
    const diagnostic = fixedDictDiagnostic();
    const actions = provider.provideCodeActions(document, diagnostic.range, {
      diagnostics: [diagnostic]
    }) as Array<{ title: string; kind: string; edit?: { get(uri: unknown): Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }> } }>;
    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action.kind).toBe(CodeActionKind.QuickFix);
    expect(action.title).toContain('FIXED_DICT');
    const edit = action.edit!.get(document.uri)[0];
    expect(edit.range.start).toEqual({ line: 2, character: 0 });
    expect(edit.range.end).toEqual({ line: 3, character: 0 });
    expect(edit.newText.split('\n')).toEqual([
      '        _fd = self.equip',
      "        _fd['slot'] = 1",
      '        self.equip = _fd',
      // 行 3 之后仍有内容(文档末尾哨兵空行)→ 替换文本带行尾换行
      ''
    ]);
  });

  it('非本码诊断/行形态不匹配/同行重复诊断:不出候选或去重', () => {
    const document = pyDocument();
    // 非 code 对账:receiverNone 诊断不出
    const other = new Diagnostic(
      new Range(new Position(2, 8), new Position(2, 19)),
      'receiver none',
      DiagnosticSeverity.Warning
    );
    other.code = 'kbengine.receiverNone';
    expect(provider.provideCodeActions(document, other.range, { diagnostics: [other] })).toHaveLength(0);
    // 光标不在诊断范围内:不出
    const away = fixedDictDiagnostic();
    expect(provider.provideCodeActions(document, new Range(0, 0, 0, 1), { diagnostics: [away] })).toHaveLength(0);
    // 同行两条重复诊断:去重为一条
    const dupA = fixedDictDiagnostic();
    const dupB = fixedDictDiagnostic();
    const dedup = provider.provideCodeActions(document, dupA.range, { diagnostics: [dupA, dupB] });
    expect(dedup).toHaveLength(1);
  });
});
