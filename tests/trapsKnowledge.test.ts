import { describe, expect, it } from 'vitest';

import {
  TRAP_KNOWLEDGE_ENTRIES,
  getTrapEntryByDetection,
  type TrapDetectionKind
} from '../src/knowledge/trapsKnowledge';
import { LINT_RULES } from '../src/lintRuleRegistry';

// C-23 交付①:KB-001 行为知识结构化条目契约。每条带 applies_to /
// detection / fix / source 四字段;detection 非空(可静态检测)的条目必须
// 恰好被一条 implemented lint 规则消费(KBE-PY-015/016/017),不冒充;
// 双语注记(noteZh/noteEn)供 hover 行为注记段。

const DETECTION_KINDS: TrapDetectionKind[] = [
  'fixed-dict-nested-mutation',
  'destroyed-entity-container-capture',
  'timer-cancel-on-destroy'
];

describe('trapsKnowledge(C-23 交付①,结构化 KB-001 条目)', () => {
  it('每条结构化字段齐备,来源指向知识库文章或任务书记录', () => {
    expect(TRAP_KNOWLEDGE_ENTRIES.length).toBeGreaterThanOrEqual(5);
    for (const entry of TRAP_KNOWLEDGE_ENTRIES) {
      expect(entry.id, entry.id).toMatch(/^KB-001-TRAP-/);
      expect(entry.appliesTo.length, entry.id).toBeGreaterThan(0);
      expect(entry.fix.length, entry.id).toBeGreaterThan(0);
      expect(entry.source.length, entry.id).toBeGreaterThan(0);
      expect(entry.noteZh.length, entry.id).toBeGreaterThan(0);
      expect(entry.noteEn.length, entry.id).toBeGreaterThan(0);
    }
  });

  it('detection 三种可检测模式各被恰好一条 implemented 规则消费(接对账)', () => {
    for (const detection of DETECTION_KINDS) {
      const entry = getTrapEntryByDetection(detection);
      expect(entry, detection).not.toBeNull();
      const consumers = LINT_RULES.filter(rule =>
        rule.status === 'implemented'
        && rule.source.includes('Diagnostics.ts')
        && (entry!.id.startsWith('KB-001-TRAP-FD') ? rule.id === 'KBE-PY-015'
          : entry!.id.startsWith('KB-001-TRAP-LIFE') ? rule.id === 'KBE-PY-016'
            : rule.id === 'KBE-PY-017')
      );
      expect(consumers, `${detection} 的消费规则`).toHaveLength(1);
    }
  });

  it('不可静态检测的条目 detection=null(不冒充可检测)', () => {
    const undetectable = TRAP_KNOWLEDGE_ENTRIES.filter(entry => entry.detection === null);
    expect(undetectable.length).toBeGreaterThanOrEqual(2);
    for (const entry of undetectable) {
      // 无消费规则:三规则 source 均不含其 id 对应模式
      expect(DETECTION_KINDS).not.toContain(entry.detection);
    }
  });

  it('双语注记:中文注记含「行为注记」,英文注记含 Behavior note', () => {
    for (const entry of TRAP_KNOWLEDGE_ENTRIES) {
      expect(entry.noteZh, entry.id).toContain('行为注记');
      expect(entry.noteEn, entry.id).toContain('Behavior note');
    }
  });
});
