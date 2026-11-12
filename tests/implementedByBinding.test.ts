/**
 * KSEM-STRUCT-06:implementedBy 绑定解析(纯核 + 采集面)。
 * 引擎真形=loadImplModule 恰两段 ImportModule+GetAttrString(class/def/赋值
 * 三形态皆可);真实导入序=包目录胜同名文件(CPython FileFinder,本地实测);
 * 重名(同文件多定义/跨根同模块)、动态返回(调用/属性链/别名目标不可静态
 * 判)、缺实现(模块/符号未找到)一律保留未知。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  parseImplementedBy,
  resolveImplementedByBinding,
  renderImplementedByBindingSection,
  type ImplementedByCandidate
} from '../src/backend/implementedByBinding';
import { implementedByBindingForWorkspace } from '../src/backend/userTypeContractSource';

// ---------------------------------------------------------------------------
// 纯核:parseImplementedBy(引擎两段拆分)
// ---------------------------------------------------------------------------

describe('parseImplementedBy(引擎恰两段)', () => {
  it('两段合法值解析出 module/symbol;首尾空白容忍', () => {
    expect(parseImplementedBy('talent.TalentTreeImpl')).toEqual({ module: 'talent', symbol: 'TalentTreeImpl' });
    expect(parseImplementedBy('  talent.TalentTreeImpl \n')).toEqual({ module: 'talent', symbol: 'TalentTreeImpl' });
  });

  it('非两段一律 null(引擎装载即报错形态)', () => {
    expect(parseImplementedBy('OnlySymbol')).toBeNull();
    expect(parseImplementedBy('a.b.c')).toBeNull();
    expect(parseImplementedBy('a.b.')).toBeNull();
    expect(parseImplementedBy('.doll')).toBeNull();
    expect(parseImplementedBy('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 纯核:resolveImplementedByBinding(绑定裁定)
// ---------------------------------------------------------------------------

const CLASS_IMPL = [
  'class TalentTreeImpl:',
  '    def createObjFromDict(self, dictData):',
  '        return dictData',
  '    def getDictFromObj(self, obj):',
  '        return {}',
  '    def isSameType(self, obj):',
  '        return True'
].join('\n');

const PARTIAL_IMPL = [
  'class TalentTreeImpl:',
  '    def isSameType(self, obj):',
  '        return True'
].join('\n');

const mod = (source: string, kind: 'module' | 'package' = 'module'): ImplementedByCandidate => ({
  filePath: kind === 'package' ? '/ws/scripts/user_type/talent/__init__.py' : '/ws/scripts/user_type/talent.py',
  source,
  kind
});

describe('resolveImplementedByBinding:unbound 面(保留未知)', () => {
  it('畸形值(malformed)/模块未找到(module-not-found)', () => {
    const malformed = resolveImplementedByBinding('OnlySymbol', [mod(CLASS_IMPL)]);
    expect(malformed).toMatchObject({ status: 'unbound', reason: 'malformed' });
    const missing = resolveImplementedByBinding('talent.TalentTreeImpl', []);
    expect(missing).toMatchObject({ status: 'unbound', reason: 'module-not-found' });
  });

  it('跨根同名模块并存 → ambiguous-module,证据含候选文件', () => {
    const a = mod(CLASS_IMPL);
    const b: ImplementedByCandidate = { filePath: '/ws/assets/scripts/user_type/talent.py', source: CLASS_IMPL, kind: 'module' };
    const binding = resolveImplementedByBinding('talent.TalentTreeImpl', [a, b]);
    expect(binding).toMatchObject({ status: 'unbound', reason: 'ambiguous-module' });
    expect(binding.reasonDetail).toContain('2 个候选');
    expect(binding.reasonDetail).toContain('talent.py');
  });

  it('符号未找到 / 同文件多处定义(重名)→ 不猜', () => {
    const notFound = resolveImplementedByBinding('talent.Who', [mod(CLASS_IMPL)]);
    expect(notFound).toMatchObject({ status: 'unbound', reason: 'symbol-not-found' });

    const duplicated = [
      'class TalentTreeImpl:',
      '        pass',
      '',
      'class TalentTreeImpl:',
      '        pass'
    ].join('\n');
    const ambiguous = resolveImplementedByBinding('talent.TalentTreeImpl', [mod(duplicated)]);
    expect(ambiguous).toMatchObject({ status: 'unbound', reason: 'ambiguous-symbol' });
    expect(ambiguous.reasonDetail).toContain('行 1/4');
  });

  it('动态返回:调用/属性链/字面量/别名目标不可静态判 → dynamic-value', () => {
    const body = 'TalentTreeImpl = make_impl()\n';
    expect(resolveImplementedByBinding('talent.TalentTreeImpl', [mod(body)]))
      .toMatchObject({ status: 'unbound', reason: 'dynamic-value' });

    const chain = 'TalentTreeImpl = mod.Thing\n';
    expect(resolveImplementedByBinding('talent.TalentTreeImpl', [mod(chain)]))
      .toMatchObject({ status: 'unbound', reason: 'dynamic-value' });

    const literal = 'TalentTreeImpl = "#hash"\n';
    const literalBinding = resolveImplementedByBinding('talent.TalentTreeImpl', [mod(literal)]);
    expect(literalBinding).toMatchObject({ status: 'unbound', reason: 'dynamic-value' });
    expect(literalBinding.reasonDetail).toContain('"#hash"'); // 串内 # 不当注释剥

    const missingAlias = 'TalentTreeImpl = Zed\n';
    expect(resolveImplementedByBinding('talent.TalentTreeImpl', [mod(missingAlias)]))
      .toMatchObject({ status: 'unbound', reason: 'dynamic-value' });

    const duplicatedAlias = 'TalentTreeImpl = Y\nclass Y:\n    pass\nclass Y:\n    pass\n';
    expect(resolveImplementedByBinding('talent.TalentTreeImpl', [mod(duplicatedAlias)]))
      .toMatchObject({ status: 'unbound', reason: 'dynamic-value' });
  });
});

describe('resolveImplementedByBinding:bound 面(真形落点)', () => {
  it('class 形态绑定,三契约方法如实扫描', () => {
    const binding = resolveImplementedByBinding('talent.TalentTreeImpl', [mod(CLASS_IMPL)]);
    expect(binding.status).toBe('bound');
    expect(binding).toMatchObject({
      form: 'class',
      modulePath: '/ws/scripts/user_type/talent.py',
      moduleKind: 'module',
      symbolLine: 1,
      contract: { createObjFromDict: true, getDictFromObj: true, isSameType: true }
    });
  });

  it('包模块形态如实记(kind=package)', () => {
    const binding = resolveImplementedByBinding('talent.TalentTreeImpl', [mod(CLASS_IMPL, 'package')]);
    expect(binding.status).toBe('bound');
    expect(binding.moduleKind).toBe('package');
  });

  it('function 形态绑定(def 定义)', () => {
    const fnImpl = 'def TalentTreeImpl():\n    return None\n';
    const binding = resolveImplementedByBinding('talent.TalentTreeImpl', [mod(fnImpl)]);
    expect(binding).toMatchObject({ status: 'bound', form: 'function', symbolLine: 1 });
    expect(binding.contract.createObjFromDict).toBe(false);
  });

  it('object 形态:别名一跳(裸名 → 本文件 class 单处定义),行落在赋值行', () => {
    const aliasImpl = [
      'class TalentTreeReal:',
      '    def createObjFromDict(self, dictData):',
      '        return dictData',
      '    def getDictFromObj(self, obj):',
      '        return {}',
      '    def isSameType(self, obj):',
      '        return True',
      'TalentTreeImpl = TalentTreeReal  # 公开名'
    ].join('\n');
    const binding = resolveImplementedByBinding('talent.TalentTreeImpl', [mod(aliasImpl)]);
    expect(binding).toMatchObject({
      status: 'bound',
      form: 'object',
      aliasedFrom: 'TalentTreeReal',
      symbolLine: 8,
      contract: { createObjFromDict: true, getDictFromObj: true, isSameType: true }
    });
  });

  it('赋值形态不误判比较/增强/海象;契约部分缺失如实 false', () => {
    const tricky = [
      'TalentTreeImpl == other',
      'TalentTreeImpl += 1',
      'if (TalentTreeImpl := build()):',
      '    pass',
      'class TalentTreeImpl:',
      '    def isSameType(self, obj):',
      '        return True'
    ].join('\n');
    const binding = resolveImplementedByBinding('talent.TalentTreeImpl', [mod(tricky)]);
    expect(binding).toMatchObject({ status: 'bound', form: 'class', symbolLine: 5 });
    expect(binding.contract).toEqual({ createObjFromDict: false, getDictFromObj: false, isSameType: true });
  });
});

describe('renderImplementedByBindingSection', () => {
  it('bound:形态/别名/落点/包注如实呈现', () => {
    const bound = renderImplementedByBindingSection(
      resolveImplementedByBinding('talent.TalentTreeImpl', [mod(CLASS_IMPL)])
    );
    expect(bound).toContain('**implementedBy 绑定**');
    expect(bound).toContain('类');
    expect(bound).toContain('talent.py:1');

    const objectBound = renderImplementedByBindingSection(
      resolveImplementedByBinding('talent.TalentTreeImpl', [mod(
        'class TalentTreeReal:\n    pass\nTalentTreeImpl = TalentTreeReal\n'
      )])
    );
    expect(objectBound).toContain('对象');
    expect(objectBound).toContain('(= `TalentTreeReal`)');
    expect(objectBound).toContain('talent.py:3');

    const packageBound = renderImplementedByBindingSection(
      resolveImplementedByBinding('talent.TalentTreeImpl', [mod(CLASS_IMPL, 'package')])
    );
    expect(packageBound).toContain('包模块');
  });

  it('unbound:每类未知原因随引擎依据呈现', () => {
    expect(renderImplementedByBindingSection(resolveImplementedByBinding('OnlySymbol', [])))
      .toContain('两段值');
    expect(renderImplementedByBindingSection(resolveImplementedByBinding('a.B', [])))
      .toContain('未在 user_type 根下解析到');
    const ambiguous = resolveImplementedByBinding('a.B', [mod('x = 1\n'), mod('y = 2\n')]);
    expect(renderImplementedByBindingSection(ambiguous)).toContain('同名并存');
    expect(renderImplementedByBindingSection(resolveImplementedByBinding('a.B', [mod('x = 1\n')])))
      .toContain('未找到该符号的定义');
    expect(renderImplementedByBindingSection(resolveImplementedByBinding('a.B', [mod('class B:\n    pass\nclass B:\n    pass\n')])))
      .toContain('多处定义');
    expect(renderImplementedByBindingSection(resolveImplementedByBinding('a.B', [mod('B = make()\n')])))
      .toContain('动态表达式');
  });
});

// ---------------------------------------------------------------------------
// 采集面:implementedByBindingForWorkspace(真实 tmpdir 布局)
// ---------------------------------------------------------------------------

let root = '';

const write = (relative: string, content: string): void => {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-impl-bind-'));
  write('scripts/entity_defs/types.xml', '<root/>');
  write('scripts/user_type/talent.py', CLASS_IMPL);
  // 包形态:包目录 + 同名文件并存 → CPython 包优先(本地 python3 实测定案)
  write('scripts/user_type/pkgmod/__init__.py', 'class PkgImpl:\n    pass\n');
  write('scripts/user_type/pkgmod.py', 'X = "file"\n');
  // 孤儿:implementedBy 指向不存在的模块
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('implementedByBindingForWorkspace(采集面)', () => {
  it('文件模块绑定成立:形态/落点/契约齐', () => {
    const binding = implementedByBindingForWorkspace(root, 'talent.TalentTreeImpl');
    expect(binding?.status).toBe('bound');
    expect(binding).toMatchObject({ form: 'class', moduleKind: 'module', contract: { isSameType: true } });
    expect(binding?.modulePath).toContain('talent.py');
  });

  it('包目录胜同名文件(真实导入序),模块形态=package', () => {
    const binding = implementedByBindingForWorkspace(root, 'pkgmod.PkgImpl');
    expect(binding?.status).toBe('bound');
    expect(binding?.moduleKind).toBe('package');
    expect(binding?.modulePath).toContain('__init__.py');
  });

  it('模块未找到 → module-not-found;implementedBy 空 → null;畸形 → malformed', () => {
    expect(implementedByBindingForWorkspace(root, 'ghost.Nothing'))
      .toMatchObject({ status: 'unbound', reason: 'module-not-found' });
    expect(implementedByBindingForWorkspace(root, undefined)).toBeNull();
    expect(implementedByBindingForWorkspace(root, '')).toBeNull();
    expect(implementedByBindingForWorkspace(root, 'BadValue')).toMatchObject({ status: 'unbound', reason: 'malformed' });
  });
});
