import type { DefinitionSymbolIdentity } from '../src/entityMapping';
import { describe, expect, it } from 'vitest';
import {
  buildMethodOwnerBindingKey,
  escapeRegExp,
  getColumnNumber,
  getLineNumber,
  inferMethodSectionFromPythonFile,
  inferOwnerKindFromPythonFile,
  parsePythonMethodBlocks,
  sameIdentity,
  uniqueFilePaths
} from '../src/entityMapping';

// entityMapping 底部的模块级纯函数池:路径/身份/正则/行号/Python 方法块解析。
// EntityMappingManager 类本体依赖 vscode(ExtensionContext/FileSystemWatcher),
// 由 mocha + @vscode/test-electron 侧覆盖,这里只测可独立求值的纯函数。

const identity = (overrides: Partial<DefinitionSymbolIdentity> = {}): DefinitionSymbolIdentity => ({
  ownerKind: 'entity',
  ownerName: 'Hero',
  sourceKind: 'local',
  sourceChain: ['Hero'],
  symbolName: 'onDie',
  ...overrides
});

describe('buildMethodOwnerBindingKey', () => {
  it('lowercases and joins identity fields with ::', () => {
    expect(buildMethodOwnerBindingKey({
      ownerKind: 'entity',
      ownerName: 'Hero',
      section: 'BaseMethods',
      symbolName: 'onDie'
    })).toBe('entity::hero::basemethods::ondie');
  });

  it('uses an empty segment when the section is absent', () => {
    expect(buildMethodOwnerBindingKey({
      ownerKind: 'interface',
      ownerName: 'MoveIface',
      symbolName: 'dash'
    })).toBe('interface::moveiface::::dash');
  });
});

describe('sameIdentity', () => {
  it('requires every structural field to match', () => {
    const base = identity();
    expect(sameIdentity(base, identity())).toBe(true);

    expect(sameIdentity(base, identity({ ownerKind: 'interface' }))).toBe(false);
    expect(sameIdentity(base, identity({ ownerName: 'Monster' }))).toBe(false);
    expect(sameIdentity(base, identity({ sourceKind: 'interface' }))).toBe(false);
    expect(sameIdentity(base, identity({ section: 'CellMethods' }))).toBe(false);
    expect(sameIdentity(base, identity({ symbolName: 'onSpawn' }))).toBe(false);
    expect(sameIdentity(base, identity({ componentSlotName: 'healthPack' }))).toBe(false);
  });

  it('normalizes propertyPath whitespace and case', () => {
    expect(sameIdentity(
      identity({ propertyPath: 'Hero.hp' }),
      identity({ propertyPath: '  hero.HP ' })
    )).toBe(true);

    // 归一后仍不同的路径必须判异
    expect(sameIdentity(
      identity({ propertyPath: 'hp' }),
      identity({ propertyPath: 'hp2' })
    )).toBe(false);

    // undefined 与空串等价(都归一为 '')
    expect(sameIdentity(
      identity({ propertyPath: undefined }),
      identity({ propertyPath: '' })
    )).toBe(true);
  });

  it('compares sourceChain case-insensitively', () => {
    expect(sameIdentity(
      identity({ sourceChain: ['MoveIface', 'Base'] }),
      identity({ sourceChain: ['moveiface', 'base'] })
    )).toBe(true);

    expect(sameIdentity(
      identity({ sourceChain: ['MoveIface'] }),
      identity({ sourceChain: ['MoveIface', 'Base'] })
    )).toBe(false);
  });
});

describe('inferOwnerKindFromPythonFile', () => {
  it('routes components, interfaces and entities by directory', () => {
    expect(inferOwnerKindFromPythonFile('/proj/scripts/entity_defs/components/HealthComp.py')).toBe('component');
    expect(inferOwnerKindFromPythonFile('/proj/scripts/entity_defs/interfaces/MoveIface.py')).toBe('interface');
    expect(inferOwnerKindFromPythonFile('/proj/scripts/entity/Hero.py')).toBe('entity');
  });

  it('normalizes separators and case before routing', () => {
    expect(inferOwnerKindFromPythonFile('C:\\Proj\\scripts\\Entity_defs\\COMPONENTS\\HealthComp.PY')).toBe('component');
    expect(inferOwnerKindFromPythonFile('..\\Scripts\\INTERFACES\\MoveIface.py')).toBe('interface');
  });

  it('returns undefined for non-python files', () => {
    expect(inferOwnerKindFromPythonFile('/proj/scripts/entity/Hero.txt')).toBeUndefined();
  });
});

describe('inferMethodSectionFromPythonFile', () => {
  it('maps base/cell/client script directories to sections', () => {
    expect(inferMethodSectionFromPythonFile('/proj/scripts/base/Hero.py')).toBe('BaseMethods');
    expect(inferMethodSectionFromPythonFile('/proj/scripts/cell/Hero.py')).toBe('CellMethods');
    expect(inferMethodSectionFromPythonFile('/proj/scripts/client/Hero.py')).toBe('ClientMethods');
  });

  it('also accepts the assets-prefixed layout and windows separators', () => {
    expect(inferMethodSectionFromPythonFile('/proj/assets/scripts/cell/Hero.py')).toBe('CellMethods');
    expect(inferMethodSectionFromPythonFile('C:\\proj\\scripts\\base\\Hero.py')).toBe('BaseMethods');
  });

  it('returns undefined outside method directories', () => {
    expect(inferMethodSectionFromPythonFile('/proj/scripts/entity/Hero.py')).toBeUndefined();
    expect(inferMethodSectionFromPythonFile('/proj/scripts/Hero.py')).toBeUndefined();
  });
});

describe('uniqueFilePaths', () => {
  it('dedupes by normalized path while keeping the first spelling', () => {
    expect(uniqueFilePaths([
      '/work/Hero.py',
      '/WORK/hero.PY',
      '/work/Hero.py'
    ])).toEqual(['/work/Hero.py']);
  });

  it('treats windows separators as equivalent', () => {
    expect(uniqueFilePaths([
      'C:\\Work\\Hero.py',
      'c:/work/Hero.py',
      'C:/Work/Other.py'
    ])).toEqual(['C:\\Work\\Hero.py', 'C:/Work/Other.py']);
  });
});

describe('escapeRegExp', () => {
  it('escapes every regex metacharacter', () => {
    expect(escapeRegExp('a.b*c(d)e[f]g$h%i?j:k{l}m|n^o\\p')).toBe(
      'a\\.b\\*c\\(d\\)e\\[f\\]g\\$h%i\\?j:k\\{l\\}m\\|n\\^o\\\\p'
    );
  });

  it('produces a literal-matching pattern', () => {
    const pattern = new RegExp(escapeRegExp('a.b+c'));
    expect(pattern.test('xa.b+cy')).toBe(true);
    expect(pattern.test('xa b cy')).toBe(false);
  });
});

describe('getLineNumber and getColumnNumber', () => {
  const text = 'a\nb\ncd'; // 行号 1/2/3,行内列 0 基

  it('computes 1-based line numbers from an offset', () => {
    expect(getLineNumber(text, 0)).toBe(1);
    expect(getLineNumber(text, 2)).toBe(2);
    // 换行符本身仍归属当前行(index 3 是第二个 \n,行号 2)
    expect(getLineNumber(text, 3)).toBe(2);
    expect(getLineNumber(text, 4)).toBe(3);
  });

  it('computes 0-based columns relative to the line start', () => {
    expect(getColumnNumber(text, 0)).toBe(0);
    expect(getColumnNumber(text, 2)).toBe(0);
    // 第三行 'cd':c 为列 0,d 为列 1
    expect(getColumnNumber(text, 4)).toBe(0);
    expect(getColumnNumber(text, 5)).toBe(1);
  });
});

describe('parsePythonMethodBlocks', () => {
  const content = [
    'class Hero:',
    '    def onDeath(self, victimID):',
    '        self.notifyDeath(victimID)',
    '        pass',
    '',
    '    async def onEnterWorld(self, data):',
    '        self.loadEquip()'
  ].join('\n');

  it('indexes def blocks with line/character and ends at the next sibling', () => {
    const blocks = parsePythonMethodBlocks(content, '/scripts/entity/Hero.py');

    expect(blocks).toHaveLength(2);

    // line 为 1 基;endLine 沿用实现的 0 基"下一非空同级行"语义(下一方法行 index 5)
    expect(blocks[0]).toMatchObject({
      filePath: '/scripts/entity/Hero.py',
      methodName: 'onDeath',
      line: 2,
      character: 8,
      endLine: 5
    });
    expect(blocks[0].calls).toEqual([
      { methodName: 'notifyDeath', line: 3, character: 13, filePath: '/scripts/entity/Hero.py' }
    ]);

    // async def 同样识别;文件尾无下一行时 endLine 为总行数
    expect(blocks[1]).toMatchObject({
      methodName: 'onEnterWorld',
      line: 6,
      character: 14,
      endLine: 7
    });
    expect(blocks[1].calls).toEqual([
      { methodName: 'loadEquip', line: 7, character: 13, filePath: '/scripts/entity/Hero.py' }
    ]);
  });

  it('tracks self-calls across multiple lines and skips blank lines', () => {
    const nested = [
      'class A:',
      '    def run(self):',
      '        self.stepOne()',
      '',
      '        self.stepTwo()'
    ].join('\n');

    const blocks = parsePythonMethodBlocks(nested, '/a.py');

    expect(blocks).toHaveLength(1);
    expect(blocks[0].calls.map(call => `${call.methodName}@${call.line}`)).toEqual([
      'stepOne@3',
      'stepTwo@5'
    ]);
  });

  it('ignores plain call sites and non-def lines', () => {
    const content2 = [
      'def helper():',
      '    notify()',
      '',
      'x = 1'
    ].join('\n');

    const blocks = parsePythonMethodBlocks(content2, '/b.py');

    expect(blocks).toHaveLength(1);
    expect(blocks[0].methodName).toBe('helper');
    // 无 self. 前缀的调用不算
    expect(blocks[0].calls).toEqual([]);
  });
});
