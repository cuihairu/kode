// KODE-I18N-002 Diagnostics 面:诊断消息文案经共享 l10nText 取词。
// 两态断言:默认(未注入 bundle)= 英文源串(真实 VS Code 英文 locale 同
// 口径);注入 zh-cn bundle = 中文。缺 key 回退由 tests/nlsRuntime.test.ts
// 统一断言。覆盖 8 个诊断模块的 message 构造(文本/纯函数面直接驱动,
// 依赖注入重的 receiverNone/roleMisuse/rpcArgCount/propertyDirection 由
// 既有单测改双态锚 + 契约测试对账键集)。
import { afterEach, describe, expect, it } from 'vitest';
import { setL10nBundle } from './fake-vscode/l10n';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';
import { computeSelfAttributeNoneFindings } from '../src/selfAttributeNoneDiagnostics';
import { findReadOnlyWriteFindings } from '../src/readOnlyWriteDiagnostics';
import { computeSpaceNavFindings } from '../src/spaceNavDiagnostics';
import { findPostDestroyFindings } from '../src/postDestroyDiagnostics';

const zh = zhCnBundle as Record<string, string>;

afterEach(() => {
  setL10nBundle(null);
});

describe('Diagnostics 面运行时文案(两态)', () => {
  it('selfAttributeNone:可能为 None 提示双语', () => {
    const source = [
      'class Foo:',
      '    def __init__(self):',
      '        self.TalentTree = None',
      '    def method(self):',
      '        self.TalentTree.get(0)'
    ].join('\n');
    const en = computeSelfAttributeNoneFindings(source);
    expect(en).toHaveLength(1);
    expect(en[0].message).toContain('may be None');
    setL10nBundle(zh);
    const zhFindings = computeSelfAttributeNoneFindings(source);
    expect(zhFindings[0].message).toContain('可能为 None');
    expect(zhFindings[0].message).toContain('判空');
  });

  it('readOnlyWrite:只读写入提示双语(含写入形态动词)', () => {
    const en = findReadOnlyWriteFindings('self.id = 1\n', 'baseapp');
    expect(en).toHaveLength(1);
    expect(en[0].message).toContain('read-only');
    expect(en[0].message).toContain('plain assignment');
    setL10nBundle(zh);
    const zhFindings = findReadOnlyWriteFindings('self.id = 1\n', 'baseapp');
    expect(zhFindings[0].message).toContain('只读写入');
    expect(zhFindings[0].message).toContain('普通赋值会被引擎拒绝');
  });

  it('spaceNav:_mapping 保留键提示双语', () => {
    const text = 'KBEngine.setSpaceData(spaceID, "_mapping", path)\n';
    const en = computeSpaceNavFindings(text);
    expect(en).toHaveLength(1);
    expect(en[0].message).toContain('reserved key');
    setL10nBundle(zh);
    const zhFindings = computeSpaceNavFindings(text);
    expect(zhFindings[0].message).toContain('保留键');
    expect(zhFindings[0].message).toContain('spacememory.cpp');
  });

  it('postDestroy:销毁后访问提示双语', () => {
    const findings = findPostDestroyFindings(
      'class Avatar:\n  def onRequest(self):\n    self.destroy()\n    self.cell.send()\n',
      'baseapp'
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('after self.destroy()');
    setL10nBundle(zh);
    const zhFindings = findPostDestroyFindings(
      'class Avatar:\n  def onRequest(self):\n    self.destroy()\n    self.cell.send()\n',
      'baseapp'
    );
    expect(zhFindings[0].message).toContain('销毁后实体已失效');
  });
});
