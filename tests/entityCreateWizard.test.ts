import { describe, expect, it } from 'vitest';
import {
  buildComponentDefContent,
  buildComponentSlotInsertion,
  buildRpcMethodDefInsertion,
  buildRpcMethodPythonInsertion,
  buildTypeAliasInsertion
} from '../src/backend/entityCreateWizard';

// RUST-179 创建向导纯核钉:插入点=关闭标签行首(吃缩进即整档漂移)、
// 冲突一律拒绝(方法名跨三段唯一/同名槽/同名别名)、缺段整体创建、
// py 侧 offset 对 \n 与 \r\n 都精确、模块级代码不得吞进类体。

const defWithSections = [
  '<root>',
  '\t<Properties>',
  '\t\t<level> UINT32 </level>',
  '\t</Properties>',
  '\t<BaseMethods>',
  '\t\t<reqCastSkill>',
  '\t\t\t<Exposed> true </Exposed>',
  '\t\t\t<Arg> UINT32 </Arg>',
  '\t\t</reqCastSkill>',
  '\t</BaseMethods>',
  '\t<CellMethods>',
  '\t</CellMethods>',
  '</root>'
].join('\n');

describe('buildRpcMethodDefInsertion', () => {
  it('existing section: inserts at close-tag line start with member indent', () => {
    const result = buildRpcMethodDefInsertion(defWithSections, 'BaseMethods', 'onOpenBag', [], false);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.createdSection).toBe(false);
    expect(result.name).toBe('onOpenBag');
    // 关闭标签行首('\t</BaseMethods>' 的 '\t' 处),不是 closeTagStart 的 '<' 处
    expect(result.insertion.offset).toBe(defWithSections.indexOf('\t</BaseMethods>'));
    const updated =
      defWithSections.slice(0, result.insertion.offset) +
      result.insertion.text +
      defWithSections.slice(result.insertion.offset);
    expect(updated).toContain('\t\t<onOpenBag>\n\t\t</onOpenBag>');
    // 无 Exposed 行(非暴露)
    expect(updated).not.toContain('<onOpenBag>\n\t\t\t<Exposed>');
    // 原关闭标签缩进保持一行两 tab
    expect(updated).toContain('\t\t</onOpenBag>\n\t</BaseMethods>');
  });

  it('exposed method emits Exposed line and Arg lines in order', () => {
    const result = buildRpcMethodDefInsertion(defWithSections, 'CellMethods', 'castSkillBurst', ['UINT32', 'STRING'], true);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const text = result.insertion.text;
    expect(text.indexOf('<Exposed>')).toBeGreaterThan(text.indexOf('<castSkillBurst>'));
    expect(text.indexOf('<Arg> UINT32 </Arg>')).toBeGreaterThan(text.indexOf('<Exposed>'));
    expect(text.indexOf('<Arg> STRING </Arg>')).toBeGreaterThan(text.indexOf('<Arg> UINT32 </Arg>'));
    expect(result.insertion.offset).toBe(defWithSections.indexOf('\t</CellMethods>'));
  });

  it('missing section: creates whole section block before root close tag', () => {
    const result = buildRpcMethodDefInsertion(defWithSections, 'ClientMethods', 'showToast', ['STRING'], true);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.createdSection).toBe(true);
    expect(result.insertion.offset).toBe(defWithSections.indexOf('</root>'));
    const updated = defWithSections.slice(0, result.insertion.offset) + result.insertion.text + defWithSections.slice(result.insertion.offset);
    expect(updated).toContain('\t<ClientMethods>\n\t\t<showToast>');
    expect(updated).toContain('\t\t</showToast>\n\t</ClientMethods>\n</root>');
  });

  it('rejects duplicate method name with owning section reported across all three sections', () => {
    const inBase = buildRpcMethodDefInsertion(defWithSections, 'BaseMethods', 'reqCastSkill', [], false);
    expect(inBase.ok).toBe(false);
    if (!inBase.ok) {
      expect(inBase.reason).toBe('method-exists');
      expect(inBase.section).toBe('BaseMethods');
    }
    const crossSection = buildRpcMethodDefInsertion(defWithSections, 'CellMethods', 'reqCastSkill', [], false);
    expect(crossSection.ok).toBe(false);
    if (!crossSection.ok) {
      expect(crossSection.section).toBe('BaseMethods');
    }
  });

  it('rejects malformed def instead of guessing an offset', () => {
    const broken = buildRpcMethodDefInsertion('<root>\t<BaseMethods>', 'BaseMethods', 'm', [], false);
    expect(broken.ok).toBe(false);
  });
});

describe('buildComponentSlotInsertion', () => {
  const hostWithComponents = [
    '<root>',
    '\t<Properties>',
    '\t</Properties>',
    '\t<Components>',
    '\t\t<bag>',
    '\t\t\t<Type> Inventory </Type>',
    '\t\t\t<Persistent> true </Persistent>',
    '\t\t</bag>',
    '\t</Components>',
    '</root>'
  ].join('\n');

  it('existing Components section: appends slot at close-tag line start', () => {
    const result = buildComponentSlotInsertion(hostWithComponents, 'wallet', 'Wallet', true);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.createdSection).toBe(false);
    expect(result.insertion.offset).toBe(hostWithComponents.indexOf('\t</Components>'));
    const updated = hostWithComponents.slice(0, result.insertion.offset) + result.insertion.text + hostWithComponents.slice(result.insertion.offset);
    expect(updated).toContain('\t\t<wallet>\n\t\t\t<Type> Wallet </Type>\n\t\t\t<Persistent> true </Persistent>\n\t\t</wallet>');
    expect(updated).toContain('\t\t</wallet>\n\t</Components>');
  });

  it('persistent=false omits the Persistent line', () => {
    const result = buildComponentSlotInsertion(hostWithComponents, 'wallet', 'Wallet', false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.insertion.text).not.toContain('Persistent');
    }
  });

  it('missing Components section: creates section before root close tag', () => {
    const result = buildComponentSlotInsertion(defWithSections, 'bag', 'Inventory', true);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.createdSection).toBe(true);
    expect(result.insertion.offset).toBe(defWithSections.indexOf('</root>'));
    expect(result.insertion.text).toContain('\t<Components>\n\t\t<bag>');
    expect(result.insertion.text.endsWith('\t</Components>\n')).toBe(true);
  });

  it('rejects duplicate slot name in the same section', () => {
    const result = buildComponentSlotInsertion(hostWithComponents, 'bag', 'Other', true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('slot-exists');
    }
  });
});

describe('buildTypeAliasInsertion', () => {
  const typesXml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Type>',
    '\t<ITEM_ID> UINT16 </ITEM_ID>',
    '\t<ITEM_COUNT> UINT32 </ITEM_COUNT>',
    '</Type>'
  ].join('\n');

  it('appends single-line alias with inherited entry indent at close-tag line start', () => {
    const result = buildTypeAliasInsertion(typesXml, 'GOLD', 'UINT32');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.insertion.offset).toBe(typesXml.indexOf('</Type>'));
    expect(result.insertion.text).toBe('\t<GOLD> UINT32 </GOLD>\n');
  });

  it('rejects duplicate alias name', () => {
    const result = buildTypeAliasInsertion(typesXml, 'ITEM_ID', 'UINT32');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('alias-exists');
    }
  });

  it('empty table falls back to single tab indent', () => {
    const empty = '<Type>\n</Type>';
    const result = buildTypeAliasInsertion(empty, 'GOLD', 'UINT32');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.insertion.text).toBe('\t<GOLD> UINT32 </GOLD>\n');
      expect(result.insertion.offset).toBe(empty.indexOf('</Type>'));
    }
  });
});

describe('buildRpcMethodPythonInsertion', () => {
  const pyBody = [
    'import KBEngine',
    '',
    '',
    'class Avatar(KBEngine.Proxy):',
    '\tdef __init__(self):',
    '\t\tpass',
    '',
    '\tdef onEnterZone(self, arg1):',
    '\t\tpass',
    ''
  ].join('\n');

  it('appends method skeleton at class body end (trailing blank lines skipped)', () => {
    const result = buildRpcMethodPythonInsertion(pyBody, '/ws/scripts/base/Avatar.py', 'onOpenBag', []);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.className).toBe('Avatar');
    // 类体最后一行是 onEnterZone 的 pass(末尾空行是文件级,不入类体)
    expect(result.insertion.offset).toBe(pyBody.indexOf('\t\tpass\n', pyBody.indexOf('onEnterZone')) + '\t\tpass\n'.length);
    const updated = pyBody.slice(0, result.insertion.offset) + result.insertion.text + pyBody.slice(result.insertion.offset);
    expect(updated).toContain('\t\tpass\n\n\tdef onOpenBag(self):\n\t\t"KBEngine method."\n\t\tpass\n');
    expect(updated.indexOf('def onOpenBag')).toBeGreaterThan(updated.indexOf('def onEnterZone'));
  });

  it('maps args to arg1..argN in the signature', () => {
    const result = buildRpcMethodPythonInsertion(pyBody, '/ws/scripts/cell/Avatar.py', 'reqCastSkill', ['UINT32', 'STRING']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.insertion.text).toContain('def reqCastSkill(self, arg1, arg2):');
    }
  });

  it('crlf files: offset lands after the last body line including \\r', () => {
    const crlf = 'class Hero:\r\n\tpass\r\n';
    const result = buildRpcMethodPythonInsertion(crlf, '/ws/scripts/base/Hero.py', 'onOpenBag', []);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.insertion.offset).toBe(crlf.length);
  });

  it('module-level code after the class is never swallowed into the body', () => {
    const mixed = ['class A:', '\tpass', '', 'X = 1'].join('\n');
    const result = buildRpcMethodPythonInsertion(mixed, '/ws/scripts/base/A.py', 'onOpenBag', []);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const updated = mixed.slice(0, result.insertion.offset) + result.insertion.text + mixed.slice(result.insertion.offset);
    // def 落在类体内(pass 之后),X = 1 仍独立成模块级
    expect(updated).toContain('\tpass\n\n\tdef onOpenBag(self):');
    expect(updated.endsWith('\nX = 1')).toBe(true);
  });

  it('rejects duplicate method and class-less files', () => {
    const dup = buildRpcMethodPythonInsertion(pyBody, '/ws/scripts/base/Avatar.py', 'onEnterZone', []);
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.reason).toBe('method-exists');
    }
    const noClass = buildRpcMethodPythonInsertion('x = 1\n', '/ws/scripts/base/x.py', 'onOpenBag', []);
    expect(noClass.ok).toBe(false);
    if (!noClass.ok) {
      expect(noClass.reason).toBe('no-class');
    }
  });
});

describe('buildComponentDefContent', () => {
  it('skeleton mirrors real component def shape', () => {
    const content = buildComponentDefContent('Inventory');
    expect(content).toContain('<root>');
    expect(content).toContain('\t<Properties>');
    expect(content.trimEnd().endsWith('</root>')).toBe(true);
  });
});

// COV 批 7:残缺文本与紧凑形态的插入边界。本文件余下不可达行的逐行
// 论证(全部走公开入口 + 残缺语料实测排查,均无触发路径,不写凑数测试):
// - closeInsertionOffset 的 closeTagStart<0 守卫与四个 offset===null 拒绝臂
//   (方法段/缺段根/组件段/缺段根/别名根):defParser 对成功解析的文档,
//   closeTagStart 只会来自 openToken.end(自闭合)或 closeToken.start
//   (普通),token 偏移恒 ≥0;截断/残缺形态(无闭标签、悬空闭标签、
//   重复嵌套同名)在 assignNodePositions 的 consumeNextToken 处直接抛错,
//   parseDefOrUndefined 归一为 undefined,走的是各入口的 !document ||
//   !document.root 拒绝臂(已有测试覆盖),closeInsertionOffset 根本
//   不会被调到。自闭合根 `<root/>` 实测 closeTagStart=7 ≥0。
// - buildRpcMethodPythonInsertion 的 parse-failed 臂:pythonParser 全文
//   无 throw 点(词法残缺如实产空 classes → no-class 拒绝,已有测试),
//   parsePythonFile 不会抛错,catch 臂不可达。
describe('残缺文本与紧凑形态的插入边界(拒绝计算/缩进回退)', () => {
  it('段首子元素缺行首缩进前缀:成员缩进回退段默认缩进,不硬凑', () => {
    // 子元素顶格(行首前缀为空)与段开标签同行(前缀非纯缩进)两种形态,
    // 都取不到既有缩进 → 回退 '\t\t',插入点仍在段关闭标签行首
    const column0 = ['<root>', '<BaseMethods>', '<m>', '</m>', '</BaseMethods>', '</root>'].join('\n');
    const r0 = buildRpcMethodDefInsertion(column0, 'BaseMethods', 'n', [], false);
    expect(r0.ok).toBe(true);
    if (!r0.ok) {
      return;
    }
    expect(r0.insertion.text).toBe('\t\t<n>\n\t\t</n>\n');
    expect(r0.insertion.offset).toBe(column0.indexOf('</BaseMethods>'));

    const sameLine = '<root>\n\t<BaseMethods><m></m>\n\t</BaseMethods>\n</root>';
    const r1 = buildRpcMethodDefInsertion(sameLine, 'BaseMethods', 'n', [], false);
    expect(r1.ok).toBe(true);
    if (!r1.ok) {
      return;
    }
    expect(r1.insertion.text).toBe('\t\t<n>\n\t\t</n>\n');
    expect(r1.insertion.offset).toBe(sameLine.indexOf('\t</BaseMethods>'));
  });

  it('根/段解析失败(残缺文本):槽与别名插入同口径拒绝,不硬插', () => {
    const slot = buildComponentSlotInsertion('', 'wallet', 'Wallet', true);
    expect(slot.ok).toBe(false);
    if (!slot.ok) {
      expect(slot.reason).toBe('parse-failed');
    }
    const truncated = buildComponentSlotInsertion('<root>\n\t<Properties>\n', 'wallet', 'Wallet', true);
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) {
      expect(truncated.reason).toBe('parse-failed');
    }

    const alias = buildTypeAliasInsertion('not xml at all', 'GOLD', 'UINT32');
    expect(alias.ok).toBe(false);
    if (!alias.ok) {
      expect(alias.reason).toBe('parse-failed');
    }
    const aliasTruncated = buildTypeAliasInsertion('<Type>\n\t<ITEM_ID>', 'GOLD', 'UINT32');
    expect(aliasTruncated.ok).toBe(false);
    if (!aliasTruncated.ok) {
      expect(aliasTruncated.reason).toBe('parse-failed');
    }
  });
});
