import { afterEach, describe, expect, it } from 'vitest';
import { setL10nBundle } from './fake-vscode/l10n';
import zhCnBundle from '../l10n/bundle.l10n.zh-cn.json';

import {
  analyzeFixedDictMutations,
  buildFixedDictWholeReassignText,
  FIXED_DICT_MUTATION_DIAGNOSTIC_CODE
} from '../src/fixedDictMutationDiagnostics';

const zh = zhCnBundle as Record<string, string>;

afterEach(() => {
  setL10nBundle(null);
});

// C-23 交付②首条规则:FIXED_DICT 属性子键赋值不触发属性同步事件
// (KBE-PY-015,数据源=KB-001 行为知识结构化条目)。引擎语义:属性同步
// 以「属性顶层赋值」为单位,FIXED_DICT 子键(`self.profile.name = x` 或
// `self.profile['name'] = x`)只改了字典对象内部,不触发同步——须整体
// 重赋。判定保守面:单行语句、`self.<属性>` 单段前缀、属性类型经
// types.xml 类型图判定为 FIXED_DICT(调用方传入);顶层整体赋值不报。
// 误报=0 验收:反例含顶层赋值/非 FIXED_DICT 属性/同名词典非 self 面向。

const FD_PROPS = new Map([['profile', ['name', 'level']], ['flags', ['slot']]]);

describe('analyzeFixedDictMutations(KBE-PY-015)', () => {
  it('正例:属性点子键赋值与字符串下标赋值都报(增强赋值同报)', () => {
    const text = [
      'class Avatar:',
      '    def rename(self):',
      '        self.profile.name = "abc"',
      "        self.profile['level'] = 3",
      '        self.flags.slot += 1',
      ''
    ].join('\n');
    const findings = analyzeFixedDictMutations(text, FD_PROPS);
    expect(findings.map(f => [f.line, f.property, f.key, f.kind])).toEqual([
      [2, 'profile', 'name', 'attr'],
      [3, 'profile', 'level', 'subscript'],
      [4, 'flags', 'slot', 'attr']
    ]);
    expect(findings[0].message).toContain('reassign');
    expect(FIXED_DICT_MUTATION_DIAGNOSTIC_CODE).toBe('kbengine.fixedDictNestedMutation');

    // 注入 zh-cn bundle:中文面(两态,取词在调用期)
    setL10nBundle(zh);
    const zhFindings = analyzeFixedDictMutations(text, FD_PROPS);
    expect(zhFindings[0].message).toContain('整体重赋');
  });

  it('反例:属性顶层整体赋值不报(这正是正确姿势)', () => {
    const text = [
      'class Avatar:',
      '    def rename(self):',
      '        self.profile = {**self.profile, "name": "abc"}',
      '        self.profile = new_profile',
      ''
    ].join('\n');
    expect(analyzeFixedDictMutations(text, FD_PROPS)).toEqual([]);
  });

  it('反例:非 FIXED_DICT 属性/未知属性/普通对象访问不报(误报=0)', () => {
    const text = [
      'class Avatar:',
      '    def work(self):',
      '        self.hp = 3',
      '        self.unknown_prop.x = 1',
      '        local_dict = {}',
      '        local_dict["k"] = 1',
      '        other.profile.name = "x"',
      '        self.cell.position = (1, 2)',
      ''
    ].join('\n');
    expect(analyzeFixedDictMutations(text, FD_PROPS)).toEqual([]);
  });

  it('注释/字符串里的同形文本不报', () => {
    const text = [
      'class Avatar:',
      '    def work(self):',
      '        # self.profile.name = "in comment"',
      '        note = "self.profile.name = in string"',
      ''
    ].join('\n');
    expect(analyzeFixedDictMutations(text, FD_PROPS)).toEqual([]);
  });

  it('quick fix 文本:整体重赋习语(点子键与下标键两形)', () => {
    expect(
      buildFixedDictWholeReassignText('self.profile.name = "abc"', 'profile', 'name')
    ).toBe('self.profile = {**self.profile, \'name\': "abc"}');
    expect(
      buildFixedDictWholeReassignText("self.profile['level'] = 3", 'profile', "'level'")
    ).toBe("self.profile = {**self.profile, 'level': 3}");
    // 增强赋值:右值回退为整句重算不可靠 → 只给 `{**old, key: <expr>}` 中
    // 原 rhs 不含运算符的保守形态;增强赋值不生成 quick fix 文本(None)
    expect(
      buildFixedDictWholeReassignText('self.flags.slot += 1', 'flags', 'slot')
    ).toBeNull();
  });
});
