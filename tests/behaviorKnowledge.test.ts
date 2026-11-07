import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  BEHAVIOR_KNOWLEDGE_ENTRIES,
  DETECTABLE_BEHAVIOR_ENTRIES,
  behaviorEntryByCode,
  behaviorEntriesForSymbol,
  behaviorNoteMarkdown,
  fixedDictBehaviorNoteMarkdown,
  FIXED_DICT_NESTED_MUTATION_CODE,
  DESTROYED_ENTITY_REFERENCE_CODE,
  TIMER_LEAK_ON_DESTROY_CODE
} from '../src/behaviorKnowledge';

/** 索引页数据行(跳过表头/分隔行) */
function trapRows(markdownPath: string): string[] {
  const text = readFileSync(markdownPath, 'utf8');
  return text.split(/\r?\n/)
    .filter(line => line.startsWith('| '))
    .filter(line => !/^\|\s*-/.test(line))
    .filter(line => !/^\|\s*(陷阱|Trap)\s*\|/.test(line));
}

const REPO_ROOT = join(__dirname, '..');

describe('behaviorKnowledge: structured KB entries (C-23 ①)', () => {
  it('entries are structurally complete (bilingual, appliesTo, fix, sources, unique ids)', () => {
    expect(BEHAVIOR_KNOWLEDGE_ENTRIES.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const entry of BEHAVIOR_KNOWLEDGE_ENTRIES) {
      expect(ids.has(entry.id), `duplicate id ${entry.id}`).toBe(false);
      ids.add(entry.id);
      expect(entry.trapZh.trim().length, `${entry.id} trapZh`).toBeGreaterThan(0);
      expect(entry.trapEn.trim().length, `${entry.id} trapEn`).toBeGreaterThan(0);
      expect(entry.appliesToZh.trim().length, `${entry.id} appliesToZh`).toBeGreaterThan(0);
      expect(entry.appliesToEn.trim().length, `${entry.id} appliesToEn`).toBeGreaterThan(0);
      expect(entry.symptomZh.trim().length, `${entry.id} symptomZh`).toBeGreaterThan(0);
      expect(entry.symptomEn.trim().length, `${entry.id} symptomEn`).toBeGreaterThan(0);
      expect(entry.fixZh.trim().length, `${entry.id} fixZh`).toBeGreaterThan(0);
      expect(entry.fixEn.trim().length, `${entry.id} fixEn`).toBeGreaterThan(0);
      expect(entry.sources.length, `${entry.id} sources`).toBeGreaterThan(0);
    }
  });

  it('entries reconcile 1:1 with traps-index rows in BOTH doc trees (doc lockstep)', () => {
    const zhRows = trapRows(join(REPO_ROOT, 'docs/zh/knowledge/traps-index.md'));
    const enRows = trapRows(join(REPO_ROOT, 'docs/knowledge/traps-index.md'));
    expect(zhRows.length).toBe(BEHAVIOR_KNOWLEDGE_ENTRIES.length);
    expect(enRows.length).toBe(BEHAVIOR_KNOWLEDGE_ENTRIES.length);
    const zhText = zhRows.join('\n');
    const enText = enRows.join('\n');
    for (const entry of BEHAVIOR_KNOWLEDGE_ENTRIES) {
      expect(zhText.includes(entry.trapZh), `zh tree missing trap cell: ${entry.trapZh}`).toBe(true);
      expect(enText.includes(entry.trapEn), `en tree missing trap cell: ${entry.trapEn}`).toBe(true);
    }
  });

  it('detection non-empty ⟺ the three C-23 lint rules (auto rule candidates)', () => {
    const codes = DETECTABLE_BEHAVIOR_ENTRIES.map(entry => entry.detection!.code).sort();
    expect(codes).toEqual([
      DESTROYED_ENTITY_REFERENCE_CODE,
      FIXED_DICT_NESTED_MUTATION_CODE,
      TIMER_LEAK_ON_DESTROY_CODE
    ].sort());
    for (const code of codes) {
      expect(behaviorEntryByCode(code)).toBeDefined();
    }
    expect(behaviorEntryByCode('kbengine.notARule')).toBeUndefined();
  });

  it('hover note markdown is bilingual (zh + en + correct pattern + evidence)', () => {
    const entry = behaviorEntryByCode(FIXED_DICT_NESTED_MUTATION_CODE)!;
    const note = behaviorNoteMarkdown(entry);
    expect(note).toContain('⚠ 行为注记:');
    expect(note).toContain('Behavior note:');
    expect(note).toContain('正确姿势:');
    expect(note).toContain('Correct pattern:');
    expect(note).toContain('依据/Evidence:');
    expect(note).toContain(entry.symptomZh);
    expect(note).toContain(entry.symptomEn);
    expect(fixedDictBehaviorNoteMarkdown()).toBe(note);
  });

  it('symbol lookup: kbengine-specific words only, no generic words', () => {
    const addTimerEntries = behaviorEntriesForSymbol('addTimer');
    // 实体级安全(destroy 全量取消)+ 模块级泄漏:同一词挂两条
    expect(addTimerEntries.map(entry => entry.id).sort()).toEqual([
      'cancel-timers-in-ondestroy-unnecessary',
      'kbengine-module-timer-leak'
    ]);
    expect(behaviorEntriesForSymbol('delTimer')).toHaveLength(1);
    expect(behaviorEntriesForSymbol('teleport')).toHaveLength(2);
    expect(behaviorEntriesForSymbol('cellData')).toHaveLength(1);
    expect(behaviorEntriesForSymbol('unknownSymbol')).toHaveLength(0);
    // 泛词不挂靠(任意 python 文件都会出现的词,挂了就是噪音)
    const allSymbols = new Set(BEHAVIOR_KNOWLEDGE_ENTRIES.flatMap(entry => [...entry.symbols]));
    for (const generic of ['login', 'createAccount', 'destroy', 'onDestroy', 'self', 'id']) {
      expect(allSymbols.has(generic), `generic word ${generic} must not be a hover symbol`).toBe(false);
    }
  });
});
