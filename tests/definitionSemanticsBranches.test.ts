import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDefinitionSemanticsLoader,
  parseLocalDefinition
} from '../src/definitionSemantics';

// definitionSemantics 批66 分支补测:生效合并在去重映射上的"已存在即跳过"
// 假臂——本地属性/方法重复(解析不去重 ⇒ 映射内撞 fullPath/方法名)、
// 接口与父链的同名成员让位于实体自有成员;以及无 <Type> 子元素的属性
// (typeNode 为 null 的 `: undefined` 假臂)。同文件 <Type> 缺席使
// arrayOfType 恒真 ⇒ 其内层 typeNode 重检不可达,已以单行 ignore 定案,
// 见源码注记与 TESTING.md 批66 段。

const write = (root: string, relative: string, content: string): void => {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
};

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sem-branch-'));

  // 本地重复:同名属性/方法在解析产物中各出现两次,loadResolved 的生效映射
  // 合并循环命中 has() 真臂(第二条被跳过)
  write(root, 'scripts/entity_defs/DupLocal.def', [
    '<root>',
    '  <Properties>',
    '    <hp><Type>UINT8</Type></hp>',
    '    <hp><Type>UINT16</Type></hp>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <ping/>',
    '    <ping/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));

  // 接口同名让位:实体自有 BaseMethods.shared,IMix 也声明 shared 与 onlyI
  write(root, 'scripts/entity_defs/interfaces/IMix.def', [
    '<root>',
    '  <BaseMethods>',
    '    <shared/>',
    '    <onlyI/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));
  write(root, 'scripts/entity_defs/IfaceDup.def', [
    '<root>',
    '  <Interfaces><IMix/></Interfaces>',
    '  <BaseMethods><shared/></BaseMethods>',
    '</root>'
  ].join('\n'));

  // 父链同名让位:实体自有 hp/ping,Par2 也声明 hp/pp 与 ping/other
  write(root, 'scripts/entity_defs/Par2.def', [
    '<root>',
    '  <Properties>',
    '    <hp><Type>UINT16</Type></hp>',
    '    <pp><Type>UINT8</Type></pp>',
    '  </Properties>',
    '  <BaseMethods>',
    '    <ping/>',
    '    <other/>',
    '  </BaseMethods>',
    '</root>'
  ].join('\n'));
  write(root, 'scripts/entity_defs/ParentDup.def', [
    '<root>',
    '  <Parent>Par2</Parent>',
    '  <Properties><hp><Type>UINT8</Type></hp></Properties>',
    '  <BaseMethods><ping/></BaseMethods>',
    '</root>'
  ].join('\n'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('local duplicate members collapse onto the first entry', () => {
  const semantics = () => parseLocalDefinition(
    [
      '<root>',
      '  <Properties>',
      '    <hp><Type>UINT8</Type></hp>',
      '    <hp><Type>UINT16</Type></hp>',
      '  </Properties>',
      '  <BaseMethods>',
      '    <ping/>',
      '    <ping/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'),
    'entity',
    'DupLocal',
    '/tmp/DupLocal.def'
  );

  it('keeps the first declaration for duplicated properties', () => {
    // 解析不去重:两条 <hp> 都进 properties,合并映射以 fullPath 撞真臂
    expect(semantics().properties.map(p => p.fullPath)).toEqual(['hp', 'hp']);
    expect(semantics().properties[1].typeName).toBe('UINT16');
  });

  it('keeps the first declaration for duplicated methods', () => {
    expect(semantics().methodsBySection.BaseMethods.map(m => m.name)).toEqual(['ping', 'ping']);
  });
});

describe('resolved merges skip already-claimed members', () => {
  let loader: NonNullable<ReturnType<typeof createDefinitionSemanticsLoader>>;

  beforeAll(() => {
    loader = createDefinitionSemanticsLoader(root)!;
  });

  it('collapses locally duplicated properties and methods onto the first entry', () => {
    const resolved = loader.loadResolved('DupLocal', 'entity')!;

    // 第二条 hp/ping 撞本地合并循环的 has() 真臂被跳过,首条保留
    expect(resolved.effectiveProperties.map(p => p.fullPath)).toEqual(['hp']);
    expect(resolved.effectiveProperties[0].typeName).toBe('UINT8');
    expect(resolved.effectiveMethodsBySection.BaseMethods.map(m => m.name)).toEqual(['ping']);
  });

  it('lets local BaseMethods win over same-name interface methods', () => {
    const resolved = loader.loadResolved('IfaceDup', 'entity')!;

    // 自有 shared 先占位,接口的 shared 撞 has() 真臂被跳过,onlyI 照常并入
    expect(resolved.effectiveMethodsBySection.BaseMethods.map(m => m.name))
      .toEqual(['shared', 'onlyI']);
  });

  it('lets own properties and methods win over same-name parent members', () => {
    const resolved = loader.loadResolved('ParentDup', 'entity')!;

    // 自有 hp(UINT8)先占位,父链 hp 撞属性 has() 真臂;父链 pp 照常并入
    expect(resolved.effectiveProperties.map(p => p.fullPath)).toEqual(['hp', 'pp']);
    expect(resolved.effectiveProperties.find(p => p.fullPath === 'hp')?.typeName).toBe('UINT8');

    // 自有 ping 先占位,父链 ping 撞方法 has() 真臂;父链 other 照常并入
    expect(resolved.effectiveMethodsBySection.BaseMethods.map(m => m.name))
      .toEqual(['ping', 'other']);
  });
});

describe('property without a Type child', () => {
  it('parses with undefined typeName and no array element', () => {
    const semantics = parseLocalDefinition(
      [
        '<root>',
        '  <Properties>',
        '    <bare/>',
        '  </Properties>',
        '</root>'
      ].join('\n'),
      'entity',
      'NoType',
      '/tmp/NoType.def'
    );

    // typeNode 为 null ⇒ typeName/arrayElement 均走 undefined 假臂
    expect(semantics.properties).toHaveLength(1);
    expect(semantics.properties[0].name).toBe('bare');
    expect(semantics.properties[0].typeName).toBeUndefined();
    expect(semantics.properties[0].arrayElement).toBeUndefined();
  });
});
