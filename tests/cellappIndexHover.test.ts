import { describe, expect, it } from 'vitest';
import { KBEngineHoverProvider } from '../src/languageProviders';
import { Hover, Position, makeTextDocument } from './helpers/vscodeStub';

// SP-5: createCellEntityInNewSpace 的 cellappIndex 参数语义 hover。
// 口径=docs/zh/api/kbengine/baseapp/Entity.md:144 +
// cellappmgr.cpp:348-351((index-1)%size 取模轮转) + entity.cpp:1487。
// 验收:cellappIndex 参数处 hover 含 0=自动均衡/N=取模轮转语义与示例。

const hoverOn = (text: string, line: number, character: number, fileName?: string): string => {
  const provider = new KBEngineHoverProvider();
  const document = makeTextDocument(text, {
    fileName: fileName ?? '/ws/scripts/base/Avatar.py',
    languageId: 'python'
  });
  const hover = provider.provideHover(document, new Position(line, character)) as Hover | null;
  if (!hover) {
    return '';
  }
  const contents = hover.contents;
  return Array.isArray(contents)
    ? contents.map(item => (typeof item === 'string' ? item : item.value)).join('')
    : typeof contents === 'string'
      ? contents
      : contents.value;
};

describe('cellappIndex semantic hover (SP-5)', () => {
  it('documents auto-balance vs modulo semantics on the parameter', () => {
    const text = 'self.createCellEntityInNewSpace(cellappIndex)\n';
    const doc = hoverOn(text, 0, 34);
    expect(doc).toContain('cellappIndex');
    // 0/None = 负载均衡自动选
    expect(doc).toMatch(/0.*None.*均衡|均衡.*0.*None/);
    // N>0 = 取模轮转
    expect(doc).toMatch(/取模|轮转|%\s*cellappSize|\(N\s*-\s*1\)/);
  });

  it('shows usage example combining load-balancing flags', () => {
    const text = 'self.createCellEntityInNewSpace(cellappIndex)\n';
    const doc = hoverOn(text, 0, 34);
    expect(doc).toMatch(/NOT_PARTCIPATING_LOAD_BALANCING|不参与负载均衡/);
    expect(doc).toMatch(/```python[\s\S]*createCellEntityInNewSpace/);
  });

  it('documents the method name itself with the same semantics', () => {
    const text = 'self.createCellEntityInNewSpace(2)\n';
    // 光标落在方法名中部(createCellEntityInNewSpace 起于 5,取中点)
    const doc = hoverOn(text, 0, 18);
    expect(doc).toContain('createCellEntityInNewSpace');
    expect(doc).toMatch(/取模|轮转/);
  });

  it('works on the def declaration parameter too', () => {
    const text = [
      '<root>',
      '  <BaseMethods>',
      '    <createCellEntityInNewSpace>',
      '      <Arg>cellappIndex</Arg>',
      '    </createCellEntityInNewSpace>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n');
    // 光标在第 3 行 Arg 行的 cellappIndex 上
    const doc = hoverOn(text, 3, 20, '/ws/scripts/entity_defs/Avatar.def');
    expect(doc).toContain('cellappIndex');
    expect(doc).toMatch(/取模|轮转/);
  });

  it('does not hijack hover for unrelated identifiers', () => {
    const text = 'someOtherParam = 1\n';
    expect(hoverOn(text, 0, 6)).not.toContain('取模');
  });
});
