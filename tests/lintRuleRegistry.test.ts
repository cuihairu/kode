// IDE-LINT-011 验收:统一 lint 规则注册与能力清单。
//
// 一致性契约(每条 implemented 规则):
//   1. code(若非 null)字符串必须出现在真实 src 模块(排除注册表自身——
//      自引用会架空检查),证明「已注册 = 真的发出诊断」。code 为 null 仅限
//      结构诊断(同域重复定义/缺失必需字段)发布时不带 code 的规则,已在
//      规则表文档如实标注(KBE-DEF-003);其余 implemented 规则必须带 code;
//   2. 每条规则引用的开关(若有)必须存在于 package.json contributes.configuration;
//   3. package.json 每个诊断类配置键必须被至少一条规则引用(无孤儿开关);
//   4. 状态三档(implemented/hint-only/pending)明确区分,报告分组正确;
//   5. getEnabledLintRules 过滤 implemented 且开关开启(无开关恒启用);
//   6. 已启用规则集合与 Problems 一致:enabled 规则的 code 均真实(第 1 条
//      已覆盖),严重度只取 Error/Warning/Information。
// 规则表文档(kbengine-lint-rules.md)行与源码锁步,不在此重复断言(文档
// 对账在 features/guide 表)。

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  LINT_RULES,
  getEnabledLintRules,
  renderLintRulesReport
} from '../src/lintRuleRegistry';

const root = join(__dirname, '..');
const srcDir = join(root, 'src');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const configProps = pkg.contributes.configuration.properties as Record<string, unknown>;

/** 全部 src 下递归 .ts 源码文本(含子目录,排除注册表自身) */
const collectSrcTsFiles = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...collectSrcTsFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith('.ts') && entry.name !== 'lintRuleRegistry.ts') {
      files.push(join(dir, entry.name));
    }
  }
  return files;
};

const srcText = collectSrcTsFiles(srcDir)
  .map(file => readFileSync(file, 'utf8'))
  .join('\n');

/** package.json 诊断类配置键(诊断开关/主开关) */
const diagnosticConfigKeys = Object.keys(configProps).filter(key =>
  key.startsWith('kbengine.') && (/Diagnostics$/.test(key) || /^kbengine\.diagnostics\./.test(key) || key === 'kbengine.enableDiagnostics')
);

/** 结构诊断规则:发布时不带 code(规则表已如实标注),允许 code 为 null */
const CODELESS_IMPLEMENTED = new Set(['KBE-DEF-003']);

const implemented = LINT_RULES.filter(rule => rule.status === 'implemented');

describe('IDE-LINT-011 规则注册与能力清单', () => {
  it('implemented 规则每条都有真实诊断 code(结构诊断除外)', () => {
    for (const rule of implemented) {
      if (CODELESS_IMPLEMENTED.has(rule.id)) {
        expect(rule.code, `${rule.id} 为结构诊断,应无 code`).toBeNull();
        continue;
      }
      expect(rule.code, `${rule.id} 缺 code`).toBeTruthy();
      expect(srcText, `${rule.id} 的 code ${rule.code} 未出现在任何 src 模块`).toContain(rule.code!);
    }
  });

  it('每条规则引用的开关都在 package.json 配置', () => {
    for (const rule of LINT_RULES) {
      for (const toggle of rule.toggles) {
        expect(configProps[toggle], `${rule.id} 的开关 ${toggle} 不在 package.json`).toBeTruthy();
      }
    }
  });

  it('package.json 每个诊断类配置键都被至少一条规则引用(无孤儿开关)', () => {
    const referenced = new Set<string>();
    for (const rule of LINT_RULES) {
      for (const toggle of rule.toggles) {
        referenced.add(toggle);
      }
    }
    const orphans = diagnosticConfigKeys.filter(key => !referenced.has(key));
    expect(orphans, `孤儿诊断开关: ${orphans.join(', ')}`).toEqual([]);
  });

  it('状态三档明确区分,严重度合法', () => {
    expect(new Set(LINT_RULES.map(rule => rule.status))).toEqual(
      new Set(['implemented', 'hint-only', 'pending'])
    );
    expect(implemented.length).toBeGreaterThan(0);
    for (const rule of implemented) {
      expect(['Error', 'Warning', 'Information']).toContain(rule.severity);
    }
  });

  it('已启用规则 = implemented 且任一开关开启(无开关恒启用)', () => {
    const togglesOn = new Set(['kbengine.readOnlyWriteDiagnostics']);
    const enabled = getEnabledLintRules(toggle => togglesOn.has(toggle));
    for (const rule of enabled) {
      expect(rule.status).toBe('implemented');
      if (rule.toggles.length > 0) {
        expect(rule.toggles.some(t => togglesOn.has(t))).toBe(true);
      }
    }
    // readOnlyWrite 开关开 → 该规则在;某关掉的开关对应规则不在。
    expect(enabled.some(rule => rule.code === 'kbengine.readOnlyWrite')).toBe(true);
    expect(enabled.some(rule => rule.code === 'kbengine.receiverNone')).toBe(false);
  });

  it('报告按状态分组渲染,含 code/严重度/角色/开关/触发/修复/源码与启用态', () => {
    const report = renderLintRulesReport(() => true);
    expect(report).toContain('已实现(');
    expect(report).toContain('仅提示(');
    expect(report).toContain('待实现(');
    expect(report).toContain('kbengine.readOnlyWrite');
    expect(report).toContain('KBE-PY-007');
    expect(report).toContain('●启用');
  });
});
