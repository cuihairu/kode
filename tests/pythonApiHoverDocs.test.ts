/**
 * C-21 纯数据面测试:pythonApiHoverDocs 的查询语义(域精确 → 唯一 owner
 * 回退 → 歧义如实)、locale 回退、A/C 触发点位置判定、B 触发追加段。
 * 不挂 vscode(hover 接线由 languageProviders 既有测试面覆盖)。
 */

import { describe, expect, it } from 'vitest';

import {
  API_DOC_ENTRY_COUNT,
  API_DOC_ENTRIES
} from '../src/generated/apiDocs';
import {
  apiDocDomainsForFace,
  formatApiDocHover,
  formatApiDocSupplement,
  getKbengineApiAccessAtPosition,
  getPythonCallbackDefinitionAtPosition,
  lookupApiDoc
} from '../src/backend/pythonApiHoverDocs';

describe('pythonApiHoverDocs lookup semantics', () => {
  it('域精确优先:fireEvent@base 命中 entity 面', () => {
    const lookup = lookupApiDoc('fireEvent', ['base'], 'en');
    expect(lookup.kind).toBe('hit');
    if (lookup.kind === 'hit') {
      expect(lookup.hit.entry.domain).toBe('base');
      expect(lookup.hit.entry.owner).toBe('entity');
    }
  });

  it('无域多 owner 歧义:返回候选,绝不静默挑一个', () => {
    const lookup = lookupApiDoc('fireEvent', [], 'en');
    expect(lookup.kind).toBe('ambiguous');
    if (lookup.kind === 'ambiguous') {
      const owners = new Set(lookup.entries.map(e => e.owner));
      expect(owners.size).toBeGreaterThan(1);
    }
  });

  it('唯一 owner 回退:createEntity 无域命中', () => {
    const lookup = lookupApiDoc('createEntity', [], 'en');
    expect(lookup.kind).toBe('hit');
  });

  it('未知成员返回 miss', () => {
    expect(lookupApiDoc('__no_such_member__', [], 'en').kind).toBe('miss');
  });

  it('指定进程时不回退到其他进程的同名 API', () => {
    expect(lookupApiDoc('createEntity', ['logger'], 'en').kind).toBe('miss');
    expect(lookupApiDoc('charge', ['cell'], 'en').kind).toBe('miss');
  });

  it('zh 命中用中文摘要;zh 缺失回退 en 并如实标注', () => {
    const withZh = API_DOC_ENTRIES.find(e => e.summaryZh && e.domain === 'base');
    expect(withZh).toBeTruthy();
    if (!withZh) { return; }
    const zh = lookupApiDoc(withZh.member, [withZh.domain], 'zh-cn');
    expect(zh.kind).toBe('hit');
    if (zh.kind === 'hit') {
      expect(zh.hit.summary).toBe(withZh.summaryZh);
    }

    const enOnly = API_DOC_ENTRIES.find(e => !e.summaryZh && e.summaryEn);
    expect(enOnly).toBeTruthy();
    if (!enOnly) { return; }
    const fallback = lookupApiDoc(enOnly.member, [enOnly.domain], 'zh-cn');
    expect(fallback.kind).toBe('hit');
    if (fallback.kind === 'hit') {
      expect(fallback.hit.summary).toBe(enOnly.summaryEn);
      // 渲染面必须给出 (en) 标注,不冒充中文
      const rendered = formatApiDocHover(fallback);
      expect(rendered).toContain('_(en)_');
    }
  });
});

describe('pythonApiHoverDocs trigger positions', () => {
  it('A 触发点:光标落在 KBEngine.<member> 的 member 上', () => {
    const line = '    e = KBEngine.createEntity("Avatar", pos)';
    const at = line.indexOf('createEntity');
    expect(getKbengineApiAccessAtPosition(line, at)).toEqual({ member: 'createEntity' });
    expect(getKbengineApiAccessAtPosition(line, at + 5)).toEqual({ member: 'createEntity' });
    // 光标在引导点(.)上不算 member 位
    expect(getKbengineApiAccessAtPosition(line, at - 1)).toBeNull();
    // 光标在 KBEngine 前缀上不算 member 位
    expect(getKbengineApiAccessAtPosition(line, line.indexOf('KBEngine') + 3)).toBeNull();
    // 其他标识符不触发
    expect(getKbengineApiAccessAtPosition('    x = foo.createEntity("Avatar")', 14)).toBeNull();
  });

  it('C 触发点:光标落在 def <回调>( 上且回调在库内', () => {
    const line = '    def onTimer(self, timerHandle, userData):';
    const at = line.indexOf('onTimer');
    expect(getPythonCallbackDefinitionAtPosition(line, at)).toEqual({ name: 'onTimer' });
    // 普通方法 def 不给文档(库内无 callback 条目)
    expect(getPythonCallbackDefinitionAtPosition('    def myHelper(self):', 8)).toBeNull();
    // 调用位不是声明位
    expect(getPythonCallbackDefinitionAtPosition('    self.onTimer(1, 2)', 8)).toBeNull();
  });

  it('face → 查询域映射:client 面附加 bots,未知面给空域列表', () => {
    expect(apiDocDomainsForFace('baseapp')).toEqual(['base']);
    expect(apiDocDomainsForFace('cellapp')).toEqual(['cell']);
    expect(apiDocDomainsForFace('client')).toEqual(['client', 'bots']);
    expect(apiDocDomainsForFace(null)).toEqual([]);
  });
});

describe('pythonApiHoverDocs rendering', () => {
  it('单条命中渲染:签名代码块 + 面/类别行 + 摘要', () => {
    const entry = API_DOC_ENTRIES.find(e => e.member === 'onTimer' && e.domain === 'base');
    expect(entry).toBeTruthy();
    if (!entry) { return; }
    const rendered = formatApiDocHover(lookupApiDoc('onTimer', ['base'], 'en'));
    expect(rendered).toContain('```python');
    expect(rendered).toContain(entry.signature);
    expect(rendered).toContain('baseapp');
    expect(rendered).toContain('callback');
  });

  it('B 触发追加段:命中才非空且带来源页标注', () => {
    const entry = API_DOC_ENTRIES.find(e => e.summaryEn && e.domain === 'base' && e.owner === 'entity');
    expect(entry).toBeTruthy();
    if (!entry) { return; }
    const supplement = formatApiDocSupplement(entry.member, ['base'], 'en');
    expect(supplement).toContain('---');
    expect(supplement).toContain(entry.page);
    // 未知成员不给追加段
    expect(formatApiDocSupplement('__no_such_member__', ['base'], 'en')).toBe('');
  });

  it('库规模地板:抽取产物不低于基线(结构漂移会显著掉数)', () => {
    expect(API_DOC_ENTRIES.length).toBe(API_DOC_ENTRY_COUNT);
    expect(API_DOC_ENTRIES.length).toBeGreaterThanOrEqual(200);
    // 每条必须有签名
    for (const entry of API_DOC_ENTRIES) {
      expect(entry.signature.length).toBeGreaterThan(0);
      expect(entry.member.length).toBeGreaterThan(0);
    }
  });
});
